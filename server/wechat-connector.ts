import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { Database } from './db.js';
import { ApiError, scoped, tokenHash, type Context } from './security.js';
import { seal } from './mail-secrets.js';
import { createILinkProvider, type ILinkProvider } from './wechat-ilink.js';
import {
  wechatBotBindingPausedMessage,
  type WeChatConnectorState,
} from '../shared/wechat-connector.js';
import { allowed, type WeChatOptions } from './wechat.js';
import { connectorBinding } from './wechat-connector-store.js';

type Login = {
  id: string;
  code?: string;
  image?: string;
  expires: number;
  base: string;
  state: 'waiting' | 'scanned' | 'need_code' | 'expired';
  message: string;
  abort: AbortController;
  polling: boolean;
};
const empty = (): WeChatConnectorState => ({
  state: 'unbound',
  message: '扫码绑定你的 Typha 连接器。',
  account_verified: false,
});
export function createWeChatConnector(
  db: Database,
  options: {
    wechat?: WeChatOptions;
    key?: Buffer;
    provider?: ILinkProvider;
    now?: () => number;
  },
) {
  const logins = new Map<string, Login>();
  const provider = options.provider ?? createILinkProvider();
  const now = options.now ?? Date.now;
  const scope = <T>(actor: string, workspace: string, fn: (ctx: Context) => Promise<T>) =>
    scoped(db, actor, workspace, async (ctx) => {
      allowed(ctx, options.wechat);
      return fn(ctx);
    });
  const owner = (actor: string, workspace: string) => `${workspace}:${actor}`;
  function requireBindingEnabled() {
    if (!options.wechat?.connectorBindingEnabled)
      throw new ApiError(409, wechatBotBindingPausedMessage);
  }
  function view(login: Login): WeChatConnectorState {
    if (now() >= login.expires) {
      login.state = 'expired';
      login.message = '二维码已过期，请重新生成。';
      login.abort.abort();
    }
    return {
      state: login.state,
      message: login.message,
      session_id: login.id,
      expires_at: new Date(login.expires).toISOString(),
      ...(login.image && login.state !== 'expired' ? { qr_image: login.image } : {}),
      account_verified: false,
    };
  }
  async function bound(actor: string, workspace: string) {
    return scope(actor, workspace, connectorBinding);
  }
  function boundView(
    row: NonNullable<Awaited<ReturnType<typeof connectorBinding>>>,
  ): WeChatConnectorState {
    return {
      state: 'bound',
      message: '微信连接器已绑定，接下来核验本机读取条件。',
      bound_at: row.bound_at,
      account_verified: !!row.verified_account_key,
    };
  }
  return {
    async status(actor: string, workspace: string) {
      const binding = await bound(actor, workspace);
      if (!options.wechat?.connectorBindingEnabled) {
        const id = owner(actor, workspace);
        logins.get(id)?.abort.abort();
        logins.delete(id);
        return {
          state: 'paused' as const,
          message: wechatBotBindingPausedMessage,
          account_verified: false,
        };
      }
      if (binding) return boundView(binding);
      const login = logins.get(owner(actor, workspace));
      return login ? view(login) : empty();
    },
    async start(actor: string, workspace: string) {
      const binding = await bound(actor, workspace);
      requireBindingEnabled();
      if (binding) return boundView(binding);
      if (!options.key) throw new ApiError(503, '本机凭证加密尚未配置，请先完成服务端设置。');
      const id = owner(actor, workspace);
      logins.get(id)?.abort.abort();
      // Allocate before awaiting network, so an older response cannot replace a newer request.
      const login: Login = {
        id: randomUUID(),
        expires: now() + 5 * 60000,
        base: 'https://ilinkai.weixin.qq.com',
        state: 'waiting',
        message: '请用手机微信扫码，并在手机上确认绑定。',
        abort: new AbortController(),
        polling: false,
      };
      logins.set(id, login);
      try {
        const qr = await provider.create(login.abort.signal);
        const image = await QRCode.toDataURL(qr.content, {
          errorCorrectionLevel: 'M',
          width: 256,
          margin: 4,
        });
        await bound(actor, workspace); // Membership/permission may have changed during network I/O.
        requireBindingEnabled();
        if (logins.get(id) !== login || login.abort.signal.aborted)
          throw new ApiError(409, '二维码已被取消或替换。');
        login.code = qr.code;
        login.image = image;
        return view(login);
      } catch (error) {
        if (logins.get(id) === login) logins.delete(id);
        login.abort.abort();
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, '二维码生成失败，请稍后重试。');
      }
    },
    async poll(actor: string, workspace: string, input: unknown) {
      const data = z
        .strictObject({
          session_id: z.uuid(),
          verify_code: z
            .string()
            .regex(/^\d{2,12}$/)
            .optional(),
        })
        .parse(input);
      const binding = await bound(actor, workspace);
      requireBindingEnabled();
      if (binding) return boundView(binding);
      const id = owner(actor, workspace),
        login = logins.get(id);
      if (!login || login.id !== data.session_id || !login.code)
        throw new ApiError(404, '扫码会话不存在，请重新生成二维码。');
      const current = view(login);
      if (current.state === 'expired') return current;
      if (login.polling) return current;
      login.polling = true;
      try {
        const result = await provider.poll(
          login.code,
          login.base,
          login.abort.signal,
          data.verify_code,
        );
        requireBindingEnabled();
        if (logins.get(id) !== login || login.abort.signal.aborted || now() >= login.expires)
          throw new ApiError(409, '二维码已取消或过期，请重新连接。');
        if (result.state === 'confirmed') {
          await scope(actor, workspace, async (ctx) => {
            requireBindingEnabled();
            if (logins.get(id) !== login || login.abort.signal.aborted || now() >= login.expires)
              throw new ApiError(409, '扫码会话已失效。');
            const sealed = seal(
              JSON.stringify(result.credentials),
              options.key!,
              `wechat-connector:${workspace}:${actor}`,
            );
            try {
              await ctx.tx.query(
                'INSERT INTO wechat_connectors(workspace_id,actor_id,encrypted_credentials,user_hash) VALUES($1,$2,$3,$4)',
                [workspace, actor, sealed, tokenHash(result.credentials.user)],
              );
            } catch {
              throw new ApiError(409, '此微信已绑定或连接状态发生变化，请刷新后核对。');
            }
            if (logins.get(id) !== login || login.abort.signal.aborted || now() >= login.expires)
              throw new ApiError(409, '扫码会话已失效，本次绑定未保存。');
          });
          logins.delete(id);
          login.abort.abort();
          return boundView((await bound(actor, workspace))!);
        }
        if (result.state === 'redirect') {
          login.base = result.base;
          login.state = 'scanned';
        } else if (result.state === 'wait') {
          /* Preserve a previously scanned state. */
        } else if (result.state === 'scanned') login.state = 'scanned';
        else if (result.state === 'need_code') login.state = 'need_code';
        else {
          login.state = 'expired';
          login.abort.abort();
        }
        login.message =
          login.state === 'need_code'
            ? '请在下方输入手机微信显示的验证码。'
            : login.state === 'scanned'
              ? '已扫码，请在手机微信上确认。'
              : login.state === 'expired'
                ? result.state === 'already_bound'
                  ? '微信提示已有机器人绑定。请保留原绑定，不要为本产品解除或替换。'
                  : '二维码已失效，请重新生成。'
                : '请用手机微信扫码，并在手机上确认绑定。';
        return view(login);
      } finally {
        login.polling = false;
      }
    },
    async cancel(actor: string, workspace: string, input: unknown) {
      const data = z.strictObject({ session_id: z.uuid() }).parse(input);
      await bound(actor, workspace);
      const id = owner(actor, workspace),
        login = logins.get(id);
      if (login?.id === data.session_id) {
        login.abort.abort();
        logins.delete(id);
      }
      return { ok: true };
    },
  };
}
