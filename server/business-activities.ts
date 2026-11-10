import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db.js';
import { ApiError, requireAdmin, scoped, type Context } from './security.js';
import * as service from './service.js';
import { person } from './people.js';
import { sourceMaterials } from './source-index.js';
import type { KnowledgeSource } from '../shared/knowledge.js';
import {
  activityBaseField as base,
  ordinaryActivityFieldKinds,
  type ActivityField,
  type ActivitySchema,
  type BusinessActivityType,
  type ActivitySource,
  type BusinessActivity,
  type ActivityDetail,
  type ActivityComment,
  type ActivityTask,
  type ActivityMember,
  type ActivityGenerationResult,
  type ActivityValue,
  type ActivityFieldProvenance,
} from '../shared/business-activities.js';
import {
  prepareActivityModel,
  activityOutputSchema,
  activityReviewSchema,
  validateActivityValue,
  activityProtocol,
  type ActivityModelInput,
  type ActivityModelOutput,
  type ActivityModelOptions,
} from './activity-model.js';
export type { ActivityModelOptions } from './activity-model.js';

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const uuid = z.uuid();
const ordinary = z.enum(ordinaryActivityFieldKinds);
const fieldInput = z.object({
  id: z.string().max(100).optional(),
  name: z.string().trim().min(1).max(80),
  kind: z.enum([...ordinaryActivityFieldKinds, 'record_reference', 'actor_reference']),
  options: z.array(z.string().trim().min(1).max(80)).max(40).default([]),
  required: z.boolean().default(false),
  ai_enabled: z.boolean().default(false),
  guidance: z.string().trim().max(4000).default(''),
  currency: z.enum(['CNY', 'USD', 'EUR', 'GBP', 'JPY']).optional(),
});
const fieldList = z.array(fieldInput).max(50);
const schemaInput = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000).default(''),
  parent_id: uuid.nullable().default(null),
  fields: fieldList.default([]),
  archived: z.boolean().default(false),
});
const typeInput = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000).default(''),
  schema_id: uuid,
  fields: fieldList.default([]),
  guidance: z.string().max(5000).default(''),
  archived: z.boolean().default(false),
});
const generationInput = z.strictObject({
  customer_id: uuid,
  project_id: uuid.nullable().default(null),
  type_id: uuid,
  source_ids: z.array(z.string().min(1).max(200)).min(1).max(60),
  linked_person_ids: z.array(uuid).max(30).default([]),
  handler_id: uuid.nullable().default(null),
  request_id: uuid,
});
type GenerationInput = z.infer<typeof generationInput>;
type SchemaRow = Omit<ActivitySchema, 'depth' | 'effective_fields'> & { workspace_id: string };
type TypeRow = Omit<BusinessActivityType, 'effective_fields' | 'schema_name'> & {
  workspace_id: string;
};
type ActivityRow = BusinessActivity & {
  workspace_id: string;
  run_id: string;
  source_versions: Record<string, string>;
};
type RunRow = {
  id: string;
  state: string;
  input_digest: string;
  config_digest: string;
  lease_token: string;
  snapshot: { config: BusinessActivityType; input: GenerationInput };
  error: string | null;
  lease_active?: boolean;
};
const defaultField = (
  id: string,
  name: string,
  kind: ActivityField['kind'],
  extra: Partial<ActivityField> = {},
): ActivityField => ({
  id,
  name,
  kind,
  options: [],
  required: false,
  ai_enabled: false,
  guidance: '',
  default_field: true,
  ...extra,
});
function defaults(): ActivityField[] {
  return [
    defaultField(base.title, '标题', 'text', {
      required: true,
      ai_enabled: true,
      guidance: '根据本次独立事件概括，不将客户要求写成公司确认。',
    }),
    defaultField(base.customer, '所属公司', 'record_reference', {
      required: true,
      read_only: true,
    }),
    defaultField(base.project, '关联项目', 'record_reference', { read_only: true }),
    defaultField(base.occurred, '发生时间', 'timestamp', {
      ai_enabled: true,
      guidance: '取本事件第一条原消息occurred_at；未知时留空，不取导入时间。',
    }),
    defaultField(base.handler, '经办人', 'actor_reference', { read_only: true }),
    defaultField(base.summary, '内容摘要', 'text', {
      ai_enabled: true,
      guidance: '按本次原文概括，保留否定、条件及发言方，不编造承诺。',
    }),
    defaultField('system:id', '活动编号', 'text', { system: true, read_only: true }),
    defaultField('system:created_at', '创建时间', 'timestamp', { system: true, read_only: true }),
    defaultField('system:created_by', '创建人', 'actor_reference', {
      system: true,
      read_only: true,
    }),
    defaultField('system:updated_at', '更新时间', 'timestamp', { system: true, read_only: true }),
  ];
}
function normalizeFields(
  input: z.infer<typeof fieldList>,
  old: ActivityField[] = [],
  root = false,
): ActivityField[] {
  const output: ActivityField[] = [];
  const original = new Map(old.map((f) => [f.id, f]));
  for (const value of input) {
    const prior = value.id ? original.get(value.id) : undefined;
    if (value.id && !prior) throw new ApiError(400, '新增属性请勿指定其他结构的属性ID');
    if (prior?.default_field) {
      if (prior.kind !== value.kind) throw new ApiError(400, '通用属性类型不能修改');
      if (prior.id === base.title && !value.ai_enabled)
        throw new ApiError(400, '活动标题用于识别每条活动，不能关闭AI生成');
      output.push({
        ...prior,
        name: value.name,
        ai_enabled: prior.read_only ? false : value.ai_enabled,
        guidance: value.guidance,
        required: prior.required,
      });
      continue;
    }
    ordinary.parse(value.kind);
    if (value.ai_enabled && !value.guidance) throw new ApiError(400, '开启AI的属性请填写整理指引');
    if (
      ['select', 'multi_select'].includes(value.kind) !== !!value.options.length ||
      new Set(value.options).size !== value.options.length
    )
      throw new ApiError(400, '选择属性需要不重复的选项');
    output.push({
      ...value,
      id: prior?.id || randomUUID(),
      currency: value.kind === 'currency' ? value.currency || 'CNY' : undefined,
    });
  }
  if (root) {
    for (const field of old.filter((f) => f.default_field))
      if (!output.some((f) => f.id === field.id)) output.unshift(field);
  }
  if (new Set(output.map((f) => f.name.toLowerCase())).size !== output.length)
    throw new ApiError(400, '属性名称不能重复');
  return output;
}
function validateEffective(fields: ActivityField[]) {
  if (fields.length > 50) throw new ApiError(400, '活动最多50个有效属性');
  if (
    new Set(fields.map((f) => f.id)).size !== fields.length ||
    new Set(fields.map((f) => f.name.toLowerCase())).size !== fields.length
  )
    throw new ApiError(400, '继承属性与本层属性重复');
}
async function schemaRow(ctx: Context, id: string) {
  const row = (
    await ctx.tx.query<SchemaRow>(
      'SELECT * FROM activity_schemas WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId, uuid.parse(id)],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, 'Schema不存在或无权访问');
  return row;
}
async function schemaView(ctx: Context, row: SchemaRow): Promise<ActivitySchema> {
  const own = row.fields.map((f) => ({
    ...f,
    source_schema_id: row.id,
    source_schema_name: row.name,
    inherited: false,
  }));
  const parent = row.parent_id ? await schemaRow(ctx, row.parent_id) : null;
  if (parent?.parent_id) throw new ApiError(409, 'Schema最多两层');
  const effective = [
    ...(parent
      ? parent.fields.map((f) => ({
          ...f,
          source_schema_id: parent.id,
          source_schema_name: parent.name,
          inherited: true,
        }))
      : []),
    ...own,
  ];
  validateEffective(effective);
  return { ...row, depth: parent ? 2 : 1, fields: own, effective_fields: effective };
}
export async function schemas(ctx: Context) {
  const rows = (
    await ctx.tx.query<SchemaRow>(
      'SELECT * FROM activity_schemas WHERE workspace_id=$1 ORDER BY created_at,id',
      [ctx.workspaceId],
    )
  ).rows;
  return Promise.all(rows.map((row) => schemaView(ctx, row)));
}
export async function createSchema(ctx: Context, raw: unknown) {
  requireAdmin(ctx);
  const value = schemaInput.parse(raw);
  let parent: SchemaRow | null = null;
  if (value.parent_id) {
    parent = await schemaRow(ctx, value.parent_id);
    if (parent.parent_id || parent.archived)
      throw new ApiError(400, '只能选择启用的一级Schema作为父结构');
  }
  const fields = parent
    ? normalizeFields(value.fields)
    : [...defaults(), ...normalizeFields(value.fields)];
  validateEffective([...(parent?.fields || []), ...fields]);
  const row = (
    await ctx.tx.query<SchemaRow>(
      'INSERT INTO activity_schemas(workspace_id,id,name,description,parent_id,fields,archived) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [
        ctx.workspaceId,
        randomUUID(),
        value.name,
        value.description,
        value.parent_id,
        JSON.stringify(fields),
        value.archived,
      ],
    )
  ).rows[0];
  return schemaView(ctx, row);
}
export async function updateSchema(ctx: Context, id: string, raw: unknown) {
  requireAdmin(ctx);
  const prior = await schemaRow(ctx, id);
  const parsed = z.object({ version: z.number().int().positive() }).passthrough().parse(raw);
  const { version, ...patch } = parsed;
  const value = schemaInput.parse({
    name: prior.name,
    description: prior.description,
    parent_id: prior.parent_id,
    fields: prior.fields,
    archived: prior.archived,
    ...patch,
  });
  // Parse a deliberately limited shape, never pass server metadata through to SQL.
  if (value.parent_id !== prior.parent_id)
    throw new ApiError(400, '已有Schema请复制后选择新父结构');
  const fields = normalizeFields(value.fields, prior.fields, !prior.parent_id);
  const parent = prior.parent_id ? await schemaRow(ctx, prior.parent_id) : null;
  validateEffective([...(parent?.fields || []), ...fields]);
  const children = (
    await ctx.tx.query<SchemaRow>(
      'SELECT * FROM activity_schemas WHERE workspace_id=$1 AND parent_id=$2',
      [ctx.workspaceId, id],
    )
  ).rows;
  for (const child of children) validateEffective([...fields, ...child.fields]);
  const dependentTypes = (
    await ctx.tx.query<TypeRow>(
      'SELECT * FROM activity_types WHERE workspace_id=$1 AND schema_id=ANY($2::uuid[])',
      [ctx.workspaceId, [id, ...children.map((child) => child.id)]],
    )
  ).rows;
  for (const dependent of dependentTypes) {
    const future =
      dependent.schema_id === id
        ? [...(parent?.fields || []), ...fields]
        : [...fields, ...children.find((child) => child.id === dependent.schema_id)!.fields];
    validateEffective([...future, ...dependent.fields]);
  }
  const row = (
    await ctx.tx.query<SchemaRow>(
      'UPDATE activity_schemas SET name=$3,description=$4,fields=$5,archived=$6 WHERE workspace_id=$1 AND id=$2 AND version=$7 RETURNING *',
      [
        ctx.workspaceId,
        id,
        value.name,
        value.description,
        JSON.stringify(fields),
        value.archived,
        version,
      ],
    )
  ).rows[0];
  if (!row) throw new ApiError(409, 'Schema已修改，请刷新');
  return schemaView(ctx, row);
}
async function typeRow(ctx: Context, id: string) {
  const row = (
    await ctx.tx.query<TypeRow>('SELECT * FROM activity_types WHERE workspace_id=$1 AND id=$2', [
      ctx.workspaceId,
      uuid.parse(id),
    ])
  ).rows[0];
  if (!row) throw new ApiError(404, '活动类型不存在或无权访问');
  return row;
}
async function typeView(ctx: Context, row: TypeRow): Promise<BusinessActivityType> {
  const rawSchema = await schemaRow(ctx, row.schema_id);
  const rawParent = rawSchema.parent_id ? await schemaRow(ctx, rawSchema.parent_id) : null;
  const schema = await schemaView(ctx, rawSchema);
  const effective = [
    ...schema.effective_fields.map((f) => ({ ...f, inherited: true })),
    ...row.fields.map((f) => ({ ...f, inherited: false })),
  ];
  validateEffective(effective);
  return {
    ...row,
    effective_fields: effective,
    schema_name: schema.name,
    schema_revision: digest([rawSchema, rawParent]),
  };
}
export async function types(ctx: Context) {
  return Promise.all(
    (
      await ctx.tx.query<TypeRow>(
        'SELECT * FROM activity_types WHERE workspace_id=$1 ORDER BY created_at,id',
        [ctx.workspaceId],
      )
    ).rows.map((row) => typeView(ctx, row)),
  );
}
export async function createType(ctx: Context, raw: unknown) {
  requireAdmin(ctx);
  const value = typeInput.parse(raw);
  const schema = await schemaView(ctx, await schemaRow(ctx, value.schema_id));
  if (schema.archived) throw new ApiError(400, 'Schema已停用');
  const fields = normalizeFields(value.fields);
  validateEffective([...schema.effective_fields, ...fields]);
  const row = (
    await ctx.tx.query<TypeRow>(
      'INSERT INTO activity_types(workspace_id,id,name,description,schema_id,fields,guidance,archived) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [
        ctx.workspaceId,
        randomUUID(),
        value.name,
        value.description,
        value.schema_id,
        JSON.stringify(fields),
        value.guidance,
        value.archived,
      ],
    )
  ).rows[0];
  return typeView(ctx, row);
}
export async function updateType(ctx: Context, id: string, raw: unknown) {
  requireAdmin(ctx);
  const prior = await typeRow(ctx, id);
  const patch = z.object({ version: z.number().int().positive() }).passthrough().parse(raw);
  const value = typeInput.parse({
    name: prior.name,
    description: prior.description,
    schema_id: prior.schema_id,
    fields: prior.fields,
    guidance: prior.guidance,
    archived: prior.archived,
    ...Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'version')),
  });
  if (value.schema_id !== prior.schema_id)
    throw new ApiError(400, '已有活动类型请复制后选择新Schema');
  const schema = await schemaView(ctx, await schemaRow(ctx, value.schema_id));
  const fields = normalizeFields(value.fields, prior.fields);
  validateEffective([...schema.effective_fields, ...fields]);
  const row = (
    await ctx.tx.query<TypeRow>(
      'UPDATE activity_types SET name=$3,description=$4,fields=$5,guidance=$6,archived=$7 WHERE workspace_id=$1 AND id=$2 AND version=$8 RETURNING *',
      [
        ctx.workspaceId,
        id,
        value.name,
        value.description,
        JSON.stringify(fields),
        value.guidance,
        value.archived,
        patch.version,
      ],
    )
  ).rows[0];
  if (!row) throw new ApiError(409, '活动类型已修改，请刷新');
  return typeView(ctx, row);
}

