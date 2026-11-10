import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import { defaultView, equalViewConfig, customerSorts, projectSorts } from '../shared/views.js';
import { activityItems } from '../shared/activity.js';
import type { AuditEvent, CustomerRecord } from '../shared/domain.js';
const origin = 'http://localhost:3100',
  password = 'test-lists-password';
let db: Database,
  admin: Agent,
  reader: Agent,
  w: string,
  actor: string,
  readerId: string,
  a: string,
  b: string,
  project: string,
  listId: string;
const headers = () => ({ origin, 'x-workspace-id': w });
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const setup = await createWorkspace(db, {
    name: 'Lists',
    email: 'lists@example.com',
    password,
    displayName: 'Admin',
  });
  w = setup.workspaceId;
  actor = setup.actorId;
  const app = createApp(db, { origin });
  admin = request.agent(app);
  reader = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'lists@example.com', password })
    .expect(200);
  readerId = (
    await admin
      .post('/api/members')
      .set(headers())
      .send({ email: 'list-reader@example.com', display_name: 'Reader', password })
      .expect(201)
  ).body.actor_id;
  await reader
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'list-reader@example.com', password })
    .expect(200);
  a = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({
        name: 'Alpha studio',
        type: 'group',
        source: 'email',
        region: 'Shanghai',
        owner_id: actor,
      })
      .expect(201)
  ).body.id;
  b = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({ name: 'Beta', type: 'distributor', source: 'referral', region: 'Paris' })
      .expect(201)
  ).body.id;
  project = (
    await admin
      .post(`/api/customers/${a}/projects`)
      .set(headers())
      .send({ name: 'Sample', type: 'sample', due_date: '2026-12-01' })
      .expect(201)
  ).body.id;
  await admin
    .put(`/api/customers/${a}/access/${readerId}`)
    .set(headers())
    .send({ access: 'viewer' })
    .expect(200);
}, 30000);
afterAll(async () => {
  await db.close();
});

