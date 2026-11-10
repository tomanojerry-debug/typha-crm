import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomUUID } from 'node:crypto';
import {
  createAgentExecution,
  AgentExecutionError,
  publicAgentExecution,
} from '../server/agent-execution.js';
import {
  callAgent,
  prepareAgent,
  type AgentModelInput,
  type AgentModelOptions,
} from '../server/agent-model.js';
import { persistRunExecution, type StoredRun } from '../server/agent-run-store.js';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import type { AgentRunResult } from '../shared/agent-runs.js';

// Deterministic provider/transport fixtures only. No model, external network,
// production database, mailbox, Graphiti, or desktop integration is exercised.
const input: AgentModelInput = {
  phase: 'classify',
  question: '普通问题',
  history: [],
  snapshot: { label: '测试', sources: [], warnings: [] },
};
const classification = { intent: '一般对话', target: null, missing: [], reply: '按当前问题回答。' };
const answer = { answer: '完成当前合成问题。', source_ids: [] };
const provider = (value: unknown, usage?: unknown) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: JSON.stringify(value), reasoning_content: 'NEVER_PERSIST_REASONING' },
        },
      ],
      ...(usage === undefined ? {} : { usage }),
    }),
    { headers: { 'content-type': 'application/json' } },
  );
const origin = 'http://localhost:3100',
  password = 'execution-fixture-password';
