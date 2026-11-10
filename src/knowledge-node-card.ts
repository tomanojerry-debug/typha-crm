import { customerStatuses, customerTypes, projectStages, projectTypes } from '../shared/domain';
import type { KnowledgeGraphNode } from '../shared/knowledge';

export interface KnowledgeCardSchemaObject {
  id: string;
  name: string;
  attributes: {
    id: string;
    name: string;
    type: string;
    storage_key?: string;
    currency?: string;
    option_labels?: Record<string, string>;
    system?: boolean;
  }[];
}

export interface KnowledgeNodeDescription {
  typeLabel: string;
  rows: { label: string; value: string }[];
  kind: 'company' | 'person' | 'project' | 'custom' | 'claim' | 'candidate';
}

type Field = KnowledgeCardSchemaObject['attributes'][number];
const objectLabels: Record<string, string> = {
  customers: '公司',
  people: '联系人',
  projects: '项目',
};
const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const technicalFields = new Set([
  'id',
  'workspace_id',
  'object_id',
  'canonical_id',
  'owner_id',
  'created_by',
  'source_ids',
  'record_ids',
  'field_provenance',
  'version',
]);
const ordinaryTypes = new Set([
  'text',
  'number',
  'currency',
  'date',
  'timestamp',
  'checkbox',
  'rating',
  'select',
  'multi_select',
]);
const currencies = new Set(['CNY', 'USD', 'EUR', 'GBP', 'JPY']);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || uuid.test(trimmed) || /^[{[]/.test(trimmed)) return null;
  return trimmed.replace(/\s+/g, ' ');
}

function dateValue(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function formatValue(type: string, value: unknown, field?: Partial<Field>): string | null {
  if (value === null || value === undefined) return null;
  if (['text', 'email', 'phone', 'url', 'domain', 'status'].includes(type)) return text(value);
  if (type === 'number')
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  if (type === 'currency')
    return typeof value === 'number' &&
      Number.isFinite(value) &&
      field?.currency &&
      currencies.has(field.currency)
      ? `${value} ${field.currency}`
      : null;
  if (type === 'checkbox' || type === 'boolean')
    return typeof value === 'boolean' ? (value ? '是' : '否') : null;
  if (type === 'rating')
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5
      ? `${value} / 5`
      : null;
  if (type === 'date') return dateValue(value);
  if (type === 'timestamp') {
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
      !dateValue(value.slice(0, 10)) ||
      !Number.isFinite(Date.parse(value))
    )
      return null;
    return new Date(value).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  if (type === 'select' || type === 'multi_select') {
    const values = Array.isArray(value) ? value : [value];
    if (!values.length) return null;
    const labels = values.map((item) => {
      if (typeof item !== 'string') return null;
      return field?.option_labels
        ? Object.hasOwn(field.option_labels, item)
          ? text(field.option_labels[item])
          : null
        : text(item);
    });
    return labels.every((label) => label !== null) ? labels.join('、') : null;
  }
  return null;
}

function enumValue(values: Record<string, string>, value: unknown): string | null {
  return typeof value === 'string' && Object.hasOwn(values, value) ? values[value] : null;
}

/** A display-only whitelist. Never enriches a candidate from its canonical CRM ID. */
export function describeKnowledgeNode(
  node: KnowledgeGraphNode,
  schemaObjects: readonly KnowledgeCardSchemaObject[] | null | undefined,
  nodes: readonly KnowledgeGraphNode[],
): KnowledgeNodeDescription {
  const object = schemaObjects?.find((item) => item.id === node.object_id);
  const typeLabel =
    (node.object_id ? objectLabels[node.object_id] : null) || text(object?.name) || '自定义记录';
  const rows: KnowledgeNodeDescription['rows'] = [];
  const add = (label: string, value: string | null) => {
    if (rows.length < 2 && value !== null) rows.push({ label, value });
  };
  const attributes = node.attributes;
  if (node.origin === 'candidate')
    return {
      kind: 'candidate',
      typeLabel: node.object_id ? typeLabel : '识别实体',
      rows,
    };
  if (node.origin === 'claim') {
    const typedValue = record(attributes.value);
    if (typedValue && typeof typedValue.type === 'string') {
      const formatted = formatValue(typedValue.type, typedValue.value, {
        currency: typeof typedValue.currency === 'string' ? typedValue.currency : undefined,
      });
      const unit = text(typedValue.unit);
      add('提取值', formatted === null ? null : `${formatted}${unit ? ` ${unit}` : ''}`);
    }
    add('提出者', text(attributes.speaker));
    return { kind: 'claim', typeLabel: '信息主张', rows };
  }
  if (node.object_id === 'customers') {
    add('客户类型', enumValue(customerTypes, attributes.type));
    add('合作状态', enumValue(customerStatuses, attributes.status));
    return { kind: 'company', typeLabel, rows };
  }
  if (node.object_id === 'people') {
    add('职位', text(attributes.job_title));
    add('邮箱', text(attributes.email));
    add('电话', text(attributes.phone));
    return { kind: 'person', typeLabel, rows };
  }
  if (node.object_id === 'projects') {
    add('阶段', enumValue(projectStages, attributes.stage));
    add('目标日期', dateValue(attributes.due_date));
    add('项目类型', enumValue(projectTypes, attributes.type));
    return { kind: 'project', typeLabel, rows };
  }

  const values = record(attributes.values);
  const customAttributes = Array.isArray(attributes.custom_attributes)
    ? attributes.custom_attributes.map(record).filter((item) => item !== null)
    : [];
  for (const field of object?.attributes || []) {
    const storedKey = field.storage_key || field.id.split(':').at(-1)!;
    if (
      field.system ||
      technicalFields.has(storedKey) ||
      !ordinaryTypes.has(field.type) ||
      !text(field.name)
    )
      continue;
    const value =
      values && Object.hasOwn(values, field.id)
        ? values[field.id]
        : customAttributes.find((item) => item.attribute_id === field.id)?.value;
    add(field.name, formatValue(field.type, value, field));
  }
  for (const field of object?.attributes || []) {
    if (rows.length === 2) break;
    if (field.type !== 'record_reference' || !text(field.name)) continue;
    const storedKey = field.storage_key || field.id.split(':').at(-1)!;
    const value =
      values && Object.hasOwn(values, field.id) ? values[field.id] : attributes[storedKey];
    if (typeof value !== 'string') continue;
    const expectedObject =
      storedKey === 'customer_id' ? 'customers' : storedKey === 'project_id' ? 'projects' : null;
    const referred = nodes.filter(
      (item) =>
        item.origin === 'crm' &&
        item.group === node.group &&
        item.id === value &&
        (!expectedObject || item.object_id === expectedObject),
    );
    add(field.name, referred.length === 1 ? text(referred[0].name) : null);
  }
  return { kind: 'custom', typeLabel, rows };
}
