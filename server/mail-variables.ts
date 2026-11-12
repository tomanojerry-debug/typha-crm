import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  MailInlineNode,
  MailVariableCatalog,
  MailVariableDocument,
  MailVariableField,
  MailVariableIssue,
  MailVariablePreview,
  MailVariableValue,
  MailRecipientBinding,
} from '../shared/mail-variables.js';
import {
  mailVariableFieldKey,
  mailVariableText,
  mailVariableDocumentFromText,
} from '../shared/mail-variables.js';
import type { OutgoingContent } from '../shared/outgoing.js';
import type { CompanyAttributeValue, AttributeValue } from '../shared/attributes.js';
import type { Person } from '../shared/domain.js';
import { entitySchema } from './entity-schema.js';
import { sanitizeAttributeSources } from './attribute-source-visibility.js';
import { ApiError, type Context } from './security.js';
import * as service from './service.js';

export function variableDataDigest(value: unknown) {
  return createHash('sha256')
    .update(
      JSON.stringify(value ?? null, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest('hex');
}

const rootSchema = z.enum(['recipient', 'recipient_company', 'customer', 'project', 'sender']);
const nodeSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string().max(100000) }),
  z.strictObject({
    type: z.literal('variable'),
    id: z.string().min(1).max(100),
    root: rootSchema,
    field: z.string().min(1).max(200),
    label: z.string().max(200).optional(),
    fallback: z.string().max(5000).optional(),
  }),
]);
export const mailVariableDocumentSchema = z
  .strictObject({
    version: z.literal(1),
    subject: z.array(nodeSchema).max(256),
    body: z.array(nodeSchema).max(256),
  })
  .superRefine((doc, ctx) => {
    const ids = new Set<string>();
    let variables = 0;
    for (const part of ['subject', 'body'] as const) {
      for (const node of doc[part]) {
        if (node.type === 'variable') {
          variables++;
          if (ids.has(node.id)) ctx.addIssue({ code: 'custom', message: '变量编号不能重复' });
          ids.add(node.id);
        }
        if (
          part === 'subject' &&
          /[\r\n]/.test(
            node.type === 'text' ? node.text : `${node.label || ''}${node.fallback || ''}`,
          )
        )
          ctx.addIssue({ code: 'custom', message: '主题变量和备用文案不能换行' });
      }
      if (mailVariableText(doc[part]).length > (part === 'subject' ? 500 : 100000))
        ctx.addIssue({ code: 'custom', message: '变量文档超过邮件长度限制' });
    }
    if (variables > 100) ctx.addIssue({ code: 'custom', message: '每封邮件最多插入100个变量' });
  });

export const mailRecipientBindingsSchema = z
  .array(z.strictObject({ email: z.email().trim().toLowerCase().max(254), person_id: z.uuid() }))
  .max(20)
  .refine(
    (items) => new Set(items.map((b) => b.email)).size === items.length,
    '收件人绑定不能重复',
  );

const allowed = {
  people: ['name', 'job_title', 'email', 'phone'],
  customers: ['name', 'region', 'email', 'phone', 'type', 'contact_name'],
  projects: ['name', 'due_date', 'type', 'stage'],
};
const companyLabels: Record<string, string> = {
  name: '公司名称',
  region: '地区',
  email: '公司邮箱',
  phone: '公司电话',
  type: '客户类型',
  contact_name: '主要联系人姓名',
};

