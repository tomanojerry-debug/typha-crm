"""Windows metadata/ACL checks only. Never reads process memory or message contents."""
import base64
import csv
import io
import json
import ntpath
import os
from pathlib import Path, PureWindowsPath
import subprocess


class WindowsMetadataError(Exception):
    def __init__(self, reason):
        self.reason = reason


def environment():
    allowed = {'PATH', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOME', 'TEMP', 'TMP',
               'APPDATA', 'LOCALAPPDATA'}
    return {key: value for key, value in os.environ.items() if key.upper() in allowed}


def local_path(value):
    drive, tail = ntpath.splitdrive(value)
    return len(drive) == 2 and drive[1] == ':' and tail.startswith(('\\', '/'))


def powershell_json(script, extra=None):
    system = os.environ.get('SystemRoot', os.environ.get('SYSTEMROOT', 'C:\\Windows'))
    if not local_path(system):
        raise WindowsMetadataError('process_access_unavailable')
    binary = ntpath.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    source = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" + script
    try:
        result = subprocess.run([binary, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                                 base64.b64encode(source.encode('utf-16le')).decode('ascii')],
                                stdin=subprocess.DEVNULL, capture_output=True, encoding='utf-8',
                                timeout=5, check=True, env={**environment(), **(extra or {})})
        if len(result.stdout) > 1024 * 1024:
            raise ValueError('metadata too large')
        return json.loads(result.stdout.lstrip('\ufeff'))
    except (subprocess.SubprocessError, OSError, ValueError):
        raise WindowsMetadataError('process_access_unavailable') from None


def private_file(path):
    """Require current-user ownership and no nonprivileged data/control access."""
    script = """+$acl=Get-Acl -LiteralPath $env:WECHAT_METADATA_PATH
$current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{
  @{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();rights=[int64]$_.FileSystemRights}
})
@{owner=$owner;current=$current;rules=$rules}|ConvertTo-Json -Compress -Depth 4
"""
    try:
        result = powershell_json(script, {'WECHAT_METADATA_PATH': str(path)})
    except WindowsMetadataError:
        raise WindowsMetadataError('windows_permissions_unavailable') from None
    return private_acl(result)


def private_acl(result):
    if not isinstance(result, dict):
        return False
    current = result.get('current')
    if not isinstance(current, str) or not current.startswith('S-1-') or result.get('owner') != current:
        return False
    rules = result.get('rules')
    # A missing/null DACL must never be interpreted as a private file.
    if not isinstance(rules, list) or not rules:
        return False
    for rule in rules:
        if not isinstance(rule, dict) or rule.get('type') not in ('Allow', 'Deny') or type(rule.get('rights')) is not int:
            return False
        if rule['type'] == 'Allow' and rule['rights'] & 0x000F01FF:
            if rule.get('sid') not in (current, 'S-1-5-18', 'S-1-5-32-544'):
                return False
    return True


def handle_eula_accepted():
    # The user must accept Microsoft's EULA themselves; never use -accepteula.
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r'Software\Sysinternals\Handle') as key:
            return winreg.QueryValueEx(key, 'EulaAccepted')[0] == 1
    except (ImportError, OSError):
        return False


def roots_from_csv(output, pid):
    lines = output.lstrip('\ufeff').splitlines()
    header = next((i for i, line in enumerate(lines) if {'process', 'pid', 'type', 'name'}.issubset(
        {value.strip().casefold() for value in next(csv.reader([line]))})), None)
    if header is None:
        raise WindowsMetadataError('process_access_unavailable')
    roots = set()
    for raw in csv.DictReader(io.StringIO('\n'.join(lines[header:]))):
        row = {key.strip().casefold(): value for key, value in raw.items() if isinstance(key, str)}
        if any(not isinstance(row.get(key), str) for key in ('process', 'pid', 'type', 'name')):
            raise WindowsMetadataError('process_access_unavailable')
        if row.get('pid') != str(pid) or row.get('process', '').casefold() not in ('weixin.exe', 'wechat.exe'):
            raise WindowsMetadataError('process_access_unavailable')
        if row.get('type', '').casefold() != 'file':
            continue
        value = row.get('name', '')
        if not local_path(value):
            # NT device paths cannot be guessed into drive paths.
            raise WindowsMetadataError('process_access_unavailable')
        parts = PureWindowsPath(value).parts
        for i, part in enumerate(parts):
            if part.casefold() == 'db_storage':
                roots.add(str(PureWindowsPath(*parts[:i + 1])))
                break
    return roots


def active_roots():
    binary = os.environ.get('WECHAT_HANDLE_BIN', '')
    if not local_path(binary) or not binary.lower().endswith('.exe') or not Path(binary).is_file():
        raise WindowsMetadataError('windows_handle_missing')
    if not handle_eula_accepted():
        raise WindowsMetadataError('windows_handle_eula_pending')
    processes = powershell_json("@{pids=@(Get-Process -Name Weixin,WeChat -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})}|ConvertTo-Json -Compress")
    pids = processes.get('pids') if isinstance(processes, dict) else None
    if not isinstance(pids, list) or any(type(pid) is not int or pid <= 0 for pid in pids):
        raise WindowsMetadataError('process_access_unavailable')
    if not pids:
        raise WindowsMetadataError('process_stopped')
    roots = set()
    for pid in pids:
        try:
            result = subprocess.run([binary, '-nobanner', '-v', '-p', str(pid), 'db_storage'],
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                    timeout=5, check=True, env=environment())
            if len(result.stdout) > 2 * 1024 * 1024:
                raise ValueError('metadata too large')
            roots.update(Path(root).resolve() for root in roots_from_csv(result.stdout, pid))
        except (subprocess.SubprocessError, OSError, ValueError):
            raise WindowsMetadataError('process_access_unavailable') from None
    return roots
