import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  agentContextPlanVersion,
  type AgentContextDependency,
  type AgentContextPlan,
  type AgentContextPlanSummary,
  type AgentContextSourceKind,
  type AgentHistorySelection,
} from '../shared/agent-context-plan.js';
import type { AgentTaskState } from '../shared/agent-task-state.js';
import type { AgentModelInput } from './agent-model.js';
import type { bindAgentEntry } from './agent-entries.js';
import {
  agentTaskStateDigest,
  agentTaskStateSchema,
  buildAgentTaskState,
  checkAgentTaskState,
} from './agent-task-state.js';
import { ApiError, type Context } from './security.js';

type Binding = ReturnType<typeof bindAgentEntry>;
type Identity = Pick<Context, 'workspaceId' | 'actorId'>;
interface PlanOptions {
  state?: AgentTaskState;
  chatId?: string;
  runId?: string;
  history?: AgentHistorySelection;
  dependencies?: AgentContextDependency[];
  maxInputBytes?: number;
}
const issued = new WeakMap<
  AgentContextPlan,
  { binding: Binding; options: PlanOptions; input: AgentModelInput }
>();
const hashPattern = z.string().regex(/^[a-f0-9]{64}$/);
const dependency = z.strictObject({
  kind: z.enum(['evidence', 'scope', 'workflow_generation', 'template', 'state']),
  digest: hashPattern,
});
const planSchema = z.strictObject({
  version: z.literal(agentContextPlanVersion),
  entry: z.string().min(1).max(50),
  task: z.string().min(1).max(50),
  identity: z.strictObject({
    workspace_id: z.uuid(),
    actor_id: z.uuid(),
    chat_id: z.uuid().optional(),
    run_id: z.uuid().optional(),
  }),
  scope: z.strictObject({ kind: z.string().min(1).max(40), digest: hashPattern }),
  state: agentTaskStateSchema,
  state_digest: hashPattern,
  dependencies: z.array(dependency).min(2).max(10),
  sources: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(300),
        kind: z.enum([
          'business_record',
          'basic_directory',
          'user_input',
          'material',
          'template',
          'current_fields',
          'task_context',
        ]),
        digest: hashPattern,
      }),
    )
    .max(250),
  selections: z.strictObject({
    sources: z.literal('authorized_domain_selection'),
    history: z.enum([
      'classification_user_turns',
      'authorized_recent_turns',
      'same_workflow_evidence',
      'scope_reset',
      'none',
    ]),
    history_count: z.number().int().min(0).max(20),
    history_limit: z.literal(20),
    history_truncation: z.literal('upstream_authorized_window'),
    preferences: z.enum(['explicit_actor_preferences', 'not_used_for_classification']),
    preference_count: z.number().int().min(0).max(8),
    material: z.enum(['current_user_material', 'none']),
  }),
  input_digest: hashPattern,
  budget: z.strictObject({
    measurement: z.literal('serialized_dynamic_context_utf8'),
    input_bytes: z.number().int().nonnegative(),
    limit_bytes: z.number().int().positive().max(1_500_000),
    overflow_policy: z.literal('reject_without_silent_truncation'),
  }),
});
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function contextPlanDigest(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)) ?? 'null')
    .digest('hex');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}
