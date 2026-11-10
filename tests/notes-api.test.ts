import { afterAll, beforeAll, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { hashPassword, scoped } from '../server/security.js';
import { insert } from '../server/service.js';
import { createPerson } from '../server/people.js';
import type { NoteDetail } from '../shared/notes.js';

const origin = 'http://localhost:3100',
  password = 'notes-http-synthetic-password';
let db: Database,
  admin: Agent,
  viewer: Agent,
  denied: Agent,
  w: string,
  actor: string,
  c: string,
  p: string,
  person: string,
  b: string;
let modelCalls = 0;
const headers = () => ({ origin, 'x-workspace-id': w });
const input = (patch = {}) => ({
  request_id: randomUUID(),
  version: 0,
  note_id: null,
  base_revision: 0,
  title: 'API合成笔记',
  customer_id: c,
  project_id: p,
  person_ids: [person],
  blocks: [
    {
      id: randomUUID(),
      type: 'paragraph',
      text: 'API内部核实：交期仍待确认。',
      origin: 'original',
      sources: [],
    },
  ],
  ...patch,
});
async function publish(patch = {}): Promise<NoteDetail> {
  const d = (
    await admin
      .put(`/api/note-drafts/${randomUUID()}`)
      .set(headers())
      .send(input(patch))
      .expect(200)
  ).body;
  return (
    await admin
      .post('/api/notes/publish')
      .set(headers())
      .send({
        request_id: randomUUID(),
        draft_id: d.id,
        draft_version: d.version,
        base_revision: d.base_revision,
      })
      .expect(200)
  ).body;
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: '笔记HTTP合成',
    email: 'notes-api-admin@example.invalid',
    displayName: '合成管理员',
    password,
  });
  w = seed.workspaceId;
  actor = seed.actorId;
  await scoped(db, actor, w, async (ctx) => {
    c = String(
      (
        await insert(ctx, 'customers', {
          name: '笔记接口公司（合成）',
          type: 'group',
          source: 'other',
        })
      ).id,
    );
    b = String(
      (await insert(ctx, 'customers', { name: '另一公司（合成）', type: 'group', source: 'other' }))
        .id,
    );
    p = String(
      (await insert(ctx, 'projects', { customer_id: c, name: '接口项目（合成）', type: 'sample' }))
        .id,
    );
    person = (await createPerson(ctx, { customer_id: c, name: '接口老师（合成）' })).id;
  });
  const app = createApp(db, {
    origin,
    agent: {
      transport: {
        async generate(value) {
          modelCalls++;
          return {
            answer: '当前原文表示交期仍待确认。',
            source_ids: value.snapshot.sources.map((s) => s.id),
          };
        },
      },
    },
  });
  admin = request.agent(app);
  viewer = request.agent(app);
  denied = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set({ origin })
    .send({ email: 'notes-api-admin@example.invalid', password })
    .expect(200);
  for (const [client, label] of [
    [viewer, 'viewer'],
    [denied, 'denied'],
  ] as const) {
    const id = randomUUID();
    await db.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      id,
      `notes-api-${label}@example.invalid`,
      label,
      await hashPassword(password),
    ]);
    await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
      w,
      id,
    ]);
    if (label === 'viewer')
      await scoped(db, actor, w, (ctx) =>
        ctx.tx.query(
          "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'viewer')",
          [w, c, id],
        ),
      );
    await client
      .post('/api/auth/login')
      .set({ origin })
      .send({ email: `notes-api-${label}@example.invalid`, password })
      .expect(200);
  }
}, 30000);
afterAll(() => db.close());

