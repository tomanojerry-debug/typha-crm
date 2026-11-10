import { entitySchema } from './entity-schema.js';
import { sanitizeAttributeSources } from './attribute-source-visibility.js';
import {
  buildAttributeRetrieval,
  attributeRetrievedSources,
  type AttributeRetrievalPlan,
} from './attribute-evidence.js';
import { knowledgeAgentSources } from './knowledge.js';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  CompanyAttribute,
  CompanyAttributeValue,
  AttributeSource,
  AttributeRun,
  AttributeValue,
} from '../shared/attributes.js';
import { attributeColumn, isEmptyAttributeValue } from '../shared/attributes.js';
import { recordKinds } from '../shared/domain.js';
import { ApiError, requireAdmin, scoped, type Context } from './security.js';
import * as service from './service.js';
import type { Database } from './db.js';
import {
  attributeModel,
  prepareModel,
  groundAttributeResult,
  type AttributeModelOptions,
} from './attribute-model.js';
import { uuid } from './validation.js';

const fieldInput = z
  .strictObject({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(['text', 'number', 'select', 'multi_select']),
    description: z.string().trim().max(1000).default(''),
    options: z.array(z.string().trim().min(1).max(60)).max(40).default([]),
    ai_enabled: z.boolean().default(false),
    guidance: z.string().trim().max(4000).default(''),
    archived: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (['select', 'multi_select'].includes(v.kind) !== !!v.options.length)
      ctx.addIssue({ code: 'custom', message: '选项字段需要至少一个选项；其他字段不能设置选项' });
    if (new Set(v.options.map((s) => s.toLowerCase())).size !== v.options.length)
      ctx.addIssue({ code: 'custom', message: '选项不能重复' });
    if (v.ai_enabled && !v.guidance)
      ctx.addIssue({ code: 'custom', message: '请填写 AI 填充指令 Guidance' });
  });
const fieldColumns = 'id,name,kind,description,options,ai_enabled,guidance,archived,version';
const valueColumns =
  'attribute_id,customer_id,value,origin,explanation,sources,generated_at,version,updated_at';
