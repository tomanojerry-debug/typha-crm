import { expect, it } from 'vitest';
import { budgetAgentSources } from '../server/agent-source-budget.js';
import type { AgentSource } from '../shared/agent.js';

const record = (id: string, body: string): AgentSource => ({
  id: `record::${id}`,
  title: id,
  body,
});

it('keeps the richer recalled evidence when a recent mail repeats the same Record', () => {
  const recalled = record('old', '原文＋结构化候选＋图事实');
  const result = budgetAgentSources([recalled, record('old', '只有邮件正文')]);
  expect(result.sources).toEqual([recalled]);
});

it('omits the whole old/new correction group when only one endpoint would fit', () => {
  const old = record('old', '100件'),
    next = record('new', '80件'.repeat(100));
  const current = { id: 'entity:profile', title: '档案', body: '公司背景' };
  const result = budgetAgentSources(
    [old, next, current, record('old', '旧值重复')],
    [['old', 'new']],
    220,
  );
  expect(result.sources).toEqual([current]);
  expect(result.warnings.join('')).toContain('整组省略');
});

it('never exposes the old endpoint when its required correction source is missing', () => {
  const unrelated = record('other', '其他有依据的事项');
  const result = budgetAgentSources([record('old', '原100件'), unrelated], [['old', 'missing']]);
  expect(result.sources).toEqual([unrelated]);
  expect(result.warnings.join('')).toContain('来源不完整');
});

it('treats overlapping corrections as one group and continues past oversized unrelated sources', () => {
  const input = [record('a', '100'), record('b', '80'), record('c', '60')];
  const result = budgetAgentSources(
    [...input, record('large', '内容'.repeat(500)), record('small', '可读')],
    [
      ['a', 'b'],
      ['b', 'c'],
    ],
    500,
  );
  expect(result.sources.map((s) => s.id)).toEqual([
    'record::a',
    'record::b',
    'record::c',
    'record::small',
  ]);
  expect(result.warnings).toHaveLength(1);
});
