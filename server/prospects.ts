import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError, type Context } from './security.js';
import * as service from './service.js';
import { person } from './people.js';
import { resolveNoteSource } from './note-sources.js';
import type {
  Prospect,
  ProspectListResponse,
  ProspectRequirement,
  ProspectSourceRef,
  ProspectTask,
  ProspectTaskListResponse,
} from '../shared/prospects.js';

const uuid = z.string().uuid();
const requirementSchema = z.strictObject({
  id: uuid,
  title: z.string().trim().min(1).max(300),
  status: z.enum(['missing', 'in_progress', 'satisfied', 'not_applicable']),
  waiting_on: z.enum(['us', 'customer', 'internal']).nullable(),
  assignee_id: uuid.nullable(),
  due_date: z.iso.date().nullable(),
  result: z.string().trim().max(5000),
  source_record_ids: z.array(uuid).max(30).default([]),
});
const refSchema = z.strictObject({
  record_id: uuid,
  source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().max(500).optional(),
});
const mutable = {
  name: z.string().trim().min(1).max(120),
  owner_id: uuid.nullable(),
  person_id: uuid.nullable(),
  summary: z.string().trim().max(10000),
  requirements: z.array(requirementSchema).max(100),
  source_refs: z.array(refSchema).max(30),
};
export const createSchema = z.strictObject({
  request_id: uuid,
  customer_id: uuid,
  existing_project_id: uuid.optional(),
  ...mutable,
  owner_id: mutable.owner_id.default(null),
  person_id: mutable.person_id.default(null),
  summary: mutable.summary.default(''),
  requirements: mutable.requirements.default([]),
  source_refs: mutable.source_refs.default([]),
});
export const updateSchema = z.strictObject({
  request_id: uuid,
  version: z.number().int().positive(),
  ...z.object(mutable).partial().shape,
  stage: z.enum(['new', 'needs', 'proposal', 'decision']).optional(),
  lifecycle: z.enum(['active', 'paused', 'closed']).optional(),
  outcome: z.enum(['won', 'lost', 'resolved', 'invalid', 'duplicate']).nullable().optional(),
  outcome_reason: z.string().trim().max(2000).optional(),
  acknowledge_open_requirements: z.boolean().optional(),
});
export const listSchema = z.strictObject({
  q: z.string().trim().max(100).default(''),
  lifecycle: z.enum(['active', 'paused', 'closed']).optional(),
  stage: z.enum(['new', 'needs', 'proposal', 'decision']).optional(),
  type: z.enum(['distributor', 'group', 'retail']).optional(),
  owner: z.union([uuid, z.enum(['me', 'unassigned'])]).optional(),
  customer_id: uuid.optional(),
  view: z.enum(['all', 'mine', 'today', 'overdue', 'closed']).default('all'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(30),
});
export const taskSchema = z.strictObject({
  q: z.string().trim().max(100).default(''),
  customer_id: uuid.optional(),
  view: z.enum(['mine', 'all', 'today', 'overdue', 'done']).default('mine'),
  status: z.enum(['', 'open', 'in_progress', 'completed']).default(''),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(30),
});

const select = `SELECT f.project_id AS id,f.customer_id,c.name AS customer_name,c.type AS customer_type,
 f.name,p.owner_id,o.display_name AS owner_name,f.person_id,n.name AS person_name,
 f.stage,f.lifecycle,f.outcome,f.outcome_reason,f.summary,f.requirements,f.source_refs,f.version,
 crm_access(f.workspace_id,f.customer_id,true) AS can_edit,f.created_at,f.updated_at,
 crm_prospect_sources_valid(f.workspace_id,f.customer_id,f.project_id,f.source_refs) AS sources_valid
 FROM prospect_profiles f JOIN projects p ON p.workspace_id=f.workspace_id AND p.customer_id=f.customer_id AND p.id=f.project_id
 JOIN customers c ON c.workspace_id=f.workspace_id AND c.id=f.customer_id
 LEFT JOIN workspace_people o ON o.workspace_id=p.workspace_id AND o.actor_id=p.owner_id AND o.active
 LEFT JOIN people n ON n.workspace_id=f.workspace_id AND n.customer_id=f.customer_id AND n.id=f.person_id AND n.archived_at IS NULL`;
const baseWhere = 'f.workspace_id=$1 AND p.archived_at IS NULL AND c.archived_at IS NULL';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const openState = (r: ProspectRequirement) => r.status === 'missing' || r.status === 'in_progress';

async function current(ctx: Context, id: string, lock = false): Promise<Prospect> {
  const row = (
    await ctx.tx.query<Prospect>(
      `${select} WHERE ${baseWhere} AND f.project_id=$2${lock ? ' FOR UPDATE OF f,p' : ''}`,
      [ctx.workspaceId, uuid.parse(id)],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, '询盘不存在、已归档或无权访问');
  return row;
}
async function canonicalRefs(
  ctx: Context,
  customerId: string,
  projectId: string,
  refs: ProspectSourceRef[],
): Promise<ProspectSourceRef[]> {
  const result: ProspectSourceRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.record_id)) throw new ApiError(400, '询盘来源编号重复');
    seen.add(ref.record_id);
    const source = await resolveNoteSource(ctx, customerId, ref);
    if (
      source.source_hash !== ref.source_hash ||
      (source.project_id !== null && source.project_id !== projectId) ||
      source.project_scope_complete === false
    )
      throw new ApiError(409, '来源已变化或属于其他项目，请重新选择来源');
    result.push({
      record_id: source.record_id,
      source_hash: source.source_hash,
      title: source.title,
    });
  }
  return result;
}
async function present(ctx: Context, row: Prospect): Promise<Prospect> {
  const formatted = {
    ...row,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
  try {
    if (!row.sources_valid) throw new ApiError(409, '来源已失效');
    return {
      ...formatted,
      source_refs: await canonicalRefs(ctx, row.customer_id, row.id, row.source_refs),
    };
  } catch (error) {
    if (!(error instanceof ApiError && [400, 404, 409].includes(error.status))) throw error;
    return {
      ...formatted,
      name: '来源已失效的询盘',
      summary: '',
      outcome_reason: '',
      requirements: row.requirements.map((r) => ({
        ...r,
        title: '来源已失效，请重新整理',
        result: '',
      })),
      source_refs: [],
      sources_valid: false,
      source_warning: '部分来源已改版、归档或失权，已隐藏旧内容；请重新选择当前来源并整理。',
    };
  }
}
export async function detail(ctx: Context, id: string): Promise<Prospect> {
  return present(ctx, await current(ctx, id));
}

async function assignable(ctx: Context, customerId: string, actor: string | null) {
  if (!actor) return;
  const valid = (
    await ctx.tx.query<{ allowed: boolean }>(
      'SELECT crm_prospect_assignable($1,$2,$3) AS allowed',
      [ctx.workspaceId, customerId, actor],
    )
  ).rows[0]?.allowed;
  if (!valid) throw new ApiError(400, '负责人必须是有该客户编辑权限的有效成员，指派不会自动授权');
}
async function validateValues(
  ctx: Context,
  customerId: string,
  personId: string | null,
  owner: string | null,
  requirements: ProspectRequirement[],
  refs: ProspectSourceRef[],
) {
  service.activeCustomer(await service.customer(ctx, customerId, true));
  if (personId && (await person(ctx, personId, customerId)).archived_at)
    throw new ApiError(409, '联系人已归档');
  await assignable(ctx, customerId, owner);
  const ids = new Set<string>(),
    sourceIds = new Set(refs.map((r) => r.record_id));
  for (const r of requirements) {
    if (ids.has(r.id)) throw new ApiError(400, '需求编号重复');
    ids.add(r.id);
    if ((r.status === 'satisfied' || r.status === 'not_applicable') && !r.result.trim())
      throw new ApiError(400, '已满足或不适用的需求需要填写结果说明');
    if (r.source_record_ids?.some((id) => !sourceIds.has(id)))
      throw new ApiError(400, '需求引用的原文必须保留在询盘来源中');
    await assignable(ctx, customerId, r.assignee_id);
  }
}
type Mutation = {
  kind: string;
  target_id: string | null;
  payload_hash: string;
  result_version: number;
};
async function replay(
  ctx: Context,
  requestId: string,
  kind: string,
  payload: unknown,
  customerId: string,
  target?: string,
) {
  // ON CONFLICT serializes identical request IDs before any business write.
  await ctx.tx.query(
    'INSERT INTO prospect_mutations(workspace_id,actor_id,customer_id,request_id,kind,target_id,payload_hash,result_version) VALUES($1,$2,$3,$4,$5,NULL,$6,0) ON CONFLICT(workspace_id,actor_id,request_id) DO NOTHING',
    [ctx.workspaceId, ctx.actorId, customerId, requestId, kind, hash(payload)],
  );
  const row = (
    await ctx.tx.query<Mutation>(
      'SELECT kind,target_id,payload_hash,result_version FROM prospect_mutations WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3 FOR UPDATE',
      [ctx.workspaceId, ctx.actorId, requestId],
    )
  ).rows[0];
  if (!row) throw new ApiError(409, '请求编号已被其他范围占用');
  if (
    row.kind !== kind ||
    row.payload_hash !== hash(payload) ||
    (target && row.target_id !== null && row.target_id !== target)
  )
    throw new ApiError(409, '相同请求编号不能用于不同询盘动作或内容');
  if (row.target_id === null) return null;
  const result = await detail(ctx, row.target_id);
  if (result.version !== row.result_version)
    throw new ApiError(409, '该操作已被较新修改取代，请读取当前询盘');
  if (!result.sources_valid) throw new ApiError(409, '来源已失效，请重新整理');
  return result;
}
async function remember(
  ctx: Context,
  requestId: string,
  kind: string,
  payload: unknown,
  row: Prospect,
) {
  await ctx.tx.query(
    'UPDATE prospect_mutations SET target_id=$6,result_version=$8 WHERE workspace_id=$1 AND actor_id=$2 AND customer_id=$3 AND request_id=$4 AND kind=$5 AND payload_hash=$7',
    [
      ctx.workspaceId,
      ctx.actorId,
      row.customer_id,
      requestId,
      kind,
      row.id,
      hash(payload),
      row.version,
    ],
  );
}
async function event(ctx: Context, row: Prospect, kind: string, previous?: Prospect) {
  await ctx.tx.query(
    'INSERT INTO prospect_events(workspace_id,customer_id,project_id,id,actor_id,profile_version,kind,change_summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      ctx.workspaceId,
      row.customer_id,
      row.id,
      randomUUID(),
      ctx.actorId,
      row.version,
      kind,
      JSON.stringify({
        stage: row.stage,
        lifecycle: row.lifecycle,
        outcome: row.outcome,
        ...(previous
          ? {
              from_stage: previous.stage,
              from_lifecycle: previous.lifecycle,
              from_outcome: previous.outcome,
            }
          : {}),
        requirements: row.requirements.map((r) => ({ id: r.id, status: r.status })),
      }),
    ],
  );
}

