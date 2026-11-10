import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { SavedMailTemplate } from '../shared/mail-template-storage.js';
import { ApiError, type Context } from './security.js';
import * as people from './people.js';
import * as service from './service.js';
import { mailVariableDocumentSchema, validateDocument } from './mail-variables.js';
import { mailVariableText } from '../shared/mail-variables.js';

const inputSchema = z.strictObject({
  request_id: z.uuid().optional(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine((value) => !/[\r\n]/.test(value)),
  subject: z
    .string()
    .max(500)
    .refine((value) => !/[\r\n]/.test(value)),
  body: z
    .string()
    .max(20000)
    .refine((value) => value.trim().length > 0),
  scope: z.enum(['customer', 'personal']).default('customer'),
  description: z.string().max(200).default(''),
  variable_document: mailVariableDocumentSchema.optional(),
});

type TemplateRow = Omit<SavedMailTemplate, 'keywords' | 'variable_document'> & {
  variable_document: SavedMailTemplate['variable_document'] | null;
};
const selection = 'id,scope,customer_id,name,description,subject,body,variable_document,created_at';
const template = ({ variable_document, ...row }: TemplateRow): SavedMailTemplate => ({
  ...row,
  ...(variable_document ? { variable_document } : {}),
  keywords: [],
});

async function targetCustomer(
  ctx: Context,
  id: string,
  target: 'customers' | 'people',
  write = false,
) {
  const person = target === 'people' ? await people.person(ctx, id) : null;
  const customer = await service.customer(ctx, person?.customer_id ?? id, write);
  service.activeCustomer(customer);
  if (person?.archived_at) throw new ApiError(409, '联系人已归档，请先恢复联系人');
  return customer.id;
}

export async function listMailTemplates(
  ctx: Context,
  id: string,
  target: 'customers' | 'people' = 'people',
): Promise<SavedMailTemplate[]> {
  const customerId = await targetCustomer(ctx, id, target);
  const rows = (
    await ctx.tx.query<TemplateRow>(
      `SELECT ${selection} FROM mail_templates WHERE workspace_id=$1 AND actor_id=$2
        AND (customer_id=$3 OR customer_id IS NULL) ORDER BY created_at DESC,id`,
      [ctx.workspaceId, ctx.actorId, customerId],
    )
  ).rows;
  return rows.map(template);
}

export async function createMailTemplate(
  ctx: Context,
  id: string,
  input: unknown,
  target: 'customers' | 'people' = 'people',
): Promise<SavedMailTemplate> {
  // Resolve authorization from the URL target, never from caller-supplied scope IDs.
  const customerId = await targetCustomer(ctx, id, target, true);
  const value = inputSchema.parse(input);
  if (value.variable_document) {
    value.variable_document = await validateDocument(ctx, value.variable_document);
    if (
      mailVariableText(value.variable_document.subject) !== value.subject ||
      mailVariableText(value.variable_document.body) !== value.body
    )
      throw new ApiError(400, '模板文字与变量文档不一致，请重新保存');
  }
  const requestId = value.request_id ?? randomUUID();
  const templateCustomer = value.scope === 'customer' ? customerId : null;
  const row = (
    await ctx.tx.query<TemplateRow>(
      `INSERT INTO mail_templates(workspace_id,actor_id,id,scope,customer_id,name,description,subject,body,request_id,variable_document)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT(workspace_id,actor_id,request_id) DO NOTHING RETURNING ${selection}`,
      [
        ctx.workspaceId,
        ctx.actorId,
        randomUUID(),
        value.scope,
        templateCustomer,
        value.name,
        value.description,
        value.subject,
        value.body,
        requestId,
        value.variable_document ? JSON.stringify(value.variable_document) : null,
      ],
    )
  ).rows[0];
  if (row) return template(row);
  const existing = (
    await ctx.tx.query<TemplateRow>(
      `SELECT ${selection} FROM mail_templates WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3`,
      [ctx.workspaceId, ctx.actorId, requestId],
    )
  ).rows[0];
  // A request key only retries the exact authorized creation. In particular,
  // never return another customer's content when a key is reused at a new URL.
  if (
    !existing ||
    existing.scope !== value.scope ||
    existing.customer_id !== templateCustomer ||
    existing.name !== value.name ||
    existing.subject !== value.subject ||
    existing.body !== value.body ||
    existing.description !== value.description ||
    !isDeepStrictEqual(existing.variable_document ?? undefined, value.variable_document)
  ) {
    throw new ApiError(409, '该创建请求已用于其他模板，请重新新建模板');
  }
  return template(existing);
}
