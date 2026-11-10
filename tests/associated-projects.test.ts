import { afterAll, beforeAll, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import type { AssociatedProjectsPage } from '../shared/connections.js';
const origin = 'http://localhost:3100',
  password = 'synthetic-project-links-password';
let db: Database,
  admin: Agent,
  viewer: Agent,
  w: string,
  actor: string,
  viewerId: string,
  customer: string,
  otherCustomer: string,
  person: string,
  unrelatedPerson: string,
  otherPerson: string;
const projects: string[] = [];
const h = () => ({ origin, 'x-workspace-id': w });
const url = (object: string, id: string) => `/api/relationships/records/${object}/${id}/projects`;
async function list(object: string, id: string, page = 1, agent = admin) {
  return (await agent.get(url(object, id)).set(h()).query({ page }).expect(200))
    .body as AssociatedProjectsPage;
}
async function createPerson(customer_id: string, name: string) {
  return (await admin.post('/api/people').set(h()).send({ customer_id, name }).expect(201)).body
    .id as string;
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Project links',
    email: 'projects-link@fixture.invalid',
    password,
    displayName: 'Admin',
  });
  w = seed.workspaceId;
  actor = seed.actorId;
  const app = createApp(db, { origin });
  admin = request.agent(app);
  viewer = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'projects-link@fixture.invalid', password })
    .expect(200);
  viewerId = (
    await admin
      .post('/api/members')
      .set(h())
      .send({ email: 'projects-viewer@fixture.invalid', display_name: 'Viewer', password })
      .expect(201)
  ).body.actor_id;
  await viewer
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'projects-viewer@fixture.invalid', password })
    .expect(200);
  customer = (
    await admin
      .post('/api/customers')
      .set(h())
      .send({ name: 'Company A', type: 'group', source: 'email' })
      .expect(201)
  ).body.id;
  otherCustomer = (
    await admin
      .post('/api/customers')
      .set(h())
      .send({ name: 'Company B', type: 'group', source: 'email' })
      .expect(201)
  ).body.id;
  person = await createPerson(customer, 'Alice');
  unrelatedPerson = await createPerson(customer, 'Ben');
  otherPerson = await createPerson(otherCustomer, 'Private');
  await admin
    .put(`/api/customers/${customer}/access/${viewerId}`)
    .set(h())
    .send({ access: 'viewer' })
    .expect(200);
  for (let i = 0; i < 7; i++)
    projects.push(
      (
        await admin
          .post(`/api/customers/${customer}/projects`)
          .set(h())
          .send({ name: `Project ${i}`, type: 'sample' })
          .expect(201)
      ).body.id,
    );
  await admin
    .post(`/api/customers/${otherCustomer}/projects`)
    .set(h())
    .send({ name: 'Private project', type: 'sample' })
    .expect(201);
  await admin
    .patch(`/api/customers/${customer}/projects/${projects[0]}`)
    .set(h())
    .send({ version: 1, archived: true })
    .expect(200);
}, 30000);
afterAll(() => db.close());

it('shows only owned company projects, paginates without duplicates and retains archived history', async () => {
  const first = await list('customers', customer),
    second = await list('customers', customer, 2);
  expect(first.total).toBe(7);
  expect(first.items).toHaveLength(5);
  expect(second.items).toHaveLength(2);
  expect(new Set([...first.items, ...second.items].map((p) => p.id))).toEqual(new Set(projects));
  expect([...first.items, ...second.items].every((p) => p.customer_id === customer)).toBe(true);
  expect(second.items.at(-1)).toMatchObject({ id: projects[0], archived_at: expect.any(String) });
  expect((await list('people', person)).total).toBe(0);
  await admin.get(url('customers', customer)).set(h()).query({ page: 0 }).expect(400);
  await admin.get(url('projects', projects[0])).set(h()).expect(400);
});

