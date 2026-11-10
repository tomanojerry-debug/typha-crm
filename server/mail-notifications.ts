import { z } from 'zod';
import { ApiError, type Context } from './security.js';
import { recognizeMailCustomers } from './mail-customer-recognition.js';
import type { MailMessage } from '../shared/connections.js';

const source = `mail_messages m LEFT JOIN customers c ON c.workspace_id=m.workspace_id AND c.id=m.customer_id
LEFT JOIN mail_notification_reads r ON r.workspace_id=m.workspace_id AND r.message_id=m.id AND r.actor_id=$2`;
const visible = `m.workspace_id=$1 AND m.direction='inbound' AND m.received_after_connection AND m.notification_enabled`;
export async function notificationSummary(ctx: Context) {
  return (
    await ctx.tx.query<{ unread: number; pending: number }>(
      `SELECT count(*) FILTER(WHERE r.message_id IS NULL)::int AS unread,
    count(*) FILTER(WHERE m.customer_id IS NULL)::int AS pending FROM ${source} WHERE ${visible}`,
      [ctx.workspaceId, ctx.actorId],
    )
  ).rows[0];
}
export async function notifications(ctx: Context, input: unknown) {
  const q = z
    .strictObject({
      filter: z.enum(['all', 'unread', 'pending']).default('all'),
      q: z.string().trim().max(100).default(''),
      page: z.coerce.number().int().min(1).max(100000).default(1),
    })
    .parse(input);
  const where = `${visible} ${q.filter === 'unread' ? 'AND r.message_id IS NULL' : q.filter === 'pending' ? 'AND m.customer_id IS NULL' : ''}
  AND ($3='' OR position(lower($3) in lower(m.subject||' '||m.sender::text))>0)`;
  const params = [ctx.workspaceId, ctx.actorId, q.q];
  const total = (
    await ctx.tx.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM ${source} WHERE ${where}`,
      params,
    )
  ).rows[0].total;
  const items = (
    await ctx.tx.query<MailMessage & { unread: boolean }>(
      `SELECT m.id,m.subject,m.sender,m.occurred_at,m.customer_id,c.name AS customer_name,
    m.body,m.account_email,m.direction,m.recipients,m.cc,
    left(m.body,180) AS preview,(r.message_id IS NULL) AS unread FROM ${source} WHERE ${where}
    ORDER BY m.occurred_at DESC,m.id LIMIT 30 OFFSET $4`,
      [...params, (q.page - 1) * 30],
    )
  ).rows;
  const recognition = await recognizeMailCustomers(ctx, items);
  return {
    items: items.map(
      (
        {
          body: _body,
          account_email: _account,
          direction: _direction,
          recipients: _to,
          cc: _cc,
          ...item
        },
        i,
      ) => ({ ...item, customer_recognition: recognition[i] }),
    ),
    total,
    page: q.page,
    ...(await notificationSummary(ctx)),
  };
}
export async function readNotification(ctx: Context, id: string) {
  const row = (
    await ctx.tx.query(`SELECT id FROM mail_messages m WHERE ${visible} AND m.id=$2`, [
      ctx.workspaceId,
      id,
    ])
  ).rows[0];
  if (!row) throw new ApiError(404, '通知不存在或无权访问');
  await ctx.tx.query(
    `INSERT INTO mail_notification_reads(workspace_id,actor_id,message_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [ctx.workspaceId, ctx.actorId, id],
  );
  return { ok: true };
}
