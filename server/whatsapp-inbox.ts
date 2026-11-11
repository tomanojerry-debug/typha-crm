import { z } from 'zod';
import type { Database } from './db.js';
import { ApiError, scoped, type Context } from './security.js';
import * as service from './service.js';

export type WhatsAppInboxConfig = {
  appSecret: string;
  verifyToken: string;
  wabaId: string;
  phoneNumberId: string;
  workspaceId: string;
  actorId: string;
};

export type WhatsAppIncomingMessage = {
  messageId: string;
  senderId: string;
  senderName: string | null;
  occurredAt: string;
  text: string;
};

const sourceLabel = (limit: number) =>
  z
    .string()
    .min(1)
    .max(limit)
    .refine((value) => !/[\x00-\x1f\x7f\u0085\u2028\u2029\p{Surrogate}]/u.test(value));
const incomingMessage = z.strictObject({
  messageId: sourceLabel(250),
  senderId: sourceLabel(250),
  senderName: sourceLabel(120).nullable(),
  occurredAt: z.iso.datetime(),
  text: z
    .string()
    .max(8000)
    .refine((value) => value.trim() !== '' && !/[\0\p{Surrogate}]/u.test(value)),
});

const pageNumber = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]);
const pagination = z.strictObject({
  limit: pageNumber.pipe(z.number().int().min(1).max(100)).default(30),
  offset: pageNumber.pipe(z.number().int().min(0).max(10000)).default(0),
});

const target = z.strictObject({
  customer_id: z.uuid().transform((id) => id.toLowerCase()),
  project_id: z
    .uuid()
    .transform((id) => id.toLowerCase())
    .nullable()
    .default(null),
});

type PendingMessage = {
  id: string;
  message_id: string;
  sender_id: string;
  sender_name: string | null;
  occurred_at: string;
  text: string;
};

type InboxRow = Omit<PendingMessage, 'text'> &
  (
    | { text: string; customer_id: null; project_id: null; record_id: null }
    | { text: null; customer_id: string; project_id: string | null; record_id: string }
  );

const inboxScope = 'workspace_id=$1 AND actor_id=$2 AND waba_id=$3 AND phone_number_id=$4';

function scopeValues(ctx: Context, config: WhatsAppInboxConfig) {
  if (
    ctx.workspaceId.toLowerCase() !== config.workspaceId.toLowerCase() ||
    ctx.actorId.toLowerCase() !== config.actorId.toLowerCase()
  )
    throw new ApiError(404, 'WhatsApp 收件区不存在或无权访问');
  return [ctx.workspaceId, ctx.actorId, config.wabaId, config.phoneNumberId];
}

export async function ingestWhatsAppMessages(
  db: Database,
  config: WhatsAppInboxConfig,
  messages: readonly WhatsAppIncomingMessage[],
): Promise<{ inserted: number }> {
  if (!messages.length) return { inserted: 0 };
  const values = z.array(incomingMessage).parse(messages);
  return scoped(db, config.actorId, config.workspaceId, async (ctx) => {
    const result = await ctx.tx.query<{ id: string }>(
      `INSERT INTO whatsapp_inbox_messages(workspace_id,actor_id,waba_id,phone_number_id,message_id,sender_id,sender_name,occurred_at,text)
       SELECT $1::uuid,$2::uuid,$3,$4,m."messageId",m."senderId",m."senderName",m."occurredAt",m.text
       FROM jsonb_to_recordset($5::jsonb) AS m("messageId" text,"senderId" text,"senderName" text,"occurredAt" timestamptz,text text)
       ORDER BY m."messageId"
       ON CONFLICT(workspace_id,actor_id,waba_id,phone_number_id,message_id) DO NOTHING
       RETURNING id`,
      [...scopeValues(ctx, config), JSON.stringify(values)],
    );
    return { inserted: result.rows.length };
  });
}

export async function listWhatsAppInbox(ctx: Context, config: WhatsAppInboxConfig, raw: unknown) {
  const scope = scopeValues(ctx, config);
  const { limit, offset } = pagination.parse(raw);
  const result = await ctx.tx.query<{ messages: PendingMessage[]; total: number }>(
    `WITH page AS (
       SELECT id,message_id,sender_id,sender_name,occurred_at,text FROM whatsapp_inbox_messages
       WHERE ${inboxScope} AND record_id IS NULL
       ORDER BY occurred_at DESC,id LIMIT $5 OFFSET $6
     )
     SELECT COALESCE((SELECT jsonb_agg(page ORDER BY occurred_at DESC,id) FROM page),'[]'::jsonb) AS messages,
       (SELECT count(*)::int FROM whatsapp_inbox_messages WHERE ${inboxScope} AND record_id IS NULL) AS total`,
    [...scope, limit, offset],
  );
  const { messages, total } = result.rows[0];
  return {
    messages: messages.map((message) => ({
      ...message,
      occurred_at: new Date(message.occurred_at).toISOString(),
    })),
    total,
  };
}

async function validateTarget(ctx: Context, customerId: string, projectId: string | null) {
  service.activeCustomer(await service.customer(ctx, customerId, true));
  if (projectId && (await service.project(ctx, customerId, projectId)).archived_at) {
    throw new ApiError(409, '项目已归档');
  }
}

export async function archiveWhatsAppMessage(
  ctx: Context,
  config: WhatsAppInboxConfig,
  id: string,
  raw: unknown,
): Promise<{ record_id: string; reused: boolean }> {
  const scope = scopeValues(ctx, config);
  const { customer_id, project_id } = target.parse(raw);
  const row = (
    await ctx.tx.query<InboxRow>(
      `SELECT id,message_id,sender_id,sender_name,occurred_at,text,customer_id,project_id,record_id
     FROM whatsapp_inbox_messages WHERE ${inboxScope} AND id=$5 FOR UPDATE`,
      [...scope, z.uuid().parse(id)],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, 'WhatsApp 消息不存在或无权访问');
  if (row.record_id !== null) {
    await validateTarget(ctx, row.customer_id, row.project_id);
    if (row.customer_id !== customer_id || row.project_id !== project_id) {
      throw new ApiError(409, '这条 WhatsApp 消息已归档到其他客户或项目');
    }
    return { record_id: row.record_id, reused: true };
  }

  await validateTarget(ctx, customer_id, project_id);
  const occurredAt = new Date(row.occurred_at).toISOString();
  const sender = row.sender_name ? `${row.sender_name} (${row.sender_id})` : row.sender_id;
  const body = `WhatsApp 文字原文\n商家账户 ${config.wabaId} · 号码标识 ${config.phoneNumberId}\n${occurredAt} · ${sender} · 来源消息 ${row.message_id}\n\n${row.text}`;
  const record = await service.insert(ctx, 'customer_records', {
    customer_id,
    project_id,
    kind: 'customer_quote',
    source_kind: 'manual',
    occurred_at: occurredAt,
    body,
    created_by: ctx.actorId,
  });
  const recordId = String(record.id);
  const archived = await ctx.tx.query<{ record_id: string }>(
    `UPDATE whatsapp_inbox_messages SET customer_id=$6,project_id=$7,record_id=$8,text=NULL,sender_name=NULL
     WHERE ${inboxScope} AND id=$5 RETURNING record_id`,
    [...scope, row.id, customer_id, project_id, recordId],
  );
  if (!archived.rows.length) throw new ApiError(409, 'WhatsApp 消息状态已变化，请刷新后重试');
  return { record_id: recordId, reused: false };
}
