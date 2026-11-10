import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  agentTaskSlotNames,
  agentTaskStateVersion,
  type AgentTaskDependency,
  type AgentTaskSlot,
  type AgentTaskState,
  type AgentTaskStateInvalidReason,
} from '../shared/agent-task-state.js';
import {
  agentEntryDefinitions,
  agentTaskDefinitions,
  entrySupportsTask,
  type AgentEntry,
  type AgentTask,
} from '../shared/agent-entries.js';
import type { HomeWorkflow } from '../shared/home-workflows.js';
import { ApiError, type Context } from './security.js';
import { taskSlotsSchema } from './task-understanding.js';

const id = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().positive();
const nullableId = id.nullable();
const scalar = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);
const applicability = z.strictObject({ scope_digest: digest, generation: nullableId });
const slotSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user_message'), request_id: id, evidence_digest: digest }),
  z.strictObject({ kind: z.literal('workflow_config'), workflow_id: id, version }),
  z.strictObject({ kind: z.literal('entry_input'), version }),
]);
export const agentTaskSlotSchema = z
  .strictObject({
    name: z.enum(agentTaskSlotNames),
    status: z.enum(['provided', 'cleared', 'missing']),
    value: z.union([scalar, z.array(scalar).max(60)]),
    source: slotSource.nullable(),
    version,
    applicability,
  })
  .superRefine((slot, ctx) => {
    if (slot.status !== 'provided' && slot.value !== null)
      ctx.addIssue({ code: 'custom', message: '未提供或已清除条件的值必须为null' });
    if ((slot.status === 'missing') !== (slot.source === null))
      ctx.addIssue({ code: 'custom', message: '本人条件必须有来源，未提供条件不能伪造来源' });
    if (slot.status !== 'provided') return;
    if (slot.name === 'language' && !['zh', 'en', 'other'].includes(String(slot.value)))
      ctx.addIssue({ code: 'custom', message: '语言条件无效' });
    if (
      ['style', 'writing_requirements', 'query'].includes(slot.name) &&
      typeof slot.value !== 'string'
    )
      ctx.addIssue({ code: 'custom', message: '文字条件必须为字符串' });
    if (slot.name === 'history_enabled' && typeof slot.value !== 'boolean')
      ctx.addIssue({ code: 'custom', message: '历史来源开关必须为布尔值' });
    if (slot.name === 'template_choice' && slot.value !== 'none' && slot.value !== 'selected')
      ctx.addIssue({ code: 'custom', message: '模板条件仅表示已选或明确不用' });
    if (
      slot.name === 'source_kinds' &&
      (!Array.isArray(slot.value) ||
        !slot.value.every((v) => ['mail', 'wechat', 'pasted'].includes(String(v))))
    )
      ctx.addIssue({ code: 'custom', message: '来源类型条件无效' });
    if (
      slot.name === 'field_ids' &&
      (!Array.isArray(slot.value) ||
        !slot.value.every((v) => typeof v === 'string' && v.length > 0))
    )
      ctx.addIssue({ code: 'custom', message: '字段条件无效' });
    if (
      ['date_start', 'date_end'].includes(slot.name) &&
      slot.value !== null &&
      !z.iso.date().safeParse(slot.value).success
    )
      ctx.addIssue({ code: 'custom', message: '日期条件无效' });
  });
export const agentTaskDependencySchema = z
  .strictObject({
    kind: z.enum(['scope', 'record', 'mail', 'document', 'note', 'template', 'field']),
    id: z.string().min(1).max(200),
    revision: z.union([z.string().min(1).max(200), z.number().int().nonnegative()]).nullable(),
    hash: digest.nullable(),
    status: z.enum(['current', 'invalid', 'unknown']),
  })
  .superRefine((value, ctx) => {
    if (value.status === 'current' && value.revision === null && value.hash === null)
      ctx.addIssue({ code: 'custom', message: '当前依赖必须有版本或摘要依据' });
  });
