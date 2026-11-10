import { z } from 'zod';
import type { ListConfig, ListField } from '../shared/list-workflow.js';
import { ApiError } from './security.js';
export const amount = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/, '金额须为非负数字，最多两位小数');
export const listConfigSchema = z.strictObject({
  columns: z
    .array(z.union([z.uuid(), z.enum(['name', 'customer_name', 'email'])]))
    .min(1)
    .max(43),
  sort: z.union([z.uuid(), z.literal('name')]),
  direction: z.enum(['asc', 'desc']),
  group_by: z.uuid().nullable(),
  filters: z.strictObject({
    match: z.enum(['all', 'any']),
    rules: z
      .array(
        z.strictObject({
          field: z.union([z.uuid(), z.literal('name')]),
          operator: z.enum(['eq', 'not_eq', 'contains', 'gt', 'lt', 'is_set', 'is_not_set']),
          value: z.string().max(2000),
        }),
      )
      .max(15),
  }),
});
export function validateListConfig(config: ListConfig, all: ListField[]) {
  const active = all.filter((f) => !f.archived),
    ids = new Set(active.map((f) => f.id));
  if (
    config.columns[0] !== 'name' ||
    new Set(config.columns).size !== config.columns.length ||
    config.columns.some((id) => !['name', 'customer_name', 'email'].includes(id) && !ids.has(id))
  )
    throw new ApiError(400, '列配置包含无效字段');
  if (config.sort !== 'name' && !ids.has(config.sort)) throw new ApiError(400, '排序字段无效');
  if (config.group_by && !active.some((f) => f.id === config.group_by && f.kind === 'stage'))
    throw new ApiError(400, '看板须按当前清单的阶段字段分组');
  for (const r of config.filters.rules) {
    const field = active.find((f) => f.id === r.field);
    if (r.field !== 'name' && !field) throw new ApiError(400, '筛选字段无效');
    if (['is_set', 'is_not_set'].includes(r.operator)) continue;
    if (!r.value.trim()) throw new ApiError(400, '请填写筛选值');
    if (r.operator === 'contains' && field && field.kind !== 'text')
      throw new ApiError(400, '此字段不支持包含筛选');
    if (['gt', 'lt'].includes(r.operator) && !['date', 'currency'].includes(field?.kind || ''))
      throw new ApiError(400, '只有日期和金额支持大小比较');
    if (field?.kind === 'stage' && !field.options.some((o) => o.id === r.value))
      throw new ApiError(400, '筛选阶段无效');
    if (field?.kind === 'member') z.uuid().parse(r.value);
    if (field?.kind === 'date') z.iso.date().parse(r.value);
    if (field?.kind === 'currency') amount.parse(r.value);
  }
}
