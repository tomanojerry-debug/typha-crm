import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, requireAdmin, type Context } from './security.js';
import * as service from './service.js';
import { person } from './people.js';
import { extractMailIntake, intakeFieldNames } from '../shared/mail-intake.js';
import {
  wechatRange,
  type WeChatPreview,
  type WeChatContact,
  type WeChatMessage,
  type WeChatEntity,
  type WeChatRelation,
  type WeChatConversation,
} from '../shared/wechat.js';
import type { WeChatTransport } from './wechat-transport.js';
import { connectorBinding } from './wechat-connector-store.js';
import type { ILinkProvider } from './wechat-ilink.js';
import { wechatBotBindingPausedMessage } from '../shared/wechat-connector.js';
export interface WeChatOptions {
  transport: WeChatTransport;
  actorId?: string;
  connectorRequired?: boolean;
  connectorBindingEnabled?: boolean;
  credentialKey?: Buffer;
  connectorProvider?: ILinkProvider;
}
export interface WeChatBatchAttribution {
  customer_id: string;
  person_id: string | null;
  project_id: string | null;
}
const identity = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((s) => !s.startsWith('-') && !/[\r\n\0]/.test(s), '请填写有效的微信身份');
const queryInput = z.strictObject({
  request_id: z.uuid(),
  identity,
  start: z.string(),
  end: z.string(),
  talker: z.string().max(200).optional(),
  conversation_id: z.uuid().optional(),
});
export function allowed(ctx: Context, options?: WeChatOptions): asserts options is WeChatOptions {
  requireAdmin(ctx);
  if (!options || options.actorId !== ctx.actorId)
    throw new ApiError(403, '本机微信读取仅供当前电脑的本地工作台账号使用。');
}
export async function status(ctx: Context, options?: WeChatOptions) {
  allowed(ctx, options);
  if (options.connectorRequired) {
    if (!options.connectorBindingEnabled)
      return { state: 'needs_setup' as const, message: wechatBotBindingPausedMessage };
    const binding = await connectorBinding(ctx);
    if (!binding)
      return { state: 'needs_setup' as const, message: '请先用手机微信扫码绑定 Typha 连接器。' };
    const local = await options.transport.status();
    const { account_key: _private, ...state } = local;
    if (local.state !== 'ready') return state;
    if (!binding.verified_account_key || binding.verified_account_key !== local.account_key)
      return {
        ...state,
        state: 'needs_setup' as const,
        message: '微信连接器已绑定，本机读取器已就绪；尚需核验手机与本机为同一微信账号。',
      };
    return state;
  }
  const { account_key: _private, ...state } = await options.transport.status();
  return state;
}
export async function openApp(ctx: Context, options?: WeChatOptions) {
  allowed(ctx, options);
  await options.transport.openApp();
  return { ok: true };
}
export function summarizeWeChat(contact: WeChatContact, messages: WeChatMessage[]) {
  const entities: WeChatEntity[] = [
    {
      id: 'person',
      kind: 'person',
      name: contact.remark || contact.name || contact.wechat_id || contact.id,
      attributes: [{ label: '微信标识', value: contact.wechat_id || contact.id }],
      evidence: [],
    },
  ];
  const relations: WeChatRelation[] = [];
  const seen = new Map<string, string>();
  const add = (
    key: string,
    kind: WeChatEntity['kind'],
    name: string,
    attributes: WeChatEntity['attributes'],
    m: WeChatMessage,
  ) => {
    let id = seen.get(key);
    if (!id) {
      id = `e${entities.length}`;
      seen.set(key, id);
      entities.push({ id, kind, name, attributes: [], evidence: [] });
    }
    const entity = entities.find((v) => v.id === id)!;
    for (const a of attributes)
      if (!entity.attributes.some((v) => v.label === a.label && v.value === a.value))
        entity.attributes.push(a);
    if (!entity.evidence.some((v) => v.message_id === m.id))
      entity.evidence.push({
        message_id: m.id,
        quote: m.text.slice(0, 600),
        speaker: m.speaker,
        at: m.at,
      });
    return id;
  };
  const edge = (from: string, to: string, label: string, message: string) => {
    const id = `r-${from}-${to}`;
    if (!relations.some((r) => r.id === id))
      relations.push({ id, from, to, label, evidence: [message] });
  };
  for (const m of messages) {
    const fields = extractMailIntake({
      body: m.text,
      sender: [],
      recipients: [],
      cc: [],
      direction: 'inbound',
      account_email: '',
    }).values;
    const company = fields.company
      ? add(
          `company:${fields.company}`,
          'company',
          fields.company,
          [
            { label: '公司名称', value: fields.company },
            ...(fields.region ? [{ label: '地区', value: fields.region }] : []),
          ],
          m,
        )
      : null;
    const project = fields.project_name
      ? add(
          `project:${fields.project_name}`,
          'project',
          fields.project_name,
          [
            { label: '项目名称', value: fields.project_name },
            ...(fields.description ? [{ label: '项目需求', value: fields.description }] : []),
          ],
          m,
        )
      : null;
    let personId: string | null = null;
    if (fields.contact) {
      if ([contact.name, contact.remark].includes(fields.contact))
        seen.set(`contact:${fields.contact}`, 'person');
      personId = add(
        `contact:${fields.contact}`,
        'person',
        fields.contact,
        [
          { label: '姓名', value: fields.contact },
          ...(fields.phone ? [{ label: '电话', value: fields.phone }] : []),
          ...(fields.job_title ? [{ label: '职位', value: fields.job_title }] : []),
        ],
        m,
      );
    }
    for (const field of ['phone', 'region', 'job_title', 'description'] as const) {
      const value = fields[field];
      if (
        !value ||
        ((field === 'phone' || field === 'job_title') && personId) ||
        (field === 'region' && company) ||
        (field === 'description' && project)
      )
        continue;
      add(
        `${field}:${value}`,
        'point',
        intakeFieldNames[field],
        [{ label: intakeFieldNames[field], value }],
        m,
      );
    }
    if (personId && company) edge(personId, company, '正文提及的联系人与公司（待核对）', m.id);
    if (company && project) edge(company, project, '正文提及的公司与项目（待核对）', m.id);
    if (
      /需要|需求|希望|请问|麻烦|待确认|确认|安排|回复|[?？]/.test(m.text) &&
      entities.filter((e) => e.kind === 'point').length < 20
    )
      add(
        `point:${m.id}`,
        'point',
        /[?？]|待确认|是否/.test(m.text)
          ? '待核对事项'
          : /确认|约定/.test(m.text)
            ? '确认相关表述'
            : '需求与跟进',
        [{ label: '原文', value: m.text.slice(0, 600) }],
        m,
      );
  }
  const limited = entities.slice(0, 60);
  return {
    entities: limited,
    relations: relations.filter(
      (r) => limited.some((e) => e.id === r.from) && limited.some((e) => e.id === r.to),
    ),
  };
}
function view(row: Record<string, unknown>): WeChatPreview {
  const messages = row.messages as WeChatMessage[];
  const entities = row.entities as WeChatEntity[];
  const full: WeChatEntity = {
    id: 'full-conversation',
    kind: 'point',
    name: '完整对话原文',
    attributes: [
      {
        label: '分享范围',
        value: `所选日期的全部 ${messages.length} 条文字；保留双方发言和上下文，关联后用于模型抽取。`,
      },
    ],
    evidence: messages.map((m) => ({
      message_id: m.id,
      quote: m.text,
      speaker: m.speaker,
      at: m.at,
    })),
  };
  return {
    ...row,
    entities:
      messages.length &&
      (row.state === 'pending' || (row.selected as string[]).includes('full-conversation'))
        ? [...entities.filter((e) => e.id !== 'full-conversation'), full]
        : entities,
    start: String(row.start),
    end: String(row.end),
    message_count: (row.messages as unknown[]).length,
    record_count: Number(row.record_count || (row.state === 'associated' ? 1 : 0)),
    method: 'local_extractive',
  } as unknown as WeChatPreview;
}
const archiveColumns = `archive_automatic,archive_new_records,(SELECT count(*)::int FROM wechat_query_records qr WHERE qr.workspace_id=wechat_queries.workspace_id AND qr.query_id=wechat_queries.id) AS record_count`;
const columns = `id,identity,to_char(start_date,'YYYY-MM-DD') AS start,to_char(end_date,'YYYY-MM-DD') AS end,messages,entities,relations,warnings,state,selected,customer_id,person_id,project_id,record_id,created_at,${archiveColumns}`;
const metadataColumns = `id,identity,to_char(start_date,'YYYY-MM-DD') AS start,to_char(end_date,'YYYY-MM-DD') AS end,jsonb_array_length(messages)::int AS message_count,'[]'::jsonb AS messages,'[]'::jsonb AS entities,'[]'::jsonb AS relations,'[]'::jsonb AS warnings,state,selected,customer_id,person_id,project_id,record_id,created_at,${archiveColumns}`;
export async function detail(ctx: Context, id: string) {
  const row = (
    await ctx.tx.query(
      `SELECT ${columns} FROM wechat_queries WHERE workspace_id=$1 AND actor_id=$2 AND id=$3`,
      [ctx.workspaceId, ctx.actorId, id],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, '微信整理预览不存在或无权访问');
  return view(row);
}
export async function list(ctx: Context, chatId?: string) {
  const rows = (
    await ctx.tx.query(
      `SELECT ${metadataColumns} FROM wechat_queries WHERE workspace_id=$1 AND actor_id=$2 ${chatId ? 'AND chat_id=$3' : ''} ORDER BY created_at DESC,id LIMIT 20`,
      chatId ? [ctx.workspaceId, ctx.actorId, chatId] : [ctx.workspaceId, ctx.actorId],
    )
  ).rows;
  return rows.map((row) => ({ ...view(row), message_count: Number(row.message_count) }));
}
export async function conversations(ctx: Context) {
  const rows = (
    await ctx.tx.query<{
      conversation_id: string;
      id: string;
      identity: WeChatContact;
      query_count: number;
      start: string;
      end: string;
      message_count: number;
      state: WeChatPreview['state'];
      created_at: string;
      total: number;
    }>(
      `WITH ranked AS (
      SELECT id,identity,start_date,end_date,jsonb_array_length(messages)::int AS message_count,state,created_at,
      first_value(id) OVER (PARTITION BY account_key,identity->>'id' ORDER BY created_at,id) AS conversation_id,
      count(*) OVER (PARTITION BY account_key,identity->>'id')::int AS query_count,
      row_number() OVER (PARTITION BY account_key,identity->>'id' ORDER BY created_at DESC,id DESC) AS latest
      FROM wechat_queries WHERE workspace_id=$1 AND actor_id=$2
    ) SELECT conversation_id,id,identity,to_char(start_date,'YYYY-MM-DD') AS start,to_char(end_date,'YYYY-MM-DD') AS end,
      message_count,state,created_at,query_count,count(*) OVER ()::int AS total
      FROM ranked WHERE latest=1 ORDER BY created_at DESC,id DESC LIMIT 100`,
      [ctx.workspaceId, ctx.actorId],
    )
  ).rows;
  const items: WeChatConversation[] = rows.map((row) => ({
    id: row.conversation_id,
    identity: row.identity,
    query_count: Number(row.query_count),
    latest: {
      id: row.id,
      start: row.start,
      end: row.end,
      message_count: Number(row.message_count),
      state: row.state,
      created_at: row.created_at,
    },
  }));
  return { items, total: Number(rows[0]?.total || 0) };
}
export async function conversationQueries(ctx: Context, id: string) {
  const anchor = (
    await ctx.tx.query<{ account_key: string; talker: string }>(
      `SELECT account_key,identity->>'id' AS talker FROM wechat_queries WHERE workspace_id=$1 AND actor_id=$2 AND id=$3`,
      [ctx.workspaceId, ctx.actorId, id],
    )
  ).rows[0];
  if (!anchor) throw new ApiError(404, '微信对话不存在或无权访问');
  const rows = (
    await ctx.tx.query(
      `SELECT ${metadataColumns},count(*) OVER ()::int AS total FROM wechat_queries
      WHERE workspace_id=$1 AND actor_id=$2 AND account_key=$3 AND identity->>'id'=$4
      ORDER BY created_at DESC,id DESC LIMIT 20`,
      [ctx.workspaceId, ctx.actorId, anchor.account_key, anchor.talker],
    )
  ).rows;
  return {
    items: rows.map((row) => ({ ...view(row), message_count: Number(row.message_count) })),
    total: Number(rows[0]?.total || 0),
  };
}
export async function preview(
  ctx: Context,
  input: unknown,
  options?: WeChatOptions,
  chatId?: string,
  batch?: WeChatBatchAttribution,
) {
  allowed(ctx, options);
  const q = queryInput.parse(input);
  if (batch) {
    const customer = await service.customer(ctx, batch.customer_id, true);
    service.activeCustomer(customer);
    if (batch.person_id && (await person(ctx, batch.person_id, batch.customer_id)).archived_at)
      throw new ApiError(409, '联系人已归档，本次未读取');
    if (
      batch.project_id &&
      (await service.project(ctx, batch.customer_id, batch.project_id)).archived_at
    )
      throw new ApiError(409, '项目已归档，本次未读取');
  }
  let range: { lower: number; upper: number };
  try {
    range = wechatRange(q.start, q.end);
  } catch {
    throw new ApiError(400, '请填写有效日期，单次最多 31 天。');
  }
  const prior = (
    await ctx.tx.query<{ id: string }>(
      'SELECT id FROM wechat_queries WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3',
      [ctx.workspaceId, ctx.actorId, q.request_id],
    )
  ).rows[0];
  if (prior) {
    if (batch) {
      const previous = await detail(ctx, prior.id);
      const archived = await archiveQuery(ctx, prior.id);
      if (
        archived.chat_id !== (chatId || null) ||
        previous.start !== q.start ||
        previous.end !== q.end ||
        (q.talker && previous.identity.id !== q.talker)
      )
        throw new ApiError(409, '此读取编号已用于其他对话或范围，请重新读取');
      await archiveBatch(ctx, prior.id, batch);
    } else await autoArchive(ctx, prior.id);
    return { preview: await detail(ctx, prior.id) };
  }
  if (
    chatId &&
    !(
      await ctx.tx.query(
        'SELECT id FROM agent_chats WHERE workspace_id=$1 AND id=$2 AND actor_id=$3',
        [ctx.workspaceId, chatId, ctx.actorId],
      )
    ).rows.length
  )
    throw new ApiError(404, '对话不存在');
  if (options.connectorRequired) {
    if (!options.connectorBindingEnabled) throw new ApiError(409, wechatBotBindingPausedMessage);
    const binding = await connectorBinding(ctx);
    if (!binding) throw new ApiError(409, '请先扫码绑定微信连接器。');
    if (!binding.verified_account_key)
      throw new ApiError(409, '尚未核验手机与本机微信为同一账号，本次未读取聊天。');
  }
  const ready = await options.transport.status();
  if (ready.state !== 'ready' || !ready.account_key) throw new ApiError(503, ready.message);
  if (
    options.connectorRequired &&
    (await connectorBinding(ctx))?.verified_account_key !== ready.account_key
  )
    throw new ApiError(409, '本机微信账号与已核验账号不符，请重新连接。');
  const conversation = q.conversation_id
    ? (
        await ctx.tx.query<{ account_key: string; identity: WeChatContact }>(
          'SELECT account_key,identity FROM wechat_queries WHERE workspace_id=$1 AND actor_id=$2 AND id=$3',
          [ctx.workspaceId, ctx.actorId, q.conversation_id],
        )
      ).rows[0]
    : undefined;
  if (q.conversation_id && !conversation) throw new ApiError(404, '微信对话不存在或无权访问');
  if (conversation && conversation.account_key !== ready.account_key)
    throw new ApiError(409, '当前登录微信账号与该对话不同，请切回原账号后读取。');
  const candidates = await options.transport.resolve(q.identity);
  const chosen = q.talker
    ? candidates.find((c) => c.id === q.talker)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if (!chosen) {
    if (!candidates.length)
      throw new ApiError(404, '没有找到匹配的微信联系人，请核对微信号、昵称或备注。');
    return { candidates, request: q };
  }
  if (conversation && conversation.identity.id !== chosen.id)
    throw new ApiError(400, '联系人与所选微信对话不符，请添加新的对话。');
  if (batch) {
    const existing = (
      await ctx.tx.query<SourceBinding>(
        'SELECT id,customer_id,person_id FROM wechat_source_bindings WHERE workspace_id=$1 AND actor_id=$2 AND account_key=$3 AND talker=$4 FOR UPDATE',
        [ctx.workspaceId, ctx.actorId, ready.account_key, chosen.id],
      )
    ).rows[0];
    if (
      existing &&
      (existing.customer_id !== batch.customer_id ||
        (batch.person_id && existing.person_id !== batch.person_id))
    )
      throw new ApiError(409, '此微信来源已关联其他客户或联系人，请核对任务范围；本次未读取消息');
  }
  const result = await options.transport.history(chosen.id, q.start, q.end);
  const after = await options.transport.status();
  if (after.state !== 'ready' || after.account_key !== ready.account_key)
    throw new ApiError(409, '读取期间微信账号发生变化，请重新查询。');
  const messages = [
    ...new Map(
      result.messages
        .filter((m) => Date.parse(m.at) >= range.lower && Date.parse(m.at) < range.upper)
        .map((m) => [m.id, m]),
    ).values(),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const { entities, relations } = summarizeWeChat(chosen, messages);
  const id = randomUUID();
  await ctx.tx.query(
    'INSERT INTO wechat_queries(workspace_id,actor_id,id,request_id,chat_id,account_key,identity,start_date,end_date,messages,entities,relations,warnings) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb)',
    [
      ctx.workspaceId,
      ctx.actorId,
      id,
      q.request_id,
      chatId ?? null,
      ready.account_key,
      JSON.stringify(chosen),
      q.start,
      q.end,
      JSON.stringify(messages),
      JSON.stringify(entities),
      JSON.stringify(relations),
      JSON.stringify(result.warnings),
    ],
  );
  if (batch) await archiveBatch(ctx, id, batch);
  else await autoArchive(ctx, id);
  return { preview: await detail(ctx, id) };
}
interface SourceBinding {
  id: string;
  customer_id: string;
  person_id: string | null;
}
type Attribution = Omit<SourceBinding, 'id'> & { project_id: string | null };
interface ArchiveQuery {
  state: 'pending' | 'associated';
  customer_id: string | null;
  person_id: string | null;
  project_id: string | null;
  chat_id: string | null;
  account_key: string;
  identity: WeChatContact;
}
async function archiveQuery(ctx: Context, id: string) {
  const row = (
    await ctx.tx.query<ArchiveQuery>(
      'SELECT state,customer_id,person_id,project_id,chat_id,account_key,identity FROM wechat_queries WHERE workspace_id=$1 AND actor_id=$2 AND id=$3 FOR UPDATE',
      [ctx.workspaceId, ctx.actorId, id],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, '微信读取记录不存在或无权访问');
  return row;
}
async function sourceBinding(ctx: Context, row: ArchiveQuery) {
  return (
    await ctx.tx.query<SourceBinding>(
      'SELECT id,customer_id,person_id FROM wechat_source_bindings WHERE workspace_id=$1 AND actor_id=$2 AND account_key=$3 AND talker=$4 FOR UPDATE',
      [ctx.workspaceId, ctx.actorId, row.account_key, row.identity.id],
    )
  ).rows[0];
}
async function validateAttribution(ctx: Context, row: ArchiveQuery, binding: Attribution) {
  const c = await service.customer(ctx, binding.customer_id, true);
  service.activeCustomer(c);
  if (binding.person_id && (await person(ctx, binding.person_id, binding.customer_id)).archived_at)
    throw new ApiError(409, '联系人已归档，未继续自动归档');
  if (
    binding.project_id &&
    (await service.project(ctx, binding.customer_id, binding.project_id)).archived_at
  )
    throw new ApiError(409, '项目已归档，未继续自动归档');
  if (row.chat_id) {
    const scope = (
      await ctx.tx.query<{ customer_id: string | null }>(
        'SELECT customer_id FROM agent_chats WHERE workspace_id=$1 AND id=$2 AND actor_id=$3',
        [ctx.workspaceId, row.chat_id, ctx.actorId],
      )
    ).rows[0];
    if (!scope || (scope.customer_id && scope.customer_id !== binding.customer_id))
      throw new ApiError(409, '此微信来源属于另一客户，请在个人资料收件对话中处理');
  }
}
async function archiveAll(
  ctx: Context,
  id: string,
  row: ArchiveQuery,
  binding: SourceBinding & Attribution,
  automatic: boolean,
) {
  await validateAttribution(ctx, row, binding);
  const p = await detail(ctx, id);
  if (row.state === 'associated') return p;
  const messages = p.messages.filter((m) => m.text.trim());
  if (!messages.length) return p;
  let added = 0;
  const records = new Set<string>();
  for (const message of messages) {
    // Stable source identity plus content version: attribution changes and overlapping
    // date ranges cannot clone a message. Changed original content remains a new version.
    const hash = createHash('sha256')
      .update(JSON.stringify([message.at, message.speaker, message.from_me, message.text]))
      .digest('hex');
    let stored = (
      await ctx.tx.query<{ record_id: string; customer_id: string }>(
        'SELECT record_id,customer_id FROM wechat_message_records WHERE workspace_id=$1 AND account_key=$2 AND talker=$3 AND message_id=$4 AND content_hash=$5',
        [ctx.workspaceId, row.account_key, row.identity.id, message.id, hash],
      )
    ).rows[0];
    if (stored && stored.customer_id !== binding.customer_id)
      throw new ApiError(409, '此源消息已归属其他客户，未重复归档');
    if (!stored) {
      const header = `微信文字原文\n联系人：${p.identity.remark || p.identity.name || p.identity.id}\n${message.at} · ${message.speaker} · 来源消息 ${message.id}\n${message.from_me ? '本方发言' : '对方发言'}；原话不代表公司正式确认。\n\n`;
      const body =
        header +
        (message.text.length + header.length <= 10000
          ? message.text
          : '本条文字较长，完整原文保存在此 Record 的微信来源证据中。');
      const record = await service.insert(ctx, 'customer_records', {
        customer_id: binding.customer_id,
        project_id: binding.project_id,
        kind: 'customer_quote',
        source_kind: 'wechat',
        occurred_at: message.at,
        body,
        created_by: ctx.actorId,
      });
      stored = { record_id: String(record.id), customer_id: binding.customer_id };
      await ctx.tx.query(
        `INSERT INTO wechat_message_records(workspace_id,actor_id,account_key,talker,message_id,content_hash,customer_id,person_id,project_id,record_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          ctx.workspaceId,
          ctx.actorId,
          row.account_key,
          row.identity.id,
          message.id,
          hash,
          binding.customer_id,
          binding.person_id,
          binding.project_id,
          stored.record_id,
        ],
      );
      const sourceKey = createHash('sha256')
        .update(
          JSON.stringify(['wechat-auto-v1', row.account_key, row.identity.id, message.id, hash]),
        )
        .digest('hex');
      await ctx.tx.query(
        `INSERT INTO knowledge_wechat_evidence(workspace_id,customer_id,id,source_key,record_id,project_id,person_id,occurred_at,speaker,body,created_by,message_id,from_me)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          ctx.workspaceId,
          binding.customer_id,
          randomUUID(),
          sourceKey,
          stored.record_id,
          binding.project_id,
          binding.person_id,
          message.at,
          message.speaker,
          message.text,
          ctx.actorId,
          message.id,
          message.from_me,
        ],
      );
      added++;
    }
    records.add(stored.record_id);
    await ctx.tx.query(
      'INSERT INTO wechat_query_records(workspace_id,query_id,customer_id,record_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [ctx.workspaceId, id, binding.customer_id, stored.record_id],
    );
  }
  await ctx.tx.query(
    "UPDATE wechat_queries SET state='associated',customer_id=$4,person_id=$5,project_id=$6,record_id=$7,selected='[\"full-conversation\"]'::jsonb,archive_automatic=$8,archive_new_records=$9 WHERE workspace_id=$1 AND actor_id=$2 AND id=$3",
    [
      ctx.workspaceId,
      ctx.actorId,
      id,
      binding.customer_id,
      binding.person_id,
      binding.project_id,
      [...records][0],
      automatic,
      added,
    ],
  );
  return detail(ctx, id);
}
async function autoArchive(ctx: Context, id: string) {
  const row = await archiveQuery(ctx, id);
  const binding = await sourceBinding(ctx, row);
  if (binding) await archiveAll(ctx, id, row, { ...binding, project_id: null }, true);
}
async function archiveBatch(ctx: Context, id: string, batch: WeChatBatchAttribution) {
  const row = await archiveQuery(ctx, id);
  const binding = await sourceBinding(ctx, row);
  if (
    binding &&
    (binding.customer_id !== batch.customer_id ||
      (batch.person_id && binding.person_id !== batch.person_id))
  )
    throw new ApiError(409, '此微信来源已有其他归属，未改变归属');
  if (!(await detail(ctx, id)).message_count) return;
  await associate(ctx, id, { ...batch, person_id: batch.person_id || binding?.person_id || null });
}
export async function associate(ctx: Context, id: string, input: unknown) {
  requireAdmin(ctx);
  const q = z
    .strictObject({
      customer_id: z.uuid(),
      person_id: z.uuid().nullable().default(null),
      project_id: z.uuid().nullable().default(null),
    })
    .parse(input);
  const row = await archiveQuery(ctx, id);
  await validateAttribution(ctx, row, q);
  if (row.state === 'associated') {
    if (
      row.customer_id !== q.customer_id ||
      row.person_id !== q.person_id ||
      row.project_id !== q.project_id
    )
      throw new ApiError(409, '此读取记录已归档，请勿改变归属');
    return detail(ctx, id);
  }
  if (!(await detail(ctx, id)).message_count)
    throw new ApiError(400, '本次范围没有可归档的文字内容');
  await ctx.tx.query(
    `INSERT INTO wechat_source_bindings(workspace_id,actor_id,id,account_key,talker,customer_id,person_id,source_query_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,account_key,talker) DO NOTHING`,
    [
      ctx.workspaceId,
      ctx.actorId,
      randomUUID(),
      row.account_key,
      row.identity.id,
      q.customer_id,
      q.person_id,
      id,
    ],
  );
  const binding = await sourceBinding(ctx, row);
  if (!binding || binding.customer_id !== q.customer_id || binding.person_id !== q.person_id)
    throw new ApiError(409, '此微信对话已有其他归属，未改变归属或重复归档');
  return archiveAll(ctx, id, row, { ...binding, project_id: q.project_id }, false);
}
