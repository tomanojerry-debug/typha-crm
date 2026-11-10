import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { z, ZodError } from 'zod';
import type { AgentRunResult } from '../shared/agent-runs.js';
import { activeAgentRun } from '../shared/agent-runs.js';
import type { ChatDetail } from '../shared/chat.js';
import type { Database } from './db.js';
import type { AgentModelOptions, AgentStream } from './agent-model.js';
import { ApiError, scoped, type Context } from './security.js';
import { uuid } from './validation.js';
import * as chats from './chats.js';
import * as ask from './ask.js';
import * as workflows from './home-workflows.js';
import { ensureAskSession } from './ask-sessions.js';
import { agentExecutionLimits, createAgentExecution } from './agent-execution.js';
import type { WeChatOptions } from './wechat.js';
import {
  clearRunGuard,
  legacyBusy,
  publicRun,
  persistRunExecution,
  setRunGuard,
  storedRun,
  type RunGuard,
  type StoredRun,
} from './agent-run-store.js';

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
const failure = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : error instanceof ZodError
      ? '输入格式不正确'
      : '服务暂时不可用，请稍后重试';
const askRunInput = ask.questionRequest.extend({ chat_id: uuid, request_id: uuid });
const chatRunInput = z.strictObject({
  kind: z.enum(['message', 'workflow']),
  payload: z.unknown(),
});

