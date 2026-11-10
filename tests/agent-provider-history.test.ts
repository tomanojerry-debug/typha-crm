import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import request, { type Agent, type Response as TestResponse } from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import type { AgentSnapshot } from '../shared/agent.js';
import type { ChatDetail } from '../shared/chat.js';
import { SseFrames } from '../shared/sse.js';

const origin = 'http://localhost:3100',
  password = 'provider-history-fixture-password',
  originalQuestion = '帮我找找姓沈的客户，并查看已有资料',
  candidateAnswer = '找到 1 位联系人，请选择卡片后继续。\n原任务保留“已有资料”。',
  completedAnswer = '已选择沈合成甲，继续原查询。\n现有联系人资料为 A_CONTACT_PRIVATE。';
type ProviderRequest = {
  stream: boolean;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
};
type Event = {
  type: string;
  text?: string;
  status?: number;
  error?: string;
  result?: ChatDetail;
};
let db: Database,
  admin: Agent,
  viewer: Agent,
  workspace: string,
  allowedCustomer: string,
  deniedCustomer: string;
let calls: ProviderRequest[] = [],
  failNextSelection = false;
const headers = () => ({ origin, 'x-workspace-id': workspace });
const events = (response: TestResponse) =>
  new SseFrames().push(response.text).map((frame) => JSON.parse(frame) as Event);

function streamContent(content: string) {
  const middle = Math.ceil(content.length / 2);
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const text =
    frame({ choices: [{ delta: { reasoning_content: 'PRIVATE_PROVIDER_REASONING' } }] }) +
    frame({ choices: [{ delta: { content: content.slice(0, middle) } }] }) +
    frame({
      choices: [{ delta: { content: content.slice(middle) }, finish_reason: 'stop' }],
    }) +
    'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        // Split inside UTF-8 characters as well as across provider SSE frames.
        for (let i = 0; i < bytes.length; i += 11) controller.enqueue(bytes.slice(i, i + 11));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}
function requestStrings(input: ProviderRequest) {
  return input.messages.flatMap(({ content }) => {
    try {
      return [content, ...strings(JSON.parse(content))];
    } catch {
      return [content];
    }
  });
}
const providerFetch = (async (_url, init) => {
  const payload = JSON.parse(String(init?.body)) as ProviderRequest;
  calls.push(payload);
  const snapshot = JSON.parse(payload.messages[1].content) as AgentSnapshot;
  const current = JSON.parse(payload.messages.at(-1)!.content) as { question: string };
  const classification = payload.messages[0].content.includes('意图分类器');
  const selecting = current.question === '选择第1个候选';
  let content: string;
  if (classification) {
    content = JSON.stringify({
      mail_action: null,
      intent: '查询资料',
      action: selecting ? 'select_candidate' : 'search_candidates',
      entity_type: 'person',
      target: selecting ? null : '沈',
      match_mode: selecting ? null : 'surname',
      candidate_index: selecting ? 1 : null,
      data_source: 'records',
      missing: [],
      reply: selecting ? '核验当前候选后继续原查询。' : '搜索姓沈的联系人。',
    });
  } else if (snapshot.retrieval?.status === 'candidates') {
    content = JSON.stringify({ answer: candidateAnswer, source_ids: [] });
  } else if (failNextSelection) {
    failNextSelection = false;
    content = payload.stream ? '{"answer":"未通过校验的临时回答' : '未按 JSON 协议回答。';
  } else {
    content = JSON.stringify({
      answer: completedAnswer,
      source_ids: snapshot.sources.slice(0, 1).map((source) => source.id),
    });
  }
  return payload.stream
    ? streamContent(content)
    : Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { content, reasoning_content: 'PRIVATE_PROVIDER_REASONING' },
          },
        ],
      });
}) as typeof fetch;

