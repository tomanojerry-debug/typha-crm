import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  agentEntryContractVersion,
  agentEntryDefinitions,
  agentTaskDefinitions,
  entrySupportsTask,
  type AgentEntry,
  type AgentEntryContext,
  type AgentTask,
} from '../shared/agent-entries.js';
import type { AskScope } from '../shared/ask.js';
import { ApiError, type Context } from './security.js';

const id = z.uuid();
const version = z.number().int().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const selection = { scope_digest: digest, selected_count: z.number().int().min(0).max(50) };
const scopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('directory') }),
  z.strictObject({
    kind: z.literal('entity'),
    object: z.enum(['customers', 'people', 'projects']),
    customer_id: id,
    record_id: id,
  }),
  z.strictObject({
    kind: z.literal('records'),
    object: z.enum(['customers', 'people', 'projects']),
    ...selection,
  }),
  z.strictObject({ kind: z.literal('list'), list_id: id, ...selection }),
  z.strictObject({
    kind: z.literal('page'),
    page: z.enum(['mail', 'wechat', 'relationships', 'chat']),
  }),
  z.strictObject({
    kind: z.literal('workflow'),
    workflow_id: id,
    version,
    customer_id: id.nullable(),
    person_id: id.nullable(),
    project_id: id.nullable(),
  }),
  z.strictObject({
    kind: z.literal('field'),
    target: z.enum(['company', 'custom']),
    customer_id: id,
    project_id: id.nullable(),
    record_id: id,
    object_id: id.optional(),
    field_id: id,
    field_version: version,
  }),
  z.strictObject({
    kind: z.literal('document'),
    customer_id: id,
    project_id: id.nullable(),
    document_id: id,
    version,
    attribute_ids: z.array(id).min(1).max(10).optional(),
  }),
  z.strictObject({
    kind: z.literal('activity'),
    customer_id: id,
    project_id: id.nullable(),
    type_id: id,
    version,
    source_ids: z.array(z.string().min(1).max(300)).min(1).max(60),
  }),
]);
export type AgentEntryScope = z.infer<typeof scopeSchema>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
function hash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/** Convert an already authorized Ask scope without copying filters or customer text into telemetry. */
export function askEntryScope(scope: AskScope): AgentEntryScope {
  if (scope.kind === 'records')
    return {
      kind: 'records',
      object: scope.object,
      scope_digest: hash(scope),
      selected_count: scope.selected_ids.length,
    };
  if (scope.kind === 'list')
    return {
      kind: 'list',
      list_id: scope.list_id,
      scope_digest: hash(scope),
      selected_count: scope.selected_ids.length,
    };
  return { ...scope };
}

/**
 * Bind only after the domain service has resolved and authorized its inputs.
 * This validates the entry/task/scope contract; it never replaces RLS, current
 * permissions, source revalidation, transaction guards or user confirmation.
 */
export function bindAgentEntry(
  ctx: Pick<Context, 'workspaceId' | 'actorId'>,
  entry: AgentEntry,
  task: AgentTask,
  input: AgentEntryScope,
  options: { answerOnly?: boolean } = {},
) {
  if (!id.safeParse(ctx.workspaceId).success || !id.safeParse(ctx.actorId).success)
    throw new ApiError(400, 'AI任务身份无效');
  if (
    !Object.hasOwn(agentEntryDefinitions, entry) ||
    !Object.hasOwn(agentTaskDefinitions, task) ||
    !entrySupportsTask(entry, task)
  )
    throw new ApiError(403, '当前入口不支持此任务');
  const parsed = scopeSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, 'AI任务范围或版本无效');
  const scope = parsed.data;
  const definition = agentTaskDefinitions[task];
  if (!(definition.scopes as readonly string[]).includes(scope.kind))
    throw new ApiError(403, '当前任务不能使用此资料范围');
  if (
    (scope.kind === 'entity' &&
      scope.object === 'customers' &&
      scope.customer_id !== scope.record_id) ||
    (scope.kind === 'workflow' && !scope.customer_id && (scope.person_id || scope.project_id)) ||
    (scope.kind === 'field' &&
      (scope.target === 'company'
        ? task !== 'company_attribute' ||
          scope.record_id !== scope.customer_id ||
          !!scope.object_id ||
          !!scope.project_id
        : task !== 'custom_attribute' || !scope.object_id)) ||
    (scope.kind === 'document' &&
      (task === 'document_attributes' ? !scope.attribute_ids : !!scope.attribute_ids)) ||
    (scope.kind === 'activity' && new Set(scope.source_ids).size !== scope.source_ids.length)
  )
    throw new ApiError(400, 'AI任务参数与当前业务对象不匹配');
  const provided = Object.entries(scope)
    .filter(([key, value]) => key !== 'kind' && value !== null && value !== undefined)
    .map(([key]) => key);
  const scopeMode: AgentEntryContext['scope_mode'] =
    scope.kind === 'directory'
      ? 'authorized_directory'
      : scope.kind === 'entity'
        ? 'current_object'
        : scope.kind === 'records' || scope.kind === 'list'
          ? scope.selected_count
            ? 'selected_rows'
            : 'current_view'
          : scope.kind === 'page'
            ? 'current_page'
            : scope.kind === 'workflow'
              ? 'task_scope'
              : scope.kind === 'field'
                ? 'selected_field'
                : scope.kind === 'document'
                  ? 'current_document'
                  : 'selected_sources';
  const modelContext: AgentEntryContext = {
    version: agentEntryContractVersion,
    entry,
    task,
    scope_kind: scope.kind,
    scope_mode: scopeMode,
    provided,
    result: options.answerOnly ? 'answer' : definition.result,
    policy: options.answerOnly ? 'answer_only' : definition.policy,
  };
  return {
    workspace_id: ctx.workspaceId,
    actor_id: ctx.actorId,
    scope,
    scope_digest: hash(scope),
    modelContext,
  };
}
