// Product vocabulary. Availability is separate from the underlying type.
// Values, evidence and rollout: docs/21-data-model-and-attribute-catalog.md.
export const dataTypes = {
  text: { name: '文本', group: 'basic', shape: 'string' },
  email: { name: '邮箱', group: 'contact', shape: 'email string' },
  phone: { name: '电话', group: 'contact', shape: 'phone string' },
  url: { name: '链接', group: 'contact', shape: 'URL string' },
  domain: { name: '域名', group: 'contact', shape: 'hostname string' },
  number: { name: '数字', group: 'basic', shape: 'finite number' },
  currency: { name: '金额', group: 'basic', shape: 'number + attribute currency' },
  checkbox: { name: '复选框', group: 'basic', shape: 'boolean' },
  date: { name: '日期', group: 'time', shape: 'YYYY-MM-DD' },
  timestamp: { name: '日期与时间', group: 'time', shape: 'ISO timestamp with timezone' },
  rating: { name: '评分', group: 'basic', shape: 'integer 1..5' },
  select: { name: '选择', group: 'choice', shape: 'option or option[]' },
  status: { name: '流程状态', group: 'choice', shape: 'single stage' },
  actor_reference: { name: '用户', group: 'reference', shape: 'workspace actor ID' },
  record_reference: { name: '记录引用', group: 'reference', shape: 'object ID + record ID' },
  location: { name: '地址', group: 'composite', shape: 'country,region,city,postcode,street' },
  file: { name: '附件', group: 'reference', shape: 'authorized file ID + metadata' },
} as const;
export type DataType = keyof typeof dataTypes;
export const dataModelVersion = 'typha-data-model-v1';
export function customKindSemantics(kind: string): { type: DataType; multiple: boolean } {
  if (kind === 'multi_select') return { type: 'select', multiple: true };
  if (kind === 'member') return { type: 'actor_reference', multiple: false };
  if (kind === 'stage') return { type: 'status', multiple: false };
  if (Object.hasOwn(dataTypes, kind)) return { type: kind as DataType, multiple: false };
  throw new Error(`Unknown attribute kind: ${kind}`);
}
