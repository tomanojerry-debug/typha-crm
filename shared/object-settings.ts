import { dataTypes, type DataType } from './data-model.js';
import { filterFields } from './filters.js';
import { communicationColumns, emailStrengthHelp } from './communications.js';
import {
  cardinalities,
  type Cardinality,
  type ObjectKind,
  type RelationDefinition,
} from './connections.js';

export interface SystemAttribute {
  id: string;
  name: string;
  type: string;
  description: string;
  options?: string[];
  constraints?: string[];
  automated?: boolean;
  properties?: string[];
  valueType?: DataType;
}

export function systemAttributes(object: ObjectKind): SystemAttribute[] {
  const result: SystemAttribute[] = Object.entries(filterFields(object))
    .filter(([id]) => id !== 'customer_name')
    .map(([id, field]) => ({
      id,
      name: id === 'id' ? '记录编号' : id === 'contact' ? '主要联系人姓名' : field.label,
      type:
        id === 'email'
          ? '邮箱'
          : id === 'phone'
            ? '电话'
            : id === 'due_date'
              ? dataTypes.date.name
              : field.kind === 'date'
                ? dataTypes.timestamp.name
                : id === 'stage'
                  ? dataTypes.status.name
                  : { text: '文本', select: '单选', member: '用户' }[
                      field.kind as 'text' | 'select' | 'member'
                    ],
      description:
        id === 'email_strength'
          ? emailStrengthHelp
          : id in communicationColumns
            ? '根据已归属当前客户的邮件计算。'
            : ['created_at', 'updated_at', 'id'].includes(id)
              ? '由系统维护。'
              : id === 'owner' && object === 'people'
                ? '继承所属公司的负责人。'
                : '系统内置字段；具体值在记录档案中维护。',
      options: field.options ? Object.values(field.options) : undefined,
      constraints:
        id === 'id'
          ? ['唯一']
          : ['name', 'type'].includes(id) || (object === 'customers' && id === 'source')
            ? ['必填']
            : [],
      properties:
        id in communicationColumns ||
        ['created_at', 'updated_at', 'id'].includes(id) ||
        (object === 'people' && id === 'owner')
          ? ['只读']
          : [],
      valueType:
        id === 'email'
          ? 'email'
          : id === 'phone'
            ? 'phone'
            : id === 'due_date'
              ? 'date'
              : field.kind === 'date'
                ? 'timestamp'
                : id === 'stage'
                  ? 'status'
                  : field.kind === 'member'
                    ? 'actor_reference'
                    : field.kind === 'select'
                      ? 'select'
                      : 'text',
      automated: id in communicationColumns,
    }));
  if (!result.some((f) => f.id === 'id'))
    result.push({
      id: 'id',
      name: '记录编号',
      type: '文本',
      description: '由系统维护。',
      options: undefined,
      constraints: ['唯一'],
      properties: ['只读'],
      valueType: 'text',
    });
  if (object !== 'projects')
    result.push({
      id: 'email_count',
      name: communicationColumns.email_count,
      type: '数字',
      description: '按明确归属的邮件去重计算。',
      options: undefined,
      constraints: [],
      properties: ['只读'],
      automated: true,
      valueType: 'number',
    });
  if (object !== 'customers')
    result.push({
      id: 'description',
      name: object === 'people' ? '备注' : '项目说明',
      type: '文本',
      description: '在记录档案中维护。',
      options: undefined,
      valueType: 'text',
    });
  if (object === 'people')
    result.push({
      id: 'is_primary',
      name: '主要联系人',
      type: '复选框',
      description: '在联系人档案中设置，标记当前公司的主要联系人。',
      options: undefined,
      valueType: 'checkbox',
    });
  return result.sort((a, b) => (a.id === 'id' ? -1 : b.id === 'id' ? 1 : 0));
}

export const systemRelationships: RelationDefinition[] = [
  {
    id: 'system-company-people',
    source_object: 'customers',
    target_object: 'people',
    source_label: '公司联系人',
    target_label: '所属公司',
    cardinality: 'one_to_many',
  },
  {
    id: 'system-company-projects',
    source_object: 'customers',
    target_object: 'projects',
    source_label: '公司项目',
    target_label: '所属公司',
    cardinality: 'one_to_many',
  },
];

export function reverseCardinality(value: Cardinality): Cardinality {
  return value === 'one_to_many' ? 'many_to_one' : value === 'many_to_one' ? 'one_to_many' : value;
}

export function relationAttributes(definitions: RelationDefinition[], object: ObjectKind) {
  return definitions.flatMap((d) => [
    ...(d.source_object === object
      ? [
          {
            id: `${d.id}:source`,
            name: d.source_label,
            inverse: d.target_label,
            object: d.target_object,
            cardinality: d.cardinality,
            definition: d,
          },
        ]
      : []),
    ...(d.target_object === object
      ? [
          {
            id: `${d.id}:target`,
            name: d.target_label,
            inverse: d.source_label,
            object: d.source_object,
            cardinality: reverseCardinality(d.cardinality),
            definition: d,
          },
        ]
      : []),
  ]);
}

export function relationshipLimits(cardinality: Cardinality) {
  return {
    label: cardinalities[cardinality],
    targets: cardinality.endsWith('many') ? '多个' : '一个',
    sources: cardinality.startsWith('many') ? '多个' : '一个',
  };
}
