import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import { requireLocalRequest, validateLocalAccess } from '../server/local-access.js';
import type { Request } from 'express';

const origin = 'http://localhost:3100';
const password = 'test-only-password-9381';
let db: Database, app: ReturnType<typeof createApp>;
let admin: Agent, editor: Agent, viewer: Agent, outsider: Agent;
let space: { workspaceId: string; actorId: string }, foreign: typeof space;
let customerA: string,
  customerB: string,
  foreignCustomer: string,
  projectA: string,
  projectB: string;
let editorId: string, viewerId: string;
const headers = () => ({ origin, 'x-workspace-id': space.workspaceId });

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  // Applying migrations twice must be safe.
  await migrate(db);
  space = await createWorkspace(db, {
    name: 'Workspace A',
    email: 'admin-a@example.com',
    displayName: 'Admin A',
    password,
  });
  foreign = await createWorkspace(db, {
    name: 'Workspace B',
    email: 'admin-b@example.com',
    displayName: 'Admin B',
    password,
  });
  app = createApp(db, { origin });
  admin = request.agent(app);
  editor = request.agent(app);
  viewer = request.agent(app);
  outsider = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'admin-a@example.com', password })
    .expect(200);
  await outsider
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'admin-b@example.com', password })
    .expect(200);
  const e = await admin
    .post('/api/members')
    .set(headers())
    .send({ email: 'editor@example.com', display_name: 'Editor', password })
    .expect(201);
  const v = await admin
    .post('/api/members')
    .set(headers())
    .send({ email: 'viewer@example.com', display_name: 'Viewer', password })
    .expect(201);
  editorId = e.body.actor_id;
  viewerId = v.body.actor_id;
  await editor
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'editor@example.com', password })
    .expect(200);
  await viewer
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'viewer@example.com', password })
    .expect(200);
  customerA = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({ name: 'Customer A', type: 'distributor', source: 'email' })
      .expect(201)
  ).body.id;
  customerB = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({ name: 'Customer B', type: 'group', source: 'taobao' })
      .expect(201)
  ).body.id;
  foreignCustomer = (
    await outsider
      .post('/api/customers')
      .set({ origin, 'x-workspace-id': foreign.workspaceId })
      .send({ name: 'Foreign confidential', type: 'retail', source: 'store' })
      .expect(201)
  ).body.id;
  projectA = (
    await admin
      .post(`/api/customers/${customerA}/projects`)
      .set(headers())
      .send({ name: 'Project A', type: 'sample' })
      .expect(201)
  ).body.id;
  projectB = (
    await admin
      .post(`/api/customers/${customerB}/projects`)
      .set(headers())
      .send({ name: 'Project B', type: 'custom' })
      .expect(201)
  ).body.id;
  await admin
    .put(`/api/customers/${customerA}/access/${editorId}`)
    .set(headers())
    .send({ access: 'editor' })
    .expect(200);
  await admin
    .put(`/api/customers/${customerA}/access/${viewerId}`)
    .set(headers())
    .send({ access: 'viewer' })
    .expect(200);
}, 30000);
afterAll(async () => {
  await db?.close();
});

