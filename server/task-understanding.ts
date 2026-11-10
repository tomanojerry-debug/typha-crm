import { z } from 'zod';
import { ApiError } from './security.js';
import { taskSlotNames, type TaskSlot, type TaskSlotUpdate } from '../shared/task-understanding.js';
import type { WorkflowConfig, WorkflowKind } from '../shared/home-workflows.js';
import type { ChatClassification } from '../shared/chat-intent.js';

export const taskSlotUpdateSchema = z
  .strictObject({
    slot: z.enum(taskSlotNames),
    op: z.enum(['set', 'clear']),
    value: z.string().trim().min(1).max(2000).nullable(),
    evidence: z.string().trim().min(1).max(2000),
  })
  .superRefine((u, ctx) => {
    if ((u.op === 'clear') !== (u.value === null))
      ctx.addIssue({ code: 'custom', message: '清除必须为null，设置必须有值' });
    if (u.op === 'set' && u.slot === 'language' && !['zh', 'en', 'other'].includes(u.value!))
      ctx.addIssue({ code: 'custom', message: '语言不在允许范围' });
    if (u.op === 'set' && u.slot === 'template_choice' && u.value !== 'none')
      ctx.addIssue({ code: 'custom', message: '具名模板必须通过实际模板选择入口绑定' });
    if (
      u.op === 'set' &&
      ['style', 'writing_requirements'].includes(u.slot) &&
      !u.evidence.includes(u.value!)
    )
      ctx.addIssue({ code: 'custom', message: '文字条件必须从本人原话提取' });
  });
export const taskSlotUpdatesSchema = z
  .array(taskSlotUpdateSchema)
  .max(4)
  .superRefine((updates, ctx) => {
    if (new Set(updates.map((u) => u.slot)).size !== updates.length)
      ctx.addIssue({ code: 'custom', message: '同一槽位不能重复更新' });
  });
export const taskSlotsSchema = z
  .array(taskSlotUpdateSchema.safeExtend({ request_id: z.uuid() }))
  .max(4);

export function validateTaskEvidence(classification: ChatClassification, question: string) {
  const evidence = [
    classification.turn_evidence,
    ...(classification.slot_updates || []).map((u) => u.evidence),
  ];
  if (evidence.some((quote) => quote !== undefined && !question.includes(quote)))
    throw new ApiError(502, '模型任务条件缺少本轮原话依据，本次未保存');
  if (classification.turn_action === 'cancel' && !classification.turn_evidence)
    throw new ApiError(502, '模型取消任务缺少本轮原话依据，本次未保存');
}

/** Merge only present updates; omission never clears a previously provided value. */
export function mergeTaskSlots(
  current: TaskSlot[] = [],
  updates: TaskSlotUpdate[],
  requestId: string,
): TaskSlot[] {
  const slots = new Map(current.map((u) => [u.slot, u]));
  for (const update of updates) slots.set(update.slot, { ...update, request_id: requestId });
  return [...slots.values()];
}

/** Carry only demonstrably neutral values; never carry a previous customer's quote. */
export function retainTaskSlots(
  slots: TaskSlot[] = [],
  scopeChanged: boolean,
  instructionChanged: boolean,
) {
  if (instructionChanged) return [];
  if (!scopeChanged) return slots.filter((slot) => slot.slot !== 'template_choice');
  return slots.flatMap((slot) => {
    if (slot.op !== 'set') return [];
    if (
      slot.slot === 'style' &&
      /^(简短|简洁|正式|自然|友好|礼貌|详细|专业|轻松|客气)$/.test(slot.value || '')
    )
      return [{ ...slot, evidence: slot.value! }];
    if (slot.slot === 'language') {
      const phrase = slot.evidence.match(
        slot.value === 'en'
          ? /英文|英语|English/i
          : slot.value === 'zh'
            ? /中文|汉语|Chinese/i
            : /其他语言/,
      );
      return phrase ? [{ ...slot, evidence: phrase[0] }] : [];
    }
    return [];
  });
}

export function taskSlotInstructions(config: WorkflowConfig) {
  return (config.task_slots || [])
    .filter((s) => s.slot !== 'template_choice')
    .map((s) => {
      const label = {
        language: '邮件语言',
        style: '文风',
        writing_requirements: '写信内容要求',
        template_choice: '模板',
      }[s.slot];
      return `${label}：${s.op === 'clear' ? '已明确清除先前同项限制，不沿用历史值' : s.value}`;
    })
    .join('\n');
}

/** Existing config remains authoritative; never duplicate identity or approval state. */
export function taskState(kind: WorkflowKind, config: WorkflowConfig, step: string) {
  return {
    kind,
    step,
    bindings: {
      customer: !!config.customer_id,
      person: !!config.person_id,
      project: config.project_id ? 'selected' : 'none',
      mail: !!config.mail_id,
    },
    template: !config.template_choice
      ? 'unprovided'
      : config.template_choice.kind === 'none'
        ? 'none'
        : 'selected',
    slots: config.task_slots || [],
    instruction: config.instruction,
  };
}
