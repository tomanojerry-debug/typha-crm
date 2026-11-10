import { z } from 'zod';
import type {
  ActivityAnalysisBucket,
  ActivityAnalysisCatalog,
  ActivityAnalysisConfig,
  ActivityAnalysisDimension,
  ActivityAnalysisResult,
  ActivityAnalysisRow,
} from '../shared/activity-analysis.js';
import type { ActivityField, BusinessActivity } from '../shared/business-activities.js';
import { activityBaseField } from '../shared/business-activities.js';
import type { KnowledgeSource } from '../shared/knowledge.js';
import { activityAnalysisSources, schemas, types } from './business-activities.js';
import { ApiError, type Context } from './security.js';
import { sourceMaterials } from './source-index.js';

const dimensions: ActivityAnalysisDimension[] = [
  'product',
  'issue',
  'version',
  'size',
  'color',
  'stage',
];
const fieldId = z.string().min(1).max(100);
const configInput = z.strictObject({
  typeId: z.uuid(),
  fields: z.strictObject({
    product: fieldId,
    issue: fieldId,
    version: fieldId.optional(),
    size: fieldId.optional(),
    color: fieldId.optional(),
    stage: fieldId.optional(),
    case: fieldId.optional(),
  }),
});
const date = z.iso.date().refine((value) => !value.startsWith('0000-'), '日期无效');
const queryInput = z
  .strictObject({
    config: configInput,
    startDate: date.optional(),
    endDate: date.optional(),
    customerId: z.uuid().optional(),
    customerType: z.enum(['distributor', 'group', 'retail']).optional(),
    product: z.string().min(1).max(5000).optional(),
    version: z.string().min(1).max(5000).optional(),
    issue: z.string().min(1).max(5000).optional(),
    stage: z.string().min(1).max(5000).optional(),
    size: z.string().min(1).max(5000).optional(),
    color: z.string().min(1).max(5000).optional(),
    offset: z.number().int().min(0).max(10000000).default(0),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .refine((input) => !input.startDate || !input.endDate || input.startDate <= input.endDate, {
    message: '开始日期不能晚于结束日期',
  });

export async function catalog(ctx: Context): Promise<ActivityAnalysisCatalog> {
  const [activityTypes, activitySchemas] = await Promise.all([types(ctx), schemas(ctx)]);
  const liveSchemas = new Set(
    activitySchemas
      .filter(
        (schema) =>
          !schema.archived &&
          (!schema.parent_id ||
            activitySchemas.some((parent) => parent.id === schema.parent_id && !parent.archived)),
      )
      .map((schema) => schema.id),
  );
  return {
    types: activityTypes
      .filter((type) => !type.archived && liveSchemas.has(type.schema_id))
      .map((type) => ({
        id: type.id,
        name: type.name,
        schema_name: type.schema_name,
        fields: type.effective_fields,
      })),
  };
}

async function mapping(ctx: Context, raw: unknown) {
  const config = configInput.parse(raw);
  const type = (await catalog(ctx)).types.find((item) => item.id === config.typeId);
  if (!type) throw new ApiError(400, '分析活动类型已失效、归档或无权访问，请重新配置');
  const mapped = new Map<string, ActivityField>();
  const used = new Set<string>();
  for (const [dimension, id] of Object.entries(config.fields)) {
    const field = type.fields.find((item) => item.id === id);
    if (
      !field ||
      !['text', 'select', ...(dimension === 'issue' ? ['multi_select'] : [])].includes(field.kind)
    )
      throw new ApiError(400, '分析字段已失效或类型不受支持，请重新配置');
    if (used.has(id)) throw new ApiError(400, '不同分析维度请分别选择字段');
    used.add(id);
    mapped.set(dimension, field);
  }
  return { config, mapped };
}

export async function validateConfig(ctx: Context, raw: unknown): Promise<ActivityAnalysisConfig> {
  return (await mapping(ctx, raw)).config;
}

type ActivityRow = BusinessActivity & {
  customer_name: string;
  source_versions: Record<string, string>;
};
type PreparedRow = {
  row: ActivityAnalysisRow;
  sourceKeys: Set<string>;
  evidenceKey: string | null;
};

function fieldValue(activity: ActivityRow, field: ActivityField): string[] | null {
  const snapshot = activity.fields.find((candidate) => candidate.id === field.id);
  if (!snapshot || snapshot.kind !== field.kind) return null;
  const value = activity.values[field.id];
  if (value === null || value === undefined || value === '') return [];
  if (field.kind === 'multi_select') {
    if (
      !Array.isArray(value) ||
      value.some((item) => typeof item !== 'string' || !field.options.includes(item)) ||
      new Set(value).size !== value.length
    )
      return null;
    return [...value].sort();
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (field.kind === 'select' && !field.options.includes(trimmed)) return null;
  return [trimmed];
}

function semantic(row: ActivityAnalysisRow) {
  return JSON.stringify([row.product, row.issues, row.version, row.size, row.color, row.stage]);
}

function merge(rows: PreparedRow[]): PreparedRow {
  const ordered = [...rows].sort(
    (a, b) =>
      (a.row.occurred_at ? Date.parse(a.row.occurred_at) : Infinity) -
        (b.row.occurred_at ? Date.parse(b.row.occurred_at) : Infinity) ||
      a.row.id.localeCompare(b.row.id),
  );
  const sourceKeys = new Set(ordered.flatMap((item) => [...item.sourceKeys]));
  return {
    row: {
      ...ordered[0].row,
      merged_ids: ordered.flatMap((item) => item.row.merged_ids).sort(),
      source_count: sourceKeys.size,
    },
    sourceKeys,
    evidenceKey: ordered[0].evidenceKey,
  };
}

function deduplicate(input: PreparedRow[]) {
  const cases = new Map<string, PreparedRow[]>();
  const evidence = new Map<string, PreparedRow[]>();
  const separate: PreparedRow[] = [];
  for (const item of input) {
    if (item.row.case_id) {
      const key = JSON.stringify([item.row.customer_id, item.row.case_id]);
      cases.set(key, [...(cases.get(key) || []), item]);
    } else if (item.evidenceKey && !item.row.review_required) {
      const key = JSON.stringify([
        item.row.customer_id,
        item.evidenceKey,
        semantic(item.row),
        item.row.occurred_at,
      ]);
      evidence.set(key, [...(evidence.get(key) || []), item]);
    } else separate.push(item);
  }
  for (const group of cases.values()) {
    if (
      new Set(group.map((item) => semantic(item.row))).size > 1 ||
      group.some((item) => item.row.review_required)
    ) {
      separate.push(
        ...group.map((item) => ({
          ...item,
          row: {
            ...item.row,
            review_required: true,
            review_reason: item.row.review_reason || ('case_conflict' as const),
          },
        })),
      );
    } else separate.push(merge(group));
  }
  separate.push(...[...evidence.values()].map(merge));
  return separate;
}

function buckets(
  rows: PreparedRow[],
  dimension: ActivityAnalysisDimension,
): ActivityAnalysisBucket[] {
  const groups = new Map<string | null, { count: number; customers: Set<string> }>();
  for (const { row } of rows) {
    const values =
      dimension === 'issue' ? (row.issues.length ? row.issues : [null]) : [row[dimension]];
    for (const value of values) {
      const group = groups.get(value) || { count: 0, customers: new Set<string>() };
      group.count++;
      group.customers.add(row.customer_id);
      groups.set(value, group);
    }
  }
  return [...groups]
    .map(([key, group]) => ({
      key,
      label: key ?? '未填写',
      feedback_count: group.count,
      customer_count: group.customers.size,
    }))
    .sort(
      (a, b) => b.feedback_count - a.feedback_count || (a.key || '').localeCompare(b.key || ''),
    );
}

/** Exact read-only aggregation, with current RLS and source validation before
 * grouping. No model, extraction, communication or business writes run here. */
export async function query(ctx: Context, raw: unknown): Promise<ActivityAnalysisResult> {
  const input = queryInput.parse(raw);
  const { config, mapped } = await mapping(ctx, input.config);
  for (const dimension of dimensions)
    if (input[dimension] !== undefined && !mapped.has(dimension))
      throw new ApiError(400, '当前分析未配置此筛选维度');
  const params: unknown[] = [ctx.workspaceId, config.typeId];
  let where = `a.workspace_id=$1 AND a.type_id=$2 AND NOT a.archived
AND c.archived_at IS NULL AND (a.project_id IS NULL OR (p.id IS NOT NULL AND p.archived_at IS NULL))`;
  if (input.customerId) {
    params.push(input.customerId);
    where += ` AND a.customer_id=$${params.length}`;
  }
  if (input.customerType) {
    params.push(input.customerType);
    where += ` AND c.type=$${params.length}`;
  }
  const activities = (
    await ctx.tx.query<ActivityRow>(
      `SELECT a.*,c.name AS customer_name FROM business_activities a
JOIN customers c ON c.workspace_id=a.workspace_id AND c.id=a.customer_id
LEFT JOIN projects p ON p.workspace_id=a.workspace_id AND p.customer_id=a.customer_id AND p.id=a.project_id
WHERE ${where} ORDER BY a.id LIMIT 5001`,
      params,
    )
  ).rows;
  if (activities.length > 5000)
    throw new ApiError(
      413,
      '此活动类型在当前客户范围内超过5000条，请缩小客户范围后分析；没有截断统计',
    );
  const cache = new Map<string, KnowledgeSource[]>();
  const prepared: PreparedRow[] = [];
  let invalidSources = 0;
  for (const activity of activities) {
    if (!cache.has(activity.customer_id))
      cache.set(activity.customer_id, await sourceMaterials(ctx, activity.customer_id));
    let source;
    try {
      source = activityAnalysisSources(activity, cache.get(activity.customer_id)!, [
        ...new Set([
          ...[...mapped.values()].map((field) => field.id),
          ...Object.keys(activity.field_provenance),
          activityBaseField.title,
          activityBaseField.occurred,
        ]),
      ]);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
      invalidSources++;
      continue;
    }
    const values = new Map<string, string[]>();
    let invalidValue = false;
    for (const [dimension, field] of mapped) {
      const value = fieldValue(activity, field);
      if (value === null) invalidValue = true;
      values.set(dimension, value || []);
    }
    prepared.push({
      row: {
        id: activity.id,
        title: activity.title,
        customer_id: activity.customer_id,
        customer_name: activity.customer_name,
        project_id: activity.project_id,
        occurred_at: activity.occurred_at ? new Date(activity.occurred_at).toISOString() : null,
        product: values.get('product')?.[0] ?? null,
        issues: values.get('issue') || [],
        version: values.get('version')?.[0] ?? null,
        size: values.get('size')?.[0] ?? null,
        color: values.get('color')?.[0] ?? null,
        stage: values.get('stage')?.[0] ?? null,
        case_id: values.get('case')?.[0] ?? null,
        merged_ids: [activity.id],
        source_count: source.source_keys.length,
        review_required: invalidValue,
        review_reason: invalidValue ? 'invalid_value' : null,
      },
      sourceKeys: new Set(source.source_keys),
      evidenceKey: source.evidence_key,
    });
  }
  const unknownDates = prepared.filter((item) => !item.row.occurred_at).length;
  const hasDateFilter = Boolean(input.startDate || input.endDate);
  const deduplicated = deduplicate(prepared);
  const excludedUnknownDates = hasDateFilter
    ? deduplicated
        .filter((item) => !item.row.occurred_at)
        .reduce((count, item) => count + item.row.merged_ids.length, 0)
    : 0;
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const matched = deduplicated
    .filter(({ row }) => {
      if (hasDateFilter) {
        if (!row.occurred_at) return false;
        const day = dateFormatter.format(new Date(row.occurred_at));
        if (input.startDate && day < input.startDate) return false;
        if (input.endDate && day > input.endDate) return false;
      }
      return dimensions.every(
        (dimension) =>
          input[dimension] === undefined ||
          (dimension === 'issue'
            ? row.issues.includes(input.issue!)
            : row[dimension] === input[dimension]),
      );
    })
    .sort(
      (a, b) =>
        (b.row.occurred_at ? Date.parse(b.row.occurred_at) : -Infinity) -
          (a.row.occurred_at ? Date.parse(a.row.occurred_at) : -Infinity) ||
        a.row.id.localeCompare(b.row.id),
    );
  const valid = matched.filter((item) => !item.row.review_required);
  const groups = Object.fromEntries(
    dimensions.map((dimension) => [
      dimension,
      mapped.has(dimension) ? buckets(valid, dimension) : [],
    ]),
  ) as ActivityAnalysisResult['groups'];
  const missing = Object.fromEntries(
    dimensions
      .filter((dimension) => mapped.has(dimension))
      .map((dimension) => [
        dimension,
        valid.filter(({ row }) =>
          dimension === 'issue' ? !row.issues.length : row[dimension] === null,
        ).length,
      ]),
  );
  return {
    summary: {
      feedback_count: valid.length,
      customer_count: new Set(valid.map((item) => item.row.customer_id)).size,
      activity_count: valid.reduce((sum, item) => sum + item.row.merged_ids.length, 0),
      source_count: new Set(valid.flatMap((item) => [...item.sourceKeys])).size,
    },
    groups,
    coverage: {
      scanned_count: activities.length,
      invalid_source_count: invalidSources,
      unknown_date_count: unknownDates,
      unknown_date_excluded_count: excludedUnknownDates,
      pending_review_count: matched.filter((item) => item.row.review_required).length,
      duplicate_activity_count: valid.reduce(
        (sum, item) => sum + item.row.merged_ids.length - 1,
        0,
      ),
      missing_values: missing,
      deduplication:
        '同客户的显式事项编号且全部映射值一致才合并；否则仅合并相同原文定位、来源版本、映射值及发生时间的重复活动。不同渠道和相似文字不推断同一事项。同编号映射冲突待核对且不计正式数；多问题分布不可相加。日期使用最早有依据的发生时间，不以创建时间补空。',
      max_activities: 5000,
    },
    rows: matched.slice(input.offset, input.offset + input.limit).map((item) => item.row),
    total: matched.length,
    offset: input.offset,
    limit: input.limit,
  };
}