/** Definitions only: no customer records, messages or attribute values are read. */
export async function mailVariableCatalog(ctx: Context): Promise<MailVariableCatalog> {
  const schema = await entitySchema(ctx);
  const fields: MailVariableField[] = [];
  for (const [objectId, roots] of [
    ['people', ['recipient']],
    ['customers', ['recipient_company', 'customer']],
    ['projects', ['project']],
  ] as const) {
    const object = schema.objects?.find((o) => o.id === objectId);
    for (const attribute of object?.attributes || []) {
      const key = attribute.storage_key || attribute.id.replace(`${objectId}:`, '');
      if (attribute.system && !allowed[objectId].includes(key)) continue;
      if (!attribute.system && objectId !== 'customers') continue;
      for (const root of roots) {
        const label =
          objectId === 'customers' && attribute.system
            ? companyLabels[key] || attribute.name
            : attribute.name;
        fields.push({
          root,
          field: attribute.id,
          label,
          path:
            root === 'recipient_company'
              ? ['收件人', '所属公司', label]
              : [
                  root === 'recipient' ? '收件人' : root === 'customer' ? '当前公司' : '当前项目',
                  label,
                ],
          kind: attribute.type,
          ...(attribute.ai_enabled ? { ai_enabled: true } : {}),
        });
      }
    }
  }
  fields.push({
    root: 'sender',
    field: 'mail_accounts:email',
    label: '发件邮箱',
    path: ['发件账号', '发件邮箱'],
    kind: 'email',
  });
  return { version: 1, fields };
}

export async function validateDocument(
  ctx: Context,
  document: unknown,
): Promise<MailVariableDocument> {
  const doc = mailVariableDocumentSchema.parse(document);
  const catalog = await mailVariableCatalog(ctx);
  const keys = new Set(catalog.fields.map((f) => mailVariableFieldKey(f.root, f.field)));
  for (const node of [...doc.subject, ...doc.body]) {
    if (node.type === 'variable' && !keys.has(mailVariableFieldKey(node.root, node.field)))
      throw new ApiError(400, '变量引用不存在、已停用或不适合邮件，请重新选择字段');
  }
  return doc;
}

/** Bindings use exact authorized record IDs and must still match the actual To. */
export async function validateRecipientBindings(
  ctx: Context,
  customerId: string,
  to: string[],
  bindings: MailRecipientBinding[] = [],
) {
  for (const binding of bindings) {
    if (!to.includes(binding.email))
      throw new ApiError(409, '联系人绑定与当前收件邮箱不一致，请重新选择');
    const person = (
      await ctx.tx.query<Person>(
        'SELECT * FROM people WHERE workspace_id=$1 AND customer_id=$2 AND id=$3 AND archived_at IS NULL',
        [ctx.workspaceId, customerId, binding.person_id],
      )
    ).rows[0];
    if (!person || person.email.trim().toLowerCase() !== binding.email)
      throw new ApiError(409, '绑定联系人已失效、不属于当前公司或邮箱已变化，请重新选择');
  }
}

interface VariableMail {
  id: string;
  version: number;
  customer_id: string;
  account_id: string | null;
  project_id: string | null;
  content: Omit<OutgoingContent, 'account_id' | 'project_id'>;
}

