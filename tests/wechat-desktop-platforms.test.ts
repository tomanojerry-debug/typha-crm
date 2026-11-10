import { expect, it } from 'vitest';
import { createLocalWeChatTransport } from '../server/wechat-transport.js';
import {
  localAbsolutePath,
  openDesktopWeChat,
  type WeChatRuntime,
} from '../server/wechat-platform.js';

const cli = 'C:\\工具 目录\\wechat-cli.exe';
const app = 'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe';
const python = 'C:\\Python 目录\\python.exe';
const script = 'C:\\我的CRM\\scripts\\wechat-bridge.py';
function windows(
  options: { python?: boolean; ready?: boolean; cli?: string; metadataFails?: boolean } = {},
) {
  const calls: {
    file: string;
    args: string[];
    options: Parameters<WeChatRuntime['execute']>[2];
  }[] = [];
  const launches: { file: string; env: NodeJS.ProcessEnv }[] = [];
  const files = new Set([
    cli,
    app,
    python,
    script,
    'C:\\用户\\.wechat-cli\\config.json',
    'C:\\用户\\.wechat-cli\\all_keys.json',
    'D:\\资料\\xwechat_files\\synthetic-account\\db_storage',
  ]);
  const runtime: WeChatRuntime = {
    platform: 'win32',
    home: 'C:\\用户',
    env: {
      SystemRoot: 'C:\\Windows',
      Path: 'C:\\Windows\\System32',
      WECHAT_CLI_BIN: options.cli ?? (options.python ? script : cli),
      ...(options.python ? { WECHAT_PYTHON_BIN: python } : {}),
      WECHAT_DATA_ROOT: 'D:\\资料\\xwechat_files',
      MINIMAX_API_KEY: 'synthetic-model-secret',
      MAIL_PASSWORD: 'synthetic-mail-secret',
      EXTRA_PRIVATE: 'synthetic-private',
    },
    exists: async (path) => files.has(path),
    realpath: async (path) => path,
    directories: async () => ['synthetic-account'],
    async execute(file, args, execution) {
      calls.push({ file, args, options: execution });
      if (file.endsWith('powershell.exe')) {
        if (options.metadataFails) throw new Error('synthetic access denied');
        return {
          stdout: JSON.stringify({
            os: '10.0.26100',
            running: true,
            version: '4.2.0',
            paths: [app],
            documents: 'D:\\资料',
          }),
        };
      }
      const command = file === python ? args.slice(1) : args;
      return {
        stdout: JSON.stringify(
          command[0] === 'status'
            ? options.ready
              ? { ready: true, account_id: 'synthetic-account' }
              : { ready: false, reason: 'not_initialized' }
            : command[0] === 'contacts'
              ? [{ username: 'wxid_synthetic', nick_name: command[2] }]
              : {
                  username: command[1],
                  messages: [{ local_id: 1, time: '2026-10-22 23:59:59', text: '合成文字' }],
                },
        ),
      };
    },
    async launch(file, env) {
      launches.push({ file, env });
    },
  };
  return { runtime, calls, launches, files };
}

it('Windows metadata and a running process never bypass initialization or expose private paths', async () => {
  const { runtime, calls } = windows();
  const status = await createLocalWeChatTransport(runtime).status();
  expect(status).toMatchObject({ state: 'needs_setup', platform: 'windows' });
  expect(status.checks).toContainEqual(
    expect.objectContaining({ label: 'Windows 微信', value: '4.2.0' }),
  );
  expect(status.checks).toContainEqual(
    expect.objectContaining({ id: 'accounts', value: '1 个；目录存在不表示已登录' }),
  );
  const json = JSON.stringify(status);
  expect(json).not.toContain('synthetic-account');
  expect(json).not.toContain('C:\\');
  expect(status.checks?.some((check) => check.label === 'Mac 微信')).toBe(false);
  expect(calls.filter((call) => call.file === cli).map((call) => call.args)).toEqual([
    ['status', '--format', 'json'],
  ]);
});

