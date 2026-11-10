import type { AgentRun } from '../shared/agent-runs.js';
import { activeAgentRun } from '../shared/agent-runs.js';
import type { Database } from './db.js';
import { ApiError, type Context } from './security.js';
import type { AgentHarnessTrace } from '../shared/agent-harness.js';
import { publicAgentExecution, type AgentExecutionTelemetry } from './agent-execution.js';

export type RunGuard = (ctx: Context) => Promise<void>;
export interface StoredRun extends AgentRun {
  workspace_id: string;
  actor_id: string;
  payload: Record<string, unknown>;
  fingerprint: string;
  token: string;
  attempt: number;
  metadata: Record<string, unknown>;
}
/** Best-effort safe metadata only, never a capability to mutate a different attempt. */
export async function persistRunExecution(
  db: Database,
  claim: Pick<StoredRun, 'workspace_id' | 'actor_id' | 'chat_id' | 'id' | 'token' | 'attempt'>,
  telemetry: AgentExecutionTelemetry,
) {
  const safe = publicAgentExecution(telemetry);
  if (!safe || safe.attempt !== claim.attempt) return false;
  const saved = await db.query(
    `UPDATE agent_runs SET metadata=jsonb_set(metadata,'{execution}',$8::jsonb),revision=revision+1,updated_at=now()
     WHERE workspace_id=$1 AND actor_id=$2 AND chat_id=$3 AND id=$4 AND token=$5 AND attempt=$6 AND status='running'
       AND COALESCE(metadata->'execution'->'sequence','-1'::jsonb)<=to_jsonb($7::bigint) RETURNING id`,
    [
      claim.workspace_id,
      claim.actor_id,
      claim.chat_id,
      claim.id,
      claim.token,
      claim.attempt,
      safe.sequence,
      JSON.stringify(safe),
    ],
  );
  return saved.rows.length > 0;
}
const guards = new Map<string, { token: string; check: RunGuard; invalidate(): void }>();
const legacyClaims = new WeakMap<Database, Set<string>>();
export const executionKey = (workspace: string, actor: string, chat: string) =>
  `${workspace}:${actor}:${chat}`;
export function legacyBusy(db: Database, workspace: string, actor: string, chat: string) {
  return legacyClaims.get(db)?.has(executionKey(workspace, actor, chat)) || false;
}
export async function legacyExecution<T>(
  db: Database,
  workspace: string,
  actor: string,
  chat: string,
  run: () => Promise<T>,
) {
  let claims = legacyClaims.get(db);
  if (!claims) legacyClaims.set(db, (claims = new Set()));
  const key = executionKey(workspace, actor, chat);
  if (claims.has(key)) throw new ApiError(409, '本对话正在回答，请等待当前请求完成');
  claims.add(key);
  try {
    return await run();
  } finally {
    claims.delete(key);
  }
}
export function setRunGuard(id: string, token: string, check: RunGuard, invalidate: () => void) {
  guards.set(id, { token, check, invalidate });
}
export function clearRunGuard(id: string, token: string) {
  if (guards.get(id)?.token === token) guards.delete(id);
}
export async function assertRunAvailable(ctx: Context, chat: string, token?: string) {
  const rows = (
    await ctx.tx.query<StoredRun>(
      "SELECT * FROM agent_runs WHERE workspace_id=$1 AND actor_id=$2 AND chat_id=$3 AND status IN ('queued','running','cancelling')",
      [ctx.workspaceId, ctx.actorId, chat],
    )
  ).rows;
  if (rows.some((row) => row.token !== token || row.status !== 'running'))
    throw new ApiError(409, '本对话正在回答，请等待当前请求完成');
}
export async function storedRun(ctx: Context, chat: string, id?: string) {
  return (
    await ctx.tx.query<StoredRun>(
      `SELECT * FROM agent_runs WHERE workspace_id=$1 AND actor_id=$2 AND chat_id=$3
       AND ($4::uuid IS NULL OR id=$4) ORDER BY created_at DESC,id DESC LIMIT 1`,
      [ctx.workspaceId, ctx.actorId, chat, id || null],
    )
  ).rows[0];
}
export async function publicRun(ctx: Context, row: StoredRun): Promise<AgentRun> {
  const { id, chat_id, request_id, kind, question, revision, error, created_at, updated_at } = row;
  let answer = '',
    status = row.status;
  const committed =
    activeAgentRun(row) &&
    (
      await ctx.tx.query(
        "SELECT id FROM chat_messages WHERE workspace_id=$1 AND chat_id=$2 AND request_id=$3 AND role='assistant'",
        [ctx.workspaceId, row.chat_id, row.request_id],
      )
    ).rows.length > 0;
  if (committed) status = 'completed';
  if (!committed && activeAgentRun(row) && row.answer) {
    const guard = guards.get(row.id);
    if (guard?.token === row.token) {
      try {
        await guard.check(ctx);
        answer = row.answer;
      } catch (error) {
        if (!(error instanceof ApiError) || ![403, 404, 409].includes(error.status)) throw error;
        guard.invalidate();
        status = 'failed';
      }
    }
  }
  const trace = Array.isArray(row.metadata.harness_trace)
    ? (row.metadata.harness_trace as AgentHarnessTrace[])
    : [];
  const customerIds = [...new Set(trace.map((event) => event.customer_id).filter(Boolean))];
  const allowedCustomers = customerIds.length
    ? new Set(
        (
          await ctx.tx.query<{ id: string }>(
            'SELECT id FROM customers WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND archived_at IS NULL',
            [ctx.workspaceId, customerIds],
          )
        ).rows.map((r) => r.id),
      )
    : new Set<string>();
  const visibleTrace = trace.filter(
    (event) =>
      event.run_id === row.id &&
      event.workspace_id === ctx.workspaceId &&
      event.actor_id === ctx.actorId &&
      event.chat_id === row.chat_id &&
      (!event.customer_id || allowedCustomers.has(event.customer_id)),
  );
  const execution = publicAgentExecution(row.metadata.execution);
  return {
    id,
    chat_id,
    request_id,
    kind,
    status,
    question,
    answer,
    revision,
    error:
      status === 'failed' && row.status !== 'failed'
        ? '生成期间资料或权限范围已变化，请重新提问'
        : error,
    created_at,
    updated_at,
    ...(visibleTrace.length ? { harness_trace: visibleTrace } : {}),
    ...(execution?.attempt === row.attempt ? { execution } : {}),
  };
}
