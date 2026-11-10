import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Database, Sql } from './db.js';
import { ApiError, requireAdmin, scoped, type Context } from './security.js';
import { person } from './people.js';
import { activeCustomer, customer, project } from './service.js';
import { unseal } from './mail-secrets.js';
import {
  smtpTransport,
  neteaseSmtp,
  SubmissionError,
  type SendTransport,
} from './smtp-transport.js';
import type {
  OutgoingContent,
  OutgoingMail,
  OutgoingStatus,
  ReplyOptions,
  ComposeOptions,
  OutgoingDelivery,
} from '../shared/outgoing.js';
import type { MailMessage } from '../shared/connections.js';
import { mailMessageId, mailReferences } from '../shared/mail-thread.js';
import { lockedOutgoing } from '../shared/outgoing.js';
import { uuid } from './validation.js';
import { hasMailVariables, mailVariableText } from '../shared/mail-variables.js';
import {
  mailVariableDocumentSchema,
  mailRecipientBindingsSchema,
  mailVariableCatalog,
  validateDocument,
  validateRecipientBindings,
  previewMailVariables,
  variableDataDigest,
} from './mail-variables.js';

const address = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const outgoingContentSchema = z
  .object({
    variable_document: mailVariableDocumentSchema.optional(),
    recipient_bindings: mailRecipientBindingsSchema.optional(),
    mass_sending: z.boolean().optional(),
    account_id: uuid.nullable(),
    project_id: uuid.nullable(),
    to: z.array(address).max(20),
    cc: z.array(address).max(20),
    bcc: z.array(address).max(20),
    subject: z
      .string()
      .max(500)
      .refine((s) => !/[\r\n]/.test(s)),
    body: z.string().max(100000),
    attachments: z
      .array(
        z
          .object({
            name: z
              .string()
              .trim()
              .min(1)
              .max(200)
              .refine((s) => !/[\r\n/\\\u0000]/.test(s)),
            content: z
              .string()
              .max(7 * 1024 * 1024)
              .refine(
                (s) =>
                  /^[A-Za-z0-9+/]*={0,2}$/.test(s) &&
                  Buffer.from(s, 'base64').toString('base64') === s,
              ),
          })
          .strict(),
      )
      .max(10),
  })
  .strict()
  .refine(
    (v) =>
      v.attachments.reduce((n, a) => n + Buffer.from(a.content, 'base64').length, 0) <=
      5 * 1024 * 1024,
    '附件总大小不能超过 5 MB',
  )
  .refine(
    (v) => !v.mass_sending || (!v.cc.length && !v.bcc.length),
    '群发逐人发送，请先移除抄送和密送',
  );
const versionSchema = z.object({ version: z.number().int().positive() }).strict();
/** Reused by the domain service and fixed Harness adapter; no new operation. */
export const outgoingSaveInputSchema = z
  .object({
    id: uuid,
    version: z.number().int().nonnegative(),
    content: outgoingContentSchema,
    reply_to_message_id: uuid.nullable().default(null),
  })
  .strict();
interface Row extends Omit<OutgoingMail, keyof OutgoingContent> {
  account_id: string | null;
  project_id: string | null;
  content: Omit<OutgoingContent, 'account_id' | 'project_id'>;
  approved_digest: string | null;
  started_at: string | null;
}
interface Sender {
  id: string;
  email: string;
  secret: string;
  enabled: boolean;
}
export interface OutgoingOptions {
  key?: Buffer;
  transport?: SendTransport;
  /** Trusted server configuration; never accepted from an HTTP request. */
  clock?: () => number;
}
function outgoingNow(options: OutgoingOptions) {
  const value = (options.clock ?? Date.now)();
  if (!Number.isFinite(value) || Number.isNaN(new Date(value).getTime()))
    throw new ApiError(500, '邮件业务时间配置无效');
  return value;
}
const expose = (r: Row): OutgoingMail => {
  const { content, approved_digest: _digest, started_at: _started, ...rest } = r;
  return { ...rest, ...content };
};
const digest = (r: Row) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        r.workspace_id,
        r.customer_id,
        r.person_id,
        r.project_id,
        r.account_id,
        r.from_email,
        r.version,
        r.content.to,
        r.content.cc,
        r.content.bcc,
        r.content.subject,
        r.content.body,
        r.content.attachments.map((a) => [a.name, a.content]),
        ...(r.reply_to_message_id ? [r.reply_to_message_id, r.in_reply_to, r.reference_ids] : []),
        ...(r.content.mass_sending ? ['mass_sending', true] : []),
        ...(hasMailVariables(r.content.variable_document)
          ? ['mail_variables', variableDataDigest(r.variable_snapshot)]
          : []),
      ]),
    )
    .digest('hex');
