import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './security.js';

const base = 'https://ilinkai.weixin.qq.com';
const text = z.string().min(1).max(4096);
export const ilinkCredentials = z.strictObject({
  token: text,
  bot: z.string().min(1).max(200),
  user: z.string().min(1).max(200),
  base: z.string(),
});
export type ILinkCredentials = z.infer<typeof ilinkCredentials>;
export interface ILinkProvider {
  create(signal: AbortSignal): Promise<{ code: string; content: string }>;
  poll(
    code: string,
    apiBase: string,
    signal: AbortSignal,
    verifyCode?: string,
  ): Promise<
    | { state: 'wait' | 'scanned' | 'need_code' | 'expired' | 'blocked' | 'already_bound' }
    | { state: 'redirect'; base: string }
    | { state: 'confirmed'; credentials: ILinkCredentials }
  >;
}

// Accept only the official iLink API hosts, never a caller-provided endpoint.
export function ilinkBase(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !/^ilinkai(?:\d+)?\.(?:weixin\.qq\.com|wechat\.com)$/.test(url.hostname) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new ApiError(502, '微信返回了未支持的连接地址，请重新连接。');
  return url.origin;
}

export function createILinkProvider(fetcher: typeof fetch = fetch): ILinkProvider {
  async function request(path: string, apiBase: string, signal: AbortSignal, body?: object) {
    const timeout = AbortSignal.timeout(body ? 15000 : 35000);
    try {
      const response = await fetcher(`${ilinkBase(apiBase)}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          'iLink-App-Id': 'bot',
          'iLink-App-ClientVersion': '132104',
          ...(body
            ? {
                AuthorizationType: 'ilink_bot_token',
                'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString(
                  'base64',
                ),
              }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.any([signal, timeout]),
      });
      if (!response.ok || !response.body) throw new Error('response');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 65536) throw new Error('size');
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const raw = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (
        (raw.ret !== undefined && raw.ret !== 0) ||
        (raw.errcode !== undefined && raw.errcode !== 0)
      )
        throw new Error('provider');
      return raw;
    } catch {
      if (!body && timeout.aborted && !signal.aborted) return { status: 'wait' };
      // No upstream response, code, verification number or credential enters logs/HTTP errors.
      throw new ApiError(502, '暂时无法连接微信扫码服务，请稍后重试。');
    }
  }
  return {
    async create(signal) {
      const raw = await request('/ilink/bot/get_bot_qrcode?bot_type=3', base, signal, {
        local_token_list: [],
      });
      const code = text.parse(raw.qrcode),
        content = text.parse(raw.qrcode_img_content);
      const target = new URL(content);
      if (
        !['http:', 'https:'].includes(target.protocol) ||
        target.username ||
        target.password ||
        target.port ||
        !/(?:^|\.)weixin\.qq\.com$|(?:^|\.)wechat\.com$/.test(target.hostname)
      )
        throw new ApiError(502, '微信二维码格式暂不支持，请重新连接。');
      return { code, content };
    },
    async poll(code, apiBase, signal, verifyCode) {
      const query = new URLSearchParams({
        qrcode: code,
        ...(verifyCode ? { verify_code: verifyCode } : {}),
      });
      const raw = await request(`/ilink/bot/get_qrcode_status?${query}`, apiBase, signal);
      switch (raw.status) {
        case 'wait':
          return { state: 'wait' };
        case 'scaned':
          return { state: 'scanned' };
        case 'need_verifycode':
          return { state: 'need_code' };
        case 'expired':
          return { state: 'expired' };
        case 'verify_code_blocked':
          return { state: 'blocked' };
        case 'binded_redirect':
          return { state: 'already_bound' };
        case 'scaned_but_redirect':
          return {
            state: 'redirect',
            base: ilinkBase(`https://${z.string().parse(raw.redirect_host)}`),
          };
        case 'confirmed': {
          const credentials = ilinkCredentials.parse({
            token: raw.bot_token,
            bot: raw.ilink_bot_id,
            user: raw.ilink_user_id,
            base: ilinkBase(typeof raw.baseurl === 'string' ? raw.baseurl : apiBase),
          });
          return { state: 'confirmed', credentials };
        }
        default:
          throw new ApiError(502, '微信扫码状态暂不支持，请重新生成二维码。');
      }
    },
  };
}
