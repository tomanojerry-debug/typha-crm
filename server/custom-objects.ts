import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  customObjectIcons,
  customObjectColors,
  customAttributeKinds,
  customSystemAttributes,
  type CustomObject,
  type CustomAttribute,
  type CustomRecord,
  type CustomValue,
} from '../shared/custom-objects.js';
import { ApiError, requireAdmin, type Context } from './security.js';
import * as service from './service.js';
import { uuid } from './validation.js';
import { sanitizeAttributeSources } from './attribute-source-visibility.js';

const objectInput = z.strictObject({
  name: z.string().trim().min(1).max(60),
  singular_name: z.string().trim().min(1).max(60),
  slug: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,47}$/, '标识需以英文字母开头，使用2–48位小写字母、数字或下划线'),
  icon: z.enum(customObjectIcons),
  color: z.enum(
    Object.keys(customObjectColors) as [
      keyof typeof customObjectColors,
      ...Array<keyof typeof customObjectColors>,
    ],
  ),
});
const fieldInput = z
  .strictObject({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(1000).default(''),
    kind: z.enum(
      Object.keys(customAttributeKinds) as [
        keyof typeof customAttributeKinds,
        ...Array<keyof typeof customAttributeKinds>,
      ],
    ),
    options: z.array(z.string().trim().min(1).max(60)).max(40).default([]),
    required: z.boolean().default(false),
    is_unique: z.boolean().default(false),
    currency: z.enum(['CNY', 'USD', 'EUR', 'GBP', 'JPY']).default('CNY'),
    archived: z.boolean().default(false),
    ai_enabled: z.boolean().default(false),
    guidance: z.string().trim().max(4000).default(''),
  })
  .superRefine((v, ctx) => {
    if (
      ['select', 'multi_select'].includes(v.kind) !== !!v.options.length ||
      new Set(v.options.map((s) => s.toLowerCase())).size !== v.options.length
    )
      ctx.addIssue({ code: 'custom', message: '选择类型需要不重复的选项，其他类型不能设置选项' });
    if (v.is_unique && !['text', 'number', 'date'].includes(v.kind))
      ctx.addIssue({ code: 'custom', message: '唯一约束当前支持文本、数字和日期' });
    if (customSystemAttributes.some((f) => f.name === v.name))
      ctx.addIssue({ code: 'custom', message: '名称与系统属性重复' });
    if (v.ai_enabled && !v.guidance)
      ctx.addIssue({ code: 'custom', message: '请填写 AI 整理指引' });
  });
const recordInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  customer_id: uuid,
  project_id: uuid.nullable().default(null),
  values: z.record(z.string().uuid(), z.unknown()).default({}),
  object_version: z.number().int().positive(),
});
const fieldColumns =
  'id,object_id,name,description,kind,options,required,is_unique,currency,archived,ai_enabled,guidance,version';
