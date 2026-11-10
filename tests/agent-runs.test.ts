import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import type { AgentModelInput, AgentStream } from '../server/agent-model.js';
import type { AgentRunResult } from '../shared/agent-runs.js';

const origin = 'http://localhost:3100',
  password = 'background-agent-run-fixture-password';
let db: Database,
  admin: Agent,
  viewer: Agent,
  workspace: string,
  viewerId: string,
  customer: string,
  base: string,
  adminCookie: string,
  server: Server;
let app: ReturnType<typeof createApp>;
let modelCalls = 0;
let classify: (input: AgentModelInput) => unknown;
let answer: (input: AgentModelInput, stream: AgentStream) => Promise<unknown>;
const h = () => ({ origin, 'x-workspace-id': workspace });
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function controlled(text = '正在分段回答') {
  const started = deferred(),
    released = deferred();
  let aborted = false;
  answer = async (input, stream) => {
    await stream.onText(text);
    started.resolve();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        aborted = true;
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      stream.signal.addEventListener('abort', abort, { once: true });
      released.promise.then(() => {
        stream.signal.removeEventListener('abort', abort);
        resolve();
      });
      if (stream.signal.aborted) abort();
    });
    await stream.onText('完整回答');
    return {
      answer: '完整回答',
      source_ids: input.snapshot.sources.slice(0, 1).map((source) => source.id),
    };
  };
  return { started: started.promise, release: () => released.resolve(), aborted: () => aborted };
}
async function newChat(agent = admin, customer_id: string | null = null) {
  return (
    await agent
      .post('/api/chats')
      .set(h())
      .send({ id: randomUUID(), title: '后台问答合成验收', customer_id })
      .expect(201)
  ).body.id as string;
}
const enqueue = (agent: Agent, chatId: string, body = '帮我整理一份提纲', id = randomUUID()) =>
  agent
    .post(`/api/chats/${chatId}/runs`)
    .set(h())
    .send({ kind: 'message', payload: { request_id: id, body } });
async function read(agent: Agent, chatId: string, runId: string) {
  return (await agent.get(`/api/chats/${chatId}/runs/${runId}`).set(h()).expect(200))
    .body as AgentRunResult;
}
async function terminal(agent: Agent, chatId: string, runId: string) {
  const end = Date.now() + 6000;
  let result: AgentRunResult;
  do {
    result = await read(agent, chatId, runId);
    if (!['queued', 'running', 'cancelling'].includes(result.run.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < end);
  throw new Error(`后台任务没有收束：${result!.run.status}`);
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Background agent runs',
    email: 'runs-admin@fixture.invalid',
    password,
    displayName: 'Admin',
  });
  workspace = seed.workspaceId;
  app = createApp(db, {
    origin,
    agent: {
      key: randomBytes(32),
      transport: {
        async generate(input) {
          if (input.phase === 'classify') return classify(input);
          throw new Error('后台回答应使用流式适配器');
        },
        async stream(input, stream) {
          modelCalls++;
          return answer(input, stream);
        },
      },
    },
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  admin = request.agent(base);
  viewer = request.agent(base);
  const login = await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'runs-admin@fixture.invalid', password })
    .expect(200);
  adminCookie = (login.headers['set-cookie'] as unknown as string[])
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
  viewerId = (
    await admin
      .post('/api/members')
      .set(h())
      .send({ email: 'runs-viewer@fixture.invalid', display_name: 'Viewer', password })
      .expect(201)
  ).body.actor_id;
  await viewer
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'runs-viewer@fixture.invalid', password })
    .expect(200);
  customer = (
    await admin
      .post('/api/customers')
      .set(h())
      .send({
        name: 'RUN_PRIVATE_CUSTOMER',
        type: 'group',
        source: 'other',
        email: 'run_private@example.com',
      })
      .expect(201)
  ).body.id;
  await admin
    .put(`/api/customers/${customer}/access/${viewerId}`)
    .set(h())
    .send({ access: 'viewer' })
    .expect(200);
}, 30000);
beforeEach(() => {
  modelCalls = 0;
  classify = () => ({ intent: '一般对话', target: null, missing: [], reply: '按当前资料回答。' });
  answer = async () => ({ answer: '完整回答', source_ids: [] });
});
afterAll(async () => {
  await app?.locals.agentRuns?.stop();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.close();
});

