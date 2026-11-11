import { randomUUID } from 'node:crypto';
import request, { type Agent } from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';

const origin = 'http://localhost:3100';
const password = 'shopify-inbox-isolated-test-password';
const adminEmail = 'shopify-admin@fixture.invalid';
const memberEmail = 'shopify-member@fixture.invalid';

type Row = { id: string; version: number };

let db: Database;
let admin: Agent;
let member: Agent;
let anonymous: Agent;
let workspace: string;
let memberId: string;
let customer: Row;
let otherCustomer: Row;
let project: Row;
let otherProject: Row;

const headers = () => ({ origin, 'x-workspace-id': workspace });
const message = () => ({
  shop_domain: 'demo-store.myshopify.com',
  conversation_id: 'fixture-conversation',
  message_id: randomUUID(),
  occurred_at: '2026-11-10T17:35:26+08:00',
  sender_name: '样衣咨询访客',
  sender_email: 'visitor@fixture.invalid',
  text: '  想确认样衣交期。\r\n尺码还在统计中。  \n',
});
const importPath = (customerId: string) => `/api/customers/${customerId}/shopify/messages`;
const recordsPath = (customerId: string) => `/api/customers/${customerId}/records`;
const evidencePath = (customerId: string, recordId: string) =>
  `${recordsPath(customerId)}/${recordId}/evidence`;
const importMessage = (customerId: string, payload: object, client = admin) =>
  client.post(importPath(customerId)).set(headers()).send(payload);
const readRecords = (customerId: string, client = admin) =>
  client.get(recordsPath(customerId)).set(headers()).expect(200);
const setAccess = (customerId: string, access: 'viewer' | 'editor' | null) =>
  admin
    .put(`/api/customers/${customerId}/access/${memberId}`)
    .set(headers())
    .send({ access })
    .expect(200);

async function createCustomer(name: string): Promise<Row> {
  return (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({ name, type: 'group', source: 'other' })
      .expect(201)
  ).body;
}

async function createProject(customerId: string, name: string): Promise<Row> {
  return (
    await admin
      .post(`/api/customers/${customerId}/projects`)
      .set(headers())
      .send({ name, type: 'sample' })
      .expect(201)
  ).body;
}

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Shopify 消息接口（合成）',
    email: adminEmail,
    displayName: '管理员',
    password,
  });
  workspace = seed.workspaceId;

  const app = createApp(db, { origin });
  admin = request.agent(app);
  member = request.agent(app);
  anonymous = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set({ origin })
    .send({ email: adminEmail, password })
    .expect(200);
  memberId = (
    await admin
      .post('/api/members')
      .set(headers())
      .send({ email: memberEmail, display_name: '业务员', password })
      .expect(201)
  ).body.actor_id;
  await member
    .post('/api/auth/login')
    .set({ origin })
    .send({ email: memberEmail, password })
    .expect(200);

  customer = await createCustomer('Shopify 样衣客户');
  otherCustomer = await createCustomer('另一客户');
  project = await createProject(customer.id, '样衣确认');
  otherProject = await createProject(otherCustomer.id, '另一公司项目');
}, 30000);

afterAll(async () => {
  await db?.close();
});

it('archives one original and makes it readable through customer, evidence, and project Ask routes', async () => {
  const input = { ...message(), project_id: project.id };
  const saved = (await importMessage(customer.id, input).expect(201)).body;
  expect(saved).toEqual({ record_id: expect.any(String), reused: false });
  const replay = (
    await importMessage(customer.id, {
      ...input,
      shop_domain: ' DEMO-STORE.MYSHOPIFY.COM ',
      occurred_at: '2026-11-10T09:35:26.000Z',
    }).expect(201)
  ).body;
  expect(replay).toEqual({ record_id: saved.record_id, reused: true });

  const records = (
    await admin
      .get(recordsPath(customer.id))
      .set(headers())
      .query({ project_id: project.id })
      .expect(200)
  ).body;
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    id: saved.record_id,
    customer_id: customer.id,
    project_id: project.id,
    kind: 'customer_quote',
    source_kind: 'manual',
  });
  expect(new Date(records[0].occurred_at).toISOString()).toBe('2026-11-10T09:35:26.000Z');
  expect(records[0].body).toContain('Shopify');
  expect(records[0].body).toContain(input.sender_name);
  expect(records[0].body).toContain(input.sender_email);
  expect(records[0].body.endsWith(input.text)).toBe(true);

  const evidence = (
    await admin.get(evidencePath(customer.id, saved.record_id)).set(headers()).expect(200)
  ).body;
  expect(evidence.record.body).toBe(records[0].body);
  expect(evidence.sources).toHaveLength(1);
  expect(evidence.sources[0]).toMatchObject({
    record_id: saved.record_id,
    trust: 'customer_quote',
    project_id: project.id,
    person_ids: [],
    occurred_at: '2026-11-10T09:35:26.000Z',
    body: records[0].body,
  });
  const scope = {
    kind: 'entity',
    object: 'projects',
    record_id: project.id,
    customer_id: customer.id,
  };
  const ask = (
    await admin
      .post('/api/ask/query')
      .set(headers())
      .send({ scope, action: 'records', question: '查看这个项目的记录' })
      .expect(200)
  ).body;
  expect(ask.sources).toEqual([expect.objectContaining({ kind: 'record', id: saved.record_id })]);
  const source = (
    await admin
      .post('/api/ask/source')
      .set(headers())
      .send({ scope, kind: 'record', id: saved.record_id })
      .expect(200)
  ).body;
  expect(source.body).toContain(input.text);
});