const sourceQuery = z.strictObject({
  customer_id: uuid,
  project_id: uuid.optional(),
  person_id: uuid.optional(),
  channel: z.enum(['email', 'wechat']).optional(),
  wechat_query_id: uuid.optional(),
  mail_id: uuid.optional(),
});
async function scope(ctx: Context, customerId: string, projectId?: string | null, write = false) {
  const customer = await service.customer(ctx, customerId, write);
  if (write) service.activeCustomer(customer);
  if (projectId) {
    const project = await service.project(ctx, customerId, projectId);
    if (write && project.archived_at) throw new ApiError(409, '项目已归档');
  }
  return customer;
}
async function contacts(ctx: Context, customerId: string, ids: string[]) {
  for (const id of ids) {
    const p = await person(ctx, id, customerId);
    if (p.archived_at) throw new ApiError(409, '联系人已归档');
  }
}
function sourceVersion(s: KnowledgeSource) {
  return digest({
    id: s.id,
    record_id: s.record_id,
    body: s.body,
    occurred_at: s.occurred_at,
    project_id: s.project_id,
    person_ids: s.person_ids,
    speaker: s.speaker,
    speaker_side: s.speaker_side,
    channel: s.channel,
    trust: s.trust,
  });
}
function sourceResult(s: KnowledgeSource): ActivitySource {
  return {
    id: s.id,
    record_id: s.record_id,
    channel: s.channel,
    title: s.title,
    body: s.body,
    occurred_at: s.occurred_at,
    person_ids: s.person_ids,
    project_id: s.project_id,
    speaker: s.speaker,
    speaker_side: s.speaker_side,
  };
}
export async function sources(ctx: Context, raw: unknown) {
  const q = sourceQuery.parse(raw);
  await scope(ctx, q.customer_id, q.project_id);
  if (q.person_id) await person(ctx, q.person_id, q.customer_id);
  if (q.wechat_query_id && q.mail_id) throw new ApiError(400, '请只选择一种来源入口');
  let recordIds: Set<string> | null = null;
  if (q.wechat_query_id) {
    const query = (
      await ctx.tx.query<{ customer_id: string | null; state: string }>(
        'SELECT customer_id,state FROM wechat_queries WHERE workspace_id=$1 AND actor_id=$2 AND id=$3',
        [ctx.workspaceId, ctx.actorId, q.wechat_query_id],
      )
    ).rows[0];
    if (!query || query.customer_id !== q.customer_id)
      throw new ApiError(404, '微信批次不存在或不属于当前公司');
    if (query.state !== 'associated') throw new ApiError(409, '请先确认微信批次归属');
    recordIds = new Set(
      (
        await ctx.tx.query<{ record_id: string }>(
          'SELECT record_id FROM wechat_query_records WHERE workspace_id=$1 AND query_id=$2 AND customer_id=$3',
          [ctx.workspaceId, q.wechat_query_id, q.customer_id],
        )
      ).rows.map((row) => row.record_id),
    );
  }
  if (q.mail_id)
    recordIds = new Set(
      (
        await ctx.tx.query<{ id: string }>(
          'SELECT id FROM customer_records WHERE workspace_id=$1 AND customer_id=$2 AND source_mail_id=$3',
          [ctx.workspaceId, q.customer_id, q.mail_id],
        )
      ).rows.map((row) => row.id),
    );
  const usage = new Map(
    (
      await ctx.tx.query<{ source_id: string; count: number }>(
        'SELECT e.source_id,count(DISTINCT e.activity_id)::int AS count FROM activity_evidence e JOIN business_activities a ON a.workspace_id=e.workspace_id AND a.id=e.activity_id WHERE e.workspace_id=$1 AND e.customer_id=$2 AND NOT a.archived GROUP BY e.source_id',
        [ctx.workspaceId, q.customer_id],
      )
    ).rows.map((row) => [row.source_id, Number(row.count)]),
  );
  const matched = (await sourceMaterials(ctx, q.customer_id)).filter(
    (s) =>
      ['email', 'wechat'].includes(s.channel) &&
      (!q.channel || s.channel === q.channel) &&
      (!q.project_id || !s.project_id || s.project_id === q.project_id) &&
      (!q.person_id || s.person_ids.includes(q.person_id)) &&
      (!recordIds || recordIds.has(s.record_id)),
  );
  return (q.wechat_query_id || q.mail_id ? matched : matched.slice(-200))
    .reverse()
    .map((source) => ({ ...sourceResult(source), activity_count: usage.get(source.id) || 0 }));
}
async function rawActivity(ctx: Context, id: string) {
  const row = (
    await ctx.tx.query<ActivityRow>(
      'SELECT * FROM business_activities WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId, uuid.parse(id)],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, '活动不存在或无权访问');
  return row;
}
function currentActivitySources(
  row: Pick<ActivityRow, 'source_versions'>,
  materials: KnowledgeSource[],
) {
  const map = new Map(materials.map((source) => [source.id, source]));
  if (
    Object.entries(row.source_versions).some(
      ([id, version]) => !map.has(id) || sourceVersion(map.get(id)!) !== version,
    )
  )
    throw new ApiError(404, '活动来源已失效或变化，请重新整理');
  return map;
}

/** Read-only analysis adapter. Callers load sourceMaterials once per customer;
 * the same source-version contract is also used by the normal activity detail.
 * Only opaque identities leave this helper, never source bodies or quotations. */
export function activityAnalysisSources(
  row: Pick<ActivityRow, 'source_versions' | 'field_provenance'>,
  materials: KnowledgeSource[],
  fieldIds: string[],
) {
  const map = currentActivitySources(row, materials);
  const sources = new Set(Object.keys(row.source_versions));
  const evidence = new Set<string>();
  for (const fieldId of fieldIds) {
    const provenance = row.field_provenance[fieldId];
    if (!provenance) continue;
    if (provenance.record_id && !materials.some((s) => s.record_id === provenance.record_id))
      throw new ApiError(404, '活动字段来源已失效或变化，请重新整理');
    for (const quote of provenance.evidence) {
      const source = map.get(quote.source_id);
      if (
        !source ||
        source.record_id !== quote.record_id ||
        !quote.quote ||
        !Number.isInteger(quote.char_start) ||
        !Number.isInteger(quote.char_end) ||
        quote.char_start < 0 ||
        quote.char_end <= quote.char_start ||
        quote.char_end > source.body.length ||
        (provenance.origin === 'manual' &&
          provenance.record_id === quote.record_id &&
          (quote.char_start !== 0 ||
            quote.char_end !== source.body.length ||
            quote.quote !== source.body)) ||
        source.body.slice(quote.char_start, quote.char_end) !== quote.quote
      )
        throw new ApiError(404, '活动字段来源已失效或变化，请重新整理');
      sources.add(source.id);
      evidence.add(
        digest([source.id, sourceVersion(source), quote.char_start, quote.char_end, quote.quote]),
      );
    }
  }
  return {
    source_keys: [...sources].sort().map((id) => digest([id, sourceVersion(map.get(id)!)])),
    evidence_key: evidence.size ? digest([...evidence].sort()) : null,
  };
}

async function readable(
  ctx: Context,
  row: ActivityRow,
  materials?: KnowledgeSource[],
): Promise<BusinessActivity> {
  const all = materials || (await sourceMaterials(ctx, row.customer_id));
  activityAnalysisSources(row, all, Object.keys(row.field_provenance));
  const linked = (
    await ctx.tx.query<{ person_id: string }>(
      'SELECT person_id FROM activity_people WHERE workspace_id=$1 AND activity_id=$2 ORDER BY person_id',
      [ctx.workspaceId, row.id],
    )
  ).rows.map((r) => r.person_id);
  const provenance: Record<string, ActivityFieldProvenance> = {};
  for (const [id, p] of Object.entries(row.field_provenance)) {
    provenance[id] = {
      ...p,
      evidence: p.evidence,
    };
  }
  const { workspace_id: _, run_id: __, source_versions: ___, ...safe } = row;
  return { ...safe, linked_person_ids: linked, field_provenance: provenance };
}
const browseQuery = z.strictObject({
  customer_id: uuid,
  project_id: uuid.optional(),
  person_id: uuid.optional(),
  type_id: uuid.optional(),
  handler_id: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(200).optional(),
  archived: z.enum(['true', 'false']).default('false'),
});
export async function browse(ctx: Context, raw: unknown) {
  const q = browseQuery.parse(raw);
  await scope(ctx, q.customer_id, q.project_id);
  if (q.person_id) await person(ctx, q.person_id, q.customer_id);
  const params: unknown[] = [ctx.workspaceId, q.customer_id, q.archived === 'true'];
  let where = 'a.workspace_id=$1 AND a.customer_id=$2 AND a.archived=$3';
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where += ` AND ${sql.replace('?', `$${params.length}`)}`;
  };
  if (q.project_id) add('a.project_id=?', q.project_id);
  if (q.type_id) add('a.type_id=?', q.type_id);
  if (q.handler_id) add('a.handler_id=?', q.handler_id);
  if (q.person_id)
    add(
      'EXISTS(SELECT 1 FROM activity_people p WHERE p.workspace_id=a.workspace_id AND p.customer_id=a.customer_id AND p.activity_id=a.id AND p.person_id=?)',
      q.person_id,
    );
  if (q.cursor) {
    let c: { created_at: string; id: string };
    try {
      c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString());
      z.iso.datetime({ offset: true }).parse(c.created_at);
      uuid.parse(c.id);
    } catch {
      throw new ApiError(400, '分页位置无效');
    }
    params.push(c.created_at, c.id);
    where += ` AND (a.created_at,a.id)<($${params.length - 1}::timestamptz,$${params.length}::uuid)`;
  }
  params.push(q.limit + 1);
  const rows = (
    await ctx.tx.query<ActivityRow>(
      `SELECT a.* FROM business_activities a WHERE ${where} ORDER BY a.created_at DESC,a.id DESC LIMIT $${params.length}`,
      params,
    )
  ).rows;
  const all = await sourceMaterials(ctx, q.customer_id),
    items: BusinessActivity[] = [];
  for (const row of rows.slice(0, q.limit)) {
    try {
      items.push(await readable(ctx, row, all));
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }
  const last = rows[q.limit - 1];
  return {
    items,
    next_cursor:
      rows.length > q.limit && last
        ? Buffer.from(
            JSON.stringify({ created_at: new Date(last.created_at).toISOString(), id: last.id }),
          ).toString('base64url')
        : null,
  };
}
export async function detail(ctx: Context, id: string, raw: unknown = {}): Promise<ActivityDetail> {
  const q = z.strictObject({ person_id: uuid.optional(), project_id: uuid.optional() }).parse(raw);
  const row = await rawActivity(ctx, id);
  const currentCustomer = await scope(ctx, row.customer_id, q.project_id);
  const currentProject = row.project_id
    ? await service.project(ctx, row.customer_id, row.project_id)
    : null;
  if (q.project_id && row.project_id !== q.project_id)
    throw new ApiError(404, '活动不属于当前项目');
  if (q.person_id) {
    await person(ctx, q.person_id, row.customer_id);
    if (
      !(
        await ctx.tx.query(
          'SELECT 1 FROM activity_people WHERE workspace_id=$1 AND activity_id=$2 AND person_id=$3',
          [ctx.workspaceId, id, q.person_id],
        )
      ).rows.length
    )
      throw new ApiError(404, '活动未关联当前联系人');
  }
  const all = await sourceMaterials(ctx, row.customer_id),
    activity = await readable(ctx, row, all);
  const evidence = (
    await ctx.tx.query<{ record_id: string }>(
      'SELECT DISTINCT record_id FROM activity_evidence WHERE workspace_id=$1 AND activity_id=$2',
      [ctx.workspaceId, id],
    )
  ).rows;
  const records = new Set(evidence.map((e) => e.record_id));
  for (const source of (
    await ctx.tx.query<{ record_id: string }>(
      'SELECT record_id FROM activity_record_sources WHERE workspace_id=$1 AND activity_id=$2',
      [ctx.workspaceId, id],
    )
  ).rows)
    records.add(source.record_id);
  for (const p of Object.values(activity.field_provenance))
    if (p.record_id) records.add(p.record_id);
  const relatedTasks = (
    await ctx.tx.query<ActivityTask>(
      "SELECT *,to_char(due_date,'YYYY-MM-DD') AS due_date FROM activity_tasks WHERE workspace_id=$1 AND activity_id=$2 ORDER BY created_at,id",
      [ctx.workspaceId, id],
    )
  ).rows;
  for (const task of relatedTasks) if (task.result_record_id) records.add(task.result_record_id);
  return {
    ...activity,
    can_edit: Boolean(
      currentCustomer.can_edit &&
      !currentCustomer.archived_at &&
      !currentProject?.archived_at &&
      !row.archived,
    ),
    comments: (
      await ctx.tx.query<ActivityComment>(
        'SELECT id,activity_id,body,created_by,created_at FROM activity_comments WHERE workspace_id=$1 AND activity_id=$2 ORDER BY created_at,id',
        [ctx.workspaceId, id],
      )
    ).rows,
    tasks: relatedTasks,
    sources: all.filter((s) => records.has(s.record_id)).map(sourceResult),
  };
}
export async function members(ctx: Context, customerId: string): Promise<ActivityMember[]> {
  await scope(ctx, uuid.parse(customerId));
  return (
    await ctx.tx.query<ActivityMember>(
      'SELECT actor_id,display_name,crm_activity_member_access($1,$2,actor_id) AS can_assign FROM workspace_people WHERE workspace_id=$1 AND active ORDER BY display_name,actor_id',
      [ctx.workspaceId, customerId],
    )
  ).rows.filter((m) => m.can_assign);
}

export interface PreparedGeneration {
  run_id: string;
  lease_token: string;
  workspace_id: string;
  actor_id: string;
  input: GenerationInput;
  input_digest: string;
  config_digest: string;
  config: BusinessActivityType;
  sources: KnowledgeSource[];
  transport: Awaited<ReturnType<typeof prepareActivityModel>>;
  completed?: ActivityGenerationResult;
}
export async function prepareGeneration(
  ctx: Context,
  raw: unknown,
  options: ActivityModelOptions = {},
): Promise<PreparedGeneration> {
  const input = generationInput.parse(raw);
  if (new Set(input.source_ids).size !== input.source_ids.length)
    throw new ApiError(400, '来源不能重复');
  input.source_ids.sort();
  input.linked_person_ids = [...new Set(input.linked_person_ids)].sort();
  await scope(ctx, input.customer_id, input.project_id, true);
  await contacts(ctx, input.customer_id, input.linked_person_ids);
  if (
    input.handler_id &&
    !(await members(ctx, input.customer_id)).some((m) => m.actor_id === input.handler_id)
  )
    throw new ApiError(400, '经办人无此客户访问权限');
  const type = await typeView(ctx, await typeRow(ctx, input.type_id));
  const schema = await schemaRow(ctx, type.schema_id);
  if (
    type.archived ||
    schema.archived ||
    (schema.parent_id && (await schemaRow(ctx, schema.parent_id)).archived)
  )
    throw new ApiError(409, '活动类型或Schema已停用');
  const all = await sourceMaterials(ctx, input.customer_id),
    map = new Map(all.map((s) => [s.id, s]));
  const selected = input.source_ids.map((id) => map.get(id));
  if (
    selected.some(
      (s) =>
        !s ||
        !['wechat', 'email'].includes(s.channel) ||
        (input.project_id && s.project_id && s.project_id !== input.project_id),
    )
  )
    throw new ApiError(404, '来源不存在、不属于当前范围或已失效');
  const chosen = (selected as KnowledgeSource[]).sort(
    (a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.id.localeCompare(b.id),
  );
  if (chosen.reduce((n, s) => n + s.body.length, 0) > 60000)
    throw new ApiError(413, '本次来源文字超过60000字符，请分批整理');
  const configDigest = digest(type),
    inputDigest = digest({
      input: { ...input, request_id: undefined },
      sources: chosen.map(sourceVersion),
    });
  await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `activity:${ctx.workspaceId}:${ctx.actorId}:${input.request_id}`,
  ]);
  await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `activity-sources:${ctx.workspaceId}:${ctx.actorId}:${inputDigest}:${configDigest}`,
  ]);
  const existing = (
    await ctx.tx.query<RunRow>(
      "SELECT *,updated_at>now()-interval '10 minutes' AS lease_active FROM activity_runs WHERE workspace_id=$1 AND actor_id=$2 AND (request_id=$3 OR (customer_id=$4 AND type_id=$5 AND input_digest=$6 AND config_digest=$7)) ORDER BY (request_id=$3) DESC LIMIT 1 FOR UPDATE",
      [
        ctx.workspaceId,
        ctx.actorId,
        input.request_id,
        input.customer_id,
        input.type_id,
        inputDigest,
        configDigest,
      ],
    )
  ).rows[0];
  const lease = randomUUID(),
    runId = existing?.id || randomUUID();
  const transport = await prepareActivityModel(ctx, input.customer_id, options);
  const prepared: PreparedGeneration = {
    run_id: runId,
    lease_token: lease,
    workspace_id: ctx.workspaceId,
    actor_id: ctx.actorId,
    input,
    input_digest: inputDigest,
    config_digest: configDigest,
    config: type,
    sources: chosen,
    transport,
  };
  if (existing) {
    if (existing.input_digest !== inputDigest || existing.config_digest !== configDigest)
      throw new ApiError(409, '同一请求的来源或配置已变化，请新建整理请求');
    if (existing.state === 'completed') {
      const rows = (
        await ctx.tx.query<ActivityRow>(
          'SELECT * FROM business_activities WHERE workspace_id=$1 AND run_id=$2 ORDER BY created_at,id',
          [ctx.workspaceId, runId],
        )
      ).rows;
      prepared.completed = {
        run_id: runId,
        state: 'completed',
        activities: await Promise.all(rows.map((row) => readable(ctx, row, all))),
        reused: true,
      };
      return prepared;
    }
    if (existing.state === 'running' && existing.lease_active)
      throw new ApiError(409, '本次活动正在整理，请稍后刷新');
    await ctx.tx.query(
      "UPDATE activity_runs SET state='running',lease_token=$3,error=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2",
      [ctx.workspaceId, runId, lease],
    );
  } else
    await ctx.tx.query(
      "INSERT INTO activity_runs(workspace_id,customer_id,id,actor_id,request_id,input_digest,config_digest,type_id,state,lease_token,source_ids,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,$10,$11)",
      [
        ctx.workspaceId,
        input.customer_id,
        runId,
        ctx.actorId,
        input.request_id,
        inputDigest,
        configDigest,
        input.type_id,
        lease,
        JSON.stringify(input.source_ids),
        JSON.stringify({ config: type, input }),
      ],
    );
  return prepared;
}
function validateModelOutput(raw: unknown, prepared: PreparedGeneration): ActivityModelOutput {
  const output = activityOutputSchema.parse(raw),
    fields = prepared.config.effective_fields.filter((f) => f.ai_enabled && !f.read_only),
    aliases = new Map(prepared.sources.map((s, i) => [`S${i + 1}`, s]));
  if (new Set(output.events.map((e) => e.event_id)).size !== output.events.length)
    throw new ApiError(422, 'AI事件编号重复');
  for (const event of output.events) {
    if (
      new Set(event.source_ids).size !== event.source_ids.length ||
      event.source_ids.some((id) => !aliases.has(id))
    )
      throw new ApiError(422, 'AI引用了范围外来源');
    if (
      event.fields.length !== fields.length ||
      new Set(event.fields.map((f) => f.field_id)).size !== fields.length
    )
      throw new ApiError(422, 'AI属性缺失或重复');
    for (const cell of event.fields) {
      const field = fields.find((f) => f.id === cell.field_id);
      if (!field) throw new ApiError(422, 'AI填写了未知属性');
      validateActivityValue(field, cell.value);
      if (cell.value === null) {
        if (cell.evidence.length) throw new ApiError(422, '空属性不应伪造证据');
      } else if (!cell.evidence.length) throw new ApiError(422, 'AI属性缺少原文证据');
      for (const quote of cell.evidence) {
        const source = aliases.get(quote.source_id);
        if (
          !source ||
          !event.source_ids.includes(quote.source_id) ||
          !source.body.includes(quote.quote)
        )
          throw new ApiError(422, 'AI引用不在本次原文中');
      }
      if (field.id === base.occurred && cell.value !== null) {
        const first = event.source_ids
          .map((id) => aliases.get(id)!)
          .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))[0];
        if (Date.parse(String(cell.value)) !== Date.parse(first.occurred_at))
          throw new ApiError(422, '发生时间不匹配原消息');
      }
    }
    if (!event.fields.find((f) => f.field_id === base.title)?.value)
      throw new ApiError(422, 'AI未识别活动标题，请重试或调整指引');
  }
  return output;
}
export async function executeGeneration(prepared: PreparedGeneration) {
  if (prepared.completed) return { events: [] } as ActivityModelOutput;
  const input: ActivityModelInput = {
    mode: 'extract',
    type: { name: prepared.config.name, guidance: prepared.config.guidance },
    fields: prepared.config.effective_fields.filter((f) => f.ai_enabled && !f.read_only),
    sources: prepared.sources.map((s, i) => ({
      id: `S${i + 1}`,
      body: s.body,
      speaker: s.speaker,
      speaker_side: s.speaker_side,
      occurred_at: s.occurred_at,
    })),
  };
  let output: ActivityModelOutput;
  try {
    output = validateModelOutput(await prepared.transport.generate(input), prepared);
    const review = activityReviewSchema.parse(
      await prepared.transport.generate({ ...input, mode: 'verify', candidate: output }),
    );
    if (
      review.events.length !== output.events.length ||
      new Set(review.events.map((e) => e.event_id)).size !== output.events.length
    )
      throw new ApiError(422, 'AI语义核对结果不完整');
    for (const event of output.events) {
      const checked = review.events.find((e) => e.event_id === event.event_id);
      if (
        !checked?.supported ||
        checked.fields.length !== event.fields.length ||
        new Set(checked.fields.map((f) => f.field_id)).size !== event.fields.length ||
        event.fields.some(
          (f) => !checked.fields.some((v) => v.field_id === f.field_id && v.supported),
        )
      )
        throw new ApiError(422, '活动字段语义核对未通过，请核对原文或调整指引后重试');
    }
    return output;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, '活动AI抽取或核对失败，请重试');
  }
}
export async function finishGeneration(
  ctx: Context,
  prepared: PreparedGeneration,
  output: ActivityModelOutput,
): Promise<ActivityGenerationResult> {
  if (ctx.workspaceId !== prepared.workspace_id || ctx.actorId !== prepared.actor_id)
    throw new ApiError(403, '整理身份已变化');
  if (prepared.completed) return prepared.completed;
  const input = prepared.input;
  // Freeze the short final write against concurrent ACL, configuration and source
  // changes. The expensive model calls have already completed outside this tx.
  const recordIds = [...new Set(prepared.sources.map((source) => source.record_id))];
  await ctx.tx.query('SELECT crm_activity_lock_sources($1,$2,$3::uuid[],$4)', [
    ctx.workspaceId,
    input.customer_id,
    recordIds,
    input.type_id,
  ]);
  await scope(ctx, input.customer_id, input.project_id, true);
  await contacts(ctx, input.customer_id, input.linked_person_ids);
  const current = await typeView(ctx, await typeRow(ctx, input.type_id));
  if (digest(current) !== prepared.config_digest) throw new ApiError(409, '配置已变化，请重新整理');
  const live = new Map((await sourceMaterials(ctx, input.customer_id)).map((s) => [s.id, s]));
  if (
    prepared.sources.some(
      (s) => !live.has(s.id) || sourceVersion(live.get(s.id)!) !== sourceVersion(s),
    )
  )
    throw new ApiError(409, '来源已变化或权限已失效，请重新整理');
  const run = (
    await ctx.tx.query<RunRow>(
      'SELECT * FROM activity_runs WHERE workspace_id=$1 AND customer_id=$2 AND id=$3 FOR UPDATE',
      [ctx.workspaceId, input.customer_id, prepared.run_id],
    )
  ).rows[0];
  if (!run || run.state !== 'running' || run.lease_token !== prepared.lease_token)
    throw new ApiError(409, '整理任务已完成或失效');
  validateModelOutput(output, prepared);
  const now = new Date().toISOString(),
    created: BusinessActivity[] = [];
  for (const event of output.events) {
    const id = randomUUID(),
      values: Record<string, ActivityValue> = {},
      provenance: Record<string, ActivityFieldProvenance> = {};
    for (const field of prepared.config.effective_fields) {
      values[field.id] = null;
      provenance[field.id] = {
        origin: field.read_only ? 'system' : field.ai_enabled ? 'ai' : 'manual',
        updated_at: now,
        evidence: [],
      };
    }
    for (const cell of event.fields) {
      values[cell.field_id] = cell.value;
      provenance[cell.field_id] = {
        origin: 'ai',
        updated_at: now,
        evidence: cell.evidence.map((q) => {
          const source = prepared.sources[Number(q.source_id.slice(1)) - 1],
            start = source.body.indexOf(q.quote);
          return {
            source_id: source.id,
            record_id: source.record_id,
            quote: q.quote,
            char_start: start,
            char_end: start + q.quote.length,
          };
        }),
      };
    }
    values[base.customer] = input.customer_id;
    values[base.project] = input.project_id;
    values[base.handler] = input.handler_id;
    values['system:id'] = id;
    values['system:created_at'] = now;
    values['system:updated_at'] = now;
    values['system:created_by'] = ctx.actorId;
    const aiValues = Object.fromEntries(event.fields.map((cell) => [cell.field_id, cell.value])),
      missing = prepared.config.effective_fields
        .filter((f) => f.required && (values[f.id] === null || values[f.id] === ''))
        .map((f) => f.id),
      sourceVersions = Object.fromEntries(
        event.source_ids.map((alias) => {
          const source = prepared.sources[Number(alias.slice(1)) - 1];
          return [source.id, sourceVersion(source)];
        }),
      );
    const row = (
      await ctx.tx.query<ActivityRow>(
        'INSERT INTO business_activities(workspace_id,customer_id,id,project_id,type_id,run_id,event_key,type_name,title,summary,occurred_at,handler_id,fields,values,ai_values,field_provenance,source_versions,missing_required_fields,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *',
        [
          ctx.workspaceId,
          input.customer_id,
          id,
          input.project_id,
          input.type_id,
          prepared.run_id,
          event.event_id,
          current.name,
          values[base.title],
          values[base.summary],
          values[base.occurred],
          input.handler_id,
          JSON.stringify(current.effective_fields),
          JSON.stringify(values),
          JSON.stringify(aiValues),
          JSON.stringify(provenance),
          JSON.stringify(sourceVersions),
          JSON.stringify(missing),
          ctx.actorId,
        ],
      )
    ).rows[0];
    for (const personId of input.linked_person_ids)
      await ctx.tx.query(
        'INSERT INTO activity_people(workspace_id,customer_id,activity_id,person_id) VALUES($1,$2,$3,$4)',
        [ctx.workspaceId, input.customer_id, id, personId],
      );
    for (const [fieldId, p] of Object.entries(provenance))
      for (const e of p.evidence)
        await ctx.tx.query(
          'INSERT INTO activity_evidence(workspace_id,customer_id,activity_id,source_id,record_id,field_id,quote,char_start,char_end) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            ctx.workspaceId,
            input.customer_id,
            id,
            e.source_id,
            e.record_id,
            fieldId,
            e.quote,
            e.char_start,
            e.char_end,
          ],
        );
    created.push(await readable(ctx, row, [...live.values()]));
  }
  await ctx.tx.query(
    "UPDATE activity_runs SET state='completed',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND lease_token=$3",
    [ctx.workspaceId, prepared.run_id, prepared.lease_token],
  );
  return { run_id: prepared.run_id, state: 'completed', activities: created, reused: false };
}
export async function generateActivities(
  db: Database,
  actorId: string,
  workspaceId: string,
  input: unknown,
  options: ActivityModelOptions = {},
) {
  const prepared = await scoped(db, actorId, workspaceId, (ctx) =>
    prepareGeneration(ctx, input, options),
  );
  if (prepared.completed) return prepared.completed;
  try {
    const output = await executeGeneration(prepared);
    return await scoped(db, actorId, workspaceId, (ctx) => finishGeneration(ctx, prepared, output));
  } catch (error) {
    await scoped(db, actorId, workspaceId, (ctx) =>
      ctx.tx.query(
        "UPDATE activity_runs SET state='failed',error=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND state='running'",
        [
          workspaceId,
          prepared.run_id,
          prepared.lease_token,
          error instanceof ApiError ? error.message : '活动整理失败，请重试',
        ],
      ),
    ).catch(() => {});
    throw error;
  }
}