/** Resolves the saved version without writing a preview, draft, approval or schedule. */
export async function previewMailVariables(
  ctx: Context,
  mail: VariableMail,
  authorizedSender: { id: string; email: string } | null = null,
): Promise<MailVariablePreview> {
  const document = mailVariableDocumentSchema.parse(
    mail.content.variable_document ||
      mailVariableDocumentFromText(mail.content.subject, mail.content.body),
  );
  const customer = await service.customer(ctx, mail.customer_id);
  service.activeCustomer(customer);
  const catalog = await mailVariableCatalog(ctx);
  const fields = new Map(catalog.fields.map((f) => [mailVariableFieldKey(f.root, f.field), f]));
  const schema = await entitySchema(ctx);
  const variables = [...document.subject, ...document.body].filter((n) => n.type === 'variable');
  const personal = variables.some((n) => ['recipient', 'recipient_company'].includes(n.root));
  const bindings = mailRecipientBindingsSchema.parse(mail.content.recipient_bindings || []);
  const candidates =
    personal || bindings.length
      ? (
          await ctx.tx.query<Person & { customer_name: string }>(
            `SELECT p.*,c.name AS customer_name FROM people p JOIN customers c ON c.workspace_id=p.workspace_id AND c.id=p.customer_id
      WHERE p.workspace_id=$1 AND p.customer_id=$2 AND p.archived_at IS NULL AND c.archived_at IS NULL
      AND lower(trim(p.email))=ANY($3::text[]) ORDER BY p.name,p.id`,
            [ctx.workspaceId, customer.id, mail.content.to],
          )
        ).rows
      : [];
  const choices = personal
    ? mail.content.to.map((email) => ({
        email,
        candidates: candidates
          .filter((p) => p.email.trim().toLowerCase() === email)
          .map((p) => ({ person_id: p.id, name: p.name, customer_name: p.customer_name })),
      }))
    : [];
  const resolvedBindings = mail.content.to.flatMap((email) => {
    const explicit = bindings.find((b) => b.email === email);
    if (explicit) return [explicit];
    const exact = candidates.filter((p) => p.email.trim().toLowerCase() === email);
    return exact.length === 1 ? [{ email, person_id: exact[0].id }] : [];
  });
  const project = mail.project_id ? await service.project(ctx, customer.id, mail.project_id) : null;
  const sender = authorizedSender?.id === mail.account_id ? authorizedSender : null;
  const customIds = [
    ...new Set(
      variables
        .filter(
          (n) =>
            ['customer', 'recipient_company'].includes(n.root) && !n.field.startsWith('customers:'),
        )
        .map((n) => n.field),
    ),
  ];
  const attributeRows = customIds.length
    ? (
        await ctx.tx.query<CompanyAttributeValue>(
          'SELECT attribute_id,customer_id,value,origin,sources,version FROM customer_attribute_values WHERE workspace_id=$1 AND customer_id=$2 AND attribute_id=ANY($3::uuid[])',
          [ctx.workspaceId, customer.id, customIds.filter((id) => z.uuid().safeParse(id).success)],
        )
      ).rows
    : [];
  const stale = new Set<string>();
  for (const attribute of attributeRows) {
    if (attribute.origin === 'ai' && attribute.value !== null) {
      const safe = await sanitizeAttributeSources(ctx, customer.id, attribute.sources);
      if (safe.invalid) stale.add(attribute.attribute_id);
    }
  }
  const recipients = mail.content.mass_sending
    ? mail.content.to
    : [mail.content.to.length === 1 ? mail.content.to[0] : null];
  const messages = recipients.map((recipient) => {
    const values: MailVariableValue[] = [];
    const issues: MailVariableIssue[] = [];
    const binding = resolvedBindings.find((b) => b.email === recipient);
    const person = binding
      ? candidates.find(
          (p) => p.id === binding.person_id && p.email.trim().toLowerCase() === recipient,
        )
      : undefined;
    const render = (nodes: MailInlineNode[], part: 'subject' | 'body') =>
      nodes
        .map((node) => {
          if (node.type === 'text') return node.text;
          const field = fields.get(mailVariableFieldKey(node.root, node.field));
          let raw: AttributeValue | undefined;
          let state: MailVariableValue['state'] = 'value';
          let reason = '';
          let source = '';
          let origin: MailVariableValue['origin'] = 'manual';
          let record_id: string | undefined;
          let record_version: number | undefined;
          let attribute_version: number | undefined;
          let value_version: number | undefined;
          if (!field) {
            state = 'invalid';
            reason = '字段已停用、无权访问或不适合邮件，请重新选择';
          } else if (
            ['recipient', 'recipient_company'].includes(node.root) &&
            !mail.content.mass_sending &&
            mail.content.to.length !== 1
          ) {
            state = 'invalid';
            reason = '普通多人邮件不能使用个人变量，请改用当前公司或共同称呼';
          } else if (['recipient', 'recipient_company'].includes(node.root) && !person) {
            state = binding ? 'invalid' : 'unbound';
            reason = binding
              ? '绑定联系人已失效或邮箱已变化，请重新选择'
              : '请为收件邮箱明确选择联系人记录';
          } else if (node.root === 'recipient') {
            raw = person![node.field.replace('people:', '') as 'name'];
            source = `people:${person!.id}`;
            record_id = person!.id;
            record_version = person!.version;
          } else if (node.root === 'customer' || node.root === 'recipient_company') {
            source = `${node.root === 'recipient_company' ? `people:${person!.id}/` : ''}customers:${customer.id}`;
            record_id = customer.id;
            record_version = customer.version;
            if (node.field.startsWith('customers:')) {
              const key = node.field.replace('customers:', '');
              raw = customer[key as 'name'];
              const definition = schema.objects
                ?.find((o) => o.id === 'customers')
                ?.attributes.find((a) => a.id === node.field);
              if (raw != null && definition?.option_labels)
                raw = definition.option_labels[String(raw)] || String(raw);
            } else {
              const attribute = attributeRows.find((a) => a.attribute_id === node.field);
              raw = attribute?.value ?? null;
              origin = attribute?.origin || 'manual';
              source = `${node.root === 'recipient_company' ? `people:${person!.id}/` : ''}customers:${customer.id}/attribute:${node.field}`;
              attribute_version = schema.company_attributes.find(
                (a) => a.id === node.field,
              )?.version;
              value_version = attribute?.version;
              if (stale.has(node.field)) {
                state = 'stale';
                reason = 'AI属性依据已失效，请先核对或重新整理';
              }
            }
          } else if (node.root === 'project') {
            if (!project || project.archived_at) {
              state = 'unbound';
              reason = '请先明确选择当前公司的有效项目';
            } else {
              raw = project[node.field.replace('projects:', '') as 'name'];
              source = `projects:${project.id}`;
              record_id = project.id;
              record_version = project.version;
              const definition = schema.objects
                ?.find((o) => o.id === 'projects')
                ?.attributes.find((a) => a.id === node.field);
              if (raw != null && definition?.option_labels)
                raw = definition.option_labels[String(raw)] || String(raw);
            }
          } else if (node.root === 'sender') {
            if (!sender) {
              state = 'unbound';
              reason = '请先选择有效发件账号';
            } else {
              raw = sender.email;
              source = `mail_accounts:${mail.account_id}`;
              record_id = mail.account_id!;
              origin = 'system';
            }
          }
          let value =
            state === 'value'
              ? Array.isArray(raw)
                ? raw.join('、')
                : raw == null
                  ? ''
                  : String(raw)
              : null;
          if (state === 'value' && !value?.trim()) {
            if (node.fallback !== undefined) {
              state = 'fallback';
              value = node.fallback;
            } else {
              state = 'empty';
              value = null;
              reason = '字段没有值，请设置备用文案或改写邮件';
            }
          }
          values.push({
            node_id: node.id,
            root: node.root,
            field: node.field,
            path: field?.path || [node.root, node.field],
            value,
            state,
            source,
            origin,
            record_id,
            record_version,
            attribute_version,
            value_version,
          });
          if (reason)
            issues.push({
              code: state,
              message: reason,
              node_id: node.id,
              root: node.root,
              field: node.field,
              part,
              ...(recipient ? { recipient } : {}),
            });
          return value ?? mailVariableText([node]);
        })
        .join('');
    const subject = render(document.subject, 'subject'),
      body = render(document.body, 'body');
    if (!subject.trim() || subject.length > 500 || /[\r\n]/.test(subject))
      issues.push({
        code: 'invalid_subject',
        message: '填值后的主题为空、换行或超过500字符',
        part: 'subject',
      });
    if (!body.trim() || body.length > 100000)
      issues.push({
        code: 'invalid_body',
        message: '填值后的正文为空或超过长度限制',
        part: 'body',
      });
    return { recipient: recipient || null, subject, body, values, issues };
  });
  const issues = messages.flatMap((m) => m.issues);
  if (!mail.content.to.length) issues.push({ code: 'no_recipient', message: '请先填写收件人' });
  const digest = variableDataDigest([
    ctx.workspaceId,
    ctx.actorId,
    mail.id,
    mail.version,
    mail.customer_id,
    mail.project_id,
    mail.account_id,
    mail.content,
    messages,
    resolvedBindings,
  ]);
  return {
    digest,
    can_confirm: issues.length === 0,
    messages,
    issues,
    recipient_choices: choices.filter(
      (choice) => !resolvedBindings.some((b) => b.email === choice.email),
    ),
    recipient_bindings: resolvedBindings,
  };
}
