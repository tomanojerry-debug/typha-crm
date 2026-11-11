import { createHmac, randomUUID } from 'node:crypto';
import request, { type Agent } from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { hashPassword } from '../server/security.js';

const origin = 'http://localhost:3100';
const password = 'fixture-whatsapp-inbox-password';
const appSecret = 'fixture-whatsapp-app-secret';
const verifyToken = 'fixture-whatsapp-verify-token';
const wabaId = '100000000001';
const phoneNumberId = '100000000002';
const senderId = '15550101010';
const occurredAt = '2026-11-11T06:00:00.000Z';
const timestamp = String(Date.parse(occurredAt) / 1000);
const webhookPath = '/webhooks/whatsapp';
const inboxPath = '/api/whatsapp/inbox';

interface InboxMessage {
  id: string;
  message_id: string;
  sender_id: string;
  sender_name: string | null;
  occurred_at: string;
  text: string;
}

let db: Database;
let app: ReturnType<typeof createApp>;
let admin: Agent;
let owner: Agent;
let outsider: Agent;
let workspaceId: string;
let outsiderWorkspaceId: string;
let ownerId: string;
let customerId: string;
let otherCustomerId: string;
let projectId: string;
let otherProjectId: string;
let archivedProjectId: string;

const headers = () => ({ origin, 'x-workspace-id': workspaceId });

function message(text = '顾客询问样衣') {
  return {
    from: senderId,
    id: `wamid.${randomUUID()}`,
    timestamp,
    type: 'text',
    text: { body: text },
  };
}

function event(
  messages: unknown[],
  options: { waba?: string; phone?: string; contacts?: unknown[]; statuses?: unknown[] } = {},
) {
  const { waba = wabaId, phone = phoneNumberId, contacts, statuses } = options;
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: waba,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: phone },
              ...(messages.length ? { messages } : {}),
              ...(contacts ? { contacts } : {}),
              ...(statuses ? { statuses } : {}),
            },
          },
        ],
      },
    ],
  };
}

function sign(raw: string) {
  return `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`;
}

function deliverRaw(raw: string, signature = sign(raw)) {
  return request(app)
    .post(webhookPath)
    .type('application/json')
    .set('X-Hub-Signature-256', signature)
    .send(raw);
}

const deliver = (payload: unknown) => deliverRaw(JSON.stringify(payload));

async function readInbox(): Promise<{ messages: InboxMessage[]; total: number }> {
  return (await owner.get(inboxPath).set(headers()).expect(200)).body;
}

async function receive(text?: string): Promise<InboxMessage> {
  const incoming = message(text);
  await deliver(event([incoming])).expect(200, { received: 1 });
  const pending = (await readInbox()).messages.find((row) => row.message_id === incoming.id);
  expect(pending).toBeDefined();
  return pending!;
}

const archivePath = (id: string) => `${inboxPath}/${id}/archive`;

function archive(id: string, target = { customer_id: customerId, project_id: projectId }) {
  return owner.post(archivePath(id)).set(headers()).send(target);
}

