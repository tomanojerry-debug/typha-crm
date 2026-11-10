import { beforeAll, afterAll, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import { runOutgoing, type OutgoingOptions } from '../server/outgoing.js';
import { SubmissionError, type SendTransport } from '../server/smtp-transport.js';
import { syncAccount } from '../server/mail.js';
import type { OutgoingContent, OutgoingMail } from '../shared/outgoing.js';
const origin = 'http://localhost:3100',
  password = 'outgoing-fixture-password',
  key = randomBytes(32);
let db: Database,
  admin: Agent,
  editor: Agent,
  w: string,
  actor: string,
  editorId: string,
  a: string,
  b: string,
  p: string,
  account: string,
  projectId: string,
  otherProject: string;
let sent: OutgoingMail[] = [],
  failure: Error | null = null,
  found = true;
const transport: SendTransport = {
  async send(input) {
    expect(input.password).toBe('synthetic-authorization');
    if (failure) throw failure;
    sent.push(input.mail);
  },
  async checkSent() {
    return found;
  },
};
const options: OutgoingOptions = { key, transport };
const headers = () => ({ origin, 'x-workspace-id': w });
const content = (patch: Partial<OutgoingContent> = {}): OutgoingContent => ({
  account_id: account,
  project_id: projectId,
  to: ['alice@example.com'],
  cc: [],
  bcc: [],
  subject: '样衣确认（合成测试）',
  body: '请核对样衣尺寸。',
  attachments: [],
  ...patch,
});
async function draft(patch: Partial<OutgoingContent> = {}, kind = 'people', target = p) {
  return (
    await admin
      .post(`/api/${kind}/${target}/outgoing`)
      .set(headers())
      .send({ id: randomUUID(), version: 0, content: content(patch) })
      .expect(200)
  ).body as OutgoingMail;
}
async function approve(r: OutgoingMail) {
  return (
    await admin
      .post(`/api/outgoing/${r.id}/approve`)
      .set(headers())
      .send({ version: r.version })
      .expect(200)
  ).body as OutgoingMail;
}
async function schedule(r: OutgoingMail, at?: string) {
  return (
    await admin
      .post(`/api/outgoing/${r.id}/schedule`)
      .set(headers())
      .send({
        version: r.version,
        mode: at ? 'later' : 'now',
        timezone: 'Asia/Shanghai',
        ...(at ? { at } : {}),
      })
      .expect(200)
  ).body as OutgoingMail;
}
async function get(r: OutgoingMail) {
  return (await admin.get(`/api/outgoing/${r.id}`).set(headers()).expect(200)).body as OutgoingMail;
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Outgoing fixtures',
    email: 'outgoing@example.com',
    password,
    displayName: 'Admin',
  });
  w = seed.workspaceId;
  actor = seed.actorId;
  const app = createApp(db, { origin, mail: { key }, outgoing: options });
  admin = request.agent(app);
  editor = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'outgoing@example.com', password })
    .expect(200);
  editorId = (
    await admin
      .post('/api/members')
      .set(headers())
      .send({ email: 'editor-outgoing@example.com', display_name: 'Editor', password })
      .expect(201)
  ).body.actor_id;
  await editor
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'editor-outgoing@example.com', password })
    .expect(200);
  a = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({
        name: 'Studio A',
        type: 'group',
        source: 'email',
        contact_name: 'Alice',
        email: 'alice@example.com',
      })
      .expect(201)
  ).body.id;
  b = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({
        name: 'Studio B',
        type: 'group',
        source: 'email',
        contact_name: 'Bob',
        email: 'bob@example.com',
      })
      .expect(201)
  ).body.id;
  p = (await admin.get('/api/people').set(headers()).query({ customer_id: a }).expect(200)).body
    .items[0].id;
  projectId = (
    await admin
      .post(`/api/customers/${a}/projects`)
      .set(headers())
      .send({ name: '样衣', type: 'custom', stage: 'new' })
      .expect(201)
  ).body.id;
  otherProject = (
    await admin
      .post(`/api/customers/${b}/projects`)
      .set(headers())
      .send({ name: '其他样衣', type: 'custom', stage: 'new' })
      .expect(201)
  ).body.id;
  account = (
    await admin
      .post('/api/mail/accounts')
      .set(headers())
      .send({ email: 'fixture@163.com', authorization_code: 'synthetic-authorization' })
      .expect(201)
  ).body.id;
  await admin
    .put(`/api/customers/${a}/access/${editorId}`)
    .set(headers())
    .send({ access: 'editor' })
    .expect(200);
}, 30000);
afterAll(() => db?.close());
it('keeps recipient search, drafts and projects inside authorized scopes', async () => {
  const visible = (
    await editor.get(`/api/people/${p}/recipient-options`).set(headers()).expect(200)
  ).body;
  expect(visible.map((r: { email: string }) => r.email)).toEqual(['alice@example.com']);
  const r = await draft();
  await editor.get(`/api/outgoing/${r.id}`).set(headers()).expect(404);
  await editor
    .post(`/api/outgoing/${r.id}/approve`)
    .set(headers())
    .send({ version: r.version })
    .expect(404);
  expect(
    (await editor.get(`/api/people/${p}/compose-options`).set(headers()).expect(200)).body.accounts,
  ).toEqual([]);
  await admin
    .post(`/api/people/${p}/outgoing`)
    .set(headers())
    .send({ id: randomUUID(), version: 0, content: content({ project_id: otherProject }) })
    .expect(404);
  await expect(
    scoped(db, actor, w, (ctx) =>
      ctx.tx.query('UPDATE outgoing_mail SET project_id=$1 WHERE id=$2', [otherProject, r.id]),
    ),
  ).rejects.toThrow();
  await expect(
    scoped(db, actor, w, (ctx) =>
      ctx.tx.query('UPDATE outgoing_mail SET customer_id=$1 WHERE id=$2', [b, r.id]),
    ),
  ).rejects.toThrow();
  expect(
    (
      await scoped(db, editorId, w, (ctx) =>
        ctx.tx.query('SELECT * FROM outgoing_mail WHERE id=$1', [r.id]),
      )
    ).rows,
  ).toHaveLength(0);
  await admin
    .get(`/api/outgoing/${r.id}`)
    .set({ ...headers(), 'x-workspace-id': randomUUID() })
    .expect(404);
});
it('does not send a draft without explicit content confirmation and time selection', async () => {
  const r = await draft();
  await admin
    .post(`/api/outgoing/${r.id}/schedule`)
    .set(headers())
    .send({ version: r.version, mode: 'now', timezone: 'Asia/Shanghai' })
    .expect(409);
  await approve(r);
  await runOutgoing(db, options);
  expect(sent).toHaveLength(0);
  await admin
    .post(`/api/outgoing/${r.id}/schedule`)
    .set(headers())
    .send({
      version: r.version,
      mode: 'later',
      at: new Date(Date.now() - 10000).toISOString(),
      timezone: 'Asia/Shanghai',
    })
    .expect(400);
  await admin
    .post(`/api/outgoing/${r.id}/schedule`)
    .set(headers())
    .send({ version: r.version, mode: 'later', timezone: 'Asia/Shanghai' })
    .expect(400);
});
it('sends the confirmed payload once, including multiple recipients and attachments, then reconciles', async () => {
  const r = await draft({
    to: ['alice@example.com', 'bob@example.com', 'new@example.net'],
    cc: ['cc@example.net'],
    bcc: ['private@example.net'],
    attachments: [{ name: '规格.txt', content: Buffer.from('样衣 120').toString('base64') }],
  });
  await approve(r);
  const queued = await schedule(r);
  const duplicate = await schedule(r);
  expect(duplicate.message_id).toBe(queued.message_id);
  const before = sent.length;
  await Promise.all([runOutgoing(db, options), runOutgoing(db, options)]);
  expect(sent).toHaveLength(before + 1);
  expect(sent.at(-1)).toMatchObject({
    ...content({ to: r.to, cc: r.cc, bcc: r.bcc, attachments: r.attachments }),
    message_id: queued.message_id,
  });
  expect((await get(r)).status).toBe('submitted');
  await schedule(r);
  await runOutgoing(db, options);
  expect(sent).toHaveLength(before + 1);
  const timeline = (
    await admin
      .get('/api/mail/messages')
      .set(headers())
      .query({ customer_id: a, person_id: p })
      .expect(200)
  ).body;
  expect(timeline.total).toBe(1);
  expect(JSON.stringify(timeline)).not.toContain('private@example.net');
  expect(timeline.items[0].project_id).toBe(projectId);
  const checked = (
    await admin
      .post(`/api/outgoing/${r.id}/reconcile`)
      .set(headers())
      .send({ version: r.version })
      .expect(200)
  ).body;
  expect(checked.status).toBe('sent_confirmed');
  await admin
    .post(`/api/people/${p}/outgoing`)
    .set(headers())
    .send({ id: r.id, version: r.version, content: content({ body: 'changed' }) })
    .expect(409);
  await admin
    .post(`/api/outgoing/${r.id}/cancel`)
    .set(headers())
    .send({ version: r.version })
    .expect(409);
});
it('does not import a second copy of a CRM message from IMAP', async () => {
  const message = sent[0];
  await syncAccount(db, actor, w, account, {
    key,
    transport: {
      async run(_input, save, discovered) {
        await discovered('Sent');
        await save(
          'Sent',
          { validity: '1', uid: 1 },
          {
            message_id: message.message_id,
            fingerprint: 'different-raw-hash',
            subject: message.subject,
            sender: [{ address: 'fixture@163.com', name: '' }],
            recipients: message.to.map((address) => ({ address, name: '' })),
            cc: [],
            participants: ['fixture@163.com', ...message.to],
            occurred_at: new Date().toISOString(),
            body: message.body,
            body_notice: null,
            attachments: [],
          },
        );
      },
    },
  });
  expect(
    (
      await admin
        .get('/api/mail/messages')
        .set(headers())
        .query({ customer_id: a, person_id: p })
        .expect(200)
    ).body.total,
  ).toBe(1);
});
it('persists future schedules, invalidates approval on editing and rejects stale versions', async () => {
  const r = await draft();
  await approve(r);
  const at = new Date(Date.now() + 3600000).toISOString();
  await schedule(r, at);
  const before = sent.length;
  await runOutgoing(db, options);
  expect(sent).toHaveLength(before);
  expect(new Date((await get(r)).scheduled_at!).toISOString()).toBe(at);
  const edited = (
    await admin
      .post(`/api/people/${p}/outgoing`)
      .set(headers())
      .send({
        id: r.id,
        version: r.version,
        content: content({ body: '新的尺寸', attachments: [{ name: 'new.txt', content: 'YQ==' }] }),
      })
      .expect(200)
  ).body;
  expect(edited).toMatchObject({
    version: 2,
    status: 'draft',
    approved_version: null,
    scheduled_at: null,
    message_id: null,
  });
  await admin.post(`/api/outgoing/${r.id}/approve`).set(headers()).send({ version: 1 }).expect(409);
  await admin
    .post(`/api/outgoing/${r.id}/schedule`)
    .set(headers())
    .send({ version: 2, mode: 'now', timezone: 'Asia/Shanghai' })
    .expect(409);
});
it('cancels pending sends and blocks archived or revoked senders', async () => {
  const r = await draft();
  await approve(r);
  await schedule(r);
  await admin
    .post(`/api/outgoing/${r.id}/cancel`)
    .set(headers())
    .send({ version: r.version })
    .expect(200);
  const before = sent.length;
  await runOutgoing(db, options);
  expect(sent).toHaveLength(before);
  const queued = await draft();
  await approve(queued);
  await schedule(queued);
  let contact = (await admin.get(`/api/people/${p}`).set(headers()).expect(200)).body;
  contact = (
    await admin
      .patch(`/api/people/${p}`)
      .set(headers())
      .send({ version: contact.version, archived: true })
      .expect(200)
  ).body;
  expect((await get(queued)).status).toBe('needs_review');
  await admin
    .patch(`/api/people/${p}`)
    .set(headers())
    .send({ version: contact.version, archived: false })
    .expect(200);
  await runOutgoing(db, options);
  expect(sent).toHaveLength(before);
  const revoked = await draft();
  await approve(revoked);
  await schedule(revoked);
  await db.query('UPDATE memberships SET active=false WHERE workspace_id=$1 AND actor_id=$2', [
    w,
    actor,
  ]);
  await runOutgoing(db, options);
  expect(sent).toHaveLength(before);
  await db.query('UPDATE memberships SET active=true WHERE workspace_id=$1 AND actor_id=$2', [
    w,
    actor,
  ]);
  expect((await get(revoked)).status).toBe('needs_review');
});
it('keeps ambiguous sends locked and never retries when the sent copy is absent', async () => {
  const r = await draft();
  await approve(r);
  await schedule(r);
  failure = new Error('private transport failure');
  await runOutgoing(db, options);
  failure = null;
  expect((await get(r)).status).toBe('uncertain');
  expect((await get(r)).error).not.toContain('private transport');
  const before = sent.length;
  await runOutgoing(db, options);
  expect(sent).toHaveLength(before);
  await admin
    .post(`/api/outgoing/${r.id}/approve`)
    .set(headers())
    .send({ version: r.version })
    .expect(409);
  found = false;
  expect(
    (
      await admin
        .post(`/api/outgoing/${r.id}/reconcile`)
        .set(headers())
        .send({ version: r.version })
        .expect(200)
    ).body.status,
  ).toBe('uncertain');
  found = true;
  expect(
    (
      await admin
        .post(`/api/outgoing/${r.id}/reconcile`)
        .set(headers())
        .send({ version: r.version })
        .expect(200)
    ).body.status,
  ).toBe('sent_confirmed');
});
it('requires fresh confirmation for definite failures and overdue schedules', async () => {
  const r = await draft();
  await approve(r);
  await schedule(r);
  failure = new SubmissionError('邮箱拒绝发送', true);
  await runOutgoing(db, options);
  failure = null;
  expect((await get(r)).status).toBe('failed');
  await admin
    .post(`/api/outgoing/${r.id}/schedule`)
    .set(headers())
    .send({ version: r.version, mode: 'now', timezone: 'Asia/Shanghai' })
    .expect(409);
  const overdue = await draft();
  await approve(overdue);
  await schedule(overdue);
  await scoped(db, actor, w, (ctx) =>
    ctx.tx.query("UPDATE outgoing_mail SET scheduled_at=now()-interval '16 minutes' WHERE id=$1", [
      overdue.id,
    ]),
  );
  await runOutgoing(db, options);
  expect((await get(overdue)).status).toBe('needs_review');
});
it('recovers a process interruption as uncertain and supports company-only mail without a fake person', async () => {
  const r = await draft({}, 'customers', a);
  expect(r.person_id).toBeNull();
  await expect(
    scoped(db, actor, w, (ctx) =>
      ctx.tx.query('UPDATE outgoing_mail SET person_id=$1 WHERE id=$2', [p, r.id]),
    ),
  ).rejects.toThrow('outgoing scope is immutable');
  const personDraft = await draft();
  await expect(
    scoped(db, actor, w, (ctx) =>
      ctx.tx.query('UPDATE outgoing_mail SET person_id=NULL WHERE id=$1', [personDraft.id]),
    ),
  ).rejects.toThrow('outgoing scope is immutable');
  await approve(r);
  await schedule(r);
  await scoped(db, actor, w, (ctx) =>
    ctx.tx.query(
      "UPDATE outgoing_mail SET status='sending',started_at=now()-interval '11 minutes' WHERE id=$1",
      [r.id],
    ),
  );
  const before = sent.length;
  await runOutgoing(db, options);
  expect(sent).toHaveLength(before);
  expect((await get(r)).status).toBe('uncertain');
  const company = await draft({ project_id: null }, 'customers', a);
  await approve(company);
  await schedule(company);
  await runOutgoing(db, options);
  expect((await get(company)).status).toBe('submitted');
  expect(
    (await admin.get(`/api/customers/${a}/outgoing`).set(headers()).expect(200)).body.some(
      (x: { id: string }) => x.id === company.id,
    ),
  ).toBe(true);
});
it('validates recipients, attachments, sender scope and duplicate draft creation', async () => {
  const id = randomUUID();
  const first = (
    await admin
      .post(`/api/people/${p}/outgoing`)
      .set(headers())
      .send({ id, version: 0, content: content() })
      .expect(200)
  ).body;
  expect(
    (
      await admin
        .post(`/api/people/${p}/outgoing`)
        .set(headers())
        .send({ id, version: 0, content: content() })
        .expect(200)
    ).body.id,
  ).toBe(first.id);
  for (const patch of [
    { to: ['bad-address'] },
    { attachments: [{ name: 'bad.txt', content: '@@' }] },
    { subject: 'hello\r\nBcc: bad@example.com' },
  ])
    await admin
      .post(`/api/people/${p}/outgoing`)
      .set(headers())
      .send({ id: randomUUID(), version: 0, content: content(patch) })
      .expect(400);
  await admin
    .post(`/api/people/${p}/outgoing`)
    .set(headers())
    .send({ id: randomUUID(), version: 0, content: content({ account_id: randomUUID() }) })
    .expect(409);
  const duplicate = await draft({ cc: ['alice@example.com'] });
  await admin
    .post(`/api/outgoing/${duplicate.id}/approve`)
    .set(headers())
    .send({ version: 1 })
    .expect(400);
  const noBody = await draft({ body: '' });
  await admin
    .post(`/api/outgoing/${noBody.id}/approve`)
    .set(headers())
    .send({ version: 1 })
    .expect(400);
});

