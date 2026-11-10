import { dataTypes } from './data-model.js';
import type { AttributeSource } from './attributes.js';
export const customObjectIcons = [
  'box',
  'receipt',
  'file',
  'package',
  'briefcase',
  'tag',
  'calendar',
  'clipboard',
  'truck',
  'shopping-bag',
  'heart',
  'layers',
] as const;
export const customObjectColors = {
  gray: '#737780',
  blue: '#3979dc',
  green: '#24a576',
  purple: '#9261d8',
  pink: '#df5894',
  orange: '#df8a36',
  red: '#e35c63',
  cyan: '#25a1b8',
} as const;
export const customAttributeKinds = {
  text: dataTypes.text.name,
  number: dataTypes.number.name,
  currency: dataTypes.currency.name,
  date: dataTypes.date.name,
  timestamp: dataTypes.timestamp.name,
  checkbox: dataTypes.checkbox.name,
  rating: dataTypes.rating.name,
  select: '单选',
  multi_select: '多选',
} as const;
export type CustomAttributeKind = keyof typeof customAttributeKinds;
export type CustomValue = string | number | boolean | string[] | null;
export interface CustomObject {
  id: string;
  name: string;
  singular_name: string;
  slug: string;
  icon: (typeof customObjectIcons)[number];
  color: keyof typeof customObjectColors;
  version: number;
  record_count: number;
  attribute_count: number;
}
export interface CustomAttribute {
  id: string;
  object_id: string;
  name: string;
  description: string;
  kind: CustomAttributeKind;
  options: string[];
  required: boolean;
  is_unique: boolean;
  currency: 'CNY' | 'USD' | 'EUR' | 'GBP' | 'JPY';
  archived: boolean;
  ai_enabled: boolean;
  guidance: string;
  version: number;
}
export interface CustomAttributeProvenance {
  origin: 'manual' | 'ai';
  state: 'filled' | 'no_information';
  explanation: string;
  missing: string[];
  sources: AttributeSource[];
  evidence: { source_id: string; quote: string }[];
  generated_at: string | null;
  run_id: string | null;
  sources_stale?: boolean;
}
export interface CustomAttributeRun {
  id: string;
  object_id: string;
  record_id: string;
  customer_id: string;
  attribute_id: string;
  value: CustomValue;
  explanation: string;
  missing: string[];
  sources: AttributeSource[];
  evidence: { source_id: string; quote: string }[];
  guidance: string;
  warnings: string[];
  model: string;
  created_at: string;
  state: 'preview' | 'applied';
}
export interface CustomRecord {
  id: string;
  object_id: string;
  customer_id: string;
  project_id: string | null;
  name: string;
  values: Record<string, CustomValue>;
  field_provenance: Record<string, CustomAttributeProvenance>;
  version: number;
  customer_name: string;
  project_name: string | null;
  created_by_name: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  can_edit: boolean;
}
export function isEmptyCustomValue(value: CustomValue | undefined) {
  return (
    value == null ||
    (typeof value === 'string' && !value.trim()) ||
    (Array.isArray(value) && !value.length)
  );
}
export const customSystemAttributes = [
  { id: 'id', name: '记录编号', type: '文本', constraint: '唯一', readonly: true },
  { id: 'name', name: '名称', type: '文本', constraint: '必填' },
  { id: 'customer', name: '所属公司', type: '记录引用 · 公司', constraint: '必填' },
  { id: 'project', name: '关联项目', type: '记录引用 · 项目', constraint: '' },
  { id: 'created_at', name: '创建时间', type: '日期与时间', constraint: '', readonly: true },
  { id: 'created_by', name: '创建人', type: '用户', constraint: '', readonly: true },
] as const;