it('accepts an unsigned visitor and stores one record when the same message arrives concurrently', async () => {
  const input = { ...message(), sender_name: undefined, sender_email: undefined };
  const before = (await readRecords(customer.id)).body.length;
  const [first, second] = await Promise.all([
    importMessage(customer.id, input).expect(201),
    importMessage(customer.id, input).expect(201),
  ]);
  expect(first.body.record_id).toBe(second.body.record_id);
  expect([first.body.reused, second.body.reused].sort()).toEqual([false, true]);

  const records = (await readRecords(customer.id)).body;
  expect(records).toHaveLength(before + 1);
  const saved = records.find((row: Row) => row.id === first.body.record_id);
  expect(saved.body.endsWith(input.text)).toBe(true);
  expect(saved.body).not.toContain('发言者：');
  expect(saved.body).not.toContain('发言者邮箱：');
});

it('rejects changed content or ownership for the same import key without revealing the saved record', async () => {
  const input = message();
  const previousCustomerCount = (await readRecords(customer.id)).body.length;
  const previousOtherCount = (await readRecords(otherCustomer.id)).body.length;
  const saved = (await importMessage(customer.id, input).expect(201)).body;
  const replay = (await importMessage(customer.id, { ...input, project_id: null }).expect(201))
    .body;
  expect(replay).toEqual({ record_id: saved.record_id, reused: true });

  for (const conflict of [
    await importMessage(customer.id, { ...input, text: '修改后的消息' }).expect(409),
    await importMessage(customer.id, { ...input, project_id: project.id }).expect(409),
    await importMessage(otherCustomer.id, input).expect(409),
  ]) {
    expect(JSON.stringify(conflict.body)).not.toContain(saved.record_id);
    expect(JSON.stringify(conflict.body)).not.toContain('想确认样衣交期');
  }
  const records = (await readRecords(customer.id)).body;
  expect(records).toHaveLength(previousCustomerCount + 1);
  expect(records.find((row: Row) => row.id === saved.record_id)).toMatchObject({
    project_id: null,
  });
  expect((await readRecords(otherCustomer.id)).body).toHaveLength(previousOtherCount);

  await setAccess(otherCustomer.id, 'editor');
  try {
    const memberCopy = (await importMessage(otherCustomer.id, input, member).expect(201)).body;
    expect(memberCopy.reused).toBe(false);
    expect(memberCopy.record_id).not.toBe(saved.record_id);
  } finally {
    await setAccess(otherCustomer.id, null);
  }
});

it('checks authentication, origin, workspace, and current customer access before importing or replaying', async () => {
  const input = message();
  await importMessage(customer.id, input, anonymous).expect(401);
  await admin
    .post(importPath(customer.id))
    .set({ ...headers(), origin: 'https://elsewhere.invalid' })
    .send(input)
    .expect(403);
  await admin.post(importPath(customer.id)).set({ origin }).send(input).expect(400);
  await admin
    .post(importPath(customer.id))
    .set({ ...headers(), 'x-workspace-id': randomUUID() })
    .send(input)
    .expect(404);
  await importMessage(customer.id, input, member).expect(404);

  await setAccess(customer.id, 'editor');
  try {
    const saved = (await importMessage(customer.id, input, member).expect(201)).body;
    await setAccess(customer.id, 'viewer');
    await importMessage(customer.id, input, member).expect(403);
    await member.get(evidencePath(customer.id, saved.record_id)).set(headers()).expect(200);

    await setAccess(customer.id, null);
    await importMessage(customer.id, input, member).expect(404);
    await member.get(evidencePath(customer.id, saved.record_id)).set(headers()).expect(404);
  } finally {
    await setAccess(customer.id, null);
  }
});

it('rejects another customer’s project and archived targets', async () => {
  const input = message();
  const before = (await readRecords(customer.id)).body.length;
  await importMessage(customer.id, { ...input, project_id: otherProject.id }).expect(404);

  const archivedCustomer = await createCustomer('待归档的客户');
  const archivedProject = await createProject(customer.id, '待归档的项目');
  await admin
    .patch(`/api/customers/${archivedCustomer.id}`)
    .set(headers())
    .send({ version: archivedCustomer.version, archived: true })
    .expect(200);
  await admin
    .patch(`/api/customers/${customer.id}/projects/${archivedProject.id}`)
    .set(headers())
    .send({ version: archivedProject.version, archived: true })
    .expect(200);
  await importMessage(archivedCustomer.id, input).expect(409);
  await importMessage(customer.id, { ...input, project_id: archivedProject.id }).expect(409);
  expect((await readRecords(customer.id)).body).toHaveLength(before);
});

it('rejects extra fields, non-Shopify domains, ambiguous times and missing original text', async () => {
  const input = message();
  const before = (await readRecords(customer.id)).body.length;
  for (const invalid of [
    { sender_role: 'staff' },
    { customer_id: otherCustomer.id },
    { metadata: {} },
    { shop_domain: 'demo-store.myshopify.com.elsewhere.invalid' },
    { occurred_at: '2026-11-10T17:35:26' },
    { occurred_at: '2026-11-10T17:35:26.0001Z' },
    { sender_email: 'not-an-email' },
    { text: ' \n ' },
    { message_id: '' },
    { conversation_id: ' leading-space' },
  ]) {
    await importMessage(customer.id, { ...input, ...invalid }).expect(400);
  }
  await importMessage(customer.id, { ...input, text: '字'.repeat(10000) }).expect(413);
  expect((await readRecords(customer.id)).body).toHaveLength(before);
});
