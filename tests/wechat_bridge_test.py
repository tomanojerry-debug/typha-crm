"""Encrypted synthetic fixtures only. No real WeChat data or process access."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location('wechat_bridge', SCRIPTS / 'wechat-bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
BINARY = os.environ.get('WECHAT_SQLCIPHER_BIN') or shutil.which('sqlcipher')
SELF = 'wxid_synthetic_self'
TALKER = 'wxid_synthetic_contact'
TABLE = 'Msg_' + hashlib.md5(TALKER.encode()).hexdigest()
DAY = int(bridge.datetime(2026, 10, 22, tzinfo=bridge.BEIJING).timestamp())


@unittest.skipUnless(BINARY, 'requires the local SQLCipher runtime')
class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = self.root / 'synthetic-account/db_storage'
        (self.db / 'contact').mkdir(parents=True)
        (self.db / 'message').mkdir()
        self.keys = {}
        self.create('contact/contact.db',
                    'CREATE TABLE contact(username TEXT PRIMARY KEY,nick_name TEXT,remark TEXT,alias TEXT);'
                    f"INSERT INTO contact VALUES('{SELF}','我','','self-fixture'),('{TALKER}','林测试','采购测试','lin-fixture'),"
                    "('wxid_second','另一位测试','采购测试','second-fixture'),('room@chatroom','测试群','','');")
        self.create('message/message_0.db',
                    'CREATE TABLE Name2Id(user_name TEXT);'
                    f"INSERT INTO Name2Id VALUES('{SELF}'),('{TALKER}');"
                    f'CREATE TABLE [{TABLE}](local_id INTEGER PRIMARY KEY,local_type INTEGER,create_time INTEGER,real_sender_id INTEGER,message_content BLOB,WCDB_CT_message_content INTEGER);'
                    f"INSERT INTO [{TABLE}] VALUES(1,1,{DAY},2,CAST('第一条文字' AS BLOB),0),(2,1,{DAY+86399},1,CAST('最后一秒' AS BLOB),0),"
                    f"(3,1,{DAY+86400},2,CAST('下一天' AS BLOB),0),(4,1,{DAY-1},2,CAST('前一天' AS BLOB),0),(5,3,{DAY+1},2,CAST('媒体不读' AS BLOB),0);"
                    "CREATE TABLE Msg_00000000000000000000000000000000(message_content TEXT);"
                    "INSERT INTO Msg_00000000000000000000000000000000 VALUES('其他客户文字不得读取');")
        self.config = self.root / 'config.json'
        self.key_file = self.root / 'all_keys.json'
        self.write_private(self.key_file, self.keys)
        self.write_private(self.config, {'db_dir': str(self.db), 'account_id': SELF, 'keys_file': str(self.key_file)})
        self.active = patch.object(bridge, 'active_roots', return_value={self.db.resolve()})
        self.active.start()

    def tearDown(self):
        self.active.stop()
        self.temp.cleanup()

    def write_private(self, path, value):
        path.write_text(json.dumps(value))
        path.chmod(0o600)

    def create(self, relative, sql):
        key = ('11' if relative.startswith('contact') else '22') * 32
        path = self.db / relative
        subprocess.run([BINARY, '-batch', str(path)], input=f'PRAGMA key="x\'{key}\'";\n{sql}',
                       encoding='utf-8', capture_output=True, check=True)
        self.keys[relative] = {'enc_key': key}
        self.assertNotEqual(path.read_bytes()[:16], b'SQLite format 3\x00')

    def context(self):
        return bridge.Context(self.config)

    def test_status_only_queries_own_identity_and_keeps_source_encrypted(self):
        context = self.context()
        before = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in self.db.rglob('*.db')}
        with patch.object(context, 'query', wraps=context.query) as query:
            self.assertTrue(context.status()['ready'])
            self.assertEqual(query.call_count, 1)
            self.assertEqual(query.call_args.args[0], 'contact/contact.db')
            self.assertIn('WHERE username=', query.call_args.args[1])
        self.assertEqual(before, {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in self.db.rglob('*.db')})
        self.assertFalse(list(self.root.rglob('*decrypted*')))

    def test_exact_contacts_include_alias_and_preserve_duplicate_names(self):
        context = self.context()
        self.assertEqual([r['username'] for r in context.contacts('lin-fixture', 30)], [TALKER])
        self.assertEqual(len(context.contacts('采购测试', 30)), 2)
        self.assertEqual(context.contacts("'; .shell echo injected\n", 30), [])

    def test_history_is_text_only_with_inclusive_beijing_end_and_stable_ids(self):
        result = self.context().history(TALKER, '2026-10-22 00:00:00', '2026-10-22 23:59:59', 200, 0)
        self.assertEqual([m['text'] for m in result['messages']], ['第一条文字', '最后一秒'])
        self.assertEqual([m['is_from_me'] for m in result['messages']], [False, True])
        self.assertEqual([m['id'] for m in result['messages']], ['message/message_0.db:1','message/message_0.db:2'])
        page = self.context().history(TALKER, '2026-10-22 00:00:00', '2026-10-22 23:59:59', 1, 1)
        self.assertEqual([m['text'] for m in page['messages']], ['第一条文字'])

    def test_no_account_guessing_and_insecure_keys_are_rejected(self):
        with patch.object(bridge, 'active_roots', return_value={self.db, self.root / 'other/db_storage'}):
            with self.assertRaises(bridge.BridgeError) as error:
                self.context()
            self.assertEqual(error.exception.reason, 'account_not_verified')
        if sys.platform == 'win32':
            import wechat_windows
            with patch.object(wechat_windows, 'private_file', return_value=False):
                with self.assertRaises(bridge.BridgeError) as error:
                    self.context()
                self.assertEqual(error.exception.reason, 'unsafe_config_permissions')
        else:
            self.key_file.chmod(0o644)
            with self.assertRaises(bridge.BridgeError) as error:
                self.context()
            self.assertEqual(error.exception.reason, 'unsafe_config_permissions')

    def test_history_does_not_require_or_read_search_and_resource_databases(self):
        for name in ['message_fts.db', 'message_resource.db']:
            (self.db / 'message' / name).write_bytes(b'not a readable chat database')
        context = self.context()
        with patch.object(context, 'query', wraps=context.query) as query:
            result = context.history(TALKER, '2026-10-22 00:00:00', '2026-10-22 23:59:59', 200, 0)
        self.assertEqual([m['text'] for m in result['messages']], ['第一条文字', '最后一秒'])
        self.assertEqual({call.args[0] for call in query.call_args_list},
                         {'contact/contact.db', 'message/message_0.db'})

    def test_history_still_requires_every_numeric_message_shard_key(self):
        self.create('message/message_1.db', 'CREATE TABLE fixture(id INTEGER);')
        # Leave the new shard out of the persisted key file.
        context = self.context()
        with patch.object(context, 'query', wraps=context.query) as query:
            with self.assertRaises(bridge.BridgeError) as error:
                context.history(TALKER, '2026-10-22 00:00:00', '2026-10-22 23:59:59', 200, 0)
        self.assertEqual(error.exception.reason, 'missing_database_key')
        self.assertTrue(all(call.args[0] == 'contact/contact.db' for call in query.call_args_list))

    def test_group_missing_dates_and_wrong_key_fail_without_partial_results(self):
        context = self.context()
        with self.assertRaises(bridge.BridgeError):
            context.history('room@chatroom', '2026-10-22 00:00:00', '2026-10-22 23:59:59', 200, 0)
        with self.assertRaises(bridge.BridgeError):
            context.history(TALKER, '2026-09-01 00:00:00', '2026-10-22 23:59:59', 200, 0)
        context.keys['message/message_0.db']['enc_key'] = '33' * 32
        with self.assertRaises(bridge.BridgeError):
            context.history(TALKER, '2026-10-22 00:00:00', '2026-10-22 23:59:59', 200, 0)

    def test_encrypted_wal_is_read_in_place_without_plaintext_copies(self):
        path = self.db / 'message/message_0.db'
        key = self.keys['message/message_0.db']['enc_key']
        writer = subprocess.Popen([BINARY, '-batch', str(path)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, encoding='utf-8', bufsize=1)
        try:
            writer.stdin.write(f'PRAGMA key="x\'{key}\'";\nPRAGMA journal_mode=WAL;\n'
                               f"INSERT INTO [{TABLE}] VALUES(6,1,{DAY+60},2,CAST('WAL文字' AS BLOB),0);\n.print fixture-ready\n")
            writer.stdin.flush()
            while writer.stdout.readline().strip() != 'fixture-ready':
                if writer.poll() is not None:
                    self.fail('synthetic writer stopped')
            self.assertTrue(Path(str(path) + '-wal').exists())
            result = self.context().history(TALKER, '2026-10-22 00:00:00', '2026-10-22 23:59:59', 200, 0)
            self.assertIn('WAL文字', [m['text'] for m in result['messages']])
            self.assertNotIn('WAL文字'.encode(), Path(str(path) + '-wal').read_bytes())
        finally:
            writer.communicate('.quit\n', timeout=5)

    def test_compressed_text_and_source_changes_are_handled(self):
        library = Path(os.environ.get('WECHAT_ZSTD_LIB', '/opt/homebrew/opt/zstd/lib/libzstd.dylib'))
        if not library.exists():
            self.skipTest('requires local zstd')
        zstd = bridge.ctypes.CDLL(str(library))
        zstd.ZSTD_compress.argtypes = [bridge.ctypes.c_void_p, bridge.ctypes.c_size_t,
                                      bridge.ctypes.c_void_p, bridge.ctypes.c_size_t, bridge.ctypes.c_int]
        zstd.ZSTD_compress.restype = bridge.ctypes.c_size_t
        content = '合成压缩文字'.encode()
        buffer = bridge.ctypes.create_string_buffer(1024)
        size = zstd.ZSTD_compress(buffer, 1024, content, len(content), 3)
        self.assertEqual(bridge.decode_text(buffer.raw[:size], 4), '合成压缩文字')
        context = self.context()
        original = context.query
        def changing(relative, sql):
            result = original(relative, sql)
            if 'AS content' in sql and result:
                result[0]['create_time'] += 1
            return result
        with patch.object(context, 'query', side_effect=changing):
            with self.assertRaises(bridge.BridgeError) as error:
                context.history(TALKER, '2026-10-22 00:00:00', '2026-10-22 23:59:59', 200, 0)
            self.assertEqual(error.exception.reason, 'source_changed')

    def test_missing_setup_does_not_query_processes_or_databases_and_unsafe_commands_do_not_exist(self):
        with patch.object(bridge.subprocess, 'run') as run:
            with self.assertRaises(bridge.BridgeError) as error:
                bridge.Context(self.root / 'missing-config.json')
            self.assertEqual(error.exception.reason, 'not_initialized')
            run.assert_not_called()
        script = Path(bridge.__file__)
        for command in ['init', 'send', 'sessions', 'search', 'export']:
            result = subprocess.run([bridge.sys.executable, str(script), command], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)


if __name__ == '__main__':
    unittest.main()
