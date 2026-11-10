import { z } from 'zod';
import { filterFields, fieldOperators, type FilterGroup } from '../shared/filters.js';
import type { RecordObject } from '../shared/views.js';
import { ApiError, type Context } from './security.js';
import { communicationSorts } from './communications.js';
export const filterGroup = z.strictObject({
  match: z.enum(['all', 'any']),
  rules: z
    .array(
      z.strictObject({
        field: z.string().max(40),
        operator: z.enum([
          'is',
          'is_not',
          'contains',
          'not_contains',
          'empty',
          'not_empty',
          'before',
          'after',
        ]),
        value: z.string().max(200),
      }),
    )
    .max(20),
});
export function validateFilters(value: FilterGroup, object: RecordObject) {
  const fields = filterFields(object);
  for (const rule of value.rules) {
    const field = Object.hasOwn(fields, rule.field) ? fields[rule.field] : undefined;
    if (!field || !fieldOperators(field.kind).includes(rule.operator))
      throw new ApiError(400, '筛选字段或运算符不受支持');
    if (['empty', 'not_empty'].includes(rule.operator)) continue;
    if (field.kind === 'select' && !Object.hasOwn(field.options!, rule.value))
      throw new ApiError(400, '筛选选项不受支持');
    if (field.kind === 'member' && rule.value !== 'me' && !z.uuid().safeParse(rule.value).success)
      throw new ApiError(400, '负责人筛选值无效');
    if (field.kind === 'date' && !z.iso.date().safeParse(rule.value).success)
      throw new ApiError(400, '筛选日期无效');
  }
}
export function filterSQL(
  ctx: Context,
  object: RecordObject,
  raw: string | undefined,
  params: unknown[],
) {
  if (!raw) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, '筛选条件格式无效');
  }
  const group = filterGroup.parse(parsed);
  validateFilters(group, object);
  if (!group.rules.length) return '';
  const prefix = object === 'customers' ? 'c' : 'p';
  const fields = filterFields(object);
  const clauses = group.rules.map((rule) => {
    const field = fields[rule.field];
    const computed = Object.hasOwn(communicationSorts, rule.field);
    const column = computed
      ? communicationSorts[rule.field]
      : rule.field === 'customer_name'
        ? 'c.name'
        : rule.field === 'owner' && object === 'people'
          ? 'c.owner_id'
          : `${prefix}.${rule.field === 'contact' ? 'contact_name' : rule.field === 'owner' ? 'owner_id' : rule.field}`;
    const expr =
      field.kind === 'date'
        ? `to_char(${column}${computed ? " AT TIME ZONE 'Asia/Shanghai'" : ''}, 'YYYY-MM-DD')`
        : `${column}::text`;
    if (rule.operator === 'empty') return `coalesce(${expr},'') = ''`;
    if (rule.operator === 'not_empty') return `coalesce(${expr},'') <> ''`;
    params.push(field.kind === 'member' && rule.value === 'me' ? ctx.actorId : rule.value);
    const param = `$${params.length}`;
    if (rule.operator === 'contains')
      return `position(lower(${param}) in lower(coalesce(${expr},''))) > 0`;
    if (rule.operator === 'not_contains')
      return `position(lower(${param}) in lower(coalesce(${expr},''))) = 0`;
    const operator = { is: '=', is_not: '<>', before: '<', after: '>' }[rule.operator];
    return field.kind === 'date'
      ? `(${expr} IS NOT NULL AND ${expr} ${operator} ${param})`
      : `lower(coalesce(${expr},'')) ${operator} lower(${param})`;
  });
  return ` AND (${clauses.join(group.match === 'any' ? ' OR ' : ' AND ')})`;
}
