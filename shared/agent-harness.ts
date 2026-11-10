export const agentHarnessPolicyVersion = 'crm-harness-v2' as const;
export const agentToolContractVersion = 'crm-tool-contracts-v1' as const;
export const agentHarnessSteps = [
  'read_sources',
  'read_template',
  'analyze_mail',
  'compose_mail',
  'validate_result',
  'save_draft',
] as const;
export type AgentHarnessStep = (typeof agentHarnessSteps)[number];
export const agentHarnessTools = [
  'crm.read_sources',
  'crm.read_template',
  'model.generate',
  'result.validate',
  'crm.save_draft',
] as const;
export type AgentHarnessTool = (typeof agentHarnessTools)[number];
export interface AgentToolContract {
  readonly version: typeof agentToolContractVersion;
  readonly kind: 'read' | 'model' | 'validation' | 'write';
  readonly effects: readonly (
    | 'read_authorized_sources'
    | 'read_selected_template'
    | 'call_configured_model'
    | 'validate_result'
    | 'create_or_read_private_draft'
  )[];
  readonly idempotency: 'read_only' | 'not_idempotent' | 'deterministic' | 'stable_operation_id';
  readonly retry: {
    /** Metadata is not an executor retry policy or an authorization to retry. */
    readonly automatic: false;
    readonly eligible_errors: readonly ('transient_read' | 'transient_model')[];
    readonly unknown_outcome: 'stop' | 'read_authoritative_result';
  };
}
const toolContract = (value: Omit<AgentToolContract, 'version'>): AgentToolContract =>
  Object.freeze({
    ...value,
    version: agentToolContractVersion,
    effects: Object.freeze([...value.effects]),
    retry: Object.freeze({
      ...value.retry,
      eligible_errors: Object.freeze([...value.retry.eligible_errors]),
    }),
  });
/** Code-owned behavior descriptions. They never grant scope or send permission. */
export const agentToolContracts: Readonly<Record<AgentHarnessTool, AgentToolContract>> =
  Object.freeze({
    'crm.read_sources': toolContract({
      kind: 'read',
      effects: ['read_authorized_sources'],
      idempotency: 'read_only',
      retry: { automatic: false, eligible_errors: ['transient_read'], unknown_outcome: 'stop' },
    }),
    'crm.read_template': toolContract({
      kind: 'read',
      effects: ['read_selected_template'],
      idempotency: 'read_only',
      retry: { automatic: false, eligible_errors: ['transient_read'], unknown_outcome: 'stop' },
    }),
    'model.generate': toolContract({
      kind: 'model',
      effects: ['call_configured_model'],
      idempotency: 'not_idempotent',
      retry: { automatic: false, eligible_errors: ['transient_model'], unknown_outcome: 'stop' },
    }),
    'result.validate': toolContract({
      kind: 'validation',
      effects: ['validate_result'],
      idempotency: 'deterministic',
      retry: { automatic: false, eligible_errors: [], unknown_outcome: 'stop' },
    }),
    'crm.save_draft': toolContract({
      kind: 'write',
      effects: ['create_or_read_private_draft'],
      idempotency: 'stable_operation_id',
      retry: {
        automatic: false,
        eligible_errors: [],
        unknown_outcome: 'read_authoritative_result',
      },
    }),
  });
export type AgentSkillId = 'handle-incoming-mail';
export interface AgentHarnessContext {
  workspaceId: string;
  actorId: string;
  customerId: string;
  projectId: string | null;
  chatId: string;
  runId: string;
  workflowId?: string;
  workflowVersion?: number;
}
export const agentHarnessErrorCodes = [
  'invalid_input',
  'invalid_output',
  'tool_not_allowed',
  'step_limit',
  'context_budget',
  'deadline',
  'cancelled',
  'permission',
  'scope_changed',
  'execution',
  'trace_unavailable',
  'run_budget',
  'model_call_limit',
  'known_token_limit',
] as const;
export type AgentHarnessErrorCode = (typeof agentHarnessErrorCodes)[number];

/** Deliberately contains no input/output text, error messages or model reasoning. */
export interface AgentHarnessTrace {
  run_id: string;
  workspace_id: string;
  actor_id: string;
  chat_id: string;
  customer_id: string;
  project_id: string | null;
  workflow_id?: string;
  workflow_version?: number;
  skill_id: AgentSkillId;
  skill_version: string;
  policy_version: typeof agentHarnessPolicyVersion | 'crm-harness-v1';
  /** Absent on pre-contract historical traces. */
  tool_contract_version?: typeof agentToolContractVersion;
  operation_id?: string;
  /** A rejected/expired write is never assumed to have rolled back. */
  write_outcome?: 'not_started' | 'completed' | 'unknown';
  step_id: AgentHarnessStep;
  tool_id: AgentHarnessTool;
  sequence: number;
  status: 'started' | 'succeeded' | 'failed' | 'cancelled';
  input_digest: string;
  output_digest?: string;
  started_at: string;
  duration_ms: number;
  error_code?: AgentHarnessErrorCode;
  /** The model adapter has not supplied billing telemetry; never infer a charge. */
  usage: { available: false };
}