let db: Database, workspace: string, actor: string;
const apps: ReturnType<typeof createApp>[] = [];
const contexts: ReturnType<typeof createAgentExecution>[] = [];
const context = (options: Parameters<typeof createAgentExecution>[0] = {}) => {
  const value = createAgentExecution(options);
  contexts.push(value);
  return value;
};
const h = () => ({ origin, 'x-workspace-id': workspace });
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Execution budget fictional workspace',
    email: 'execution@fixture.invalid',
    displayName: '测试老板',
    password,
  });
  workspace = seed.workspaceId;
  actor = seed.actorId;
}, 30000);
afterEach(async () => {
  for (const value of contexts.splice(0)) value.dispose();
  for (const app of apps.splice(0)) await app.locals.agentRuns.stop();
});
afterAll(() => db.close());
async function client(options: AgentModelOptions) {
  const app = createApp(db, { origin, agent: options });
  apps.push(app);
  const agent = request.agent(app);
  await agent
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'execution@fixture.invalid', password })
    .expect(200);
  return { app, agent };
}
async function start(agent: Agent) {
  const chat = (
    await agent
      .post('/api/chats')
      .set(h())
      .send({ id: randomUUID(), title: '执行预算测试', customer_id: null })
      .expect(201)
  ).body.id as string;
  const result = (
    await agent
      .post(`/api/chats/${chat}/runs`)
      .set(h())
      .send({ kind: 'message', payload: { request_id: randomUUID(), body: '普通问题' } })
      .expect(202)
  ).body as AgentRunResult;
  return { chat, id: result.run.id };
}
async function terminal(agent: Agent, chat: string, id: string) {
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const result = (await agent.get(`/api/chats/${chat}/runs/${id}`).set(h()).expect(200))
      .body as AgentRunResult;
    if (!['queued', 'running', 'cancelling'].includes(result.run.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Execution fixture did not reach a terminal state');
}

it('shares a model-call budget across classification, answer and a would-be correction', async () => {
  const execution = context({ limits: { maxModelCalls: 2 } });
  const generate = vi.fn(async () => 'raw result');
  await execution.runModel('classify', generate);
  await execution.runModel('answer', generate);
  await expect(execution.runModel('answer', generate)).rejects.toMatchObject({
    code: 'model_call_limit',
    status: 429,
  });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(execution.snapshot()).toMatchObject({
    model_calls: { started: 2, returned: 2, active: 0 },
    phases: { classify: { calls: 1 }, answer: { calls: 1 } },
    provider_usage: {
      input_tokens: null,
      output_tokens: null,
      unknown_calls: 2,
      cost_amount: null,
    },
  });
});

it('bounds noncooperative work and ignores usage from a late cancelled adapter', async () => {
  const abort = new AbortController(),
    snapshots: unknown[] = [];
  const execution = context({
    signal: abort.signal,
    onUpdate: (value) => {
      snapshots.push(value);
    },
  });
  let lateUsage: ((usage: { input_tokens: number; output_tokens: number }) => void) | undefined;
  let release!: () => void;
  const pending = execution.runModel('classify', (runtime) => {
    lateUsage = runtime.onUsage;
    return new Promise<string>((resolve) => {
      release = () => resolve('too late');
    });
  });
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  execution.dispose();
  const previous = snapshots.length;
  lateUsage?.({ input_tokens: 100, output_tokens: 100 });
  release();
  await new Promise((resolve) => setImmediate(resolve));
  expect(snapshots).toHaveLength(previous);
  expect(execution.snapshot()).toMatchObject({
    model_calls: { cancelled: 1, returned: 0, active: 0 },
    provider_usage: { input_tokens: null, output_tokens: null },
  });
});

it('collects supplied provider tokens without persisting prompts, reasoning or a made-up fee', async () => {
  const execution = context();
  const transport = await prepareAgent({ workspaceId: workspace } as never, null, {
    apiKey: 'SYNTHETIC_SECRET_KEY',
    execution,
    fetch: vi.fn(async () =>
      provider(answer, { prompt_tokens: 17, completion_tokens: 5, total_tokens: 99999 }),
    ) as typeof fetch,
  });
  await transport.generate({ ...input, phase: 'answer', question: 'PRIVATE_QUESTION_DO_NOT_LOG' });
  const telemetry = execution.snapshot();
  expect(telemetry.provider_usage).toEqual({
    complete: true,
    reported_calls: 1,
    partial_calls: 0,
    unknown_calls: 0,
    input_tokens: 17,
    output_tokens: 5,
    reported_input_tokens: 17,
    reported_output_tokens: 5,
    cost_amount: null,
  });
  expect(JSON.stringify(telemetry)).not.toMatch(
    /PRIVATE_QUESTION|SECRET_KEY|REASONING|source_ids|99999/,
  );
});

it('leaves missing usage unknown and never infers a token component from total_tokens', async () => {
  const execution = context({ limits: { maxKnownTokens: 1 } });
  const transport = await prepareAgent({ workspaceId: workspace } as never, null, {
    apiKey: 'synthetic',
    execution,
    fetch: vi.fn(async () => provider(classification)) as typeof fetch,
  });
  await transport.generate(input);
  expect(execution.snapshot().provider_usage).toMatchObject({
    complete: false,
    input_tokens: null,
    output_tokens: null,
    unknown_calls: 1,
    cost_amount: null,
  });
  const partial = context();
  const partialTransport = await prepareAgent({ workspaceId: workspace } as never, null, {
    apiKey: 'synthetic',
    execution: partial,
    fetch: vi.fn(async () =>
      provider(classification, { prompt_tokens: 7, total_tokens: 200 }),
    ) as typeof fetch,
  });
  await partialTransport.generate(input);
  expect(partial.snapshot().provider_usage).toMatchObject({
    complete: false,
    input_tokens: 7,
    output_tokens: null,
    partial_calls: 1,
    reported_calls: 0,
  });
});

it('supports a conservative gate over known provider tokens and does not start another model', async () => {
  const execution = context({ limits: { maxKnownTokens: 5 } });
  const transport = await prepareAgent({ workspaceId: workspace } as never, null, {
    apiKey: 'synthetic',
    execution,
    fetch: vi.fn(async () =>
      provider(classification, { prompt_tokens: 4, completion_tokens: 2 }),
    ) as typeof fetch,
  });
  await expect(transport.generate(input)).rejects.toMatchObject({ code: 'known_token_limit' });
  await expect(transport.generate({ ...input, phase: 'answer' })).rejects.toMatchObject({
    code: 'known_token_limit',
  });
  expect(execution.snapshot()).toMatchObject({
    model_calls: { started: 1, failed: 1, active: 0 },
    provider_usage: { input_tokens: 4, output_tokens: 2 },
    error_code: 'known_token_limit',
  });
});

it('telemetry failures cannot replace the primary provider error', async () => {
  const execution = context({
    onUpdate: async () => {
      throw new Error('OBSERVER_FAILURE');
    },
  });
  const primary = new Error('PRIMARY_PROVIDER_FAILURE');
  await expect(
    execution.runModel('answer', async (runtime) => {
      runtime.onUsage?.({ input_tokens: 1, output_tokens: 2 });
      throw primary;
    }),
  ).rejects.toBe(primary);
  await new Promise((resolve) => setImmediate(resolve));
  expect(execution.snapshot().telemetry_failures).toBeGreaterThan(0);
  await expect(
    callAgent(
      input,
      'synthetic',
      'cn',
      vi.fn(async () =>
        provider('invalid final object', { prompt_tokens: 1, completion_tokens: 2 }),
      ) as typeof fetch,
      undefined,
      {
        onUsage() {
          throw new Error('OBSERVER_FAILURE');
        },
      },
    ),
  ).resolves.toBe('invalid final object');
});

it('aborts a nonstream response reader as well as forwarding its signal to fetch', async () => {
  const abort = new AbortController();
  let readCancelled = false,
    suppliedSignal: AbortSignal | null = null;
  const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
    suppliedSignal = options?.signal as AbortSignal;
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          readCancelled = true;
        },
      }),
    );
  }) as typeof fetch;
  const pending = callAgent(input, 'synthetic', 'cn', fetcher, undefined, { signal: abort.signal });
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect((suppliedSignal as AbortSignal | null)?.aborted).toBe(true);
  expect(readCancelled).toBe(true);
});

