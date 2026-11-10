import type { Request } from 'express';
import { ApiError } from './security.js';

const loopbackHosts = new Set(['127.0.0.1', '[::1]']);
const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function validateLocalAccess(options: {
  development?: boolean;
  secureCookies?: boolean;
  origin: string;
  host?: string;
  databaseUrl?: string;
}) {
  const origin = new URL(options.origin);
  if (
    !options.development ||
    options.secureCookies ||
    origin.protocol !== 'http:' ||
    !loopbackHosts.has(origin.hostname) ||
    (options.host !== undefined && !['127.0.0.1', '::1'].includes(options.host)) ||
    options.databaseUrl
  ) {
    throw new Error('本地直接访问仅支持回环地址上的开发环境与本地数据库');
  }
}

export function requireLocalRequest(req: Request, origin: string) {
  if (
    !loopbackAddresses.has(req.socket.remoteAddress ?? '') ||
    req.get('host') !== new URL(origin).host ||
    (req.get('origin') !== undefined && req.get('origin') !== origin) ||
    req.get('sec-fetch-site') === 'cross-site'
  ) {
    throw new ApiError(403, '本地工作台仅接受本机同源访问');
  }
}