it('advertises backend capability and keeps draft recovery actor-private', async () => {
  expect((await admin.get('/api/agent/capabilities').set(headers()).expect(200)).body.notes).toBe(
    true,
  );
  const d = (
    await admin.put(`/api/note-drafts/${randomUUID()}`).set(headers()).send(input()).expect(200)
  ).body;
  await viewer.get(`/api/note-drafts/${d.id}`).set(headers()).expect(404);
  expect((await viewer.get('/api/notes?view=drafts').set(headers()).expect(200)).body.total).toBe(
    0,
  );
  await admin
    .delete(`/api/note-drafts/${d.id}`)
    .set(headers())
    .send({ version: d.version })
    .expect(200);
});
it('returns the same publication from all three entity filters with knowledge revision metadata', async () => {
  const note = await publish();
  expect(note.revision_version).toBe(1);
  expect(note.content_hash).toMatch(/^[a-f0-9]{64}$/);
  expect(note.knowledge_versions?.graph?.requested_version).toBeGreaterThan(0);
  for (const query of [
    `customer_id=${c}`,
    `customer_id=${c}&project_id=${p}`,
    `customer_id=${c}&person_id=${person}`,
  ]) {
    const body = (await viewer.get(`/api/notes?${query}`).set(headers()).expect(200)).body;
    expect(
      body.notes.some((n: NoteDetail) => n.id === note.id && n.revision_id === note.revision_id),
    ).toBe(true);
  }
  await denied.get(`/api/notes/${note.id}`).set(headers()).expect(404);
  expect((await denied.get('/api/notes').set(headers()).expect(200)).body.total).toBe(0);
  await viewer.put(`/api/note-drafts/${randomUUID()}`).set(headers()).send(input()).expect(403);
});
it('rejects forged workspace and cross-company associations at the HTTP boundary', async () => {
  await admin
    .put(`/api/note-drafts/${randomUUID()}`)
    .set(headers())
    .send(input({ customer_id: b }))
    .expect(404);
  await admin.get('/api/notes').set({ origin, 'x-workspace-id': randomUUID() }).expect(404);
  await denied.get(`/api/notes/sources?customer_id=${c}`).set(headers()).expect(404);
});
it('replays a publish response without creating another revision and refuses a different payload', async () => {
  const d = (
    await admin.put(`/api/note-drafts/${randomUUID()}`).set(headers()).send(input()).expect(200)
  ).body;
  const payload = {
    request_id: randomUUID(),
    draft_id: d.id,
    draft_version: d.version,
    base_revision: 0,
  };
  const one = (await admin.post('/api/notes/publish').set(headers()).send(payload).expect(200))
    .body;
  const two = (await admin.post('/api/notes/publish').set(headers()).send(payload).expect(200))
    .body;
  expect(two.revision_id).toBe(one.revision_id);
  await admin
    .post('/api/notes/publish')
    .set(headers())
    .send({ ...payload, draft_version: d.version + 1 })
    .expect(409);
  expect(
    (await admin.get(`/api/notes/${one.id}/versions`).set(headers()).expect(200)).body.revisions,
  ).toHaveLength(1);
});
it('registers real Agent draft routes and keeps generated summaries outside published knowledge', async () => {
  const note = await publish();
  const selected = (
    await admin
      .get(`/api/notes/sources?customer_id=${c}&project_id=${p}&person_id=${person}`)
      .set(headers())
      .expect(200)
  ).body.sources;
  expect(selected.some((s: { record_id: string }) => s.record_id === note.record_id)).toBe(true);
  const before = modelCalls;
  const body = {
    request_id: randomUUID(),
    customer_id: c,
    project_id: p,
    person_ids: [person],
    source_record_ids: [note.record_id],
    title: 'AI派生草稿',
  };
  const result = (await admin.post('/api/notes/agent-draft').set(headers()).send(body).expect(200))
    .body;
  expect(result.draft.blocks[0].origin).toBe('derived');
  expect(result.draft.blocks[0].sources[0].record_id).toBe(note.record_id);
  await admin.post('/api/notes/agent-draft').set(headers()).send(body).expect(200);
  expect(modelCalls).toBe(before + 1);
  await viewer.get(`/api/note-drafts/${result.draft.id}`).set(headers()).expect(404);
  await admin
    .post('/api/notes/from-answer')
    .set(headers())
    .send({ request_id: randomUUID(), chat_id: randomUUID(), message_id: randomUUID() })
    .expect(404);
});
it('archives immediately and distinguishes operation tokens from immutable content versions', async () => {
  const note = await publish();
  const archived = (
    await admin
      .post(`/api/notes/${note.id}/archive`)
      .set(headers())
      .send({ version: note.version, request_id: randomUUID() })
      .expect(200)
  ).body;
  expect(archived.version).toBeGreaterThan(note.version);
  expect(archived.revision_version).toBe(1);
  expect(
    (await viewer.get(`/api/notes?customer_id=${c}`).set(headers()).expect(200)).body.notes.some(
      (n: NoteDetail) => n.id === note.id,
    ),
  ).toBe(false);
  const restored = (
    await admin
      .post(`/api/notes/${note.id}/restore`)
      .set(headers())
      .send({ version: archived.version, request_id: randomUUID() })
      .expect(200)
  ).body;
  expect(restored.revision_id).toBe(note.revision_id);
  expect(restored.revision_version).toBe(1);
});
it('isolates personal templates and does not put them into customer records', async () => {
  const template = (
    await admin
      .post('/api/note-templates')
      .set(headers())
      .send({
        name: '内部交接结构',
        blocks: [{ id: randomUUID(), type: 'heading', text: '待确认问题' }],
      })
      .expect(201)
  ).body;
  expect(
    (await admin.get('/api/note-templates').set(headers()).expect(200)).body.templates.some(
      (t: { id: string }) => t.id === template.id,
    ),
  ).toBe(true);
  expect(
    (await viewer.get('/api/note-templates').set(headers()).expect(200)).body.templates,
  ).toHaveLength(0);
});
