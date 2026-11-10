"""Synthetic Windows metadata only; these are not Windows device acceptance tests."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
spec = importlib.util.spec_from_file_location('wechat_windows', SCRIPTS / 'wechat_windows.py')
windows = importlib.util.module_from_spec(spec)
spec.loader.exec_module(windows)
sys.modules['wechat_windows'] = windows
spec = importlib.util.spec_from_file_location('wechat_bridge_windows_tests', SCRIPTS / 'wechat-bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
CSV = '"Process","PID","Type","Handle","Name"\n"Weixin.exe","42","File","ABC","C:\\用户 目录\\xwechat_files\\synthetic\\db_storage\\contact\\contact.db"\n'


class WindowsMetadataTests(unittest.TestCase):
    def test_csv_accounts_are_scoped_to_exact_pid_process_and_local_path(self):
        self.assertEqual(windows.roots_from_csv(CSV, 42),
                         {r'C:\用户 目录\xwechat_files\synthetic\db_storage'})
        for bad in [CSV.replace('"42"', '"43"'), CSV.replace('Weixin.exe', 'Other.exe'),
                    CSV.replace('C:\\用户 目录', '\\\\remote\\share'), 'Access denied',
                    'Process,PID,Type,Handle,Name\nWeixin.exe,42,File']:
            with self.assertRaises(windows.WindowsMetadataError):
                windows.roots_from_csv(bad, 42)
        multiple = CSV + '"WeChat.exe","42","File","BBB","D:\\other\\db_storage\\contact\\contact.db"\n'
        self.assertEqual(len(windows.roots_from_csv(multiple, 42)), 2)

    def test_acl_query_uses_literal_path_in_environment_and_requires_explicit_true(self):
        path = Path("synthetic user's file $(never executed).json")
        user = 'S-1-5-21-100'
        safe = {'owner': user, 'current': user, 'rules': [{'sid': user, 'type': 'Allow', 'rights': 0x1F01FF}]}
        with patch.object(windows, 'powershell_json', return_value=safe) as query:
            self.assertTrue(windows.private_file(path))
            script, values = query.call_args.args
            self.assertNotIn(str(path), script)
            self.assertEqual(values, {'WECHAT_METADATA_PATH': str(path)})
            self.assertIn('GetAccessRules', script)
        for value in [False, 'true', None]:
            with patch.object(windows, 'powershell_json', return_value=value):
                self.assertFalse(windows.private_file(path))

    def test_acl_rejects_other_user_read_write_and_control_rights_and_null_dacl(self):
        user = 'S-1-5-21-100'
        own = {'sid': user, 'type': 'Allow', 'rights': 0x1F01FF}
        base = {'owner': user, 'current': user, 'rules': [own]}
        self.assertTrue(windows.private_acl(base))
        for sid in ['S-1-5-18', 'S-1-5-32-544']:
            self.assertTrue(windows.private_acl({**base, 'rules': [own, {'sid': sid, 'type': 'Allow', 'rights': 0x1F01FF}]}))
        for rights in [1, 2, 4, 0x10000, 0x40000, 0x80000]:
            self.assertFalse(windows.private_acl({**base, 'rules': [own, {'sid': 'S-1-1-0', 'type': 'Allow', 'rights': rights}]}))
        self.assertFalse(windows.private_acl({**base, 'owner': 'S-1-5-21-200'}))
        self.assertFalse(windows.private_acl({**base, 'rules': []}))
        self.assertFalse(windows.private_acl({**base, 'rules': None}))

    def test_handle_is_explicit_and_eula_never_accepted_by_the_bridge(self):
        with patch.dict(windows.os.environ, {'WECHAT_HANDLE_BIN': ''}), patch.object(windows.subprocess, 'run') as run:
            with self.assertRaises(windows.WindowsMetadataError) as error:
                windows.active_roots()
            self.assertEqual(error.exception.reason, 'windows_handle_missing')
            run.assert_not_called()
        with patch.dict(windows.os.environ, {'WECHAT_HANDLE_BIN': r'C:\tools\handle64.exe'}), \
             patch.object(windows.Path, 'is_file', return_value=True), \
             patch.object(windows, 'handle_eula_accepted', return_value=False), \
             patch.object(windows.subprocess, 'run') as run:
            with self.assertRaises(windows.WindowsMetadataError) as error:
                windows.active_roots()
            self.assertEqual(error.exception.reason, 'windows_handle_eula_pending')
            run.assert_not_called()

    def test_process_metadata_failures_do_not_fall_back_to_stale_accounts(self):
        with patch.dict(windows.os.environ, {'WECHAT_HANDLE_BIN': r'C:\tools\handle64.exe', 'MINIMAX_API_KEY': 'synthetic-secret'}), \
             patch.object(windows.Path, 'is_file', return_value=True), \
             patch.object(windows, 'handle_eula_accepted', return_value=True), \
             patch.object(windows, 'powershell_json', return_value={'pids': [42]}), \
             patch.object(windows.subprocess, 'run', return_value=SimpleNamespace(stdout=CSV)) as run:
            self.assertEqual(len(windows.active_roots()), 1)
            args = run.call_args.args[0]
            self.assertEqual(args, [r'C:\tools\handle64.exe', '-nobanner', '-v', '-p', '42', 'db_storage'])
            self.assertNotIn('-accepteula', args)
            self.assertNotIn('MINIMAX_API_KEY', run.call_args.kwargs['env'])
            run.side_effect = subprocess.TimeoutExpired('synthetic', 5)
            with self.assertRaises(windows.WindowsMetadataError) as error:
                windows.active_roots()
            self.assertEqual(error.exception.reason, 'process_access_unavailable')

    def test_missing_configuration_on_windows_never_opens_processes_or_key_files(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(bridge, 'HOST_PLATFORM', 'win32'), \
             patch.object(windows, 'active_roots') as roots, patch.object(windows, 'private_file') as acl:
            with self.assertRaises(bridge.BridgeError) as error:
                bridge.Context(Path(folder) / 'missing.json')
            self.assertEqual(error.exception.reason, 'not_initialized')
            roots.assert_not_called()
            acl.assert_not_called()

    def test_windows_config_requires_acl_instead_of_posix_mode_bits(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'config.json'
            path.write_text('{"synthetic":"中文路径"}', encoding='utf-8')
            with patch.object(bridge, 'HOST_PLATFORM', 'win32'), patch.object(windows, 'private_file', return_value=False):
                with self.assertRaises(bridge.BridgeError) as error:
                    bridge.private_json(path)
                self.assertEqual(error.exception.reason, 'unsafe_config_permissions')
            with patch.object(bridge, 'HOST_PLATFORM', 'win32'), patch.object(windows, 'private_file', return_value=True):
                self.assertEqual(bridge.private_json(path), {'synthetic': '中文路径'})

    def test_windows_query_uses_null_device_readonly_utf8_and_stdin_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            context = bridge.Context.__new__(bridge.Context)
            context.db_dir = Path(folder).resolve()
            (context.db_dir / 'contact').mkdir()
            (context.db_dir / 'contact/contact.db').write_bytes(b'1234567890123456')
            context.keys = {'contact/contact.db': {'enc_key': '22' * 32}}
            context.binary = r'C:\tools\sqlcipher.exe'
            with patch.object(bridge, 'HOST_PLATFORM', 'win32'), \
                 patch.object(bridge.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='[]')) as run:
                self.assertEqual(context.query('contact/contact.db', 'SELECT 1'), [])
                args = run.call_args.args[0]
                self.assertIn('-readonly', args)
                self.assertEqual(args[args.index('-init') + 1], 'NUL')
                self.assertNotIn('22' * 32, ' '.join(args))
                self.assertIn('22' * 32, run.call_args.kwargs['input'])
                self.assertEqual(run.call_args.kwargs['encoding'], 'utf-8')
                self.assertNotIn('/dev/null', run.call_args.kwargs['input'])


if __name__ == '__main__':
    unittest.main()
