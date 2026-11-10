import { beforeAll, afterAll, it, expect } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { createApp } from '../server/app.js';
import { scoped } from '../server/security.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as custom from '../server/custom-objects.js';
import { insert } from '../server/service.js';

let db: Database,
  admin: Agent,
  viewer: Agent,
  editor: Agent,
  w: string,
  a: string,
  b: string,
  p: string,
  foreignProject: string,
  objectId: string,
  fieldId: string,
  memberId: string,
  recordId: string;
const origin = 'http://localhost:3100',
  password = 'custom-fixture-password';
const h = () => ({ origin, 'x-workspace-id': w });
let objectVersion = 1;
const path = () => `/api/custom-objects/${objectId}`;
const objectBody = {
  name: '发票',
  singular_name: '发票',
  slug: 'invoices',
  icon: 'receipt',
  color: 'red',
};
async function version() {
  return (await admin.get('/api/custom-objects').set(h())).body.find(
    (o: { id: string }) => o.id === objectId,
  ).version;
}
async function body(extra: Record<string, unknown> = {}) {
  return {
    name: 'Invoice fixture',
    customer_id: a,
    project_id: p,
    values: { [fieldId]: 'INV-001' },
    object_version: objectVersion,
    ...extra,
  };
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Custom fixture',
    email: 'custom-admin@example.invalid',
    password,
    displayName: 'Admin',
  });
  w = seed.workspaceId;
  adminActor = seed.actorId;
  const app = createApp(db, { origin });
  admin = request.agent(app);
  viewer = request.agent(app);
  editor = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'custom-admin@example.invalid', password })
    .expect(200);
  for (const [agent, email] of [
    [viewer, 'custom-viewer@example.invalid'],
    [editor, 'custom-editor@example.invalid'],
  ] as const) {
    const m = (
      await admin
        .post('/api/members')
        .set(h())
        .send({ email, display_name: email, password })
        .expect(201)
    ).body;
    if (agent === editor) memberId = m.actor_id;
    await agent.post('/api/auth/login').set('origin', origin).send({ email, password }).expect(200);
  }
  a = (
    await admin
      .post('/api/customers')
      .set(h())
      .send({ name: 'A', type: 'group', source: 'other' })
      .expect(201)
  ).body.id;
  b = (
    await admin
      .post('/api/customers')
      .set(h())
      .send({ name: 'B private', type: 'group', source: 'other' })
      .expect(201)
  ).body.id;
  p = (
    await admin
      .post(`/api/customers/${a}/projects`)
      .set(h())
      .send({ name: 'A Project', type: 'sample' })
      .expect(201)
  ).body.id;
  foreignProject = (
    await admin
      .post(`/api/customers/${b}/projects`)
      .set(h())
      .send({ name: 'B Project', type: 'sample' })
      .expect(201)
  ).body.id;
  for (const m of (await admin.get('/api/members').set(h())).body.filter(
    (m: { role: string }) => m.role !== 'admin',
  ))
    await admin
      .put(`/api/customers/${a}/access/${m.actor_id}`)
      .set(h())
      .send({ access: m.actor_id === memberId ? 'editor' : 'viewer' })
      .expect(200);
}, 30000);
afterAll(() => db.close());
it('creates a persistent object with immutable unique slug and admin-only configuration', async () => {
  await viewer.post('/api/custom-objects').set(h()).send(objectBody).expect(403);
  const obj = (await admin.post('/api/custom-objects').set(h()).send(objectBody).expect(201)).body;
  objectId = obj.id;
  expect(obj).toMatchObject({ ...objectBody, record_count: 0, attribute_count: 6 });
  await admin.post('/api/custom-objects').set(h()).send(objectBody).expect(409);
  await admin
    .post('/api/custom-objects')
    .set(h())
    .send({ ...objectBody, name: 'Other', slug: 'people' })
    .expect(409);
  await admin
    .post('/api/custom-objects')
    .set(h())
    .send({ ...objectBody, name: 'Other', slug: 'Bad Slug' })
    .expect(400);
  await scoped(db, seedActor(), w, async (ctx) => {
    await expect(
      ctx.tx.query('UPDATE custom_objects SET slug=$1 WHERE workspace_id=$2 AND id=$3', [
        'renamed',
        w,
        objectId,
      ]),
    ).rejects.toThrow();
  });
});
let adminActor = '';
function seedActor() {
  return adminActor;
}
// Read identity through the authenticated endpoint, never a client supplied actor.
it('loads server identity and creates required unique text attribute', async () => {
  const f = (
    await admin
      .post(`${path()}/attributes`)
      .set(h())
      .send({ name: '发票号', kind: 'text', required: true, is_unique: true })
      .expect(201)
  ).body;
  fieldId = f.id;
  await editor
    .post(`${path()}/attributes`)
    .set(h())
    .send({ name: 'Bad', kind: 'text' })
    .expect(403);
  await admin
    .post(`${path()}/attributes`)
    .set(h())
    .send({ name: '发票号', kind: 'text' })
    .expect(409);
  await admin
    .post(`${path()}/attributes`)
    .set(h())
    .send({ name: 'Bad options', kind: 'select', options: ['A', 'a'] })
    .expect(400);
  objectVersion = await version();
});
it('validates required values, dates, unique values and does not confuse false or zero with missing', async () => {
  await admin
    .post(`${path()}/records`)
    .set(h())
    .send(await body({ values: {} }))
    .expect(400);
  const kinds = [
    { name: '金额', kind: 'currency', currency: 'USD' },
    { name: '到期日', kind: 'date' },
    { name: '已审核', kind: 'checkbox' },
    { name: '评级', kind: 'rating' },
    { name: '分类', kind: 'select', options: ['A', 'B'] },
  ];
  const fields = [];
  for (const f of kinds)
    fields.push((await admin.post(`${path()}/attributes`).set(h()).send(f).expect(201)).body);
  objectVersion = await version();
  const values = {
    [fieldId]: 'INV-001',
    [fields[0].id]: 0,
    [fields[1].id]: '2026-10-23',
    [fields[2].id]: false,
    [fields[3].id]: 4,
    [fields[4].id]: 'A',
  };
  await admin
    .post(`${path()}/records`)
    .set(h())
    .send(await body({ values: { ...values, [fields[1].id]: '2026-02-30' } }))
    .expect(400);
  const r = (
    await editor
      .post(`${path()}/records`)
      .set(h())
      .send(await body({ values }))
      .expect(201)
  ).body;
  recordId = r.id;
  expect(r.values).toMatchObject(values);
  await admin
    .post(`${path()}/records`)
    .set(h())
    .send(await body({ customer_id: b, project_id: null, values }))
    .expect(409);
  await viewer
    .post(`${path()}/records`)
    .set(h())
    .send(await body({ values: { [fieldId]: 'INV-002' } }))
    .expect(403);
});
it('enforces customer and workspace isolation, including counts, options and direct IDs', async () => {
  await admin
    .post(`${path()}/records`)
    .set(h())
    .send(await body({ customer_id: b, project_id: null, values: { [fieldId]: 'PRIVATE-B' } }))
    .expect(201);
  const rows = (await viewer.get(`${path()}/records`).set(h()).expect(200)).body;
  expect(rows.total).toBe(1);
  expect(JSON.stringify(rows)).not.toContain('PRIVATE-B');
  expect((await viewer.get('/api/custom-objects').set(h())).body[0].record_count).toBe(1);
  const options = (await viewer.get(`${path()}/record-options`).set(h()).expect(200)).body;
  expect(options.customers.map((c: { id: string }) => c.id)).toEqual([a]);
  await viewer.get(`${path()}/record-options?customer_id=${b}`).set(h()).expect(404);
  await viewer
    .get(path() + '/records/' + randomUUID())
    .set(h())
    .expect(404);
  await viewer
    .get('/api/custom-objects')
    .set({ ...h(), 'x-workspace-id': randomUUID() })
    .expect(404);
});
it('rejects foreign projects, immutable company, stale schema and stale record versions', async () => {
  await admin
    .post(`${path()}/records`)
    .set(h())
    .send(await body({ project_id: foreignProject, values: { [fieldId]: 'INV-003' } }))
    .expect(404);
  const r = (await admin.get(`${path()}/records/${recordId}`).set(h()).expect(200)).body;
  await admin
    .put(`${path()}/records/${recordId}`)
    .set(h())
    .send({ ...(await body()), version: r.version, customer_id: b, project_id: null })
    .expect(400);
  await admin
    .put(`${path()}/records/${recordId}`)
    .set(h())
    .send({ ...(await body()), version: r.version, object_version: 1 })
    .expect(409);
  const next = await body({ version: r.version, project_id: null, name: 'Edited' });
  const saved = (await editor.put(`${path()}/records/${recordId}`).set(h()).send(next).expect(200))
    .body;
  expect(saved.project_id).toBeNull();
  await editor.put(`${path()}/records/${recordId}`).set(h()).send(next).expect(409);
});
it('archives and restores fields preserving historical data and rejects stale field version', async () => {
  const f = (await admin.get(`${path()}/attributes`).set(h())).body.find(
    (f: { id: string }) => f.id === fieldId,
  );
  const update = {
    name: f.name,
    kind: f.kind,
    required: f.required,
    is_unique: f.is_unique,
    currency: f.currency,
    options: f.options,
    archived: true,
    version: f.version,
  };
  const archived = (
    await admin.put(`${path()}/attributes/${fieldId}`).set(h()).send(update).expect(200)
  ).body;
  await admin.put(`${path()}/attributes/${fieldId}`).set(h()).send(update).expect(409);
  objectVersion = await version();
  const r = (await admin.get(`${path()}/records/${recordId}`).set(h())).body;
  await editor
    .put(`${path()}/records/${recordId}`)
    .set(h())
    .send(await body({ version: r.version, values: {}, project_id: null }))
    .expect(200);
  expect((await admin.get(`${path()}/records/${recordId}`).set(h())).body.values[fieldId]).toBe(
    'INV-001',
  );
  await admin
    .put(`${path()}/attributes/${fieldId}`)
    .set(h())
    .send({ ...update, archived: false, version: archived.version })
    .expect(200);
});
it('revocation takes effect immediately and database constraints prevent cross-customer project writes', async () => {
  await admin
    .put(`/api/customers/${a}/access/${memberId}`)
    .set(h())
    .send({ access: null })
    .expect(200);
  await editor.get(`${path()}/records/${recordId}`).set(h()).expect(404);
  expect((await editor.get(`${path()}/records`).set(h())).body.total).toBe(0);
  await expect(
    scoped(db, adminActor, w, (ctx) =>
      ctx.tx.query(
        'UPDATE custom_object_records SET project_id=$1 WHERE workspace_id=$2 AND object_id=$3 AND id=$4',
        [foreignProject, w, objectId, recordId],
      ),
    ),
  ).rejects.toThrow();
  await expect(
    scoped(db, adminActor, w, (ctx) =>
      ctx.tx.query('UPDATE custom_objects SET slug=$1 WHERE workspace_id=$2 AND id=$3', [
        'changed',
        w,
        objectId,
      ]),
    ),
  ).rejects.toThrow();
});

