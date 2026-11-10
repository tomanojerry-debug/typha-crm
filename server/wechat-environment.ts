import type { WeChatStatus } from '../shared/wechat.js';
import {
  desktopName,
  desktopPaths,
  localAbsolutePath,
  localWeChatRuntime,
  runWeChatCommand,
  windowsWeChatApp,
  windowsWeChatMetadata,
  type WeChatRuntime,
} from './wechat-platform.js';

// Metadata only: do not open contacts, messages, config contents or key files.
// Running the app and finding old account folders do not establish a logged-in account.
export async function inspectWeChatEnvironment(
  runtime: WeChatRuntime = localWeChatRuntime,
): Promise<NonNullable<WeChatStatus['checks']>> {
  if (!['darwin', 'win32'].includes(runtime.platform)) return [];
  const path = desktopPaths(runtime);
  const configPath =
    runtime.env.WECHAT_CLI_CONFIG || path.join(runtime.home, '.wechat-cli', 'config.json');
  const command = async (file: string, args: string[]) => {
    try {
      return await runWeChatCommand(runtime, file, args);
    } catch {
      return null;
    }
  };
  let installed: boolean, version: string | null, system: string | null, running: boolean | null;
  let entitlements: string | null = null;
  let dataRoot: string | null = null;
  if (runtime.platform === 'win32') {
    const metadata = await windowsWeChatMetadata(runtime);
    installed = Boolean(await windowsWeChatApp(runtime, metadata));
    version = metadata?.version || null;
    system = metadata?.os || null;
    running = metadata?.running ?? null;
    dataRoot =
      runtime.env.WECHAT_DATA_ROOT ||
      (metadata?.documents ? path.join(metadata.documents, 'xwechat_files') : null);
  } else {
    const app = (await runtime.exists('/Applications/WeChat.app'))
      ? '/Applications/WeChat.app'
      : path.join(runtime.home, 'Applications', 'WeChat.app');
    installed = await runtime.exists(app);
    [version, system, entitlements] = await Promise.all([
      command('/usr/libexec/PlistBuddy', [
        '-c',
        'Print :CFBundleShortVersionString',
        path.join(app, 'Contents', 'Info.plist'),
      ]),
      command('/usr/bin/sw_vers', ['-productVersion']),
      command('/usr/bin/codesign', ['-d', '--entitlements', ':-', app]),
    ]);
    running = Boolean(await command('/usr/bin/pgrep', ['-x', 'WeChat']));
    dataRoot =
      runtime.env.WECHAT_DATA_ROOT ||
      path.join(
        runtime.home,
        'Library',
        'Containers',
        'com.tencent.xinWeChat',
        'Data',
        'Documents',
        'xwechat_files',
      );
  }
  const config = localAbsolutePath(runtime, configPath) && (await runtime.exists(configPath));
  const keys =
    localAbsolutePath(runtime, configPath) &&
    (await runtime.exists(path.join(path.dirname(configPath), 'all_keys.json')));
  let directories: number | null = null;
  if (dataRoot && localAbsolutePath(runtime, dataRoot)) {
    try {
      directories = (
        await Promise.all(
          (await runtime.directories(dataRoot)).map((name) =>
            runtime.exists(path.join(dataRoot!, name, 'db_storage')),
          ),
        )
      ).filter(Boolean).length;
    } catch {
      /* Never search the whole disk for a custom data folder. */
    }
  }
  const debugAllowed =
    entitlements === null
      ? null
      : /<key>com\.apple\.security\.get-task-allow<\/key>\s*<true\s*\/>/.test(entitlements) ||
        /\[Key\]\s+com\.apple\.security\.get-task-allow\s+\[Value\]\s+\[Bool\]\s+true/.test(
          entitlements,
        );
  return [
    {
      id: 'os',
      label: runtime.platform === 'win32' ? 'Windows' : 'macOS',
      value: system || '无法检测',
      state: system ? 'ok' : 'unknown',
    },
    {
      id: 'app',
      label: desktopName(runtime.platform),
      value: installed ? version || '已安装，版本待核对' : '未找到',
      state: installed ? 'ok' : 'action',
    },
    {
      id: 'process',
      label: '微信进程',
      value: running
        ? '运行中，登录状态待连接器核对'
        : '未检测到；请核对微信是否打开及系统检查权限',
      state: running ? 'ok' : 'unknown',
    },
    {
      id: 'initialization',
      label: '读取配置',
      value: config && keys ? '配置和密钥文件存在，尚需验证有效性' : '未完成初始化',
      state: config && keys ? 'unknown' : 'action',
    },
    {
      id: 'process_access',
      label: runtime.platform === 'win32' ? '数据库读取前提' : '初始化诊断',
      value:
        runtime.platform === 'win32'
          ? '须核验当前账号、私有文件ACL及进程文件句柄；不会自动提权'
          : debugAllowed === true
            ? '应用允许调试；这不代表账号配置、密钥或版本兼容性已核验'
            : debugAllowed === false
              ? '官方应用未开放调试；已有有效密钥时日常只读无需改签，首次初始化须另行评估兼容性并授权'
              : '无法核对应用签名权限',
      state: 'unknown',
    },
    {
      id: 'accounts',
      label: '本机账号目录',
      value:
        directories === null
          ? '无法访问默认位置；自定位置可配置 WECHAT_DATA_ROOT'
          : directories > 1
            ? `${directories} 个；连接前须明确当前账号`
            : `${directories} 个；目录存在不表示已登录`,
      state: directories === null || directories === 0 ? 'action' : 'unknown',
    },
  ];
}
