import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  ReportBucket,
  ReportCatalog,
  ReportDashboard,
  ReportField,
  ReportQueryResult,
  ReportRow,
  ReportSource,
} from '../shared/reports.js';
import {
  customerStatuses,
  customerTypes,
  projectStages,
  projectTypes,
  recordKinds,
  sources,
} from '../shared/domain.js';
import { ApiError, type Context } from './security.js';
import * as activityAnalysis from './activity-analysis.js';

const uuid = z.string().uuid();
const sourceId = z
  .string()
  .regex(/^(companies|people|projects|activities|records|custom:[0-9a-f-]{36})$/);
const metric = z.enum(['count', 'distinct_customers', 'sum', 'average']);
const fieldId = z.string().min(1).max(80);
const widgetInput = z.strictObject({
  id: uuid,
  title: z.string().trim().min(1).max(100),
  source: sourceId,
  metric,
  metricField: fieldId.optional(),
  groupBy: fieldId,
  visualization: z.enum(['number', 'bar', 'donut', 'line']),
});
const dashboardInput = z.strictObject({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1000).default(''),
  widgets: z.array(widgetInput).max(24),
  activity_analysis: z.unknown().optional(),
});
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      !value.startsWith('0000-') &&
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, '日期无效');
const queryInput = z
  .strictObject({
    source: sourceId,
    metric,
    metricField: fieldId.optional(),
    groupBy: fieldId,
    startDate: date.optional(),
    endDate: date.optional(),
    customerId: uuid.optional(),
    customerType: z.enum(['distributor', 'group', 'retail']).optional(),
    bucketKey: z.string().max(2000).optional(),
    offset: z.number().int().min(0).max(10000000).default(0),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .refine((value) => !value.startDate || !value.endDate || value.startDate <= value.endDate, {
    message: '开始日期不能晚于结束日期',
  });
type Definition = { id: string; name: string; kind: string; object_id?: string; currency?: string };
interface SourcePlan {
  source: ReportSource;
  from: string;
  where: string;
  name: string;
  id: string;
  date: string;
  project: string;
  person: string;
  expressions: Record<string, string>;
  numeric: Record<string, string>;
  labels: Record<string, Record<string, string>>;
}
const columns = 'id,name,description,widgets,activity_analysis,version,created_at,updated_at';
const category = (id: string, label: string): ReportField => ({ id, label, kind: 'category' });
const supportedCategoryKinds = new Set(['select', 'multi_select', 'checkbox']);

/** All row reads execute under scoped() / light_crm_app. This module never reads
 * business source bodies or graph payloads, and does not call a model. */
async function plans(ctx: Context): Promise<SourcePlan[]> {
  const definitions = (
    await ctx.tx.query<Definition>(
      `SELECT id,name,kind,NULL::uuid AS object_id,NULL::text AS currency FROM customer_attributes
       WHERE workspace_id=$1 AND NOT archived
       UNION ALL SELECT id,name,kind,object_id,currency FROM custom_object_attributes
       WHERE workspace_id=$1 AND NOT archived`,
      [ctx.workspaceId],
    )
  ).rows;
  const objects = (
    await ctx.tx.query<{ id: string; name: string }>(
      'SELECT id,name FROM custom_objects WHERE workspace_id=$1 ORDER BY created_at,id',
      [ctx.workspaceId],
    )
  ).rows;
  const members = Object.fromEntries(
    (
      await ctx.tx.query<{ actor_id: string; display_name: string }>(
        'SELECT actor_id,display_name FROM workspace_people WHERE workspace_id=$1',
        [ctx.workspaceId],
      )
    ).rows.map((row) => [row.actor_id, row.display_name]),
  );
  const customerNames = Object.fromEntries(
    (
      await ctx.tx.query<{ id: string; name: string }>(
        'SELECT id,name FROM customers WHERE workspace_id=$1 AND archived_at IS NULL',
        [ctx.workspaceId],
      )
    ).rows.map((row) => [row.id, row.name]),
  );
  const projectJoin = `LEFT JOIN projects p ON p.workspace_id=r.workspace_id
    AND p.customer_id=r.customer_id AND p.id=r.project_id`;
  const liveProject = '(r.project_id IS NULL OR (p.id IS NOT NULL AND p.archived_at IS NULL))';
  const base = (
    id: string,
    label: string,
    from: string,
    where: string,
    name: string,
    dateExpression: string,
    dateLabel: string,
    fields: ReportField[],
    expressions: Record<string, string>,
    labels: SourcePlan['labels'] = {},
  ): SourcePlan => ({
    source: {
      id,
      label,
      dateLabel,
      fields: [
        ...fields,
        category('customer', '所属公司'),
        category('customer_type', '客户类型'),
        {
          id: 'month',
          label: `${dateLabel.startsWith('发生') ? '发生' : '创建'}月份`,
          kind: 'date',
        },
      ],
    },
    from,
    where: `c.workspace_id=$1 AND c.archived_at IS NULL AND (${where})`,
    name,
    id: id === 'companies' ? 'c.id' : 'r.id',
    date: dateExpression,
    project:
      ['projects', 'activities', 'records'].includes(id) || id.startsWith('custom:')
        ? id === 'projects'
          ? 'r.id'
          : 'r.project_id'
        : 'NULL::uuid',
    person: id === 'people' ? 'r.id' : 'NULL::uuid',
    expressions: {
      ...expressions,
      customer: 'c.id::text',
      customer_type: 'c.type',
      month: `to_char(${dateExpression} AT TIME ZONE 'Asia/Shanghai','YYYY-MM')`,
    },
    numeric: {},
    labels: { ...labels, customer: customerNames, customer_type: customerTypes },
  });
  const list = [
    base(
      'companies',
      '公司',
      'customers c',
      'true',
      'c.name',
      'c.created_at',
      '创建时间',
      [
        category('type', '客户类型'),
        category('source', '客户来源'),
        category('status', '合作状态'),
        category('region', '地区'),
        category('owner', '负责人'),
      ],
      {
        type: 'c.type',
        source: 'c.source',
        status: 'c.status',
        region: "nullif(c.region,'')",
        owner: 'c.owner_id::text',
      },
      { type: customerTypes, source: sources, status: customerStatuses, owner: members },
    ),
    base(
      'people',
      '联系人',
      'people r JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id',
      'r.archived_at IS NULL',
      'r.name',
      'r.created_at',
      '创建时间',
      [category('owner', '负责人'), category('is_primary', '主要联系人')],
      { owner: 'c.owner_id::text', is_primary: 'r.is_primary::text' },
      { owner: members, is_primary: { true: '是', false: '否' } },
    ),
    base(
      'projects',
      '项目',
      'projects r JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id',
      'r.archived_at IS NULL',
      'r.name',
      'r.created_at',
      '创建时间',
      [category('type', '项目类型'), category('stage', '当前阶段'), category('owner', '负责人')],
      { type: 'r.type', stage: 'r.stage', owner: 'r.owner_id::text' },
      { type: projectTypes, stage: projectStages, owner: members },
    ),
    base(
      'activities',
      '活动',
      `business_activities r JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id ${projectJoin}`,
      `NOT r.archived AND ${liveProject}`,
      'r.title',
      'coalesce(r.occurred_at,r.created_at)',
      '发生时间（空时取创建时间）',
      [category('type', '活动类型'), category('handler', '经手人')],
      { type: 'r.type_name', handler: 'r.handler_id::text' },
      { handler: members },
    ),
    base(
      'records',
      '沟通与资料',
      `customer_records r JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id ${projectJoin}`,
      liveProject,
      "CASE r.kind WHEN 'customer_quote' THEN '客户原话' WHEN 'company_confirmed' THEN '公司确认' ELSE '内部推断' END",
      'coalesce(r.occurred_at,r.created_at)',
      '发生时间（空时取创建时间）',
      [category('kind', '事实类型'), category('source', '资料来源')],
      { kind: 'r.kind', source: "coalesce(r.source_kind,'manual')" },
      {
        kind: recordKinds,
        source: {
          manual: '人工记录',
          email: '邮件',
          wechat: '微信',
          document: '文档',
          note: '内部笔记',
        },
      },
    ),
  ];
  for (const object of objects) {
    // IDs come from the current workspace's UUID columns, never input SQL.
    list.push(
      base(
        `custom:${object.id}`,
        object.name,
        `custom_object_records r JOIN customers c ON c.workspace_id=r.workspace_id AND c.id=r.customer_id ${projectJoin}`,
        `r.archived_at IS NULL AND r.object_id='${uuid.parse(object.id)}'::uuid AND ${liveProject}`,
        'r.name',
        'r.created_at',
        '创建时间',
        [],
        {},
      ),
    );
  }
  for (const definition of definitions) {
    const source = list.find(
      (item) =>
        item.source.id === (definition.object_id ? `custom:${definition.object_id}` : 'companies'),
    );
    if (
      !source ||
      (!supportedCategoryKinds.has(definition.kind) &&
        !['number', 'currency', 'rating'].includes(definition.kind))
    )
      continue;
    const id = `attr:${definition.id}`;
    const attrId = uuid.parse(definition.id);
    const value = definition.object_id
      ? `r.values->'${attrId}'`
      : `(SELECT av.value FROM customer_attribute_values av WHERE av.workspace_id=c.workspace_id AND av.customer_id=c.id AND av.attribute_id='${attrId}'::uuid)`;
    const numeric = ['number', 'currency', 'rating'].includes(definition.kind);
    source.source.fields.push({
      id,
      label: definition.name,
      kind: numeric ? 'number' : 'category',
      ...(definition.kind === 'currency' ? { unit: definition.currency } : {}),
    });
    source.expressions[id] =
      definition.kind === 'multi_select'
        ? `(SELECT CASE WHEN count(*)=0 THEN NULL ELSE jsonb_agg(option ORDER BY option)::text END
          FROM (SELECT DISTINCT option FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(${value})='array' THEN ${value} ELSE '[]'::jsonb END
          ) AS option) canonical_options)`
        : `(${value}) #>> '{}'`;
    if (numeric)
      source.numeric[id] =
        `CASE WHEN jsonb_typeof(${value})='number' THEN ((${value}) #>> '{}')::numeric END`;
    if (definition.kind === 'checkbox') source.labels[id] = { true: '是', false: '否' };
  }
  return list;
}

export async function catalog(ctx: Context): Promise<ReportCatalog> {
  return {
    sources: (await plans(ctx)).map((plan) => plan.source),
    customers: (
      await ctx.tx.query<{ id: string; name: string }>(
        'SELECT id,name FROM customers WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY name,id',
        [ctx.workspaceId],
      )
    ).rows,
    customerTypes: Object.entries(customerTypes).map(([value, label]) => ({ value, label })),
  };
}
function validateQuery(
  source: SourcePlan | undefined,
  input: Pick<z.infer<typeof queryInput>, 'source' | 'metric' | 'metricField' | 'groupBy'>,
) {
  if (!source) throw new ApiError(400, '报告数据源不存在或已失效，请重新选择');
  if (input.groupBy !== 'none' && !Object.hasOwn(source.expressions, input.groupBy))
    throw new ApiError(400, '分组字段不存在或已停用，请重新选择');
  if (['sum', 'average'].includes(input.metric)) {
    if (!input.metricField || !Object.hasOwn(source.numeric, input.metricField))
      throw new ApiError(400, '请选择当前数据源有效的数字属性');
  } else if (input.metricField) throw new ApiError(400, '计数指标不需要数字属性');
  return source;
}
function number(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const result = Number(value);
  if (!Number.isFinite(result)) throw new ApiError(400, '指标超出可显示范围，请缩小范围');
  return result;
}
function bucketLabel(key: string, labels: Record<string, string>) {
  const value: unknown = JSON.parse(key);
  if (value === null || value === '') return '未填写';
  const raw = String(value);
  if (Object.hasOwn(labels, raw)) return labels[raw];
  // Multi-select attributes are grouped by their whole selection. Every record
  // contributes once; a chart never silently inflates its denominator.
  if (raw.startsWith('[')) {
    try {
      const items: unknown = JSON.parse(raw);
      if (Array.isArray(items)) return items.join('、') || '未填写';
    } catch {
      /* Plain category. */
    }
  }
  return raw;
}
function fillMonths(buckets: ReportBucket[], input: z.infer<typeof queryInput>) {
  if (input.groupBy !== 'month' || input.bucketKey !== undefined) return buckets;
  const first = input.startDate?.slice(0, 7) || buckets[0]?.label;
  const last = input.endDate?.slice(0, 7) || buckets.at(-1)?.label;
  if (!first || !last) return buckets;
  const ordinal = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;
  const start = ordinal(first),
    end = ordinal(last);
  if (end - start >= 120) throw new ApiError(400, '月份趋势最多展示120个月，请缩小日期范围');
  const existing = new Map(buckets.map((bucket) => [bucket.label, bucket]));
  const result: ReportBucket[] = [];
  for (let index = start; index <= end; index++) {
    const month = `${Math.floor(index / 12)
      .toString()
      .padStart(4, '0')}-${((index % 12) + 1).toString().padStart(2, '0')}`;
    result.push(
      existing.get(month) || {
        key: JSON.stringify(month),
        label: month,
        value: input.metric === 'count' || input.metric === 'distinct_customers' ? 0 : null,
        count: 0,
        customerCount: 0,
      },
    );
  }
  return result;
}
export async function query(ctx: Context, body: unknown): Promise<ReportQueryResult> {
  const input = queryInput.parse(body);
  // Validate explicit trend spans before doing any aggregation work.
  if (input.groupBy === 'month' && input.startDate && input.endDate) fillMonths([], input);
  const source = validateQuery(
    (await plans(ctx)).find((plan) => plan.source.id === input.source),
    input,
  );
  const params: unknown[] = [ctx.workspaceId];
  const param = (value: unknown) => `$${params.push(value)}`;
  let where = source.where;
  if (input.customerId) {
    const customer = await ctx.tx.query(
      'SELECT id FROM customers WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL',
      [ctx.workspaceId, input.customerId],
    );
    if (!customer.rows.length) throw new ApiError(404, '公司不存在或无权访问');
    where += ` AND c.id=${param(input.customerId)}::uuid`;
  }
  if (input.customerType) where += ` AND c.type=${param(input.customerType)}`;
  if (input.startDate)
    where += ` AND (${source.date} AT TIME ZONE 'Asia/Shanghai')::date>=${param(input.startDate)}::date`;
  if (input.endDate)
    where += ` AND (${source.date} AT TIME ZONE 'Asia/Shanghai')::date<=${param(input.endDate)}::date`;
  const group = input.groupBy === 'none' ? "'全部'::text" : source.expressions[input.groupBy];
  const numeric = input.metricField ? source.numeric[input.metricField] : 'NULL::numeric';
  const aggregate =
    input.metric === 'count'
      ? 'count(*)'
      : input.metric === 'distinct_customers'
        ? 'count(DISTINCT customer_id)'
        : input.metric === 'sum'
          ? 'sum(numeric_value)'
          : 'avg(numeric_value)';
  const filter = input.bucketKey === undefined ? 'true' : `key=${param(input.bucketKey)}`;
  const prefix = `WITH base AS (SELECT ${source.id} AS id,${source.name} AS name,
    c.id AS customer_id,c.name AS customer_name,${source.project} AS project_id,${source.person} AS person_id,
    ${source.date} AS date,coalesce(to_jsonb(nullif((${group})::text,''))::text,'null') AS key,
    ${numeric} AS numeric_value FROM ${source.from} WHERE ${where}),
    filtered AS (SELECT * FROM base WHERE ${filter})`;
  const summary = (
    await ctx.tx.query<{
      value: unknown;
      total: number;
      value_count: number;
      customer_count: number;
    }>(
      `${prefix} SELECT ${aggregate} AS value,count(*)::int AS total,
       ${['sum', 'average'].includes(input.metric) ? 'count(numeric_value)' : 'count(*)'}::int AS value_count,
       count(DISTINCT customer_id)::int AS customer_count FROM filtered`,
      params,
    )
  ).rows[0];
  const buckets = (
    await ctx.tx.query<{ key: string; value: unknown; count: number; customer_count: number }>(
      `${prefix} SELECT key,${aggregate} AS value,count(*)::int AS count,count(DISTINCT customer_id)::int AS customer_count
    FROM filtered GROUP BY key ORDER BY ${input.groupBy === 'month' ? 'key' : 'value DESC NULLS LAST,key'}`,
      params,
    )
  ).rows;
  const rows = (
    await ctx.tx.query<ReportRow>(
      `${prefix} SELECT id,name,customer_id,customer_name,project_id,person_id,date FROM filtered
    ORDER BY date DESC,id DESC LIMIT ${param(input.limit)} OFFSET ${param(input.offset)}`,
      params,
    )
  ).rows;
  return {
    value: number(summary.value),
    valueCount: summary.value_count,
    total: summary.total,
    customerCount: summary.customer_count,
    buckets: fillMonths(
      buckets.map((bucket): ReportBucket => ({
        key: bucket.key,
        label: bucketLabel(bucket.key, source.labels[input.groupBy] || {}),
        value: number(bucket.value),
        count: bucket.count,
        customerCount: bucket.customer_count,
      })),
      input,
    ),
    rows,
    offset: input.offset,
    limit: input.limit,
    hasMore: input.offset + rows.length < summary.total,
    dateLabel: source.source.dateLabel,
    generatedAt: new Date().toISOString(),
  };
}
async function validateWidgets(ctx: Context, widgets: z.infer<typeof widgetInput>[]) {
  if (new Set(widgets.map((widget) => widget.id)).size !== widgets.length)
    throw new ApiError(400, '图表编号不能重复');
  const available = await plans(ctx);
  for (const widget of widgets) {
    validateQuery(
      available.find((source) => source.source.id === widget.source),
      widget,
    );
    if (widget.visualization === 'donut' && !['count', 'sum'].includes(widget.metric))
      throw new ApiError(400, '环形图仅支持记录数量或合计，避免重复分母');
    if (widget.visualization === 'line' && widget.groupBy !== 'month')
      throw new ApiError(400, '折线图需要按月份分组');
    if (widget.visualization === 'number' && widget.groupBy !== 'none')
      throw new ApiError(400, '数字图表无需分组');
  }
}
export async function dashboards(ctx: Context): Promise<ReportDashboard[]> {
  return (
    await ctx.tx.query<ReportDashboard>(
      `SELECT ${columns} FROM report_dashboards WHERE workspace_id=$1 AND actor_id=$2 ORDER BY updated_at DESC,id`,
      [ctx.workspaceId, ctx.actorId],
    )
  ).rows;
}
export async function dashboard(ctx: Context, id: string): Promise<ReportDashboard> {
  const row = (
    await ctx.tx.query<ReportDashboard>(
      `SELECT ${columns} FROM report_dashboards WHERE workspace_id=$1 AND actor_id=$2 AND id=$3`,
      [ctx.workspaceId, ctx.actorId, uuid.parse(id)],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, '报告不存在或无权访问');
  return row;
}
export async function createDashboard(ctx: Context, body: unknown): Promise<ReportDashboard> {
  const input = dashboardInput.parse(body);
  const analysis =
    input.activity_analysis == null
      ? null
      : await activityAnalysis.validateConfig(ctx, input.activity_analysis);
  await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `reports:${ctx.workspaceId}:${ctx.actorId}`,
  ]);
  if ((await dashboards(ctx)).length >= 50) throw new ApiError(400, '每人最多保存50个报告看板');
  await validateWidgets(ctx, input.widgets);
  return (
    await ctx.tx.query<ReportDashboard>(
      `INSERT INTO report_dashboards(workspace_id,actor_id,id,name,description,widgets,activity_analysis) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING ${columns}`,
      [
        ctx.workspaceId,
        ctx.actorId,
        randomUUID(),
        input.name,
        input.description,
        JSON.stringify(input.widgets),
        analysis === null ? null : JSON.stringify(analysis),
      ],
    )
  ).rows[0];
}
export async function updateDashboard(
  ctx: Context,
  id: string,
  body: unknown,
): Promise<ReportDashboard> {
  const { version, ...input } = z
    .strictObject({ ...dashboardInput.shape, version: z.number().int().positive() })
    .parse(body);
  const existing = await dashboard(ctx, id);
  const rawAnalysis =
    input.activity_analysis === undefined
      ? (existing.activity_analysis ?? null)
      : input.activity_analysis;
  const analysis =
    rawAnalysis === null ? null : await activityAnalysis.validateConfig(ctx, rawAnalysis);
  await validateWidgets(ctx, input.widgets);
  const row = (
    await ctx.tx.query<ReportDashboard>(
      `UPDATE report_dashboards SET name=$4,description=$5,widgets=$6::jsonb,activity_analysis=$8::jsonb WHERE workspace_id=$1 AND actor_id=$2 AND id=$3 AND version=$7 RETURNING ${columns}`,
      [
        ctx.workspaceId,
        ctx.actorId,
        id,
        input.name,
        input.description,
        JSON.stringify(input.widgets),
        version,
        analysis === null ? null : JSON.stringify(analysis),
      ],
    )
  ).rows[0];
  if (!row) throw new ApiError(409, '报告已在其他页面修改，请刷新后重新核对');
  return row;
}
export async function deleteDashboard(ctx: Context, id: string, body: unknown) {
  const { version } = z.strictObject({ version: z.number().int().positive() }).parse(body);
  await dashboard(ctx, id);
  const row = (
    await ctx.tx.query(
      'DELETE FROM report_dashboards WHERE workspace_id=$1 AND actor_id=$2 AND id=$3 AND version=$4 RETURNING id',
      [ctx.workspaceId, ctx.actorId, id, version],
    )
  ).rows[0];
  if (!row) throw new ApiError(409, '报告已在其他页面修改，请刷新后重新核对');
  return { deleted: true };
}
