import { afterAll, beforeAll, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';

const origin = 'http://localhost:3100';
const password = 'team-workbench-fixture-password';
const adminEmail = 'team-admin@fixture.invalid';
const salespersonEmail = 'salesperson@fixture.invalid';
const designerEmail = 'designer@fixture.invalid';
let db: Database;
let workspace: string;
let adminId: string;
let salespersonId: string;
let designerId: string;
let customer: string;
let admin: Agent;
let salesperson: Agent;
let designer: Agent;

const headers = () => ({ origin, 'x-workspace-id': workspace });

async function login(agent: Agent, email: string) {
  await agent.post('/api/auth/login').set({ origin }).send({ email, password }).expect(200);
}

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: '团队工作台测试',
    displayName: '管理员',
    email: adminEmail,
    password,
  });
  workspace = seed.workspaceId;
  adminId = seed.actorId;
  const app = createApp(db, { origin });
  admin = request.agent(app);
  salesperson = request.agent(app);
  designer = request.agent(app);
  await login(admin, adminEmail);
  salespersonId = (
    await admin
      .post('/api/members')
      .set(headers())
      .send({ email: salespersonEmail, display_name: '外贸业务员', password })
      .expect(201)
  ).body.actor_id;
  designerId = (
    await admin
      .post('/api/members')
      .set(headers())
      .send({ email: designerEmail, display_name: '设计师', password, workspace_mode: 'tasks' })
      .expect(201)
  ).body.actor_id;
  await login(salesperson, salespersonEmail);
  await login(designer, designerEmail);
  customer = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({ name: '演示客户', type: 'group', source: 'other' })
      .expect(201)
  ).body.id;
  await admin
    .put(`/api/customers/${customer}/access/${salespersonId}`)
    .set(headers())
    .send({ access: 'editor' })
    .expect(200);
}, 30000);

afterAll(() => db?.close());

it('uses authenticated membership to choose the CRM or tasks workspace', async () => {
  for (const [agent, actor, role, workspaceMode] of [
    [admin, adminId, 'admin', 'crm'],
    [salesperson, salespersonId, 'member', 'crm'],
    [designer, designerId, 'member', 'tasks'],
  ] as const) {
    expect((await agent.get('/api/session').expect(200)).body).toMatchObject({
      actor: { id: actor },
      auth_mode: 'password',
      workspaces: [{ id: workspace, role, workspace_mode: workspaceMode }],
    });
  }
  expect((await admin.get('/api/members').set(headers()).expect(200)).body).toContainEqual({
    actor_id: designerId,
    display_name: '设计师',
    email: designerEmail,
    role: 'member',
    active: true,
    workspace_mode: 'tasks',
  });
  await salesperson.get(`/api/customers/${customer}`).set(headers()).expect(200);
});

it('keeps tasks memberships out of general workspace and customer operations', async () => {
  for (const route of [
    '/api/customers',
    `/api/customers/${customer}`,
    '/api/members',
    '/api/agent/capabilities',
    '/api/wechat/connector',
  ]) {
    await designer.get(route).set(headers()).expect(403);
  }
  await designer
    .post('/api/ask/query')
    .set(headers())
    .send({
      scope: { kind: 'entity', object: 'customers', record_id: customer, customer_id: customer },
      question: '查看档案',
    })
    .expect(403);
  await designer
    .patch(`/api/members/${salespersonId}`)
    .set(headers())
    .send({ active: false })
    .expect(403);
  await designer.get('/api/tasks').set(headers()).expect(200);
});

it('rejects direct grants to a task collaborator and denies stale grants at the database boundary', async () => {
  const path = `/api/customers/${customer}/access/${designerId}`;
  await admin.put(path).set(headers()).send({ access: 'viewer' }).expect(400);
  const customerVersion = (await admin.get(`/api/customers/${customer}`).set(headers()).expect(200))
    .body.version;
  await admin
    .patch(`/api/customers/${customer}`)
    .set(headers())
    .send({ version: customerVersion, owner_id: designerId })
    .expect(400);
  await admin
    .post(`/api/customers/${customer}/projects`)
    .set(headers())
    .send({ name: '不可指派的项目', type: 'inquiry', owner_id: designerId })
    .expect(400);
  await scoped(db, adminId, workspace, (ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id, customer_id, actor_id, access) VALUES ($1,$2,$3,'editor')",
      [workspace, customer, designerId],
    ),
  );
  expect(
    (
      await scoped(db, designerId, workspace, (ctx) => ctx.tx.query('SELECT id FROM customers'), {
        allowTasks: true,
      })
    ).rows,
  ).toEqual([]);
  await admin.put(path).set(headers()).send({ access: null }).expect(200);
});

it('rejects a stale tab identity before reading or invalidating the current login', async () => {
  const staleTab = { ...headers(), 'x-expected-actor-id': salespersonId };
  await designer.get('/api/tasks').set(staleTab).expect(401);
  await designer.post('/api/auth/logout').set(staleTab).send({}).expect(401);
  expect((await designer.get('/api/session').expect(200)).body.actor.id).toBe(designerId);
  await designer
    .get('/api/tasks')
    .set({ ...headers(), 'x-expected-actor-id': designerId })
    .expect(200);
});

it('updates access for an existing session when a workspace member is disabled', async () => {
  const path = `/api/members/${designerId}`;
  await admin.patch(path).set(headers()).send({ active: false }).expect(200);
  try {
    expect((await designer.get('/api/session').expect(200)).body.workspaces).toEqual([]);
    await designer.get('/api/tasks').set(headers()).expect(404);
  } finally {
    await admin.patch(path).set(headers()).send({ active: true }).expect(200);
  }
});