beforeAll(async () => {
  // Explicitly omit dataDir/url: this suite owns only an in-memory PGlite database.
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Provider history fixture',
    email: 'provider-history@fixture.invalid',
    displayName: 'Admin',
    password,
  });
  workspace = seed.workspaceId;
  const app = createApp(db, {
    origin,
    agent: { apiKey: 'SYNTHETIC_PROVIDER_KEY', fetch: providerFetch },
  });
  admin = request.agent(app);
  viewer = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'provider-history@fixture.invalid', password })
    .expect(200);
  const viewerId = (
    await admin
      .post('/api/members')
      .set(headers())
      .send({ email: 'provider-viewer@fixture.invalid', display_name: 'Viewer', password })
      .expect(201)
  ).body.actor_id;
  await viewer
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'provider-viewer@fixture.invalid', password })
    .expect(200);
  for (const [name, permitted] of [
    ['授权合成公司', true],
    ['未授权合成公司', false],
  ] as const) {
    const customer = (
      await admin
        .post('/api/customers')
        .set(headers())
        .send({ name, type: 'group', source: 'other' })
        .expect(201)
    ).body.id as string;
    if (permitted) allowedCustomer = customer;
    else deniedCustomer = customer;
    await admin
      .post('/api/people')
      .set(headers())
      .send({
        customer_id: customer,
        name: permitted ? '沈合成甲' : '沈未授权乙',
        description: permitted ? 'A_CONTACT_PRIVATE' : 'B_CONTACT_PRIVATE',
      })
      .expect(201);
  }
  await admin
    .post(`/api/customers/${deniedCustomer}/records`)
    .set(headers())
    .send({ kind: 'company_confirmed', body: 'B_BUSINESS_PRIVATE' })
    .expect(201);
  await admin
    .put(`/api/customers/${allowedCustomer}/access/${viewerId}`)
    .set(headers())
    .send({ access: 'viewer' })
    .expect(200);
}, 30000);
afterAll(async () => db?.close());
beforeEach(() => {
  calls = [];
  failNextSelection = false;
});

async function createCandidateChat(stream: boolean) {
  const id = (
    await viewer
      .post('/api/chats')
      .set(headers())
      .send({ id: randomUUID(), title: '合成真实响应协议验证', customer_id: null })
      .expect(201)
  ).body.id as string;
  const response = await viewer
    .post(`/api/chats/${id}/messages`)
    .set(headers())
    .set('accept', stream ? 'text/event-stream' : 'application/json')
    .send({ request_id: randomUUID(), body: originalQuestion })
    .expect(200);
  const detail = stream ? events(response).at(-1)!.result! : (response.body as ChatDetail);
  const candidate = detail.messages.at(-1)!;
  expect(candidate.body).toBe(candidateAnswer);
  expect(candidate.retrieval).toMatchObject({ status: 'candidates', total: 1 });
  expect(candidate.retrieval!.candidates).toMatchObject([
    { title: '沈合成甲', customer_id: allowedCustomer },
  ]);
  expect(JSON.stringify(calls)).not.toMatch(
    /A_CONTACT_PRIVATE|B_CONTACT_PRIVATE|B_BUSINESS_PRIVATE/,
  );
  expect(JSON.stringify(calls)).not.toContain('沈未授权乙');
  return { id, candidate };
}
function select(id: string, messageId: string, requestId: string, stream: boolean) {
  return viewer
    .post(`/api/chats/${id}/messages`)
    .set(headers())
    .set('accept', stream ? 'text/event-stream' : 'application/json')
    .send({
      request_id: requestId,
      body: '选择第1个候选',
      candidate_selection: { message_id: messageId, index: 1 },
    });
}
function assertSelectionRequest() {
  const classification = calls.at(-2)!,
    answer = calls.at(-1)!;
  expect(classification.messages[0].content).toContain('意图分类器');
  expect(answer.messages[0].content).toContain('CRM 助手');
  for (const payload of [classification, answer]) {
    expect(requestStrings(payload)).toContain(originalQuestion);
    expect(requestStrings(payload)).toContain(candidateAnswer);
    // Past natural-language answers must not teach the current JSON responder to
    // abandon its protocol; preserving them as explicit history data is allowed.
    for (const message of payload.messages.filter((message) => message.role === 'assistant'))
      expect(() => JSON.parse(message.content)).not.toThrow();
    expect(JSON.stringify(payload)).not.toMatch(/B_CONTACT_PRIVATE|B_BUSINESS_PRIVATE|沈未授权乙/);
  }
  const snapshot = JSON.parse(answer.messages[1].content) as AgentSnapshot;
  expect(snapshot.retrieval).toMatchObject({
    status: 'unique',
    task: { question: originalQuestion },
  });
  expect(snapshot.warnings).toContain(`继续用户原任务：${originalQuestion}`);
  expect(JSON.stringify(snapshot.sources)).toContain('A_CONTACT_PRIVATE');
  const entitySources = snapshot.sources.filter((source) => source.ref);
  expect(entitySources.length).toBeGreaterThan(0);
  expect(entitySources.every((source) => source.ref!.customer_id === allowedCustomer)).toBe(true);
  // Index availability is server status, not another customer's source.
  expect(snapshot.sources.filter((source) => !source.ref).map((source) => source.id)).toEqual([
    'knowledge:status',
  ]);
}
async function assertNoBusinessActions() {
  for (const table of ['outgoing_mail', 'wechat_queries']) {
    const result = await db.query<{ n: number }>(`SELECT count(*)::int n FROM ${table}`);
    expect(result.rows[0].n).toBe(0);
  }
}

