import { createHash } from 'node:crypto';
import {
  mailVariableText,
  type MailInlineNode,
  type MailVariableDocument,
  type MailVariableNode,
} from '../shared/mail-variables.js';

type Part = 'subject' | 'body';
const markerPrefix = '[[CRM_SLOT:';

export type MailTemplateVariableErrorCode =
  | 'missing_subject'
  | 'missing_marker'
  | 'duplicate_marker'
  | 'cross_part_marker'
  | 'unknown_marker'
  | 'display_marker';

/** Fixed diagnostics only: never retain model text or customer field values. */
export class MailTemplateVariableError extends Error {
  constructor(
    readonly code: MailTemplateVariableErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The model receives opaque slots, never the authority to choose a field reference. */
export function protectTemplateVariables(document: MailVariableDocument) {
  const slots: { marker: string; part: Part; node: MailVariableNode }[] = [];
  const masked = (part: Part) =>
    document[part]
      .map((node) => {
        if (node.type === 'text') {
          if (node.text.includes(markerPrefix)) throw new Error('模板文字包含保留的变量标记');
          return node.text;
        }
        const key = createHash('sha256')
          .update(JSON.stringify([part, node]))
          .digest('hex')
          .slice(0, 24);
        const marker = `${markerPrefix}${part}:${key}]]`;
        slots.push({ marker, part, node });
        return marker;
      })
      .join('');
  const subject = masked('subject'),
    body = masked('body');
  return { subject, body, slots };
}

/** The final output contract must agree with the selected template's fixed slots. */
export function mailTemplateVariableContract(document: MailVariableDocument) {
  const { slots } = protectTemplateVariables(document);
  if (!slots.length) return null;
  const markers = (part: Part) => slots.filter((slot) => slot.part === part).map((s) => s.marker);
  const subject = markers('subject'),
    body = markers('body');
  return {
    subjectRequired: subject.length > 0,
    instructions: [
      '本轮邮件变量输出合同（固定槽位规则，优先于普通模板文案调整）：',
      `draft_subject 必须保留的标记：${JSON.stringify(subject)}。${subject.length ? '本轮 draft_subject 必填，不可省略。' : '本轮 draft_subject 可以省略；如提供也不得放入正文标记。'}`,
      `draft_body 必须保留的标记：${JSON.stringify(body)}。`,
      '上列每颗标记必须完整、原样且恰好一次放在指定字段，不跨主题与正文移动、重复、改写或新增标记。即使只写系统测试、简化文案或调整署名，也必须保留这些固定槽位。普通文字可以按本人要求改写，不要猜测或填入变量值。',
      '结构化结果里给用户展示的 body 字段禁止出现内部标记；邮件内容字段 draft_subject 与 draft_body 则必须保留上述标记。不要把“展示 body 禁止标记”误用于 draft_body。',
    ].join('\n'),
  };
}

export function restoreTemplateDraft(
  document: MailVariableDocument,
  subject: string | undefined,
  body: string,
  displayBody: string,
) {
  if (displayBody.includes(markerPrefix))
    throw new MailTemplateVariableError('display_marker', '展示结果包含内部变量标记');
  const masked = protectTemplateVariables(document);
  if (subject === undefined && masked.slots.some((slot) => slot.part === 'subject'))
    throw new MailTemplateVariableError('missing_subject', '模型遗漏了包含变量的邮件主题');
  return restoreTemplateVariables(document, subject ?? masked.subject, body);
}

export function restoreTemplateVariables(
  document: MailVariableDocument,
  subject: string,
  body: string,
): MailVariableDocument {
  const { slots } = protectTemplateVariables(document);
  const values = { subject, body };
  for (const slot of slots) {
    const count = (value: string) => value.split(slot.marker).length - 1;
    if (count(values[slot.part === 'subject' ? 'body' : 'subject']))
      throw new MailTemplateVariableError(
        'cross_part_marker',
        '模型移动了主题或正文的模板变量，请重新拟稿',
      );
    if (!count(values[slot.part]))
      throw new MailTemplateVariableError('missing_marker', '模型遗漏了模板变量，请重新拟稿');
    if (count(values[slot.part]) !== 1)
      throw new MailTemplateVariableError('duplicate_marker', '模型重复了模板变量，请重新拟稿');
  }
  const restore = (part: Part): MailInlineNode[] => {
    const nodes: MailInlineNode[] = [];
    let remaining = values[part];
    for (;;) {
      const next = slots
        .filter((slot) => slot.part === part && remaining.includes(slot.marker))
        .map((slot) => ({ ...slot, position: remaining.indexOf(slot.marker) }))
        .sort((a, b) => a.position - b.position)[0];
      if (!next) break;
      const text = remaining.slice(0, next.position);
      if (text.includes(markerPrefix))
        throw new MailTemplateVariableError('unknown_marker', '模型返回了未授权的变量标记');
      if (text) nodes.push({ type: 'text', text });
      nodes.push({ ...next.node });
      remaining = remaining.slice(next.position + next.marker.length);
    }
    if (remaining.includes(markerPrefix))
      throw new MailTemplateVariableError('unknown_marker', '模型返回了未授权的变量标记');
    if (remaining) nodes.push({ type: 'text', text: remaining });
    return nodes;
  };
  return { version: 1, subject: restore('subject'), body: restore('body') };
}

export function displayTemplateSlots(document: MailVariableDocument, value: string) {
  for (const { marker, node } of protectTemplateVariables(document).slots)
    value = value.split(marker).join(mailVariableText([node]));
  if (value.includes(markerPrefix))
    throw new MailTemplateVariableError('unknown_marker', '模型返回了不完整的变量引用');
  return value;
}
