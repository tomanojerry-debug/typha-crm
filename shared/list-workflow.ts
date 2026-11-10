export const fieldTypes = {
  stage: '阶段',
  member: '负责人',
  date: '日期',
  currency: '金额',
  text: '文本',
} as const;
export const stageColors = {
  gray: '#9299a5',
  blue: '#4f85df',
  cyan: '#43aabe',
  purple: '#9b77d4',
  orange: '#d79848',
  green: '#48a583',
} as const;
export type FieldKind = keyof typeof fieldTypes;
export interface StageOption {
  id: string;
  label: string;
  color: keyof typeof stageColors;
}
export interface ListField {
  id: string;
  name: string;
  kind: FieldKind;
  options: StageOption[];
  currency: 'CNY' | 'USD' | 'EUR';
  position: number;
  archived: boolean;
  version: number;
}
export type ListValue = string | null;
export interface WorkflowEntry {
  id: string;
  customer_id: string;
  project_id: string | null;
  person_id: string | null;
  name: string;
  customer_name: string;
  email: string;
  field_values: Record<string, ListValue>;
  version: number;
  can_edit: boolean;
}
export const listOperators = {
  eq: '等于',
  not_eq: '不等于',
  contains: '包含',
  gt: '大于 / 晚于',
  lt: '小于 / 早于',
  is_set: '已填写',
  is_not_set: '未填写',
} as const;
export interface ListRule {
  field: string;
  operator: keyof typeof listOperators;
  value: string;
}
export interface ListConfig {
  columns: string[];
  sort: string;
  direction: 'asc' | 'desc';
  group_by: string | null;
  filters: { match: 'all' | 'any'; rules: ListRule[] };
}
export interface WorkflowResult {
  items: WorkflowEntry[];
  total: number;
  page: number;
  page_size: number;
  groups: Record<string, number>;
  sums: Record<string, string>;
}
export function defaultListConfig(fields: ListField[]): ListConfig {
  return {
    columns: ['name', ...fields.filter((f) => !f.archived).map((f) => f.id)],
    sort: 'name',
    direction: 'asc',
    group_by: fields.find((f) => !f.archived && f.kind === 'stage')?.id || null,
    filters: { match: 'all', rules: [] },
  };
}
