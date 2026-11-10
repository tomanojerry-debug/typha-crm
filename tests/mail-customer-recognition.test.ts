import { afterAll, beforeAll, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { parseMail, type MailTransport } from '../server/mail-transport.js';
import { scoped } from '../server/security.js';
import { recognizeMailCustomers } from '../server/mail-customer-recognition.js';

const origin = 'http://localhost:3100',
  password = 'recognition-fixture-password';
let db: Database,
  admin: Agent,
  member: Agent,
  workspace: string,
  actor: string,
  memberId: string,
  account: string;
let company: string, phoneCompany: string, otherActor: string, otherWorkspace: string;
const samples = [
  ['known', 'known@163.com', '普通来信'],
  ['new', 'new@163.com', '公司：全新示例工作室\n姓名：王测试'],
  ['company', 'new-company@163.com', '公司名称：已有示例工作室\n联系人：李测试'],
  ['phone', 'new-phone@163.com', '电话：+1 (202) 555-0107'],
  ['conflict', 'conflict@163.com', '公司：已有示例工作室\n电话：+1 202 555 0107'],
  ['name-only', 'name@163.com', '姓名：王测试'],
  [
    'quoted',
    'quoted@163.com',
    '咨询样衣\n> 公司：已有示例工作室\n-----Original Message-----\n电话：+1 202 555 0107',
  ],
  ['foreign', 'foreign@163.com', '公司：隔离空间公司'],
  ['body-conflict', 'body-conflict@163.com', '公司：已有示例工作室\n公司：另一公司'],
];
const transport: MailTransport = {
  async run(_input, save) {
    for (const [i, [subject, from, body]] of samples.entries())
      await save(
        'INBOX',
        { validity: '1', uid: i + 1 },
        await parseMail(
          Buffer.from(
            `From: ${from}\r\nTo: inbox@163.com\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${subject}@recognition.invalid>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
          ),
          new Date(),
        ),
      );
  },
};
const h = () => ({ origin, 'x-workspace-id': workspace });
async function notifications(user = admin) {
  return (await user.get('/api/mail/notifications').set(h()).expect(200)).body.items;
}
async function detail(subject: string) {
  const row = (await notifications()).find((m: { subject: string }) => m.subject === subject);
  return (await admin.get(`/api/mail/messages/${row.id}`).set(h()).expect(200)).body;
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Recognition fixture',
    email: 'admin@recognition.invalid',
    displayName: 'Admin',
    password,
  });
  workspace = seed.workspaceId;
  actor = seed.actorId;
  const other = await createWorkspace(db, {
    name: 'Other fixture',
    email: 'other@recognition.invalid',
    displayName: 'Other',
    password,
  });
  otherActor = other.actorId;
  otherWorkspace = other.workspaceId;
  const app = createApp(db, { origin, mail: { key: randomBytes(32), transport } });
  admin = request.agent(app);
  member = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'admin@recognition.invalid', password })
    .expect(200);
  memberId = (
    await admin
      .post('/api/members')
      .set(h())
      .send({ email: 'member@recognition.invalid', display_name: 'Member', password })
      .expect(201)
  ).body.actor_id;
  await member
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'member@recognition.invalid', password })
    .expect(200);
  company = (
    await admin
      .post('/api/customers')
      .set(h())
      .send({
        name: '已有示例工作室',
        type: 'group',
        source: 'email',
        contact_name: '王测试',
        email: 'known@163.com',
      })
      .expect(201)
  ).body.id;
  phoneCompany = (
    await admin
      .post('/api/customers')
      .set(h())
      .send({
        name: '电话示例公司',
        type: 'group',
        source: 'email',
        contact_name: '王测试',
        phone: '+1 202 555 0107',
      })
      .expect(201)
  ).body.id;
  await admin
    .put(`/api/customers/${company}/access/${memberId}`)
    .set(h())
    .send({ access: 'viewer' })
    .expect(200);
  await scoped(db, otherActor, otherWorkspace, (ctx) =>
    ctx.tx.query(
      "INSERT INTO customers(workspace_id,id,name,type,source) VALUES($1,$2,'隔离空间公司','group','email')",
      [otherWorkspace, randomUUID()],
    ),
  );
  account = (
    await admin
      .post('/api/mail/accounts')
      .set(h())
      .send({ email: 'inbox@163.com', authorization_code: 'synthetic-authorization' })
      .expect(201)
  ).body.id;
  await db.query(
    "UPDATE mail_accounts SET created_at=now()-interval '1 day',intake_mode='manual' WHERE id=$1",
    [account],
  );
  await admin.post(`/api/mail/accounts/${account}/sync`).set(h()).send({}).expect(200);
}, 30000);
afterAll(() => db.close());

it('notifies both new and known customers and labels them without guessing from public domains', async () => {
  const items = await notifications();
  expect(items).toHaveLength(samples.length);
  expect(items.find((m: { subject: string }) => m.subject === 'known')).toMatchObject({
    customer_id: company,
    customer_recognition: { kind: 'known' },
  });
  expect(items.find((m: { subject: string }) => m.subject === 'new')).toMatchObject({
    customer_id: null,
    customer_recognition: { kind: 'new', candidates: [] },
  });
  expect(items.every((m: object) => !('body' in m))).toBe(true);
});
it('uses company and phone in the body as reviewable candidates even in manual intake mode', async () => {
  for (const [subject, id] of [
    ['company', company],
    ['phone', phoneCompany],
  ]) {
    const mail = await detail(subject);
    expect(mail).toMatchObject({
      customer_id: null,
      project_id: null,
      intake_mode: 'manual',
      intake_suggestions: null,
      customer_recognition: { kind: 'possible', candidates: [{ id }] },
    });
    expect(mail.people).toEqual([]);
  }
  expect((await admin.get('/api/customers').set(h()).expect(200)).body.total).toBe(2);
});
it('leaves multiple matches and conflicting content for review instead of assigning a customer', async () => {
  const conflict = await detail('conflict');
  expect(conflict.customer_id).toBeNull();
  expect(conflict.customer_recognition.kind).toBe('ambiguous');
  expect(conflict.customer_recognition.candidates.map((c: { id: string }) => c.id).sort()).toEqual(
    [company, phoneCompany].sort(),
  );
  expect((await detail('body-conflict')).customer_recognition.kind).toBe('ambiguous');
});
it('ignores names alone and quoted history, and never exposes another workspace or unauthorized customer', async () => {
  for (const subject of ['name-only', 'quoted', 'foreign'])
    expect((await detail(subject)).customer_recognition).toMatchObject({
      kind: 'new',
      candidates: [],
    });
  const restricted = await notifications(member);
  expect(restricted).toHaveLength(1);
  expect(restricted[0].subject).toBe('known');
  const pending = await detail('company');
  await member.get(`/api/mail/messages/${pending.id}`).set(h()).expect(404);
  const evidence = {
    customer_id: null,
    customer_name: null,
    body: '公司：电话示例公司',
    sender: [{ name: '', address: 'unmatched@163.com' }],
    recipients: [],
    cc: [],
    direction: 'inbound' as const,
    account_email: 'inbox@163.com',
  };
  const result = await scoped(db, memberId, workspace, (ctx) =>
    recognizeMailCustomers(ctx, [evidence]),
  );
  expect(result[0]).toMatchObject({ kind: 'new', candidates: [] });
  const foreign = await scoped(db, otherActor, otherWorkspace, (ctx) =>
    recognizeMailCustomers(ctx, [{ ...evidence, body: '公司：已有示例工作室' }]),
  );
  expect(foreign[0]).toMatchObject({ kind: 'new', candidates: [] });
});
it('keeps suggested matches pending until the user explicitly confirms association', async () => {
  const mail = await detail('company');
  await admin
    .post(`/api/mail/messages/${mail.id}/assign`)
    .set(h())
    .send({ customer_id: company, reviewed: false })
    .expect(400);
  await admin
    .post(`/api/mail/messages/${mail.id}/assign`)
    .set(h())
    .send({ customer_id: company, reviewed: true })
    .expect(200);
  expect((await detail('company')).customer_recognition.kind).toBe('known');
  expect((await admin.get(`/api/customers/${company}`).set(h()).expect(200)).body.email_count).toBe(
    2,
  );
});
