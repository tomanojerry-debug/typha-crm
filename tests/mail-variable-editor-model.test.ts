import { expect, it } from 'vitest';
import type { MailVariableCatalog } from '../shared/mail-variables.js';
import {
  cleanMailPaste,
  cloneMailNodes,
  mailVariableDirectory,
  searchMailVariableFields,
} from '../src/mail-variable-editor-model.js';

const catalog: MailVariableCatalog = {
  version: 1,
  fields: [
    {
      root: 'recipient_company',
      field: 'customers:contact_name',
      label: '主要联系人姓名',
      path: ['收件人', '所属公司', '主要联系人姓名'],
      kind: 'text',
    },
    {
      root: 'customer',
      field: 'customers:email',
      label: '公司邮箱',
      path: ['当前公司', '公司邮箱'],
      kind: 'text',
    },
    {
      root: 'recipient',
      field: 'people:name',
      label: '姓名',
      path: ['收件人', '姓名'],
      kind: 'text',
    },
    {
      root: 'recipient',
      field: 'people:email',
      label: '邮箱',
      path: ['收件人', '邮箱'],
      kind: 'text',
    },
    {
      root: 'customer',
      field: 'summary-uuid',
      label: '总结',
      path: ['当前公司', '总结'],
      kind: 'text',
      ai_enabled: true,
    },
  ],
};

it('ranks exact field labels before prefix, substring and path matches with stable ties', () => {
  expect(searchMailVariableFields(catalog, '姓名')[0].field).toBe('people:name');
  expect(searchMailVariableFields(catalog, '邮箱')[0].field).toBe('people:email');
  expect(searchMailVariableFields(catalog, '公司').map((field) => field.field)).toEqual([
    'customers:email',
    'customers:contact_name',
    'summary-uuid',
  ]);
  expect(searchMailVariableFields(catalog, '不存在')).toEqual([]);
});

it('keeps recipient company and current mail company as separate paths and places explicit AI fields deeper', () => {
  expect(mailVariableDirectory(catalog, []).groups.map((group) => group.label)).toEqual([
    '收件人',
    '当前公司',
  ]);
  expect(mailVariableDirectory(catalog, ['收件人']).groups[0].path).toEqual(['收件人', '所属公司']);
  expect(
    mailVariableDirectory(catalog, ['当前公司', '更多属性', '自定义属性']).fields[0].field,
  ).toBe('summary-uuid');
});

it('preserves an explicitly empty fallback independently from the original controlled nodes', () => {
  const nodes = [
    {
      type: 'variable' as const,
      id: 'variable',
      root: 'recipient' as const,
      field: 'people:name',
      fallback: '',
    },
  ];
  const copied = cloneMailNodes(nodes);
  expect(Object.hasOwn(copied[0], 'fallback')).toBe(true);
  copied[0].type === 'variable' && (copied[0].fallback = '备用');
  expect(nodes[0].fallback).toBe('');
});

it('accepts pasted HTML-looking text literally and normalizes only line endings', () => {
  expect(cleanMailPaste('<script>alert(1)</script>\r\n后文')).toBe(
    '<script>alert(1)</script>\n后文',
  );
  expect(cleanMailPaste('主题\r\n后文', false)).toBe('主题 后文');
});
