import { customerTypes, customerStatuses, projectTypes, projectStages, sources } from './domain.js';
import type { RecordObject } from './views.js';
import { emailStrengthLabels, communicationColumns } from './communications.js';
export type FilterRule = {
  field: string;
  operator:
    'is' | 'is_not' | 'contains' | 'not_contains' | 'empty' | 'not_empty' | 'before' | 'after';
  value: string;
};
export type FilterGroup = { match: 'all' | 'any'; rules: FilterRule[] };
export type FilterField = {
  label: string;
  kind: 'text' | 'select' | 'member' | 'date';
  options?: Record<string, string>;
};
const communicationFilters: Record<string, FilterField> = {
  email_strength: {
    label: communicationColumns.email_strength,
    kind: 'select',
    options: emailStrengthLabels,
  },
  last_email_at: { label: communicationColumns.last_email_at, kind: 'date' },
  first_email_at: { label: communicationColumns.first_email_at, kind: 'date' },
  last_inbound_at: { label: communicationColumns.last_inbound_at, kind: 'date' },
  last_outbound_at: { label: communicationColumns.last_outbound_at, kind: 'date' },
};
export function filterFields(object: RecordObject): Record<string, FilterField> {
  if (object === 'people')
    return {
      name: { label: '姓名', kind: 'text' },
      customer_name: { label: '公司 / 客户', kind: 'text' },
      job_title: { label: '职位', kind: 'text' },
      email: { label: '邮箱', kind: 'text' },
      phone: { label: '电话', kind: 'text' },
      owner: { label: '负责人', kind: 'member' },
      updated_at: { label: '最近更新', kind: 'date' },
      created_at: { label: '创建时间', kind: 'date' },
      id: { label: 'Record ID', kind: 'text' },
      ...communicationFilters,
    };
  return object === 'customers'
    ? {
        name: { label: '客户名称', kind: 'text' },
        type: { label: '客户类型', kind: 'select', options: customerTypes },
        status: { label: '合作状态', kind: 'select', options: customerStatuses },
        source: { label: '来源', kind: 'select', options: sources },
        contact: { label: '联系人', kind: 'text' },
        email: { label: '邮箱', kind: 'text' },
        phone: { label: '电话', kind: 'text' },
        region: { label: '地区', kind: 'text' },
        owner: { label: '负责人', kind: 'member' },
        updated_at: { label: '最近更新', kind: 'date' },
        created_at: { label: '创建时间', kind: 'date' },
        ...communicationFilters,
      }
    : {
        name: { label: '项目名称', kind: 'text' },
        customer_name: { label: '所属客户', kind: 'text' },
        type: { label: '项目类型', kind: 'select', options: projectTypes },
        stage: { label: '项目阶段', kind: 'select', options: projectStages },
        owner: { label: '负责人', kind: 'member' },
        due_date: { label: '目标日期', kind: 'date' },
        updated_at: { label: '最近更新', kind: 'date' },
        created_at: { label: '创建时间', kind: 'date' },
      };
}
export const operatorLabels = {
  is: '是',
  is_not: '不是',
  contains: '包含',
  not_contains: '不包含',
  empty: '为空',
  not_empty: '不为空',
  before: '早于',
  after: '晚于',
};
export function fieldOperators(kind: FilterField['kind']): FilterRule['operator'][] {
  return [
    ...(kind === 'text'
      ? ['contains', 'not_contains', 'is', 'is_not']
      : kind === 'date'
        ? ['is', 'before', 'after']
        : ['is', 'is_not']),
    'empty',
    'not_empty',
  ] as FilterRule['operator'][];
}
