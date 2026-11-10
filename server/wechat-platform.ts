import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

const execute = promisify(execFile);
export interface WeChatRuntime {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  exists(path: string, executable?: boolean): Promise<boolean>;
  realpath(path: string): Promise<string>;
  directories(path: string): Promise<string[]>;
  launch(file: string, env: NodeJS.ProcessEnv): Promise<void>;
  execute(
    file: string,
    args: string[],
    options: {
      timeout: number;
      maxBuffer: number;
      env: NodeJS.ProcessEnv;
      shell: false;
      windowsHide: true;
    },
  ): Promise<{ stdout: string }>;
}

export const localWeChatRuntime: WeChatRuntime = {
  platform: process.platform,
  home: homedir(),
  env: process.env,
  async exists(path, executable = false) {
    try {
      await access(path, executable ? constants.X_OK : constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  realpath,
  async directories(path) {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  },
  async launch(file, env) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(file, [], { detached: true, stdio: 'ignore', shell: false, env });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  },
  async execute(file, args, options) {
    return { stdout: (await execute(file, args, { ...options, encoding: 'utf8' })).stdout };
  },
};

export const desktopPaths = (runtime: WeChatRuntime) =>
  runtime.platform === 'win32' ? win32 : posix;
export const desktopName = (platform: NodeJS.Platform) =>
  platform === 'win32' ? 'Windows 微信' : platform === 'darwin' ? 'Mac 微信' : '本机微信';

export function localAbsolutePath(runtime: WeChatRuntime, value: string) {
  return runtime.platform === 'win32'
    ? /^[a-z]:[\\/]/i.test(value) && win32.isAbsolute(value)
    : posix.isAbsolute(value);
}

// Model/mail credentials are never passed to a CLI or its interpreter.
export function wechatChildEnvironment(runtime: WeChatRuntime): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'HOMEDRIVE',
    'HOMEPATH',
    'USERNAME',
    'USERDOMAIN',
    'PROGRAMDATA',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'SESSIONNAME',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
    'WECHAT_CLI_CONFIG',
    'WECHAT_SQLCIPHER_BIN',
    'WECHAT_ZSTD_LIB',
    'WECHAT_HANDLE_BIN',
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(runtime.env).filter(
        ([key, value]) => allowed.has(key.toUpperCase()) && value !== undefined,
      ),
    ),
    TZ: 'Asia/Shanghai',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };
}

export async function runWeChatCommand(
  runtime: WeChatRuntime,
  file: string,
  args: string[],
  timeout = 4000,
  maxBuffer = 128 * 1024,
) {
  return (
    await runtime.execute(file, args, {
      timeout,
      maxBuffer,
      env: wechatChildEnvironment(runtime),
      shell: false,
      windowsHide: true,
    })
  ).stdout.trim();
}

export function windowsPowerShell(runtime: WeChatRuntime) {
  const root = runtime.env.SystemRoot || runtime.env.SYSTEMROOT || 'C:\\Windows';
  if (!localAbsolutePath(runtime, root)) throw new Error('Windows 系统路径不可用');
  return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function powerShellArguments(script: string) {
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
}

const windowsMetadataScript = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$processes=@(Get-Process -Name Weixin,WeChat -ErrorAction SilentlyContinue)
$paths=@()
foreach($p in $processes){try{if($p.Path){$paths+=$p.Path}}catch{}}
foreach($base in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths')){
  foreach($name in @('Weixin.exe','WeChat.exe')){try{$v=(Get-Item -LiteralPath ($base+'\\'+$name) -ErrorAction Stop).GetValue('');if($v){$paths+=$v}}catch{}}
}
$version=$null
foreach($p in $paths){try{$version=[Diagnostics.FileVersionInfo]::GetVersionInfo($p).ProductVersion;if($version){break}}catch{}}
[pscustomobject]@{os=[Environment]::OSVersion.Version.ToString();running=($processes.Count -gt 0);paths=@($paths|Select-Object -Unique);version=$version;documents=[Environment]::GetFolderPath('MyDocuments')}|ConvertTo-Json -Compress
`;

export interface WindowsWeChatMetadata {
  os: string;
  running: boolean;
  paths: string[];
  version: string | null;
  documents: string;
}

export async function windowsWeChatMetadata(
  runtime: WeChatRuntime,
): Promise<WindowsWeChatMetadata | null> {
  try {
    const raw = JSON.parse(
      await runWeChatCommand(
        runtime,
        windowsPowerShell(runtime),
        powerShellArguments(windowsMetadataScript),
      ),
    );
    if (!raw || typeof raw.running !== 'boolean') return null;
    return {
      os: typeof raw.os === 'string' ? raw.os : '',
      running: raw.running,
      paths: Array.isArray(raw.paths)
        ? raw.paths.filter((v: unknown): v is string => typeof v === 'string')
        : [],
      version: typeof raw.version === 'string' ? raw.version : null,
      documents: typeof raw.documents === 'string' ? raw.documents : '',
    };
  } catch {
    return null;
  }
}

export async function windowsWeChatApp(
  runtime: WeChatRuntime,
  metadata?: WindowsWeChatMetadata | null,
) {
  const roots = [
    runtime.env.ProgramFiles,
    runtime.env['ProgramFiles(x86)'],
    runtime.env.LOCALAPPDATA,
  ].filter(Boolean) as string[];
  const candidates = [
    runtime.env.WECHAT_APP_BIN,
    ...(metadata?.paths || []),
    ...roots.flatMap((root) => [
      win32.join(root, 'Tencent', 'Weixin', 'Weixin.exe'),
      win32.join(root, 'Tencent', 'WeChat', 'WeChat.exe'),
    ]),
  ];
  for (const value of candidates) {
    if (
      !value ||
      !localAbsolutePath(runtime, value) ||
      !/^(?:Weixin|WeChat)\.exe$/i.test(win32.basename(value))
    )
      continue;
    if (!(await runtime.exists(value, true))) continue;
    let canonical: string;
    try {
      canonical = await runtime.realpath(value);
    } catch {
      continue;
    }
    if (
      localAbsolutePath(runtime, canonical) &&
      /^(?:Weixin|WeChat)\.exe$/i.test(win32.basename(canonical))
    )
      return canonical;
  }
  return null;
}

export async function openDesktopWeChat(runtime: WeChatRuntime) {
  if (runtime.platform === 'darwin') {
    await runWeChatCommand(runtime, '/usr/bin/open', ['-b', 'com.tencent.xinWeChat'], 10000);
    return;
  }
  if (runtime.platform === 'win32') {
    const app = await windowsWeChatApp(runtime, await windowsWeChatMetadata(runtime));
    if (!app) throw new Error('未找到 Windows 微信，请先安装或配置 WECHAT_APP_BIN。');
    await runtime.launch(app, wechatChildEnvironment(runtime));
    return;
  }
  throw new Error('本机微信读取目前仅适配 Mac 和 Windows。');
}
