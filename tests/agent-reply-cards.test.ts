import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { AskSource } from '../shared/ask.js';
import type { ChatRetrieval } from '../shared/chat-intent.js';
import type { ChatMessage } from '../shared/chat.js';
import {
  AgentCandidateCards,
  AgentRecordAnswerCard,
  AgentReplyCard,
  AgentReplySources,
  AgentSourceCard,
} from '../src/AgentReplyCards.js';
import {
  agentRecordReplySource,
  agentRecordDisplayBody,
  agentReplyCopyText,
  uniqueAgentSources,
} from '../src/agent-reply-card-data.js';

const source: AskSource = {
  kind: 'entity',
  object: 'people',
  id: 'person-a',
  customer_id: 'company-a',
  title: '沈示例',
  description: '候选目录 · 联系人 · 所属公司：示例公司',
  company_name: '示例公司',
};
const action = { label: '打开档案', onClick() {} };

it('omits only standalone header duplicates while retaining other names, fields and substantive confirmations', () => {
  for (const [object, label] of [
    ['people', '联系人'],
    ['customers', '公司名称'],
    ['projects', '项目名称'],
  ] as const) {
    const target = { ...source, object, title: '示例名称' };
    const body = `已选择第1个候选：示例名称。\n\n**${label}**：示例名称\n邮箱：demo@fixture.invalid\n所属公司：示例名称\n\n已选择第1个候选：示例名称，交期待确认。\n${label}：另一名称\n备注：示例名称需要确认尺码。`;
    const display = agentRecordDisplayBody(body, target);
    expect(display).not.toContain('已选择第1个候选：示例名称。');
    expect(display).not.toContain(`**${label}**：示例名称`);
    expect(display).toContain('邮箱：demo@fixture.invalid');
    expect(display).toContain('所属公司：示例名称');
    expect(display).toContain('已选择第1个候选：示例名称，交期待确认。');
    expect(display).toContain(`${label}：另一名称`);
    expect(display).toContain('备注：示例名称需要确认尺码。');
    expect(agentReplyCopyText(body)).toBe(body);
    const quoted = `\`\`\`text\n${label}：示例名称\n已选择第1个候选：示例名称。\n\`\`\`\n> ${label}：示例名称\n| ${label} | 示例名称 |`;
    expect(agentRecordDisplayBody(quoted, target)).toBe(quoted);
  }
});

it('uses only the explicit unique query target, without treating drafts, analysis or citations as profile identity', () => {
  const message: ChatMessage = {
    id: 'message-a',
    role: 'assistant',
    body: '邮箱：contact@fixture.invalid',
    material: null,
    created_at: '2026-10-27T00:00:00Z',
    classification: { intent: '查询资料', target: '沈', missing: [], reply: '查询授权资料' },
    retrieval: {
      status: 'unique',
      query: '沈',
      entity_type: 'person',
      match_mode: 'surname',
      total: 1,
      truncated: false,
      candidates: [source],
      task: { intent: '查询资料', question: '查看姓沈联系人的资料' },
    },
    sources: [{ ...source, id: 'related-company', object: 'customers' }],
  };
  for (const object of ['people', 'customers', 'projects'] as const) {
    const target = { ...source, object };
    expect(
      agentRecordReplySource({
        ...message,
        retrieval: { ...message.retrieval!, candidates: [target] },
      }),
    ).toEqual(target);
  }
  expect(agentRecordReplySource({ ...message, retrieval: undefined })).toBeUndefined();
  const customerSource: AskSource = { ...source, id: 'company-a', object: 'customers' };
  const overview: ChatMessage = {
    ...message,
    action: 'overview',
    retrieval: undefined,
    sources: [
      { ...customerSource, id: 'other-company', customer_id: 'other-company' },
      customerSource,
    ],
  };
  expect(agentRecordReplySource(overview, 'company-a')).toEqual(customerSource);
  expect(agentRecordReplySource(overview, 'not-a-source')).toBeUndefined();
  expect(
    agentRecordReplySource({
      ...message,
      retrieval: { ...message.retrieval!, candidates: [source, source] },
    }),
  ).toBeUndefined();
  expect(
    agentRecordReplySource({
      ...message,
      retrieval: { ...message.retrieval!, status: 'candidates' },
    }),
  ).toBeUndefined();
  for (const intent of ['分析建议', '起草内容', '一般对话'] as const) {
    expect(
      agentRecordReplySource({
        ...message,
        classification: { ...message.classification!, intent },
      }),
    ).toBeUndefined();
    expect(
      agentRecordReplySource({
        ...message,
        retrieval: { ...message.retrieval!, task: { intent, question: '继续原任务' } },
      }),
    ).toBeUndefined();
  }
});