async function grant(customer: string, access: 'editor' | 'viewer' | null) {
  await admin
    .put(`/api/customers/${customer}/access/${ownerId}`)
    .set(headers())
    .send({ access })
    .expect(200);
}

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const adminEmail = 'whatsapp-admin@fixture.invalid';
  const ownerEmail = 'whatsapp-owner@fixture.invalid';
  const outsiderEmail = 'whatsapp-outsider@fixture.invalid';
  ({ workspaceId } = await createWorkspace(db, {
    name: 'WhatsApp fixture',
    email: adminEmail,
    password,
    displayName: 'Admin fixture',
  }));
  ({ workspaceId: outsiderWorkspaceId } = await createWorkspace(db, {
    name: 'Other workspace fixture',
    email: outsiderEmail,
    password,
    displayName: 'Outsider fixture',
  }));
  ownerId = randomUUID();
  await db.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [
    ownerId,
    ownerEmail,
    'Intake owner fixture',
    await hashPassword(password),
  ]);
  await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
    workspaceId,
    ownerId,
  ]);
  app = createApp(db, {
    origin,
    whatsapp: { appSecret, verifyToken, wabaId, phoneNumberId, workspaceId, actorId: ownerId },
  });
  admin = request.agent(app);
  owner = request.agent(app);
  outsider = request.agent(app);
  for (const [agent, email] of [
    [admin, adminEmail],
    [owner, ownerEmail],
    [outsider, outsiderEmail],
  ] as const) {
    await agent.post('/api/auth/login').set('origin', origin).send({ email, password }).expect(200);
  }
  async function createCustomer(name: string) {
    const result = await admin
      .post('/api/customers')
      .set(headers())
      .send({ name, type: 'group', source: 'other' })
      .expect(201);
    return result.body.id as string;
  }
  async function createProject(customer: string, name: string) {
    const result = await admin
      .post(`/api/customers/${customer}/projects`)
      .set(headers())
      .send({ name, type: 'sample' })
      .expect(201);
    return result.body as { id: string; version: number };
  }
  customerId = await createCustomer('样衣客户（虚构）');
  otherCustomerId = await createCustomer('另一客户（虚构）');
  projectId = (await createProject(customerId, '样衣（虚构）')).id;
  otherProjectId = (await createProject(otherCustomerId, '另一项目（虚构）')).id;
  const archived = await createProject(customerId, '归档项目（虚构）');
  archivedProjectId = archived.id;
  await admin
    .patch(`/api/customers/${customerId}/projects/${archived.id}`)
    .set(headers())
    .send({ version: archived.version, archived: true })
    .expect(200);
  await grant(customerId, 'editor');
  await grant(otherCustomerId, 'editor');
}, 30000);

afterAll(async () => {
  await db?.close();
});

it('verifies the Meta subscription challenge only for the configured token', async () => {
  const query = {
    'hub.mode': 'subscribe',
    'hub.verify_token': verifyToken,
    'hub.challenge': '28591370',
  };
  await request(app).get(webhookPath).query(query).expect(200, '28591370');
  await request(app)
    .get(webhookPath)
    .query({ ...query, 'hub.verify_token': 'incorrect' })
    .expect(403);
  await request(createApp(db, { origin })).get(webhookPath).query(query).expect(404);
});

it('requires the exact raw-body signature before accepting or parsing a delivery', async () => {
  const payload = event([message()]);
  const original = JSON.stringify(payload);
  const before = (await readInbox()).total;
  await request(app).post(webhookPath).type('application/json').send(original).expect(403);
  await deliverRaw(`${original}\n`, sign(original)).expect(403);
  await deliverRaw('not JSON', sign(original)).expect(403);
  await deliverRaw('not JSON').expect(400);
  expect((await readInbox()).total).toBe(before);
});

it('accepts signed Unicode text once under parallel retries and preserves exact original content', async () => {
  const text = '  想了解长袖样衣 🩰\n第二行原话\t ';
  const incoming = message(text);
  const payload = event([incoming], {
    contacts: [{ wa_id: senderId, profile: { name: '访客（虚构）' } }],
  });
  const raw = JSON.stringify(payload, null, 2);
  const replies = await Promise.all([deliverRaw(raw).expect(200), deliverRaw(raw).expect(200)]);
  expect(replies.map((reply) => reply.body.received).sort()).toEqual([0, 1]);
  for (const reply of replies) expect(reply.body).toEqual({ received: reply.body.received });
  await deliver(
    event([{ ...incoming, text: { body: 'same message ID with changed content' } }]),
  ).expect(200, { received: 0 });
  const rows = (await readInbox()).messages.filter((row) => row.message_id === incoming.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    sender_id: senderId,
    sender_name: '访客（虚构）',
    occurred_at: occurredAt,
    text,
  });
  const unnamed = await receive();
  expect(unnamed.sender_name).toBeNull();
});

it('ignores foreign account, foreign number, delivery status and non-text changes', async () => {
  const before = (await readInbox()).total;
  const incoming = message();
  for (const payload of [
    event([incoming], { waba: '200000000001' }),
    event([incoming], { phone: '200000000002' }),
    event([], { statuses: [{ id: incoming.id, status: 'delivered', timestamp }] }),
    event([{ ...incoming, type: 'image', text: undefined, image: { id: 'fixture-image' } }]),
  ]) {
    await deliver(payload).expect(200, { received: 0 });
  }
  expect((await readInbox()).total).toBe(before);
});

