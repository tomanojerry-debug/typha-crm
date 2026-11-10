import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AskSource } from '../shared/ask.js';
import type { ChatRetrieval } from '../shared/chat-intent.js';
import { AgentListedCustomerCards, AgentReplySources } from '../src/AgentReplyCards.js';
import {
  agentListedCustomerItems,
  agentListedCustomerSummary,
  agentReplyCopyText,
} from '../src/agent-reply-card-data.js';

const company = (id: string, title = `虚构客户${id}`): AskSource => ({
  kind: 'entity',
  object: 'customers',
  id,
  customer_id: id,
  title,
  description: '这段业务说明不属于基础目录展示',
  directory_fields: [
    { label: '负责人', value: '虚构国内' },
    { label: '客户类型', value: '团体定制' },
  ],
});
const listed = (overrides: Partial<ChatRetrieval> = {}): ChatRetrieval => ({
  status: 'listed',
  query: null,
  entity_type: 'company',
  match_mode: null,
  candidates: [],
  items: [company('a'), company('b')],
  total: 2,
  truncated: false,
  listing: {
    object: 'customers',
    ownership: 'owned_by_me',
    page: 1,
    page_size: 30,
    returned: 2,
    snapshot_digest: 'server-only-snapshot-digest',
  },
  ...overrides,
});
const render = (retrieval: ChatRetrieval, disabled = false) =>
  renderToStaticMarkup(
    createElement(AgentListedCustomerCards, { retrieval, disabled, onOpen() {} }),
  );

describe('listed customer directory presentation', () => {
  it('shows the actual owner scope and counts without offering candidate continuation', () => {
    const html = render(listed());
    expect(html).toContain('我负责的客户 · 共 2 条 · 第 1 页 · 当前显示 2 条');
    expect(html.match(/打开档案/g)).toHaveLength(2);
    expect(html).not.toContain('选择并继续');
    expect(html).not.toContain('候选 1');
    expect(html).not.toContain('请先选择');
    expect(html).not.toContain('server-only-snapshot-digest');
  });

  it('distinguishes accessible scope and reports the real first-page truncation', () => {
    const retrieval = listed({
      items: Array.from({ length: 30 }, (_, index) => company(String(index))),
      total: 47,
      truncated: true,
      listing: { ...listed().listing!, ownership: 'accessible', returned: 30 },
    });
    const html = render(retrieval);
    expect(html).toContain('当前可访问的客户 · 共 47 条 · 第 1 页 · 当前显示 30 条');
    expect(html).toContain('当前仅显示前 30 条，可补充名称缩小范围');
    expect(html).not.toContain('仅显示前 10 项');
    expect(html).not.toContain('下一页');
    expect(html.match(/打开档案/g)).toHaveLength(30);
  });

  it('renders an empty list with its actual scope and no invented customer or action', () => {
    const html = render(
      listed({ items: [], total: 0, listing: { ...listed().listing!, returned: 0 } }),
    );
    expect(html).toContain('我负责的客户 · 共 0 条');
    expect(html).toContain('当前显示 0 条');
    expect(html).toContain('当前没有符合此范围的客户。');
    expect(html).not.toContain('打开档案');
    expect(html).not.toContain('选择并继续');
  });

  it('deduplicates scoped directory cards and excludes them from repeated evidence cards', () => {
    const a = company('a');
    const retrieval = listed({ items: [a, { ...a }, company('b')] });
    const items = agentListedCustomerItems(retrieval);
    expect(items).toHaveLength(2);
    expect(render(retrieval).match(/打开档案/g)).toHaveLength(2);
    expect(
      renderToStaticMarkup(
        createElement(AgentReplySources, { sources: [a], exclude: items, onOpen() {} }),
      ),
    ).toBe('');
    expect(agentListedCustomerSummary(retrieval)).toContain('当前显示 2 条');
  });

  it('uses explicit basic fields, hides business descriptions and escapes untrusted names', () => {
    const a = company('a', '<img src=x onerror=alert(1)>');
    const html = render(listed({ items: [a], total: 1 }));
    expect(html).toContain('虚构国内');
    expect(html).toContain('团体定制');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('这段业务说明');
    expect(html).not.toContain('邮箱');
    expect(html).not.toContain('电话');
    expect(html).not.toContain('所属公司');
  });

  it('never turns business sources or mismatched company identities into listed cards', () => {
    const a = company('a');
    expect(
      agentListedCustomerItems(
        listed({ items: [a, { ...a, kind: 'record' }, { ...a, customer_id: 'other' }] }),
      ),
    ).toEqual([a]);
  });

  it('disables opening while the existing conversation is busy', () => {
    const html = render(listed(), true);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain('选择并继续');
  });

  it('does not reuse old items when server retrieval has been cleared or changed', () => {
    const invalidated = listed({ status: 'not_searched', listing: undefined });
    expect(render(invalidated)).toBe('');
    expect(agentListedCustomerItems(invalidated)).toEqual([]);
    expect(agentReplyCopyText('当前列表已失效，请重新查询。', invalidated)).toBe(
      '当前列表已失效，请重新查询。',
    );
  });

  it('copies the complete model reply, actual scope and visible basic fields once', () => {
    const a = company('a');
    const copied = agentReplyCopyText('已按当前权限列出。', listed({ items: [a, a], total: 1 }));
    expect(copied.startsWith('已按当前权限列出。\n\n我负责的客户 · 共 1 条')).toBe(true);
    expect(copied.match(/虚构客户a/g)).toHaveLength(1);
    expect(copied).toContain('负责人：虚构国内');
    expect(copied).toContain('客户类型：团体定制');
    expect(copied).not.toContain('这段业务说明');
    expect(copied).not.toContain('选择并继续');
  });

  it('does not guess ownership when listing metadata is unavailable', () => {
    expect(agentListedCustomerSummary(listed({ listing: undefined }))).toBe(
      '客户列表 · 共 2 条 · 当前显示 2 条',
    );
  });
});
