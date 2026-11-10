import type { AgentEntry, AgentTask } from './agent-entries.js';
import type { AgentTaskState } from './agent-task-state.js';

export const agentContextPlanVersion = 'crm-context-plan-v1' as const;
export type AgentContextSourceKind =
  | 'business_record'
  | 'basic_directory'
  | 'user_input'
  | 'material'
  | 'template'
  | 'current_fields'
  | 'task_context';
export type AgentHistorySelection =
  | 'classification_user_turns'
  | 'authorized_recent_turns'
  | 'same_workflow_evidence'
  | 'scope_reset'
  | 'none';
export interface AgentContextDependency {
  kind: 'evidence' | 'scope' | 'workflow_generation' | 'template' | 'state';
  digest: string;
}
/** Private, per-call manifest. Never persist this object or send it wholesale to a provider. */
export interface AgentContextPlan {
  version: typeof agentContextPlanVersion;
  entry: AgentEntry;
  task: AgentTask;
  identity: { workspace_id: string; actor_id: string; chat_id?: string; run_id?: string };
  scope: { kind: string; digest: string };
  state: AgentTaskState;
  state_digest: string;
  dependencies: AgentContextDependency[];
  sources: { id: string; kind: AgentContextSourceKind; digest: string }[];
  selections: {
    sources: 'authorized_domain_selection';
    history: AgentHistorySelection;
    history_count: number;
    history_limit: 20;
    history_truncation: 'upstream_authorized_window';
    preferences: 'explicit_actor_preferences' | 'not_used_for_classification';
    preference_count: number;
    material: 'current_user_material' | 'none';
  };
  input_digest: string;
  budget: {
    measurement: 'serialized_dynamic_context_utf8';
    input_bytes: number;
    limit_bytes: number;
    overflow_policy: 'reject_without_silent_truncation';
  };
}
/** Safe Run observation: hashes, enums and counts; no source, slot or preference text. */
export interface AgentContextPlanSummary {
  version: typeof agentContextPlanVersion;
  entry: AgentEntry;
  task: AgentTask;
  phase: 'classify' | 'answer';
  scope_kind: string;
  scope_digest: string;
  state_version: string;
  state_digest: string;
  input_digest: string;
  dependency_digest: string;
  source_count: number;
  history_count: number;
  preference_count: number;
  input_bytes: number;
  limit_bytes: number;
}
