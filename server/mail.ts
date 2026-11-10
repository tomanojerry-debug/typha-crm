import { isExcluded } from './mail-settings.js';
import { recognizeMailCustomers } from './mail-customer-recognition.js';
import { extractMailIntake } from '../shared/mail-intake.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, requireAdmin, scoped, type Context } from './security.js';
import type { Database } from './db.js';
import * as service from './service.js';
import { person, syncPrimary } from './people.js';
import * as validation from './validation.js';
import type { Customer } from '../shared/domain.js';
import { seal, unseal } from './mail-secrets.js';
import {
  imapTransport,
  type MailTransport,
  type Cursors,
  type ParsedMail,
} from './mail-transport.js';
import type { MailAccount, MailMessage } from '../shared/connections.js';
const email = z.email().trim().toLowerCase().max(254);
const accountInput = z
  .object({
    email: email.refine(
      (x) => /^[^@]+@(163\.com|126\.com|yeah\.net)$/.test(x),
      '暂未支持此邮箱服务，请使用当前已开放连接的邮箱账号',
    ),
    authorization_code: z.string().trim().min(6).max(200),
    aliases: z.array(email).max(20).default([]),
  })
  .strict();
interface AccountRow extends MailAccount {
  workspace_id: string;
  secret: string;
  cursors: Cursors;
  sync_token: string | null;
  connected_by: string;
}
export interface MailOptions {
  key?: Buffer;
  transport?: MailTransport;
}
export async function accounts(ctx: Context) {
  requireAdmin(ctx);
  return (
    await ctx.tx.query<MailAccount>(
      `SELECT id,email,aliases,enabled,created_at,intake_mode,true AS notify_unknown,true AS notify_known,muted_senders,settings_version,settings_updated_at,last_sync_at,sync_started_at,sync_error,sent_folder,(SELECT count(*)::int FROM mail_messages m WHERE m.workspace_id=a.workspace_id AND m.account_id=a.id) AS synced_count FROM mail_accounts a WHERE workspace_id=$1 ORDER BY created_at,id`,
      [ctx.workspaceId],
    )
  ).rows;
}
export async function createAccount(ctx: Context, input: unknown, options: MailOptions) {
  requireAdmin(ctx);
  if (!options.key) throw new ApiError(503, '服务端尚未配置邮箱加密密钥');
  const value = accountInput.parse(input),
    id = randomUUID();
  await ctx.tx.query(
    'INSERT INTO mail_accounts(workspace_id,id,email,secret,aliases,connected_by) VALUES($1,$2,$3,$4,$5::jsonb,$6)',
    [
      ctx.workspaceId,
      id,
      value.email,
      seal(value.authorization_code, options.key, `${ctx.workspaceId}:${id}`),
      JSON.stringify(value.aliases),
      ctx.actorId,
    ],
  );
  return (await accounts(ctx)).find((x) => x.id === id);
}
export async function editAccount(ctx: Context, id: string, input: unknown, options: MailOptions) {
  requireAdmin(ctx);
  const v = z
    .object({
      enabled: z.boolean().optional(),
      authorization_code: z.string().trim().min(6).max(200).optional(),
    })
    .strict()
    .refine((x) => Object.keys(x).length > 0)
    .parse(input);
  if (v.authorization_code && !options.key) throw new ApiError(503, '服务端尚未配置邮箱加密密钥');
  const found = (
    await ctx.tx.query(
      'UPDATE mail_accounts SET enabled=coalesce($3,enabled),secret=coalesce($4,secret),connected_by=$5 WHERE workspace_id=$1 AND id=$2 RETURNING id',
      [
        ctx.workspaceId,
        id,
        v.enabled ?? null,
        v.authorization_code
          ? seal(v.authorization_code, options.key!, `${ctx.workspaceId}:${id}`)
          : null,
        ctx.actorId,
      ],
    )
  ).rows[0];
  if (!found) throw new ApiError(404, '邮箱连接不存在');
  return (await accounts(ctx)).find((x) => x.id === id);
}
async function match(ctx: Context, addresses: string[], internal: string[]) {
  const external = addresses.filter((x) => !internal.includes(x.toLowerCase()));
  const customers = new Set<string>(),
    people = new Set<string>();
  let unresolved = false;
  for (const address of external) {
    // Include archived and duplicate identities in ambiguity checks; never guess a company from a domain.
    const rows = (
      await ctx.tx.query<{ customer_id: string; person_id: string | null; archived: boolean }>(
        `SELECT p.customer_id,p.id AS person_id,(p.archived_at IS NOT NULL OR c.archived_at IS NOT NULL) AS archived FROM people p JOIN customers c ON c.workspace_id=p.workspace_id AND c.id=p.customer_id WHERE p.workspace_id=$1 AND lower(trim(p.email))=$2 UNION ALL SELECT id AS customer_id,NULL AS person_id,(archived_at IS NOT NULL) AS archived FROM customers WHERE workspace_id=$1 AND lower(trim(email))=$2`,
        [ctx.workspaceId, address.toLowerCase()],
      )
    ).rows;
    const ids = new Set(rows.map((x) => x.customer_id));
    for (const id of ids) customers.add(id);
    if (ids.size !== 1 || rows.some((x) => x.archived)) unresolved = true;
    for (const row of rows) if (row.person_id && !row.archived) people.add(row.person_id);
  }
  const reason = !external.length
    ? '没有可匹配的外部联系人'
    : customers.size > 1
      ? '涉及多个客户，请在邮箱核对后单独整理资料'
      : unresolved || customers.size !== 1
        ? '存在未匹配或已归档的联系人'
        : '已按明确邮箱地址关联';
  return {
    customerId: !unresolved && customers.size === 1 ? [...customers][0] : null,
    knownCustomers: [...customers],
    people: [...people],
    reason,
  };
}
async function internalAddresses(ctx: Context) {
  const rows = (
    await ctx.tx.query<{ email: string; aliases: string[] }>(
      'SELECT email,aliases FROM mail_accounts WHERE workspace_id=$1',
      [ctx.workspaceId],
    )
  ).rows;
  return [...new Set(rows.flatMap((r) => [r.email, ...r.aliases]).map((x) => x.toLowerCase()))];
}
async function storeMail(ctx: Context, account: AccountRow, message: ParsedMail) {
  if (await isExcluded(ctx, message.participants)) return;
  if (
    message.message_id &&
    (
      await ctx.tx.query<{ known: boolean }>('SELECT crm_is_outgoing_message($1,$2,$3) AS known', [
        ctx.workspaceId,
        account.id,
        message.message_id,
      ])
    ).rows[0].known
  )
    return;
  const direction = message.sender.some((x) =>
    [account.email, ...account.aliases].includes(x.address),
  )
    ? 'outbound'
    : 'inbound';
  const internal = await internalAddresses(ctx);
  const matched = await match(ctx, message.participants, internal);
  const id = randomUUID();
  const row = (
    await ctx.tx.query<{ id: string }>(
      `INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,body_notice,attachments,match_reason,received_after_connection,intake_mode,intake_suggestions,notification_enabled,message_id,reply_to,reference_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20::jsonb,$21,$22,$23::jsonb,$24::jsonb) ON CONFLICT(workspace_id,account_id,fingerprint) DO UPDATE SET message_id=coalesce(mail_messages.message_id,EXCLUDED.message_id),reply_to=CASE WHEN mail_messages.reply_to='[]'::jsonb THEN EXCLUDED.reply_to ELSE mail_messages.reply_to END,reference_ids=CASE WHEN mail_messages.reference_ids='[]'::jsonb THEN EXCLUDED.reference_ids ELSE mail_messages.reference_ids END WHERE (mail_messages.message_id IS NULL AND EXCLUDED.message_id IS NOT NULL) OR (mail_messages.reply_to='[]'::jsonb AND EXCLUDED.reply_to<>'[]'::jsonb) OR (mail_messages.reference_ids='[]'::jsonb AND EXCLUDED.reference_ids<>'[]'::jsonb) RETURNING id`,
      [
        ctx.workspaceId,
        id,
        account.id,
        account.email,
        matched.customerId,
        message.fingerprint,
        message.subject,
        JSON.stringify(message.sender),
        JSON.stringify(message.recipients),
        JSON.stringify(message.cc),
        JSON.stringify(message.participants),
        message.occurred_at,
        direction,
        message.body,
        message.body_notice,
        JSON.stringify(message.attachments),
        matched.reason,
        new Date(message.occurred_at).getTime() >= new Date(account.created_at).getTime(),
        account.intake_mode,
        account.intake_mode === 'review' && !matched.customerId
          ? JSON.stringify(
              extractMailIntake({ ...message, direction, account_email: account.email }),
            )
          : null,
        !message.sender.some((x) => account.muted_senders.includes(x.address.toLowerCase())),
        message.message_id || null,
        JSON.stringify(message.reply_to || []),
        JSON.stringify(message.reference_ids || []),
      ],
    )
  ).rows[0];
  if (row?.id === id && matched.customerId)
    for (const p of matched.people)
      await ctx.tx.query(
        'INSERT INTO mail_people(workspace_id,customer_id,message_id,person_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [ctx.workspaceId, matched.customerId, row.id, p],
      );
}
export async function syncAccount(
  db: Database,
  actorId: string,
  workspaceId: string,
  id: string,
  options: MailOptions,
) {
  if (!options.key) throw new ApiError(503, '服务端尚未配置邮箱加密密钥');
  const token = randomUUID();
  const account = await scoped(db, actorId, workspaceId, async (ctx) => {
    requireAdmin(ctx);
    const row = (
      await ctx.tx.query<AccountRow>(
        `UPDATE mail_accounts SET sync_token=$3,sync_started_at=now(),sync_error=NULL WHERE workspace_id=$1 AND id=$2 AND enabled AND (sync_token IS NULL OR sync_started_at<now()-interval '10 minutes') RETURNING *`,
        [workspaceId, id, token],
      )
    ).rows[0];
    if (!row) throw new ApiError(409, '邮箱已暂停、正在同步或不可访问');
    return row;
  });
  try {
    await (options.transport ?? imapTransport).run(
      {
        email: account.email,
        password: unseal(account.secret, options.key, `${workspaceId}:${id}`),
        cursors: account.cursors,
      },
      async (folder, cursor, message) => {
        await scoped(db, actorId, workspaceId, async (ctx) => {
          requireAdmin(ctx);
          const current = (
            await ctx.tx.query<AccountRow>(
              'SELECT * FROM mail_accounts WHERE workspace_id=$1 AND id=$2 AND sync_token=$3 AND enabled FOR UPDATE',
              [workspaceId, id, token],
            )
          ).rows[0];
          if (!current) throw new ApiError(409, '同步已停止');
          if (message) await storeMail(ctx, current, message);
          // Mail and cursor commit together; a retry cannot silently skip a failed message.
          await ctx.tx.query(
            'UPDATE mail_accounts SET cursors=$4::jsonb WHERE workspace_id=$1 AND id=$2 AND sync_token=$3',
            [workspaceId, id, token, JSON.stringify({ ...current.cursors, [folder]: cursor })],
          );
        });
      },
      async (sent) => {
        await scoped(db, actorId, workspaceId, async (ctx) => {
          requireAdmin(ctx);
          await ctx.tx.query(
            'UPDATE mail_accounts SET sent_folder=$4 WHERE workspace_id=$1 AND id=$2 AND sync_token=$3',
            [workspaceId, id, token, sent],
          );
        });
      },
      async (participants) =>
        scoped(db, actorId, workspaceId, async (ctx) => {
          requireAdmin(ctx);
          return !(await isExcluded(ctx, participants));
        }),
    );
    await scoped(db, actorId, workspaceId, async (ctx) => {
      requireAdmin(ctx);
      await ctx.tx.query(
        'UPDATE mail_accounts SET sync_token=NULL,sync_started_at=NULL,last_sync_at=now(),sync_error=NULL WHERE workspace_id=$1 AND id=$2 AND sync_token=$3',
        [workspaceId, id, token],
      );
    });
    return { ok: true };
  } catch {
    await scoped(db, actorId, workspaceId, async (ctx) => {
      requireAdmin(ctx);
      await ctx.tx.query(
        'UPDATE mail_accounts SET sync_token=NULL,sync_started_at=NULL,sync_error=$4 WHERE workspace_id=$1 AND id=$2 AND sync_token=$3',
        [
          workspaceId,
          id,
          token,
          '同步未完成，请核对 IMAP 开通状态、授权码和网络后重试；已保存邮件保留',
        ],
      );
    }).catch(() => {});
    throw new ApiError(
      502,
      '同步未完成，请核对 IMAP 开通状态、授权码和网络；已保存进度保留，可安全重试',
    );
  }
}
const mailSelect = `m.intake_mode,m.id,m.account_id,m.account_email,m.customer_id,c.name AS customer_name,m.project_id,m.subject,m.sender,m.recipients,m.cc,m.occurred_at,m.direction,left(m.body,180) AS preview,m.body_notice,m.attachments,m.match_reason,coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.name) ORDER BY p.name) FROM mail_people mp JOIN people p ON p.workspace_id=mp.workspace_id AND p.id=mp.person_id WHERE mp.workspace_id=m.workspace_id AND mp.message_id=m.id),'[]'::jsonb) AS people`;
const mailFrom =
  'mail_messages m LEFT JOIN customers c ON c.workspace_id=m.workspace_id AND c.id=m.customer_id';
