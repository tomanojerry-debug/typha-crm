import { expect, it } from 'vitest';
import { groundAttributeResult } from '../server/attribute-model.js';
import type { AttributeSource } from '../shared/attributes.js';

const source: AttributeSource = {
  id: 'record:original',
  kind: 'record',
  title: '虚构微信原文',
  body: JSON.stringify({
    evidence: [{ body: '我们主打儿童芭蕾裙，暂时没有确认价格。' }],
    derived_facts: [{ fact: '已批准每件99元' }],
  }),
};
const result = (quote: string) => ({
  value: '儿童芭蕾裙',
  explanation: '依据客户原话。',
  source_ids: [source.id],
  evidence: [{ source_id: source.id, quote }],
  missing: [],
});

it('requires an exact original quotation and retains it with the one Record source', () => {
  expect(groundAttributeResult(result('我们主打儿童芭蕾裙'), [source]).sources).toMatchObject([
    { id: source.id, quote: '我们主打儿童芭蕾裙' },
  ]);
  expect(() => groundAttributeResult(result('我们主打高端婚纱'), [source])).toThrow('原文摘录');
});
it('does not accept a graph summary, title, notice, or another AI claim as its own evidence', () => {
  expect(() => groundAttributeResult(result('已批准每件99元'), [source])).toThrow('原文摘录');
  expect(() => groundAttributeResult(result(source.title), [source])).toThrow('原文摘录');
});
it('rejects omitted or spoofed sources and allows an explicit unsupported null result', () => {
  expect(() =>
    groundAttributeResult({ ...result('我们主打儿童芭蕾裙'), source_ids: ['record:other'] }, [
      source,
    ]),
  ).toThrow('原文摘录');
  expect(() =>
    groundAttributeResult({ ...result('我们主打儿童芭蕾裙'), evidence: [] }, [source]),
  ).toThrow('原文摘录');
  expect(
    groundAttributeResult(
      {
        value: null,
        explanation: '无相关信息',
        source_ids: [],
        evidence: [],
        missing: ['无价格确认'],
      },
      [source],
    ).value,
  ).toBeNull();
});
it('treats zero and false as values requiring support', () => {
  for (const value of [0, false])
    expect(() =>
      groundAttributeResult(
        { value, explanation: '无依据', source_ids: [], evidence: [], missing: [] },
        [source],
      ),
    ).toThrow('原文摘录');
});