export async function create(ctx: Context, input: unknown): Promise<Prospect> {
  const value = createSchema.parse(input);
  service.activeCustomer(await service.customer(ctx, value.customer_id, true));
  const prior = await replay(ctx, value.request_id, 'create', value, value.customer_id);
  if (prior) return prior;
  let id = value.existing_project_id;
  if (id) {
    const p = await service.project(ctx, value.customer_id, id);
    if (p.archived_at || p.type !== 'inquiry' || p.stage !== 'new')
      throw new ApiError(409, '只能明确接管未归档、新建阶段的询盘项目');
    if (
      (
        await ctx.tx.query(
          'SELECT project_id FROM prospect_profiles WHERE workspace_id=$1 AND project_id=$2',
          [ctx.workspaceId, id],
        )
      ).rows.length
    )
      throw new ApiError(409, '该项目已经是询盘，请关联现有询盘');
    await ctx.tx.query('SELECT id FROM projects WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
      ctx.workspaceId,
      id,
    ]);
  } else {
    id = String(
      (
        await service.insert(ctx, 'projects', {
          customer_id: value.customer_id,
          name: value.name,
          type: 'inquiry',
          stage: 'new',
          owner_id: value.owner_id,
        })
      ).id,
    );
  }
  const refs = await canonicalRefs(ctx, value.customer_id, id, value.source_refs);
  await validateValues(
    ctx,
    value.customer_id,
    value.person_id,
    value.owner_id,
    value.requirements,
    refs,
  );
  await ctx.tx.query('UPDATE projects SET name=$3,owner_id=$4 WHERE workspace_id=$1 AND id=$2', [
    ctx.workspaceId,
    id,
    refs.length ? `咨询跟进 · ${id.slice(0, 8)}` : value.name,
    value.owner_id,
  ]);
  await ctx.tx.query(
    'INSERT INTO prospect_profiles(workspace_id,customer_id,project_id,name,person_id,summary,requirements,source_refs,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      ctx.workspaceId,
      value.customer_id,
      id,
      value.name,
      value.person_id,
      value.summary,
      JSON.stringify(value.requirements),
      JSON.stringify(refs),
      ctx.actorId,
    ],
  );
  const row = await detail(ctx, id);
  await event(ctx, row, 'created');
  await remember(ctx, value.request_id, 'create', value, row);
  return row;
}

