export const agentFeedbackPolicyVersion = 'crm-agent-feedback-v1' as const;
export const agentFeedbackReasons = [
  'transient_provider',
  'transient_network',
  'provider_auth',
  'provider_quota',
  'invalid_response',
  'permission',
  'scope_changed',
  'cancelled',
  'deadline',
  'model_call_limit',
  'known_token_limit',
  'unknown',
] as const;
export type AgentFeedbackReason = (typeof agentFeedbackReasons)[number];
export const agentFeedbackBlockReasons = [
  'non_recoverable',
  'no_context_plan',
  'no_guard',
  'visible_output',
  'retry_limit',
] as const;
export type AgentFeedbackBlockReason = (typeof agentFeedbackBlockReasons)[number];
/** No source text, provider errors, prompts, IDs or arbitrary metadata belong here. */
export interface AgentFeedbackEvent {
  sequence: number;
  phase: 'classify' | 'answer';
  model_call: number;
  reason: AgentFeedbackReason;
  action: 'retry_model' | 'stop';
  outcome: 'selected' | 'recovered' | 'failed' | 'blocked' | 'stopped';
  retry_number: 0 | 1;
  block_reason: AgentFeedbackBlockReason | null;
}
export interface AgentFeedbackTelemetry {
  policy_version: typeof agentFeedbackPolicyVersion;
  max_model_retries: 1;
  /** A reservation may be blocked by its fresh domain guard before a new call. */
  retries_reserved: number;
  events: AgentFeedbackEvent[];
}