export async function update(ctx: Context, id: string, raw: unknown) {
  const patch = z
    .strictObject({
      version: z.number().int().positive(),
      values: z.record(z.string(), z.unknown()).default({}),
      linked_person_ids: z.array(uuid).max(30).optional(),
      archived: z.boolean().optional(),
    })
    .parse(raw);
  const row = await rawActivity(ctx, id);
  await scope(ctx, row.customer_id, row.project_id, true);
  await readable(ctx, row);
  if (row.version !== patch.version) throw new ApiError(409, '活动已修改，请刷新');
  if (patch.linked_person_ids) await contacts(ctx, row.customer_id, patch.linked_person_ids);
  const values = { ...row.values },
    provenance = { ...row.field_provenance };
  const changed: { field: ActivityField; value: ActivityValue }[] = [];
  for (const [key, value] of Object.entries(patch.values)) {
    const field = row.fields.find((f) => f.id === key);
    if (!field || field.read_only) throw new ApiError(400, '未知属性或只读属性');
    const checked = validateActivityValue(field, value);
    if (field.id === base.title && (!checked || typeof checked !== 'string'))
      throw new ApiError(400, '活动标题不能为空');
    if (digest(values[key]) !== digest(checked)) {
      values[key] = checked;
      changed.push({ field, value: checked });
    }
  }
  const now = new Date().toISOString();
  if (changed.length) {
    const body = `活动「${row.title}」人工补充／更正（本人内部陈述，不代表公司正式确认；原始沟通原文保持不变）：\n${changed.map(({ field, value }) => `${field.name}：${JSON.stringify(value)}`).join('\n')}`;
    if (body.length > 10000) throw new ApiError(413, '本次人工补充过长，请分批保存');
    const record = await service.insert(ctx, 'customer_records', {
      customer_id: row.customer_id,
      project_id: row.project_id,
      kind: 'inference',
      body,
      created_by: ctx.actorId,
      source_kind: 'manual',
      occurred_at: now,
    });
    await ctx.tx.query(
      'INSERT INTO activity_record_sources(workspace_id,customer_id,activity_id,record_id) VALUES($1,$2,$3,$4)',
      [ctx.workspaceId, row.customer_id, id, record.id],
    );
    for (const { field } of changed)
      provenance[field.id] = {
        origin: 'manual',
        actor_id: ctx.actorId,
        updated_at: now,
        record_id: String(record.id),
        evidence: [
          {
            source_id: `record:${record.id}`,
            record_id: String(record.id),
            quote: body,
            char_start: 0,
            char_end: body.length,
          },
        ],
        explanation: '本人明确保存的人工补充，保留原AI值和原文。',
      };
  }
  values['system:updated_at'] = now;
  const missing = row.fields
    .filter((f) => f.required && (values[f.id] === null || values[f.id] === ''))
    .map((f) => f.id);
  const saved = (
    await ctx.tx.query<ActivityRow>(
      'UPDATE business_activities SET title=$3,summary=$4,occurred_at=$5,values=$6,field_provenance=$7,missing_required_fields=$8,archived=$9 WHERE workspace_id=$1 AND id=$2 AND version=$10 RETURNING *',
      [
        ctx.workspaceId,
        id,
        values[base.title],
        values[base.summary],
        values[base.occurred],
        JSON.stringify(values),
        JSON.stringify(provenance),
        JSON.stringify(missing),
        patch.archived ?? row.archived,
        patch.version,
      ],
    )
  ).rows[0];
  if (!saved) throw new ApiError(409, '活动已修改，请刷新');
  if (patch.linked_person_ids) {
    await ctx.tx.query('DELETE FROM activity_people WHERE workspace_id=$1 AND activity_id=$2', [
      ctx.workspaceId,
      id,
    ]);
    for (const personId of new Set(patch.linked_person_ids))
      await ctx.tx.query(
        'INSERT INTO activity_people(workspace_id,customer_id,activity_id,person_id) VALUES($1,$2,$3,$4)',
        [ctx.workspaceId, row.customer_id, id, personId],
      );
  }
  return readable(ctx, saved);
}

