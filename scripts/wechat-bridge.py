#!/usr/bin/env python3
"""Local read-only WeChat 4.x adapter. No init, signing, export or sending commands.

SQLCipher reads encrypted pages in place; no plaintext database copies or shared caches.
The schema was checked against huohuoer/wechat-cli commit a3789232d4f79bf0b30634d9dadbce71e4acd601.
Live WeChat versions still require explicit compatibility verification.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from datetime import datetime, timedelta, timezone

ROOT = Path(__file__).resolve().parent.parent
HOST_PLATFORM = sys.platform
CONFIG = Path(os.environ.get('WECHAT_CLI_CONFIG', str(ROOT / '.local/wechat/config.json')))
BEIJING = timezone(timedelta(hours=8))
MESSAGE_DB = re.compile(r'message/message_[0-9]+\.db')
LOCAL_ENV = {key: value for key, value in os.environ.items()
             if key.upper() in {'PATH', 'HOME', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'TEMP', 'TMP'}}
LOCAL_ENV.update({'HOME': str(Path.home()), 'LC_ALL': 'en_US.UTF-8', 'TZ': 'Asia/Shanghai'})


class BridgeError(Exception):
    def __init__(self, reason):
        self.reason = reason


def private_json(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise BridgeError('unsafe_config_permissions')
    if HOST_PLATFORM == 'win32':
        # Loaded lazily; Windows-only APIs must not run on Mac.
        from wechat_windows import private_file, WindowsMetadataError
        try:
            if not private_file(path):
                raise BridgeError('unsafe_config_permissions')
        except WindowsMetadataError as error:
            raise BridgeError(error.reason) from None
    elif info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise BridgeError('unsafe_config_permissions')
    if info.st_size > 1024 * 1024:
        raise BridgeError('invalid_config')
    result = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(result, dict):
        raise BridgeError('invalid_config')
    return result


def active_roots():
    """Only process metadata and open file paths; never reads a chat or screen."""
    if HOST_PLATFORM == 'win32':
        from wechat_windows import active_roots as windows_roots, WindowsMetadataError
        try:
            return windows_roots()
        except WindowsMetadataError as error:
            raise BridgeError(error.reason) from None
    if HOST_PLATFORM != 'darwin':
        raise BridgeError('unsupported_platform')
    try:
        pids = subprocess.run(['/usr/bin/pgrep', '-x', 'WeChat'], capture_output=True,
                              text=True, timeout=3, check=True, env=LOCAL_ENV).stdout.split()
        if not pids or any(not pid.isdigit() for pid in pids):
            raise BridgeError('process_stopped')
        result = subprocess.run(['/usr/sbin/lsof', '-n', '-P', '-Fn', '-p', ','.join(pids)],
                                capture_output=True, text=True, timeout=5, env=LOCAL_ENV)
        roots = set()
        for line in result.stdout.splitlines():
            if line.startswith('n') and '/db_storage/' in line:
                roots.add(Path(line[1:].split('/db_storage/')[0], 'db_storage').resolve())
        return roots
    except (subprocess.SubprocessError, OSError):
        raise BridgeError('process_access_unavailable') from None


def literal(value):
    # Values become hex SQL literals, never SQL syntax or CLI dot commands.
    return "CAST(X'" + str(value).encode('utf-8').hex() + "' AS TEXT)"


class Context:
    def __init__(self, config=CONFIG):
        if not config.exists():
            raise BridgeError('not_initialized')
        self.config = private_json(config)
        self.db_dir = Path(self.config['db_dir']).resolve(strict=True)
        if self.db_dir.name != 'db_storage':
            raise BridgeError('invalid_config')
        self.account_id = self.config['account_id']
        if not isinstance(self.account_id, str) or not self.account_id or len(self.account_id) > 200:
            raise BridgeError('invalid_config')
        self.keys = private_json(Path(self.config['keys_file']).resolve(strict=True))
        candidates = [os.environ.get('WECHAT_SQLCIPHER_BIN')] if os.environ.get('WECHAT_SQLCIPHER_BIN') else ['/opt/homebrew/bin/sqlcipher', '/usr/local/bin/sqlcipher']
        self.binary = next((path for path in candidates if Path(path).is_absolute()
                            and (HOST_PLATFORM != 'win32' or path.lower().endswith('.exe'))
                            if os.access(path, os.X_OK)), None)
        if not self.binary:
            raise BridgeError('sqlcipher_missing')
        self.check_account()

    def check_account(self):
        roots = active_roots()
        if len(roots) != 1 or self.db_dir not in roots:
            raise BridgeError('account_not_verified')

    def query(self, relative, sql):
        if relative != 'contact/contact.db' and not MESSAGE_DB.fullmatch(relative):
            raise BridgeError('invalid_database')
        path = (self.db_dir / relative).resolve(strict=True)
        if not path.is_relative_to(self.db_dir):
            raise BridgeError('invalid_database')
        entry = self.keys.get(relative)
        key = entry.get('enc_key') if isinstance(entry, dict) else None
        if not isinstance(key, str) or not re.fullmatch(r'[0-9a-fA-F]{64}', key):
            raise BridgeError('missing_database_key')
        with path.open('rb') as source:
            salt = source.read(16)
        if len(salt) != 16 or salt.startswith(b'SQLite format 3'):
            raise BridgeError('unsupported_database')
        # Key only travels over stdin to the local SQLCipher process, never argv/env/logs.
        null = 'NUL' if HOST_PLATFORM == 'win32' else os.devnull
        source = (f'.bail on\n.timeout 2000\n.output {null}\n'
                  f'PRAGMA key="x\'{key}{salt.hex()}\'";\n'
                  'PRAGMA cipher_memory_security=ON;\nPRAGMA query_only=ON;\n'
                  'PRAGMA temp_store=MEMORY;\n.output stdout\n.mode json\n' + sql + ';\n')
        result = subprocess.run([self.binary, '-readonly', '-batch', '-init', null, str(path)], input=source,
                                capture_output=True, encoding='utf-8', timeout=8, env=LOCAL_ENV)
        if result.returncode != 0 or len(result.stdout) > 8 * 1024 * 1024:
            raise BridgeError('database_query_failed')
        rows = json.loads(result.stdout) if result.stdout.strip() else []
        if not isinstance(rows, list):
            raise BridgeError('unsupported_schema')
        return rows

    def status(self):
        # Schema plus one exact own-contact identity; no message query or contact listing.
        rows = self.query('contact/contact.db',
                          'SELECT username FROM contact WHERE username=' + literal(self.account_id) + ' LIMIT 1')
        if len(rows) != 1:
            raise BridgeError('account_not_verified')
        self.check_account()
        return {'ready': True, 'account_id': hashlib.sha256(str(self.db_dir).encode()).hexdigest()}

    def contacts(self, identity, limit):
        if not identity.strip() or len(identity) > 120:
            raise BridgeError('identity_required')
        value = literal(identity)
        rows = self.query('contact/contact.db',
                          'SELECT username,nick_name,remark,alias FROM contact WHERE '
                          f'(username={value} COLLATE NOCASE OR nick_name={value} COLLATE NOCASE '
                          f'OR remark={value} COLLATE NOCASE OR alias={value} COLLATE NOCASE) '
                          "AND instr(username,'@chatroom')=0 AND substr(username,1,3)!='gh_' "
                          f'ORDER BY username LIMIT {limit + 1}')
        if len(rows) > limit:
            raise BridgeError('too_many_contacts')
        self.check_account()
        return rows

    def history(self, talker, start, end, limit, offset):
        if not talker or talker.startswith('-') or '@chatroom' in talker or talker.startswith('gh_'):
            raise BridgeError('single_chat_required')
        lower = datetime.strptime(start, '%Y-%m-%d %H:%M:%S').replace(tzinfo=BEIJING)
        upper = datetime.strptime(end, '%Y-%m-%d %H:%M:%S').replace(tzinfo=BEIJING) + timedelta(seconds=1)
        if lower.hour or lower.minute or lower.second or upper.hour or upper.minute or upper.second:
            raise BridgeError('invalid_dates')
        if not timedelta(0) < upper - lower <= timedelta(days=31):
            raise BridgeError('invalid_dates')
        if not 1 <= limit <= 200 or not 0 <= offset < 1000 or offset + limit > 1000:
            raise BridgeError('invalid_pagination')
        # Verify the stable talker with an exact contact query, without fuzzy substitution.
        contact = next((row for row in self.contacts(talker, 30) if row['username'] == talker), None)
        if not contact:
            raise BridgeError('contact_not_verified')
        table = 'Msg_' + hashlib.md5(talker.encode()).hexdigest()
        condition = (f'(m.local_type & 4294967295)=1 AND m.create_time>={int(lower.timestamp())} '
                     f'AND m.create_time<{int(upper.timestamp())}')
        databases = sorted(key for key in self.keys if MESSAGE_DB.fullmatch(key))
        existing = sorted('message/' + path.name for path in (self.db_dir / 'message').glob('message_*.db')
                          if MESSAGE_DB.fullmatch('message/' + path.name))
        if not databases or existing != databases:
            raise BridgeError('missing_database_key')
        entries = []
        # First select identifiers/time/sender metadata; fetch text only for the final page.
        # This avoids reading every shard's message text to merge pagination.
        for relative in databases:
            found = self.query(relative, 'SELECT name FROM sqlite_master WHERE type=\'table\' AND name=' + literal(table))
            if not found:
                continue
            rows = self.query(relative,
                              f'SELECT m.local_id,m.create_time,n.user_name AS sender FROM [{table}] m '
                              f'LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id WHERE {condition} '
                              f'ORDER BY m.create_time DESC,m.local_id DESC LIMIT {offset + limit}')
            for row in rows:
                row['database'] = relative
                entries.append(row)
        entries.sort(key=lambda row: (-int(row['create_time']), row['database'], -int(row['local_id'])))
        selected = entries[offset:offset + limit]
        messages = []
        for relative in databases:
            page = [row for row in selected if row['database'] == relative]
            if not page:
                continue
            ids = ','.join(str(int(row['local_id'])) for row in page)
            rows = self.query(relative,
                              f'SELECT m.local_id,m.create_time,n.user_name AS sender,m.WCDB_CT_message_content AS ct,'
                              'CASE WHEN length(m.message_content)<=32768 THEN hex(m.message_content) ELSE NULL END AS content '
                              f'FROM [{table}] m LEFT JOIN Name2Id n ON n.rowid=m.real_sender_id '
                              f'WHERE {condition} AND m.local_id IN ({ids})')
            if len(rows) != len(page):
                raise BridgeError('source_changed')
            by_id = {row['local_id']: row for row in page}
            for row in rows:
                before = by_id[row['local_id']]
                if row['create_time'] != before['create_time'] or row['sender'] != before['sender']:
                    raise BridgeError('source_changed')
                if row['sender'] not in (talker, self.account_id):
                    raise BridgeError('sender_not_verified')
                if not isinstance(row['content'], str):
                    raise BridgeError('message_too_large')
                text = decode_text(bytes.fromhex(row['content']), row['ct'])
                messages.append({'id': relative + ':' + str(row['local_id']),
                                 'timestamp': row['create_time'], 'text': text,
                                 'sender': '我' if row['sender'] == self.account_id else contact.get('remark') or contact.get('nick_name') or talker,
                                 'is_from_me': row['sender'] == self.account_id})
        self.check_account()
        messages.sort(key=lambda row: (row['timestamp'], row['id']))
        return {'username': talker, 'is_group': False, 'messages': messages}


def decode_text(content, compression):
    if compression == 4:
        candidates = [os.environ.get('WECHAT_ZSTD_LIB')] if os.environ.get('WECHAT_ZSTD_LIB') else ['/opt/homebrew/opt/zstd/lib/libzstd.dylib', '/usr/local/opt/zstd/lib/libzstd.dylib']
        library = next((path for path in candidates if Path(path).is_absolute() and Path(path).is_file()), None)
        if not library:
            raise BridgeError('zstd_missing')
        zstd = ctypes.CDLL(library)
        zstd.ZSTD_decompress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t]
        zstd.ZSTD_decompress.restype = ctypes.c_size_t
        zstd.ZSTD_isError.argtypes = [ctypes.c_size_t]
        zstd.ZSTD_isError.restype = ctypes.c_uint
        buffer = ctypes.create_string_buffer(32768)
        length = zstd.ZSTD_decompress(buffer, len(buffer), content, len(content))
        if zstd.ZSTD_isError(length):
            raise BridgeError('message_decode_failed')
        content = buffer.raw[:length]
    return content.decode('utf-8', errors='strict')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=CONFIG)
    commands = parser.add_subparsers(dest='command', required=True)
    status = commands.add_parser('status')
    status.add_argument('--format', choices=['json'], default='json')
    contacts = commands.add_parser('contacts')
    contacts.add_argument('--query', required=True)
    contacts.add_argument('--limit', type=int, choices=range(1, 31), default=30)
    contacts.add_argument('--format', choices=['json'], default='json')
    history = commands.add_parser('history')
    history.add_argument('talker')
    history.add_argument('--start-time', required=True)
    history.add_argument('--end-time', required=True)
    history.add_argument('--limit', type=int, default=200)
    history.add_argument('--offset', type=int, default=0)
    history.add_argument('--type', choices=['text'], required=True)
    history.add_argument('--format', choices=['json'], default='json')
    args = parser.parse_args()
    try:
        context = Context(args.config)
        if args.command == 'status':
            result = context.status()
        elif args.command == 'contacts':
            result = context.contacts(args.query, args.limit)
        else:
            result = context.history(args.talker, args.start_time, args.end_time, args.limit, args.offset)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (BridgeError, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        reason = error.reason if isinstance(error, BridgeError) else 'local_read_failed'
        print(json.dumps({'ready': False, 'reason': reason} if args.command == 'status' else {'ok': False, 'reason': reason}))
        return 0 if args.command == 'status' else 1


if __name__ == '__main__':
    sys.exit(main())