const stateSchema = z.strictObject({
  version: z.literal(agentTaskStateVersion),
  entry: z.enum(Object.keys(agentEntryDefinitions) as [AgentEntry, ...AgentEntry[]]),
  task: z.enum(Object.keys(agentTaskDefinitions) as [AgentTask, ...AgentTask[]]),
  identity: z.strictObject({
    workspace_id: id,
    actor_id: id,
    chat_id: nullableId,
    run_id: nullableId,
    workflow_id: nullableId,
  }),
  scope: z.strictObject({
    kind: z.enum([
      'directory',
      'entity',
      'records',
      'list',
      'page',
      'workflow',
      'field',
      'document',
      'activity',
    ]),
    digest,
    customer_id: nullableId,
    person_id: nullableId,
    project_id: nullableId,
    generation: nullableId,
  }),
  phase: z.enum([
    'configure',
    'template',
    'ready',
    'decision',
    'review',
    'completed',
    'cancelled',
    'queued',
    'running',
    'failed',
    'interrupted',
  ]),
  revision: version,
  slots: z.array(agentTaskSlotSchema).max(20),
  dependencies: z.array(agentTaskDependencySchema).max(200),
  result: z
    .strictObject({
      message_id: nullableId,
      draft_id: nullableId,
      scope_digest: digest,
      source_digest: digest.nullable(),
      dependency_digest: digest,
      generation: nullableId,
    })
    .nullable(),
  cancellation: z.strictObject({
    status: z.enum(['active', 'requested', 'cancelled']),
    request_id: nullableId,
  }),
});
export const agentTaskStateSchema = stateSchema.superRefine((state, ctx) => {
  if (
    !entrySupportsTask(state.entry, state.task) ||
    !(agentTaskDefinitions[state.task].scopes as readonly string[]).includes(state.scope.kind)
  )
    ctx.addIssue({ code: 'custom', message: '任务不属于当前入口或资料范围' });
  if ((state.scope.person_id || state.scope.project_id) && !state.scope.customer_id)
    ctx.addIssue({ code: 'custom', message: '联系人和项目必须有客户归属' });
  if (
    ['entity', 'field', 'document', 'activity'].includes(state.scope.kind) &&
    !state.scope.customer_id
  )
    ctx.addIssue({ code: 'custom', message: '当前业务范围必须绑定客户' });
  if (
    ['directory', 'records', 'list', 'page'].includes(state.scope.kind) &&
    (state.scope.customer_id || state.scope.person_id || state.scope.project_id)
  )
    ctx.addIssue({ code: 'custom', message: '目录或集合范围不能伪造单一客户绑定' });
  if (
    state.scope.kind === 'workflow' &&
    (!state.identity.workflow_id || !state.identity.chat_id || !state.scope.generation)
  )
    ctx.addIssue({ code: 'custom', message: '对话任务必须绑定现有Workflow、会话和配置代次' });
  if (state.identity.workflow_id && !state.identity.chat_id)
    ctx.addIssue({ code: 'custom', message: 'Workflow不能脱离所属会话' });
  if (
    ['attribute', 'document', 'activity'].includes(state.entry) &&
    (state.identity.chat_id || state.identity.workflow_id)
  )
    ctx.addIssue({ code: 'custom', message: '按钮入口不制造会话或Workflow身份' });
  if (
    state.scope.kind !== 'workflow' &&
    state.identity.workflow_id &&
    state.entry !== 'home_workflow'
  )
    ctx.addIssue({ code: 'custom', message: '当前入口不能借用其他任务Workflow' });
  if (new Set(state.slots.map((slot) => slot.name)).size !== state.slots.length)
    ctx.addIssue({ code: 'custom', message: '条件不能重复' });
  if (
    new Set(state.dependencies.map((dep) => `${dep.kind}:${dep.id}`)).size !==
    state.dependencies.length
  )
    ctx.addIssue({ code: 'custom', message: '依赖不能重复' });
  if (
    (state.cancellation.status !== 'active' || state.phase === 'cancelled') &&
    state.result !== null
  )
    ctx.addIssue({ code: 'custom', message: '取消任务不能保留可用结果' });
  if (state.phase === 'cancelled' && state.cancellation.status === 'active')
    ctx.addIssue({ code: 'custom', message: '任务阶段与取消状态不一致' });
  if ((state.cancellation.status !== 'active' || state.phase === 'cancelled') && state.slots.length)
    ctx.addIssue({ code: 'custom', message: '取消后的说明不能继续携带旧任务条件' });
  if (
    (state.cancellation.status !== 'active' || state.phase === 'cancelled') &&
    state.dependencies.length
  )
    ctx.addIssue({ code: 'custom', message: '取消后的说明不能继续携带旧任务来源依赖' });
  for (const slot of state.slots) {
    if (
      slot.source?.kind === 'workflow_config' &&
      (slot.source.workflow_id !== state.identity.workflow_id ||
        slot.source.version > state.revision)
    )
      ctx.addIssue({ code: 'custom', message: '条件来源与任务身份或版本不符' });
    const allowed: Partial<Record<AgentTask, readonly string[]>> = {
      home_chat: ['query'],
      page_question: ['query'],
      document_question: ['query'],
      company_attribute: ['field_value'],
      custom_attribute: ['field_value'],
      document_attributes: ['field_ids', 'field_value'],
      summary: ['source_kinds', 'date_start', 'date_end', 'history_enabled'],
      update: ['source_kinds', 'date_start', 'date_end', 'field_ids'],
      reply: [
        'language',
        'style',
        'writing_requirements',
        'template_choice',
        'source_kinds',
        'date_start',
        'date_end',
        'history_enabled',
      ],
      compose: [
        'language',
        'style',
        'writing_requirements',
        'template_choice',
        'source_kinds',
        'date_start',
        'date_end',
        'history_enabled',
      ],
      generate_activities: ['source_kinds', 'date_start', 'date_end'],
    };
    if (!allowed[state.task]?.includes(slot.name))
      ctx.addIssue({ code: 'custom', message: '当前任务不支持此条件' });
  }
});

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function agentTaskStateDigest(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function agentTaskDependencyDigest(dependencies: AgentTaskDependency[]) {
  return agentTaskStateDigest(
    dependencies
      .map((dep) => agentTaskDependencySchema.parse(dep))
      .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
  );
}
type StateInput = Omit<
  AgentTaskState,
  'version' | 'identity' | 'scope' | 'slots' | 'dependencies' | 'result' | 'cancellation'
> & {
  identity?: Partial<Omit<AgentTaskState['identity'], 'workspace_id' | 'actor_id'>>;
  scope: Pick<AgentTaskState['scope'], 'kind' | 'digest'> &
    Partial<Omit<AgentTaskState['scope'], 'kind' | 'digest'>>;
  slots?: AgentTaskSlot[];
  dependencies?: AgentTaskDependency[];
  result?: AgentTaskState['result'];
  cancellation?: AgentTaskState['cancellation'];
};
/** This helper accepts server-owned values only; schema validity is never authorization. */
export function buildAgentTaskState(
  ctx: Pick<Context, 'workspaceId' | 'actorId'>,
  input: StateInput,
): AgentTaskState {
  const state = {
    version: agentTaskStateVersion,
    ...input,
    identity: {
      ...input.identity,
      chat_id: input.identity?.chat_id ?? null,
      run_id: input.identity?.run_id ?? null,
      workflow_id: input.identity?.workflow_id ?? null,
      workspace_id: ctx.workspaceId,
      actor_id: ctx.actorId,
    },
    scope: {
      ...input.scope,
      customer_id: input.scope.customer_id ?? null,
      person_id: input.scope.person_id ?? null,
      project_id: input.scope.project_id ?? null,
      generation: input.scope.generation ?? null,
    },
    slots: input.slots || [],
    dependencies: input.dependencies || [],
    result: input.result ?? null,
    cancellation: input.cancellation || { status: 'active', request_id: null },
  };
  return agentTaskStateSchema.parse(state);
}

type WorkflowStateRow = Pick<
  HomeWorkflow,
  'id' | 'chat_id' | 'kind' | 'step' | 'version' | 'config' | 'result' | 'draft_id'
> & {
  actor_id?: string;
  workspace_id?: string;
  config_generation: string;
  result_digest: string | null;
};
/** No instruction, material, result body, source body, or original quote is copied. */
export function workflowAgentTaskState(
  ctx: Pick<Context, 'workspaceId' | 'actorId'>,
  row: WorkflowStateRow,
  options: { scopeDigest: string; runId?: string; dependencies?: AgentTaskDependency[] },
) {
  if (
    (row.actor_id && row.actor_id !== ctx.actorId) ||
    (row.workspace_id && row.workspace_id !== ctx.workspaceId)
  )
    throw new ApiError(403, '任务身份与当前用户不符');
  const applies = { scope_digest: options.scopeDigest, generation: row.config_generation };
  const slots: AgentTaskSlot[] = taskSlotsSchema.parse(row.config.task_slots || []).map((slot) => ({
    name: slot.slot,
    status: slot.op === 'clear' ? 'cleared' : 'provided',
    value: slot.value,
    source: {
      kind: 'user_message',
      request_id: slot.request_id,
      evidence_digest: agentTaskStateDigest(slot.evidence),
    },
    version: row.version,
    applicability: applies,
  }));
  const choice = row.config.template_choice;
  if (choice && !slots.some((slot) => slot.name === 'template_choice'))
    slots.push({
      name: 'template_choice',
      status: 'provided',
      value: choice.kind === 'none' ? 'none' : 'selected',
      source: { kind: 'workflow_config', workflow_id: row.id, version: row.version },
      version: row.version,
      applicability: applies,
    });
  const dependencies = options.dependencies || [];
  const cancelled = row.step === 'cancelled';
  return buildAgentTaskState(ctx, {
    entry: 'home_workflow',
    task: row.kind,
    identity: { chat_id: row.chat_id, workflow_id: row.id, run_id: options.runId || null },
    scope: {
      kind: 'workflow',
      digest: options.scopeDigest,
      customer_id: row.config.customer_id,
      person_id: row.config.person_id,
      project_id: row.config.project_id,
      generation: row.config_generation,
    },
    phase: row.step,
    revision: row.version,
    slots: cancelled ? [] : slots,
    dependencies: cancelled ? [] : dependencies,
    result:
      !cancelled && row.result && row.result_digest
        ? {
            message_id: row.result.message_id,
            draft_id: row.draft_id,
            scope_digest: options.scopeDigest,
            source_digest: row.result_digest,
            dependency_digest: agentTaskDependencyDigest(dependencies),
            generation: row.config_generation,
          }
        : null,
    cancellation: { status: cancelled ? 'cancelled' : 'active', request_id: null },
  });
}

/** Compare against freshly authorized current inputs. This never performs a permission lookup. */
export function checkAgentTaskState(
  value: unknown,
  current: {
    workspaceId: string;
    actorId: string;
    scopeDigest: string;
    generation?: string | null;
    entry?: AgentEntry;
    task?: AgentTask;
    chatId?: string | null;
    runId?: string | null;
    workflowId?: string | null;
    revision?: number;
    dependencies?: AgentTaskDependency[];
    sourceDigest?: string | null;
    cancelled?: boolean;
  },
): { valid: boolean; reasons: AgentTaskStateInvalidReason[] } {
  const state = agentTaskStateSchema.parse(value);
  const reasons = new Set<AgentTaskStateInvalidReason>();
  if (
    state.identity.workspace_id !== current.workspaceId ||
    state.identity.actor_id !== current.actorId
  )
    reasons.add('identity_changed');
  if (
    (current.entry !== undefined && state.entry !== current.entry) ||
    (current.task !== undefined && state.task !== current.task) ||
    (current.chatId !== undefined && state.identity.chat_id !== current.chatId) ||
    (current.runId !== undefined && state.identity.run_id !== current.runId) ||
    (current.workflowId !== undefined && state.identity.workflow_id !== current.workflowId)
  )
    reasons.add('identity_changed');
  if (state.scope.digest !== current.scopeDigest) reasons.add('scope_changed');
  if (current.generation !== undefined && state.scope.generation !== current.generation)
    reasons.add('generation_changed');
  if (current.revision !== undefined && state.revision !== current.revision)
    reasons.add('generation_changed');
  if (current.cancelled || state.cancellation.status !== 'active' || state.phase === 'cancelled')
    reasons.add('cancelled');
  if (
    state.slots.some(
      (slot) =>
        slot.applicability.scope_digest !== state.scope.digest ||
        slot.applicability.generation !== state.scope.generation,
    )
  )
    reasons.add('slot_scope_changed');
  if (state.dependencies.some((dep) => dep.status !== 'current'))
    reasons.add('dependency_unverified');
  if (state.dependencies.length && current.dependencies === undefined)
    reasons.add('dependency_unverified');
  if (
    current.dependencies !== undefined &&
    agentTaskDependencyDigest(state.dependencies) !==
      agentTaskDependencyDigest(current.dependencies)
  )
    reasons.add('dependency_changed');
  if (current.dependencies?.some((dep) => dep.status !== 'current'))
    reasons.add('dependency_unverified');
  if (
    state.result &&
    (state.result.scope_digest !== state.scope.digest ||
      state.result.generation !== state.scope.generation ||
      state.result.dependency_digest !== agentTaskDependencyDigest(state.dependencies))
  )
    reasons.add('result_stale');
  if (state.result?.source_digest && current.sourceDigest === undefined)
    reasons.add('dependency_unverified');
  if (
    state.result?.source_digest &&
    current.sourceDigest !== undefined &&
    state.result.source_digest !== current.sourceDigest
  )
    reasons.add('result_stale');
  return { valid: reasons.size === 0, reasons: [...reasons] };
}