it('keeps a malformed matching text batch from partially creating records', async () => {
  const before = (await readInbox()).total;
  const valid = message();
  const invalid = { ...message(), timestamp: 'not-a-timestamp' };
  await deliver(event([valid, invalid])).expect(400);
  const after = await readInbox();
  expect(after.total).toBe(before);
  expect(after.messages.some((row) => row.message_id === valid.id)).toBe(false);
});

it('restricts the pending inbox and archive to the configured actor and workspace', async () => {
  const pending = await receive('仅归属账号可见的虚构原话');
  await request(app).get(inboxPath).set(headers()).expect(401);
  await admin.get(inboxPath).set(headers()).expect(404);
  await outsider.get(inboxPath).set({ origin, 'x-workspace-id': outsiderWorkspaceId }).expect(404);
  await admin
    .post(archivePath(pending.id))
    .set(headers())
    .send({ customer_id: customerId })
    .expect(404);
  expect((await readInbox()).messages.some((row) => row.id === pending.id)).toBe(true);
});

it('archives atomically to one authorized active customer and keeps exact record evidence', async () => {
  const text = '  黑色样衣需要短肩带\n请保留这一行\t ';
  const pending = await receive(text);
  await archive(pending.id, { customer_id: customerId, project_id: otherProjectId }).expect(404);
  await archive(pending.id, { customer_id: customerId, project_id: archivedProjectId }).expect(409);
  await owner
    .post(archivePath(pending.id))
    .set(headers())
    .send({ customer_id: customerId, text: 'modified text' })
    .expect(400);
  const replies = await Promise.all([
    archive(pending.id).expect(200),
    archive(pending.id).expect(200),
  ]);
  const [created, replay] = replies
    .map((reply) => reply.body)
    .sort((a, b) => Number(a.reused) - Number(b.reused));
  expect(created).toEqual({ record_id: expect.any(String), reused: false });
  expect(replay).toEqual({ record_id: created.record_id, reused: true });
  await archive(pending.id, { customer_id: otherCustomerId, project_id: otherProjectId }).expect(
    409,
  );
  expect((await readInbox()).messages.some((row) => row.id === pending.id)).toBe(false);

  const records = (
    await owner.get(`/api/customers/${customerId}/records`).set(headers()).expect(200)
  ).body;
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    id: created.record_id,
    project_id: projectId,
    kind: 'customer_quote',
    source_kind: 'manual',
    occurred_at: occurredAt,
  });
  expect(records[0].body).toContain('WhatsApp');
  expect(records[0].body).toContain(pending.message_id);
  expect(records[0].body.endsWith(text)).toBe(true);
  const evidence = (
    await owner
      .get(`/api/customers/${customerId}/records/${created.record_id}/evidence`)
      .set(headers())
      .expect(200)
  ).body;
  expect(evidence.record.body).toBe(records[0].body);
  expect(evidence.sources).toEqual([
    expect.objectContaining({ record_id: created.record_id, body: records[0].body }),
  ]);
});

it('rechecks current customer edit access on archive replay', async () => {
  const pending = await receive();
  const result = await archive(pending.id).expect(200);
  try {
    await grant(customerId, 'viewer');
    const viewer = await archive(pending.id).expect(403);
    expect(viewer.body).not.toHaveProperty('record_id');
    await grant(customerId, null);
    const revoked = await archive(pending.id).expect(404);
    expect(revoked.body).not.toHaveProperty('record_id');
    await owner
      .get(`/api/customers/${customerId}/records/${result.body.record_id}/evidence`)
      .set(headers())
      .expect(404);
  } finally {
    await grant(customerId, 'editor');
  }
});

it('rejects signed delivery when the configured member is disabled', async () => {
  const before = (await readInbox()).total;
  await admin.patch(`/api/members/${ownerId}`).set(headers()).send({ active: false }).expect(200);
  try {
    await deliver(event([message()])).expect(404);
    await owner.get(inboxPath).set(headers()).expect(404);
  } finally {
    await admin.patch(`/api/members/${ownerId}`).set(headers()).send({ active: true }).expect(200);
  }
  expect((await readInbox()).total).toBe(before);
});