it('retains definitions and values after closing and reopening a persistent database', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'light-crm-custom-'));
  let store: Database | undefined;
  try {
    store = await openDatabase({ dataDir: join(folder, 'db') });
    await migrate(store);
    const seed = await createWorkspace(store, {
      name: 'Persistent fixture',
      email: 'persistent@example.invalid',
      password,
      displayName: 'Fixture',
    });
    const created = await scoped(store, seed.actorId, seed.workspaceId, async (ctx) => {
      const c = await insert(ctx, 'customers', {
        name: 'Fixture A',
        type: 'group',
        source: 'other',
      });
      const o = await custom.createObject(ctx, objectBody);
      const f = await custom.saveField(ctx, o.id, null, {
        name: '编号',
        kind: 'text',
        is_unique: true,
      });
      const updated = await custom.object(ctx, o.id);
      const r = await custom.saveRecord(ctx, o.id, null, {
        name: 'Persisted invoice',
        customer_id: c.id,
        object_version: updated.version,
        values: { [f.id]: '00001' },
      });
      return { o, f, r };
    });
    await store.close();
    store = undefined;
    store = await openDatabase({ dataDir: join(folder, 'db') });
    await migrate(store);
    await scoped(store, seed.actorId, seed.workspaceId, async (ctx) => {
      expect((await custom.objects(ctx))[0]).toMatchObject({
        slug: 'invoices',
        record_count: 1,
        attribute_count: 7,
      });
      expect((await custom.record(ctx, created.o.id, created.r.id)).values[created.f.id]).toBe(
        '00001',
      );
    });
  } finally {
    await store?.close();
    await rm(folder, { recursive: true, force: true });
  }
}, 30000);