async function lock(ctx: Context) {
  await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `custom-objects:${ctx.workspaceId}`,
  ]);
}
export async function objects(ctx: Context) {
  return (
    await ctx.tx.query<CustomObject>(
      `SELECT o.*, (SELECT count(*)::int FROM custom_object_records r WHERE r.workspace_id=o.workspace_id AND r.object_id=o.id AND r.archived_at IS NULL) AS record_count, (SELECT count(*)::int+6 FROM custom_object_attributes a WHERE a.workspace_id=o.workspace_id AND a.object_id=o.id AND NOT a.archived) AS attribute_count FROM custom_objects o WHERE o.workspace_id=$1 ORDER BY o.created_at,o.id`,
      [ctx.workspaceId],
    )
  ).rows;
}
export async function object(ctx: Context, id: string, version?: number) {
  const row = (
    await ctx.tx.query<CustomObject>(
      'SELECT * FROM custom_objects WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId, id],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, '实体不存在或无权访问');
  if (version !== undefined && version !== row.version)
    throw new ApiError(409, '实体或属性配置已变化，请刷新后重新核对');
  return row;
}
export async function createObject(ctx: Context, input: unknown) {
  requireAdmin(ctx);
  const v = objectInput.parse(input);
  await lock(ctx);
  const rows = await objects(ctx);
  if (rows.length >= 30) throw new ApiError(400, '最多创建30个自定义实体');
  if (
    [
      'customers',
      'companies',
      'people',
      'projects',
      'home',
      'chat',
      'mail',
      'wechat',
      'relationships',
    ].includes(v.slug) ||
    ['公司', '联系人', '项目'].includes(v.name) ||
    rows.some((o) => o.name.toLowerCase() === v.name.toLowerCase() || o.slug === v.slug)
  )
    throw new ApiError(409, '实体名称或标识已存在或被系统保留');
  return (
    await ctx.tx.query<CustomObject>(
      'INSERT INTO custom_objects(workspace_id,id,name,singular_name,slug,icon,color) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *,0 AS record_count,6 AS attribute_count',
      [ctx.workspaceId, randomUUID(), v.name, v.singular_name, v.slug, v.icon, v.color],
    )
  ).rows[0];
}
export async function fields(ctx: Context, id: string) {
  await object(ctx, id);
  return (
    await ctx.tx.query<CustomAttribute>(
      `SELECT ${fieldColumns} FROM custom_object_attributes WHERE workspace_id=$1 AND object_id=$2 ORDER BY created_at,id`,
      [ctx.workspaceId, id],
    )
  ).rows;
}
export async function saveField(ctx: Context, id: string, fieldId: string | null, input: unknown) {
  requireAdmin(ctx);
  const parsed = z
    .strictObject({
      ...fieldInput.shape,
      ...(fieldId ? { version: z.number().int().positive() } : {}),
    })
    .parse(input);
  const { version, ...rest } = parsed as z.infer<typeof fieldInput> & { version?: number };
  const v = fieldInput.parse(rest);
  await lock(ctx);
  const all = await fields(ctx, id);
  const old = all.find((f) => f.id === fieldId);
  if (fieldId && !old) throw new ApiError(404, '属性不存在');
  if (
    !v.archived &&
    all.some(
      (f) => f.id !== fieldId && !f.archived && f.name.toLowerCase() === v.name.toLowerCase(),
    )
  )
    throw new ApiError(409, '已有同名属性');
  if (!v.archived && (!old || old.archived) && all.filter((f) => !f.archived).length >= 40)
    throw new ApiError(400, '最多40个有效属性');
  if (old && old.currency !== v.currency) throw new ApiError(400, '已有属性币种不可修改');
  if (old && (old.kind !== v.kind || old.options.some((o) => !v.options.includes(o))))
    throw new ApiError(400, '已有属性类型及选项不可删除或改名，可添加选项');
  const row = fieldId
    ? (
        await ctx.tx.query<CustomAttribute>(
          `UPDATE custom_object_attributes SET name=$1,options=$2,required=$3,archived=$4,is_unique=$5,description=$10,ai_enabled=$11,guidance=$12 WHERE workspace_id=$6 AND object_id=$7 AND id=$8 AND version=$9 RETURNING ${fieldColumns}`,
          [
            v.name,
            JSON.stringify(v.options),
            v.required,
            v.archived,
            v.is_unique,
            ctx.workspaceId,
            id,
            fieldId,
            version,
            v.description,
            v.ai_enabled,
            v.guidance,
          ],
        )
      ).rows[0]
    : (
        await ctx.tx.query<CustomAttribute>(
          `INSERT INTO custom_object_attributes(workspace_id,object_id,id,name,kind,options,required,archived,is_unique,currency,description,ai_enabled,guidance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${fieldColumns}`,
          [
            ctx.workspaceId,
            id,
            randomUUID(),
            v.name,
            v.kind,
            JSON.stringify(v.options),
            v.required,
            v.archived,
            v.is_unique,
            v.currency,
            v.description,
            v.ai_enabled,
            v.guidance,
          ],
        )
      ).rows[0];
  if (!row) throw new ApiError(409, '属性已被修改，请重新打开');
  await ctx.tx.query('UPDATE custom_objects SET version=version WHERE workspace_id=$1 AND id=$2', [
    ctx.workspaceId,
    id,
  ]);
  return row;
}
export function validateValue(f: CustomAttribute, value: unknown): CustomValue {
  if (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && !value.length)
  ) {
    if (f.required) throw new ApiError(400, `请填写${f.name}`);
    return null;
  }
  if (f.kind === 'text') {
    const s = z
      .string()
      .trim()
      .max(f.is_unique ? 250 : 5000)
      .parse(value);
    if (f.required && !s) throw new ApiError(400, `请填写${f.name}`);
    return s || null;
  }
  if (f.kind === 'number' || f.kind === 'currency')
    return z.number().finite().min(-1e15).max(1e15).parse(value);
  if (f.kind === 'checkbox') return z.boolean().parse(value);
  if (f.kind === 'rating') return z.number().int().min(1).max(5).parse(value);
  if (f.kind === 'timestamp') return z.iso.datetime({ offset: true }).parse(value);
  if (f.kind === 'date') return z.iso.date().parse(value);
  const choices =
    f.kind === 'select' ? [z.string().parse(value)] : z.array(z.string()).max(40).parse(value);
  if (new Set(choices).size !== choices.length || choices.some((s) => !f.options.includes(s)))
    throw new ApiError(400, `${f.name}的选项无效`);
  return f.kind === 'select' ? choices[0] : choices;
}
const selectRecord = `SELECT r.*,c.name AS customer_name,p.name AS project_name,u.display_name AS created_by_name,crm_access(r.workspace_id,r.customer_id,true) AS can_edit FROM custom_object_records r JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id LEFT JOIN projects p ON p.workspace_id=r.workspace_id AND p.customer_id=r.customer_id AND p.id=r.project_id LEFT JOIN workspace_people u ON u.workspace_id=r.workspace_id AND u.actor_id=r.created_by`;
async function visibleRecord(ctx: Context, row: CustomRecord) {
  const field_provenance = { ...row.field_provenance };
  for (const [id, provenance] of Object.entries(field_provenance)) {
    if (provenance.origin !== 'ai') continue;
    const safe = await sanitizeAttributeSources(ctx, row.customer_id, provenance.sources);
    const visible = new Set(safe.sources.map((source) => source.id));
    field_provenance[id] = {
      ...provenance,
      sources: safe.sources,
      evidence: safe.invalid
        ? []
        : provenance.evidence.filter((evidence) => visible.has(evidence.source_id)),
      ...(safe.invalid
        ? {
            sources_stale: true,
            explanation: '部分原始依据已失效，已隐藏旧依据。请核对当前资料，必要时清空后重新整理。',
            missing: ['原始依据已失效'],
          }
        : {}),
    };
  }
  return { ...row, field_provenance };
}
export async function record(ctx: Context, id: string, recordId: string) {
  await object(ctx, id);
  const row = (
    await ctx.tx.query<CustomRecord>(
      `${selectRecord} WHERE r.workspace_id=$1 AND r.object_id=$2 AND r.id=$3`,
      [ctx.workspaceId, id, recordId],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, '记录不存在或无权访问');
  return visibleRecord(ctx, row);
}
export async function records(ctx: Context, id: string, input: unknown) {
  await object(ctx, id);
  const v = z
    .strictObject({
      q: z.string().trim().max(120).default(''),
      page: z.coerce.number().int().min(1).max(100000).default(1),
      archived: z.enum(['true', 'false']).default('false'),
    })
    .parse(input);
  const args = [ctx.workspaceId, id, v.archived === 'true', `%${v.q.replace(/[\\%_]/g, '\\$&')}%`];
  const where = `WHERE r.workspace_id=$1 AND r.object_id=$2 AND (r.archived_at IS NOT NULL)=$3 AND (r.name ILIKE $4 OR c.name ILIKE $4)`;
  const total = (
    await ctx.tx.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM custom_object_records r JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id ${where}`,
      args,
    )
  ).rows[0].total;
  const items = (
    await ctx.tx.query<CustomRecord>(
      `${selectRecord} ${where} ORDER BY r.updated_at DESC,r.id LIMIT 50 OFFSET $5`,
      [...args, (v.page - 1) * 50],
    )
  ).rows;
  return {
    items: await Promise.all(items.map((row) => visibleRecord(ctx, row))),
    total,
    page: v.page,
  };
}
export async function saveRecord(
  ctx: Context,
  id: string,
  recordId: string | null,
  input: unknown,
) {
  const parsed = z
    .strictObject({
      ...recordInput.shape,
      ...(recordId
        ? { version: z.number().int().positive(), archived: z.boolean().default(false) }
        : {}),
    })
    .parse(input);
  const v = parsed as z.infer<typeof recordInput> & { version?: number; archived?: boolean };
  await lock(ctx);
  await object(ctx, id, v.object_version);
  const old = recordId ? await record(ctx, id, recordId) : null;
  if (old && old.customer_id !== v.customer_id) throw new ApiError(400, '记录所属公司不可修改');
  const c = await service.customer(ctx, v.customer_id, true);
  service.activeCustomer(c);
  if (old?.archived_at && v.archived) throw new ApiError(409, '请先恢复记录再编辑');
  if (v.project_id) {
    const p = await service.project(ctx, v.customer_id, v.project_id);
    if (p.archived_at && p.id !== old?.project_id) throw new ApiError(409, '项目已归档');
  }
  const all = await fields(ctx, id),
    values: Record<string, CustomValue> = {},
    provenance = { ...old?.field_provenance };
  if (Object.keys(v.values).some((k) => !all.some((f) => f.id === k)))
    throw new ApiError(400, '包含不存在的属性');
  for (const f of all) {
    if (f.archived) {
      if (old?.values[f.id] !== undefined) values[f.id] = old.values[f.id];
      continue;
    }
    values[f.id] = validateValue(f, v.values[f.id]);
    if (JSON.stringify(values[f.id]) !== JSON.stringify(old?.values[f.id]))
      provenance[f.id] = {
        origin: 'manual',
        state: 'filled',
        explanation: '',
        missing: [],
        sources: [],
        evidence: [],
        generated_at: null,
        run_id: null,
      };
  }
  const row = recordId
    ? (
        await ctx.tx.query<{ id: string }>(
          'UPDATE custom_object_records SET name=$1,project_id=$2,values=$3,archived_at=$4,field_provenance=$9 WHERE workspace_id=$5 AND object_id=$6 AND id=$7 AND version=$8 RETURNING id',
          [
            v.name,
            v.project_id,
            JSON.stringify(values),
            v.archived ? new Date().toISOString() : null,
            ctx.workspaceId,
            id,
            recordId,
            v.version,
            JSON.stringify(provenance),
          ],
        )
      ).rows[0]
    : (
        await ctx.tx.query<{ id: string }>(
          'INSERT INTO custom_object_records(workspace_id,object_id,id,customer_id,project_id,name,values,created_by,field_provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
          [
            ctx.workspaceId,
            id,
            randomUUID(),
            v.customer_id,
            v.project_id,
            v.name,
            JSON.stringify(values),
            ctx.actorId,
            JSON.stringify(provenance),
          ],
        )
      ).rows[0];
  if (!row) throw new ApiError(409, '记录已被修改，请刷新后重新打开');
  return record(ctx, id, row.id);
}
export async function recordOptions(ctx: Context, id: string, input: unknown) {
  await object(ctx, id);
  const v = z
    .strictObject({ q: z.string().trim().max(120).default(''), customer_id: uuid.optional() })
    .parse(input);
  const customers = (
    await ctx.tx.query<{ id: string; name: string; can_edit: boolean }>(
      'SELECT id,name,crm_access(workspace_id,id,true) AS can_edit FROM customers WHERE workspace_id=$1 AND archived_at IS NULL AND (name ILIKE $2 OR id=$3) ORDER BY name,id LIMIT 50',
      [ctx.workspaceId, `%${v.q.replace(/[\\%_]/g, '\\$&')}%`, v.customer_id || null],
    )
  ).rows;
  if (v.customer_id) await service.customer(ctx, v.customer_id);
  const projects = v.customer_id
    ? (
        await ctx.tx.query<{ id: string; name: string }>(
          'SELECT id,name FROM projects WHERE workspace_id=$1 AND customer_id=$2 AND archived_at IS NULL ORDER BY name,id',
          [ctx.workspaceId, v.customer_id],
        )
      ).rows
    : [];
  return { customers, projects };
}
