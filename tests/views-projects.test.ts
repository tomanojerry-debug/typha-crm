import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import { defaultView, equalViewConfig, type ViewConfig } from '../shared/views.js';

const origin = 'http://localhost:3100';
const password = 'test-only-views-password';
let db: Database;
let admin: Agent, reader: Agent;
let workspaceId: string, actorId: string, readerId: string, otherWorkspace: string;
let customerA: string, customerB: string, projectA: string;
let viewId: string;
const headers = () => ({ origin, 'x-workspace-id': workspaceId });
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  ({ workspaceId, actorId } = await createWorkspace(db, {
    name: 'View tests',
    email: 'views@example.com',
    password,
    displayName: 'Admin',
  }));
  otherWorkspace = (
    await createWorkspace(db, {
      name: 'Other',
      email: 'other-views@example.com',
      password,
      displayName: 'Other',
    })
  ).workspaceId;
  const app = createApp(db, { origin });
  admin = request.agent(app);
  reader = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'views@example.com', password })
    .expect(200);
  readerId = (
    await admin
      .post('/api/members')
      .set(headers())
      .send({ email: 'views-reader@example.com', display_name: 'Reader', password })
      .expect(201)
  ).body.actor_id;
  await reader
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'views-reader@example.com', password })
    .expect(200);
  customerA = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({
        name: 'Alpha',
        type: 'distributor',
        source: 'email',
        region: 'France',
        owner_id: actorId,
      })
      .expect(201)
  ).body.id;
  customerB = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({ name: 'Hidden company', type: 'group', source: 'taobao' })
      .expect(201)
  ).body.id;
  await admin
    .put(`/api/customers/${customerA}/access/${readerId}`)
    .set(headers())
    .send({ access: 'viewer' })
    .expect(200);
  projectA = (
    await admin
      .post(`/api/customers/${customerA}/projects`)
      .set(headers())
      .send({ name: 'Visible project', type: 'sample', due_date: '2026-11-01' })
      .expect(201)
  ).body.id;
  // Thirty-five more rows ensure sorting and counts are tested across pages.
  for (let i = 0; i < 35; i++)
    await admin
      .post(`/api/customers/${customerB}/projects`)
      .set(headers())
      .send({
        name: `Project ${String(i).padStart(2, '0')}`,
        type: 'custom',
        stage: i < 20 ? 'new' : 'in_progress',
        due_date: i === 34 ? null : `2026-12-${String((i % 28) + 1).padStart(2, '0')}`,
      })
      .expect(201);
}, 30000);
afterAll(async () => {
  await db.close();
});

describe('personal views', () => {
  it('stores full configuration without granting data access to another user', async () => {
    const config: ViewConfig = {
      ...defaultView('customers'),
      type: 'distributor',
      owner: 'me',
      sort: 'name',
      direction: 'asc',
      columns: ['name', 'region', 'owner'],
    };
    const created = await admin
      .post('/api/views')
      .set(headers())
      .send({ object: 'customers', name: 'My distributors', config })
      .expect(201);
    viewId = created.body.id;
    expect(created.body.config).toEqual(config);
    expect(equalViewConfig(config, created.body.config)).toBe(true);
    expect(
      equalViewConfig({ ...config, columns: ['name', 'owner', 'region'] }, created.body.config),
    ).toBe(false);
    expect((await admin.get('/api/views').set(headers()).expect(200)).body).toHaveLength(1);
    expect((await reader.get('/api/views').set(headers()).expect(200)).body).toEqual([]);
    await reader
      .patch(`/api/views/${viewId}`)
      .set(headers())
      .send({ object: 'customers', name: 'Hijacked', config, version: 1 })
      .expect(404);
    await reader.delete(`/api/views/${viewId}`).set(headers()).send({ version: 1 }).expect(404);
    await scoped(db, readerId, workspaceId, async ({ tx }) => {
      expect((await tx.query('SELECT * FROM saved_views')).rows).toEqual([]);
    });
    await reader
      .get('/api/views')
      .set({ ...headers(), 'x-workspace-id': otherWorkspace })
      .expect(404);
  });
  it('allows readers to keep personal display preferences and rejects unsupported query configurations', async () => {
    await reader
      .post('/api/views')
      .set(headers())
      .send({ object: 'projects', name: 'My projects', config: defaultView('projects') })
      .expect(201);
    for (const config of [
      { ...defaultView('projects'), columns: ['name', 'email'] },
      { ...defaultView('projects'), columns: ['name', 'name'] },
      { ...defaultView('projects'), status: 'active' },
      { ...defaultView('projects'), sort: 'name; DROP TABLE projects' },
      { ...defaultView('projects'), owner: 'unknown-person' },
    ])
      await reader
        .post('/api/views')
        .set(headers())
        .send({ object: 'projects', name: 'Invalid', config })
        .expect(400);
    await reader
      .post('/api/views')
      .set(headers())
      .send({
        object: 'customers',
        name: 'Bad scope',
        actor_id: actorId,
        config: defaultView('customers'),
      })
      .expect(400);
  });
  it('requires a current version and prevents changing a saved view object', async () => {
    const input = {
      object: 'customers',
      name: 'Renamed',
      config: defaultView('customers'),
      version: 1,
    };
    const updated = await admin
      .patch(`/api/views/${viewId}`)
      .set(headers())
      .send(input)
      .expect(200);
    expect(updated.body.version).toBe(2);
    await admin.patch(`/api/views/${viewId}`).set(headers()).send(input).expect(409);
    await admin
      .patch(`/api/views/${viewId}`)
      .set(headers())
      .send({ ...input, object: 'projects', config: defaultView('projects'), version: 2 })
      .expect(400);
    await admin.delete(`/api/views/${viewId}`).set(headers()).send({ version: 1 }).expect(409);
    await admin.delete(`/api/views/${viewId}`).set(headers()).send({ version: 2 }).expect(200);
    expect((await admin.get('/api/customers').set(headers()).expect(200)).body.total).toBe(2);
  });
});

