import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Database, Sql } from './db.js';

const scryptAsync = promisify(scrypt);
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [salt, hex] = encoded.split(':');
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hex, 'hex');
  return expected.length === key.length && timingSafeEqual(expected, key);
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export interface Context {
  workspaceId: string;
  actorId: string;
  role: 'admin' | 'member';
  tx: Sql;
}
export async function scoped<T>(
  db: Database,
  actorId: string,
  workspaceId: string,
  fn: (ctx: Context) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    const membership = (
      await tx.query<{ role: 'admin' | 'member' }>(
        'SELECT role FROM memberships WHERE workspace_id = $1 AND actor_id = $2 AND active FOR SHARE',
        [workspaceId, actorId],
      )
    ).rows[0];
    if (!membership) throw new ApiError(404, '工作空间不存在或无权访问');
    await tx.query(
      "SELECT set_config('app.workspace_id', $1, true), set_config('app.actor_id', $2, true)",
      [workspaceId, actorId],
    );
    await tx.exec('SET LOCAL ROLE light_crm_app');
    return fn({ workspaceId, actorId, role: membership.role, tx });
  });
}
export function requireAdmin(ctx: Pick<Context, 'role'>) {
  if (ctx.role !== 'admin') throw new ApiError(403, '此操作需要工作空间管理员权限');
}
