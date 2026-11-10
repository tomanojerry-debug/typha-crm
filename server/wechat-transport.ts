import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { WeChatStatus, WeChatContact, WeChatMessage } from '../shared/wechat.js';
import { wechatRange } from '../shared/wechat.js';
import { inspectWeChatEnvironment } from './wechat-environment.js';
import {
  desktopPaths,
  localAbsolutePath,
  localWeChatRuntime,
  openDesktopWeChat,
  runWeChatCommand,
  type WeChatRuntime,
} from './wechat-platform.js';
const setupMessages: Record<string, string> = {
  not_initialized:
    '只读适配器已安装，尚未初始化当前微信账号。需先确认本机读取授权；不会自动提权或提取密钥。',
  account_not_verified:
    '尚未确认当前微信账号。请在 Mac 微信中登录指定账号，并核对读取配置；不会自动选择其他账号。',
  process_stopped: '请先打开 Mac 微信并登录，再检查连接。',
  process_access_unavailable: '无法核对当前微信进程，请检查本机系统读取授权。',
  unsafe_config_permissions: '读取配置或密钥文件的权限不安全，请将其限制为当前系统用户可读写。',
  sqlcipher_missing: '缺少本机 SQLCipher 运行库，请完成读取适配器安装。',
  windows_handle_missing: '缺少 Windows 账号核验工具，请配置 Microsoft Handle 后检查连接。',
  windows_handle_eula_pending:
    '请先在 Windows 本机查看并接受 Microsoft Handle 的许可，再检查连接。',
  windows_permissions_unavailable: '无法核验 Windows 配置的私有权限，请检查本机账号及文件 ACL。',
};
export interface WeChatTransport {
  status(): Promise<WeChatStatus & { account_key?: string }>;
  resolve(identity: string): Promise<WeChatContact[]>;
  history(
    talker: string,
    start: string,
    end: string,
  ): Promise<{ messages: WeChatMessage[]; warnings: string[] }>;
  openApp(): Promise<void>;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const str = (...values: unknown[]) =>
  (values.find((v) => typeof v === 'string' && v.trim()) as string | undefined)?.trim();
function list(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw;
  const root = object(raw),
    data = object(root.data);
  for (const v of [data[key], root[key], root.data]) if (Array.isArray(v)) return v;
  throw new Error('微信 CLI 返回格式不兼容，请检查本机 CLI 版本。');
}
export function normalizeWeChatContacts(raw: unknown): WeChatContact[] {
  return list(raw, 'contacts')
    .map((value) => {
      const r = object(value);
      return {
        id: str(r.wxid, r.user_name, r.username, r.id) || '',
        name: str(r.nickname, r.nick_name, r.name, r.display_name) || '',
        remark: str(r.remark, r.remark_name) || '',
        wechat_id: str(r.alias, r.wechat_id) || '',
      };
    })
    .filter(
      (r) => r.id && !r.id.endsWith('@chatroom') && !r.id.startsWith('-') && r.id.length <= 200,
    );
}
export function normalizeWeChatMessages(raw: unknown): WeChatMessage[] {
  const root = object(raw),
    data = object(root.data);
  for (const failures of [root.failures, data.failures]) {
    if (failures && (!Array.isArray(failures) || failures.length))
      throw new Error('微信 CLI 报告部分读取失败，请核对连接后重试；本次未生成预览。');
  }
  return list(raw, 'messages')
    .map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(
          '微信 CLI 消息格式不兼容：需要带稳定消息 ID 和时间的结构化记录，不能使用格式化文字代替。',
        );
      const r = object(value),
        id = object(r.id);
      const stamp = r.time_iso ?? r.create_time ?? r.timestamp ?? r.time;
      const time =
        typeof stamp === 'number'
          ? stamp < 1e12
            ? stamp * 1000
            : stamp
          : Date.parse(
              /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(String(stamp))
                ? `${String(stamp).replace(' ', 'T')}+08:00`
                : String(stamp),
            );
      const from_me =
        r.is_from_me === true || r.is_sender === true || r.is_sender === 1 || r.is_self === true;
      return {
        id: String(
          r.local_id ??
            id.local_id ??
            (typeof r.id === 'string' || typeof r.id === 'number' ? r.id : '') ??
            '',
        ),
        at: Number.isFinite(time) ? new Date(time).toISOString() : '',
        speaker:
          str(r.sender, r.sender_name, r.sender_contact_display) || (from_me ? '我' : '对方'),
        from_me,
        text:
          ([r.text, r.content].find((value) => typeof value === 'string' && value.trim()) as
            string | undefined) || '',
      };
    })
    .filter((m) => m.id && m.at && m.text);
}
export function createLocalWeChatTransport(
  runtime: WeChatRuntime = localWeChatRuntime,
): WeChatTransport {
  const paths = desktopPaths(runtime);
  const platform = runtime.platform === 'win32' ? ('windows' as const) : ('macos' as const);
  async function bin() {
    const configured = runtime.env.WECHAT_CLI_BIN;
    const candidates = configured
      ? [configured]
      : runtime.platform === 'win32'
        ? [
            paths.join(runtime.home, '.local', 'bin', 'wechat-cli.exe'),
            paths.join(runtime.home, '.local', 'share', 'wechat-cli', 'wechat-cli.exe'),
            ...(runtime.env.WECHAT_PYTHON_BIN
              ? [fileURLToPath(new URL('../scripts/wechat-bridge.py', import.meta.url))]
              : []),
          ]
        : [
            '/opt/homebrew/bin/wechat-cli',
            '/usr/local/bin/wechat-cli',
            paths.join(runtime.home, '.local', 'bin', 'wechat-cli'),
            paths.join(runtime.home, '.local', 'share', 'wechat-cli', 'wechat-cli'),
          ];
    for (const candidate of candidates) {
      if (!localAbsolutePath(runtime, candidate) || /\.(?:cmd|bat|ps1)$/i.test(candidate)) continue;
      try {
        const python = /\.py$/i.test(candidate);
        if (!(await runtime.exists(candidate, !python))) continue;
        const path = await runtime.realpath(candidate);
        if (!localAbsolutePath(runtime, path)) continue;
        if (python && !/\.py$/i.test(path)) continue;
        if (python && (runtime.platform === 'win32' || runtime.env.WECHAT_PYTHON_BIN)) {
          const interpreter = runtime.env.WECHAT_PYTHON_BIN;
          if (
            !interpreter ||
            !localAbsolutePath(runtime, interpreter) ||
            !(await runtime.exists(interpreter, true))
          )
            continue;
          const canonical = await runtime.realpath(interpreter);
          if (
            !localAbsolutePath(runtime, canonical) ||
            (runtime.platform === 'win32' && !/\.exe$/i.test(canonical))
          )
            continue;
          return { file: canonical, prefix: [path] };
        }
        if (python && !(await runtime.exists(path, true))) continue;
        if (runtime.platform === 'win32' && !/\.exe$/i.test(path)) continue;
        return { file: path, prefix: [] };
      } catch {
        /* Try next known installation. */
      }
    }
    return null;
  }
  async function run(args: string[]) {
    const command = await bin();
    if (!command) throw new Error('本机尚未配置兼容读取器，请先安装并完成本机读取授权。');
    try {
      const stdout = await runWeChatCommand(
        runtime,
        command.file,
        [...command.prefix, ...args],
        15000,
        4 * 1024 * 1024,
      );
      const raw: unknown = JSON.parse(stdout);
      if (object(raw).ok === false) throw new Error('CLI error');
      return raw;
    } catch {
      throw new Error(
        '暂时无法读取微信，请确认本机微信已登录、CLI 已初始化，且具有所需的本机读取权限。',
      );
    }
  }
  return {
    async status() {
      if (!['darwin', 'win32'].includes(runtime.platform))
        return { state: 'unsupported', message: '本机微信读取目前仅适配 Mac 和 Windows。' };
      const checks = await inspectWeChatEnvironment(runtime);
      if (!(await bin()))
        return {
          state: 'missing',
          platform,
          message:
            '尚未连接：请配置兼容读取器；Windows Python桥还需配置 WECHAT_PYTHON_BIN。微信打开不表示 CRM 已能读取。',
          checks: [
            ...checks,
            { id: 'adapter', label: '读取适配器', value: '未安装', state: 'action' as const },
          ],
        };
      checks.push({
        id: 'adapter',
        label: '读取适配器',
        value: '已安装，连接状态待核验',
        state: 'unknown',
      });
      try {
        const raw = object(await run(['status', '--format', 'json'])),
          data = object(raw.data),
          account = object(data.account ?? raw.account);
        const identity = str(
          data.account_id,
          raw.account_id,
          account.wxid,
          account.id,
          typeof data.account === 'string' ? data.account : null,
        );
        if (
          !identity ||
          (data.ready ?? raw.ready) !== true ||
          data.ready === false ||
          raw.ready === false
        )
          return {
            state: 'needs_setup',
            platform,
            message:
              setupMessages[String(data.reason ?? raw.reason)] ||
              '适配器已安装，请完成微信登录和本机初始化，并确认当前读取账号。',
            checks,
          };
        return {
          state: 'ready',
          platform,
          message: '本机微信可用，仅在你指定联系人及日期后读取。',
          account_key: createHash('sha256').update(identity).digest('hex'),
          checks,
        };
      } catch {
        return {
          state: 'needs_setup',
          platform,
          message:
            '适配器未能验证当前账号。请检查版本、登录和读取授权；原版 wechat-cli 0.2.4 不提供所需的 status 接口，不能直接连接。',
          checks,
        };
      }
    },
    async resolve(identity) {
      return normalizeWeChatContacts(
        await run(['contacts', '--query', identity, '--format', 'json', '--limit', '30']),
      ).filter((c) =>
        [c.id, c.name, c.remark, c.wechat_id].some(
          (v) => v.toLocaleLowerCase() === identity.toLocaleLowerCase(),
        ),
      );
    },
    async history(talker, start, end) {
      const range = wechatRange(start, end);
      if (!talker || talker.startsWith('-') || talker.includes('@chatroom'))
        throw new Error('请先选择有效的单聊联系人。');
      const messages = new Map<string, WeChatMessage>();
      let full = false;
      for (let offset = 0; offset < 1000; offset += 200) {
        const raw = await run([
          'history',
          talker,
          '--format',
          'json',
          '--type',
          'text',
          '--start-time',
          `${start} 00:00:00`,
          '--end-time',
          `${end} 23:59:59`,
          '--limit',
          '200',
          '--offset',
          String(offset),
        ]);
        const root = object(raw),
          data = object(root.data);
        if (
          root.is_group === true ||
          data.is_group === true ||
          (str(data.username, root.username) && str(data.username, root.username) !== talker)
        )
          throw new Error('微信返回的会话身份与所选联系人不符，本次未生成预览。');
        const page = list(raw, 'messages');
        if (page.length > 200) throw new Error('微信适配器未遵守分页上限，请核对版本。');
        const batch = normalizeWeChatMessages(raw);
        for (const m of batch)
          if (Date.parse(m.at) >= range.lower && Date.parse(m.at) < range.upper)
            messages.set(m.id, m);
        if (page.length < 200) {
          full = true;
          break;
        }
      }
      return {
        messages: [...messages.values()].sort((a, b) => a.at.localeCompare(b.at)),
        warnings: full
          ? ['仅整理已返回的文字；图片、语音和文件未转写。']
          : ['本次最多读取 1000 条，请缩小日期范围以获得完整结果。', '图片、语音和文件未转写。'],
      };
    },
    async openApp() {
      await openDesktopWeChat(runtime);
    },
  };
}