function payload(input: AgentModelInput) {
  const { context_plan: _plan, ...value } = input;
  return value;
}
function sourceKind(
  source: AgentModelInput['snapshot']['sources'][number],
): AgentContextSourceKind {
  if (source.id.startsWith('mail-template:')) return 'template';
  if (source.id.startsWith('user:')) return 'user_input';
  if (source.id.startsWith('material:')) return 'material';
  if (source.id.startsWith('document:')) return 'business_record';
  if (source.ref?.kind === 'entity') return 'basic_directory';
  if (source.ref) return 'business_record';
  if (/^(field|fields|attribute|attributes):/.test(source.id)) return 'current_fields';
  return 'task_context';
}
/** Deliberately excludes identity IDs, private dependency hashes and slot provenance/text. */
export function contextPlanModelView(plan: AgentContextPlan) {
  return {
    version: plan.version,
    entry: plan.entry,
    task: plan.task,
    scope_kind: plan.scope.kind,
    state: {
      version: plan.state.version,
      phase: plan.state.phase,
      cancellation: plan.state.cancellation.status,
      slots: plan.state.slots.map(({ name, status, value }) => ({ name, status, value })),
    },
    selections: plan.selections,
    source_kinds: [...new Set(plan.sources.map((source) => source.kind))],
    budget: plan.budget,
    instruction:
      '此计划说明服务端实际装配范围；目录、模板、用户说明和任务状态不等于客户业务证据或发送许可。',
  };
}
function measuredBytes(input: AgentModelInput, plan: AgentContextPlan) {
  return Buffer.byteLength(
    JSON.stringify({ ...payload(input), context_plan: contextPlanModelView(plan) }),
    'utf8',
  );
}
/** Build only after the domain adapter has selected and authorized all actual input. */
export function planAgentContext<T extends AgentModelInput>(
  ctx: Identity,
  binding: Binding,
  input: T,
  options: PlanOptions = {},
): T & { context_plan: AgentContextPlan } {
  // Match JSON wire semantics (including SQL Date values) before hashing/freezing.
  input = JSON.parse(JSON.stringify(payload(input))) as T;
  if (binding.workspace_id !== ctx.workspaceId || binding.actor_id !== ctx.actorId)
    throw new ApiError(403, '上下文计划身份与当前用户不符');
  if (contextPlanDigest(input.entry_context) !== contextPlanDigest(binding.modelContext))
    throw new ApiError(409, '上下文计划入口或任务已变化');
  const scope = binding.scope;
  const state =
    options.state ||
    buildAgentTaskState(ctx, {
      entry: binding.modelContext.entry,
      task: binding.modelContext.task,
      identity: { chat_id: options.chatId, run_id: options.runId },
      scope: {
        kind: scope.kind,
        digest: binding.scope_digest,
        customer_id: 'customer_id' in scope ? scope.customer_id : null,
        person_id: scope.kind === 'entity' && scope.object === 'people' ? scope.record_id : null,
        project_id:
          scope.kind === 'entity' && scope.object === 'projects'
            ? scope.record_id
            : 'project_id' in scope
              ? scope.project_id
              : null,
      },
      phase: 'running',
      revision: 'version' in scope ? scope.version : 1,
    });
  agentTaskStateSchema.parse(state);
  const expectedCustomer = 'customer_id' in scope ? scope.customer_id : null;
  const expectedPerson =
    scope.kind === 'entity' && scope.object === 'people'
      ? scope.record_id
      : scope.kind === 'workflow'
        ? scope.person_id
        : null;
  const expectedProject =
    scope.kind === 'entity' && scope.object === 'projects'
      ? scope.record_id
      : 'project_id' in scope
        ? scope.project_id
        : null;
  if (
    state.scope.kind !== scope.kind ||
    state.scope.customer_id !== expectedCustomer ||
    state.scope.person_id !== expectedPerson ||
    state.scope.project_id !== expectedProject ||
    (scope.kind === 'workflow' &&
      (state.identity.workflow_id !== scope.workflow_id || state.revision !== scope.version)) ||
    (scope.kind !== 'workflow' && state.identity.workflow_id !== null)
  )
    throw new ApiError(409, '任务状态与入口对象或版本不符');
  if (
    state.identity.workspace_id !== ctx.workspaceId ||
    state.identity.actor_id !== ctx.actorId ||
    state.scope.digest !== binding.scope_digest ||
    state.entry !== binding.modelContext.entry ||
    state.task !== binding.modelContext.task
  )
    throw new ApiError(409, '任务状态与上下文范围不符');
  if (
    (options.chatId && state.identity.chat_id !== options.chatId) ||
    (options.runId && state.identity.run_id !== options.runId)
  )
    throw new ApiError(409, '任务状态与当前会话或运行不符');
  if (state.cancellation.status === 'active') {
    const validity = checkAgentTaskState(state, {
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      scopeDigest: binding.scope_digest,
      generation: state.scope.generation,
      dependencies: state.dependencies,
      sourceDigest: options.dependencies?.find((item) => item.kind === 'evidence')?.digest,
    });
    if (!validity.valid) throw new ApiError(409, '任务状态的条件或来源已失效');
  } else if (state.slots.length || state.dependencies.length || state.result) {
    throw new ApiError(409, '取消后的任务不能携带旧条件或来源');
  }
  if (input.history.length > 20) throw new ApiError(400, '上下文历史超过既有20条窗口，请重新准备');
  if (
    new Set(input.snapshot.sources.map((source) => source.id)).size !==
    input.snapshot.sources.length
  )
    throw new ApiError(400, '上下文来源标识重复，请重新准备');
  if (
    state.scope.customer_id &&
    input.snapshot.sources.some(
      (source) => source.ref && source.ref.customer_id !== state.scope.customer_id,
    )
  )
    throw new ApiError(403, '上下文来源不属于当前客户范围');
  if (
    state.scope.project_id &&
    input.snapshot.sources.some(
      (source) => source.ref?.project_id && source.ref.project_id !== state.scope.project_id,
    )
  )
    throw new ApiError(403, '上下文来源不属于当前项目范围');
  if (
    input.phase === 'classify' &&
    (input.snapshot.sources.length || input.material || input.user_preferences?.length)
  )
    throw new ApiError(400, '分类上下文不能提前读取业务原文、材料或偏好');
  if (
    state.cancellation.status !== 'active' &&
    (input.snapshot.sources.some((source) => !source.id.startsWith('user:')) ||
      input.material ||
      input.history.length ||
      state.result)
  )
    throw new ApiError(409, '取消后的说明不能继续使用旧任务资料');
  const dependencies: AgentContextDependency[] = [
    { kind: 'scope', digest: binding.scope_digest },
    { kind: 'state', digest: agentTaskStateDigest(state) },
    ...(options.dependencies || []),
  ];
  if (new Set(dependencies.map((item) => item.kind)).size !== dependencies.length)
    throw new ApiError(400, '上下文依赖类型重复');
  const plan: AgentContextPlan = {
    version: agentContextPlanVersion,
    entry: binding.modelContext.entry,
    task: binding.modelContext.task,
    identity: {
      workspace_id: ctx.workspaceId,
      actor_id: ctx.actorId,
      ...(options.chatId ? { chat_id: options.chatId } : {}),
      ...(options.runId ? { run_id: options.runId } : {}),
    },
    scope: { kind: scope.kind, digest: binding.scope_digest },
    state: structuredClone(state),
    state_digest: agentTaskStateDigest(state),
    dependencies,
    sources: input.snapshot.sources.map((source) => ({
      id: source.id,
      kind: sourceKind(source),
      digest: contextPlanDigest(source),
    })),
    selections: {
      sources: 'authorized_domain_selection',
      history:
        options.history ||
        (input.phase === 'classify'
          ? 'classification_user_turns'
          : input.history.length
            ? 'authorized_recent_turns'
            : 'none'),
      history_count: input.history.length,
      history_limit: 20,
      history_truncation: 'upstream_authorized_window',
      preferences:
        input.phase === 'classify' ? 'not_used_for_classification' : 'explicit_actor_preferences',
      preference_count: input.user_preferences?.length || 0,
      material: input.material ? 'current_user_material' : 'none',
    },
    input_digest: contextPlanDigest(payload(input)),
    budget: {
      measurement: 'serialized_dynamic_context_utf8',
      input_bytes: 0,
      limit_bytes: options.maxInputBytes ?? 1_500_000,
      overflow_policy: 'reject_without_silent_truncation',
    },
  };
  // The displayed byte count is itself part of the dynamic context. Find its fixed point.
  for (let i = 0; i < 6; i++) {
    const bytes = measuredBytes(input, plan);
    if (bytes === plan.budget.input_bytes) break;
    plan.budget.input_bytes = bytes;
  }
  planSchema.parse(plan);
  if (plan.budget.input_bytes > plan.budget.limit_bytes)
    throw new ApiError(413, '本次上下文超过容量限制，请缩小资料范围后重试');
  freeze(plan);
  issued.set(plan, {
    binding: structuredClone(binding),
    options: { ...options, state: plan.state },
    input: freeze(structuredClone(payload(input))),
  });
  // Snapshot once. A transport cannot change a nested source, history or material
  // after the boundary check, and freezing never mutates the domain's original rows.
  return freeze({ ...structuredClone(payload(input)), context_plan: plan }) as T & {
    context_plan: AgentContextPlan;
  };
}
/** Rebuild for an existing code-owned correction, never an automatic retry or new authorization. */
export function refreshAgentContext<T extends AgentModelInput>(
  input: T,
  purpose: 'mail_variable_correction' | 'legacy_classification_restore',
) {
  const old = input.context_plan && issued.get(input.context_plan);
  if (!old) throw new ApiError(409, '上下文计划不是本次服务端生成');
  const legacy = purpose === 'legacy_classification_restore';
  if (
    legacy
      ? old.binding.modelContext.entry !== 'home' || old.input.phase !== 'classify'
      : old.binding.modelContext.entry !== 'home_workflow' ||
        !['compose', 'reply'].includes(old.binding.modelContext.task) ||
        old.input.phase !== 'answer'
  )
    throw new ApiError(409, '上下文计划不支持此纠正用途');
  const protectedInput = (value: AgentModelInput) => ({
    ...payload(value),
    snapshot: { ...value.snapshot, warnings: [] },
    ...(legacy ? { question: '', history: [] } : {}),
  });
  if (
    contextPlanDigest(protectedInput(input)) !== contextPlanDigest(protectedInput(old.input)) ||
    (!legacy &&
      old.input.snapshot.warnings.some(
        (warning, index) => input.snapshot.warnings[index] !== warning,
      )) ||
    (legacy && input.snapshot.sources.length)
  )
    throw new ApiError(409, '纠正不能更改原范围、来源或本人条件');
  return planAgentContext(
    { workspaceId: old.binding.workspace_id, actorId: old.binding.actor_id },
    old.binding,
    input,
    old.options,
  );
}
export function assertAgentContextInput(input: AgentModelInput, ctx?: Identity) {
  const plan = input.context_plan;
  if (!plan || !issued.has(plan)) throw new ApiError(409, '缺少本次服务端上下文计划');
  if (
    ctx &&
    (plan.identity.workspace_id !== ctx.workspaceId || plan.identity.actor_id !== ctx.actorId)
  )
    throw new ApiError(403, '上下文计划属于其他用户或工作空间');
  if (
    contextPlanDigest(payload(input)) !== plan.input_digest ||
    measuredBytes(input, plan) !== plan.budget.input_bytes ||
    agentTaskStateDigest(plan.state) !== plan.state_digest
  )
    throw new ApiError(409, '上下文内容已变化，请重新装配');
  if (plan.budget.input_bytes > plan.budget.limit_bytes)
    throw new ApiError(413, '本次上下文超过容量限制');
  return plan;
}
/** Must follow the domain's current RLS/source/template re-read; hashes alone grant no access. */
export function assertAgentContextCurrent(
  plan: AgentContextPlan,
  ctx: Identity,
  current: {
    scopeDigest: string;
    evidenceDigest?: string;
    generation?: string;
    state?: AgentTaskState;
    templateDigest?: string;
  },
) {
  if (
    !issued.has(plan) ||
    plan.identity.workspace_id !== ctx.workspaceId ||
    plan.identity.actor_id !== ctx.actorId ||
    plan.scope.digest !== current.scopeDigest
  )
    throw new ApiError(409, '上下文身份或范围已变化');
  for (const item of plan.dependencies) {
    if (item.kind === 'evidence' && item.digest !== current.evidenceDigest)
      throw new ApiError(409, '上下文来源已变化');
    if (
      item.kind === 'workflow_generation' &&
      item.digest !== contextPlanDigest(current.generation ?? null)
    )
      throw new ApiError(409, '任务配置代次已变化');
    if (item.kind === 'template' && item.digest !== current.templateDigest)
      throw new ApiError(409, '当前邮件模板未复验或已变化');
  }
  if (
    !current.state &&
    (plan.state.slots.length || plan.state.dependencies.length || plan.state.result)
  )
    throw new ApiError(409, '缺少当前任务状态复验');
  if (current.state && agentTaskStateDigest(current.state) !== plan.state_digest)
    throw new ApiError(409, '当前任务状态已变化');
}
export function contextPlanSummary(input: AgentModelInput): AgentContextPlanSummary {
  const plan = assertAgentContextInput(input);
  return {
    version: plan.version,
    entry: plan.entry,
    task: plan.task,
    phase: input.phase || 'answer',
    scope_kind: plan.scope.kind,
    scope_digest: plan.scope.digest,
    state_version: plan.state.version,
    state_digest: plan.state_digest,
    input_digest: plan.input_digest,
    dependency_digest: contextPlanDigest(plan.dependencies),
    source_count: plan.sources.length,
    history_count: plan.selections.history_count,
    preference_count: plan.selections.preference_count,
    input_bytes: plan.budget.input_bytes,
    limit_bytes: plan.budget.limit_bytes,
  };
}
/** Preserve producer ownership through tool validation; JSON from HTTP/model cannot mint a plan. */
export const agentContextPlanToolSchema = z.custom<AgentContextPlan>(
  (value) => !!value && typeof value === 'object' && issued.has(value as AgentContextPlan),
);

export const agentContextPlanSummarySchema = z.strictObject({
  version: z.literal(agentContextPlanVersion),
  entry: agentTaskStateSchema.shape.entry,
  task: agentTaskStateSchema.shape.task,
  phase: z.enum(['classify', 'answer']),
  scope_kind: agentTaskStateSchema.shape.scope.shape.kind,
  scope_digest: hashPattern,
  state_version: agentTaskStateSchema.shape.version,
  state_digest: hashPattern,
  input_digest: hashPattern,
  dependency_digest: hashPattern,
  source_count: z.number().int().min(0).max(250),
  history_count: z.number().int().min(0).max(20),
  preference_count: z.number().int().min(0).max(8),
  input_bytes: z.number().int().min(0).max(1_500_000),
  limit_bytes: z.number().int().min(1).max(1_500_000),
});