it.each([false, true])(
  'continues a surname candidate through provider JSON history and scoped sources (stream=%s)',
  async (stream) => {
    const { id, candidate } = await createCandidateChat(stream);
    const response = await select(id, candidate.id, randomUUID(), stream).expect(200);
    const detail = stream ? events(response).at(-1)!.result! : (response.body as ChatDetail);
    expect(calls).toHaveLength(4);
    assertSelectionRequest();
    expect(detail.messages).toHaveLength(4);
    expect(detail.messages[1]).toEqual(candidate);
    expect(detail.messages[3]).toMatchObject({
      body: completedAnswer,
      retrieval: { status: 'unique', task: { question: originalQuestion } },
      sources: [{ customer_id: allowedCustomer }],
    });
    expect(JSON.stringify(detail)).not.toContain('PRIVATE_PROVIDER_REASONING');
    if (stream) {
      expect(events(response).some((event) => event.type === 'answer')).toBe(true);
      expect(events(response).at(-1)?.type).toBe('done');
    }
    await assertNoBusinessActions();
  },
);

it.each([false, true])(
  'keeps a failed provider selection atomic and retries the same request only once (stream=%s)',
  async (stream) => {
    const { id, candidate } = await createCandidateChat(stream),
      requestId = randomUUID();
    failNextSelection = true;
    const failure = await select(id, candidate.id, requestId, stream).expect(stream ? 200 : 502);
    expect(calls).toHaveLength(4);
    assertSelectionRequest();
    if (stream) {
      expect(events(failure).some((event) => event.type === 'answer')).toBe(true);
      expect(events(failure).at(-1)).toMatchObject({ type: 'error', status: 502 });
      expect(events(failure).some((event) => event.type === 'done')).toBe(false);
    } else expect(failure.body.error).toContain('回答格式异常');
    const unchanged = (await viewer.get(`/api/chats/${id}`).set(headers()).expect(200))
      .body as ChatDetail;
    expect(unchanged.messages).toHaveLength(2);
    expect(unchanged.messages[1]).toEqual(candidate);
    const retry = await select(id, candidate.id, requestId, stream).expect(200);
    const detail = stream ? events(retry).at(-1)!.result! : (retry.body as ChatDetail);
    expect(calls).toHaveLength(6);
    assertSelectionRequest();
    expect(detail.messages).toHaveLength(4);
    expect(detail.messages[3].body).toBe(completedAnswer);
    await select(id, candidate.id, requestId, stream).expect(200);
    expect(calls).toHaveLength(6);
    const reloaded = (await viewer.get(`/api/chats/${id}`).set(headers()).expect(200))
      .body as ChatDetail;
    expect(reloaded.messages).toEqual(detail.messages);
    expect(JSON.stringify(reloaded)).not.toContain('未通过校验的临时回答');
    await assertNoBusinessActions();
  },
);