it('keeps the complete model answer and literal unknown values inside one record card', () => {
  const html = renderToStaticMarkup(
    createElement(AgentRecordAnswerCard, {
      source,
      body: '邮箱：contact@fixture.invalid\n所属公司：示例公司\n\n电话未填写。<script>unsafe()</script>',
      onOpen() {},
    }),
  );
  expect(html).toContain('联系人资料');
  expect(html.match(/contact@fixture.invalid/g)).toHaveLength(1);
  expect(html).toContain('电话未填写。');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('查看原回复');
  expect(html.indexOf('邮箱：')).toBeLessThan(html.indexOf('</section>'));
  expect(html).toContain('打开档案');
});

it('deduplicates only identical scoped records and excludes the already displayed candidate', () => {
  const sameName = { ...source, id: 'person-b' };
  const otherCustomer = { ...source, customer_id: 'company-b' };
  const otherObject: AskSource = { ...source, object: 'projects' };
  const record: AskSource = { ...source, kind: 'record', object: undefined };
  const mail: AskSource = { ...record, kind: 'mail' };
  expect(
    uniqueAgentSources([source, { ...source }, sameName, otherCustomer, otherObject, record, mail]),
  ).toEqual([source, sameName, otherCustomer, otherObject, record, mail]);
  expect(uniqueAgentSources([source, sameName, record], [source])).toEqual([sameName, record]);
});

it('shows actual company metadata once and renders untrusted record names as text', () => {
  const html = renderToStaticMarkup(
    createElement(AgentSourceCard, {
      source: { ...source, title: '<img src=x onerror=alert(1)>' },
      action,
      hideDescription: true,
    }),
  );
  expect(html).toContain('所属公司');
  expect(html.match(/示例公司/g)).toHaveLength(1);
  expect(html).toContain('&lt;img');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('候选目录');
});

it('shows only explicit directory fields in candidate/source cards and copies the same values', () => {
  const rich: AskSource = {
    ...source,
    directory_fields: [
      { label: '邮箱', value: 'own@fixture.invalid' },
      { label: '职位', value: '业务对接' },
    ],
    description: '联系人：沈示例',
  };
  const html = renderToStaticMarkup(createElement(AgentSourceCard, { source: rich, action }));
  expect(html).toContain('own@fixture.invalid');
  expect(html).toContain('业务对接');
  expect(html).not.toContain('联系人：沈示例</p>');
  const copied = agentReplyCopyText('请选择候选。', {
    status: 'candidates',
    query: '沈',
    entity_type: 'person',
    match_mode: 'surname',
    total: 1,
    truncated: false,
    candidates: [rich],
  });
  expect(copied).toContain('邮箱：own@fixture.invalid');
  expect(copied).toContain('职位：业务对接');
});

it('does not invent missing fields or assign a company to itself', () => {
  const withoutCompany = renderToStaticMarkup(
    createElement(AgentSourceCard, {
      source: { ...source, company_name: undefined, description: '' },
      action,
    }),
  );
  expect(withoutCompany).not.toContain('所属公司');
  const company = renderToStaticMarkup(
    createElement(AgentSourceCard, {
      source: { ...source, object: 'customers', description: '' },
      action,
    }),
  );
  expect(company).not.toContain('所属公司');
});