describe('server-derived identity and workspace boundary', () => {
  it('requires a real session and validates workspace membership', async () => {
    await request(app).get('/api/customers').set(headers()).expect(401);
    await editor.get('/api/customers').set('x-workspace-id', foreign.workspaceId).expect(404);
    await admin.get('/api/customers').expect(400);
    await admin.get('/api/customers').set('x-workspace-id', 'invalid').expect(400);
  });
  it('does not trust actor headers or unknown scope fields', async () => {
    await editor
      .get(`/api/customers/${customerB}`)
      .set(headers())
      .set('x-actor-id', space.actorId)
      .expect(404);
    await admin
      .post('/api/customers')
      .set(headers())
      .send({ name: 'Bad', type: 'retail', source: 'store', workspace_id: foreign.workspaceId })
      .expect(400);
    await editor
      .post(`/api/customers/${customerA}/records`)
      .set(headers())
      .send({ body: 'Bad actor', kind: 'inference', created_by: space.actorId })
      .expect(400);
  });
  it('rejects cross-origin writes, including login', async () => {
    await admin
      .post('/api/customers')
      .set({ origin: 'https://evil.example', 'x-workspace-id': space.workspaceId })
      .send({})
      .expect(403);
    await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin-a@example.com', password })
      .expect(403);
  });
  it('returns only authorized rows, counts and search results', async () => {
    const list = await editor.get('/api/customers').set(headers()).expect(200);
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([customerA]);
    expect(list.body.total).toBe(1);
    expect(list.body.summary.customers).toBe(1);
    expect(list.body.summary.open_projects).toBe(1);
    const search = await editor.get('/api/customers?q=Customer%20B').set(headers()).expect(200);
    expect(search.body.total).toBe(0);
    await admin.get(`/api/customers/${foreignCustomer}`).set(headers()).expect(404);
    const members = await editor.get('/api/members').set(headers()).expect(200);
    expect(JSON.stringify(members.body)).not.toContain('password');
    expect(JSON.stringify(members.body)).not.toContain('admin-b');
  });
});
describe('explicit local workspace access', () => {
  const localOrigin = 'http://127.0.0.1:3100';
  const localHost = '127.0.0.1:3100';
  const localApp = () =>
    createApp(db, { origin: localOrigin, development: true, localActorId: viewerId });

  it('opens without cookies using only the configured actor', async () => {
    const response = await request(localApp())
      .get('/api/session')
      .set('host', localHost)
      .set('x-actor-id', space.actorId)
      .expect(200);
    expect(response.body.auth_mode).toBe('local');
    expect(response.body.actor.id).toBe(viewerId);
    expect(response.body.workspaces.map((w: { id: string }) => w.id)).toEqual([space.workspaceId]);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('preserves customer permissions, read-only access and workspace isolation', async () => {
    const local = request(localApp());
    const h = { host: localHost, origin: localOrigin, 'x-workspace-id': space.workspaceId };
    const response = await local.get('/api/customers').set(h).expect(200);
    expect(response.body.items.map((c: { id: string }) => c.id)).toEqual([customerA]);
    await local.get(`/api/customers/${customerB}`).set(h).expect(404);
    await local
      .get('/api/customers')
      .set({ ...h, 'x-workspace-id': foreign.workspaceId })
      .expect(404);
    await local
      .patch(`/api/customers/${customerA}`)
      .set(h)
      .send({ version: 1, name: 'Must remain read-only' })
      .expect(403);
  });

  it('blocks foreign hosts and cross-origin reads as well as writes', async () => {
    const local = request(localApp());
    await local.get('/api/session').set('host', 'foreign.example:3100').expect(403);
    await local
      .get('/api/session')
      .set({ host: localHost, origin: 'https://foreign.example' })
      .expect(403);
    await local
      .get('/api/session')
      .set({ host: localHost, 'sec-fetch-site': 'cross-site' })
      .expect(403);
    await local.post('/api/customers').set('host', localHost).send({}).expect(403);
    const remote = {
      socket: { remoteAddress: '192.168.1.20' },
      get: (key: string) => (key === 'host' ? localHost : undefined),
    } as Request;
    expect(() => requireLocalRequest(remote, localOrigin)).toThrow('本机同源访问');
  });

  it('cannot enable local access in production, on public hosts or external databases', () => {
    const valid = { development: true, origin: localOrigin, host: '127.0.0.1' };
    for (const override of [
      { development: false },
      { secureCookies: true },
      { host: '0.0.0.0' },
      { origin: 'http://foreign.example:3100' },
      { databaseUrl: 'postgresql://localhost/crm' },
    ]) {
      expect(() => validateLocalAccess({ ...valid, ...override })).toThrow('本地直接访问');
    }
    expect(() => createApp(db, { origin: localOrigin, localActorId: viewerId })).toThrow(
      '本地直接访问',
    );
  });

  it('does not fall back to another actor or password login when local access fails', async () => {
    await request(
      createApp(db, {
        origin: localOrigin,
        development: true,
        localActorId: randomUUID(),
      }),
    )
      .get('/api/session')
      .set('host', localHost)
      .expect(503);
    for (const path of ['/api/auth/login', '/api/auth/logout']) {
      await request(localApp())
        .post(path)
        .set({ host: localHost, origin: localOrigin })
        .send({})
        .expect(409);
    }
  });
});
describe('customer and project authorization', () => {
  it('denies every guessed child route for an unauthorized customer', async () => {
    for (const path of ['', '/projects', '/records', '/audit', `/projects/${projectB}`]) {
      await editor.get(`/api/customers/${customerB}${path}`).set(headers()).expect(404);
    }
    await editor
      .patch(`/api/customers/${customerB}`)
      .set(headers())
      .send({ name: 'Hijack', version: 1 })
      .expect(404);
    await editor
      .post(`/api/customers/${customerB}/projects`)
      .set(headers())
      .send({ name: 'Bad', type: 'sample' })
      .expect(404);
    await editor
      .post(`/api/customers/${customerB}/records`)
      .set(headers())
      .send({ body: 'Bad', kind: 'inference' })
      .expect(404);
  });
  it('enforces read-only access and admin-only operations', async () => {
    await viewer.get(`/api/customers/${customerA}`).set(headers()).expect(200);
    await viewer
      .patch(`/api/customers/${customerA}`)
      .set(headers())
      .send({ name: 'Bad', version: 1 })
      .expect(403);
    await viewer
      .post(`/api/customers/${customerA}/projects`)
      .set(headers())
      .send({ name: 'Bad', type: 'inquiry' })
      .expect(403);
    await viewer
      .patch(`/api/customers/${customerA}/projects/${projectA}`)
      .set(headers())
      .send({ name: 'Bad', version: 1 })
      .expect(403);
    await viewer
      .post(`/api/customers/${customerA}/records`)
      .set(headers())
      .send({ body: 'Bad', kind: 'inference' })
      .expect(403);
    await editor
      .post('/api/customers')
      .set(headers())
      .send({ name: 'Bad', type: 'retail', source: 'store' })
      .expect(403);
    await editor.get(`/api/customers/${customerA}/access`).set(headers()).expect(403);
    await editor
      .put(`/api/customers/${customerA}/access/${viewerId}`)
      .set(headers())
      .send({ access: 'editor' })
      .expect(403);
    await editor
      .post('/api/members')
      .set(headers())
      .send({ email: 'bad@example.com', display_name: 'Bad', password })
      .expect(403);
    await editor
      .patch(`/api/members/${viewerId}`)
      .set(headers())
      .send({ active: false })
      .expect(403);
  });
  it('rejects mismatched project references, including for an admin who can see both', async () => {
    await admin.get(`/api/customers/${customerA}/projects/${projectB}`).set(headers()).expect(404);
    await admin
      .patch(`/api/customers/${customerA}/projects/${projectB}`)
      .set(headers())
      .send({ name: 'Bad', version: 1 })
      .expect(404);
    await admin
      .post(`/api/customers/${customerA}/records`)
      .set(headers())
      .send({ body: 'Bad', kind: 'customer_quote', project_id: projectB })
      .expect(404);
    await admin
      .get(`/api/customers/${customerA}/records?project_id=${projectB}`)
      .set(headers())
      .expect(404);
    await admin
      .patch(`/api/customers/${customerA}/projects/${projectA}`)
      .set(headers())
      .send({ version: 1, customer_id: customerB })
      .expect(400);
  });
  it('supports customer-level records with no project and keeps kinds separate', async () => {
    for (const kind of ['customer_quote', 'inference', 'company_confirmed']) {
      const result = await editor
        .post(`/api/customers/${customerA}/records`)
        .set(headers())
        .send({ body: `Synthetic ${kind}`, kind, project_id: null })
        .expect(201);
      expect(result.body.project_id).toBeNull();
      expect(result.body.created_by).toBe(editorId);
    }
    const list = await editor.get(`/api/customers/${customerA}/records`).set(headers()).expect(200);
    expect(list.body).toHaveLength(3);
    expect(JSON.stringify(list.body)).not.toContain(customerB);
  });
  it('validates same-workspace owners and strict dates', async () => {
    await admin
      .patch(`/api/customers/${customerA}`)
      .set(headers())
      .send({ version: 1, owner_id: foreign.actorId })
      .expect(400);
    await editor
      .post(`/api/customers/${customerA}/projects`)
      .set(headers())
      .send({ name: 'Bad date', type: 'sample', due_date: '2026-02-30' })
      .expect(400);
  });
  it('uses optimistic concurrency and scoped atomic audit events', async () => {
    const result = await editor
      .patch(`/api/customers/${customerA}`)
      .set(headers())
      .send({ version: 1, name: 'Customer A revised' })
      .expect(200);
    expect(result.body.version).toBe(2);
    await editor
      .patch(`/api/customers/${customerA}`)
      .set(headers())
      .send({ version: 1, name: 'Stale' })
      .expect(409);
    const audit = await editor.get(`/api/customers/${customerA}/audit`).set(headers()).expect(200);
    expect(
      audit.body.some(
        (event: { actor_id: string; action: string }) =>
          event.actor_id === editorId && event.action === 'update',
      ),
    ).toBe(true);
    expect(
      audit.body.every((event: { customer_id: string }) => event.customer_id === customerA),
    ).toBe(true);
  });
  it('archives without deleting history and requires restore before further edits', async () => {
    await editor
      .patch(`/api/customers/${customerA}`)
      .set(headers())
      .send({ version: 2, archived: true })
      .expect(403);
    await admin
      .patch(`/api/customers/${customerA}`)
      .set(headers())
      .send({ version: 2, archived: true })
      .expect(200);
    await editor
      .post(`/api/customers/${customerA}/projects`)
      .set(headers())
      .send({ name: 'Bad', type: 'sample' })
      .expect(409);
    await editor
      .patch(`/api/customers/${customerA}/projects/${projectA}`)
      .set(headers())
      .send({ version: 1, stage: 'completed' })
      .expect(409);
    await editor
      .post(`/api/customers/${customerA}/records`)
      .set(headers())
      .send({ body: 'Bad', kind: 'inference' })
      .expect(409);
    await editor.get(`/api/customers/${customerA}/records`).set(headers()).expect(200);
    const list = await editor.get('/api/customers').set(headers()).expect(200);
    expect(list.body.items).toEqual([]);
    const archived = await editor.get('/api/customers?archived=true').set(headers()).expect(200);
    expect(archived.body.total).toBe(1);
    await admin
      .patch(`/api/customers/${customerA}`)
      .set(headers())
      .send({ version: 3, archived: false })
      .expect(200);
    await admin.delete(`/api/customers/${customerA}`).set(headers()).send({}).expect(404);
  });
  it('archives and restores projects without permitting edits to archived projects', async () => {
    await editor
      .patch(`/api/customers/${customerA}/projects/${projectA}`)
      .set(headers())
      .send({ version: 1, archived: true })
      .expect(200);
    await editor
      .patch(`/api/customers/${customerA}/projects/${projectA}`)
      .set(headers())
      .send({ version: 2, stage: 'completed' })
      .expect(409);
    await editor
      .post(`/api/customers/${customerA}/records`)
      .set(headers())
      .send({ project_id: projectA, body: 'Bad', kind: 'inference' })
      .expect(409);
    await editor
      .patch(`/api/customers/${customerA}/projects/${projectA}`)
      .set(headers())
      .send({ version: 2, archived: false })
      .expect(200);
  });
});
describe('database defense in depth', () => {
  it('filters even unscoped SQL under the business role and resets role afterward', async () => {
    await scoped(db, editorId, space.workspaceId, async ({ tx }) => {
      const rows = (await tx.query<{ id: string }>('SELECT id FROM customers')).rows;
      expect(rows.map((row) => row.id)).toEqual([customerA]);
      expect((await tx.query('SELECT * FROM projects WHERE id = $1', [projectB])).rows).toEqual([]);
      expect(
        (await tx.query('SELECT * FROM audit_events WHERE customer_id = $1', [customerB])).rows,
      ).toEqual([]);
    });
    await db.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE light_crm_app');
      expect((await tx.query('SELECT * FROM customers')).rows).toEqual([]);
    });
  });
  it('rejects direct cross-customer updates and viewer writes', async () => {
    await scoped(db, editorId, space.workspaceId, async ({ tx }) => {
      expect(
        (
          await tx.query("UPDATE customers SET name = 'Bad' WHERE id = $1 RETURNING id", [
            customerB,
          ])
        ).rows,
      ).toEqual([]);
    });
    await expect(
      scoped(db, viewerId, space.workspaceId, async ({ tx }) => {
        await tx.query(
          "INSERT INTO customer_records(workspace_id, customer_id, id, kind, body, created_by) VALUES ($1, $2, $3, 'inference', 'Bad', $4)",
          [space.workspaceId, customerA, randomUUID(), viewerId],
        );
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('joint foreign keys reject mismatched projects even when using the DB owner', async () => {
    await expect(
      db.query(
        `INSERT INTO customer_records(workspace_id, customer_id, project_id, id, kind, body, created_by)
      VALUES ($1, $2, $3, $4, 'inference', 'Bad', $5)`,
        [space.workspaceId, customerA, projectB, randomUUID(), space.actorId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      db.query(
        `INSERT INTO projects(workspace_id, customer_id, id, name, type)
      VALUES ($1, $2, $3, 'Bad', 'inquiry')`,
        [space.workspaceId, foreignCustomer, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      db.query('UPDATE projects SET customer_id = $1 WHERE id = $2', [customerB, projectA]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('rolls back business data and its audit together on failure', async () => {
    await expect(
      scoped(db, space.actorId, space.workspaceId, async ({ tx }) => {
        await tx.query("UPDATE customers SET name = 'Rolled back' WHERE id = $1", [customerA]);
        throw new Error('rollback-test');
      }),
    ).rejects.toThrow('rollback-test');
    const result = await admin.get(`/api/customers/${customerA}`).set(headers()).expect(200);
    expect(result.body.name).toBe('Customer A revised');
    expect(result.body.version).toBe(4);
  });
});
describe('permission changes and sessions', () => {
  it('revocation affects the existing session on its very next request', async () => {
    await admin
      .put(`/api/customers/${customerA}/access/${editorId}`)
      .set(headers())
      .send({ access: null })
      .expect(200);
    await editor.get(`/api/customers/${customerA}`).set(headers()).expect(404);
    await editor.get(`/api/customers/${customerA}/records`).set(headers()).expect(404);
    await editor.get(`/api/customers/${customerA}/audit`).set(headers()).expect(404);
    expect((await editor.get('/api/customers').set(headers()).expect(200)).body.total).toBe(0);
  });
  it('deactivated members cannot use an existing session to access workspace data', async () => {
    await admin
      .patch(`/api/members/${viewerId}`)
      .set(headers())
      .send({ active: false })
      .expect(200);
    await viewer.get(`/api/customers/${customerA}`).set(headers()).expect(404);
    expect((await viewer.get('/api/session').expect(200)).body.workspaces).toEqual([]);
    await admin
      .put(`/api/customers/${customerA}/access/${viewerId}`)
      .set(headers())
      .send({ access: 'editor' })
      .expect(400);
  });
  it('uses opaque HttpOnly cookies and stores only a token hash', async () => {
    const browser = request.agent(app);
    const login = await browser
      .post('/api/auth/login')
      .set('origin', origin)
      .send({ email: 'admin-a@example.com', password })
      .expect(200);
    const cookie = login.headers['set-cookie'][0];
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const raw = cookie.split(';')[0].split('=')[1];
    expect((await db.query('SELECT * FROM sessions WHERE token_hash = $1', [raw])).rows).toEqual(
      [],
    );
    await browser.post('/api/auth/logout').set('origin', origin).send({}).expect(200);
    await browser.get('/api/session').expect(401);
    await request(app).get('/api/session').set('Cookie', cookie.split(';')[0]).expect(401);
  });
});