it('Windows requires an adapter readiness proof and keeps literal arguments, dates and secrets isolated', async () => {
  const { runtime, calls } = windows({ ready: true });
  const transport = createLocalWeChatTransport(runtime);
  expect(await transport.status()).toMatchObject({
    state: 'ready',
    platform: 'windows',
    account_key: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  const identity = '采购老师 & $(synthetic)';
  expect(await transport.resolve(identity)).toMatchObject([{ name: identity }]);
  expect(
    (await transport.history('wxid_synthetic', '2026-10-22', '2026-10-22')).messages,
  ).toHaveLength(1);
  expect(calls.find((call) => call.args[0] === 'contacts')?.args[2]).toBe(identity);
  const history = calls.find((call) => call.args[0] === 'history')!;
  expect(history.args).toContain('2026-10-22 23:59:59');
  for (const call of calls) {
    expect(call.options).toMatchObject({
      shell: false,
      windowsHide: true,
      env: { TZ: 'Asia/Shanghai' },
    });
    expect(JSON.stringify(call.options)).not.toMatch(/synthetic-(?:model|mail|private)/);
  }
});

it('Windows executes Python bridges through an explicit interpreter, including Unicode and spaces', async () => {
  const { runtime, calls } = windows({ python: true, ready: true });
  expect((await createLocalWeChatTransport(runtime).status()).state).toBe('ready');
  const invocation = calls.find((call) => call.file === python)!;
  expect(invocation.args).toEqual([script, 'status', '--format', 'json']);
  expect(invocation.options.env.PYTHONIOENCODING).toBe('utf-8');
  expect(invocation.options.env).not.toHaveProperty('MINIMAX_API_KEY');
});

it('missing Windows Python is actionable and never executes a script through a shell', async () => {
  const { runtime, calls } = windows({ python: true });
  delete runtime.env.WECHAT_PYTHON_BIN;
  expect((await createLocalWeChatTransport(runtime).status()).state).toBe('missing');
  expect(calls.every((call) => call.file.endsWith('powershell.exe'))).toBe(true);
});

it.each([
  'C:\\tools\\wechat-cli.cmd',
  'C:\\tools\\wechat-cli.bat',
  '\\\\server\\share\\wechat.exe',
  'C:relative.exe',
  '/tmp/wechat-cli',
])('rejects unsafe Windows entry %s without attempting execution', async (entry) => {
  const { runtime, calls, files } = windows({ cli: entry });
  files.add(entry);
  expect((await createLocalWeChatTransport(runtime).status()).state).toBe('missing');
  expect(calls.every((call) => call.file.endsWith('powershell.exe'))).toBe(true);
});

it('opens the registered Windows executable without a shell, restart, elevation or forced login', async () => {
  const { runtime, calls, launches } = windows();
  await openDesktopWeChat(runtime);
  expect(launches.map((launch) => launch.file)).toEqual([app]);
  expect(calls).toHaveLength(1);
  expect(calls[0].args).toContain('-NonInteractive');
  expect(calls[0].args).not.toContain('-ExecutionPolicy');
  expect(JSON.stringify(launches)).not.toContain('synthetic-model-secret');
});

it('does not guess an executable or claim installation when Windows inspection fails', async () => {
  const { runtime, files, launches } = windows({ metadataFails: true });
  files.delete(app);
  expect((await createLocalWeChatTransport(runtime).status()).checks).toContainEqual(
    expect.objectContaining({ id: 'app', state: 'action' }),
  );
  await expect(openDesktopWeChat(runtime)).rejects.toThrow('未找到 Windows 微信');
  expect(launches).toHaveLength(0);
});

it('Mac keeps native bundle launch; unsupported hosts execute no commands', async () => {
  const { runtime, calls } = windows();
  runtime.platform = 'darwin';
  await openDesktopWeChat(runtime);
  expect(calls[0]).toMatchObject({ file: '/usr/bin/open', args: ['-b', 'com.tencent.xinWeChat'] });
  runtime.platform = 'linux';
  const before = calls.length;
  expect((await createLocalWeChatTransport(runtime).status()).state).toBe('unsupported');
  await expect(openDesktopWeChat(runtime)).rejects.toThrow('Mac 和 Windows');
  expect(calls).toHaveLength(before);
  runtime.platform = 'win32';
  expect(localAbsolutePath(runtime, 'C:\\有效路径\\tool.exe')).toBe(true);
  expect(localAbsolutePath(runtime, '\\rooted.exe')).toBe(false);
});