it('supports the existing fixed directory contract without inferring fields from arbitrary prose', () => {
  const legacy = renderToStaticMarkup(
    createElement(AgentSourceCard, {
      source: { ...source, company_name: undefined },
      action,
      allowLegacyDirectory: true,
    }),
  );
  expect(legacy).toContain('<dt>所属公司</dt>');
  expect(legacy.match(/示例公司/g)).toHaveLength(1);
  const prose = renderToStaticMarkup(
    createElement(AgentSourceCard, {
      source: {
        ...source,
        company_name: undefined,
        description: '备注里提到了所属公司：不应自动解析',
      },
      action,
    }),
  );
  expect(prose).not.toContain('<dt>所属公司</dt>');
  expect(prose).toContain('不应自动解析');
  const relationLabel = renderToStaticMarkup(
    createElement(AgentSourceCard, {
      source: { ...source, company_name: undefined },
      action,
    }),
  );
  expect(relationLabel).not.toContain('<dt>所属公司</dt>');
  expect(relationLabel).toContain('候选目录 · 联系人 · 所属公司：示例公司');
});

it('preserves candidate order and disabled choices while keeping the full reply in copy output', () => {
  const other = { ...source, id: 'person-b', title: '沈另例' };
  const retrieval: ChatRetrieval = {
    status: 'candidates',
    query: '沈',
    entity_type: 'person',
    match_mode: 'surname',
    total: 20,
    truncated: true,
    candidates: [source, other],
  };
  const html = renderToStaticMarkup(
    createElement(AgentCandidateCards, {
      retrieval,
      busy: false,
      inactive: true,
      onSelect() {},
    }),
  );
  expect(html.indexOf('沈示例')).toBeLessThan(html.indexOf('沈另例'));
  expect(html).toContain('候选 1');
  expect(html).toContain('候选 2');
  expect(html).not.toContain('<button');
  expect(html.match(/role="status"/g)).toHaveLength(2);
  expect(html).toContain('历史候选');
  expect(html).not.toContain('选择并继续');
  expect(html).toContain('仅显示前 10 项');
  expect(html).toContain('找到 20 位联系人');
  expect(html).not.toContain('查看原回复');
  const copied = agentReplyCopyText('模型原回复保持完整。', retrieval);
  expect(copied.startsWith('模型原回复保持完整。\n\n1. 沈示例')).toBe(true);
  expect(copied).toContain('所属公司：示例公司');
  expect(copied.indexOf('1. 沈示例')).toBeLessThan(copied.indexOf('2. 沈另例'));
  expect(agentReplyCopyText('普通原回复')).toBe('普通原回复');
});

it('keeps evidence collapsed and distinguishes source actions from candidate selection', () => {
  const record: AskSource = { ...source, kind: 'record', object: undefined };
  const html = renderToStaticMarkup(
    createElement(AgentReplySources, {
      sources: [source, source, record],
      disabled: true,
      onOpen() {},
    }),
  );
  expect(html).toContain('回答依据 · 2');
  expect(html).not.toContain('<details open');
  expect(html).toContain('打开档案');
  expect(html).toContain('查看原文');
  expect(html).not.toContain('选择并继续');
  expect(html.match(/disabled=""/g)).toHaveLength(2);
  expect(
    renderToStaticMarkup(
      createElement(AgentReplySources, { sources: [source], exclude: [source], onOpen() {} }),
    ),
  ).toBe('');
});

it('keeps valid zero and false field values and the explicit write action', () => {
  const html = renderToStaticMarkup(
    createElement(AgentReplyCard, {
      title: '导入样例',
      typeLabel: '导入预览',
      icon: null,
      fields: [
        { label: '数量', value: 0 },
        { label: '已确认', value: false },
      ],
      footer: '核对后再创建',
      action: { label: '创建 2 条记录', primary: true, disabled: true, onClick() {} },
    }),
  );
  expect(html).toContain('<dd>0</dd>');
  expect(html).toContain('<dd>false</dd>');
  expect(html).toContain('创建 2 条记录');
  expect(html).toContain('disabled=""');
});
