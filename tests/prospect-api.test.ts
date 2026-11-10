import { afterAll, beforeAll, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import { insert } from '../server/service.js';
import type { Prospect, ProspectRequirement } from '../shared/prospects.js';

let db: Database, client: Agent, workspace: string, actor: string, customer: string;
let lastContext = '';
const origin = 'http://localhost:3100';
const headers = () => ({ origin, 'x-workspace-id': workspace });
const condition = (): ProspectRequirement => ({
  id: randomUUID(),
  title: '等待客户确认尺码分配',
  status: 'missing',
  waiting_on: 'customer',
  assignee_id: actor,
  due_date: '2026-11-12',
  result: '',
  source_record_ids: [],
});
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: '潜客HTTP虚构环境',
    email: 'prospect-api@example.invalid',
    displayName: '合成老板',
    password: 'prospect-test-password',
  });
  workspace = seed.workspaceId;
  actor = seed.actorId;
  customer = await scoped(db, actor, workspace, async (ctx) =>
    String(
      (
        await insert(ctx, 'customers', {
          name: '个人零售虚构客户',
          type: 'retail',
          source: 'store',
        })
      ).id,
    ),
  );
  client = request.agent(
    createApp(db, {
      origin,
      agent: {
        transport: {
          async generate(input) {
            lastContext = input.snapshot.sources.map((source) => source.body).join('\n');
            return {
              answer: '当前仍需确认尺码分配。',
              source_ids: input.snapshot.sources.slice(0, 1).map((source) => source.id),
            };
          },
        },
      },
    }),
  );
  await client
    .post('/api/auth/login')
    .set({ origin })
    .send({ email: 'prospect-api@example.invalid', password: 'prospect-test-password' })
    .expect(200);
}, 30000);
afterAll(async () => {
  await db?.close();
});

it('exposes the library capability and one authoritative state through HTTP and todos', async () => {
  const caps = (await client.get('/api/agent/capabilities').set(headers()).expect(200)).body;
  expect(caps.prospects).toBe(true);
  const state = condition();
  const body = {
    request_id: randomUUID(),
    customer_id: customer,
    name: '儿童练功服尺码咨询',
    owner_id: actor,
    summary: '本次仅确认尺码。',
    requirements: [state],
  };
  const created: Prospect = (
    await client.post('/api/prospects').set(headers()).send(body).expect(201)
  ).body;
  expect(created.customer_type).toBe('retail');
  expect((await client.post('/api/prospects').set(headers()).send(body).expect(201)).body.id).toBe(
    created.id,
  );
  const pending = (await client.get('/api/prospects/tasks?status=open').set(headers()).expect(200))
    .body;
  expect(
    pending.items.some(
      (x: { id: string; prospect_id: string }) => x.id === state.id && x.prospect_id === created.id,
    ),
  ).toBe(true);
  await client
    .post('/api/ask/query')
    .set(headers())
    .send({
      scope: { kind: 'entity', object: 'projects', customer_id: customer, record_id: created.id },
      question: '这次咨询还有哪些没满足，建议下一步做什么？',
    })
    .expect(200);
  expect(lastContext).toContain('当前询盘已保存的业务工作状态');
  expect(lastContext).toContain(state.title);
  const updated: Prospect = (
    await client
      .patch(`/api/prospects/${created.id}`)
      .set(headers())
      .send({
        request_id: randomUUID(),
        version: created.version,
        requirements: [{ ...state, status: 'satisfied', result: '客户已明确确认尺码表。' }],
      })
      .expect(200)
  ).body;
  expect(updated.version).toBe(created.version + 1);
  expect(
    (
      await client.get('/api/prospects/tasks?status=open').set(headers()).expect(200)
    ).body.items.some((x: { id: string }) => x.id === state.id),
  ).toBe(false);
  expect(
    (
      await client.get('/api/prospects/tasks?status=completed').set(headers()).expect(200)
    ).body.items.some((x: { id: string }) => x.id === state.id),
  ).toBe(true);
  expect((await client.get('/api/tasks').set(headers()).expect(200)).body).toEqual([]);
});

it('keeps the same customer for separate inquiries and prevents the ordinary project route bypass', async () => {
  const first: Prospect = (
    await client
      .post('/api/prospects')
      .set(headers())
      .send({
        request_id: randomUUID(),
        customer_id: customer,
        name: '第一笔咨询',
        owner_id: actor,
      })
      .expect(201)
  ).body;
  const next: Prospect = (
    await client
      .post('/api/prospects')
      .set(headers())
      .send({
        request_id: randomUUID(),
        customer_id: customer,
        name: '第二笔咨询',
        owner_id: actor,
      })
      .expect(201)
  ).body;
  expect(next.id).not.toBe(first.id);
  const project = (
    await client.get(`/api/customers/${customer}/projects/${first.id}`).set(headers()).expect(200)
  ).body;
  await client
    .patch(`/api/customers/${customer}/projects/${first.id}`)
    .set(headers())
    .send({ version: project.version, type: 'sample' })
    .expect(409);
  await client
    .patch(`/api/prospects/${first.id}`)
    .set(headers())
    .send({ request_id: randomUUID(), version: first.version, stage: 'proposal' })
    .expect(200);
  await client
    .patch(`/api/prospects/${first.id}`)
    .set(headers())
    .send({ request_id: randomUUID(), version: first.version, stage: 'decision' })
    .expect(409);
  expect(
    (await client.get(`/api/prospects/${next.id}`).set(headers()).expect(200)).body.stage,
  ).toBe('new');
});

it('keeps source intake explicit and rejects unscoped generation before any model work', async () => {
  await client
    .post('/api/prospect-intakes/generate')
    .set(headers())
    .send({ request_id: randomUUID(), source_record_ids: [randomUUID()] })
    .expect(400);
  const all = (await client.get('/api/prospects').set(headers()).expect(200)).body;
  expect(all.total).toBe(3);
  await client
    .post('/api/prospects')
    .set({ ...headers(), origin: 'http://untrusted.invalid' })
    .send({ request_id: randomUUID(), customer_id: customer, name: '不应创建' })
    .expect(403);
});
