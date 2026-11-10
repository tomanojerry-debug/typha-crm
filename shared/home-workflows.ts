import type { AskSource } from './ask.js';
import type { ChatDetail } from './chat.js';
import type { ReplyOptions, OutgoingMail } from './outgoing.js';
import type { MailMessage } from './connections.js';
import type { MailTemplate } from './mail-templates.js';
import type { AgentHarnessTrace } from './agent-harness.js';
import type { MailVariableDocument } from './mail-variables.js';
import type { TaskSlot } from './task-understanding.js';

export const workflowLabels = {
  summary: '总结沟通信息',
  reply: '处理客户来信',
  compose: '新建客户邮件',
  update: '更新客户资料',
} as const;
export type WorkflowKind = keyof typeof workflowLabels;
export type WorkflowTaskAction = 'message' | 'draft_current';
export type WorkflowStep =
  'configure' | 'template' | 'ready' | 'decision' | 'review' | 'completed' | 'cancelled';
export type WorkflowTemplateChoice = { kind: 'none' } | { kind: 'starter' | 'saved'; id: string };
export interface WorkflowMailTemplate extends MailTemplate {
  kind: 'starter' | 'saved';
}
export interface WorkflowHistoryScope {
  enabled: boolean;
  date_start: string | null;
  date_end: string | null;
  source_kinds: ('mail' | 'wechat')[];
  person_id: string | null;
  project_id: string | null;
}
export interface WorkflowConfig {
  /** Server-owned extraction provenance; UI round-trips it but cannot author it. */
  task_slots?: TaskSlot[];
  customer_id: string | null;
  person_id: string | null;
  project_id: string | null;
  source_kinds: ('mail' | 'wechat' | 'pasted')[];
  date_start: string | null;
  date_end: string | null;
  mail_id: string | null;
  document_id: string | null;
  material: { name: string; content: string } | null;
  instruction: string;
  field_ids: string[];
  template_choice?: WorkflowTemplateChoice | null;
  template_digest?: string | null;
  selected_template_name?: string | null;
  history_scope?: WorkflowHistoryScope | null;
}
export interface WorkflowMailIssue {
  id: string;
  question: string;
  source_ids: string[];
  quote: string;
  status: 'answerable' | 'needs_decision' | 'missing' | 'conflict';
  response: string | null;
}
export interface WorkflowMailDecision {
  issue_id: string;
  question: string;
  answer: string | null;
}
export interface WorkflowMailCoverage {
  issue_id: string;
  status: 'covered' | 'pending' | 'omitted';
  draft_quote: string | null;
}
export interface WorkflowChange {
  key: string;
  label: string;
  old_value: unknown;
  value: unknown;
  reason: string;
  source_ids: string[];
  quote: string;
  value_version: number;
  field_version?: number;
}
export interface WorkflowResult {
  body: string;
  sources: AskSource[];
  decisions: string[];
  draft_body: string | null;
  draft_subject?: string;
  variable_document?: MailVariableDocument;
  changes: WorkflowChange[];
  applied_keys: string[];
  message_id: string;
  generated_at: string;
  fill_results?: WorkflowFillOutcome[];
  issues?: WorkflowMailIssue[];
  mail_decisions?: WorkflowMailDecision[];
  coverage?: WorkflowMailCoverage[];
  mail_instructions?: string[];
  harness?: { skill: { id: string; version: string }; trace: AgentHarnessTrace[] };
}
export interface WorkflowFillOutcome {
  key: string;
  status: 'filled' | 'missing' | 'conflict' | 'preserved' | 'failed';
  explanation?: string;
  error?: string;
}
export interface HomeWorkflow {
  id: string;
  chat_id: string;
  kind: WorkflowKind;
  step: WorkflowStep;
  version: number;
  config: WorkflowConfig;
  result: WorkflowResult | null;
  customer_name: string | null;
  person_name: string | null;
  project_name: string | null;
  draft_id: string | null;
  updated_at: string;
  notice?: string | null;
}
export interface WorkflowCandidate {
  id: string;
  customer_id: string;
  object: 'customers' | 'people';
  name: string;
  customer_name: string;
  email: string;
}
export interface WorkflowField {
  key: string;
  label: string;
  kind: string;
  value: unknown;
  version: number;
  field_version?: number;
  options?: string[];
  ai_enabled: boolean;
  empty: boolean;
}
export interface WorkflowOptions {
  mails_total?: number;
  projects: { id: string; name: string }[];
  mails: {
    id: string;
    subject: string;
    sender: string;
    sent_at: string;
    project_id: string | null;
  }[];
  fields: WorkflowField[];
  can_edit: boolean;
  documents?: { id: string; name: string; project_id: string | null }[];
}
export interface WorkflowRunResponse {
  workflow: HomeWorkflow;
  detail: ChatDetail;
}
export interface WorkflowReplyResponse {
  workflow: HomeWorkflow;
  draft: OutgoingMail;
  plan: ReplyOptions;
  source?: MailMessage;
}