export async function fields(ctx: Context) {
  return (
    await ctx.tx.query<CompanyAttribute>(
      `SELECT ${fieldColumns} FROM customer_attributes WHERE workspace_id=$1 ORDER BY created_at,id`,
      [ctx.workspaceId],
    )
  ).rows;
}
async function field(ctx: Context, id: string, version?: number) {
  const row = (await fields(ctx)).find((f) => f.id === id);
  if (!row) throw new ApiError(404, '属性不存在或无权访问');
  if (row.archived) throw new ApiError(409, '属性已停用');
  if (version !== undefined && row.version !== version)
    throw new ApiError(409, '属性配置已变化，请重新打开');
  return row;
}
export async function createField(ctx: Context, input: unknown) {
  requireAdmin(ctx);
  const value = fieldInput.parse(input);
  // Serializes field limits and naming against another creation in this workspace.
  await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `company-attributes:${ctx.workspaceId}`,
  ]);
  const existing = await fields(ctx);
  if (existing.filter((f) => !f.archived).length >= 40)
    throw new ApiError(400, '最多创建 40 个有效公司属性');
  if (existing.some((f) => !f.archived && f.name.toLowerCase() === value.name.toLowerCase()))
    throw new ApiError(409, '已有同名属性');
  return (
    await ctx.tx.query<CompanyAttribute>(
      `INSERT INTO customer_attributes(workspace_id,id,name,kind,description,options,ai_enabled,guidance,archived)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${fieldColumns}`,
      [
        ctx.workspaceId,
        randomUUID(),
        value.name,
        value.kind,
        value.description,
        JSON.stringify(value.options),
        value.ai_enabled,
        value.guidance,
        value.archived,
      ],
    )
  ).rows[0];
}
export async function updateField(ctx: Context, id: string, input: unknown) {
  requireAdmin(ctx);
  const { version, ...rest } = z
    .strictObject({ ...fieldInput.shape, version: z.number().int().positive() })
    .parse(input);
  const value = fieldInput.parse(rest);
  const old = (await fields(ctx)).find((f) => f.id === id);
  if (!old) throw new ApiError(404, '属性不存在');
  if (old.kind !== value.kind) throw new ApiError(400, '已有属性类型不可修改');
  if (old.options.some((o) => !value.options.includes(o)))
    throw new ApiError(400, '已有选项不能删除或改名，可新增选项');
  if (
    old.archived &&
    !value.archived &&
    (await fields(ctx)).filter((f) => !f.archived).length >= 40
  )
    throw new ApiError(400, '有效公司属性已达上限');
  const row = (
    await ctx.tx.query<CompanyAttribute>(
      `UPDATE customer_attributes SET name=$1,description=$2,options=$3,ai_enabled=$4,guidance=$5,archived=$6
     WHERE workspace_id=$7 AND id=$8 AND version=$9 RETURNING ${fieldColumns}`,
      [
        value.name,
        value.description,
        JSON.stringify(value.options),
        value.ai_enabled,
        value.guidance,
        value.archived,
        ctx.workspaceId,
        id,
        version,
      ],
    )
  ).rows[0];
  if (!row) throw new ApiError(409, '属性配置已被修改，请刷新');
  return row;
}
export function validateValue(f: CompanyAttribute, input: unknown): AttributeValue {
  if (input === null) return null;
  if (f.kind === 'text') return z.string().trim().max(5000).parse(input) || null;
  if (f.kind === 'number') return z.number().finite().min(-1e15).max(1e15).parse(input);
  if (f.kind === 'select') {
    const v = z.string().parse(input);
    if (!f.options.includes(v)) throw new ApiError(400, '候选值不在属性选项中');
    return v;
  }
  const values = z.array(z.string()).max(40).parse(input);
  if (new Set(values).size !== values.length || values.some((v) => !f.options.includes(v)))
    throw new ApiError(400, '多选值重复或不在属性选项中');
  return values.length ? values : null;
}
export async function values(ctx: Context, customerId: string) {
  await service.customer(ctx, customerId);
  const rows = (
    await ctx.tx.query<CompanyAttributeValue>(
      `SELECT ${valueColumns} FROM customer_attribute_values WHERE workspace_id=$1 AND customer_id=$2 ORDER BY attribute_id`,
      [ctx.workspaceId, customerId],
    )
  ).rows;
  return visibleValues(ctx, rows);
}
async function visibleValues(ctx: Context, rows: CompanyAttributeValue[]) {
  const result: CompanyAttributeValue[] = [];
  for (const row of rows) {
    if (!row.sources.length) {
      result.push(row);
      continue;
    }
    const safe = await sanitizeAttributeSources(ctx, row.customer_id, row.sources);
    result.push({
      ...row,
      sources: safe.sources,
      sources_stale: safe.invalid,
      ...(safe.invalid
        ? { explanation: '部分原始依据已失效或不可见，请重新整理；已保留属性值。' }
        : {}),
    });
  }
  return result;
}
export async function batchValues(ctx: Context, input: unknown) {
  const { customer_ids } = z.strictObject({ customer_ids: z.array(uuid).max(30) }).parse(input);
  for (const id of customer_ids) await service.customer(ctx, id);
  const rows = (
    await ctx.tx.query<CompanyAttributeValue>(
      `SELECT ${valueColumns} FROM customer_attribute_values WHERE workspace_id=$1 AND customer_id=ANY($2::uuid[])`,
      [ctx.workspaceId, customer_ids],
    )
  ).rows;
  return visibleValues(ctx, rows);
}
async function editable(ctx: Context, customerId: string) {
  const customer = await service.customer(ctx, customerId, true);
  service.activeCustomer(customer);
  return customer;
}
async function writeValue(
  ctx: Context,
  customerId: string,
  f: CompanyAttribute,
  value: AttributeValue,
  version: number,
  ai?: { id: string; explanation: string; sources: AttributeSource[]; created_at: string },
) {
  const row = (
    await ctx.tx.query<CompanyAttributeValue>(
      `INSERT INTO customer_attribute_values(workspace_id,customer_id,attribute_id,id,value,origin,explanation,sources,generated_at,run_id)
     SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 WHERE $11=0 OR EXISTS(
      SELECT 1 FROM customer_attribute_values WHERE workspace_id=$1 AND customer_id=$2 AND attribute_id=$3 AND version=$11)
     ON CONFLICT(workspace_id,customer_id,attribute_id) DO UPDATE SET value=excluded.value,origin=excluded.origin,
      explanation=excluded.explanation,sources=excluded.sources,generated_at=excluded.generated_at,run_id=excluded.run_id
     WHERE customer_attribute_values.version=$11 RETURNING ${valueColumns}`,
      [
        ctx.workspaceId,
        customerId,
        f.id,
        randomUUID(),
        JSON.stringify(value),
        ai ? 'ai' : 'manual',
        ai?.explanation || '',
        JSON.stringify(ai?.sources || []),
        ai?.created_at || null,
        ai?.id || null,
        version,
      ],
    )
  ).rows[0];
  if (!row) throw new ApiError(409, '属性值已被修改，请刷新后核对');
  return row;
}
export async function saveValue(ctx: Context, customerId: string, id: string, input: unknown) {
  await editable(ctx, customerId);
  const v = z
    .strictObject({
      value: z.unknown(),
      version: z.number().int().min(0),
      attribute_version: z.number().int().positive(),
    })
    .parse(input);
  const f = await field(ctx, id, v.attribute_version);
  return writeValue(ctx, customerId, f, validateValue(f, v.value), v.version);
}

