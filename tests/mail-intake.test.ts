import { afterAll, beforeAll, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { parseMail, type MailTransport } from '../server/mail-transport.js';
import { scoped } from '../server/security.js';

const origin = 'http://localhost:3100',
  password = 'notification-fixture-password',
  own = 'fixture@163.com';
let db: Database,
  admin: Agent,
  member: Agent,
  workspace: string,
  actor: string,
  memberId: string,
  account: string,
  knownCustomer: string;
const h = () => ({ origin, 'x-workspace-id': workspace });
const recentDate = new Date(Date.now() - 60000).toUTCString();
const samples = [
  ['unknown@fixture.invalid', 'new', 'new'],
  ['known@fixture.invalid', 'known', 'new'],
  ['old@fixture.invalid', 'historical', 'old'],
  [own, 'outbound', 'new'],
  ['no-project@fixture.invalid', 'without-project', 'new'],
  ['known@fixture.invalid, unknown@fixture.invalid', 'conflict', 'new'],
];
const transport: MailTransport = {
  async run(_input, save) {
    for (let i = 0; i < samples.length; i++) {
      const [sender, subject, age] = samples[i];
      await save(
        'INBOX',
        { validity: '1', uid: i + 1 },
        await parseMail(
          Buffer.from(
            `From: ${sender}\r\nTo: ${sender === own ? 'known@fixture.invalid' : own}\r\nSubject: ${subject}\r\nDate: ${age === 'old' ? new Date(Date.now() - 86400000 * 3).toUTCString() : recentDate}\r\nMessage-ID: <${subject}@fixture.invalid>\r\n\r\nSynthetic company intake sample.`,
          ),
          new Date(),
        ),
      );
    }
  },
};
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Mail intake',
    email: 'admin@fixture.invalid',
    displayName: 'Admin',
    password,
  });
  workspace = seed.workspaceId;
  actor = seed.actorId;
  const app = createApp(db, { origin, mail: { key: randomBytes(32), transport } });
  admin = request.agent(app);
  member = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'admin@fixture.invalid', password })
    .expect(200);
  memberId = (
    await admin
      .post('/api/members')
      .set(h())
      .send({ email: 'member@fixture.invalid', display_name: 'Member', password })
      .expect(201)
  ).body.actor_id;
  await member
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'member@fixture.invalid', password })
    .expect(200);
  knownCustomer = (
    await admin
      .post('/api/customers')
      .set(h())
      .send({
        name: 'Existing',
        type: 'group',
        source: 'email',
        contact_name: 'Known',
        email: 'known@fixture.invalid',
      })
      .expect(201)
  ).body.id;
  await admin
    .put(`/api/customers/${knownCustomer}/access/${memberId}`)
    .set(h())
    .send({ access: 'viewer' })
    .expect(200);
  account = (
    await admin
      .post('/api/mail/accounts')
      .set(h())
      .send({ email: own, authorization_code: 'synthetic-auth-code' })
      .expect(201)
  ).body.id;
  await db.query(
    "UPDATE mail_accounts SET created_at=now()-interval '1 day' WHERE workspace_id=$1 AND id=$2",
    [workspace, account],
  );
  // A stable fixture Date is essential for testing idempotent imports.
  await admin.post(`/api/mail/accounts/${account}/sync`).set(h()).send({}).expect(200);
}, 30000);
afterAll(() => db.close());
async function notification(subject: string) {
  return (await admin.get('/api/mail/notifications').set(h()).expect(200)).body.items.find(
    (m: { subject: string }) => m.subject === subject,
  );
}
const intake = (
  name = 'New company',
  address = 'unknown@fixture.invalid',
  project: object | null = { name: 'Sample project', type: 'sample' },
) => ({
  customer: { name, type: 'group', contact_name: 'Contact', email: address, region: 'Test region' },
  project,
  reviewed: true,
  job_title: 'Purchasing lead',
});
it('notifies only new inbound mail, filters, deduplicates and isolates pending messages', async () => {
  let list = (await admin.get('/api/mail/notifications').set(h()).expect(200)).body;
  expect(list.total).toBe(4);
  expect(list.unread).toBe(4);
  expect(list.pending).toBe(3);
  expect(list.items.map((m: { subject: string }) => m.subject)).not.toContain('historical');
  expect(
    (
      await admin
        .get('/api/mail/notifications')
        .set(h())
        .query({ q: 'without-project' })
        .expect(200)
    ).body.total,
  ).toBe(1);
  await admin.post(`/api/mail/accounts/${account}/sync`).set(h()).send({}).expect(200);
  list = (await admin.get('/api/mail/notifications').set(h()).expect(200)).body;
  expect(list.total).toBe(4);
  const visible = (await member.get('/api/mail/notifications').set(h()).expect(200)).body;
  expect(visible.items.map((m: { subject: string }) => m.subject)).toEqual(['known']);
  const unknown = await notification('new');
  await member.post(`/api/mail/notifications/${unknown.id}/read`).set(h()).send({}).expect(404);
  await member
    .post(`/api/mail/messages/${unknown.id}/create-customer`)
    .set(h())
    .send(intake())
    .expect(403);
});
it('stores per-person read state; unread is independent of pending and revocation removes access', async () => {
  const unknown = await notification('new'),
    known = await notification('known');
  await admin.post(`/api/mail/notifications/${unknown.id}/read`).set(h()).send({}).expect(200);
  await admin.post(`/api/mail/notifications/${unknown.id}/read`).set(h()).send({}).expect(200);
  expect((await admin.get('/api/mail/notifications/summary').set(h()).expect(200)).body).toEqual({
    unread: 3,
    pending: 3,
  });
  expect(
    (await admin.get('/api/mail/notifications').set(h()).query({ filter: 'unread' }).expect(200))
      .body.total,
  ).toBe(3);
  await member.post(`/api/mail/notifications/${known.id}/read`).set(h()).send({}).expect(200);
  expect((await notification('known')).unread).toBe(true);
  // Database policy also rejects forging another actor's read state.
  await expect(
    scoped(db, actor, workspace, (ctx) =>
      ctx.tx.query(
        'INSERT INTO mail_notification_reads(workspace_id,actor_id,message_id) VALUES($1,$2,$3)',
        [workspace, memberId, unknown.id],
      ),
    ),
  ).rejects.toThrow();
  await admin
    .put(`/api/customers/${knownCustomer}/access/${memberId}`)
    .set(h())
    .send({ access: null })
    .expect(200);
  expect((await member.get('/api/mail/notifications').set(h()).expect(200)).body.total).toBe(0);
  await member.post(`/api/mail/notifications/${known.id}/read`).set(h()).send({}).expect(404);
});
it('rejects invalid or conflicting intake without creating records', async () => {
  const unknown = await notification('new'),
    conflict = await notification('conflict');
  const before = (await admin.get('/api/customers').set(h()).expect(200)).body.total;
  await admin
    .post(`/api/mail/messages/${unknown.id}/create-customer`)
    .set(h())
    .send({ ...intake(), reviewed: false })
    .expect(400);
  await admin
    .post(`/api/mail/messages/${unknown.id}/create-customer`)
    .set(h())
    .send(intake('Wrong', 'someone@else.invalid'))
    .expect(400);
  await admin
    .post(`/api/mail/messages/${unknown.id}/create-customer`)
    .set(h())
    .send(intake('Internal', own))
    .expect(400);
  await admin
    .post(`/api/mail/messages/${unknown.id}/create-customer`)
    .set(h())
    .send(intake('Existing'))
    .expect(409);
  await admin
    .post(`/api/mail/messages/${conflict.id}/create-customer`)
    .set(h())
    .send(intake())
    .expect(409);
  await admin
    .post(`/api/mail/messages/${unknown.id}/create-customer`)
    .set(h())
    .send({ ...intake(), project: { name: 'Wrong', type: 'sample', customer_id: knownCustomer } })
    .expect(400);
  expect((await admin.get('/api/customers').set(h()).expect(200)).body.total).toBe(before);
  await admin
    .post(`/api/mail/messages/${randomUUID()}/create-customer`)
    .set(h())
    .send(intake())
    .expect(404);
});
it('atomically creates company, person and optional project; retry does not duplicate', async () => {
  const unknown = await notification('new');
  const message = (
    await admin
      .post(`/api/mail/messages/${unknown.id}/create-customer`)
      .set(h())
      .send(intake())
      .expect(201)
  ).body;
  expect(message.customer_id).toBeTruthy();
  expect(message.project_id).toBeTruthy();
  expect(message.people).toHaveLength(1);
  const person = message.people[0].id;
  expect((await admin.get(`/api/people/${person}`).set(h()).expect(200)).body.job_title).toBe(
    'Purchasing lead',
  );
  for (const [object, id] of [
    ['customers', message.customer_id],
    ['people', person],
  ]) {
    const related = (
      await admin.get(`/api/relationships/records/${object}/${id}/projects`).set(h()).expect(200)
    ).body;
    expect(related.total).toBe(1);
    expect(related.items[0].id).toBe(message.project_id);
    const record = (await admin.get(`/api/${object}/${id}`).set(h()).expect(200)).body;
    expect(record.email_count).toBe(1);
  }
  await admin
    .post(`/api/mail/messages/${unknown.id}/create-customer`)
    .set(h())
    .send(intake())
    .expect(409);
  expect(
    (await admin.get('/api/customers').set(h()).query({ q: 'New company' }).expect(200)).body.total,
  ).toBe(1);
  expect((await notification('new')).customer_id).toBe(message.customer_id);
  expect(
    (await admin.get('/api/mail/notifications/summary').set(h()).expect(200)).body.pending,
  ).toBe(2);
  const another = await notification('without-project');
  const noProject = (
    await admin
      .post(`/api/mail/messages/${another.id}/create-customer`)
      .set(h())
      .send(intake('No project company', 'no-project@fixture.invalid', null))
      .expect(201)
  ).body;
  expect(noProject.project_id).toBeNull();
  expect(
    (
      await admin
        .get(`/api/relationships/records/people/${noProject.people[0].id}/projects`)
        .set(h())
        .expect(200)
    ).body.total,
  ).toBe(0);
});
it('does not allow notification access through another workspace', async () => {
  const other = await createWorkspace(db, {
    name: 'Other space',
    email: 'other@fixture.invalid',
    displayName: 'Other',
    password,
  });
  await admin
    .get('/api/mail/notifications')
    .set({ ...h(), 'x-workspace-id': other.workspaceId })
    .expect(404);
  await admin
    .get('/api/mail/notifications/summary')
    .set({ ...h(), 'x-workspace-id': other.workspaceId })
    .expect(404);
});