it('rejects changed version-zero retries instead of reporting stale content as a saved edit', async () => {
  const r = await draft();
  const original = content();
  const identical = (
    await admin
      .post(`/api/people/${p}/outgoing`)
      .set(headers())
      .send({ id: r.id, version: 0, content: original })
      .expect(200)
  ).body;
  expect(identical).toMatchObject({ id: r.id, version: r.version, body: original.body });
  for (const patch of [
    { body: '这是首次保存响应丢失后新增的编辑。' },
    { subject: '另一个主题' },
    { project_id: null },
    { account_id: null },
    { to: ['another@example.net'] },
    { attachments: [{ name: 'edited.txt', content: 'YQ==' }] },
  ] satisfies Partial<OutgoingContent>[]) {
    await admin
      .post(`/api/people/${p}/outgoing`)
      .set(headers())
      .send({ id: r.id, version: 0, content: content(patch) })
      .expect(409);
  }
  expect(await get(r)).toMatchObject({
    id: r.id,
    version: r.version,
    status: 'draft',
    body: original.body,
    subject: original.subject,
    project_id: projectId,
    account_id: account,
    to: original.to,
    attachments: [],
  });
});

it('keeps a confirmed future schedule unchanged when a stale create retry has different edits', async () => {
  const r = await draft();
  await approve(r);
  const at = new Date(Date.now() + 3600000).toISOString();
  const queued = await schedule(r, at);
  await admin
    .post(`/api/people/${p}/outgoing`)
    .set(headers())
    .send({ id: r.id, version: 0, content: content({ body: '尚未确认的新编辑' }) })
    .expect(409);
  expect(await get(r)).toMatchObject({
    id: r.id,
    version: r.version,
    status: 'scheduled',
    approved_version: r.version,
    body: r.body,
    message_id: queued.message_id,
  });
  expect(new Date((await get(r)).scheduled_at!).toISOString()).toBe(at);
  const identical = (
    await admin
      .post(`/api/people/${p}/outgoing`)
      .set(headers())
      .send({ id: r.id, version: 0, content: content() })
      .expect(200)
  ).body;
  expect(identical.message_id).toBe(queued.message_id);
  await admin
    .post(`/api/outgoing/${r.id}/cancel`)
    .set(headers())
    .send({ version: r.version })
    .expect(200);
});

