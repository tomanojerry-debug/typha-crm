import type { AskSource } from './ask.js';
import type { TaskUnderstanding, ClassificationDiagnostics } from './task-understanding.js';

export const chatIntents = ['查询资料', '分析建议', '整理录入', '起草内容', '一般对话'] as const;
export const chatActions = [
  'search_candidates',
  'lookup_entity',
  'list_customers',
  'select_candidate',
  'clarify',
  'respond',
] as const;
export type ChatEntityType = 'person' | 'company' | 'project' | 'unknown';
export type ChatMatchMode = 'surname' | 'name' | 'email';
export type CustomerListOwnership = 'owned_by_me' | 'accessible';
export interface ChatClassification extends TaskUnderstanding {
  /** Server-measured; never accepted from model output. */
  diagnostics?: ClassificationDiagnostics;
  intent: (typeof chatIntents)[number];
  target: string | null;
  missing: string[];
  reply: string;
  // Optional when reading model messages saved before the candidate workflow.
  action?: (typeof chatActions)[number];
  entity_type?: ChatEntityType;
  match_mode?: ChatMatchMode | null;
  candidate_index?: number | null;
  data_source?: 'records' | 'wechat_device' | 'none';
  /** An explicit list filter, never an actor ID or an authorization grant. */
  ownership?: CustomerListOwnership | null;
  // A task hint only; the server still validates scope and every business action.
  mail_action?: 'compose' | 'reply' | null;
}
export interface ChatRetrieval {
  status: 'not_searched' | 'candidates' | 'unique' | 'no_match' | 'listed';
  query: string | null;
  entity_type: ChatEntityType;
  match_mode: ChatMatchMode | null;
  total: number;
  truncated: boolean;
  // Server order is authoritative; model citation order never controls selection.
  candidates: AskSource[];
  /** A completed, read-only directory page; it never creates candidate selection. */
  items?: AskSource[];
  listing?: {
    object: 'customers';
    ownership: CustomerListOwnership;
    page: 1;
    page_size: 30;
    returned: number;
    /** Code-owned hash of the fixed list scope and safe directory snapshot. */
    snapshot_digest: string;
  };
  task?: {
    intent: ChatClassification['intent'];
    question: string;
    mail_action?: ChatClassification['mail_action'];
  };
}
