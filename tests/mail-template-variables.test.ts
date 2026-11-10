import { describe, expect, it } from 'vitest';
import type { MailVariableDocument } from '../shared/mail-variables.js';
import {
  displayTemplateSlots,
  mailTemplateVariableContract,
  MailTemplateVariableError,
  protectTemplateVariables,
  restoreTemplateDraft,
  restoreTemplateVariables,
} from '../server/mail-template-variables.js';

const document: MailVariableDocument = {
  version: 1,
  subject: [
    { type: 'text', text: '给' },
    {
      type: 'variable',
      id: 'company',
      root: 'recipient_company',
      field: 'customers:name',
      label: '收件人 › 所属公司 › 公司名称',
    },
  ],
  body: [
    {
      type: 'variable',
      id: 'name',
      root: 'recipient',
      field: 'people:name',
      fallback: '',
      label: '收件人 › 姓名',
    },
    { type: 'text', text: '您好。' },
  ],
};

describe('model template slots', () => {
  it('gives the model a partitioned mandatory contract without customer values or field authority', () => {
    const masked = protectTemplateVariables(document),
      contract = mailTemplateVariableContract(document)!;
    expect(contract.subjectRequired).toBe(true);
    expect(contract.instructions).toContain('本轮 draft_subject 必填，不可省略');
    for (const slot of masked.slots) expect(contract.instructions).toContain(slot.marker);
    expect(contract.instructions).toContain('不要把“展示 body 禁止标记”误用于 draft_body');
    expect(contract.instructions).not.toMatch(/people:name|customers:name|沈|澄光/);
    const bodyOnly = { ...document, subject: [{ type: 'text' as const, text: '系统测试' }] };
    expect(mailTemplateVariableContract(bodyOnly)?.subjectRequired).toBe(false);
    expect(mailTemplateVariableContract(bodyOnly)?.instructions).toContain(
      '本轮 draft_subject 可以省略',
    );
    expect(
      mailTemplateVariableContract({
        version: 1,
        subject: [],
        body: [{ type: 'text', text: 'Hi' }],
      }),
    ).toBeNull();
  });

  it('keeps display instructions separate and provides fixed diagnostics for safe correction', () => {
    const masked = protectTemplateVariables(document);
    for (const [subject, body, display, code] of [
      [undefined, masked.body, '已拟稿', 'missing_subject'],
      [masked.subject, '普通正文', '已拟稿', 'missing_marker'],
      [masked.subject, masked.body + masked.slots[1].marker, '已拟稿', 'duplicate_marker'],
      [masked.subject + masked.slots[1].marker, masked.body, '已拟稿', 'cross_part_marker'],
      [masked.subject, masked.body + '[[CRM_SLOT:forged]]', '已拟稿', 'unknown_marker'],
      [masked.subject, masked.body, masked.slots[1].marker, 'display_marker'],
    ]) {
      try {
        restoreTemplateDraft(document, subject, body!, display!);
        throw Error('Expected variable validation error');
      } catch (error) {
        expect(error).toBeInstanceOf(MailTemplateVariableError);
        expect((error as MailTemplateVariableError).code).toBe(code);
        expect((error as Error).message).not.toContain('[[CRM_SLOT:');
      }
    }
    expect(restoreTemplateDraft(document, masked.subject, masked.body, '已拟稿')).toEqual(document);
  });

  it('restores exactly the authorized references while allowing ordinary copy changes', () => {
    const masked = protectTemplateVariables(document);
    expect(masked.body).not.toContain('people:name');
    const restored = restoreTemplateVariables(
      document,
      `核对：${masked.subject}`,
      `${masked.body}谢谢。`,
    );
    expect(restored.subject[1]).toEqual(document.subject[1]);
    expect(restored.body[0]).toEqual(document.body[0]);
    expect(restored.body[1]).toEqual({ type: 'text', text: '您好。谢谢。' });
    expect(displayTemplateSlots(document, masked.body)).toBe('{收件人 › 姓名}您好。');
  });
  it('rejects omitted, duplicated, cross-part and invented markers', () => {
    const masked = protectTemplateVariables(document),
      marker = masked.slots.find((slot) => slot.part === 'body')!.marker;
    for (const [subject, body] of [
      [masked.subject, '您好。'],
      [masked.subject, masked.body + marker],
      [masked.subject + marker, '您好。'],
      [masked.subject, masked.body + '[[CRM_SLOT:body:invented]]'],
    ])
      expect(() => restoreTemplateVariables(document, subject, body)).toThrow();
    expect(() => displayTemplateSlots(document, '部分标记[[CRM_SLOT:body:')).toThrow();
  });
  it('keeps slots stable when only surrounding draft text changes', () => {
    const before = protectTemplateVariables(document);
    const restored = restoreTemplateVariables(document, before.subject, `敬请：${before.body}`);
    expect(protectTemplateVariables(restored).slots).toEqual(before.slots);
  });
});