export async function mailList(ctx: Context, input: unknown) {
  const q = z
    .object({
      customer_id: z.uuid().optional(),
      person_id: z.uuid().optional(),
      project_id: z.uuid().optional(),
      pending: z.enum(['true', 'false', 'all']).default('false'),
      q: z.string().max(100).default(''),
      page: z.coerce.number().int().min(1).max(100000).default(1),
    })
    .strict()
    .parse(input);
  const params: unknown[] = [ctx.workspaceId];
  let where = 'm.workspace_id=$1';
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where += ` AND ${sql}=$${params.length}`;
  };
  if (q.pending === 'true') {
    requireAdmin(ctx);
    where += ' AND m.customer_id IS NULL';
  } else if (q.pending === 'false') where += ' AND m.customer_id IS NOT NULL';
  if (q.customer_id) {
    await service.customer(ctx, q.customer_id);
    add('m.customer_id', q.customer_id);
  }
  if (q.person_id) {
    await person(ctx, q.person_id, q.customer_id);
    params.push(q.person_id);
    where += ` AND EXISTS(SELECT 1 FROM mail_people mp WHERE mp.workspace_id=m.workspace_id AND mp.message_id=m.id AND mp.person_id=$${params.length})`;
  }
  if (q.project_id) {
    if (!q.customer_id) throw new ApiError(400, '项目查询必须指定客户');
    await service.project(ctx, q.customer_id, q.project_id);
    add('m.project_id', q.project_id);
  }
  params.push(q.q);
  where += ` AND ($${params.length}='' OR position(lower($${params.length}) in lower(m.subject||' '||m.sender::text||' '||m.recipients::text))>0)`;
  const stats = (
    await ctx.tx.query<{
      total: number;
      last_inbound: string | null;
      last_outbound: string | null;
    }>(
      `SELECT count(*)::int AS total,max(m.occurred_at) FILTER(WHERE m.direction='inbound') AS last_inbound,max(m.occurred_at) FILTER(WHERE m.direction='outbound') AS last_outbound FROM mail_messages m WHERE ${where}`,
      params,
    )
  ).rows[0];
  params.push(ctx.actorId);
  const rows = (
    await ctx.tx.query<MailMessage>(
      `SELECT ${mailSelect},m.body,(m.direction='inbound' AND m.received_after_connection AND NOT EXISTS(SELECT 1 FROM mail_notification_reads r WHERE r.workspace_id=m.workspace_id AND r.message_id=m.id AND r.actor_id=$${params.length})) AS unread FROM ${mailFrom} WHERE ${where} ORDER BY m.occurred_at DESC,m.id LIMIT 30 OFFSET $${params.length + 1}`,
      [...params, (q.page - 1) * 30],
    )
  ).rows;
  const recognition = await recognizeMailCustomers(ctx, rows);
  const items = rows.map(({ body: _body, ...row }, index) => ({
    ...row,
    customer_recognition: recognition[index],
  }));
  return { items, ...stats, page: q.page };
}
export async function mailTrackingSummary(ctx: Context) {
  return (
    await ctx.tx.query<{ unread: number; pending: number }>(
      `SELECT count(*) FILTER(WHERE m.direction='inbound' AND m.received_after_connection AND NOT EXISTS(SELECT 1 FROM mail_notification_reads r WHERE r.workspace_id=m.workspace_id AND r.message_id=m.id AND r.actor_id=$2))::int AS unread,count(*) FILTER(WHERE m.customer_id IS NULL)::int AS pending FROM mail_messages m WHERE m.workspace_id=$1`,
      [ctx.workspaceId, ctx.actorId],
    )
  ).rows[0];
}
export async function readMail(ctx: Context, id: string) {
  if (
    !(
      await ctx.tx.query('SELECT id FROM mail_messages WHERE workspace_id=$1 AND id=$2', [
        ctx.workspaceId,
        id,
      ])
    ).rows.length
  )
    throw new ApiError(404, '邮件不存在或无权访问');
  await ctx.tx.query(
    'INSERT INTO mail_notification_reads(workspace_id,actor_id,message_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [ctx.workspaceId, ctx.actorId, id],
  );
  return { ok: true };
}
export async function mailDetail(ctx: Context, id: string) {
  const row = (
    await ctx.tx.query<MailMessage>(
      `SELECT ${mailSelect},m.body,m.intake_suggestions,m.reply_to,m.message_id,m.reference_ids,(SELECT name FROM projects j WHERE j.workspace_id=m.workspace_id AND j.customer_id=m.customer_id AND j.id=m.project_id) AS project_name FROM ${mailFrom} WHERE m.workspace_id=$1 AND m.id=$2`,
      [ctx.workspaceId, id],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, '邮件不存在或无权访问');
  if (row.intake_mode === 'review' && !row.customer_id)
    row.intake_suggestions ??= extractMailIntake(row);
  [row.customer_recognition] = await recognizeMailCustomers(ctx, [row]);
  return row;
}
export async function assignMail(ctx: Context, id: string, input: unknown) {
  requireAdmin(ctx);
  const v = z
    .object({
      customer_id: z.uuid(),
      project_id: z.uuid().nullable().default(null),
      person_ids: z.array(z.uuid()).max(30).default([]),
      reviewed: z.literal(true),
    })
    .strict()
    .parse(input);
  const current = (
    await ctx.tx.query<{ customer_id: string | null; participants: string[] }>(
      'SELECT customer_id,participants FROM mail_messages WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [ctx.workspaceId, id],
    )
  ).rows[0];
  if (!current) throw new ApiError(404, '邮件不存在');
  if (current.customer_id) throw new ApiError(409, '邮件已关联，请刷新查看');
  service.activeCustomer(await service.customer(ctx, v.customer_id, true));
  if (v.project_id) {
    const p = await service.project(ctx, v.customer_id, v.project_id);
    if (p.archived_at) throw new ApiError(409, '项目已归档');
  }
  const matched = await match(ctx, current.participants, await internalAddresses(ctx));
  if (matched.knownCustomers.some((c) => c !== v.customer_id))
    throw new ApiError(409, '邮件包含其他客户的已知地址，不能将整封邮件放入此客户档案');
  for (const p of v.person_ids) {
    const row = await person(ctx, p, v.customer_id);
    if (row.archived_at) throw new ApiError(409, '联系人已归档');
  }
  await ctx.tx.query(
    'UPDATE mail_messages SET customer_id=$3,project_id=$4,match_reason=$5 WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId, id, v.customer_id, v.project_id, '管理员已核对并关联'],
  );
  for (const p of new Set([...matched.people, ...v.person_ids]))
    await ctx.tx.query(
      'INSERT INTO mail_people(workspace_id,customer_id,message_id,person_id) VALUES($1,$2,$3,$4)',
      [ctx.workspaceId, v.customer_id, id, p],
    );
  return mailDetail(ctx, id);
}
// Creation and association share the request transaction: retries cannot leave orphan records.
export async function createMailCustomer(ctx: Context, id: string, input: unknown) {
  requireAdmin(ctx);
  const v = z
    .strictObject({
      customer: validation.customerCreate.omit({ source: true, owner_id: true, status: true }),
      job_title: z.string().trim().max(200).default(''),
      project: validation.projectCreate
        .omit({ owner_id: true, stage: true })
        .nullable()
        .default(null),
      reviewed: z.literal(true),
    })
    .parse(input);
  const current = (
    await ctx.tx.query<{ customer_id: string | null; participants: string[] }>(
      'SELECT customer_id,participants FROM mail_messages WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [ctx.workspaceId, id],
    )
  ).rows[0];
  if (!current) throw new ApiError(404, '邮件不存在');
  if (current.customer_id) throw new ApiError(409, '邮件已关联，请刷新查看');
  const internal = await internalAddresses(ctx);
  if (!v.customer.contact_name || !v.customer.email)
    throw new ApiError(400, '请填写联系人姓名和邮箱');
  const contactEmail = v.customer.email.trim().toLowerCase();
  if (internal.includes(contactEmail) || !current.participants.includes(contactEmail))
    throw new ApiError(400, '联系人邮箱必须是这封邮件的外部联系人地址');
  const matched = await match(ctx, current.participants, internal);
  if (matched.knownCustomers.length)
    throw new ApiError(409, '邮件中已有联系人属于现有公司，请使用“关联已有公司”，避免重复建档');
  const duplicate = (
    await ctx.tx.query(
      'SELECT id FROM customers WHERE workspace_id=$1 AND lower(trim(name))=lower($2)',
      [ctx.workspaceId, v.customer.name],
    )
  ).rows[0];
  if (duplicate) throw new ApiError(409, '已有同名公司，请先查找并关联已有公司');
  const customer = (await service.insert(ctx, 'customers', {
    ...v.customer,
    email: contactEmail,
    source: 'email',
    status: 'potential',
    owner_id: null,
  })) as unknown as Customer;
  await syncPrimary(ctx, customer);
  if (v.job_title)
    await ctx.tx.query(
      'UPDATE people SET job_title=$3 WHERE workspace_id=$1 AND customer_id=$2 AND is_primary',
      [ctx.workspaceId, customer.id, v.job_title],
    );
  const project = v.project
    ? await service.insert(ctx, 'projects', {
        ...v.project,
        customer_id: customer.id,
        stage: 'new',
        owner_id: null,
      })
    : null;
  return assignMail(ctx, id, {
    customer_id: customer.id,
    project_id: project?.id ?? null,
    reviewed: true,
  });
}
export function startMailWorker(db: Database, options: MailOptions) {
  let stopped = false,
    running: Promise<void> | undefined;
  const tick = () => {
    if (stopped || running || !options.key) return;
    running = (async () => {
      const rows = (
        await db.query<{ workspace_id: string; id: string; connected_by: string }>(
          `SELECT workspace_id,id,connected_by FROM mail_accounts WHERE enabled ORDER BY last_sync_at NULLS FIRST LIMIT 20`,
        )
      ).rows;
      for (const row of rows) {
        if (stopped) break;
        await syncAccount(db, row.connected_by, row.workspace_id, row.id, options).catch(() => {});
      }
    })()
      .catch(() => {})
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
