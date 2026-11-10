import { describe, expect, it } from 'vitest';
import {
  addStarterTemplateVariables,
  mailTemplates,
  searchMailTemplates,
} from '../shared/mail-templates.js';
import { mailVariableText, type MailVariableDocument } from '../shared/mail-variables.js';
import { mailVariableDocumentSchema } from '../server/mail-variables.js';

describe('starter email template variables', () => {
  it('upgrades all seven starters into valid unbound documents with consistent display text', () => {
    expect(mailTemplates.map((template) => template.id)).toEqual([
      'product-size-inquiry',
      'group-custom-requirements',
      'sample-feedback-receipt',
      'order-shipping-inquiry',
      'product-size-inquiry-en',
      'group-custom-requirements-en',
      'overseas-wholesale-inquiry',
    ]);
    for (const template of mailTemplates) {
      const document = mailVariableDocumentSchema.parse(template.variable_document);
      expect(mailVariableText(document.subject)).toBe(template.subject);
      expect(mailVariableText(document.body)).toBe(template.body);
      const variables = [...document.subject, ...document.body].filter(
        (node) => node.type === 'variable',
      );
      expect(
        variables.some((node) => node.root === 'recipient' && node.field === 'people:name'),
      ).toBe(true);
      expect(
        variables.some((node) => node.root === 'sender' && node.field === 'mail_accounts:email'),
      ).toBe(true);
      expect(new Set(variables.map((node) => `${node.root}:${node.field}`))).toEqual(
        new Set([
          'recipient:people:name',
          'sender:mail_accounts:email',
          ...([
            'group-custom-requirements',
            'group-custom-requirements-en',
            'overseas-wholesale-inquiry',
          ].includes(template.id)
            ? ['recipient_company:customers:name']
            : []),
        ]),
      );
      expect(JSON.stringify(document)).not.toContain('@');
      expect(template.body).not.toMatch(
        /【待填写：(客户称呼|Customer name|Contact name|发件人署名|Sender name(?: and company)?)】/u,
      );
    }
  });

  it('keeps unknown business slots and the original confirmation wording manual', () => {
    const get = (id: string) => mailTemplates.find((template) => template.id === id)!;
    expect(get('product-size-inquiry').subject).toContain('【待填写：款式名称】');
    expect(get('product-size-inquiry-en').body).toContain('【待填写：Style name or product link】');
    expect(get('sample-feedback-receipt').body).toContain('【待填写：款式编号或名称、样衣版本】');
    expect(get('sample-feedback-receipt').body).toContain(
      '是否调整、调整方案及时间，仍需评估并另行确认',
    );
    expect(get('order-shipping-inquiry').subject).toContain('【待填写：订单编号】');
    expect(get('overseas-wholesale-inquiry').body).toContain(
      'subject to separate review and written confirmation',
    );
    expect(get('group-custom-requirements').subject).toContain('{收件人 › 所属公司 › 公司名称}');
  });

  it('converts only exact known placeholders and is idempotent without altering saved metadata', () => {
    const original = {
      id: 'saved-copy',
      scope: 'customer',
      customer_id: 'fixture-customer',
      subject: '【待填写：Company name】',
      body: 'Hi 【待填写：Contact name】,\n【待填写：订单编号】\n【待填写：Sender name and company】',
    };
    const upgraded = addStarterTemplateVariables(original);
    expect(upgraded).toMatchObject({
      id: original.id,
      scope: original.scope,
      customer_id: original.customer_id,
    });
    expect(upgraded.subject).toBe('{收件人 › 所属公司 › 公司名称}');
    expect(upgraded.body).toBe('Hi {收件人 › 姓名},\n【待填写：订单编号】\n{发件账号 › 发件邮箱}');
    expect(addStarterTemplateVariables(upgraded)).toBe(upgraded);
    expect(original.body).toContain('【待填写：Contact name】');
    const unknown = {
      subject: '【待填写：订单编号】',
      body: '【待填写：客户公司所在地】【待填写：constructor】【待填写：__proto__】',
    };
    expect(addStarterTemplateVariables(unknown)).toBe(unknown);
    const document: MailVariableDocument = {
      version: 1,
      subject: [],
      body: [{ type: 'text', text: '【待填写：客户称呼】' }],
    };
    const existing = { subject: '', body: '【待填写：客户称呼】', variable_document: document };
    expect(addStarterTemplateVariables(existing)).toBe(existing);
  });
});

describe('starter email template search', () => {
  it('returns a fresh catalogue list for an empty query without reordering it', () => {
    const ids = mailTemplates.map((template) => template.id);
    const results = searchMailTemplates(' \t ');
    expect(results).not.toBe(mailTemplates);
    expect(results.map((template) => template.id)).toEqual(ids);
    searchMailTemplates('反馈');
    expect(mailTemplates.map((template) => template.id)).toEqual(ids);
  });

  it('finds Chinese fragments and ranks a named scenario ahead of body mentions', () => {
    expect(searchMailTemplates('尺码')[0].id).toBe('product-size-inquiry');
    expect(searchMailTemplates('反馈').map((template) => template.id)).toEqual([
      'sample-feedback-receipt',
    ]);
  });

  it('requires every keyword, across fields and regardless of punctuation', () => {
    expect(searchMailTemplates('团体、尺码').map((template) => template.id)).toEqual([
      'group-custom-requirements',
      'group-custom-requirements-en',
    ]);
    expect(searchMailTemplates('样衣 物流')).toEqual([]);
    expect(searchMailTemplates('不存在的业务场景')).toEqual([]);
  });

  it('includes the two English counterparts and searches only the supplied catalogue', () => {
    expect(searchMailTemplates('商品 英文').map((template) => template.id)).toEqual([
      'product-size-inquiry-en',
    ]);
    expect(searchMailTemplates('团体 英文').map((template) => template.id)).toEqual([
      'group-custom-requirements-en',
    ]);
    const visible = [{ ...mailTemplates[0], id: 'private', name: '本人尺寸回复' }];
    expect(searchMailTemplates('尺寸', visible).map((template) => template.id)).toEqual([
      'private',
    ]);
    expect(searchMailTemplates('海外', visible)).toEqual([]);
  });

  it('normalizes English case and width and supports bounded keyword abbreviations', () => {
    expect(searchMailTemplates('Ｂ２Ｂ')[0].id).toBe('overseas-wholesale-inquiry');
    expect(searchMailTemplates('WHOLESALE distributor')[0].id).toBe('overseas-wholesale-inquiry');
    expect(searchMailTemplates('TRK')[0].id).toBe('order-shipping-inquiry');
    expect(searchMailTemplates('ctm')[0].id).toBe('group-custom-requirements');
    expect(searchMailTemplates('物流x')).toEqual([]);
  });
});