// All rows use the explicit server-resolved customer plus RLS. The model is never
// given a database handle, a retrieval tool, or an identifier for another customer.
export async function companyContext(
  ctx: Context,
  customerId: string,
  targetAttributeId?: string,
  retrieval?: AttributeRetrievalPlan,
) {
  const c = await editable(ctx, customerId);
  if (retrieval && retrieval.graph.scope.customer_id !== customerId)
    throw new ApiError(409, '检索客户范围已变化，请重新生成');
  const recalled = retrieval ? await attributeRetrievedSources(ctx, retrieval) : null;
  const sources: AttributeSource[] = [
    ...(recalled?.sources || []),
    {
      id: `company:${c.id}`,
      kind: 'company',
      title: c.name,
      body: JSON.stringify({
        name: c.name,
        type: c.type,
        status: c.status,
        region: c.region,
        contact_name: c.contact_name,
        email: c.email,
        phone: c.phone,
        version: c.version,
      }),
    },
  ];
  const warnings: string[] = [...(recalled?.warnings || [])];
  const specs = [
    {
      kind: 'record',
      table: 'customer_records',
      columns: 'id,kind,body,project_id,created_at',
      limit: 40,
      order: 'created_at DESC,id',
      label: '业务记录',
    },
    {
      kind: 'person',
      table: 'people',
      columns: 'id,name,job_title,email,phone,description,archived_at,version',
      limit: 25,
      order: 'id',
      label: '联系人',
    },
    {
      kind: 'project',
      table: 'projects',
      columns: 'id,name,type,stage,description,due_date,archived_at,version',
      limit: 25,
      order: 'id',
      label: '项目',
    },
  ] as const;
  for (const spec of specs) {
    const rows = (
      await ctx.tx.query<Record<string, unknown>>(
        `SELECT ${spec.columns},count(*) OVER()::int AS total FROM ${spec.table} WHERE workspace_id=$1 AND customer_id=$2 ORDER BY ${spec.order} LIMIT ${spec.limit}`,
        [ctx.workspaceId, customerId],
      )
    ).rows;
    if (Number(rows[0]?.total || 0) > spec.limit)
      warnings.push(
        `${spec.label}仅包含${spec.limit}条，共${rows[0].total}条，不能据此推断完整数量或遗漏事项`,
      );
    for (const row of rows) {
      const { total, ...data } = row;
      const title =
        spec.kind === 'record'
          ? `${recordKinds[data.kind as keyof typeof recordKinds]} · ${new Date(String(data.created_at)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`
          : String(data.name);
      let truncated = false;
      for (const k of ['body', 'description'])
        if (typeof data[k] === 'string' && data[k].length > 1600) {
          data[k] = data[k].slice(0, 1600) + '（内容截断）';
          truncated = true;
        }
      if (truncated) warnings.push(`${title}仅提供前1600字`);
      sources.push({
        id: `${spec.kind}:${data.id}`,
        kind: spec.kind,
        title,
        body: JSON.stringify(data),
      });
    }
  }
  const edges = (
    await ctx.tx.query<Record<string, unknown>>(
      `SELECT e.id,e.source_object,e.source_id,e.target_object,e.target_id,d.source_label,d.target_label,
       count(*) OVER()::int AS total
     FROM relationship_edges e JOIN relationship_definitions d ON d.workspace_id=e.workspace_id AND d.id=e.definition_id
     WHERE e.workspace_id=$1 AND e.customer_id=$2 ORDER BY e.id LIMIT 50`,
      [ctx.workspaceId, customerId],
    )
  ).rows;
  if (Number(edges[0]?.total || 0) > 50) warnings.push(`显式关联仅包含50条，共${edges[0].total}条`);
  for (const { total, ...e } of edges) {
    const prefix = (object: unknown) =>
      object === 'customers' ? 'company' : object === 'people' ? 'person' : 'project';
    e.source_name =
      sources.find((s) => s.id === `${prefix(e.source_object)}:${e.source_id}`)?.title ||
      '未包含的关联记录';
    e.target_name =
      sources.find((s) => s.id === `${prefix(e.target_object)}:${e.target_id}`)?.title ||
      '未包含的关联记录';
    sources.push({
      id: `relationship:${e.id}`,
      kind: 'relationship',
      title: String(e.source_label),
      body: JSON.stringify(e),
    });
  }
  const currentValues = await values(ctx, customerId);
  const definitions = await fields(ctx);
  for (const v of currentValues) {
    const definition = definitions.find((f) => f.id === v.attribute_id && !f.archived);
    if (
      definition &&
      v.attribute_id !== targetAttributeId &&
      v.value !== null &&
      v.origin === 'manual'
    )
      sources.push({
        id: `attribute:${v.attribute_id}`,
        kind: 'attribute',
        title: definition.name,
        body: JSON.stringify({ value: v.value, origin: v.origin, version: v.version }),
      });
  }
  let size = 0;
  for (const source of retrieval ? [] : await knowledgeAgentSources(ctx, customerId)) {
    if (source.ref?.kind === 'record')
      sources.push({
        id: `record:${source.ref.id}`,
        kind: 'record',
        title: source.title,
        body: source.body,
      });
    else warnings.push(source.body);
  }
  warnings.push(
    retrieval
      ? '按字段检索的原文和图谱优先，近期记录仅补充；所有索引共用Record来源，历史说法不等于当前公司确认。'
      : '沟通原文为近期窗口，不能据此断言全部历史没有相关信息。',
  );
  const first = new Map<string, AttributeSource>();
  for (const source of sources) if (!first.has(source.id)) first.set(source.id, source);
  const unique = [...first.values()];
  const included = unique.filter((s) => {
    size += s.body.length;
    return size <= 120000;
  });
  if (included.length !== unique.length) warnings.push('本次资料达到12万字符预算，尾部资料未包含');
  const schema = await entitySchema(ctx);
  const digest = createHash('sha256')
    .update(JSON.stringify({ schema, sources: included, warnings }))
    .digest('hex');
  return { schema, sources: included, warnings, digest, values: currentValues };
}
const runSelect =
  'id,customer_id,attribute_id,value,explanation,missing,sources,guidance,warnings,model,created_at,state';