export async function comment(ctx: Context, id: string, raw: unknown) {
  const input = z
    .strictObject({
      body: z.string().trim().min(1).max(4000),
      assignee_id: uuid.optional(),
      task_title: z.string().trim().min(1).max(500).optional(),
      due_date: z.iso.date().nullable().optional(),
      request_id: uuid.optional(),
    })
    .parse(raw);
  const activity = await rawActivity(ctx, id);
  await scope(ctx, activity.customer_id, activity.project_id, true);
  await readable(ctx, activity);
  if (activity.archived) throw new ApiError(409, '活动已归档');
  if (input.assignee_id) {
    if (!input.task_title) throw new ApiError(400, '请明确填写跟进事项');
    if (!(await members(ctx, activity.customer_id)).some((m) => m.actor_id === input.assignee_id))
      throw new ApiError(400, '所选成员没有此客户访问权限');
  } else if (input.task_title || input.due_date)
    throw new ApiError(400, '创建待办请明确选择负责人');
  const requestId = input.request_id || randomUUID(),
    requestDigest = digest({ activity_id: id, ...input, request_id: undefined });
  await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `activity-comment:${ctx.workspaceId}:${ctx.actorId}:${requestId}`,
  ]);
  const existing = (
    await ctx.tx.query<ActivityComment & { request_digest: string }>(
      'SELECT * FROM activity_comments WHERE workspace_id=$1 AND created_by=$2 AND request_id=$3',
      [ctx.workspaceId, ctx.actorId, requestId],
    )
  ).rows[0];
  if (existing) {
    if (existing.request_digest !== requestDigest)
      throw new ApiError(409, '同一备注请求内容已变化');
    const task =
      (
        await ctx.tx.query<ActivityTask>(
          "SELECT *,to_char(due_date,'YYYY-MM-DD') AS due_date FROM activity_tasks WHERE workspace_id=$1 AND comment_id=$2",
          [ctx.workspaceId, existing.id],
        )
      ).rows[0] || null;
    return { comment: existing, task };
  }
  const saved = (
    await ctx.tx.query<ActivityComment>(
      'INSERT INTO activity_comments(workspace_id,customer_id,id,activity_id,body,created_by,request_id,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,activity_id,body,created_by,created_at',
      [
        ctx.workspaceId,
        activity.customer_id,
        randomUUID(),
        id,
        input.body,
        ctx.actorId,
        requestId,
        requestDigest,
      ],
    )
  ).rows[0];
  let task: ActivityTask | null = null;
  if (input.assignee_id)
    task = (
      await ctx.tx.query<ActivityTask>(
        'INSERT INTO activity_tasks(workspace_id,customer_id,id,activity_id,comment_id,project_id,title,assignee_id,created_by,due_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [
          ctx.workspaceId,
          activity.customer_id,
          randomUUID(),
          id,
          saved.id,
          activity.project_id,
          input.task_title,
          input.assignee_id,
          ctx.actorId,
          input.due_date || null,
        ],
      )
    ).rows[0];
  return { comment: saved, task };
}
export async function tasks(ctx: Context, raw: unknown = {}) {
  const q = z
    .strictObject({ status: z.enum(['open', 'in_progress', 'completed']).optional() })
    .parse(raw);
  return (
    await ctx.tx.query<ActivityTask>(
      "SELECT *,to_char(due_date,'YYYY-MM-DD') AS due_date FROM activity_tasks WHERE workspace_id=$1 AND assignee_id=$2 AND ($3::text IS NULL OR status=$3) ORDER BY created_at DESC,id LIMIT 100",
      [ctx.workspaceId, ctx.actorId, q.status || null],
    )
  ).rows;
}
export async function updateTask(ctx: Context, id: string, raw: unknown) {
  const input = z
    .strictObject({
      version: z.number().int().positive(),
      status: z.enum(['in_progress', 'completed']),
      result: z.string().trim().min(1).max(4000).optional(),
    })
    .parse(raw);
  const task = (
    await ctx.tx.query<ActivityTask>(
      'SELECT * FROM activity_tasks WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId, uuid.parse(id)],
    )
  ).rows[0];
  if (!task) throw new ApiError(404, '待办不存在或无权访问');
  if (task.assignee_id !== ctx.actorId) throw new ApiError(403, '只有被指派人可以推进或完成此待办');
  await scope(ctx, task.customer_id, task.project_id);
  if (task.status === 'completed') {
    if (input.status === 'completed' && input.result === task.result) return task;
    throw new ApiError(409, '待办已完成');
  }
  if (input.status === 'completed' && !input.result)
    throw new ApiError(400, '完成待办请填写处理结果');
  const row = (
    await ctx.tx.query<ActivityTask>(
      'UPDATE activity_tasks SET status=$3,result=$4 WHERE workspace_id=$1 AND id=$2 AND version=$5 RETURNING *',
      [ctx.workspaceId, id, input.status, input.result || task.result, input.version],
    )
  ).rows[0];
  if (!row) throw new ApiError(409, '待办已修改，请刷新');
  return row;
}
