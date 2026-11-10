import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { classifyMessage, parseClassification } from '../server/chat-intent.js';
import {
  mergeTaskSlots,
  taskSlotInstructions,
  taskState,
  taskSlotsSchema,
  retainTaskSlots,
} from '../server/task-understanding.js';
import type { WorkflowConfig } from '../shared/home-workflows.js';
import type { TaskSlotUpdate } from '../shared/task-understanding.js';

const classification = {
  intent: '起草内容',
  target: null,
  missing: [],
  reply: '继续当前任务',
  mail_action: null,
};
const language: TaskSlotUpdate = { slot: 'language', op: 'set', value: 'en', evidence: '英文' };

it('validates evidenced updates without accepting invented identities, approvals, dates or named templates', () => {
  expect(
    parseClassification(
      { ...classification, turn_action: 'modify', slot_updates: [language] },
      '改成英文',
    ),
  ).toMatchObject({ slot_updates: [language] });
  for (const slot of ['customer_id', 'person_id', 'send_at', 'approved', 'to']) {
    expect(() =>
      parseClassification({ ...classification, slot_updates: [{ ...language, slot }] }, '英文'),
    ).toThrow();
  }
  for (const update of [
    { ...language, slot: 'template_choice', value: 'invented-template-id' },
    { ...language, evidence: '不存在的原话' },
    { ...language, slot: 'style', value: '模型自己编写的风格' },
    { ...language, op: 'clear', value: 'en' },
    { ...language, op: 'set', value: null },
  ])
    expect(() =>
      parseClassification({ ...classification, slot_updates: [update] }, '英文'),
    ).toThrow();
  expect(() =>
    parseClassification({ ...classification, slot_updates: [language, language] }, '英文'),
  ).toThrow();
  expect(() =>
    parseClassification({ ...classification, diagnostics: { duration_ms: 0 } }),
  ).toThrow();
});

it('preserves omissions and uses explicit clear rather than null overwrites', () => {
  const first = mergeTaskSlots([], [language], randomUUID());
  expect(taskSlotsSchema.parse(first)).toEqual(first);
  const style: TaskSlotUpdate = { slot: 'style', op: 'set', value: '简短', evidence: '简短' };
  const second = mergeTaskSlots(first, [style], randomUUID());
  expect(second[0]).toEqual(first[0]);
  const cleared = mergeTaskSlots(
    second,
    [{ ...style, op: 'clear', value: null, evidence: '取消文风限制' }],
    randomUUID(),
  );
  const config = { task_slots: cleared } as WorkflowConfig;
  expect(taskSlotInstructions(config)).toContain('邮件语言：en');
  expect(taskSlotInstructions(config)).toContain('文风：已明确清除');
  expect(cleared.find((s) => s.slot === 'style')).toMatchObject({ op: 'clear', value: null });
});

it('distinguishes an unprovided template from explicit none without manufacturing an identity', () => {
  const config = {
    customer_id: null,
    person_id: null,
    project_id: null,
    mail_id: null,
    template_choice: null,
    instruction: '',
  } as WorkflowConfig;
  expect(taskState('compose', config, 'template')).toMatchObject({
    template: 'unprovided',
    bindings: { customer: false, project: 'none' },
  });
  expect(
    taskState('compose', { ...config, template_choice: { kind: 'none' } }, 'ready').template,
  ).toBe('none');
});

it('requires source evidence for cancellation and measures classification on the server', async () => {
  expect(() =>
    parseClassification({ ...classification, turn_action: 'cancel' }, '取消任务'),
  ).toThrow();
  const result = await classifyMessage(
    async () => ({ ...classification, turn_action: 'cancel', turn_evidence: '取消任务' }),
    '取消任务',
  );
  expect(result.diagnostics).toMatchObject({ contract_version: 'task-slots-v1' });
  expect(result.diagnostics!.duration_ms).toBeGreaterThanOrEqual(0);
  await expect(
    classifyMessage(async () => {
      throw new Error('provider unavailable');
    }, '取消任务'),
  ).rejects.toThrow('provider unavailable');
});

it('drops scope-bound wording and old quotes on rebinding, and resets extracted constraints on explicit instruction edits', () => {
  const slots = mergeTaskSlots(
    [],
    [
      { ...language, evidence: '甲客户特价99元，用英文' },
      { slot: 'style', op: 'set', value: '简短', evidence: '甲客户特价99元，简短一点' },
      {
        slot: 'writing_requirements',
        op: 'set',
        value: '甲客户特价99元',
        evidence: '甲客户特价99元',
      },
    ],
    randomUUID(),
  );
  const retained = retainTaskSlots(slots, true, false);
  expect(retained.map((s) => s.slot)).toEqual(['language', 'style']);
  expect(JSON.stringify(retained)).not.toContain('甲客户');
  expect(retainTaskSlots(slots, false, true)).toEqual([]);
});