async function row(ctx: Context, id: string, lock = false) {
  const r = (
    await ctx.tx.query<Row>(
      `SELECT * FROM outgoing_mail WHERE workspace_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`,
      [ctx.workspaceId, id],
    )
  ).rows[0];
  if (!r) throw new ApiError(404, '邮件草稿不存在或无权访问');
  return r;
}
async function target(ctx: Context, id: string, kind: 'people' | 'customers' = 'people') {
  if (kind === 'people') return person(ctx, id);
  const c = await customer(ctx, id);
  return { ...c, customer_id: c.id, customer_name: c.name };
}
async function activeScope(
  ctx: Context,
  personId: string | null,
  projectId: string | null,
  customerId?: string,
) {
  const p = await target(ctx, personId || customerId!, personId ? 'people' : 'customers');
  activeCustomer(await customer(ctx, p.customer_id, true));
  if (p.archived_at) throw new ApiError(409, '联系人已归档，请先恢复');
  if (projectId && (await project(ctx, p.customer_id, projectId)).archived_at)
    throw new ApiError(409, '项目已归档，请重新选择');
  return p;
}
async function sender(ctx: Context, id: string | null) {
  requireAdmin(ctx);
  if (!id) throw new ApiError(400, '请选择发件邮箱');
  const r = (
    await ctx.tx.query<Sender>(
      'SELECT id,email,secret,enabled FROM mail_accounts WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId, id],
    )
  ).rows[0];
  if (!r?.enabled) throw new ApiError(409, '发件邮箱不存在或已暂停');
  return r;
}
async function ready(ctx: Context, r: Row, useSnapshot = true) {
  if (r.reply_to_message_id) await replySource(ctx, r.reply_to_message_id, r.customer_id);
  const p = await activeScope(ctx, r.person_id, r.project_id, r.customer_id);
  const account = await sender(ctx, r.account_id);
  await validateRecipientBindings(ctx, r.customer_id, r.content.to, r.content.recipient_bindings);
  if (useSnapshot && hasMailVariables(r.content.variable_document) && r.variable_snapshot)
    await validateRecipientBindings(
      ctx,
      r.customer_id,
      r.content.to,
      r.variable_snapshot.recipient_bindings,
    );
  if (r.content.mass_sending) {
    if (r.content.cc.length || r.content.bcc.length || r.reply_to_message_id)
      throw new ApiError(400, '群发不支持抄送、密送或回复，请分别写信');
    // Each copy stays in the explicitly reviewed customer/project scope.
    const foreign = (
      await ctx.tx.query(
        `SELECT 1 FROM people WHERE workspace_id=$1 AND customer_id<>$2 AND lower(trim(email))=ANY($3::text[]) LIMIT 1`,
        [ctx.workspaceId, r.customer_id, r.content.to],
      )
    ).rows.length;
    if (foreign) throw new ApiError(400, '群发收件人含其他公司的联系人，请在对应公司内分别写信');
  }
  if (!r.content.to.length || !r.content.subject.trim() || !r.content.body.trim())
    throw new ApiError(400, '请填写收件人、主题和正文');
  const recipients = [...r.content.to, ...r.content.cc, ...r.content.bcc];
  if (new Set(recipients).size !== recipients.length)
    throw new ApiError(400, '收件人、抄送和密送中存在重复邮箱');
  return account;
}
export async function recipientOptions(
  ctx: Context,
  personId: string,
  input: unknown,
  kind: 'people' | 'customers' = 'people',
) {
  const p = await target(ctx, personId, kind);
  const { q, mass } = z
    .object({
      q: z.string().trim().max(100).default(''),
      mass: z.enum(['true', 'false']).optional(),
    })
    .strict()
    .parse(input);
  // Contact search uses the same server-side customer visibility as People.
  return (
    await ctx.tx.query(
      `SELECT p.id,p.name,p.email,p.customer_id,c.name AS customer_name FROM people p JOIN customers c ON c.workspace_id=p.workspace_id AND c.id=p.customer_id WHERE p.workspace_id=$1 AND p.archived_at IS NULL AND c.archived_at IS NULL AND trim(p.email)<>'' AND ($3::uuid IS NULL OR p.customer_id=$3) AND ($2='' OR position(lower($2) in lower(p.name||' '||p.email||' '||c.name))>0) ORDER BY p.name,p.id LIMIT 30`,
      [ctx.workspaceId, q, mass === 'true' ? p.customer_id : null],
    )
  ).rows;
}
function checkVersion(r: Row, version: number) {
  if (r.version !== version) throw new ApiError(409, '邮件已有新版本，请关闭后重新打开');
}
export async function composeOptions(
  ctx: Context,
  personId: string,
  kind: 'people' | 'customers' = 'people',
): Promise<ComposeOptions> {
  const p = await target(ctx, personId, kind);
  return {
    mail_variables: await mailVariableCatalog(ctx),
    accounts:
      ctx.role === 'admin'
        ? (
            await ctx.tx.query<{ id: string; email: string }>(
              'SELECT id,email FROM mail_accounts WHERE workspace_id=$1 AND enabled ORDER BY created_at,id',
              [ctx.workspaceId],
            )
          ).rows
        : [],
    projects: (
      await ctx.tx.query<{ id: string; name: string }>(
        'SELECT id,name FROM projects WHERE workspace_id=$1 AND customer_id=$2 AND archived_at IS NULL ORDER BY name,id',
        [ctx.workspaceId, p.customer_id],
      )
    ).rows,
    sender_notice: ctx.role === 'admin' ? null : '当前工作空间邮箱由管理员发送；你可以先保存草稿。',
  };
}
async function replySource(ctx: Context, id: string, customerId?: string) {
  const source = (
    await ctx.tx.query<MailMessage>(
      `SELECT m.*,c.name AS customer_name FROM mail_messages m LEFT JOIN customers c ON c.workspace_id=m.workspace_id AND c.id=m.customer_id WHERE m.workspace_id=$1 AND m.id=$2`,
      [ctx.workspaceId, id],
    )
  ).rows[0];
  if (!source || (customerId && source.customer_id !== customerId))
    throw new ApiError(404, '原邮件不存在或不属于当前客户');
  if (!source.customer_id) throw new ApiError(409, '请先录入或关联客户，再回复这封邮件');
  return source;
}
export async function replyOptions(
  ctx: Context,
  id: string,
  input: unknown,
): Promise<ReplyOptions> {
  const { mode, draft_id } = z
    .strictObject({ mode: z.enum(['reply', 'all']).default('reply'), draft_id: uuid.optional() })
    .parse(input);
  const source = await replySource(ctx, id);
  await activeScope(ctx, null, source.project_id, source.customer_id!);
  const people = (
    await ctx.tx.query<{ id: string }>(
      `SELECT p.id FROM mail_people mp JOIN people p ON p.workspace_id=mp.workspace_id AND p.customer_id=mp.customer_id AND p.id=mp.person_id WHERE mp.workspace_id=$1 AND mp.message_id=$2 AND p.archived_at IS NULL ORDER BY p.id LIMIT 2`,
      [ctx.workspaceId, id],
    )
  ).rows;
  const draft = draft_id ? await row(ctx, draft_id) : null;
  if (draft && draft.reply_to_message_id !== id)
    throw new ApiError(404, '该草稿不是这封邮件的回复');
  const personId = draft ? draft.person_id : people.length === 1 ? people[0].id : null;
  const kind = personId ? 'people' : 'customers';
  const p = await target(ctx, personId || source.customer_id!, kind);
  const options = await composeOptions(ctx, p.id, kind);
  const accounts = (
    await ctx.tx.query<{ email: string; aliases: string[] }>(
      'SELECT email,aliases FROM mail_accounts WHERE workspace_id=$1',
      [ctx.workspaceId],
    )
  ).rows;
  const own = new Set(
    [source.account_email, ...accounts.flatMap((a) => [a.email, ...a.aliases])].map((a) =>
      a.toLowerCase(),
    ),
  );
  const addresses = (values: MailMessage['sender']) => [
    ...new Set(
      values
        .map((a) => a.address.trim().toLowerCase())
        .filter((a) => !own.has(a) && address.safeParse(a).success),
    ),
  ];
  const to = addresses(
    source.direction === 'outbound'
      ? source.recipients
      : source.reply_to?.length
        ? source.reply_to
        : source.sender,
  );
  if (mode === 'all' && source.direction === 'inbound')
    to.push(...addresses(source.recipients).filter((a) => !to.includes(a)));
  const cc = mode === 'all' ? addresses(source.cc).filter((a) => !to.includes(a)) : [];
  const parentId = mailMessageId(source.message_id);
  const references = parentId
    ? mailReferences([...mailReferences(source.reference_ids), parentId])
    : [];
  return {
    source_id: source.id,
    kind,
    target: {
      id: p.id,
      name: p.name,
      email: p.email,
      customer_id: p.customer_id,
      customer_name: p.customer_name || '',
    },
    options,
    content: {
      account_id: options.accounts.some((a) => a.id === source.account_id)
        ? source.account_id
        : null,
      project_id: source.project_id,
      to,
      cc,
      bcc: [],
      subject: (/^(?:re|回复|答复)(?:\[\d+\])?\s*[:：]/i.test(source.subject.trim())
        ? source.subject
        : `Re: ${source.subject}`
      )
        .replace(/[\r\n]/g, ' ')
        .slice(0, 500),
      body: '',
      attachments: [],
    },
    in_reply_to: parentId,
    reference_ids: references,
  };
}
export async function listReplies(ctx: Context, id: string) {
  await replySource(ctx, id);
  return (
    await ctx.tx.query(
      `SELECT id,content->>'subject' AS subject,status,scheduled_at,updated_at FROM outgoing_mail WHERE workspace_id=$1 AND reply_to_message_id=$2 ORDER BY updated_at DESC,id LIMIT 100`,
      [ctx.workspaceId, id],
    )
  ).rows;
}
export async function listOutgoing(
  ctx: Context,
  personId: string,
  kind: 'people' | 'customers' = 'people',
) {
  await target(ctx, personId, kind);
  return (
    await ctx.tx.query(
      "SELECT id,subject,status,scheduled_at,updated_at FROM (SELECT *,content->>'subject' AS subject FROM outgoing_mail) d WHERE workspace_id=$1 AND (($3='people' AND person_id=$2) OR ($3='customers' AND customer_id=$2 AND person_id IS NULL)) ORDER BY updated_at DESC,id LIMIT 100",
      [ctx.workspaceId, personId, kind],
    )
  ).rows;
}
export async function getOutgoing(ctx: Context, id: string) {
  const r = await row(ctx, id);
  return {
    ...expose(r),
    ...(r.content.mass_sending ? { deliveries: await deliveries(ctx.tx, r) } : {}),
  };
}
async function deliveries(tx: Sql, r: Row): Promise<OutgoingDelivery[]> {
  return (
    await tx.query<OutgoingDelivery>(
      'SELECT id,recipient,message_id,status,error FROM outgoing_deliveries WHERE workspace_id=$1 AND outgoing_id=$2 AND batch_id=$3 ORDER BY recipient,id',
      [r.workspace_id, r.id, r.message_id],
    )
  ).rows;
}
export async function testSender(
  db: Database,
  actorId: string,
  workspaceId: string,
  id: string,
  options: OutgoingOptions,
) {
  if (!options.key) throw new ApiError(503, '服务端邮箱密钥不可用');
  const account = await scoped(db, actorId, workspaceId, (ctx) => sender(ctx, id));
  const client = neteaseSmtp(
    account.email,
    unseal(account.secret, options.key, `${workspaceId}:${account.id}`),
  );
  try {
    await client.verify();
    return { ok: true, message: '发信连接可用，未发送邮件' };
  } catch {
    throw new ApiError(502, '发信连接未通过，请检查网易 SMTP 服务是否开启、授权码和网络');
  } finally {
    client.close();
  }
}
export async function saveOutgoing(
  ctx: Context,
  targetId: string,
  input: unknown,
  kind: 'people' | 'customers' = 'people',
) {
  const personId = kind === 'people' ? targetId : null;
  const v = outgoingSaveInputSchema.parse(input);
  const p = await activeScope(
    ctx,
    personId,
    v.content.project_id,
    kind === 'customers' ? targetId : undefined,
  );
  if (v.content.account_id) await sender(ctx, v.content.account_id);
  const source = v.reply_to_message_id
    ? await replySource(ctx, v.reply_to_message_id, p.customer_id)
    : null;
  if (v.content.variable_document) {
    await validateDocument(ctx, v.content.variable_document);
    if (
      mailVariableText(v.content.variable_document.subject) !== v.content.subject ||
      mailVariableText(v.content.variable_document.body) !== v.content.body
    )
      throw new ApiError(400, '变量文档与邮件编辑内容不一致，请重新保存');
  }
  await validateRecipientBindings(ctx, p.customer_id, v.content.to, v.content.recipient_bindings);
  const parentId = mailMessageId(source?.message_id);
  const references = parentId
    ? mailReferences([...mailReferences(source?.reference_ids), parentId])
    : [];
  const { account_id, project_id, ...content } = v.content;
  if (v.version === 0) {
    await ctx.tx.query(
      'INSERT INTO outgoing_mail(workspace_id,customer_id,person_id,id,created_by,account_id,project_id,content,reply_to_message_id,in_reply_to,reference_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb) ON CONFLICT(workspace_id,id) DO NOTHING',
      [
        ctx.workspaceId,
        p.customer_id,
        personId,
        v.id,
        ctx.actorId,
        account_id,
        project_id,
        JSON.stringify(content),
        v.reply_to_message_id,
        parentId,
        JSON.stringify(references),
      ],
    );
    const saved = await row(ctx, v.id);
    if (
      saved.person_id !== personId ||
      saved.customer_id !== p.customer_id ||
      saved.reply_to_message_id !== v.reply_to_message_id
    )
      throw new ApiError(409, '草稿不属于当前联系人');
    // A lost first-save response may retry version zero. Only replay the exact
    // payload; otherwise returning the old row would falsely mark new edits as
    // saved in the composer and silently discard what the user just wrote.
    if (
      saved.account_id !== account_id ||
      saved.project_id !== project_id ||
      !isDeepStrictEqual(saved.content, content)
    )
      throw new ApiError(
        409,
        '这份草稿已存在且内容不同，请重新打开已保存草稿后继续编辑；本次修改尚未保存',
      );
    return expose(saved);
  }
  const current = await row(ctx, v.id, true);
  if (
    current.person_id !== personId ||
    current.customer_id !== p.customer_id ||
    current.reply_to_message_id !== v.reply_to_message_id
  )
    throw new ApiError(404, '草稿不属于当前联系人');
  checkVersion(current, v.version);
  if (lockedOutgoing(current.status))
    throw new ApiError(409, '邮件已开始发送，请先核对结果，不能修改或重复发送');
  await ctx.tx.query(
    'UPDATE outgoing_mail SET account_id=$3,project_id=$4,content=$5::jsonb WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId, v.id, account_id, project_id, JSON.stringify(content)],
  );
  return getOutgoing(ctx, v.id);
}
export async function variablePreview(ctx: Context, id: string, input: unknown) {
  const v = versionSchema.parse(input),
    r = await row(ctx, id);
  checkVersion(r, v.version);
  await activeScope(ctx, r.person_id, r.project_id, r.customer_id);
  return previewMailVariables(ctx, r);
}
export async function approveOutgoing(ctx: Context, id: string, input: unknown) {
  const v = z
      .strictObject({
        version: z.number().int().positive(),
        variable_preview_digest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .parse(input),
    r = await row(ctx, id, true);
  checkVersion(r, v.version);
  if (!['draft', 'approved', 'failed', 'cancelled', 'needs_review'].includes(r.status))
    throw new ApiError(409, '请先取消排期或核对发送结果');
  const a = await ready(ctx, r, false);
  if (hasMailVariables(r.content.variable_document)) {
    const preview = await previewMailVariables(ctx, r);
    if (!preview.can_confirm) throw new ApiError(409, '邮件变量尚未解决，请先预览并处理所有问题');
    if (v.variable_preview_digest !== preview.digest)
      throw new ApiError(409, '邮件填值或资料已变化，请重新预览并确认具体内容');
    r.variable_snapshot = {
      version: 1,
      preview_digest: preview.digest,
      messages: preview.messages,
      recipient_bindings: preview.recipient_bindings,
    };
  }
  r.from_email = a.email;
  await ctx.tx.query(
    "UPDATE outgoing_mail SET status='approved',from_email=$3,approved_version=version,approved_at=now(),approved_digest=$4,scheduled_at=NULL,timezone=NULL,message_id=NULL,error=NULL,variable_snapshot=$5::jsonb WHERE workspace_id=$1 AND id=$2",
    [
      ctx.workspaceId,
      id,
      a.email,
      digest(r),
      r.variable_snapshot ? JSON.stringify(r.variable_snapshot) : null,
    ],
  );
  return getOutgoing(ctx, id);
}
export async function scheduleOutgoing(
  ctx: Context,
  id: string,
  input: unknown,
  options: OutgoingOptions,
) {
  const v = z
    .object({
      version: z.number().int().positive(),
      mode: z.enum(['now', 'later']),
      at: z.iso.datetime({ offset: true }).optional(),
      timezone: z.literal('Asia/Shanghai'),
    })
    .strict()
    .parse(input);
  if (!options.key) throw new ApiError(503, '服务端尚未配置邮箱加密密钥');
  const r = await row(ctx, id, true);
  checkVersion(r, v.version);
  // A retry after an ambiguous HTTP response must never create a second send.
  if (
    ['scheduled', 'sending', 'submitted', 'sent_confirmed', 'uncertain', 'partial'].includes(
      r.status,
    )
  )
    return getOutgoing(ctx, id);
  if (
    r.status !== 'approved' ||
    r.approved_version !== r.version ||
    r.approved_digest !== digest(r)
  )
    throw new ApiError(409, '请先确认当前版本的邮件内容');
  const a = await ready(ctx, r);
  if (a.email !== r.from_email) throw new ApiError(409, '发件身份已变化，请重新确认');
  const now = outgoingNow(options);
  const at = v.mode === 'now' ? new Date(now) : v.at ? new Date(v.at) : null;
  if (!at || (v.mode === 'later' && (at.getTime() <= now || at.getTime() > now + 366 * 86400000)))
    throw new ApiError(400, '请选择未来一年内的发送时间');
  await ctx.tx.query(
    "UPDATE outgoing_mail SET status='scheduled',scheduled_at=$3,timezone=$4,message_id=$5,error=NULL WHERE workspace_id=$1 AND id=$2",
    [
      ctx.workspaceId,
      id,
      at.toISOString(),
      v.timezone,
      `<${randomUUID()}@${a.email.split('@')[1]}>`,
    ],
  );
  if (r.content.mass_sending) {
    const queued = await row(ctx, id);
    for (const recipient of r.content.to)
      await ctx.tx.query(
        'INSERT INTO outgoing_deliveries(workspace_id,customer_id,outgoing_id,id,version,batch_id,recipient,message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          ctx.workspaceId,
          r.customer_id,
          id,
          randomUUID(),
          r.version,
          queued.message_id,
          recipient,
          `<${randomUUID()}@${a.email.split('@')[1]}>`,
        ],
      );
  }
  return getOutgoing(ctx, id);
}
export async function cancelOutgoing(ctx: Context, id: string, input: unknown) {
  const v = versionSchema.parse(input),
    r = await row(ctx, id, true);
  checkVersion(r, v.version);
  if (lockedOutgoing(r.status)) throw new ApiError(409, '邮件已开始发送，无法撤回，请核对结果');
  await ctx.tx.query(
    "UPDATE outgoing_mail SET status='cancelled',approved_version=NULL,approved_at=NULL,approved_digest=NULL,scheduled_at=NULL,timezone=NULL,message_id=NULL,error=NULL WHERE workspace_id=$1 AND id=$2",
    [ctx.workspaceId, id],
  );
  return getOutgoing(ctx, id);
}
async function workerContext<T>(db: Database, r: Row, fn: (tx: Sql) => Promise<T>) {
  // Persist the external outcome even if access was revoked during SMTP submission.
  return db.transaction(async (tx) => {
    await tx.query(
      "SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
      [r.workspace_id, r.created_by],
    );
    return fn(tx);
  });
}
async function recordSubmission(tx: Sql, r: Row) {
  r = frozenMessage(r, r.content.mass_sending ? r.content.to[0] : undefined);
  const id = randomUUID(),
    recipients = (addresses: string[]) => addresses.map((address) => ({ address, name: '' }));
  // Bcc stays in the author's draft and is not exposed in the shared timeline.
  const inserted = (
    await tx.query<{ id: string }>(
      `INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,project_id,fingerprint,message_id,subject,sender,recipients,cc,participants,occurred_at,direction,body,attachments,match_reason,notification_enabled,reference_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,now(),'outbound',$14,$15::jsonb,'用户确认后从 CRM 发送',false,$16::jsonb) ON CONFLICT(workspace_id,account_id,fingerprint) DO NOTHING RETURNING id`,
      [
        r.workspace_id,
        id,
        r.account_id,
        r.from_email,
        r.customer_id,
        r.project_id,
        `outgoing:${r.id}:${r.version}${r.content.mass_sending ? `:${r.message_id}` : ''}`,
        r.message_id,
        r.content.subject,
        JSON.stringify(recipients([r.from_email!])),
        JSON.stringify(recipients(r.content.to)),
        JSON.stringify(recipients(r.content.cc)),
        JSON.stringify([r.from_email, ...r.content.to, ...r.content.cc]),
        r.content.body,
        JSON.stringify(
          r.content.attachments.map((a) => ({
            name: a.name,
            size: Buffer.from(a.content, 'base64').length,
            type: 'application/octet-stream',
          })),
        ),
        JSON.stringify(r.reference_ids || []),
      ],
    )
  ).rows[0];
  if (inserted && hasMailVariables(r.content.variable_document)) {
    for (const binding of r.variable_snapshot!.recipient_bindings.filter((b) =>
      r.content.to.includes(b.email),
    ))
      await tx.query(
        'INSERT INTO mail_people(workspace_id,customer_id,message_id,person_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [r.workspace_id, r.customer_id, inserted.id, binding.person_id],
      );
    return;
  }
  if (inserted && r.person_id && !r.content.mass_sending)
    await tx.query(
      'INSERT INTO mail_people(workspace_id,customer_id,message_id,person_id) VALUES($1,$2,$3,$4)',
      [r.workspace_id, r.customer_id, inserted.id, r.person_id],
    );
  if (inserted && (r.reply_to_message_id || r.content.mass_sending))
    await tx.query(
      `INSERT INTO mail_people(workspace_id,customer_id,message_id,person_id) SELECT workspace_id,customer_id,$3,id FROM people WHERE workspace_id=$1 AND customer_id=$2 AND archived_at IS NULL AND lower(trim(email))=ANY($4::text[]) ON CONFLICT DO NOTHING`,
      [r.workspace_id, r.customer_id, inserted.id, [...r.content.to, ...r.content.cc]],
    );
}
async function finish(db: Database, r: Row, status: OutgoingStatus, error: string | null) {
  await workerContext(db, r, async (tx) => {
    const updated = (
      await tx.query(
        "UPDATE outgoing_mail SET status=$3,error=$4,submitted_at=CASE WHEN $3 IN ('submitted','sent_confirmed') THEN coalesce(submitted_at,now()) ELSE submitted_at END WHERE workspace_id=$1 AND id=$2 AND status IN ('sending','uncertain','submitted') RETURNING id",
        [r.workspace_id, r.id, status, error],
      )
    ).rows[0];
    if (updated && ['submitted', 'sent_confirmed'].includes(status)) await recordSubmission(tx, r);
  });
}
function deliveryMail(r: Row, d: OutgoingDelivery): Row {
  return frozenMessage(
    {
      ...r,
      message_id: d.message_id,
      content: { ...r.content, to: [d.recipient], cc: [], bcc: [] },
    },
    d.recipient,
  );
}
function frozenMessage(r: Row, recipient?: string): Row {
  if (!hasMailVariables(r.content.variable_document)) return r;
  const snapshot = r.variable_snapshot;
  const message = recipient
    ? snapshot?.messages.find((m) => m.recipient === recipient)
    : snapshot?.messages.length === 1
      ? snapshot.messages[0]
      : undefined;
  if (!message || message.issues.length)
    throw new ApiError(409, '邮件填值快照不可用，请重新预览并确认');
  return { ...r, content: { ...r.content, subject: message.subject, body: message.body } };
}
async function finishDelivery(
  db: Database,
  r: Row,
  d: OutgoingDelivery,
  status: OutgoingDelivery['status'],
  error: string | null,
) {
  await workerContext(db, r, async (tx) => {
    const updated = (
      await tx.query(
        "UPDATE outgoing_deliveries SET status=$3,error=$4 WHERE workspace_id=$1 AND id=$2 AND status IN ('sending','submitted','uncertain') RETURNING id",
        [r.workspace_id, d.id, status, error],
      )
    ).rows.length;
    if (updated && ['submitted', 'sent_confirmed'].includes(status))
      await recordSubmission(tx, deliveryMail(r, d));
  });
}
async function summarizeMass(db: Database, r: Row) {
  await workerContext(db, r, async (tx) => {
    const items = await deliveries(tx, r);
    if (!items.length) return;
    const all = (states: string[]) => items.every((d) => states.includes(d.status));
    const status: OutgoingStatus = items.some((d) => d.status === 'uncertain')
      ? 'uncertain'
      : all(['sent_confirmed'])
        ? 'sent_confirmed'
        : all(['submitted', 'sent_confirmed'])
          ? 'submitted'
          : items.some((d) => ['submitted', 'sent_confirmed'].includes(d.status))
            ? 'partial'
            : 'failed';
    const accepted = items.filter((d) => ['submitted', 'sent_confirmed'].includes(d.status)).length;
    const error = ['submitted', 'sent_confirmed'].includes(status)
      ? null
      : `${accepted} / ${items.length} 封已被邮箱接受。其余结果请逐项核对，系统不会自动重发。`;
    await tx.query(
      "UPDATE outgoing_mail SET status=$3,error=$4,submitted_at=CASE WHEN $5>0 THEN coalesce(submitted_at,now()) ELSE submitted_at END WHERE workspace_id=$1 AND id=$2 AND message_id=$6 AND status IN ('sending','submitted','uncertain','partial')",
      [r.workspace_id, r.id, status, error, accepted, r.message_id],
    );
  });
}
async function stopPending(db: Database, r: Row, reason: string) {
  await workerContext(db, r, (tx) =>
    tx.query(
      "UPDATE outgoing_deliveries SET status='stopped',error=$4 WHERE workspace_id=$1 AND outgoing_id=$2 AND batch_id=$3 AND status='pending'",
      [r.workspace_id, r.id, r.message_id, reason],
    ),
  );
}
async function sendMass(db: Database, r: Row, options: OutgoingOptions) {
  const items = await workerContext(db, r, (tx) => deliveries(tx, r));
  for (const d of items) {
    if (d.status !== 'pending') continue;
    let account: Sender;
    try {
      const claimed = await scoped(db, r.created_by, r.workspace_id, async (ctx) => {
        const current = await row(ctx, r.id, true);
        if (
          current.status !== 'sending' ||
          current.version !== r.version ||
          current.message_id !== r.message_id
        )
          return null;
        const a = await ready(ctx, current);
        if (current.approved_digest !== digest(current) || a.email !== current.from_email)
          throw new ApiError(409, '发件身份或内容已变化');
        await ctx.tx.query(
          'UPDATE outgoing_mail SET started_at=now() WHERE workspace_id=$1 AND id=$2',
          [r.workspace_id, r.id],
        );
        const updated = (
          await ctx.tx.query(
            "UPDATE outgoing_deliveries SET status='sending' WHERE workspace_id=$1 AND id=$2 AND status='pending' RETURNING id",
            [r.workspace_id, d.id],
          )
        ).rows.length;
        return updated ? a : null;
      });
      if (!claimed) break;
      account = claimed;
    } catch {
      await stopPending(db, r, '客户、项目或发件权限已变化，本封尚未发送');
      break;
    }
    try {
      let password: string;
      try {
        password = unseal(account.secret, options.key!, `${r.workspace_id}:${account.id}`);
      } catch {
        throw new SubmissionError('邮箱授权信息不可用，请在邮箱设置中更新', true);
      }
      await (options.transport ?? smtpTransport).send({
        mail: expose(deliveryMail(r, d)),
        email: account.email,
        password,
      });
      await finishDelivery(db, r, d, 'submitted', null);
    } catch (e) {
      const definite = e instanceof SubmissionError && e.definitelyNotSent;
      await finishDelivery(
        db,
        r,
        d,
        definite ? 'failed' : 'uncertain',
        e instanceof SubmissionError ? e.message : '发送结果不确定，请先核对发件记录',
      );
      await stopPending(db, r, '前一封发送未完成，本封尚未发送');
      break;
    }
  }
  await summarizeMass(db, r);
}
export async function runOutgoing(db: Database, options: OutgoingOptions) {
  // Reject a broken injected clock before changing any delivery state.
  if (options.clock) outgoingNow(options);
  const abandoned = (
    await db.query<Row>(
      "SELECT * FROM outgoing_mail WHERE status='sending' AND started_at<now()-interval '10 minutes'",
    )
  ).rows;
  for (const r of abandoned) {
    if (r.content.mass_sending) {
      await workerContext(db, r, (tx) =>
        tx.query(
          "UPDATE outgoing_deliveries SET status='uncertain',error='发送过程曾中断，请核对发件记录' WHERE workspace_id=$1 AND outgoing_id=$2 AND batch_id=$3 AND status='sending'",
          [r.workspace_id, r.id, r.message_id],
        ),
      );
      await stopPending(db, r, '发送过程曾中断，本封尚未发送');
      await summarizeMass(db, r);
    } else await finish(db, r, 'uncertain', '发送过程曾中断，请核对发件记录；系统不会自动重发。');
  }
  const due = (
    await db.query<Row>(
      "SELECT * FROM outgoing_mail WHERE status='scheduled' AND scheduled_at<=now() ORDER BY scheduled_at LIMIT 10",
    )
  ).rows;
  for (const candidate of due) {
    let claimed: { r: Row; account: Sender } | null = null;
    try {
      claimed = await scoped(db, candidate.created_by, candidate.workspace_id, async (ctx) => {
        const r = await row(ctx, candidate.id, true);
        if (r.status !== 'scheduled') return null;
        if (!options.key) throw new ApiError(503, '邮箱密钥不可用，请重新确认发送');
        const account = await ready(ctx, r);
        if (
          r.approved_version !== r.version ||
          r.approved_digest !== digest(r) ||
          r.from_email !== account.email
        )
          throw new ApiError(409, '邮件内容或发件身份已变化，请重新确认');
        if (outgoingNow(options) - new Date(r.scheduled_at!).getTime() > 15 * 60000)
          throw new ApiError(409, '发送时间已超过 15 分钟，请重新确认并选择时间');
        await ctx.tx.query(
          "UPDATE outgoing_mail SET status='sending',started_at=now() WHERE workspace_id=$1 AND id=$2",
          [ctx.workspaceId, r.id],
        );
        return { r, account };
      });
    } catch (e) {
      await workerContext(db, candidate, (tx) =>
        tx.query(
          "UPDATE outgoing_mail SET status='needs_review',error=$3 WHERE workspace_id=$1 AND id=$2 AND status='scheduled'",
          [
            candidate.workspace_id,
            candidate.id,
            e instanceof ApiError ? e.message : '发送前校验失败，请重新确认',
          ],
        ),
      );
      continue;
    }
    if (!claimed) continue;
    const { r, account } = claimed;
    if (r.content.mass_sending) {
      await sendMass(db, r, options);
      continue;
    }
    let password: string;
    try {
      password = unseal(account.secret, options.key!, `${r.workspace_id}:${account.id}`);
    } catch {
      await finish(db, r, 'failed', '邮箱授权信息不可用，请在邮箱设置中更新');
      continue;
    }
    try {
      await (options.transport ?? smtpTransport).send({
        mail: expose(frozenMessage(r)),
        email: account.email,
        password,
      });
      await finish(db, r, 'submitted', null);
    } catch (e) {
      await finish(
        db,
        r,
        e instanceof SubmissionError && e.definitelyNotSent ? 'failed' : 'uncertain',
        e instanceof SubmissionError
          ? e.message
          : '发送结果不确定，请核对发件记录；系统不会自动重发。',
      );
    }
  }
}
export async function reconcileOutgoing(
  db: Database,
  actorId: string,
  workspaceId: string,
  id: string,
  options: OutgoingOptions,
) {
  const { r, account } = await scoped(db, actorId, workspaceId, async (ctx) => {
    const r = await row(ctx, id);
    if (!['uncertain', 'submitted', 'sent_confirmed', 'partial'].includes(r.status))
      throw new ApiError(409, '当前状态无需核对发件记录');
    const account = await sender(ctx, r.account_id);
    return { r, account };
  });
  if (r.content.mass_sending) {
    if (!options.key) throw new ApiError(503, '邮箱密钥不可用');
    const password = unseal(account.secret, options.key, `${workspaceId}:${account.id}`);
    try {
      for (const d of await workerContext(db, r, (tx) => deliveries(tx, r))) {
        if (!['uncertain', 'submitted'].includes(d.status)) continue;
        const found = await (options.transport ?? smtpTransport).checkSent({
          mail: expose(deliveryMail(r, d)),
          email: account.email,
          password,
        });
        if (found) await finishDelivery(db, r, d, 'sent_confirmed', null);
      }
    } catch {
      throw new ApiError(502, '暂时无法核对全部发件记录，请稍后再试；不会重新发送');
    } finally {
      await summarizeMass(db, r);
    }
    return scoped(db, actorId, workspaceId, (ctx) => getOutgoing(ctx, id));
  }
  if (r.status !== 'sent_confirmed') {
    if (!options.key) throw new ApiError(503, '邮箱密钥不可用');
    let found: boolean;
    try {
      found = await (options.transport ?? smtpTransport).checkSent({
        mail: expose(frozenMessage(r)),
        email: account.email,
        password: unseal(account.secret, options.key, `${workspaceId}:${account.id}`),
      });
    } catch {
      throw new ApiError(502, '暂时无法核对发件箱，请稍后再试；不会重新发送');
    }
    if (found) await finish(db, r, 'sent_confirmed', null);
    else
      await workerContext(db, r, (tx) =>
        tx.query(
          "UPDATE outgoing_mail SET error='发件箱暂未找到对应记录；这不代表发送失败，请在原邮箱继续核对。' WHERE workspace_id=$1 AND id=$2 AND status IN ('submitted','uncertain')",
          [workspaceId, id],
        ),
      );
  }
  return scoped(db, actorId, workspaceId, (ctx) => getOutgoing(ctx, id));
}
export function startOutgoingWorker(db: Database, options: OutgoingOptions) {
  let running: Promise<void> | null = null;
  const tick = () => {
    if (!running)
      running = runOutgoing(db, options)
        .catch(() => {
          console.error('发信队列暂时不可用，将在下次轮询检查状态。');
        })
        .finally(() => {
          running = null;
        });
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
