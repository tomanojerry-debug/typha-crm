import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError, type Context } from './security.js';
import { activeCustomer, customer, project } from './service.js';

const recordLimit = 10000;
const singleLine = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029\uD800-\uDFFF]+$/u;
const reference = z
  .string()
  .max(250)
  .regex(singleLine)
  .refine((value) => value === value.trim());
const messageInput = z.strictObject({
  shop_domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/),
  conversation_id: reference,
  message_id: reference,
  occurred_at: z.iso
    .datetime({ offset: true })
    .refine((value) => !/\.\d{4}/.test(value), '消息时间精度最多到毫秒'),
  sender_name: z.string().regex(singleLine).trim().min(1).max(250).optional(),
  sender_email: z.string().trim().pipe(z.email().max(254)).optional(),
  project_id: z.uuid().nullable().default(null),
  text: z
    .string()
    .max(recordLimit)
    .refine((value) => value.trim().length > 0 && !/[\u0000\uD800-\uDFFF]/u.test(value)),
});

function recordId(ctx: Context, message: z.infer<typeof messageInput>) {
  const bytes = createHash('sha256')
    .update(
      JSON.stringify([
        'shopify-inbox-message-v1',
        ctx.workspaceId.toLowerCase(),
        ctx.actorId.toLowerCase(),
        message.shop_domain,
        message.conversation_id,
        message.message_id,
      ]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function importShopifyInboxMessage(ctx: Context, customerId: string, input: unknown) {
  const message = messageInput.parse(input);
  const timestamp = new Date(message.occurred_at);
  if (
    !Number.isFinite(timestamp.getTime()) ||
    timestamp.getUTCFullYear() < 1 ||
    timestamp.getUTCFullYear() > 9999
  )
    throw new ApiError(400, '请提供有效的消息时间和时区');
  const occurredAt = timestamp.toISOString();
  const body = [
    '人工导入的 Shopify Inbox 顾客原话',
    `店铺：${message.shop_domain}`,
    `会话编号：${message.conversation_id}`,
    `消息编号：${message.message_id}`,
    `消息时间：${occurredAt}`,
    ...(message.sender_name ? [`发言者：${message.sender_name}`] : []),
    ...(message.sender_email ? [`发言者邮箱：${message.sender_email}`] : []),
    '原文属于顾客陈述。公司确认信息需要另行核对。',
    '',
    message.text,
  ].join('\n');
  if (body.length > recordLimit) throw new ApiError(413, '消息原文和来源信息合计超过 10000 字符');

  activeCustomer(await customer(ctx, customerId, true));
  if (message.project_id && (await project(ctx, customerId, message.project_id)).archived_at)
    throw new ApiError(409, '项目已归档');

  // Caller-supplied message references belong to the importing actor's namespace.
  // Keeping the target out of the key prevents the same actor from filing the message twice.
  const id = recordId(ctx, message);
  const inserted = await ctx.tx.query<{ id: string }>(
    `INSERT INTO customer_records(workspace_id,customer_id,project_id,id,kind,body,created_by,source_kind,occurred_at)
     SELECT c.workspace_id,c.id,$3::uuid,$4::uuid,'customer_quote',$5,$6::uuid,'manual',$7::timestamptz
     FROM customers c
     WHERE c.workspace_id=$1 AND c.id=$2 AND c.archived_at IS NULL
       AND crm_access(c.workspace_id,c.id,true)
       AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM projects p
         WHERE p.workspace_id=c.workspace_id AND p.customer_id=c.id AND p.id=$3 AND p.archived_at IS NULL))
     ON CONFLICT(workspace_id,id) DO NOTHING RETURNING id`,
    [ctx.workspaceId, customerId, message.project_id, id, body, ctx.actorId, occurredAt],
  );
  if (inserted.rows.length) return { record_id: id, reused: false };

  const existing = await ctx.tx.query<{ id: string }>(
    `SELECT r.id FROM customer_records r
     JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id
     LEFT JOIN projects p ON p.workspace_id=r.workspace_id AND p.customer_id=r.customer_id AND p.id=r.project_id
     WHERE r.workspace_id=$1 AND r.customer_id=$2 AND r.id=$3 AND r.project_id IS NOT DISTINCT FROM $4::uuid
       AND r.kind='customer_quote' AND r.source_kind='manual' AND r.body=$5 AND r.occurred_at=$6::timestamptz
       AND r.created_by=$7 AND crm_access(r.workspace_id,r.customer_id,true)
       AND c.archived_at IS NULL AND (r.project_id IS NULL OR (p.id IS NOT NULL AND p.archived_at IS NULL))`,
    [ctx.workspaceId, customerId, id, message.project_id, body, occurredAt, ctx.actorId],
  );
  if (!existing.rows.length) throw new ApiError(409, '消息无法导入，请核对来源、原文和归属');
  return { record_id: id, reused: true };
}
