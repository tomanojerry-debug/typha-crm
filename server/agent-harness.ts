import { createHash } from 'node:crypto';
import { agentContextPlanToolSchema } from './agent-context-plan.js';
import { z } from 'zod';
import {
  agentHarnessPolicyVersion,
  agentToolContracts,
  agentToolContractVersion,
  agentHarnessSteps,
  agentHarnessTools,
  type AgentHarnessContext,
  type AgentHarnessErrorCode,
  type AgentHarnessStep,
  type AgentHarnessTool,
  type AgentHarnessTrace,
  type AgentSkillId,
} from '../shared/agent-harness.js';
import { getAgentSkill, type AgentSkill } from './agent-skills.js';
import { ApiError } from './security.js';
import { chatActions, chatIntents } from '../shared/chat-intent.js';
import { userPreferenceOptions, type UserPreferenceKey } from '../shared/user-preferences.js';
import { taskSlotUpdatesSchema } from './task-understanding.js';

const id = z.uuid();
const version = z.number().int().positive();
const label = z.string().max(10000);
// These two extension objects are already constructed by domain services. Check
// their JSON wire representation, not a purported complete catalog/entry schema.
// Their meaning, scope and available capabilities remain the producer's concern.
const producerJson = z.preprocess(
  (value) => {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  },
  z.record(z.string(), z.json()),
);
export const agentSourceToolSchema = z.strictObject({
  id: z.string().min(1).max(200),
  title: label,
  body: z.string().max(100000),
  ref: z
    .strictObject({
      kind: z.enum(['entity', 'record', 'mail']),
      id,
      title: label,
      description: label,
      customer_id: id,
      company_name: label.optional(),
      directory_fields: z
        .array(z.strictObject({ label, value: label }))
        .max(50)
        .optional(),
      object: z.enum(['customers', 'people', 'projects']).optional(),
      project_id: id.optional(),
      person_id: id.optional(),
      note_id: id.optional(),
      note_revision_id: id.optional(),
      note_version: version.optional(),
      source_hash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .optional(),
});
const companyDirectory = z.strictObject({
  id,
  name: label,
  type: z.string().max(100),
  region: label,
  contact_name: label,
  email: z.string().max(254),
  phone: z.string().max(200),
  status: z.string().max(100),
  version,
});
const contactDirectory = z.strictObject({
  id,
  name: label,
  email: z.string().max(254),
  phone: z.string().max(200),
  job_title: label,
  company_id: id,
  version,
});
const mailDirectory = z.strictObject({
  source_nature: z.literal('authorized_basic_directory'),
  current_company: companyDirectory,
  selected_contact: contactDirectory.nullable(),
  recipient_basis: z.enum(['explicit_compose_target', 'reply_envelope_not_resolved']),
  recipient: contactDirectory
    .omit({ job_title: true })
    .extend({
      kind: z.enum(['person', 'company']),
      job_title: label.optional(),
    })
    .nullable(),
  recipient_company: companyDirectory.nullable(),
  project: z
    .strictObject({
      id,
      name: label,
      type: z.string().max(100),
      stage: z.string().max(100),
      due_date: z.preprocess(
        (value) => (value instanceof Date ? value.toISOString() : value),
        z.string().max(50).nullable(),
      ),
      version,
    })
    .nullable(),
});
export const agentSnapshotToolSchema = z.strictObject({
  label,
  sources: z.array(agentSourceToolSchema).max(200),
  warnings: z.array(z.string().max(100000)).max(200),
  mail_directory: mailDirectory.optional(),
  task_state: producerJson.optional(),
  schema: producerJson.optional(),
});
const history = z
  .array(
    z.strictObject({
      role: z.enum(['user', 'assistant']),
      // A private editable draft may be appended to one existing turn. Keep the
      // established 20 turns; do not silently truncate or summarize their content.
      content: z.string().max(1500000),
    }),
  )
  .max(20);
const preferences = z
  .array(
    z.strictObject({
      category: z.enum(
        Object.keys(userPreferenceOptions) as [UserPreferenceKey, ...UserPreferenceKey[]],
      ),
      value: z.string().max(5000),
    }),
  )
  .max(8);
const classification = z.strictObject({
  intent: z.enum(chatIntents),
  target: z.string().max(254).nullable(),
  missing: z.array(z.string().max(100)).max(5),
  reply: z.string().min(1).max(1000),
  action: z.enum(chatActions).optional(),
  entity_type: z.enum(['person', 'company', 'project', 'unknown']).optional(),
  match_mode: z.enum(['surname', 'name', 'email']).nullable().optional(),
  candidate_index: z.number().int().min(1).max(10).nullable().optional(),
  data_source: z.enum(['records', 'wechat_device', 'none']).optional(),
  ownership: z.enum(['owned_by_me', 'accessible']).nullable().optional(),
  mail_action: z.enum(['compose', 'reply']).nullable().optional(),
  turn_action: z.enum(['start', 'continue', 'modify', 'cancel', 'clarify']).optional(),
  turn_evidence: z.string().max(2000).optional(),
  slot_updates: taskSlotUpdatesSchema.optional(),
  diagnostics: z
    .strictObject({
      contract_version: z.literal('task-slots-v1'),
      duration_ms: z.number().nonnegative(),
    })
    .optional(),
});
/** Mail fixed-node payload. Tenant/scope authorization still belongs to guards. */
export const agentModelToolInputSchema = z.strictObject({
  context_plan: agentContextPlanToolSchema.optional(),
  phase: z.enum(['classify', 'answer']).optional(),
  question: z.string().min(1).max(100000),
  snapshot: agentSnapshotToolSchema,
  history,
  classification: classification.optional(),
  user_preferences: preferences.optional(),
  preference_instruction: z.string().max(10000).optional(),
  task_instructions: z.string().max(24000).optional(),
  material: z
    .strictObject({ name: z.string().max(200), content: z.string().max(40000) })
    .optional(),
  entry_context: producerJson.optional(),
});
export const agentReadEnvelopeSchema = z.strictObject({
  snapshot: agentSnapshotToolSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  history,
  question: z.string().min(1).max(100000),
  user_preferences: preferences,
  preference_instruction: z.string().max(10000),
});
export const agentTemplateReceiptToolSchema = z
  .strictObject({
    name: z.string().min(1).max(200),
    digest: z.union([z.literal('none'), z.string().regex(/^[a-f0-9]{64}$/)]),
  })
  .nullable();

const contextSchema = z.strictObject({
  workspaceId: z.uuid(),
  actorId: z.uuid(),
  customerId: z.uuid(),
  projectId: z.uuid().nullable(),
  chatId: z.uuid(),
  runId: z.uuid(),
  workflowId: z.uuid().optional(),
  workflowVersion: z.number().int().positive().optional(),
});
const limitsSchema = z.strictObject({
  maxSteps: z.number().int().min(1).max(8).default(8),
  maxDurationMs: z.number().int().min(1).max(180_000).default(120_000),
  // Preserve the existing 20-message window, without automatic summaries or
  // silently dropping a question. Individual source builders keep their limits.
  maxContextBytes: z.number().int().min(1).max(1_500_000).default(1_500_000),
  maxEstimatedInputTokens: z.number().int().min(1).max(500_000).default(240_000),
});
const stepTools: Readonly<Record<AgentHarnessStep, AgentHarnessTool>> = Object.freeze({
  read_sources: 'crm.read_sources',
  read_template: 'crm.read_template',
  analyze_mail: 'model.generate',
  compose_mail: 'model.generate',
  validate_result: 'result.validate',
  save_draft: 'crm.save_draft',
});
class HarnessError extends ApiError {
  constructor(
    status: number,
    message: string,
    readonly code: AgentHarnessErrorCode,
  ) {
    super(status, message);
  }
}
interface HarnessLimits {
  maxSteps?: number;
  maxDurationMs?: number;
  maxContextBytes?: number;
  maxEstimatedInputTokens?: number;
}
export interface AgentHarnessOptions {
  /** Must be constructed after server-side scope and ownership validation. */
  context: AgentHarnessContext;
  skillId: AgentSkillId;
  signal?: AbortSignal;
  /** Revalidate current permissions and source/config versions before and after each step. */
  guard(): Promise<void>;
  onTrace?(event: AgentHarnessTrace): Promise<void>;
  limits?: HarnessLimits;
}
interface StepInput<Input extends z.ZodType, Output extends z.ZodType> {
  step: AgentHarnessStep;
  tool: AgentHarnessTool;
  input: unknown;
  inputSchema: Input;
  outputSchema: Output;
  /** Stable server-owned logical operation, required for a write tool. */
  operationId?: string;
  execute(
    input: z.output<Input>,
    runtime: {
      context: Readonly<AgentHarnessContext>;
      signal: AbortSignal;
      skill: AgentSkill;
    },
  ): Promise<unknown>;
}
function serialized(value: unknown) {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    throw new HarnessError(400, 'Agent 步骤输入格式无效', 'invalid_input');
  }
}
function digest(value: unknown) {
  return createHash('sha256').update(serialized(value)).digest('hex');
}

/** Conservative UTF-8 byte upper bound, not a tokenizer or provider usage report. */
export function estimateAgentInputTokens(value: unknown) {
  return Buffer.byteLength(serialized(value));
}

/** A small sequential executor over fixed code-owned adapters; never a model tool loop. */
export function createAgentHarness(options: AgentHarnessOptions) {
  const parsedContext = contextSchema.safeParse(options.context);
  const parsedLimits = limitsSchema.safeParse(options.limits || {});
  if (!parsedContext.success || !parsedLimits.success || typeof options.guard !== 'function')
    throw new ApiError(400, 'Agent 运行范围或预算无效');
  const context = Object.freeze(parsedContext.data);
  const limits = Object.freeze(parsedLimits.data);
  const skill = getAgentSkill(options.skillId);
  const deadline = Date.now() + limits.maxDurationMs;
  const timeout = AbortSignal.timeout(limits.maxDurationMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const traces: AgentHarnessTrace[] = [];
  let sequence = 0;
  let running = false;

  function assertActive() {
    if (options.signal?.aborted) {
      // The parent Run can abort for a deadline, budget or scope failure. That
      // is not a user cancellation and must preserve its truthful terminal state.
      if (options.signal.reason instanceof ApiError) throw options.signal.reason;
      throw new DOMException('Agent 运行已取消', 'AbortError');
    }
    if (timeout.aborted || Date.now() >= deadline)
      throw new HarnessError(504, 'Agent 运行超过时间限制，请重试', 'deadline');
    signal.throwIfAborted();
  }
  function withSignal<T>(work: () => Promise<T>): Promise<T> {
    assertActive();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        try {
          assertActive();
        } catch (error) {
          reject(error);
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => {
          assertActive();
          return work();
        })
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort));
    });
  }
  function checkContext(value: unknown) {
    assertActive();
    const complete = { instructions: skill.instructions, context: value };
    const size = Buffer.byteLength(serialized(complete));
    if (size > limits.maxContextBytes)
      throw new HarnessError(
        413,
        '本次资料超过 Agent 上下文预算，请缩小来源范围',
        'context_budget',
      );
    if (estimateAgentInputTokens(complete) > limits.maxEstimatedInputTokens)
      throw new HarnessError(
        413,
        '本次资料超过 Agent 输入 token 估算预算，请缩小来源范围',
        'context_budget',
      );
    return size;
  }
  async function emit(event: AgentHarnessTrace) {
    // Events are assembled from fixed fields only. Never accept extra metadata or
    // copy adapter errors, model content, prompts or arguments into this channel.
    const safe = Object.freeze({ ...event, usage: Object.freeze({ available: false as const }) });
    traces.push(safe);
    if (options.onTrace) {
      try {
        await options.onTrace(safe);
      } catch {
        throw new HarnessError(503, 'Agent 运行记录暂不可用，请重试', 'trace_unavailable');
      }
    }
  }
  async function runStep<Input extends z.ZodType, Output extends z.ZodType>(
    definition: StepInput<Input, Output>,
  ): Promise<z.output<Output>> {
    assertActive();
    if (running) throw new ApiError(409, '同一次 Agent 运行只允许按顺序执行步骤');
    if (
      !z.enum(agentHarnessSteps).safeParse(definition.step).success ||
      !z.enum(agentHarnessTools).safeParse(definition.tool).success ||
      !skill.steps.includes(definition.step) ||
      stepTools[definition.step] !== definition.tool
    )
      throw new HarnessError(403, 'Agent 步骤不允许调用此工具', 'tool_not_allowed');
    if (sequence >= limits.maxSteps)
      throw new HarnessError(429, 'Agent 运行达到步骤上限，请调整任务后重试', 'step_limit');
    running = true;
    const stepSequence = ++sequence;
    const started = Date.now();
    const contract = agentToolContracts[definition.tool];
    const operationId = z.uuid().safeParse(definition.operationId);
    let executeStarted = false;
    const base = {
      run_id: context.runId,
      workspace_id: context.workspaceId,
      actor_id: context.actorId,
      customer_id: context.customerId,
      project_id: context.projectId,
      chat_id: context.chatId,
      ...(context.workflowId ? { workflow_id: context.workflowId } : {}),
      ...(context.workflowVersion ? { workflow_version: context.workflowVersion } : {}),
      skill_id: skill.id,
      skill_version: skill.version,
      policy_version: agentHarnessPolicyVersion,
      tool_contract_version: agentToolContractVersion,
      ...(operationId.success ? { operation_id: operationId.data } : {}),
      step_id: definition.step,
      tool_id: definition.tool,
      sequence: stepSequence,
      input_digest: '',
      started_at: new Date(started).toISOString(),
      usage: { available: false as const },
    };
    try {
      if (contract.idempotency === 'stable_operation_id' && !operationId.success)
        throw new HarnessError(400, 'Agent 写操作缺少稳定的操作标识', 'invalid_input');
      if (contract.kind !== 'write' && definition.operationId !== undefined)
        throw new HarnessError(400, '只读或模型步骤不能声明写操作标识', 'invalid_input');
      base.input_digest = digest(definition.input);
      checkContext(definition.input);
      const input = definition.inputSchema.safeParse(definition.input);
      if (!input.success) throw new HarnessError(400, 'Agent 步骤输入不符合要求', 'invalid_input');
      if (
        contract.kind === 'write' &&
        (!input.data ||
          typeof input.data !== 'object' ||
          !('operation_id' in input.data) ||
          input.data.operation_id !== operationId.data)
      )
        throw new HarnessError(400, 'Agent 写操作标识与输入不一致', 'invalid_input');
      await withSignal(options.guard);
      await withSignal(() => emit({ ...base, status: 'started', duration_ms: 0 }));
      const raw = await withSignal(() => {
        executeStarted = true;
        return definition.execute(input.data, { context, signal, skill });
      });
      assertActive();
      const result = definition.outputSchema.safeParse(raw);
      if (!result.success)
        throw new HarnessError(502, 'Agent 步骤结果不符合要求，本次未采用', 'invalid_output');
      checkContext(result.data);
      await withSignal(options.guard);
      await withSignal(() =>
        emit({
          ...base,
          status: 'succeeded',
          output_digest: digest(result.data),
          ...(contract.kind === 'write' ? { write_outcome: 'completed' as const } : {}),
          duration_ms: Math.max(0, Date.now() - started),
        }),
      );
      return result.data;
    } catch (error) {
      const failure =
        options.signal?.aborted && options.signal.reason instanceof ApiError
          ? options.signal.reason
          : error;
      const cancelled =
        !(failure instanceof ApiError) &&
        (options.signal?.aborted ||
          (failure instanceof DOMException && failure.name === 'AbortError'));
      // Only fixed public budget codes can cross into the safe trace. Never
      // copy arbitrary adapter codes or messages (which may contain source text).
      const budgetCode =
        failure instanceof ApiError &&
        'code' in failure &&
        (failure.code === 'model_call_limit' || failure.code === 'known_token_limit')
          ? failure.code
          : undefined;
      const code: AgentHarnessErrorCode = cancelled
        ? 'cancelled'
        : failure instanceof HarnessError
          ? failure.code
          : failure instanceof ApiError && failure.status === 504
            ? 'deadline'
            : failure instanceof ApiError && failure.status === 429
              ? budgetCode || 'run_budget'
              : failure instanceof ApiError && [403, 404].includes(failure.status)
                ? 'permission'
                : failure instanceof ApiError && failure.status === 409
                  ? 'scope_changed'
                  : 'execution';
      const terminalTrace = emit({
        ...base,
        input_digest: base.input_digest || digest(null),
        status: cancelled ? 'cancelled' : 'failed',
        duration_ms: Math.max(0, Date.now() - started),
        error_code: code,
        ...(contract.kind === 'write'
          ? { write_outcome: executeStarted ? ('unknown' as const) : ('not_started' as const) }
          : {}),
      }).catch(() => {});
      // A cancelled/expired run must stop even if trace persistence is stalled.
      // The terminal event is retained locally; persistence is best-effort after
      // expiry. Cancellation does not roll back an adapter's completed writes.
      if (!signal.aborted && Date.now() < deadline)
        await withSignal(() => terminalTrace).catch(() => {});
      if (cancelled) throw new DOMException('Agent 运行已取消', 'AbortError');
      if (failure instanceof ApiError) throw failure;
      throw new ApiError(502, 'Agent 步骤执行失败，请重试');
    } finally {
      running = false;
    }
  }
  return {
    context,
    skill,
    signal,
    checkContext,
    runStep,
    get trace(): AgentHarnessTrace[] {
      return traces.map((event) => ({ ...event, usage: { available: false } }));
    },
  };
}