export function createAgentRuns(
  db: Database,
  options: { agent: AgentModelOptions; wechat?: WeChatOptions },
) {
  const executionLimits = agentExecutionLimits(options.agent.executionLimits);
  const tasks = new Map<
    string,
    { controller: AbortController; token: string; promise: Promise<void> }
  >();
  const pending = new Set<Promise<void>>();
  let stopping = false;
  async function read(ctx: Context, chatId: string, runId: string): Promise<AgentRunResult> {
    const detail: ChatDetail = await chats.detail(ctx, chatId);
    const row = await storedRun(ctx, chatId, runId);
    if (!row) throw new ApiError(404, '运行记录不存在或无权访问');
    const run = await publicRun(ctx, row);
    detail.run = run;
    detail.chat.run_status = run.status;
    // Only the external directory selection request is cached. All CRM data,
    // previews and finalized messages above are read under current permissions.
    if (row.metadata.wechat_request && run.status === 'completed')
      detail.wechat_request = row.metadata.wechat_request as ChatDetail['wechat_request'];
    return { run, detail };
  }
  const get = (actor: string, workspace: string, chat: string, id: string) =>
    scoped(db, actor, workspace, (ctx) => read(ctx, chat, id));

  async function finish(
    row: StoredRun,
    status: StoredRun['status'],
    error: string | null,
    metadata = {},
  ) {
    // Status-only internal cleanup is intentionally bound to this private claim.
    // It must still work when a revoked membership can no longer enter scoped().
    await db.query(
      `UPDATE agent_runs r SET status=CASE WHEN EXISTS (
          SELECT 1 FROM chat_messages m WHERE m.workspace_id=r.workspace_id AND m.chat_id=r.chat_id AND m.request_id=r.request_id AND m.role='assistant'
        ) THEN 'completed' ELSE $6 END, answer='', error=CASE WHEN EXISTS (
          SELECT 1 FROM chat_messages m WHERE m.workspace_id=r.workspace_id AND m.chat_id=r.chat_id AND m.request_id=r.request_id AND m.role='assistant'
        ) THEN NULL ELSE $7 END, metadata=metadata||$8::jsonb,revision=revision+1,updated_at=now()
       WHERE workspace_id=$1 AND actor_id=$2 AND chat_id=$3 AND id=$4 AND token=$5 AND status IN ('running','cancelling')`,
      [
        row.workspace_id,
        row.actor_id,
        row.chat_id,
        row.id,
        row.token,
        status,
        error,
        JSON.stringify(metadata),
      ],
    );
  }
  async function execute(id: string) {
    if (stopping || tasks.has(id)) return;
    const claimed = (
      await db.query<StoredRun>(
        "UPDATE agent_runs SET status='running',revision=revision+1,updated_at=now() WHERE id=$1 AND status='queued' RETURNING *",
        [id],
      )
    ).rows[0];
    if (!claimed) return;
    if (stopping) {
      await finish(claimed, 'interrupted', '服务已重启，本次回答已中断，请重试');
      return;
    }
    const controller = new AbortController();
    const execution = createAgentExecution({
      signal: controller.signal,
      limits: executionLimits,
      attempt: claimed.attempt,
      onUpdate: (telemetry) => persistRunExecution(db, claimed, telemetry).then(() => undefined),
    });
    const agentOptions = { ...options.agent, execution };
    let guard: RunGuard | undefined;
    const promise = (async () => {
      try {
        await execution.run(() =>
          scoped(db, claimed.actor_id, claimed.workspace_id, (ctx) =>
            chats.detail(ctx, claimed.chat_id),
          ),
        );
        const stream: AgentStream = {
          signal: execution.signal,
          runId: claimed.id,
          runToken: claimed.token,
          async onHarnessTrace(event) {
            if (
              event.run_id !== claimed.id ||
              event.workspace_id !== claimed.workspace_id ||
              event.actor_id !== claimed.actor_id ||
              event.chat_id !== claimed.chat_id
            )
              throw new ApiError(500, '运行轨迹范围不一致');
            await scoped(db, claimed.actor_id, claimed.workspace_id, async (ctx) => {
              await chats.detail(ctx, claimed.chat_id);
              if (event.customer_id) {
                const accessible = await ctx.tx.query(
                  'SELECT id FROM customers WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL',
                  [ctx.workspaceId, event.customer_id],
                );
                if (!accessible.rows.length) throw new ApiError(404, '客户不存在或无权访问');
              }
              const saved = await ctx.tx.query(
                `UPDATE agent_runs SET metadata=jsonb_set(metadata,'{harness_trace}',
                  COALESCE(metadata->'harness_trace','[]'::jsonb)||$6::jsonb),revision=revision+1,updated_at=now()
                 WHERE workspace_id=$1 AND actor_id=$2 AND chat_id=$3 AND id=$4 AND token=$5
                 AND status IN ('running','cancelling')
                 AND jsonb_array_length(COALESCE(metadata->'harness_trace','[]'::jsonb))<128 RETURNING id`,
                [
                  ctx.workspaceId,
                  ctx.actorId,
                  claimed.chat_id,
                  claimed.id,
                  claimed.token,
                  JSON.stringify([event]),
                ],
              );
              if (!saved.rows.length) throw new ApiError(409, '运行已结束或步骤轨迹超出限制');
            });
          },
          registerGuard(check) {
            guard = check;
            setRunGuard(id, claimed.token, check, () =>
              controller.abort(new ApiError(409, '生成期间资料或权限范围已变化，请重新提问')),
            );
          },
          async onText(text) {
            execution.assertActive();
            if (!guard) throw new ApiError(500, '回答缺少当前权限校验');
            await scoped(db, claimed.actor_id, claimed.workspace_id, async (ctx) => {
              await guard!(ctx);
              execution.assertActive();
              const saved = await ctx.tx.query(
                `UPDATE agent_runs SET answer=$6,revision=revision+1,updated_at=now()
                 WHERE workspace_id=$1 AND actor_id=$2 AND chat_id=$3 AND id=$4 AND token=$5 AND status='running' RETURNING id`,
                [
                  claimed.workspace_id,
                  claimed.actor_id,
                  claimed.chat_id,
                  id,
                  claimed.token,
                  text.slice(0, 100000),
                ],
              );
              if (!saved.rows.length) throw new DOMException('Cancelled', 'AbortError');
            });
          },
        };
        const result = await execution.run(async () => {
          if (claimed.kind === 'ask')
            return ask.modelQuery(
              db,
              claimed.actor_id,
              claimed.workspace_id,
              claimed.payload,
              agentOptions,
              stream,
            );
          else if (claimed.kind === 'workflow')
            return workflows.run(
              db,
              claimed.actor_id,
              claimed.workspace_id,
              claimed.chat_id,
              claimed.payload,
              agentOptions,
              stream,
            );
          else
            return chats.sendWithModel(
              db,
              claimed.actor_id,
              claimed.workspace_id,
              claimed.chat_id,
              claimed.payload,
              agentOptions,
              options.wechat,
              stream,
            );
        });
        execution.dispose();
        const metadata =
          result && typeof result === 'object' && 'wechat_request' in result
            ? { wechat_request: result.wechat_request }
            : {};
        await finish(claimed, 'completed', null, { ...metadata, execution: execution.snapshot() });
      } catch (error) {
        const reason = execution.signal.reason;
        const cancelled = execution.signal.aborted && !(reason instanceof ApiError);
        execution.dispose();
        await finish(
          claimed,
          stopping ? 'interrupted' : cancelled ? 'cancelled' : 'failed',
          stopping
            ? '服务已重启，本次回答已中断，请重试'
            : cancelled
              ? null
              : failure(reason instanceof ApiError ? reason : error),
          { execution: execution.snapshot() },
        ).catch(() => undefined);
      } finally {
        execution.dispose();
        clearRunGuard(id, claimed.token);
        tasks.delete(id);
      }
    })();
    tasks.set(id, { controller, token: claimed.token, promise });
    await promise;
  }
  function schedule(id: string) {
    setImmediate(() => {
      if (!stopping) {
        const active = tasks.get(id);
        if (active) {
          void active.promise.finally(() => schedule(id));
          return;
        }
        const job = execute(id).catch(() => undefined);
        pending.add(job);
        void job.finally(() => pending.delete(job));
      }
    });
  }
  async function accept(
    actor: string,
    workspace: string,
    chatId: string,
    kind: StoredRun['kind'],
    raw: unknown,
  ) {
    if (stopping) throw new ApiError(503, '服务正在重启，请稍后重试');
    if (legacyBusy(db, workspace, actor, chatId))
      throw new ApiError(409, '本对话正在回答，请等待当前请求完成');
    const payload =
      kind === 'message'
        ? chats.messageInput.parse(raw)
        : kind === 'workflow'
          ? workflows.runInput.parse(raw)
          : askRunInput.parse(raw);
    if (
      'material' in payload &&
      payload.material &&
      Buffer.byteLength(payload.material.content) > 40000
    )
      throw new ApiError(400, '资料最多 40 KB');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(canonical([chatId, kind, payload])))
      .digest('hex');
    const accepted = await scoped(db, actor, workspace, async (ctx) => {
      const previous = (
        await ctx.tx.query<StoredRun>(
          'SELECT * FROM agent_runs WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3',
          [workspace, actor, payload.request_id],
        )
      ).rows[0];
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new ApiError(409, '此请求编号已用于其他范围或内容');
        return read(ctx, chatId, previous.id);
      }
      // Ask creates only a validated empty session, never a half-saved answer.
      if (kind === 'ask') await ensureAskSession(ctx, askRunInput.parse(payload));
      const detail = await chats.detail(ctx, chatId); // locks the chat across acceptance
      // Another accepting transaction may have committed while this one waited
      // for the chat lock (PostgreSQL, rather than PGlite's serialized queue).
      const raced = (
        await ctx.tx.query<StoredRun>(
          'SELECT * FROM agent_runs WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3',
          [workspace, actor, payload.request_id],
        )
      ).rows[0];
      if (raced) {
        if (raced.fingerprint !== fingerprint)
          throw new ApiError(409, '此请求编号已用于其他范围或内容');
        return read(ctx, chatId, raced.id);
      }
      if (legacyBusy(db, workspace, actor, chatId))
        throw new ApiError(409, '本对话正在回答，请等待当前请求完成');
      if (detail.run && activeAgentRun(detail.run))
        throw new ApiError(409, '本对话正在回答，请等待当前请求完成');
      if (
        (
          await ctx.tx.query(
            'SELECT id FROM chat_messages WHERE workspace_id=$1 AND chat_id=$2 AND request_id=$3',
            [workspace, chatId, payload.request_id],
          )
        ).rows.length
      )
        throw new ApiError(409, '此请求编号已用于已有消息，请重新发起');
      let question: string;
      if (kind === 'workflow')
        question = (await workflows.prepareRun(ctx, chatId, payload)).question;
      else if (kind === 'ask') question = askRunInput.parse(payload).question;
      else {
        const value = chats.messageInput.parse(payload);
        if (
          detail.chat.origin &&
          (value.material || value.candidate_selection || value.action !== 'message')
        )
          throw new ApiError(400, '此对话来自页面问答，请在原页面范围内继续提问');
        question =
          value.body ||
          {
            message: '请分析这份资料',
            overview: '请概括当前客户档案和已知背景',
            activity: '请分析近期沟通进展、待确认事项和依据',
            web_research: '研究公司的公开信息',
          }[value.action];
      }
      const id = randomUUID();
      await ctx.tx.query(
        `INSERT INTO agent_runs(workspace_id,actor_id,chat_id,id,request_id,kind,status,question,payload,fingerprint,token)
         VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10)`,
        [
          workspace,
          actor,
          chatId,
          id,
          payload.request_id,
          kind,
          question,
          JSON.stringify(payload),
          fingerprint,
          randomUUID(),
        ],
      );
      await ctx.tx.query(
        'UPDATE agent_chats SET updated_at=now() WHERE workspace_id=$1 AND id=$2',
        [workspace, chatId],
      );
      return read(ctx, chatId, id);
    }).catch(async (error: unknown) => {
      const conflict =
        (error instanceof ApiError && error.status === 409) ||
        (error && typeof error === 'object' && 'code' in error && error.code === '23505');
      if (conflict) {
        const replay = await scoped(db, actor, workspace, async (ctx) => {
          const row = (
            await ctx.tx.query<StoredRun>(
              'SELECT * FROM agent_runs WHERE workspace_id=$1 AND actor_id=$2 AND request_id=$3',
              [workspace, actor, payload.request_id],
            )
          ).rows[0];
          if (row?.fingerprint === fingerprint) return read(ctx, chatId, row.id);
        });
        if (replay) return replay;
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
        throw new ApiError(409, '本对话正在回答或此请求编号已被使用，请刷新后重试');
      throw error;
    });
    if (accepted.run.status === 'queued') schedule(accepted.run.id);
    return accepted;
  }
  async function cancel(actor: string, workspace: string, chat: string, id: string) {
    const result = await scoped(db, actor, workspace, async (ctx) => {
      await read(ctx, chat, id);
      await ctx.tx.query(
        `UPDATE agent_runs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END,
           answer='',revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND actor_id=$2 AND chat_id=$3 AND id=$4 AND status IN ('queued','running')`,
        [workspace, actor, chat, id],
      );
      return read(ctx, chat, id);
    });
    if (result.run.status === 'cancelling') tasks.get(id)?.controller.abort();
    return result;
  }
  async function retry(actor: string, workspace: string, chat: string, id: string) {
    if (stopping) throw new ApiError(503, '服务正在重启，请稍后重试');
    if (legacyBusy(db, workspace, actor, chat))
      throw new ApiError(409, '本对话正在回答，请等待当前请求完成');
    const result = await scoped(db, actor, workspace, async (ctx) => {
      const existing = await read(ctx, chat, id),
        row = (await storedRun(ctx, chat, id))!;
      const latest = await storedRun(ctx, chat);
      if (latest && latest.id !== id)
        throw new ApiError(409, '此请求之后已有新的对话内容，请按当前会话重新提问');
      if (activeAgentRun(existing.run) || row.status === 'completed') return existing;
      const saved = (
        await ctx.tx.query(
          "SELECT id FROM chat_messages WHERE workspace_id=$1 AND chat_id=$2 AND request_id=$3 AND role='assistant'",
          [workspace, chat, row.request_id],
        )
      ).rows.length;
      if (saved)
        await ctx.tx.query(
          "UPDATE agent_runs SET status='completed',answer='',error=NULL,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
          [workspace, id],
        );
      else {
        if (row.kind === 'ask') await ensureAskSession(ctx, askRunInput.parse(row.payload));
        if (row.kind === 'workflow') await workflows.prepareRun(ctx, chat, row.payload);
        await ctx.tx.query(
          "UPDATE agent_runs SET status='queued',answer='',error=NULL,metadata='{}',attempt=attempt+1,token=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
          [workspace, id, randomUUID()],
        );
      }
      return read(ctx, chat, id);
    });
    if (result.run.status === 'queued') schedule(id);
    return result;
  }
  async function events(
    req: Request,
    res: Response,
    actor: string,
    workspace: string,
    chat: string,
    id: string,
  ) {
    let current = await get(actor, workspace, chat, id),
      closed = false;
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const onClose = () => {
      closed = true;
    };
    res.on('close', onClose);
    let revision = -1;
    let heartbeatAt = Date.now();
    try {
      while (!closed) {
        if (current.run.revision !== revision) {
          res.write(`data: ${JSON.stringify({ type: 'run', run: current.run })}\n\n`);
          revision = current.run.revision;
        }
        if (!activeAgentRun(current.run)) {
          res.write(`data: ${JSON.stringify({ type: 'done', result: current })}\n\n`);
          break;
        }
        if (Date.now() - heartbeatAt > 15000) {
          res.write(': keepalive\n\n');
          heartbeatAt = Date.now();
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 200);
          timer.unref();
        });
        if (!closed) current = await get(actor, workspace, chat, id);
      }
    } catch (error) {
      if (!closed)
        res.write(
          `data: ${JSON.stringify({ type: 'error', status: error instanceof ApiError ? error.status : 500, error: failure(error) })}\n\n`,
        );
    } finally {
      res.off('close', onClose);
      res.end();
    }
  }
  async function interruptUnfinished() {
    // A committed assistant always wins over a cancellation or shutdown race.
    await db.exec(`UPDATE agent_runs r SET status=CASE WHEN EXISTS (
      SELECT 1 FROM chat_messages m WHERE m.workspace_id=r.workspace_id AND m.chat_id=r.chat_id AND m.request_id=r.request_id AND m.role='assistant'
    ) THEN 'completed' ELSE 'interrupted' END,answer='',revision=revision+1,updated_at=now(),
      error=CASE WHEN EXISTS (SELECT 1 FROM chat_messages m WHERE m.workspace_id=r.workspace_id AND m.chat_id=r.chat_id AND m.request_id=r.request_id AND m.role='assistant')
        THEN NULL ELSE '服务已重启，本次回答已中断，请重试' END WHERE status IN ('running','cancelling');
      DELETE FROM ask_session_claims c WHERE EXISTS (SELECT 1 FROM agent_runs r WHERE r.workspace_id=c.workspace_id AND r.actor_id=c.actor_id AND r.chat_id=c.chat_id AND r.request_id=c.request_id AND r.status='interrupted');`);
  }
  async function recover() {
    await interruptUnfinished();
    for (const row of (
      await db.query<{ id: string }>("SELECT id FROM agent_runs WHERE status='queued'")
    ).rows)
      schedule(row.id);
  }
  async function stop() {
    stopping = true;
    for (const task of tasks.values()) task.controller.abort();
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        timer.unref();
      }),
    ]);
    await interruptUnfinished();
  }
  return {
    get,
    cancel,
    retry,
    events,
    recover,
    stop,
    enqueueChat(actor: string, workspace: string, chat: string, input: unknown) {
      const value = chatRunInput.parse(input);
      return accept(actor, workspace, chat, value.kind, value.payload);
    },
    enqueueAsk(actor: string, workspace: string, input: unknown) {
      const value = askRunInput.parse(input);
      return accept(actor, workspace, value.chat_id, 'ask', value);
    },
  };
}
