/** Stable references; labels are display-only and never select records or fields. */
export type MailVariableRoot =
  'recipient' | 'recipient_company' | 'customer' | 'project' | 'sender';

export interface MailTextNode {
  type: 'text';
  text: string;
}
export interface MailVariableNode {
  type: 'variable';
  id: string;
  root: MailVariableRoot;
  field: string;
  label?: string;
  /** Absence means unset; an explicitly supplied empty string is a valid fallback. */
  fallback?: string;
}
export type MailInlineNode = MailTextNode | MailVariableNode;
export interface MailVariableDocument {
  version: 1;
  subject: MailInlineNode[];
  body: MailInlineNode[];
}
export interface MailVariableField {
  root: MailVariableRoot;
  field: string;
  label: string;
  path: string[];
  kind: string;
  ai_enabled?: boolean;
}
export interface MailVariableCatalog {
  version: 1;
  fields: MailVariableField[];
}
export interface MailRecipientBinding {
  email: string;
  person_id: string;
}
export interface MailVariableIssue {
  code: string;
  message: string;
  recipient?: string;
  node_id?: string;
  root?: MailVariableRoot;
  field?: string;
  part?: 'subject' | 'body';
}
export interface MailVariableValue {
  node_id: string;
  root: MailVariableRoot;
  field: string;
  path: string[];
  value: string | null;
  state: 'value' | 'fallback' | 'empty' | 'unbound' | 'invalid' | 'stale';
  source: string;
  origin?: 'manual' | 'ai' | 'system';
  record_id?: string;
  record_version?: number;
  attribute_version?: number;
  value_version?: number;
}
export interface MailRenderedMessage {
  recipient: string | null;
  subject: string;
  body: string;
  values: MailVariableValue[];
  issues: MailVariableIssue[];
}
export interface MailVariableRecipientChoice {
  email: string;
  candidates: { person_id: string; name: string; customer_name: string }[];
}
export interface MailVariablePreview {
  digest: string;
  can_confirm: boolean;
  messages: MailRenderedMessage[];
  issues: MailVariableIssue[];
  recipient_choices: MailVariableRecipientChoice[];
  recipient_bindings: MailRecipientBinding[];
}
export interface MailVariableSnapshot {
  version: 1;
  preview_digest: string;
  messages: MailRenderedMessage[];
  recipient_bindings: MailRecipientBinding[];
}

export function mailVariableFieldKey(root: MailVariableRoot, field: string) {
  return `${root}:${field}`;
}
export function mailVariableText(nodes: MailInlineNode[]) {
  return nodes
    .map((node) =>
      node.type === 'text' ? node.text : `{${node.label || `${node.root} › ${node.field}`}}`,
    )
    .join('');
}
export function mailVariableDocumentFromText(subject: string, body: string): MailVariableDocument {
  return {
    version: 1,
    subject: subject ? [{ type: 'text', text: subject }] : [],
    body: body ? [{ type: 'text', text: body }] : [],
  };
}
export function hasMailVariables(document: MailVariableDocument | undefined | null) {
  return (
    !!document && [...document.subject, ...document.body].some((node) => node.type === 'variable')
  );
}