it('records the final streaming usage once without treating every cumulative frame as another call', async () => {
  const execution = context();
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(answer) }, finish_reason: null }], usage: { prompt_tokens: 8, completion_tokens: 1 } })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`;
  const transport = await prepareAgent({ workspaceId: workspace } as never, null, {
    apiKey: 'synthetic',
    execution,
    fetch: vi.fn(
      async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    ) as typeof fetch,
  });
  const output = await transport.stream!(
    { ...input, phase: 'answer' },
    { signal: new AbortController().signal, onText: async () => {} },
  );
  expect(output).toEqual(answer);
  expect(execution.snapshot()).toMatchObject({
    model_calls: { started: 1, returned: 1 },
    provider_usage: { reported_calls: 1, input_tokens: 8, output_tokens: 3 },
  });
});

it('persistent Home counts its classification before the answer and stores actual usage under the attempt', async () => {
  let calls = 0;
  const { agent } = await client({
    apiKey: 'synthetic',
    fetch: vi.fn(async () =>
      ++calls === 1
        ? provider(classification, { prompt_tokens: 11, completion_tokens: 3 })
        : provider(answer, { prompt_tokens: 17, completion_tokens: 5 }),
    ) as typeof fetch,
  });
  const run = await start(agent),
    done = await terminal(agent, run.chat, run.id);
  expect(done.run.status).toBe('completed');
  expect(done.run.execution).toMatchObject({
    attempt: 1,
    model_calls: { started: 2, returned: 2, active: 0 },
    phases: { classify: { calls: 1 }, answer: { calls: 1 } },
    provider_usage: { complete: true, input_tokens: 28, output_tokens: 8, cost_amount: null },
  });
  expect(done.detail.messages).toHaveLength(2);
  expect(JSON.stringify(done.run.execution)).not.toMatch(/reasoning|SYNTHETIC|source_ids/);
});

it('a persistent call limit includes classification and prevents an unstarted answer from saving', async () => {
  const generate = vi.fn(async (value: AgentModelInput) =>
    value.phase === 'classify' ? classification : answer,
  );
  const { agent } = await client({
    transport: { generate },
    executionLimits: { maxModelCalls: 1 },
  });
  const run = await start(agent),
    done = await terminal(agent, run.chat, run.id);
  expect(done.run.status).toBe('failed');
  expect(done.run.error).toContain('调用上限');
  expect(done.run.execution).toMatchObject({
    error_code: 'model_call_limit',
    model_calls: { started: 1 },
    provider_usage: { input_tokens: null, output_tokens: null },
  });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(done.detail.messages).toEqual([]);
});

it('an explicit persistent cancellation physically reaches native classification fetch', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let nativeSignal: AbortSignal | undefined;
  const { agent } = await client({
    apiKey: 'synthetic',
    fetch: vi.fn(async (_url: unknown, options?: RequestInit) => {
      nativeSignal = options!.signal as AbortSignal;
      entered();
      return new Promise<Response>((_resolve, reject) =>
        nativeSignal!.addEventListener('abort', () => reject(nativeSignal!.reason), { once: true }),
      );
    }) as typeof fetch,
  });
  const run = await start(agent);
  await started;
  await agent.post(`/api/chats/${run.chat}/runs/${run.id}/cancel`).set(h()).send({}).expect(200);
  const done = await terminal(agent, run.chat, run.id);
  expect(nativeSignal?.aborted).toBe(true);
  expect(done.run.status).toBe('cancelled');
  expect(done.run.execution).toMatchObject({
    error_code: 'cancelled',
    model_calls: { started: 1, cancelled: 1, active: 0 },
  });
  expect(done.detail.messages).toEqual([]);
});

it('a persistent deadline fails instead of masquerading as a user cancellation and never saves late text', async () => {
  let nativeSignal: AbortSignal | undefined, release!: () => void;
  const { agent } = await client({
    apiKey: 'synthetic',
    executionLimits: { maxDurationMs: 100 },
    fetch: vi.fn(async (_url: unknown, options?: RequestInit) => {
      nativeSignal = options!.signal as AbortSignal;
      return new Promise<Response>((resolve) => {
        release = () => resolve(provider(classification));
      });
    }) as typeof fetch,
  });
  const run = await start(agent),
    done = await terminal(agent, run.chat, run.id);
  expect(nativeSignal?.aborted).toBe(true);
  expect(done.run).toMatchObject({ status: 'failed', answer: '' });
  expect(done.run.error).toContain('时间限制');
  expect(done.run.execution).toMatchObject({
    error_code: 'deadline',
    model_calls: { started: 1, failed: 1, active: 0 },
  });
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((await agent.get(`/api/chats/${run.chat}`).set(h()).expect(200)).body.messages).toEqual(
    [],
  );
});

it('late telemetry cannot overwrite another retry token, cancelled state or foreign actor', async () => {
  const { agent } = await client({
    transport: { generate: async () => classification },
    executionLimits: { maxModelCalls: 1 },
  });
  const run = await start(agent);
  await terminal(agent, run.chat, run.id);
  const old = (await db.query<StoredRun>('SELECT * FROM agent_runs WHERE id=$1', [run.id])).rows[0];
  const nextToken = randomUUID();
  await db.query(
    "UPDATE agent_runs SET token=$2,attempt=attempt+1,status='running',metadata='{}'::jsonb WHERE id=$1",
    [run.id, nextToken],
  );
  const next = context({ attempt: old.attempt + 1 });
  expect(await persistRunExecution(db, old, context().snapshot())).toBe(false);
  const claim = { ...old, token: nextToken, attempt: old.attempt + 1 };
  expect(await persistRunExecution(db, { ...claim, actor_id: randomUUID() }, next.snapshot())).toBe(
    false,
  );
  expect(await persistRunExecution(db, claim, next.snapshot())).toBe(true);
  await db.query("UPDATE agent_runs SET status='cancelling' WHERE id=$1", [run.id]);
  await next.runModel('answer', async () => answer);
  expect(await persistRunExecution(db, claim, next.snapshot())).toBe(false);
  const metadata = (
    await db.query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM agent_runs WHERE id=$1',
      [run.id],
    )
  ).rows[0].metadata;
  expect(metadata.execution).toMatchObject({ attempt: 2, model_calls: { started: 0 } });
});

it('rejects HTTP budget overrides and never publishes arbitrary stored telemetry fields', async () => {
  const { agent } = await client({
    transport: {
      generate: async (value) => (value.phase === 'classify' ? classification : answer),
    },
  });
  const chat = (
    await agent
      .post('/api/chats')
      .set(h())
      .send({ id: randomUUID(), title: '拒绝客户端预算', customer_id: null })
      .expect(201)
  ).body.id;
  await agent
    .post(`/api/chats/${chat}/runs`)
    .set(h())
    .send({
      kind: 'message',
      payload: {
        request_id: randomUUID(),
        body: '普通问题',
        executionLimits: { maxModelCalls: 999 },
      },
    })
    .expect(400);
  const telemetry = context().snapshot();
  expect(publicAgentExecution({ ...telemetry, prompt: 'SHOULD_NOT_PUBLISH' })).toBeUndefined();
  expect(publicAgentExecution(telemetry)).toEqual(telemetry);
  expect(new AgentExecutionError('deadline')).toMatchObject({ status: 504 });
});

it('rejects invalid internal execution policy before accepting or claiming a Run', async () => {
  const before = (
    await db.query<{ count: number }>('SELECT count(*)::int AS count FROM agent_runs')
  ).rows[0].count;
  expect(() =>
    createApp(db, {
      origin,
      agent: { transport: { generate: async () => answer }, executionLimits: { maxModelCalls: 0 } },
    }),
  ).toThrow();
  expect(
    (await db.query<{ count: number }>('SELECT count(*)::int AS count FROM agent_runs')).rows[0]
      .count,
  ).toBe(before);
});
