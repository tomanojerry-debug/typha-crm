import type { AskScope } from './ask.js';
import type { RecordObject } from './views.js';

export const agentEntryContractVersion = 'crm-agent-entries-v1' as const;
export const agentEntryDefinitions = {
  home: { label: '首页对话', tasks: ['home_chat'], interaction: 'conversation' },
  page_ask: { label: '页面问答', tasks: ['page_question'], interaction: 'conversation' },
  home_workflow: {
    label: '对话内任务',
    tasks: ['summary', 'reply', 'compose', 'update', 'company_attribute', 'document_attributes'],
    interaction: 'conversation',
  },
  attribute: {
    label: 'AI属性整理',
    tasks: ['company_attribute', 'custom_attribute'],
    interaction: 'action',
  },
  document: {
    label: '文件内操作',
    tasks: ['document_question', 'document_attributes'],
    interaction: 'action',
  },
  activity: { label: '活动生成', tasks: ['generate_activities'], interaction: 'action' },
} as const;
export type AgentEntry = keyof typeof agentEntryDefinitions;

export const agentTaskDefinitions = {
  home_chat: { scopes: ['directory', 'entity'], result: 'answer', policy: 'conversation' },
  page_question: {
    scopes: ['entity', 'records', 'list', 'page'],
    result: 'answer',
    policy: 'answer_only',
  },
  summary: { scopes: ['workflow'], result: 'summary', policy: 'workflow_actions' },
  reply: { scopes: ['workflow'], result: 'mail_draft', policy: 'draft_review' },
  compose: { scopes: ['workflow'], result: 'mail_draft', policy: 'draft_review' },
  update: { scopes: ['workflow'], result: 'customer_changes', policy: 'review_changes' },
  company_attribute: {
    scopes: ['field'],
    result: 'attribute_candidate',
    policy: 'attribute_service',
  },
  custom_attribute: {
    scopes: ['field'],
    result: 'attribute_candidate',
    policy: 'attribute_service',
  },
  document_question: { scopes: ['document'], result: 'answer', policy: 'answer_only' },
  document_attributes: {
    scopes: ['document'],
    result: 'document_fields',
    policy: 'attribute_service',
  },
  generate_activities: { scopes: ['activity'], result: 'activities', policy: 'activity_service' },
} as const;
export type AgentTask = keyof typeof agentTaskDefinitions;

/** A model sees which conditions the server already supplied, not IDs or authorization tokens. */
export interface AgentEntryContext {
  version: typeof agentEntryContractVersion;
  entry: AgentEntry;
  task: AgentTask;
  scope_kind: (typeof agentTaskDefinitions)[AgentTask]['scopes'][number];
  scope_mode:
    | 'authorized_directory'
    | 'current_object'
    | 'selected_rows'
    | 'current_view'
    | 'current_page'
    | 'task_scope'
    | 'selected_field'
    | 'current_document'
    | 'selected_sources';
  provided: string[];
  result: (typeof agentTaskDefinitions)[AgentTask]['result'];
  policy: (typeof agentTaskDefinitions)[AgentTask]['policy'];
}

export function entrySupportsTask(entry: AgentEntry, task: AgentTask) {
  if (!Object.hasOwn(agentEntryDefinitions, entry) || !Object.hasOwn(agentTaskDefinitions, task))
    return false;
  return (agentEntryDefinitions[entry].tasks as readonly string[]).includes(task);
}

/** UI scope selection only. The server still validates the whole scope under current permissions. */
export function workbenchAskScope(input: {
  selected: { customerId: string; personId?: string; projectId?: string } | null;
  section: string;
  object: RecordObject;
  query: string;
  selectedIds: string[];
  activeListId: string | null;
  listScope: Extract<AskScope, { kind: 'list' }> | null;
}): AskScope | null {
  const target = input.selected;
  if (target)
    return {
      kind: 'entity',
      object: target.personId ? 'people' : target.projectId ? 'projects' : 'customers',
      customer_id: target.customerId,
      record_id: target.personId || target.projectId || target.customerId,
    };
  if (['customers', 'people', 'projects'].includes(input.section)) {
    if (input.activeListId)
      return input.listScope?.list_id === input.activeListId
        ? structuredClone(input.listScope)
        : null;
    return {
      kind: 'records',
      object: input.object,
      query: input.query,
      selected_ids: [...input.selectedIds],
    };
  }
  if (input.section === 'mail' || input.section === 'wechat' || input.section === 'relationships')
    return { kind: 'page', page: input.section };
  return null;
}
