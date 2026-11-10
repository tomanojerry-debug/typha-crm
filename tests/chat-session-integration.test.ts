import { afterAll, beforeAll, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import { continueTurns, resumeTurns, type AgentModelInput } from '../server/agent-model.js';
import type { ChatPage } from '../shared/chat.js';

const origin = 'http://localhost:3100';
const password = 'session-integration-fixture-password';
let db: Database, actor: string, workspace: string, admin: Agent, other: Agent;
const seen: AgentModelInput[] = [];
const h = () => ({ origin, 'x-workspace-id': workspace });
const newChat = async () =>
  (
    await admin
      .post('/api/chats')
      .set(h())
      .send({ id: randomUUID(), title: '测试工作', customer_id: null })
      .expect(201)
  ).body.id as string;
const send = (id: string, body: string, request_id = randomUUID()) =>
  admin.post(`/api/chats/${id}/messages`).set(h()).send({ body, request_id });

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Session integration',
    email: 'sessions@fixture.invalid',
    password,
    displayName: 'Tester',
  });
  workspace = seed.workspaceId;
  actor = seed.actorId;
  const app = createApp(db, {
    origin,
    agent: {
      transport: {
        async generate(input) {
          if (input.phase === 'classify')
            return { intent: '一般对话', target: null, missing: [], reply: '处理当前用户问题。' };
          seen.push(input);
          return { answer: '根据当前要求处理。', source_ids: [] };
        },
      },
    },
  });
  admin = request.agent(app);
  other = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'sessions@fixture.invalid', password })
    .expect(200);
  await admin
    .post('/api/members')
    .set(h())
    .send({ email: 'session-other@fixture.invalid', display_name: 'Other', password })
    .expect(201);
  await other
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'session-other@fixture.invalid', password })
    .expect(200);
}, 30000);
afterAll(() => db.close());

it('paginates beyond the old 100-chat cap without gaps at identical timestamps', async () => {
  const ids = Array.from({ length: 107 }, () => randomUUID());
  await scoped(db, actor, workspace, async (ctx) => {
    await ctx.tx.query(
      `INSERT INTO agent_chats(workspace_id,actor_id,id,title,customer_id)
       SELECT $1,$2,x.id,'分页合成对话',NULL FROM jsonb_to_recordset($3::jsonb) x(id uuid)`,
      [workspace, actor, JSON.stringify(ids.map((id) => ({ id })))],
    );
  });
  const loaded: string[] = [];
  let cursor: string | null = null;
  do {
    const page: ChatPage = (
      await admin
        .get(`/api/chats/page?limit=10${cursor ? `&cursor=${cursor}` : ''}`)
        .set(h())
        .expect(200)
    ).body;
    expect(page.items.length).toBeLessThanOrEqual(10);
    loaded.push(...page.items.map((c) => c.id));
    cursor = page.next_cursor;
  } while (cursor);
  expect(loaded).toHaveLength(107);
  expect(new Set(loaded)).toEqual(new Set(ids));
  expect((await other.get('/api/chats/page?limit=10').set(h()).expect(200)).body).toEqual({
    items: [],
    next_cursor: null,
  });
  await admin.get('/api/chats/page?cursor=invalid').set(h()).expect(400);
  await admin.get('/api/chats/page?limit=11').set(h()).expect(400);
});

it('uses exactly the latest ten complete Home turns while preserving the entire log', async () => {
  const id = await newChat();
  for (let n = 1; n <= 12; n++) await send(id, `普通问题第${n}次`).expect(200);
  const input = seen.at(-1)!;
  expect(input.history).toHaveLength(20);
  expect(input.history[0].content).toBe('普通问题第2次');
  expect(input.history.at(-2)?.content).toBe('普通问题第11次');
  expect(input.history.some((t) => t.content === '普通问题第1次')).toBe(false);
  expect((await admin.get(`/api/chats/${id}`).set(h()).expect(200)).body.messages).toHaveLength(24);
});

it('persists an explicit preference after a model answer and applies it in a new chat', async () => {
  const id = await newChat(),
    request_id = randomUUID();
  await send(id, '记住：以后查联系人用姓名、公司、邮箱三列表格', request_id).expect(200);
  let preferences = (await admin.get('/api/agent/preferences').set(h()).expect(200)).body;
  expect(preferences).toHaveLength(1);
  expect(preferences[0].category).toBe('contact_columns');
  expect((await other.get('/api/agent/preferences').set(h()).expect(200)).body).toHaveLength(0);
  const next = await newChat();
  await send(next, '普通问题').expect(200);
  expect(seen.at(-1)?.user_preferences).toEqual([
    { category: 'contact_columns', value: '查询联系人时，用姓名、公司、邮箱三列表格展示。' },
  ]);
  await send(id, '记住：以后查联系人用姓名、公司、邮箱三列表格', request_id).expect(200);
  preferences = (await admin.get('/api/agent/preferences').set(h()).expect(200)).body;
  expect(preferences).toHaveLength(1);
  await other.delete(`/api/agent/preferences/${preferences[0].id}`).set(h()).send({}).expect(404);
  await admin.delete(`/api/agent/preferences/${preferences[0].id}`).set(h()).send({}).expect(200);
  await send(await newChat(), '普通问题').expect(200);
  expect(seen.at(-1)?.user_preferences).toEqual([]);
});

it('keeps all twenty continuation messages even when Chinese text exceeds the old byte limit', () => {
  const key = randomBytes(32);
  const turns = Array.from({ length: 24 }, (_, n) => ({
    role: n % 2 ? ('assistant' as const) : ('user' as const),
    content: `${n}：${'测'.repeat(3000)}`,
  }));
  const history = resumeTurns(continueTurns(turns, key, 'scope', 'digest'), key, 'scope', 'digest');
  expect(history).toHaveLength(20);
  expect(history[0].content).toBe(turns[4].content);
  expect(history.at(-1)?.content).toBe(turns[23].content);
});