it('sends mass mail as independent copies, keeps per-recipient results and links only matching People', async () => {
  const second = (
    await admin
      .post('/api/people')
      .set(headers())
      .send({ customer_id: a, name: 'Ann', email: 'ann@example.com' })
      .expect(201)
  ).body.id;
  const r = await draft({
    mass_sending: true,
    to: ['alice@example.com', 'ann@example.com'],
    attachments: [{ name: 'info.txt', content: 'YQ==' }],
  });
  await approve(r);
  const queued = await schedule(r);
  expect(queued.deliveries).toHaveLength(2);
  expect(new Set(queued.deliveries!.map((d) => d.message_id)).size).toBe(2);
  expect((await schedule(r)).deliveries).toEqual(queued.deliveries);
  const before = sent.length;
  await Promise.all([runOutgoing(db, options), runOutgoing(db, options)]);
  const copies = sent.slice(before);
  expect(copies).toHaveLength(2);
  expect(copies.map((m) => m.to)).toEqual([['alice@example.com'], ['ann@example.com']]);
  for (const m of copies)
    expect(m).toMatchObject({
      cc: [],
      bcc: [],
      subject: r.subject,
      body: r.body,
      attachments: r.attachments,
      project_id: projectId,
      customer_id: a,
    });
  expect((await get(r)).deliveries!.map((d) => d.status)).toEqual(['submitted', 'submitted']);
  for (const [personId, email] of [
    [p, 'alice@example.com'],
    [second, 'ann@example.com'],
  ]) {
    const messages = (
      await admin
        .get('/api/mail/messages')
        .set(headers())
        .query({ customer_id: a, person_id: personId })
        .expect(200)
    ).body.items.filter((m: { attachments: { name: string }[] }) =>
      m.attachments.some((a) => a.name === 'info.txt'),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].recipients).toEqual([{ address: email, name: '' }]);
  }
  await schedule(r);
  await runOutgoing(db, options);
  expect(sent).toHaveLength(before + 2);
  const reconciled = (
    await admin
      .post(`/api/outgoing/${r.id}/reconcile`)
      .set(headers())
      .send({ version: r.version })
      .expect(200)
  ).body;
  expect(reconciled.status).toBe('sent_confirmed');
  expect(reconciled.deliveries.map((d: { status: string }) => d.status)).toEqual([
    'sent_confirmed',
    'sent_confirmed',
  ]);
  await editor.get(`/api/outgoing/${r.id}`).set(headers()).expect(404);
  expect(
    (
      await scoped(db, editorId, w, (ctx) =>
        ctx.tx.query('SELECT * FROM outgoing_deliveries WHERE outgoing_id=$1', [r.id]),
      )
    ).rows,
  ).toEqual([]);
  await expect(
    scoped(db, actor, w, (ctx) =>
      ctx.tx.query('UPDATE outgoing_deliveries SET customer_id=$1 WHERE outgoing_id=$2', [b, r.id]),
    ),
  ).rejects.toThrow();
});
it('binds mass mode to the reviewed version, cancels pending copies and rejects CC and other-customer mass mail', async () => {
  await admin
    .post(`/api/people/${p}/outgoing`)
    .set(headers())
    .send({
      id: randomUUID(),
      version: 0,
      content: content({ mass_sending: true, cc: ['cc@example.com'] }),
    })
    .expect(400);
  const foreign = await draft({ mass_sending: true, to: ['alice@example.com', 'bob@example.com'] });
  await admin
    .post(`/api/outgoing/${foreign.id}/approve`)
    .set(headers())
    .send({ version: 1 })
    .expect(400);
  const choices = (
    await admin
      .get(`/api/people/${p}/recipient-options`)
      .set(headers())
      .query({ mass: 'true' })
      .expect(200)
  ).body;
  expect(choices.some((c: { email: string }) => c.email === 'bob@example.com')).toBe(false);
  const r = await draft({ mass_sending: true, to: ['alice@example.com', 'ann@example.com'] });
  await approve(r);
  await schedule(r, new Date(Date.now() + 3600000).toISOString());
  const edited = (
    await admin
      .post(`/api/people/${p}/outgoing`)
      .set(headers())
      .send({ id: r.id, version: r.version, content: { ...content(), mass_sending: false } })
      .expect(200)
  ).body;
  expect(edited).toMatchObject({
    version: 2,
    status: 'draft',
    approved_version: null,
    scheduled_at: null,
  });
  const before = sent.length;
  await runOutgoing(db, options);
  expect(sent).toHaveLength(before);
  await admin
    .post(`/api/outgoing/${r.id}/schedule`)
    .set(headers())
    .send({ version: 2, mode: 'now', timezone: 'Asia/Shanghai' })
    .expect(409);
  const cancelled = await draft({ mass_sending: true });
  await approve(cancelled);
  await schedule(cancelled);
  await admin
    .post(`/api/outgoing/${cancelled.id}/cancel`)
    .set(headers())
    .send({ version: 1 })
    .expect(200);
  await runOutgoing(db, options);
  expect(sent).toHaveLength(before);
});
it('stops mass sending on ambiguity and never retries accepted or uncertain copies', async () => {
  const r = await draft({
    mass_sending: true,
    to: ['alice@example.com', 'ann@example.com', 'new@example.net'],
  });
  await approve(r);
  await schedule(r);
  let calls = 0;
  const failing = {
    key,
    transport: {
      ...transport,
      async send(input: { mail: OutgoingMail }) {
        calls++;
        if (calls === 2) throw new Error('private network failure');
        sent.push(input.mail);
      },
    },
  };
  await runOutgoing(db, failing);
  const result = await get(r);
  expect(result.status).toBe('uncertain');
  expect(result.deliveries!.map((d) => d.status)).toEqual(['submitted', 'uncertain', 'stopped']);
  expect(JSON.stringify(result)).not.toContain('private network failure');
  await runOutgoing(db, failing);
  expect(calls).toBe(2);
  await admin.post(`/api/outgoing/${r.id}/approve`).set(headers()).send({ version: 1 }).expect(409);
  found = false;
  await admin
    .post(`/api/outgoing/${r.id}/reconcile`)
    .set(headers())
    .send({ version: 1 })
    .expect(200);
  expect((await get(r)).status).toBe('uncertain');
  found = true;
  const checked = (
    await admin
      .post(`/api/outgoing/${r.id}/reconcile`)
      .set(headers())
      .send({ version: 1 })
      .expect(200)
  ).body;
  expect(checked.status).toBe('partial');
  expect(checked.deliveries.map((d: { status: string }) => d.status)).toEqual([
    'sent_confirmed',
    'sent_confirmed',
    'stopped',
  ]);
  await schedule(r);
  await runOutgoing(db, failing);
  expect(calls).toBe(2);
});
it('recovers mass interruptions without guessing that pending copies were sent', async () => {
  const r = await draft({ mass_sending: true, to: ['alice@example.com', 'ann@example.com'] });
  await approve(r);
  await schedule(r);
  await scoped(db, actor, w, async (ctx) => {
    await ctx.tx.query(
      "UPDATE outgoing_mail SET status='sending',started_at=now()-interval '11 minutes' WHERE id=$1",
      [r.id],
    );
    await ctx.tx.query(
      "UPDATE outgoing_deliveries SET status='sending' WHERE outgoing_id=$1 AND recipient='alice@example.com'",
      [r.id],
    );
  });
  const before = sent.length;
  await runOutgoing(db, options);
  expect(sent).toHaveLength(before);
  expect((await get(r)).deliveries!.map((d) => d.status)).toEqual(['uncertain', 'stopped']);
  expect((await get(r)).status).toBe('uncertain');
});
it('checks permissions between independent copies and keeps partial completion locked', async () => {
  const r = await draft({ mass_sending: true, to: ['alice@example.com', 'ann@example.com'] });
  await approve(r);
  await schedule(r);
  let calls = 0;
  await runOutgoing(db, {
    key,
    transport: {
      ...transport,
      async send() {
        calls++;
        await db.query(
          'UPDATE memberships SET active=false WHERE workspace_id=$1 AND actor_id=$2',
          [w, actor],
        );
      },
    },
  });
  await db.query('UPDATE memberships SET active=true WHERE workspace_id=$1 AND actor_id=$2', [
    w,
    actor,
  ]);
  expect(calls).toBe(1);
  expect((await get(r)).status).toBe('partial');
  expect((await get(r)).deliveries!.map((d) => d.status)).toEqual(['submitted', 'stopped']);
  await admin
    .post(`/api/people/${p}/outgoing`)
    .set(headers())
    .send({ id: r.id, version: 1, content: content({ body: 'changed' }) })
    .expect(409);
});
it('deduplicates each mass sent copy when IMAP sees the same Message-ID', async () => {
  const r = await draft({ mass_sending: true, to: ['alice@example.com', 'ann@example.com'] });
  await approve(r);
  await schedule(r);
  await runOutgoing(db, options);
  const copies = (await get(r)).deliveries!;
  const before = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM mail_messages'))
    .rows[0].n;
  await syncAccount(db, actor, w, account, {
    key,
    transport: {
      async run(_input, save) {
        for (const [i, d] of copies.entries())
          await save(
            'Sent',
            { validity: 'mass', uid: i + 101 },
            {
              message_id: d.message_id,
              fingerprint: `raw-mass-${i}`,
              subject: r.subject,
              sender: [{ address: 'fixture@163.com', name: '' }],
              recipients: [{ address: d.recipient, name: '' }],
              cc: [],
              participants: ['fixture@163.com', d.recipient],
              occurred_at: new Date().toISOString(),
              body: r.body,
              body_notice: null,
              attachments: [],
            },
          );
      },
    },
  });
  expect(
    (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM mail_messages')).rows[0].n,
  ).toBe(before);
});
it('allows a freshly confirmed retry only when every mass copy is definitely unsent', async () => {
  const r = await draft({ mass_sending: true, to: ['alice@example.com', 'ann@example.com'] });
  await approve(r);
  const old = await schedule(r);
  failure = new SubmissionError('授权失败，未投递', true);
  await runOutgoing(db, options);
  failure = null;
  expect((await get(r)).status).toBe('failed');
  expect((await get(r)).deliveries!.map((d) => d.status)).toEqual(['failed', 'stopped']);
  await admin
    .post(`/api/outgoing/${r.id}/schedule`)
    .set(headers())
    .send({ version: 1, mode: 'now', timezone: 'Asia/Shanghai' })
    .expect(409);
  await approve(r);
  const queued = await schedule(r);
  expect(queued.message_id).not.toBe(old.message_id);
  const before = sent.length;
  await runOutgoing(db, options);
  expect(sent).toHaveLength(before + 2);
  expect((await get(r)).status).toBe('submitted');
});
it('uses only the trusted business clock for scheduling boundaries without changing global time', async () => {
  const realNow = Date.now;
  const reference = Date.parse('2020-01-01T01:00:00+08:00');
  let reads = 0;
  options.clock = () => {
    reads++;
    return reference;
  };
  try {
    const r = await approve(await draft());
    const payload = {
      version: r.version,
      mode: 'later',
      timezone: 'Asia/Shanghai',
    };
    for (const at of [reference, reference - 1, reference + 366 * 86400000 + 1]) {
      await admin
        .post(`/api/outgoing/${r.id}/schedule`)
        .set(headers())
        .send({ ...payload, at: new Date(at).toISOString() })
        .expect(400);
      expect((await get(r)).status).toBe('approved');
    }
    await admin
      .post(`/api/outgoing/${r.id}/schedule`)
      .set(headers())
      .send({ ...payload, at: new Date(reference + 60000).toISOString(), clock: reference })
      .expect(400);
    expect(reads).toBe(3);
    const upper = await schedule(r, new Date(reference + 366 * 86400000).toISOString());
    expect(new Date(upper.scheduled_at!).getTime()).toBe(reference + 366 * 86400000);
    expect(reads).toBe(4);
    await admin
      .post(`/api/outgoing/${r.id}/cancel`)
      .set(headers())
      .send({ version: r.version })
      .expect(200);
    const immediate = await schedule(await approve(await draft()));
    expect(new Date(immediate.scheduled_at!).getTime()).toBe(reference);
    await admin
      .post(`/api/outgoing/${immediate.id}/cancel`)
      .set(headers())
      .send({ version: immediate.version })
      .expect(200);
    expect(Date.now).toBe(realNow);
    expect(new Date().getFullYear()).toBeGreaterThan(2020);
  } finally {
    delete options.clock;
  }
});
it('checks worker lateness against its trusted clock and refuses invalid clocks before effects', async () => {
  const reference = Date.parse('2020-01-01T01:00:00+08:00');
  options.clock = () => reference;
  try {
    const eligible = await schedule(
      await approve(await draft()),
      new Date(reference + 60000).toISOString(),
    );
    await expect(runOutgoing(db, { ...options, clock: () => Number.NaN })).rejects.toThrow(
      '邮件业务时间配置无效',
    );
    expect((await get(eligible)).status).toBe('scheduled');
    expect(sent.filter((mail) => mail.id === eligible.id)).toHaveLength(0);
    await runOutgoing(db, { ...options, clock: () => reference + 60000 });
    expect((await get(eligible)).status).toBe('submitted');
    expect(sent.filter((mail) => mail.id === eligible.id)).toHaveLength(1);
    await runOutgoing(db, { ...options, clock: () => reference + 60000 });
    expect(sent.filter((mail) => mail.id === eligible.id)).toHaveLength(1);
    const late = await schedule(
      await approve(await draft()),
      new Date(reference + 60000).toISOString(),
    );
    await runOutgoing(db, { ...options, clock: () => reference + 16 * 60000 + 1 });
    expect((await get(late)).status).toBe('needs_review');
    expect(sent.filter((mail) => mail.id === late.id)).toHaveLength(0);
  } finally {
    delete options.clock;
  }
});