it('accepts a durable pending question immediately, before any canonical answer pair exists', async () => {
  const gate = controlled(),
    chatId = await newChat(),
    requestId = randomUUID();
  const accepted = (await enqueue(admin, chatId, '帮我整理一份提纲', requestId).expect(202))
    .body as AgentRunResult;
  expect(accepted.run).toMatchObject({
    chat_id: chatId,
    request_id: requestId,
    kind: 'message',
    question: '帮我整理一份提纲',
  });
  expect(['queued', 'running']).toContain(accepted.run.status);
  await gate.started;
  const pending = (await admin.get(`/api/chats/${chatId}`).set(h()).expect(200)).body;
  expect(pending.run.id).toBe(accepted.run.id);
  expect(pending.messages).toEqual([]);
  const page = (await admin.get('/api/chats/page').set(h()).expect(200)).body;
  expect(page.items.find((chat: { id: string }) => chat.id === chatId)).toMatchObject({
    run_status: 'running',
  });
  const saved = await db.query('SELECT id FROM chat_messages WHERE chat_id=$1', [chatId]);
  expect(saved.rows).toEqual([]);
  gate.release();
  const done = await terminal(admin, chatId, accepted.run.id);
  expect(done.run.status).toBe('completed');
  expect(done.detail.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  expect(done.detail.messages[1].body).toBe('完整回答');
});

it('continues streaming after an SSE subscriber disconnects and restores the final answer', async () => {
  const gate = controlled(),
    chatId = await newChat();
  const accepted = (await enqueue(admin, chatId).expect(202)).body as AgentRunResult;
  await gate.started;
  const controller = new AbortController();
  const response = await fetch(`${base}/api/chats/${chatId}/runs/${accepted.run.id}/events`, {
    headers: { ...h(), cookie: adminCookie },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  let received = '';
  while (!received.includes('"type":"run"')) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error('没有收到任务首帧');
    received += new TextDecoder().decode(chunk.value);
  }
  await reader.cancel();
  controller.abort();
  expect(gate.aborted()).toBe(false);
  gate.release();
  const done = await terminal(admin, chatId, accepted.run.id);
  expect(done.run.status).toBe('completed');
  expect(gate.aborted()).toBe(false);
  expect(modelCalls).toBe(1);
  const restored = (await admin.get(`/api/chats/${chatId}`).set(h()).expect(200)).body;
  expect(restored.messages[1].body).toBe('完整回答');
});

it('deduplicates concurrent identical input and refuses request-id reuse with different input', async () => {
  const gate = controlled(),
    chatId = await newChat(),
    requestId = randomUUID();
  const replies = await Promise.all([
    enqueue(admin, chatId, '同一个问题', requestId).expect(202),
    enqueue(admin, chatId, '同一个问题', requestId).expect(202),
  ]);
  expect(replies[0].body.run.id).toBe(replies[1].body.run.id);
  await gate.started;
  await enqueue(admin, chatId, '换成其他问题', requestId).expect(409);
  gate.release();
  await terminal(admin, chatId, replies[0].body.run.id);
  const again = (await enqueue(admin, chatId, '同一个问题', requestId).expect(202)).body;
  expect(again.run.status).toBe('completed');
  expect(modelCalls).toBe(1);
  expect(again.detail.messages).toHaveLength(2);
});

it('serializes all active work for a chat, including legacy send routes, and isolates run ownership', async () => {
  const gate = controlled(),
    chatId = await newChat();
  const accepted = (await enqueue(admin, chatId).expect(202)).body as AgentRunResult;
  await gate.started;
  await enqueue(admin, chatId, '另一个并发问题').expect(409);
  await admin
    .post(`/api/chats/${chatId}/messages`)
    .set(h())
    .send({ request_id: randomUUID(), body: '旧入口并发问题' })
    .expect(409);
  await viewer.get(`/api/chats/${chatId}/runs/${accepted.run.id}`).set(h()).expect(404);
  gate.release();
  expect((await terminal(admin, chatId, accepted.run.id)).run.status).toBe('completed');
  expect(modelCalls).toBe(1);
});

it('cancels only on explicit request, saves no partial pair, and retries the same accepted input once', async () => {
  const gate = controlled(),
    chatId = await newChat();
  const accepted = (await enqueue(admin, chatId).expect(202)).body as AgentRunResult;
  await gate.started;
  await admin
    .post(`/api/chats/${chatId}/runs/${accepted.run.id}/cancel`)
    .set(h())
    .send({})
    .expect(200);
  const cancelled = await terminal(admin, chatId, accepted.run.id);
  expect(cancelled.run.status).toBe('cancelled');
  expect(cancelled.run.answer).toBe('');
  expect(cancelled.detail.messages).toEqual([]);
  expect(gate.aborted()).toBe(true);
  answer = async () => ({ answer: '重试完成', source_ids: [] });
  const retry = (
    await admin
      .post(`/api/chats/${chatId}/runs/${accepted.run.id}/retry`)
      .set(h())
      .send({})
      .expect(202)
  ).body as AgentRunResult;
  expect(retry.run.id).toBe(accepted.run.id);
  expect(retry.run.request_id).toBe(accepted.run.request_id);
  const done = await terminal(admin, chatId, accepted.run.id);
  expect(done.run.status).toBe('completed');
  expect(done.detail.messages).toHaveLength(2);
  expect(done.detail.messages[1].body).toBe('重试完成');
  expect(modelCalls).toBe(2);
});

it('does not replay a persisted partial answer after customer access is revoked from an unbound chat', async () => {
  classify = () => ({
    intent: '查询资料',
    target: 'run_private',
    missing: [],
    reply: '查询授权邮箱目录。',
  });
  const secret = 'UNBOUND_PRIVATE_PARTIAL_ANSWER',
    gate = controlled(secret),
    chatId = await newChat(viewer);
  const accepted = (await enqueue(viewer, chatId, '查邮箱run_private的客户').expect(202))
    .body as AgentRunResult;
  await gate.started;
  const before = await read(viewer, chatId, accepted.run.id);
  expect(before.run.answer).toBe(secret);
  await admin
    .put(`/api/customers/${customer}/access/${viewerId}`)
    .set(h())
    .send({ access: null })
    .expect(200);
  const after = await viewer.get(`/api/chats/${chatId}/runs/${accepted.run.id}`).set(h());
  expect([200, 404, 409]).toContain(after.status);
  expect(JSON.stringify(after.body)).not.toContain(secret);
  const restored = await viewer.get(`/api/chats/${chatId}`).set(h()).expect(200);
  expect(JSON.stringify(restored.body)).not.toContain(secret);
  gate.release();
  const end = Date.now() + 6000;
  let status = '';
  do {
    status = (
      await db.query<{ status: string }>('SELECT status FROM agent_runs WHERE id=$1', [
        accepted.run.id,
      ])
    ).rows[0].status;
    if (!['queued', 'running', 'cancelling'].includes(status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < end);
  expect(['failed', 'cancelled', 'interrupted']).toContain(status);
  expect((await db.query('SELECT id FROM chat_messages WHERE chat_id=$1', [chatId])).rows).toEqual(
    [],
  );
});

it('creates an Ask conversation with its validated origin before the model finishes', async () => {
  const gate = controlled(),
    chatId = randomUUID(),
    requestId = randomUUID(),
    scope = { kind: 'entity', object: 'customers', customer_id: customer, record_id: customer };
  const accepted = (
    await admin
      .post('/api/ask/runs')
      .set(h())
      .send({
        chat_id: chatId,
        request_id: requestId,
        scope,
        question: '概括当前资料',
        action: 'overview',
      })
      .expect(202)
  ).body as AgentRunResult;
  expect(accepted.run).toMatchObject({ chat_id: chatId, request_id: requestId, kind: 'ask' });
  expect(accepted.detail.chat.origin).toMatchObject({ kind: 'ask', scope });
  expect(accepted.detail.chat.customer_id).toBe(customer);
  await gate.started;
  const pending = (await admin.get(`/api/chats/${chatId}`).set(h()).expect(200)).body;
  expect(pending.messages).toEqual([]);
  expect(pending.run.id).toBe(accepted.run.id);
  const duplicates = await Promise.all(
    [0, 1].map(() =>
      admin
        .post('/api/ask/runs')
        .set(h())
        .send({
          chat_id: chatId,
          request_id: requestId,
          scope,
          question: '概括当前资料',
          action: 'overview',
        })
        .expect(202),
    ),
  );
  expect(duplicates.map((reply) => reply.body.run.id)).toEqual([accepted.run.id, accepted.run.id]);
  expect(modelCalls).toBe(1);
  await admin
    .post('/api/ask/runs')
    .set(h())
    .send({
      chat_id: chatId,
      request_id: randomUUID(),
      scope: { kind: 'page', page: 'mail' },
      question: '切换范围',
    })
    .expect(409);
  gate.release();
  const done = await terminal(admin, chatId, accepted.run.id);
  expect(done.run.status).toBe('completed');
  expect(done.detail.messages).toHaveLength(2);
  expect(done.detail.messages[1].body).toBe('完整回答');
});

it('rejects unauthorized Ask scope without creating an empty conversation or calling the model', async () => {
  const chatId = randomUUID();
  await admin
    .put(`/api/customers/${customer}/access/${viewerId}`)
    .set(h())
    .send({ access: null })
    .expect(200);
  await viewer
    .post('/api/ask/runs')
    .set(h())
    .send({
      chat_id: chatId,
      request_id: randomUUID(),
      scope: { kind: 'entity', object: 'customers', customer_id: customer, record_id: customer },
      question: '概括当前资料',
    })
    .expect(404);
  expect(modelCalls).toBe(0);
  expect((await db.query('SELECT id FROM agent_chats WHERE id=$1', [chatId])).rows).toEqual([]);
});

it('clears streamed drafts on model failure and never commits half a turn or exposes raw provider errors', async () => {
  answer = async (_input, stream) => {
    await stream.onText('不能保存的半段回答');
    throw new Error('RAW_PROVIDER_SECRET_TRACE');
  };
  const chatId = await newChat(),
    accepted = (await enqueue(admin, chatId).expect(202)).body as AgentRunResult,
    done = await terminal(admin, chatId, accepted.run.id);
  expect(done.run.status).toBe('failed');
  expect(done.run.answer).toBe('');
  expect(done.run.error).toBeTruthy();
  expect(JSON.stringify(done)).not.toContain('RAW_PROVIDER_SECRET_TRACE');
  expect(done.detail.messages).toEqual([]);
});

it('recovers interrupted runs without replaying model work and preserves a previously committed answer', async () => {
  answer = async () => {
    throw new Error('simulated worker failure before a saved answer');
  };
  const failedChat = await newChat(),
    failedRun = (await enqueue(admin, failedChat).expect(202)).body as AgentRunResult;
  expect((await terminal(admin, failedChat, failedRun.run.id)).run.status).toBe('failed');
  await db.query("UPDATE agent_runs SET status='running',answer='旧进程遗留草稿' WHERE id=$1", [
    failedRun.run.id,
  ]);
  await app.locals.agentRuns.recover();
  const interrupted = await read(admin, failedChat, failedRun.run.id);
  expect(interrupted.run.status).toBe('interrupted');
  expect(interrupted.run.answer).toBe('');
  expect(interrupted.run.question).toBe(failedRun.run.question);
  expect(interrupted.detail.messages).toEqual([]);
  expect(modelCalls).toBe(1);

  answer = async () => ({ answer: '重启前已经保存', source_ids: [] });
  const savedChat = await newChat(),
    savedRun = (await enqueue(admin, savedChat).expect(202)).body as AgentRunResult;
  expect((await terminal(admin, savedChat, savedRun.run.id)).run.status).toBe('completed');
  await db.query("UPDATE agent_runs SET status='cancelling',answer='过期草稿' WHERE id=$1", [
    savedRun.run.id,
  ]);
  await app.locals.agentRuns.recover();
  const recovered = await read(admin, savedChat, savedRun.run.id);
  expect(recovered.run.status).toBe('completed');
  expect(recovered.run.answer).toBe('');
  expect(recovered.detail.messages[1].body).toBe('重启前已经保存');
  const lateCancel = (
    await admin
      .post(`/api/chats/${savedChat}/runs/${savedRun.run.id}/cancel`)
      .set(h())
      .send({})
      .expect(200)
  ).body as AgentRunResult;
  expect(lateCancel.run.status).toBe('completed');
  expect(lateCancel.detail.messages[1].body).toBe('重启前已经保存');
  await admin
    .post(`/api/chats/${savedChat}/runs/${savedRun.run.id}/retry`)
    .set(h())
    .send({})
    .expect(202);
  expect(modelCalls).toBe(2);
  expect((await read(admin, savedChat, savedRun.run.id)).detail.messages).toHaveLength(2);
});

it('runs workflow replies in the same durable queue and invalidates a draft when its configuration changes', async () => {
  const pack = (body: string) => ({ body, decisions: [], draft_body: null, changes: [] });
  const workflowGate = () => {
    const started = deferred(),
      released = deferred();
    answer = async (_input, stream) => {
      await stream.onText(JSON.stringify(pack('工作流程分段草稿')));
      started.resolve();
      await released.promise;
      return { answer: JSON.stringify(pack('流程回答完成')), source_ids: [] };
    };
    return { started: started.promise, release: () => released.resolve() };
  };
  const chatId = await newChat();
  const workflow = (
    await admin.post(`/api/chats/${chatId}/workflow`).set(h()).send({ kind: 'summary' }).expect(201)
  ).body;
  let gate = workflowGate();
  const accepted = (
    await admin
      .post(`/api/chats/${chatId}/runs`)
      .set(h())
      .send({
        kind: 'workflow',
        payload: {
          version: workflow.version,
          request_id: randomUUID(),
          body: '你好',
          phase: 'analyze',
        },
      })
      .expect(202)
  ).body as AgentRunResult;
  await gate.started;
  expect((await read(admin, chatId, accepted.run.id)).run).toMatchObject({
    kind: 'workflow',
    answer: '工作流程分段草稿',
    status: 'running',
  });
  await enqueue(admin, chatId, '工作流程期间的普通问题').expect(409);
  gate.release();
  const done = await terminal(admin, chatId, accepted.run.id);
  expect(done.run.status).toBe('completed');
  expect(done.detail.messages[1].body).toBe('流程回答完成');

  const latest = (await admin.get(`/api/chats/${chatId}/workflow`).set(h()).expect(200)).body;
  gate = workflowGate();
  const stale = (
    await admin
      .post(`/api/chats/${chatId}/runs`)
      .set(h())
      .send({
        kind: 'workflow',
        payload: {
          version: latest.version,
          request_id: randomUUID(),
          body: '你好',
          phase: 'analyze',
        },
      })
      .expect(202)
  ).body as AgentRunResult;
  await gate.started;
  await admin
    .patch(`/api/chats/${chatId}/workflow`)
    .set(h())
    .send({
      version: latest.version,
      config: { ...latest.config, instruction: '修改后的新条件' },
    })
    .expect(200);
  const changed = await read(admin, chatId, stale.run.id);
  expect(changed.run.answer).toBe('');
  gate.release();
  const failed = await terminal(admin, chatId, stale.run.id);
  expect(failed.run.status).toBe('failed');
  expect(failed.detail.messages).toHaveLength(2);
});

it('releases Ask session claims after model failure or cancellation and can retry the same request', async () => {
  const scope = {
    kind: 'entity',
    object: 'customers',
    customer_id: customer,
    record_id: customer,
  };
  const startAsk = async () => {
    const chatId = randomUUID(),
      requestId = randomUUID();
    const accepted = (
      await admin
        .post('/api/ask/runs')
        .set(h())
        .send({
          chat_id: chatId,
          request_id: requestId,
          scope,
          question: '概括当前资料',
        })
        .expect(202)
    ).body as AgentRunResult;
    return { chatId, requestId, accepted };
  };
  const assertNoClaim = async (chatId: string) => {
    expect(
      (await db.query('SELECT token FROM ask_session_claims WHERE chat_id=$1', [chatId])).rows,
    ).toEqual([]);
  };
  const retryAsk = async (chatId: string, run: AgentRunResult) => {
    answer = async () => ({ answer: 'Ask重试完成', source_ids: [] });
    const retried = (
      await admin
        .post(`/api/chats/${chatId}/runs/${run.run.id}/retry`)
        .set(h())
        .send({})
        .expect(202)
    ).body as AgentRunResult;
    expect(retried.run.request_id).toBe(run.run.request_id);
    const done = await terminal(admin, chatId, run.run.id);
    expect(done.run.status).toBe('completed');
    expect(done.detail.messages).toHaveLength(2);
    expect(done.detail.messages[1].body).toBe('Ask重试完成');
    await assertNoClaim(chatId);
  };

  answer = async () => {
    throw new Error('simulated Ask failure');
  };
  const failed = await startAsk();
  expect((await terminal(admin, failed.chatId, failed.accepted.run.id)).run.status).toBe('failed');
  await assertNoClaim(failed.chatId);
  await retryAsk(failed.chatId, failed.accepted);

  const gate = controlled('Ask取消前的分段草稿'),
    cancelled = await startAsk();
  await gate.started;
  expect(
    (await db.query('SELECT token FROM ask_session_claims WHERE chat_id=$1', [cancelled.chatId]))
      .rows,
  ).toHaveLength(1);
  await admin
    .post(`/api/chats/${cancelled.chatId}/runs/${cancelled.accepted.run.id}/cancel`)
    .set(h())
    .send({})
    .expect(200);
  expect((await terminal(admin, cancelled.chatId, cancelled.accepted.run.id)).run.status).toBe(
    'cancelled',
  );
  await assertNoClaim(cancelled.chatId);
  await retryAsk(cancelled.chatId, cancelled.accepted);
});

it('rejects retrying an older failed run after a newer turn has completed', async () => {
  answer = async () => {
    throw new Error('first attempt failed');
  };
  const chatId = await newChat();
  const first = (await enqueue(admin, chatId, '旧查询').expect(202)).body as AgentRunResult;
  expect((await terminal(admin, chatId, first.run.id)).run.status).toBe('failed');
  answer = async () => ({ answer: '当前会话的新回答', source_ids: [] });
  const second = (await enqueue(admin, chatId, '新的查询').expect(202)).body as AgentRunResult;
  expect((await terminal(admin, chatId, second.run.id)).run.status).toBe('completed');
  const retry = await admin
    .post(`/api/chats/${chatId}/runs/${first.run.id}/retry`)
    .set(h())
    .send({})
    .expect(409);
  expect(retry.body.error).toContain('按当前会话重新提问');
  expect(modelCalls).toBe(2);
  const latest = (await admin.get(`/api/chats/${chatId}`).set(h()).expect(200)).body;
  expect(latest.run.id).toBe(second.run.id);
  expect(latest.messages).toHaveLength(2);
  expect(latest.messages[1].body).toBe('当前会话的新回答');
});

it('does not answer or append messages when shutdown begins while classification is pending', async () => {
  const classificationStarted = deferred(),
    classificationReleased = deferred();
  classify = async () => {
    classificationStarted.resolve();
    await classificationReleased.promise;
    return { intent: '一般对话', target: null, missing: [], reply: '已分类。' };
  };
  const chatId = await newChat(),
    accepted = (await enqueue(admin, chatId).expect(202)).body as AgentRunResult;
  await classificationStarted.promise;
  const stopping = app.locals.agentRuns.stop();
  classificationReleased.resolve();
  await stopping;
  const interrupted = await read(admin, chatId, accepted.run.id);
  expect(interrupted.run.status).toBe('interrupted');
  expect(interrupted.run.answer).toBe('');
  expect(interrupted.detail.messages).toEqual([]);
  expect(modelCalls).toBe(0);
  expect((await db.query('SELECT id FROM chat_messages WHERE chat_id=$1', [chatId])).rows).toEqual(
    [],
  );
});