describe('authorized customer and project browsing', () => {
  it('combines customer filters and applies permissions to writable choices', async () => {
    const list = await admin
      .get(
        '/api/customers?type=distributor&owner=me&region=france&source=email&sort=name&direction=asc',
      )
      .set(headers())
      .expect(200);
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([customerA]);
    expect(
      (await reader.get('/api/customers?editable=true').set(headers()).expect(200)).body.total,
    ).toBe(0);
    await admin.get('/api/customers?sort=unknown').set(headers()).expect(400);
  });
  it('uses full-result sorting and counts before pagination', async () => {
    const first = await admin
      .get('/api/projects?sort=name&direction=asc')
      .set(headers())
      .expect(200);
    const second = await admin
      .get('/api/projects?sort=name&direction=asc&page=2')
      .set(headers())
      .expect(200);
    expect(first.body.items).toHaveLength(30);
    expect(second.body.items).toHaveLength(6);
    expect(first.body.total).toBe(36);
    expect(first.body.groups).toEqual({ new: 21, in_progress: 15 });
    expect(first.body.items[0].name).toBe('Project 00');
    expect(second.body.items[5].name).toBe('Visible project');
    const filtered = await admin
      .get('/api/projects?stage=in_progress&type=custom&q=Project')
      .set(headers())
      .expect(200);
    expect(filtered.body.total).toBe(15);
    expect(filtered.body.groups).toEqual({ in_progress: 15 });
    const dates = await admin
      .get('/api/projects?sort=due_date&direction=asc&page=2')
      .set(headers())
      .expect(200);
    expect(dates.body.items.at(-1).due_date).toBeNull();
  });
  it('does not expose hidden project names, counts or search matches', async () => {
    const visible = await reader.get('/api/projects').set(headers()).expect(200);
    expect(visible.body.total).toBe(1);
    expect(visible.body.groups).toEqual({ new: 1 });
    expect(visible.body.items[0].id).toBe(projectA);
    expect(visible.body.items[0].can_edit).toBe(false);
    expect((await reader.get('/api/projects?q=Hidden').set(headers()).expect(200)).body.total).toBe(
      0,
    );
    await reader
      .patch(`/api/customers/${customerA}/projects/${projectA}`)
      .set(headers())
      .send({ version: 1, stage: 'completed' })
      .expect(403);
  });
  it('treats archived customers’ projects as read-only archive results', async () => {
    await admin
      .patch(`/api/customers/${customerA}`)
      .set(headers())
      .send({ version: 1, archived: true })
      .expect(200);
    expect((await reader.get('/api/projects').set(headers()).expect(200)).body.total).toBe(0);
    const archived = await reader.get('/api/projects?archived=true').set(headers()).expect(200);
    expect(archived.body.items[0].can_edit).toBe(false);
    expect(archived.body.items[0].customer_archived_at).toBeTruthy();
    await admin
      .patch(`/api/customers/${customerA}`)
      .set(headers())
      .send({ version: 2, archived: false })
      .expect(200);
  });
  it('rechecks permissions after revocation even when a personal view still exists', async () => {
    expect((await reader.get('/api/views').set(headers()).expect(200)).body).toHaveLength(1);
    await admin
      .put(`/api/customers/${customerA}/access/${readerId}`)
      .set(headers())
      .send({ access: null })
      .expect(200);
    const result = await reader.get('/api/projects').set(headers()).expect(200);
    expect(result.body.items).toEqual([]);
    expect(result.body.total).toBe(0);
    expect(result.body.groups).toEqual({});
    await reader.get(`/api/customers/${customerA}`).set(headers()).expect(404);
    await admin
      .patch(`/api/members/${readerId}`)
      .set(headers())
      .send({ active: false })
      .expect(200);
    await reader.get('/api/views').set(headers()).expect(404);
  });
});