export async function update(ctx: Context, prospectId: string, input: unknown): Promise<Prospect> {
  const id = uuid.parse(prospectId),
    value = updateSchema.parse(input);
  const visible = await current(ctx, id);
  service.activeCustomer(await service.customer(ctx, visible.customer_id, true));
  const before = await current(ctx, id, true);
  const prior = await replay(ctx, value.request_id, 'update', value, before.customer_id, id);
  if (prior) return prior;
  if (before.version !== value.version) throw new ApiError(409, '询盘已被修改，请刷新后重试');
  const next = {
    ...before,
    ...value,
    person_id: value.person_id === undefined ? before.person_id : value.person_id,
  };
  if ((next.lifecycle === 'closed') !== (next.outcome !== null))
    throw new ApiError(400, '结束询盘必须明确结果；重开请同时清除旧结果');
  if (
    next.lifecycle === 'closed' &&
    next.requirements.some(openState) &&
    !value.acknowledge_open_requirements
  )
    throw new ApiError(409, '仍有未完成业务状态，请明确确认保留后再结束询盘');
  if (
    next.lifecycle === 'closed' &&
    (
      await ctx.tx.query<{ pending: boolean }>(
        'SELECT crm_prospect_pending_mail($1,$2,$3) AS pending',
        [ctx.workspaceId, before.customer_id, id],
      )
    ).rows[0]?.pending
  )
    throw new ApiError(409, '询盘有待发送或结果待核对的邮件，请在邮件中明确处理后再结束');
  // Previously selected evidence remains a dependency even if a caller removes its visible card.
  const merged = new Map(before.source_refs.map((r) => [r.record_id, r]));
  for (const ref of value.source_refs || []) {
    const old = merged.get(ref.record_id);
    if (
      old &&
      old.source_hash !== ref.source_hash &&
      (value.summary === undefined || value.requirements === undefined)
    )
      throw new ApiError(409, '来源改版后需重新提交完整摘要与业务需求，不能沿用旧内容');
    merged.set(ref.record_id, ref);
  }
  const refs = await canonicalRefs(ctx, before.customer_id, id, [...merged.values()]);
  await validateValues(
    ctx,
    before.customer_id,
    next.person_id,
    next.owner_id,
    next.requirements,
    refs,
  );
  await ctx.tx.query(
    'UPDATE prospect_profiles SET person_id=$3,stage=$4,lifecycle=$5,outcome=$6,outcome_reason=$7,summary=$8,requirements=$9,source_refs=$10,name=$11,version=version+1 WHERE workspace_id=$1 AND project_id=$2 AND version=$12',
    [
      ctx.workspaceId,
      id,
      next.person_id,
      next.stage,
      next.lifecycle,
      next.outcome,
      next.outcome_reason,
      next.summary,
      JSON.stringify(next.requirements),
      JSON.stringify(refs),
      next.name,
      before.version,
    ],
  );
  await ctx.tx.query("SELECT set_config('app.prospect_mutation',$1,true)", [id]);
  await ctx.tx.query(
    'UPDATE projects SET name=$3,owner_id=$4 WHERE workspace_id=$1 AND customer_id=$2 AND id=$5',
    [
      ctx.workspaceId,
      before.customer_id,
      refs.length ? `咨询跟进 · ${id.slice(0, 8)}` : next.name,
      next.owner_id,
      id,
    ],
  );
  await ctx.tx.query("SELECT set_config('app.prospect_mutation','',true)");
  const row = await detail(ctx, id);
  if (!row.sources_valid) throw new ApiError(409, '提交前来源已变化，请重新整理');
  await event(
    ctx,
    row,
    before.lifecycle === 'closed' && row.lifecycle !== 'closed' ? 'reopened' : 'updated',
    before,
  );
  await remember(ctx, value.request_id, 'update', value, row);
  return row;
}

