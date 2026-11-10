import type { AgentEntry, AgentEntryContext, AgentTask } from './agent-entries.js';

export const agentTaskStateVersion = 'crm-task-state-v1' as const;
export const agentTaskSlotNames = [
  'language',
  'style',
  'writing_requirements',
  'template_choice',
  'source_kinds',
  'date_start',
  'date_end',
  'history_enabled',
  'field_ids',
  'field_value',
  'query',
] as const;
export type AgentTaskSlotName = (typeof agentTaskSlotNames)[number];
export type AgentTaskSlotValue =
  string | number | boolean | null | (string | number | boolean | null)[];
export type AgentTaskSlotSource =
  | { kind: 'user_message'; request_id: string; evidence_digest: string }
  | { kind: 'workflow_config'; workflow_id: string; version: number }
  | { kind: 'entry_input'; version: number };
export interface AgentTaskSlot {
  name: AgentTaskSlotName;
  /** A provided null is distinct from an omitted or explicitly cleared value. */
  status: 'provided' | 'cleared' | 'missing';
  value: AgentTaskSlotValue;
  source: AgentTaskSlotSource | null;
  version: number;
  applicability: { scope_digest: string; generation: string | null };
}
export interface AgentTaskDependency {
  kind: 'scope' | 'record' | 'mail' | 'document' | 'note' | 'template' | 'field';
  id: string;
  revision: string | number | null;
  hash: string | null;
  status: 'current' | 'invalid' | 'unknown';
}
/** Server projection only. Existing Workflow/Run rows remain the persistence authority. */
export interface AgentTaskState {
  version: typeof agentTaskStateVersion;
  entry: AgentEntry;
  task: AgentTask;
  identity: {
    workspace_id: string;
    actor_id: string;
    chat_id: string | null;
    run_id: string | null;
    workflow_id: string | null;
  };
  scope: {
    kind: AgentEntryContext['scope_kind'];
    digest: string;
    customer_id: string | null;
    person_id: string | null;
    project_id: string | null;
    generation: string | null;
  };
  phase:
    | 'configure'
    | 'template'
    | 'ready'
    | 'decision'
    | 'review'
    | 'completed'
    | 'cancelled'
    | 'queued'
    | 'running'
    | 'failed'
    | 'interrupted';
  revision: number;
  slots: AgentTaskSlot[];
  dependencies: AgentTaskDependency[];
  result: {
    message_id: string | null;
    draft_id: string | null;
    scope_digest: string;
    source_digest: string | null;
    dependency_digest: string;
    generation: string | null;
  } | null;
  cancellation: { status: 'active' | 'requested' | 'cancelled'; request_id: string | null };
}
export type AgentTaskStateInvalidReason =
  | 'identity_changed'
  | 'scope_changed'
  | 'generation_changed'
  | 'cancelled'
  | 'dependency_changed'
  | 'dependency_unverified'
  | 'slot_scope_changed'
  | 'result_stale';
