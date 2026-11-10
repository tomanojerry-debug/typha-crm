import { expect, test } from 'vitest';
import {
  relationAttributes,
  relationshipLimits,
  systemRelationships,
  systemAttributes,
} from '../shared/object-settings.js';
import { customKindSemantics } from '../shared/data-model.js';
import type { RelationDefinition } from '../shared/connections.js';

test('数据类型、约束和行为分别表达，日期不混作时间戳', () => {
  const projects = systemAttributes('projects');
  expect(projects.find((f) => f.id === 'due_date')).toMatchObject({
    type: '日期',
    valueType: 'date',
  });
  expect(projects.find((f) => f.id === 'created_at')).toMatchObject({
    type: '日期与时间',
    valueType: 'timestamp',
    constraints: [],
    properties: ['只读'],
  });
  expect(projects.find((f) => f.id === 'stage')).toMatchObject({
    type: '流程状态',
    valueType: 'status',
  });
  expect(systemAttributes('customers').find((f) => f.id === 'type')?.constraints).toContain('必填');
  expect(customKindSemantics('multi_select')).toEqual({ type: 'select', multiple: true });
  expect(customKindSemantics('stage')).toEqual({ type: 'status', multiple: false });
  expect(customKindSemantics('member')).toEqual({ type: 'actor_reference', multiple: false });
});

test('公司归属在两端展示正确的名称与反向数量限制', () => {
  const company = relationAttributes(systemRelationships, 'customers');
  const person = relationAttributes(systemRelationships, 'people');
  const project = relationAttributes(systemRelationships, 'projects');
  expect(company.map((r) => [r.name, r.object, r.cardinality])).toEqual([
    ['公司联系人', 'people', 'one_to_many'],
    ['公司项目', 'projects', 'one_to_many'],
  ]);
  expect(person.map((r) => [r.name, r.inverse, r.cardinality])).toEqual([
    ['所属公司', '公司联系人', 'many_to_one'],
  ]);
  expect(project.map((r) => [r.name, r.object, r.cardinality])).toEqual([
    ['所属公司', 'customers', 'many_to_one'],
  ]);
  expect(relationshipLimits(person[0].cardinality)).toMatchObject({
    targets: '一个',
    sources: '多个',
  });
});

test('同类实体关系保留两个不同属性，其他实体不展示此关系', () => {
  const d: RelationDefinition = {
    id: 'same-object',
    source_object: 'people',
    target_object: 'people',
    source_label: '指导老师',
    target_label: '指导学员',
    cardinality: 'many_to_one',
  };
  const rows = relationAttributes([d], 'people');
  expect(rows.map((r) => [r.name, r.inverse, r.cardinality])).toEqual([
    ['指导老师', '指导学员', 'many_to_one'],
    ['指导学员', '指导老师', 'one_to_many'],
  ]);
  expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  expect(relationAttributes([d], 'projects')).toEqual([]);
});
