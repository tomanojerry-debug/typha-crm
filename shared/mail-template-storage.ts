import type { MailTemplate } from './mail-templates.js';
import type { MailVariableDocument } from './mail-variables.js';

export type MailTemplateScope = 'customer' | 'personal';

export interface MailTemplateInput {
  request_id?: string;
  name: string;
  subject: string;
  body: string;
  scope?: MailTemplateScope;
  description?: string;
  variable_document?: MailVariableDocument;
}

export interface SavedMailTemplate extends MailTemplate {
  scope: MailTemplateScope;
  customer_id: string | null;
  created_at: string;
}