let edge: string;
it('combines both relationship directions and explicit project mail once without inheriting unrelated company projects', async () => {
  const forward = (
    await admin
      .post('/api/relationships')
      .set(h())
      .send({
        source_object: 'people',
        target_object: 'projects',
        source_label: '参与项目',
        target_label: '成员',
        cardinality: 'many_to_many',
      })
      .expect(201)
  ).body.id;
  const reverse = (
    await admin
      .post('/api/relationships')
      .set(h())
      .send({
        source_object: 'projects',
        target_object: 'people',
        source_label: '对接人',
        target_label: '负责项目',
        cardinality: 'many_to_many',
      })
      .expect(201)
  ).body.id;
  edge = (
    await admin
      .post('/api/relationship-edges')
      .set(h())
      .send({ definition_id: forward, source_id: person, target_id: projects[1] })
      .expect(201)
  ).body.id;
  await admin
    .post('/api/relationship-edges')
    .set(h())
    .send({ definition_id: reverse, source_id: projects[2], target_id: person })
    .expect(201);
  await admin
    .post('/api/relationship-edges')
    .set(h())
    .send({ definition_id: reverse, source_id: projects[1], target_id: person })
    .expect(201);
  await scoped(db, actor, w, async (ctx) => {
    const account = randomUUID();
    await ctx.tx.query(
      "INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by) VALUES($1,$2,'sample@163.com','synthetic-unused',$3)",
      [w, account, actor],
    );
    for (const projectId of [projects[2], projects[3], projects[3], null]) {
      const message = randomUUID();
      await ctx.tx.query(
        `INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,project_id,fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason)
        VALUES($1,$2,$3,'sample@163.com',$4,$5,$2::uuid::text,'Synthetic','[]','[]','[]','[]',now(),'inbound','Synthetic','fixture')`,
        [w, message, account, customer, projectId],
      );
      await ctx.tx.query(
        'INSERT INTO mail_people(workspace_id,customer_id,message_id,person_id) VALUES($1,$2,$3,$4)',
        [w, customer, message, person],
      );
    }
  });
  const result = await list('people', person);
  expect(result.total).toBe(3);
  expect(new Set(result.items.map((p) => p.id))).toEqual(new Set(projects.slice(1, 4)));
  expect(result.items.find((p) => p.id === projects[1])).toMatchObject({
    via_relationship: true,
    via_email: false,
  });
  expect(result.items.find((p) => p.id === projects[2])).toMatchObject({
    via_relationship: true,
    via_email: true,
  });
  expect(result.items.find((p) => p.id === projects[3])).toMatchObject({
    via_relationship: false,
    via_email: true,
  });
  expect((await list('people', unrelatedPerson)).total).toBe(0);
});

it('inherits customer permissions and immediately denies revoked or foreign workspace access', async () => {
  expect((await list('people', person, 1, viewer)).total).toBe(3);
  await viewer.get(url('customers', otherCustomer)).set(h()).expect(404);
  await viewer.get(url('people', otherPerson)).set(h()).expect(404);
  await viewer.delete(`/api/relationship-edges/${edge}`).set(h()).send({}).expect(403);
  const other = await createWorkspace(db, {
    name: 'Other workspace',
    email: 'project-other@fixture.invalid',
    password,
    displayName: 'Other',
  });
  await admin
    .get(url('people', person))
    .set({ ...h(), 'x-workspace-id': other.workspaceId })
    .expect(404);
  await admin
    .put(`/api/customers/${customer}/access/${viewerId}`)
    .set(h())
    .send({ access: null })
    .expect(200);
  await viewer.get(url('people', person)).set(h()).expect(404);
  await viewer.get(url('customers', customer)).set(h()).expect(404);
});

it('recomputes links after relationship removal and preserves archived person project history', async () => {
  const relations = (
    await admin.get(`/api/relationships/records/people/${person}`).set(h()).expect(200)
  ).body.items as { id: string; edge_id: string }[];
  for (const r of relations.filter((r) => r.id === projects[1]))
    await admin.delete(`/api/relationship-edges/${r.edge_id}`).set(h()).send({}).expect(200);
  expect((await list('people', person)).total).toBe(2);
  await admin
    .patch(`/api/people/${person}`)
    .set(h())
    .send({ version: 1, archived: true })
    .expect(200);
  expect((await list('people', person)).total).toBe(2);
});