type StoredRun = AttributeRun & {
  attribute_version: number;
  value_version: number;
  context_digest: string;
  retrieval_plan: AttributeRetrievalPlan | null;
};
export async function generate(
  db: Database,
  actorId: string,
  workspaceId: string,
  customerId: string,
  input: unknown,
  options: AttributeModelOptions,
) {
  const req = z
    .strictObject({
      attribute_id: uuid,
      attribute_version: z.number().int().positive(),
      guidance: z.string().trim().min(1).max(4000).optional(),
      use_saved_guidance: z.boolean().default(false),
      only_empty: z.boolean().default(false),
    })
    .refine((v) => v.use_saved_guidance || !!v.guidance, '请提供填充指令')
    .parse(input);
  const target = await scoped(db, actorId, workspaceId, async (ctx) => {
    const f = await field(ctx, req.attribute_id, req.attribute_version);
    await editable(ctx, customerId);
    if (!f.ai_enabled) throw new ApiError(409, '此属性尚未开启 AI 填充');
    const guidance = req.use_saved_guidance ? f.guidance : req.guidance!;
    if (!guidance.trim()) throw new ApiError(409, '此属性尚未保存 AI 填充指令');
    return { f, guidance };
  });
  const retrieval = await buildAttributeRetrieval(
    db,
    actorId,
    workspaceId,
    customerId,
    [target.f.name, target.f.description, target.guidance].filter(Boolean).join('\n'),
    options,
  );
  const prepared = await scoped(db, actorId, workspaceId, async (ctx) => {
    const f = await field(ctx, target.f.id, target.f.version);
    const context = await companyContext(ctx, customerId, f.id, retrieval);
    const current = context.values.find((v) => v.attribute_id === f.id);
    if (req.only_empty && !isEmptyAttributeValue(current?.value))
      throw new ApiError(409, '此属性已有值，已保留；如需替换请打开属性编辑');
    const transport = await prepareModel(ctx, customerId, options);
    return {
      f,
      context,
      transport,
      guidance: target.guidance,
      valueVersion: current?.version || 0,
    };
  });
  const raw = await prepared.transport.generate({
    schema: prepared.context.schema,
    field: prepared.f,
    guidance: prepared.guidance,
    sources: prepared.context.sources,
    warnings: prepared.context.warnings,
  });
  const result = groundAttributeResult(raw, prepared.context.sources);
  let candidate: AttributeValue;
  try {
    candidate = validateValue(prepared.f, result.value);
  } catch {
    throw new ApiError(502, '模型候选值不符合字段类型或选项，未保存');
  }
  return scoped(db, actorId, workspaceId, async (ctx) => {
    await field(ctx, prepared.f.id, prepared.f.version);
    const fresh = await companyContext(ctx, customerId, prepared.f.id, retrieval);
    const valueVersion = fresh.values.find((v) => v.attribute_id === prepared.f.id)?.version || 0;
    if (fresh.digest !== prepared.context.digest || valueVersion !== prepared.valueVersion)
      throw new ApiError(409, '生成期间公司资料已变化，请重新生成');
    const safe = await sanitizeAttributeSources(ctx, customerId, result.sources);
    if (safe.invalid) throw new ApiError(502, '模型未提供当前可核对的原文依据，未保存候选值');
    return (
      await ctx.tx.query<AttributeRun>(
        `INSERT INTO customer_attribute_runs(workspace_id,customer_id,attribute_id,actor_id,id,attribute_version,value_version,
       context_digest,guidance,value,explanation,missing,sources,warnings,model,retrieval_plan)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING ${runSelect}`,
        [
          workspaceId,
          customerId,
          prepared.f.id,
          actorId,
          randomUUID(),
          prepared.f.version,
          prepared.valueVersion,
          fresh.digest,
          prepared.guidance,
          JSON.stringify(candidate),
          result.explanation,
          JSON.stringify(result.missing),
          JSON.stringify(safe.sources),
          JSON.stringify(fresh.warnings),
          attributeModel,
          JSON.stringify(retrieval),
        ],
      )
    ).rows[0];
  });
}
export async function applyRun(ctx: Context, customerId: string, id: string) {
  await editable(ctx, customerId);
  const r = (
    await ctx.tx.query<StoredRun>(
      `SELECT * FROM customer_attribute_runs WHERE workspace_id=$1 AND customer_id=$2 AND id=$3 AND actor_id=$4 FOR UPDATE`,
      [ctx.workspaceId, customerId, id, ctx.actorId],
    )
  ).rows[0];
  if (!r) throw new ApiError(404, '候选结果不存在或无权访问');
  if (r.state === 'applied') {
    const existing = (
      await ctx.tx.query<CompanyAttributeValue>(
        `SELECT ${valueColumns} FROM customer_attribute_values WHERE workspace_id=$1 AND customer_id=$2 AND run_id=$3`,
        [ctx.workspaceId, customerId, r.id],
      )
    ).rows[0];
    if (!existing) throw new ApiError(409, '应用后属性值已再次修改，请刷新');
    return (await values(ctx, customerId)).find(
      (value) => value.attribute_id === existing.attribute_id,
    )!;
  }
  if (Date.now() - new Date(r.created_at).getTime() > 3600000)
    throw new ApiError(409, '候选结果已过期，请重新生成');
  const f = await field(ctx, r.attribute_id, r.attribute_version);
  if (!f.ai_enabled) throw new ApiError(409, 'AI 填充已关闭');
  const context = await companyContext(ctx, customerId, f.id, r.retrieval_plan || undefined);
  if (context.digest !== r.context_digest)
    throw new ApiError(409, '公司资料或属性值已变化，请重新生成后核对');
  const saved = await writeValue(ctx, customerId, f, validateValue(f, r.value), r.value_version, r);
  await ctx.tx.query(
    "UPDATE customer_attribute_runs SET state='applied' WHERE workspace_id=$1 AND id=$2",
    [ctx.workspaceId, id],
  );
  return saved;
}
export async function validateViewColumns(ctx: Context, object: string, columns: string[]) {
  const custom = columns.filter((k) => k.startsWith('attr:'));
  if (!custom.length) return;
  const available = await fields(ctx);
  if (
    object !== 'customers' ||
    custom.some((key) => !available.some((f) => !f.archived && attributeColumn(f.id) === key))
  )
    throw new ApiError(400, '视图包含不存在或已停用的公司属性');
}
