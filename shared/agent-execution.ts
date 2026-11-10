import type { AgentContextPlanSummary } from './agent-context-plan.js';
import type { AgentFeedbackTelemetry } from './agent-feedback.js';
export const agentExecutionPolicyVersion = 'crm-agent-execution-v1' as const;
export interface AgentExecutionLimits {
  maxDurationMs?: number;
  maxModelCalls?: number;
  /** Optional hard gate over reported provider tokens only; never an estimate. */
  maxKnownTokens?: number;
}
export interface AgentProviderUsage {
  input_tokens: number | null;
  output_tokens: number | null;
}
export type AgentExecutionPhase = 'classify' | 'answer';
export type AgentExecutionErrorCode =
  | 'deadline'
  | 'model_call_limit'
  | 'known_token_limit'
  | 'cancelled'
  | 'model_error'
  | 'scope_changed';
export interface AgentExecutionTelemetry {
  feedback?: AgentFeedbackTelemetry;
  context_plans?: AgentContextPlanSummary[];
  policy_version: typeof agentExecutionPolicyVersion;
  attempt: number;
  sequence: number;
  started_at: string;
  deadline_at: string;
  ended_at: string | null;
  duration_ms: number;
  limits: { duration_ms: number; model_calls: number; known_tokens: number | null };
  model_calls: {
    started: number;
    returned: number;
    failed: number;
    cancelled: number;
    active: number;
  };
  phases: Record<AgentExecutionPhase, { calls: number; duration_ms: number }>;
  provider_usage: {
    complete: boolean;
    reported_calls: number;
    partial_calls: number;
    unknown_calls: number;
    input_tokens: number | null;
    output_tokens: number | null;
    reported_input_tokens: number;
    reported_output_tokens: number;
    cost_amount: null;
  };
  error_code: AgentExecutionErrorCode | null;
  telemetry_failures: number;
}
