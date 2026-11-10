export const attributeKinds = {
  text: '文本',
  number: '数字',
  select: '单选',
  multi_select: '多选',
} as const;
export type AttributeKind = keyof typeof attributeKinds;
export type AttributeValue = string | number | string[] | null;
export interface CompanyAttribute {
  id: string;
  name: string;
  kind: AttributeKind;
  description: string;
  options: string[];
  ai_enabled: boolean;
  guidance: string;
  archived: boolean;
  version: number;
}
export interface AttributeSource {
  id: string;
  kind: 'company' | 'record' | 'person' | 'project' | 'relationship' | 'attribute';
  title: string;
  body: string;
  quote?: string;
}
export interface CompanyAttributeValue {
  attribute_id: string;
  customer_id: string;
  value: AttributeValue;
  origin: 'manual' | 'ai';
  explanation: string;
  sources: AttributeSource[];
  generated_at: string | null;
  version: number;
  updated_at: string;
  sources_stale?: boolean;
}
export interface AttributeRun {
  id: string;
  customer_id: string;
  attribute_id: string;
  value: AttributeValue;
  explanation: string;
  missing: string[];
  sources: AttributeSource[];
  guidance: string;
  warnings: string[];
  model: string;
  created_at: string;
  state: 'preview' | 'applied';
}
export interface AttributeModelStatus {
  configured: boolean;
  can_manage: boolean;
  model: string;
  region: 'cn' | 'global';
}
export const attributeColumn = (id: string) => `attr:${id}`;
export function isEmptyAttributeValue(value: AttributeValue | undefined) {
  return (
    value == null ||
    (typeof value === 'string' && !value.trim()) ||
    (Array.isArray(value) && !value.length)
  );
}
export function formatAttributeValue(value: AttributeValue | undefined, origin?: 'manual' | 'ai') {
  return value == null
    ? origin === 'ai'
      ? '无相关信息'
      : '未填写'
    : Array.isArray(value)
      ? value.join('、')
      : String(value);
}
