import { beforeAll, afterAll, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWorkspace } from '../server/bootstrap.js';
import { createApp } from '../server/app.js';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import { parseMail, type MailTransport } from '../server/mail-transport.js';
import { syncAccount } from '../server/mail.js';
import { runOutgoing } from '../server/outgoing.js';
import type { OutgoingMail, ReplyOptions } from '../shared/outgoing.js';
import { mailMessageId, mailReferences } from '../shared/mail-thread.js';
const origin = 'http://localhost:3100',
  password = 'mail-reply-test-password',
  key = randomBytes(32);
let db: Database,
  admin: Agent,
  editor: Agent,
  w: string,
  actor: string,
  account: string,
  customer: string,
  other: string,
  project: string,
  person: string,
  source: string,
  outbound: string,
  unknown: string,
  foreign: string;
const sent: OutgoingMail[] = [];
const raws = [
  'From: Alice <alice@studio.example>\r\nTo: fixture@163.com, alias@163.com, teammate@example.net\r\nCc: alice@studio.example, cc@example.net, other@163.com\r\nBcc: private@example.net\r\nReply-To: service@studio.example\r\nMessage-ID: <parent@studio.example>\r\nReferences: <first@studio.example> <previous@studio.example>\r\nSubject: 样衣反馈\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n这是原邮件，不应自动转发。',
  'From: fixture@163.com\r\nTo: alice@studio.example\r\nCc: cc@example.net\r\nMessage-ID: <outbound@163.com>\r\nSubject: Re: 样衣反馈\r\n\r\nSent source',
  'From: new@unknown.example\r\nTo: fixture@163.com\r\nSubject: Unknown\r\n\r\nUnmatched source',
  'From: bob@other.example\r\nTo: fixture@163.com\r\nSubject: Other customer\r\n\r\nPrivate other source',
];
const mail: { key: Buffer; transport: MailTransport } = {
  key,
  transport: {
    async run(_input, save) {
      for (const [i, raw] of raws.entries())
        await save(
          'INBOX',
          { validity: '1', uid: i + 1 },
          await parseMail(Buffer.from(raw), new Date()),
        );
    },
  },
};
const outgoing = {
  key,
  transport: {
    async send(input: { mail: OutgoingMail }) {
      sent.push(input.mail);
    },
    async checkSent() {
      return true;
    },
  },
};
const h = () => ({ origin, 'x-workspace-id': w });
async function options(id = source, mode = 'reply') {
  return (
    await admin.get(`/api/mail/messages/${id}/reply-options`).set(h()).query({ mode }).expect(200)
  ).body as ReplyOptions;
}
async function save(plan: ReplyOptions, body = '谢谢，尺码信息已收到。') {
  return (
    await admin
      .post(`/api/${plan.kind}/${plan.target.id}/outgoing`)
      .set(h())
      .send({
        id: randomUUID(),
        version: 0,
        reply_to_message_id: plan.source_id,
        content: { ...plan.content, body },
      })
      .expect(200)
  ).body as OutgoingMail;
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Reply isolation',
    email: 'admin@reply.invalid',
    displayName: 'Admin',
    password,
  });
  w = seed.workspaceId;
  actor = seed.actorId;
  foreign = (
    await createWorkspace(db, {
      name: 'Foreign',
      email: 'foreign@reply.invalid',
      displayName: 'Foreign',
      password,
    })
  ).workspaceId;
  const app = createApp(db, { origin, mail, outgoing });
  admin = request.agent(app);
  editor = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'admin@reply.invalid', password })
    .expect(200);
  const editorId = (
    await admin
      .post('/api/members')
      .set(h())
      .send({ email: 'editor@reply.invalid', display_name: 'Editor', password })
      .expect(201)
  ).body.actor_id;
  await editor
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'editor@reply.invalid', password })
    .expect(200);
  customer = (
    await admin
      .post('/api/customers')
      .set(h())
      .send({
        name: 'Studio A',
        type: 'group',
        source: 'email',
        contact_name: 'Alice',
        email: 'alice@studio.example',
      })
      .expect(201)
  ).body.id;
  other = (
    await admin
      .post('/api/customers')
      .set(h())
      .send({
        name: 'Studio B',
        type: 'group',
        source: 'email',
        contact_name: 'Bob',
        email: 'bob@other.example',
      })
      .expect(201)
  ).body.id;
  person = (await admin.get('/api/people').set(h()).query({ customer_id: customer }).expect(200))
    .body.items[0].id;
  project = (
    await admin
      .post(`/api/customers/${customer}/projects`)
      .set(h())
      .send({ name: '样衣项目', type: 'sample' })
      .expect(201)
  ).body.id;
  await admin
    .put(`/api/customers/${customer}/access/${editorId}`)
    .set(h())
    .send({ access: 'editor' })
    .expect(200);
  account = (
    await admin
      .post('/api/mail/accounts')
      .set(h())
      .send({
        email: 'fixture@163.com',
        authorization_code: 'synthetic-authorization',
        aliases: ['alias@163.com'],
      })
      .expect(201)
  ).body.id;
  await admin
    .post('/api/mail/accounts')
    .set(h())
    .send({ email: 'other@163.com', authorization_code: 'synthetic-authorization' })
    .expect(201);
  await scoped(db, actor, w, (ctx) =>
    ctx.tx.query(
      "UPDATE mail_accounts SET created_at=now()-interval '1 day' WHERE workspace_id=$1",
      [w],
    ),
  );
  await syncAccount(db, actor, w, account, mail);
  const rows = (
    await admin.get('/api/mail/messages').set(h()).query({ pending: 'all' }).expect(200)
  ).body.items;
  source = rows.find((m: { subject: string }) => m.subject === '样衣反馈').id;
  outbound = rows.find((m: { subject: string }) => m.subject === 'Re: 样衣反馈').id;
  unknown = rows.find((m: { subject: string }) => m.subject === 'Unknown').id;
  // Unknown CC recipients deliberately prevent automatic attribution. The user
  // confirms the complete source before a reply can enter this customer scope.
  for (const id of [source, outbound])
    await admin
      .post(`/api/mail/messages/${id}/assign`)
      .set(h())
      .send({
        customer_id: customer,
        project_id: id === source ? project : null,
        person_ids: [person],
        reviewed: true,
      })
      .expect(200);
}, 30000);
afterAll(() => db?.close());
it('retains only safe reply identifiers and parses actual reply routing headers', async () => {
  const parsed = await parseMail(Buffer.from(raws[0]), new Date());
  expect(parsed.message_id).toBe('<parent@studio.example>');
  expect(parsed.reply_to?.[0].address).toBe('service@studio.example');
  expect(parsed.reference_ids).toHaveLength(2);
  expect(mailMessageId('<ok@example.com>\r\nBcc: bad@example.com')).toBeNull();
  expect(mailReferences(['<ok@example.com>', 'bad', '<ok@example.com>'])).toEqual([
    '<ok@example.com>',
  ]);
  const detail = (await admin.get(`/api/mail/messages/${source}`).set(h()).expect(200)).body;
  expect(detail.project_name).toBe('样衣项目');
  expect(detail.message_id).toBe(parsed.message_id);
});
it('prepares reply and reply-all with the source account/project and excludes own aliases and Bcc', async () => {
  const plan = await options();
  expect(plan.target.id).toBe(person);
  expect(plan.content).toMatchObject({
    account_id: account,
    project_id: project,
    to: ['service@studio.example'],
    cc: [],
    bcc: [],
    subject: 'Re: 样衣反馈',
    body: '',
    attachments: [],
  });
  const all = await options(source, 'all');
  expect(all.content.to).toEqual(['service@studio.example', 'teammate@example.net']);
  expect(all.content.cc).toEqual(['alice@studio.example', 'cc@example.net']);
  expect(JSON.stringify(all)).not.toContain('private@example.net');
  const previous = await options(outbound);
  expect(previous.content.to).toEqual(['alice@studio.example']);
  expect(previous.content.subject).toBe('Re: 样衣反馈');
});
it('enforces source visibility, confirmed customer scope, immutable reply metadata and exact draft resumption', async () => {
  await admin.get(`/api/mail/messages/${unknown}/reply-options`).set(h()).expect(409);
  await admin
    .get(`/api/mail/messages/${source}/reply-options`)
    .set({ ...h(), 'x-workspace-id': foreign })
    .expect(404);
  const otherMail = (
    await admin.get('/api/mail/messages').set(h()).query({ customer_id: other }).expect(200)
  ).body.items[0].id;
  await editor.get(`/api/mail/messages/${otherMail}/reply-options`).set(h()).expect(404);
  const plan = await options();
  const draft = await save(plan);
  const bad = await admin
    .post(`/api/${plan.kind}/${plan.target.id}/outgoing`)
    .set(h())
    .send({
      id: randomUUID(),
      version: 0,
      content: { ...plan.content, body: 'test' },
      reply_to_message_id: otherMail,
    });
  expect(bad.status).toBe(404);
  await expect(
    scoped(db, actor, w, (ctx) =>
      ctx.tx.query('UPDATE outgoing_mail SET in_reply_to=$1 WHERE workspace_id=$2 AND id=$3', [
        '<fake@example.com>',
        w,
        draft.id,
      ]),
    ),
  ).rejects.toThrow();
  await admin
    .get(`/api/mail/messages/${outbound}/reply-options`)
    .set(h())
    .query({ draft_id: draft.id })
    .expect(404);
  expect(
    (
      await admin
        .get(`/api/mail/messages/${source}/reply-options`)
        .set(h())
        .query({ draft_id: draft.id })
        .expect(200)
    ).body.target.id,
  ).toBe(person);
  expect(
    (await admin.get(`/api/mail/messages/${source}/replies`).set(h()).expect(200)).body.some(
      (r: { id: string }) => r.id === draft.id,
    ),
  ).toBe(true);
  expect(
    (await editor.get(`/api/mail/messages/${source}/replies`).set(h()).expect(200)).body,
  ).toEqual([]);
});
it('requires content confirmation, invalidates approval after edits, and submits a reply once into all related records', async () => {
  const plan = await options();
  let draft = await save(plan);
  await admin
    .post(`/api/outgoing/${draft.id}/schedule`)
    .set(h())
    .send({ version: draft.version, mode: 'now', timezone: 'Asia/Shanghai' })
    .expect(409);
  await admin
    .post(`/api/outgoing/${draft.id}/approve`)
    .set(h())
    .send({ version: draft.version })
    .expect(200);
  draft = (
    await admin
      .post(`/api/${plan.kind}/${plan.target.id}/outgoing`)
      .set(h())
      .send({
        id: draft.id,
        version: draft.version,
        reply_to_message_id: source,
        content: { ...plan.content, body: '谢谢，请确认下一步。' },
      })
      .expect(200)
  ).body;
  expect(draft.status).toBe('draft');
  expect(draft.approved_version).toBeNull();
  await admin
    .post(`/api/outgoing/${draft.id}/approve`)
    .set(h())
    .send({ version: draft.version })
    .expect(200);
  await admin
    .post(`/api/outgoing/${draft.id}/schedule`)
    .set(h())
    .send({ version: draft.version, mode: 'now', timezone: 'Asia/Shanghai' })
    .expect(200);
  await runOutgoing(db, outgoing);
  await runOutgoing(db, outgoing);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    in_reply_to: '<parent@studio.example>',
    reference_ids: [
      '<first@studio.example>',
      '<previous@studio.example>',
      '<parent@studio.example>',
    ],
    reply_to_message_id: source,
    body: '谢谢，请确认下一步。',
    attachments: [],
  });
  for (const filter of [
    { customer_id: customer },
    { person_id: person },
    { customer_id: customer, project_id: project },
  ]) {
    const rows = (await admin.get('/api/mail/messages').set(h()).query(filter).expect(200)).body
      .items;
    expect(rows.some((m: { preview: string }) => m.preview === '谢谢，请确认下一步。')).toBe(true);
  }
});
it('keeps read state and manual project assignment on re-sync, and handles legacy sources without fabricating headers', async () => {
  const before = (
    await admin.get('/api/mail/messages').set(h()).query({ pending: 'all' }).expect(200)
  ).body.total;
  await admin.post(`/api/mail/messages/${source}/read`).set(h()).send({}).expect(200);
  await syncAccount(db, actor, w, account, mail);
  const after = (
    await admin.get('/api/mail/messages').set(h()).query({ pending: 'all' }).expect(200)
  ).body;
  expect(after.total).toBe(before);
  expect(after.items.find((m: { id: string }) => m.id === source)).toMatchObject({
    project_id: project,
    unread: false,
  });
  await scoped(db, actor, w, (ctx) =>
    ctx.tx.query(
      'UPDATE mail_messages SET message_id=NULL,reference_ids=$3::jsonb WHERE workspace_id=$1 AND id=$2',
      [w, outbound, '[]'],
    ),
  );
  const legacy = await save(await options(outbound));
  expect(legacy.in_reply_to).toBeNull();
  expect(legacy.reference_ids).toEqual([]);
});
it('rechecks source exclusions at send time instead of sending from a no-longer-visible source', async () => {
  const draft = await save(await options());
  await admin
    .post(`/api/outgoing/${draft.id}/approve`)
    .set(h())
    .send({ version: draft.version })
    .expect(200);
  await admin
    .post(`/api/outgoing/${draft.id}/schedule`)
    .set(h())
    .send({ version: draft.version, mode: 'now', timezone: 'Asia/Shanghai' })
    .expect(200);
  const exclusion = (await admin.get('/api/mail/exclusions').set(h()).expect(200)).body;
  await admin
    .put('/api/mail/exclusions')
    .set(h())
    .send({ rules: ['alice@studio.example'], version: exclusion.version, reviewed: true })
    .expect(200);
  await runOutgoing(db, outgoing);
  expect(sent).toHaveLength(1);
  expect((await admin.get(`/api/outgoing/${draft.id}`).set(h()).expect(200)).body.status).toBe(
    'needs_review',
  );
  await admin.get(`/api/mail/messages/${source}/reply-options`).set(h()).expect(404);
});