describe('record lists and views', () => {
  it('manually groups existing records idempotently without changing the global records', async () => {
    listId = (
      await admin
        .post('/api/lists')
        .set(headers())
        .send({ name: '重点跟进', object: 'customers' })
        .expect(201)
    ).body.id;
    for (let i = 0; i < 2; i++)
      await admin
        .post(`/api/lists/${listId}/entries`)
        .set(headers())
        .send({ entries: [{ customer_id: a }] })
        .expect(200);
    const list = (
      await admin.get('/api/customers').query({ list_id: listId }).set(headers()).expect(200)
    ).body;
    expect(list.items.map((r: { id: string }) => r.id)).toEqual([a]);
    expect(list.total).toBe(1);
    expect((await admin.get('/api/lists').set(headers()).expect(200)).body[0].count).toBe(1);
    expect((await admin.get('/api/customers').set(headers()).expect(200)).body.total).toBe(2);
    await admin
      .delete(`/api/lists/${listId}/entries`)
      .set(headers())
      .send({ entries: [{ customer_id: a }] })
      .expect(200);
    expect(
      (await admin.get('/api/customers').query({ list_id: listId }).set(headers()).expect(200)).body
        .total,
    ).toBe(0);
    await admin.get(`/api/customers/${a}`).set(headers()).expect(200);
  });
  it('creates a list and initial membership atomically', async () => {
    const before = (await reader.get('/api/lists').set(headers()).expect(200)).body.length;
    await reader
      .post('/api/lists')
      .set(headers())
      .send({
        name: '应回滚',
        object: 'customers',
        entries: [{ customer_id: a }, { customer_id: b }],
      })
      .expect(404);
    expect((await reader.get('/api/lists').set(headers()).expect(200)).body.length).toBe(before);
  });
  it('keeps lists private and cannot use list membership to grant customer access', async () => {
    expect((await reader.get('/api/lists').set(headers()).expect(200)).body).toEqual([]);
    await reader.get('/api/customers').query({ list_id: listId }).set(headers()).expect(404);
    const own = (
      await reader
        .post('/api/lists')
        .set(headers())
        .send({ name: '我的清单', object: 'customers' })
        .expect(201)
    ).body.id;
    await reader
      .post(`/api/lists/${own}/entries`)
      .set(headers())
      .send({ entries: [{ customer_id: a }, { customer_id: b }] })
      .expect(404);
    expect(
      (await reader.get('/api/customers').query({ list_id: own }).set(headers()).expect(200)).body
        .total,
    ).toBe(0);
    await reader
      .post(`/api/lists/${own}/entries`)
      .set(headers())
      .send({ entries: [{ customer_id: a }] })
      .expect(200);
    await expect(
      scoped(db, readerId, w, (ctx) =>
        ctx.tx.query(
          'INSERT INTO list_entries(workspace_id,actor_id,list_id,object,customer_id) VALUES($1,$2,$3,$4,$5)',
          [w, readerId, own, 'customers', b],
        ),
      ),
    ).rejects.toThrow();
    await admin
      .put(`/api/customers/${a}/access/${readerId}`)
      .set(headers())
      .send({ access: null })
      .expect(200);
    expect(
      (await reader.get('/api/customers').query({ list_id: own }).set(headers()).expect(200)).body
        .total,
    ).toBe(0);
    expect((await reader.get('/api/lists').set(headers()).expect(200)).body[0].count).toBe(0);
    await admin
      .put(`/api/customers/${a}/access/${readerId}`)
      .set(headers())
      .send({ access: 'viewer' })
      .expect(200);
  });
  it('enforces object and composite project ownership, including at database level', async () => {
    const id = (
      await admin
        .post('/api/lists')
        .set(headers())
        .send({ name: '项目清单', object: 'projects' })
        .expect(201)
    ).body.id;
    await admin
      .post(`/api/lists/${id}/entries`)
      .set(headers())
      .send({ entries: [{ customer_id: b, project_id: project }] })
      .expect(404);
    await admin
      .post(`/api/lists/${id}/entries`)
      .set(headers())
      .send({ entries: [{ customer_id: a }] })
      .expect(400);
    await expect(
      scoped(db, actor, w, (ctx) =>
        ctx.tx.query(
          'INSERT INTO list_entries(workspace_id,actor_id,list_id,object,customer_id,project_id) VALUES($1,$2,$3,$4,$5,$6)',
          [w, actor, id, 'projects', b, project],
        ),
      ),
    ).rejects.toThrow();
    await admin
      .post(`/api/lists/${id}/entries`)
      .set(headers())
      .send({ entries: [{ customer_id: a, project_id: project }] })
      .expect(200);
    expect(
      (await admin.get('/api/projects').query({ list_id: id }).set(headers()).expect(200)).body
        .total,
    ).toBe(1);
    await admin.get('/api/customers').query({ list_id: id }).set(headers()).expect(400);
    await admin.get('/api/projects').query({ list_id: randomUUID() }).set(headers()).expect(404);
  });
  it('saves multiple independently configured views within a list and locks their scope', async () => {
    const config = {
      ...defaultView('customers'),
      columns: ['name', 'region'],
      filters: {
        match: 'any',
        rules: [
          { field: 'region', operator: 'contains', value: 'Paris' },
          { field: 'type', operator: 'is', value: 'group' },
        ],
      },
    };
    const view = (
      await admin
        .post('/api/views')
        .set(headers())
        .send({ name: '自定义视图', object: 'customers', list_id: listId, config })
        .expect(201)
    ).body;
    expect(view.list_id).toBe(listId);
    expect(view.config).toEqual(config);
    await admin
      .patch(`/api/views/${view.id}`)
      .set(headers())
      .send({ name: '移出清单', object: 'customers', list_id: null, config, version: view.version })
      .expect(400);
    await reader
      .post('/api/views')
      .set(headers())
      .send({ name: '不应创建', object: 'customers', list_id: listId, config })
      .expect(404);
    await admin
      .patch(`/api/lists/${listId}`)
      .set(headers())
      .send({ name: '重命名', version: 1 })
      .expect(200);
    await admin
      .patch(`/api/lists/${listId}`)
      .set(headers())
      .send({ name: '过期写入', version: 1 })
      .expect(409);
  });
});
describe('attribute filters', () => {
  it('combines AND/OR on the server, with owner, empty and date conditions', async () => {
    await admin
      .post(`/api/customers/${a}/projects`)
      .set(headers())
      .send({ name: 'No date', type: 'inquiry' })
      .expect(201);
    const run = async (object: string, filters: unknown, agent = admin) =>
      (
        await agent
          .get(`/api/${object}`)
          .query({ filters: JSON.stringify(filters) })
          .set(headers())
          .expect(200)
      ).body;
    expect(
      (
        await run('customers', {
          match: 'all',
          rules: [
            { field: 'name', operator: 'contains', value: 'alpha' },
            { field: 'region', operator: 'is', value: 'Shanghai' },
          ],
        })
      ).items[0].id,
    ).toBe(a);
    expect(
      (
        await run('customers', {
          match: 'any',
          rules: [
            { field: 'type', operator: 'is', value: 'group' },
            { field: 'region', operator: 'is', value: 'Paris' },
          ],
        })
      ).total,
    ).toBe(2);
    expect(
      (
        await run(
          'customers',
          {
            match: 'any',
            rules: [
              { field: 'type', operator: 'is', value: 'group' },
              { field: 'region', operator: 'is', value: 'Paris' },
            ],
          },
          reader,
        )
      ).total,
    ).toBe(1);
    expect(
      (
        await run('customers', {
          match: 'all',
          rules: [{ field: 'owner', operator: 'is', value: 'me' }],
        })
      ).items[0].id,
    ).toBe(a);
    expect(
      (
        await run('customers', {
          match: 'all',
          rules: [{ field: 'owner', operator: 'empty', value: '' }],
        })
      ).items[0].id,
    ).toBe(b);
    expect(
      (
        await run('projects', {
          match: 'all',
          rules: [{ field: 'due_date', operator: 'before', value: '2026-12-02' }],
        })
      ).total,
    ).toBe(1);
  });
  it('sorts every available column using a server allowlist', async () => {
    for (const sort of Object.keys(customerSorts))
      await admin
        .get('/api/customers')
        .query({ sort, direction: 'asc' })
        .set(headers())
        .expect(200);
    for (const sort of Object.keys(projectSorts))
      await admin.get('/api/projects').query({ sort, direction: 'asc' }).set(headers()).expect(200);
  });
  it('rejects unsupported fields/operators and does not interpret input as SQL', async () => {
    for (const rule of [
      { field: 'name); DROP TABLE customers;', operator: 'is', value: 'x' },
      { field: 'constructor', operator: 'is', value: 'x' },
      { field: 'type', operator: 'is', value: 'unknown' },
      { field: 'owner', operator: 'contains', value: 'x' },
      { field: 'updated_at', operator: 'before', value: 'not-a-date' },
    ])
      await admin
        .get('/api/customers')
        .query({ filters: JSON.stringify({ match: 'all', rules: [rule] }) })
        .set(headers())
        .expect(400);
    const result = await admin
      .get('/api/customers')
      .query({
        filters: JSON.stringify({
          match: 'all',
          rules: [{ field: 'name', operator: 'contains', value: "' OR 1=1 --" }],
        }),
      })
      .set(headers())
      .expect(200);
    expect(result.body.total).toBe(0);
  });
});
it('keeps project activity separate and deduplicates record insert events', () => {
  const records = [
    { id: 'r1', project_id: 'p1', created_at: '2026-10-01' },
    { id: 'r2', project_id: 'p2', created_at: '2026-10-02' },
    { id: 'r3', project_id: null, created_at: '2026-10-03' },
  ] as CustomerRecord[];
  const events = [
    {
      id: 'e1',
      entity_type: 'customer_records',
      entity_id: 'r1',
      action: 'insert',
      created_at: '2026-10-01',
    },
    {
      id: 'e2',
      entity_type: 'projects',
      entity_id: 'p1',
      action: 'update',
      created_at: '2026-10-04',
    },
    {
      id: 'e3',
      entity_type: 'projects',
      entity_id: 'p2',
      action: 'update',
      created_at: '2026-10-05',
    },
  ] as AuditEvent[];
  expect(activityItems(records, events, 'p1').map((i) => i.id)).toEqual(['event-e2', 'record-r1']);
  expect(activityItems(records, events).length).toBe(5);
});
it('compares nested JSONB filter keys without losing condition order', () => {
  const config = {
    ...defaultView('customers'),
    filters: {
      match: 'all' as const,
      rules: [{ field: 'name', operator: 'contains' as const, value: 'A' }],
    },
  };
  const other = {
    ...config,
    filters: {
      rules: [{ value: 'A', operator: 'contains' as const, field: 'name' }],
      match: 'all' as const,
    },
  };
  expect(equalViewConfig(config, other)).toBe(true);
});