export async function list(ctx: Context, input: unknown = {}): Promise<ProspectListResponse> {
  const q = listSchema.parse(input),
    args: unknown[] = [ctx.workspaceId];
  const conditions = [baseWhere];
  const add = (sql: string, value: unknown) => {
    args.push(value);
    conditions.push(sql.replace('?', `$${args.length}`));
  };
  if (q.q)
    add(
      '(crm_prospect_sources_valid(f.workspace_id,f.customer_id,f.project_id,f.source_refs) AND f.name ILIKE ? OR c.name ILIKE ?)',
      `%${q.q}%`,
    );
  // The single bound search parameter is intentionally reused for both columns.
  if (q.q)
    conditions[conditions.length - 1] = conditions[conditions.length - 1].replace(
      '?',
      `$${args.length}`,
    );
  if (q.lifecycle) add('f.lifecycle=?', q.lifecycle);
  if (q.stage) add('f.stage=?', q.stage);
  if (q.type) add('c.type=?', q.type);
  if (q.customer_id) add('f.customer_id=?', q.customer_id);
  if (q.owner === 'unassigned') conditions.push('p.owner_id IS NULL');
  else if (q.owner) add('p.owner_id=?', q.owner === 'me' ? ctx.actorId : q.owner);
  if (q.view === 'closed') conditions.push("f.lifecycle='closed'");
  if (q.view === 'mine')
    add(
      `f.lifecycle<>'closed' AND crm_prospect_sources_valid(f.workspace_id,f.customer_id,f.project_id,f.source_refs) AND EXISTS(SELECT 1 FROM jsonb_array_elements(f.requirements) r WHERE r->>'status' IN ('missing','in_progress') AND crm_prospect_assignable(f.workspace_id,f.customer_id,coalesce(nullif(r->>'assignee_id','')::uuid,p.owner_id)) AND coalesce(nullif(r->>'assignee_id','')::uuid,p.owner_id)=?)`,
      ctx.actorId,
    );
  if (q.view === 'today' || q.view === 'overdue')
    conditions.push(
      `f.lifecycle<>'closed' AND crm_prospect_sources_valid(f.workspace_id,f.customer_id,f.project_id,f.source_refs) AND EXISTS(SELECT 1 FROM jsonb_array_elements(f.requirements) r WHERE r->>'status' IN ('missing','in_progress') AND r->>'due_date' ${q.view === 'today' ? '=' : '<'} to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD'))`,
    );
  const where = conditions.join(' AND ');
  const total = Number(
    (
      await ctx.tx.query<{ total: string }>(
        `${select.replace(/^SELECT[\s\S]*? FROM prospect_profiles/, 'SELECT count(*) AS total FROM prospect_profiles')} WHERE ${where}`,
        args,
      )
    ).rows[0]?.total || 0,
  );
  const rows = (
    await ctx.tx.query<Prospect>(
      `${select} WHERE ${where} ORDER BY f.updated_at DESC,f.project_id LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, q.page_size, (q.page - 1) * q.page_size],
    )
  ).rows;
  const items: Prospect[] = [];
  for (const row of rows) items.push(await present(ctx, row));
  return { items, total, page: q.page, page_size: q.page_size };
}

export async function tasks(ctx: Context, input: unknown = {}): Promise<ProspectTaskListResponse> {
  const q = taskSchema.parse(input),
    args: unknown[] = [ctx.workspaceId];
  const conditions = [
    baseWhere,
    'crm_prospect_sources_valid(f.workspace_id,f.customer_id,f.project_id,f.source_refs)',
  ];
  const add = (sql: string, value: unknown) => {
    args.push(value);
    conditions.push(sql.replace('?', `$${args.length}`));
  };
  if (q.view === 'done' || q.status === 'completed') conditions.push("r->>'status'='satisfied'");
  else
    conditions.push(
      "f.lifecycle<>'closed'",
      q.status === 'in_progress'
        ? "r->>'status'='in_progress'"
        : q.status === 'open'
          ? "r->>'status'='missing'"
          : "r->>'status' IN ('missing','in_progress')",
    );
  if (q.view !== 'all')
    add("coalesce(nullif(r->>'assignee_id','')::uuid,p.owner_id)=?", ctx.actorId);
  if (q.customer_id) add('f.customer_id=?', q.customer_id);
  if (q.q) add("(r->>'title' ILIKE ? OR f.name ILIKE ?)", `%${q.q}%`);
  if (q.q)
    conditions[conditions.length - 1] = conditions[conditions.length - 1].replace(
      '?',
      `$${args.length}`,
    );
  if (q.view === 'today' || q.view === 'overdue')
    conditions.push(
      `r->>'due_date' ${q.view === 'today' ? '=' : '<'} to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')`,
    );
  conditions.push(
    "coalesce(nullif(r->>'assignee_id','')::uuid,p.owner_id) IS NULL OR crm_prospect_assignable(f.workspace_id,f.customer_id,coalesce(nullif(r->>'assignee_id','')::uuid,p.owner_id))",
  );
  const from = `${select.slice(select.indexOf(' FROM prospect_profiles'))},LATERAL jsonb_array_elements(f.requirements) r`;
  const where = conditions.map((c) => `(${c})`).join(' AND ');
  const total = Number(
    (await ctx.tx.query<{ total: string }>(`SELECT count(*) AS total ${from} WHERE ${where}`, args))
      .rows[0]?.total || 0,
  );
  const rows = (
    await ctx.tx.query<{
      requirement: ProspectRequirement;
      prospect_id: string;
      prospect_name: string;
      prospect_version: number;
      customer_id: string;
      customer_name: string;
      customer_type: Prospect['customer_type'];
      effective_assignee_id: string | null;
      lifecycle: Prospect['lifecycle'];
      can_edit: boolean;
    }>(
      `SELECT r AS requirement,f.project_id AS prospect_id,f.name AS prospect_name,f.version AS prospect_version,f.customer_id,c.name AS customer_name,c.type AS customer_type,coalesce(nullif(r->>'assignee_id','')::uuid,p.owner_id) AS effective_assignee_id,f.lifecycle,crm_access(f.workspace_id,f.customer_id,true) AS can_edit ${from} WHERE ${where} ORDER BY nullif(r->>'due_date','') NULLS LAST,f.updated_at DESC,r->>'id' LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, q.page_size, (q.page - 1) * q.page_size],
    )
  ).rows;
  const items: ProspectTask[] = rows.map(({ requirement, ...row }) => ({
    ...requirement,
    ...row,
    sources_valid: true,
  }));
  return { items, total, page: q.page, page_size: q.page_size };
}

/** The ordinary project endpoint must not bypass inquiry authority or its version check. */
export async function validateProjectUpdate(
  ctx: Context,
  customerId: string,
  id: string,
  patch: Record<string, unknown>,
) {
  const managed =
    (
      await ctx.tx.query(
        'SELECT project_id FROM prospect_profiles WHERE workspace_id=$1 AND customer_id=$2 AND project_id=$3',
        [ctx.workspaceId, customerId, id],
      )
    ).rows.length > 0;
  if (managed && ['type', 'stage', 'name', 'owner_id'].some((key) => Object.hasOwn(patch, key)))
    throw new ApiError(
      409,
      '该项目由潜在客户业务状态管理，请在潜在客户页面修改名称、负责人、阶段或结果',
    );
}
