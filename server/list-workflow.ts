import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ListConfig, ListField, ListValue, WorkflowEntry } from '../shared/list-workflow.js';
import { amount, listConfigSchema, validateListConfig } from './list-validation.js';
import { ApiError, type Context } from './security.js';
import { getList } from './lists.js';
import * as service from './service.js';
import { person } from './people.js';

const color = z.enum(['gray', 'blue', 'cyan', 'purple', 'orange', 'green']);
const options = z
  .array(
    z.strictObject({ id: z.uuid().optional(), label: z.string().trim().min(1).max(40), color }),
  )
  .max(40);
const fieldInput = z.strictObject({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['stage', 'member', 'date', 'currency', 'text']),
  currency: z.enum(['CNY', 'USD', 'EUR']).default('CNY'),
  options: options.default([]),
});
const fieldPatch = z.strictObject({
  name: fieldInput.shape.name.optional(),
  options: options.optional(),
  position: z.number().int().min(0).max(1000).optional(),
  archived: z.boolean().optional(),
  version: z.number().int().positive(),
});
const selectFields = 'id,name,kind,options,currency,position,archived,version';
export async function fields(ctx: Context, id: string) {
  await getList(ctx, id);
  return (
    await ctx.tx.query<ListField>(
      `SELECT ${selectFields} FROM list_fields WHERE workspace_id=$1 AND list_id=$2 ORDER BY position,id`,
      [ctx.workspaceId, id],
    )
  ).rows;
}
async function lockList(ctx: Context, id: string) {
  await getList(ctx, id);
  await ctx.tx.query('SELECT id FROM record_lists WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [
    ctx.workspaceId,
    id,
  ]);
}
function checkOptions(kind: string, opts: z.infer<typeof options>) {
  if ((kind === 'stage' && !opts.length) || (kind !== 'stage' && opts.length))
    throw new ApiError(400, '只有阶段字段需要至少一个选项');
  if (
    new Set(opts.map((o) => o.label.toLocaleLowerCase())).size !== opts.length ||
    new Set(opts.filter((o) => o.id).map((o) => o.id)).size !== opts.filter((o) => o.id).length
  )
    throw new ApiError(400, '阶段名称或 ID 不能重复');
  return opts.map((o) => ({ ...o, id: o.id || randomUUID() }));
}
export async function createField(ctx: Context, id: string, input: unknown) {
  const value = fieldInput.parse(input);
  await lockList(ctx, id);
  const existing = await fields(ctx, id);
  if (existing.filter((f) => !f.archived).length >= 40)
    throw new ApiError(400, '每个清单最多 40 个有效字段');
  const opts = checkOptions(value.kind, value.options);
  return (
    await ctx.tx.query(
      `INSERT INTO list_fields(workspace_id,actor_id,list_id,id,name,kind,options,currency,position) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${selectFields}`,
      [
        ctx.workspaceId,
        ctx.actorId,
        id,
        randomUUID(),
        value.name,
        value.kind,
        JSON.stringify(opts),
        value.currency,
        Math.max(-1, ...existing.map((f) => f.position)) + 1,
      ],
    )
  ).rows[0];
}
export async function updateField(ctx: Context, id: string, fieldId: string, input: unknown) {
  const value = fieldPatch.parse(input);
  await lockList(ctx, id);
  const all = await fields(ctx, id),
    old = all.find((f) => f.id === fieldId);
  if (!old) throw new ApiError(404, '字段不存在或不属于此清单');
  const opts = value.options ? checkOptions(old.kind, value.options) : old.options;
  if (old.options.some((o) => !opts.some((n) => n.id === o.id)))
    throw new ApiError(400, '已有阶段请改名或调整顺序，不能移除其历史标识');
  if (old.archived && value.archived === false && all.filter((f) => !f.archived).length >= 40)
    throw new ApiError(400, '有效字段已达上限');
  const row = (
    await ctx.tx.query(
      `UPDATE list_fields SET name=$1,options=$2,position=$3,archived=$4 WHERE workspace_id=$5 AND list_id=$6 AND id=$7 AND version=$8 RETURNING ${selectFields}`,
      [
        value.name ?? old.name,
        JSON.stringify(opts),
        value.position ?? old.position,
        value.archived ?? old.archived,
        ctx.workspaceId,
        id,
        fieldId,
        value.version,
      ],
    )
  ).rows[0];
  if (!row) throw new ApiError(409, '字段已被修改，请重新打开设置');
  return row;
}
export async function updateEntry(ctx: Context, id: string, entryId: string, input: unknown) {
  const value = z
    .strictObject({
      version: z.number().int().positive(),
      values: z.record(z.uuid(), z.string().max(2000).nullable()),
    })
    .parse(input);
  if (!Object.keys(value.values).length) throw new ApiError(400, '请提供需要修改的字段');
  await lockList(ctx, id);
  const row = (
    await ctx.tx.query<WorkflowEntry>(
      'SELECT * FROM list_entries WHERE workspace_id=$1 AND list_id=$2 AND id=$3',
      [ctx.workspaceId, id, entryId],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, '清单记录不存在或无权访问');
  service.activeCustomer(await service.customer(ctx, row.customer_id, true));
  if (row.project_id && (await service.project(ctx, row.customer_id, row.project_id)).archived_at)
    throw new ApiError(409, '项目已归档');
  if (row.person_id && (await person(ctx, row.person_id, row.customer_id)).archived_at)
    throw new ApiError(409, '联系人已归档');
  const all = await fields(ctx, id);
  for (const [key, val] of Object.entries(value.values)) {
    const f = all.find((f) => f.id === key && !f.archived);
    if (!f) throw new ApiError(400, '字段不存在、已隐藏或不属于当前清单');
    if (val === null) continue;
    if (f.kind === 'stage' && !f.options.some((o) => o.id === val))
      throw new ApiError(400, '阶段不属于当前字段');
    if (f.kind === 'date') z.iso.date().parse(val);
    if (f.kind === 'currency') amount.parse(val);
    if (f.kind === 'member') {
      z.uuid().parse(val);
      const member = (
        await ctx.tx.query(
          'SELECT actor_id FROM workspace_people WHERE workspace_id=$1 AND actor_id=$2 AND active',
          [ctx.workspaceId, val],
        )
      ).rows[0];
      if (!member) throw new ApiError(400, '负责人必须是本空间有效成员');
    }
  }
  const updated = (
    await ctx.tx.query(
      'UPDATE list_entries SET field_values=field_values || $1::jsonb WHERE workspace_id=$2 AND list_id=$3 AND id=$4 AND version=$5 RETURNING id,version,field_values',
      [JSON.stringify(value.values), ctx.workspaceId, id, entryId, value.version],
    )
  ).rows[0];
  if (!updated) throw new ApiError(409, '这条记录已被修改，请刷新后重试');
  return updated;
}
export async function browseEntries(ctx: Context, id: string, input: unknown) {
  const q = z
    .strictObject({
      config: listConfigSchema,
      query: z.string().trim().max(100).default(''),
      page: z.number().int().min(1).max(100000).default(1),
    })
    .parse(input);
  const list = await getList(ctx, id),
    all = await fields(ctx, id);
  validateListConfig(q.config, all);
  const type = list.object,
    alias = type === 'customers' ? 'c' : 'r';
  const join =
    type === 'customers'
      ? ''
      : ` JOIN ${type} r ON r.workspace_id=e.workspace_id AND r.customer_id=e.customer_id AND r.id=e.${type === 'people' ? 'person_id' : 'project_id'}`;
  const from = `list_entries e JOIN customers c ON c.workspace_id=e.workspace_id AND c.id=e.customer_id${join}`;
  const name = `${alias}.name`,
    email = type === 'people' ? 'r.email' : 'c.email';
  const params: unknown[] = [ctx.workspaceId, id, q.query];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const valueSQL = (id: string) => (id === 'name' ? name : `(e.field_values->>${bind(id)})`);
  const typedSQL = (id: string) => {
    const val = valueSQL(id);
    return all.find((f) => f.id === id)?.kind === 'currency' ? `(${val})::numeric` : val;
  };
  let where = `e.workspace_id=$1 AND e.list_id=$2 AND c.archived_at IS NULL${type !== 'customers' ? ' AND r.archived_at IS NULL' : ''} AND ($3='' OR position(lower($3) in lower(${name}||' '||c.name))>0)`;
  const rules = q.config.filters.rules.map((r) => {
    const val = typedSQL(r.field);
    if (r.operator === 'is_set') return `${val} IS NOT NULL`;
    if (r.operator === 'is_not_set') return `${val} IS NULL`;
    const parameter = bind(r.value);
    if (r.operator === 'contains') return `position(lower(${parameter}) in lower(${val}))>0`;
    if (r.operator === 'not_eq') return `(${val} IS NULL OR ${val} <> ${parameter})`;
    return `${val} ${{ eq: '=', gt: '>', lt: '<' }[r.operator]} ${parameter}`;
  });
  if (rules.length)
    where += ` AND (${rules.join(q.config.filters.match === 'all' ? ' AND ' : ' OR ')})`;
  const counts = (
    await ctx.tx.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM ${from} WHERE ${where}`,
      params,
    )
  ).rows[0];
  const groups: Record<string, number> = {};
  if (q.config.group_by) {
    const groupParams = [...params, q.config.group_by];
    const rows = (
      await ctx.tx.query<{ key: string; count: number }>(
        `SELECT coalesce(e.field_values->>$${groupParams.length},'') AS key,count(*)::int AS count FROM ${from} WHERE ${where} GROUP BY 1`,
        groupParams,
      )
    ).rows;
    rows.forEach((r) => (groups[r.key] = r.count));
  }
  const sums: Record<string, string> = {};
  for (const f of all.filter(
    (f) => !f.archived && f.kind === 'currency' && q.config.columns.includes(f.id),
  )) {
    sums[f.id] = (
      await ctx.tx.query<{ sum: string }>(
        `SELECT coalesce(sum((e.field_values->>$${params.length + 1})::numeric),0)::text AS sum FROM ${from} WHERE ${where}`,
        [...params, f.id],
      )
    ).rows[0].sum;
  }
  const sortField = all.find((f) => f.id === q.config.sort);
  let sort = typedSQL(q.config.sort);
  if (sortField?.kind === 'stage')
    sort = `CASE ${sort} ${sortField.options.map((o, i) => `WHEN ${bind(o.id)} THEN ${i}`).join(' ')} END`;
  if (sortField?.kind === 'member')
    sort = `(SELECT display_name FROM workspace_people m WHERE m.workspace_id=e.workspace_id AND m.actor_id::text=${sort})`;
  const pageSize = 50;
  const items = (
    await ctx.tx.query<WorkflowEntry>(
      `SELECT e.id,e.customer_id,e.project_id,e.person_id,e.version,e.field_values,${name} AS name,c.name AS customer_name,${email} AS email,crm_access(e.workspace_id,e.customer_id,true) AS can_edit FROM ${from} WHERE ${where} ORDER BY ${sort} ${q.config.direction === 'asc' ? 'ASC' : 'DESC'} NULLS LAST,e.id LIMIT ${pageSize} OFFSET ${(q.page - 1) * pageSize}`,
      params,
    )
  ).rows;
  return { items, total: counts.total, page: q.page, page_size: pageSize, groups, sums };
}
