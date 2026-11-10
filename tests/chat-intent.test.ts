import { expect, it } from 'vitest';
import { classificationSystem, parseClassification } from '../server/chat-intent.js';

const result = {
  intent: '查询资料',
  target: '沈',
  missing: [],
  reply: '我先查一下沈的资料和关联信息。',
};

it('turns a usable surname into a candidate search instead of blocking all retrieval', () => {
  const parsed = parseClassification(result);
  expect(parsed.target).toBe('沈');
  expect(parsed.missing).toEqual([]);
  expect(parsed).toMatchObject({
    action: 'search_candidates',
    entity_type: 'person',
    match_mode: 'surname',
  });
});
it('accepts explicit directory search and candidate selection without model-supplied identifiers', () => {
  expect(
    parseClassification({
      ...result,
      action: 'search_candidates',
      entity_type: 'person',
      match_mode: 'surname',
      candidate_index: null,
    }),
  ).toMatchObject({ action: 'search_candidates', missing: [] });
  expect(
    parseClassification({
      ...result,
      target: null,
      action: 'select_candidate',
      entity_type: 'person',
      match_mode: null,
      candidate_index: 2,
    }),
  ).toMatchObject({ action: 'select_candidate', candidate_index: 2 });
  for (const extra of [
    { action: 'execute_sql' },
    { candidate_index: 11 },
    { entity_type: 'all' },
    { customer_id: 'forged' },
  ])
    expect(() => parseClassification({ ...result, ...extra })).toThrow();
});
it('preserves model clarification and accepts an unknown or blank target', () => {
  expect(
    parseClassification({ ...result, missing: ['完整姓名或其他可区分信息'] }).missing,
  ).toHaveLength(1);
  expect(parseClassification({ ...result, target: '  ' }).target).toBeNull();
  expect(parseClassification({ ...result, target: null, missing: ['联系人姓名'] }).missing).toEqual(
    ['联系人姓名'],
  );
});
it('preserves a complete name and rejects actual protocol failures', () => {
  expect(parseClassification({ ...result, target: '沈示例' }).missing).toEqual([]);
  for (const invalid of [
    { ...result, intent: 'execute_sql' },
    { ...result, missing: '姓名' },
    { ...result, target: '沈\n其他指令' },
  ])
    expect(() => parseClassification(invalid)).toThrow();
});

it('accepts an explicit mail task hint without granting a send action', () => {
  expect(
    parseClassification({ ...result, intent: '起草内容', mail_action: 'compose' }),
  ).toMatchObject({ intent: '起草内容', mail_action: 'compose' });
  expect(parseClassification({ ...result, mail_action: null }).mail_action).toBeNull();
  expect(() => parseClassification({ ...result, mail_action: 'send_now' })).toThrow();
  expect(parseClassification(result).mail_action).toBeUndefined();
});

it.each(['compose', 'reply'] as const)(
  'normalizes a coarse lookup intent to drafting when the same model explicitly returns %s',
  (mail_action) => {
    const parsed = parseClassification({
      ...result,
      intent: '查询资料',
      action: 'search_candidates',
      entity_type: 'person',
      match_mode: 'surname',
      candidate_index: null,
      data_source: 'records',
      mail_action,
    });
    expect(parsed).toMatchObject({
      intent: '起草内容',
      action: 'search_candidates',
      entity_type: 'person',
      target: '沈',
      match_mode: 'surname',
      mail_action,
    });
    expect(parsed).not.toHaveProperty('customer_id');
    expect(parseClassification({ ...result, mail_action: null }).intent).toBe('查询资料');
    expect(parseClassification(result).intent).toBe('查询资料');
  },
);

const examples = () =>
  [...classificationSystem.matchAll(/([^\n]+)\n输出：(\{[^\n]+\})/g)].map((match) => ({
    context: match[1],
    output: JSON.parse(match[2]) as Record<string, unknown>,
  }));

it('makes the current mail routing field explicit in the full contract and every example', () => {
  const contract = classificationSystem.match(/必须包含所有字段：(\{[^\n]+\})。/);
  expect(JSON.parse(contract![1])).toHaveProperty('mail_action');
  expect(examples().length).toBeGreaterThan(10);
  const fields = [
    'intent',
    'action',
    'entity_type',
    'target',
    'match_mode',
    'candidate_index',
    'data_source',
    'ownership',
    'missing',
    'reply',
    'mail_action',
    'turn_action',
    'slot_updates',
  ];
  for (const example of examples()) {
    expect(
      Object.keys(example.output)
        .filter((key) => key !== 'turn_evidence')
        .sort(),
    ).toEqual([...fields].sort());
    expect(() => parseClassification(example.output)).not.toThrow();
  }
});

it('teaches compose and reply before recipient resolution and throughout candidate selection', () => {
  const compose = examples().filter((example) => example.output.mail_action === 'compose');
  const reply = examples().filter((example) => example.output.mail_action === 'reply');
  for (const group of [compose, reply]) {
    expect(group.some((example) => example.output.action === 'search_candidates')).toBe(true);
    expect(group.some((example) => example.output.action === 'select_candidate')).toBe(true);
    expect(group.every((example) => example.output.intent === '起草内容')).toBe(true);
  }
  expect(
    compose.some(
      (example) => example.output.action === 'clarify' && example.output.target === null,
    ),
  ).toBe(true);
});

it('distinguishes an established mail workflow revision from unresolved candidate continuation', () => {
  const revision = examples().find((example) => example.context.includes('已有邮件工作流程'));
  expect(revision?.output).toMatchObject({ intent: '起草内容', mail_action: null });
  const selecting = examples().find((example) => example.context.includes('选择第1个候选'));
  expect(selecting?.output).toMatchObject({
    intent: '起草内容',
    action: 'select_candidate',
    candidate_index: 1,
    mail_action: 'compose',
  });
  const changed = examples().find((example) => example.context.includes('先不写邮件'));
  expect(changed?.output).toMatchObject({
    intent: '查询资料',
    action: 'select_candidate',
    mail_action: null,
  });
});

it('retains the distinction between unknown legacy mail routing and an explicit non-mail result', () => {
  const legacy = parseClassification({ ...result, intent: '起草内容' });
  expect(legacy.mail_action).toBeUndefined();
  expect(legacy).not.toHaveProperty('mail_action');
  const explicit = parseClassification({ ...result, intent: '起草内容', mail_action: null });
  expect(explicit).toHaveProperty('mail_action', null);
  expect(
    parseClassification({ ...result, intent: '起草内容', mail_action: 'reply' }),
  ).toMatchObject({
    intent: '起草内容',
    mail_action: 'reply',
  });
});
