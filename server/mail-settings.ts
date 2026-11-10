import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, requireAdmin, type Context } from './security.js';
import type {
  MailExclusions,
  MailProcessingSettings,
  ExclusionImpact,
} from '../shared/connections.js';

const address = z.string().trim().toLowerCase().pipe(z.email().max(254));
const rules = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .refine(
        (value) =>
          value.includes('@')
            ? z.email().safeParse(value).success
            : /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value),
        '请填写完整邮箱地址或域名，不支持通配符和网址',
      ),
  )
  .max(100)
  .transform((items) => [...new Set(items)].sort());
const processing = z.strictObject({
  intake_mode: z.enum(['review', 'manual']),
  // Accept old clients, but both categories are always enabled when saving and syncing.
  notify_unknown: z.boolean().optional(),
  notify_known: z.boolean().optional(),
  muted_senders: z
    .array(address)
    .max(100)
    .transform((items) => [...new Set(items)].sort()),
  settings_version: z.number().int().positive(),
});
export async function saveProcessing(ctx: Context, id: string, input: unknown) {
  requireAdmin(ctx);
  const v = processing.parse(input);
  const current = (
    await ctx.tx.query<{ settings_version: number }>(
      'SELECT settings_version FROM mail_accounts WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [ctx.workspaceId, id],
    )
  ).rows[0];
  if (!current) throw new ApiError(404, '邮箱连接不存在');
  if (current.settings_version !== v.settings_version)
    throw new ApiError(409, '收信设置已被修改，请重新打开后再保存');
  const row = (
    await ctx.tx.query<MailProcessingSettings>(
      `UPDATE mail_accounts SET intake_mode=$3,notify_unknown=$4,notify_known=$5,muted_senders=$6::jsonb,
    settings_version=settings_version+1,settings_updated_at=now() WHERE workspace_id=$1 AND id=$2
    RETURNING intake_mode,notify_unknown,notify_known,muted_senders,settings_version,settings_updated_at`,
      [ctx.workspaceId, id, v.intake_mode, true, true, JSON.stringify(v.muted_senders)],
    )
  ).rows[0];
  await audit(ctx, 'processing', row, id);
  return row;
}
async function audit(ctx: Context, kind: string, settings: unknown, account: string | null = null) {
  await ctx.tx.query(
    'INSERT INTO mail_settings_audit(id,workspace_id,actor_id,account_id,kind,settings) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
    [randomUUID(), ctx.workspaceId, ctx.actorId, account, kind, JSON.stringify(settings)],
  );
}
export async function exclusions(ctx: Context): Promise<MailExclusions> {
  requireAdmin(ctx);
  return (
    (
      await ctx.tx.query<MailExclusions>(
        'SELECT rules,version,updated_at FROM mail_exclusions WHERE workspace_id=$1',
        [ctx.workspaceId],
      )
    ).rows[0] ?? { rules: [], version: 0, updated_at: null }
  );
}
const exclusionInput = z.strictObject({ rules, version: z.number().int().nonnegative() });
export async function previewExclusions(ctx: Context, input: unknown) {
  requireAdmin(ctx);
  const v = exclusionInput.parse(input);
  const current = await exclusions(ctx);
  if (current.version !== v.version) throw new ApiError(409, '排除名单已被修改，请重新打开设置');
  const impact = (
    await ctx.tx.query<ExclusionImpact>('SELECT * FROM crm_mail_exclusion_impact($1::jsonb)', [
      JSON.stringify(v.rules),
    ])
  ).rows;
  return { rules: v.rules, version: current.version, impact };
}
export async function saveExclusions(ctx: Context, input: unknown) {
  requireAdmin(ctx);
  const v = exclusionInput.extend({ reviewed: z.literal(true) }).parse(input);
  // A placeholder row serializes first creation without broad workspace write privileges.
  await ctx.tx.query(
    'INSERT INTO mail_exclusions(workspace_id,version) VALUES($1,0) ON CONFLICT DO NOTHING',
    [ctx.workspaceId],
  );
  await ctx.tx.query('SELECT version FROM mail_exclusions WHERE workspace_id=$1 FOR UPDATE', [
    ctx.workspaceId,
  ]);
  if ((await exclusions(ctx)).version !== v.version)
    throw new ApiError(409, '排除名单已被修改，请重新预览');
  const row = (
    await ctx.tx.query<MailExclusions>(
      `INSERT INTO mail_exclusions(workspace_id,rules) VALUES($1,$2::jsonb)
    ON CONFLICT(workspace_id) DO UPDATE SET rules=EXCLUDED.rules,version=mail_exclusions.version+1,updated_at=now()
    RETURNING rules,version,updated_at`,
      [ctx.workspaceId, JSON.stringify(v.rules)],
    )
  ).rows[0];
  await audit(ctx, 'exclusions', row);
  return row;
}
export async function isExcluded(ctx: Context, participants: string[]) {
  return (
    await ctx.tx.query<{ blocked: boolean }>('SELECT crm_mail_excluded($1,$2::jsonb) AS blocked', [
      ctx.workspaceId,
      JSON.stringify(participants),
    ])
  ).rows[0].blocked;
}
