import { afterAll, beforeAll, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { parseMail, type MailTransport, type ParsedMail } from '../server/mail-transport.js';
import { scoped } from '../server/security.js';

const origin = 'http://localhost:3100',
  password = 'mail-settings-fixture-password';
let db: Database,
  admin: Agent,
  member: Agent,
  workspace: string,
  actor: string,
  memberId: string,
  account: string,
  second: string,
  customer: string,
  person: string,
  otherWorkspace: string;
const queues: Record<string, ParsedMail[]> = {};
let bodyFetches = 0;
const transport: MailTransport = {
  async run(input, save, _discovered, shouldImport) {
    const after = input.cursors.INBOX?.uid ?? 0;
    const messages = queues[input.email] ?? [];
    for (let i = after; i < messages.length; i++) {
      const message = messages[i];
      if (await shouldImport(message.participants)) {
        bodyFetches++;
        await save('INBOX', { validity: '1', uid: i + 1 }, message);
      } else await save('INBOX', { validity: '1', uid: i + 1 }, null);
    }
  },
};
const h = () => ({ origin, 'x-workspace-id': workspace });
async function push(
  subject: string,
  from = 'new@163.com',
  to = 'owner@163.com',
  body = '公司：合成舞蹈工作室\n联系人：林测试\n电话：13800001234\n地区：杭州\n客户类型：团体定制',
) {
  const message = await parseMail(
    Buffer.from(
      `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${new Date(Date.now() - 60000).toUTCString()}\r\nMessage-ID: <${subject}@fixture.invalid>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
    ),
    new Date(),
  );
  (queues[to] ??= []).push(message);
}
async function sync(id = account) {
  await admin.post(`/api/mail/accounts/${id}/sync`).set(h()).send({}).expect(200);
}
async function accountSettings() {
  return (await admin.get('/api/mail/accounts').set(h()).expect(200)).body.find(
    (x: { id: string }) => x.id === account,
  );
}
async function settings(patch: object = {}) {
  const current = await accountSettings();
  return admin
    .patch(`/api/mail/accounts/${account}/processing`)
    .set(h())
    .send({
      intake_mode: current.intake_mode,
      notify_known: current.notify_known,
      notify_unknown: current.notify_unknown,
      muted_senders: current.muted_senders,
      settings_version: current.settings_version,
      ...patch,
    });
}
async function messages(pending = true) {
  return (
    await admin
      .get('/api/mail/messages')
      .set(h())
      .query({ pending: String(pending) })
      .expect(200)
  ).body.items;
}
async function getMail(subject: string, pending = true) {
  const row = (await messages(pending)).find((x: { subject: string }) => x.subject === subject);
  return (await admin.get(`/api/mail/messages/${row.id}`).set(h()).expect(200)).body;
}
async function exclude(rules: string[]) {
  const current = (await admin.get('/api/mail/exclusions').set(h()).expect(200)).body;
  const preview = (
    await admin
      .post('/api/mail/exclusions/preview')
      .set(h())
      .send({ rules, version: current.version })
      .expect(200)
  ).body;
  await admin
    .put('/api/mail/exclusions')
    .set(h())
    .send({ rules: preview.rules, version: preview.version, reviewed: true })
    .expect(200);
  return preview;
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Settings fixture',
    email: 'settings-admin@fixture.invalid',
    displayName: 'Admin',
    password,
  });
  workspace = seed.workspaceId;
  actor = seed.actorId;
  otherWorkspace = (
    await createWorkspace(db, {
      name: 'Other',
      email: 'other-settings@fixture.invalid',
      displayName: 'Other',
      password,
    })
  ).workspaceId;
  const app = createApp(db, { origin, mail: { key: randomBytes(32), transport } });
  admin = request.agent(app);
  member = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'settings-admin@fixture.invalid', password })
    .expect(200);
  memberId = (
    await admin
      .post('/api/members')
      .set(h())
      .send({ email: 'settings-member@fixture.invalid', display_name: 'Member', password })
      .expect(201)
  ).body.actor_id;
  await member
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'settings-member@fixture.invalid', password })
    .expect(200);
  customer = (
    await admin
      .post('/api/customers')
      .set(h())
      .send({
        name: 'Known studio',
        type: 'group',
        source: 'email',
        contact_name: 'Known',
        email: 'known@studio.example',
      })
      .expect(201)
  ).body.id;
  person = (await admin.get('/api/people').set(h()).query({ customer_id: customer }).expect(200))
    .body.items[0].id;
  await admin
    .put(`/api/customers/${customer}/access/${memberId}`)
    .set(h())
    .send({ access: 'viewer' })
    .expect(200);
  for (const address of ['owner@163.com', 'second@163.com']) {
    const id = (
      await admin
        .post('/api/mail/accounts')
        .set(h())
        .send({ email: address, authorization_code: 'synthetic-auth-code' })
        .expect(201)
    ).body.id;
    if (address === 'owner@163.com') account = id;
    else second = id;
  }
  await db.query(
    "UPDATE mail_accounts SET created_at=now()-interval '1 day' WHERE workspace_id=$1",
    [workspace],
  );
}, 30000);
afterAll(() => db.close());
it('defaults to review, persists extracted drafts and never creates customer records from public domains', async () => {
  expect(await accountSettings()).toMatchObject({
    intake_mode: 'review',
    notify_unknown: true,
    notify_known: true,
    muted_senders: [],
    settings_version: 1,
  });
  await push('default');
  await push('known', 'known@studio.example');
  await sync();
  const mail = await getMail('default');
  expect(mail.intake_mode).toBe('review');
  expect(mail.intake_suggestions.values).toMatchObject({
    company: '合成舞蹈工作室',
    contact: '林测试',
    phone: '13800001234',
    region: '杭州',
  });
  expect(mail.customer_id).toBeNull();
  expect(mail.project_id).toBeNull();
  expect((await admin.get('/api/customers').set(h()).expect(200)).body.total).toBe(1);
  expect((await getMail('known', false)).customer_id).toBe(customer);
  expect((await admin.get('/api/mail/notifications/summary').set(h()).expect(200)).body).toEqual({
    unread: 2,
    pending: 1,
  });
});
it('keeps manual intake separate from notifications and preserves old intake snapshots', async () => {
  const result = await settings({ intake_mode: 'manual', notify_unknown: false });
  expect(result.status).toBe(200);
  expect(result.body.settings_updated_at).toBeTruthy();
  expect(result.body.notify_unknown).toBe(true);
  await push('manual');
  await sync();
  await sync();
  const mail = await getMail('manual');
  expect(mail.intake_mode).toBe('manual');
  expect(mail.intake_suggestions).toBeNull();
  expect(mail.body).toContain('联系人');
  expect((await getMail('default')).intake_suggestions.values.contact).toBe('林测试');
  expect((await admin.get('/api/mail/notifications').set(h()).expect(200)).body.total).toBe(3);
  const before = await accountSettings();
  expect(before.synced_count).toBe(3);
  const old = before.settings_version;
  expect((await settings({ notify_unknown: true })).status).toBe(200);
  expect((await settings({ settings_version: old })).status).toBe(409);
  expect((await getMail('manual')).intake_mode).toBe('manual');
});
it('mutes only exact senders and preserves association and interaction statistics', async () => {
  expect(
    (
      await settings({
        intake_mode: 'review',
        notify_known: true,
        muted_senders: [' KNOWN@STUDIO.EXAMPLE ', 'known@studio.example'],
      })
    ).status,
  ).toBe(200);
  await push('muted', 'known@studio.example');
  await push('not-muted', 'another@studio.example');
  await sync();
  expect((await getMail('muted', false)).customer_id).toBe(customer);
  const notifications = (
    await admin.get('/api/mail/notifications').set(h()).expect(200)
  ).body.items.map((x: { subject: string }) => x.subject);
  expect(notifications).not.toContain('muted');
  expect(notifications).toContain('known');
  expect(notifications).toContain('not-muted');
  expect(
    (await admin.get(`/api/customers/${customer}`).set(h()).expect(200)).body.email_count,
  ).toBe(2);
  expect((await accountSettings()).muted_senders).toEqual(['known@studio.example']);
  expect((await settings({ muted_senders: ['studio.example'] })).status).toBe(400);
});
it('always notifies known and unknown arrivals even when a legacy client or stored switch says off', async () => {
  expect(
    (await settings({ notify_known: false, notify_unknown: true, muted_senders: [] })).status,
  ).toBe(200);
  await db.query('UPDATE mail_accounts SET notify_known=false,notify_unknown=false WHERE id=$1', [
    account,
  ]);
  await push('known-off', 'known@studio.example');
  await push('unknown-on');
  await sync();
  const items = (await admin.get('/api/mail/notifications').set(h()).expect(200)).body.items.map(
    (x: { subject: string }) => x.subject,
  );
  expect(items).toContain('known-off');
  expect(items).toContain('unknown-on');
  expect((await getMail('known-off', false)).customer_id).toBe(customer);
});
it('previews and hides existing mail consistently across accounts, details, notifications, relations and metrics', async () => {
  await push('other-account', 'known@studio.example', 'second@163.com');
  await sync(second);
  const known = await getMail('known', false);
  const project = (
    await admin
      .post(`/api/customers/${customer}/projects`)
      .set(h())
      .send({ name: 'Privacy project', type: 'sample' })
      .expect(201)
  ).body.id;
  await scoped(db, actor, workspace, (ctx) =>
    ctx.tx.query('UPDATE mail_messages SET project_id=$3 WHERE workspace_id=$1 AND id=$2', [
      workspace,
      known.id,
      project,
    ]),
  );
  expect(
    (await admin.get(`/api/relationships/records/people/${person}/projects`).set(h()).expect(200))
      .body.total,
  ).toBe(1);
  const preview = await exclude(['STUDIO.EXAMPLE']);
  expect(preview.impact.reduce((sum: number, x: { to_hide: number }) => sum + x.to_hide, 0)).toBe(
    5,
  );
  expect(preview.impact).toHaveLength(2);
  for (const user of [admin, member]) {
    await user.get(`/api/mail/messages/${known.id}`).set(h()).expect(404);
    expect(
      (
        await user
          .get('/api/mail/messages')
          .set(h())
          .query({ customer_id: customer, q: 'known' })
          .expect(200)
      ).body.total,
    ).toBe(0);
    expect(
      (await user.get(`/api/customers/${customer}`).set(h()).expect(200)).body.email_count,
    ).toBe(0);
    expect((await user.get(`/api/people/${person}`).set(h()).expect(200)).body.email_count).toBe(0);
    expect(
      (await user.get(`/api/relationships/records/people/${person}/projects`).set(h()).expect(200))
        .body.total,
    ).toBe(0);
    await user.post(`/api/mail/notifications/${known.id}/read`).set(h()).send({}).expect(404);
  }
  await admin
    .post(`/api/mail/messages/${known.id}/assign`)
    .set(h())
    .send({ customer_id: customer, reviewed: true })
    .expect(404);
  const raw = await scoped(db, actor, workspace, (ctx) =>
    ctx.tx.query('SELECT id FROM mail_messages WHERE id=$1', [known.id]),
  );
  expect(raw.rows).toHaveLength(0);
  const links = await scoped(db, actor, workspace, (ctx) =>
    ctx.tx.query('SELECT message_id FROM mail_people WHERE message_id=$1', [known.id]),
  );
  expect(links.rows).toHaveLength(0);
  const notes = (await admin.get('/api/mail/notifications').set(h()).expect(200)).body.items;
  expect(
    notes.every(
      (x: { subject: string }) => !['known', 'not-muted', 'other-account'].includes(x.subject),
    ),
  ).toBe(true);
  // Stored data and customer ownership are retained, not deleted.
  expect(
    (await db.query('SELECT id FROM mail_messages WHERE id=$1', [known.id])).rows,
  ).toHaveLength(1);
});
it('skips blocked messages before body fetch, advances cursor, enforces domain boundaries and restores only stored history', async () => {
  const start = bodyFetches;
  await push('blocked-subdomain', 'private@dept.studio.example');
  await push('boundary', 'safe@notstudio.example');
  await push('cc-blocked', 'new@163.com', 'owner@163.com', 'Synthetic');
  // A blocked CC participant hides the whole message.
  const last = queues['owner@163.com'].at(-1)!;
  last.participants.push('known@studio.example');
  await sync();
  expect(bodyFetches - start).toBe(1);
  await sync();
  expect(bodyFetches - start).toBe(1);
  expect((await messages()).map((x: { subject: string }) => x.subject)).toContain('boundary');
  expect(
    (await db.query('SELECT id FROM mail_messages WHERE subject=$1', ['blocked-subdomain'])).rows,
  ).toHaveLength(0);
  const preview = await exclude([]);
  expect(
    preview.impact.reduce((sum: number, x: { to_restore: number }) => sum + x.to_restore, 0),
  ).toBe(5);
  expect(
    (await admin.get(`/api/customers/${customer}`).set(h()).expect(200)).body.email_count,
  ).toBe(4);
  await sync();
  expect(
    (await db.query('SELECT id FROM mail_messages WHERE subject=$1', ['blocked-subdomain'])).rows,
  ).toHaveLength(0);
});
it('requires admin, isolates workspaces, validates entries and audits settings without credentials', async () => {
  const valid = {
    intake_mode: 'review',
    notify_unknown: true,
    notify_known: true,
    muted_senders: [],
    settings_version: (await accountSettings()).settings_version,
  };
  await member.patch(`/api/mail/accounts/${account}/processing`).set(h()).send(valid).expect(403);
  await member.get('/api/mail/exclusions').set(h()).expect(403);
  await member
    .post('/api/mail/exclusions/preview')
    .set(h())
    .send({ rules: [], version: 0 })
    .expect(403);
  await member
    .put('/api/mail/exclusions')
    .set(h())
    .send({ rules: [], version: 0, reviewed: true })
    .expect(403);
  await admin
    .patch(`/api/mail/accounts/${account}/processing`)
    .set({ ...h(), 'x-workspace-id': otherWorkspace })
    .send(valid)
    .expect(404);
  await admin
    .get('/api/mail/exclusions')
    .set({ ...h(), 'x-workspace-id': otherWorkspace })
    .expect(404);
  const ex = (await admin.get('/api/mail/exclusions').set(h()).expect(200)).body;
  await admin
    .post('/api/mail/exclusions/preview')
    .set(h())
    .send({ rules: ['*.example.com'], version: ex.version })
    .expect(400);
  await admin
    .put('/api/mail/exclusions')
    .set(h())
    .send({ rules: ['example.com'], version: ex.version, reviewed: false })
    .expect(400);
  await admin
    .put('/api/mail/exclusions')
    .set(h())
    .send({ rules: [], version: 0, reviewed: true })
    .expect(409);
  const audit = await scoped(db, actor, workspace, (ctx) =>
    ctx.tx.query('SELECT kind,settings FROM mail_settings_audit'),
  );
  expect(audit.rows.length).toBeGreaterThan(5);
  expect(JSON.stringify(audit.rows)).not.toContain('synthetic-auth-code');
  await expect(
    scoped(db, memberId, workspace, (ctx) =>
      ctx.tx.query('SELECT * FROM crm_mail_exclusion_impact($1::jsonb)', ['[]']),
    ),
  ).rejects.toThrow();
});

it('tracks latest mail with visible pending/associated scopes, recognition and per-person read markers', async () => {
  const all = (await admin.get('/api/mail/messages').set(h()).query({ pending: 'all' }).expect(200))
    .body;
  const pending = (
    await admin.get('/api/mail/messages').set(h()).query({ pending: 'true' }).expect(200)
  ).body;
  const associated = (
    await admin.get('/api/mail/messages').set(h()).query({ pending: 'false' }).expect(200)
  ).body;
  expect(all.total).toBe(pending.total + associated.total);
  expect(all.items.some((m: { customer_id: string | null }) => m.customer_id === null)).toBe(true);
  expect(all.items.some((m: { customer_id: string | null }) => m.customer_id === customer)).toBe(
    true,
  );
  expect(all.items.every((m: object) => !('body' in m))).toBe(true);
  expect(all.items.every((m: { customer_recognition?: unknown }) => !!m.customer_recognition)).toBe(
    true,
  );
  const unread = all.items.find((m: { unread: boolean }) => m.unread);
  expect(unread).toBeTruthy();
  const before = (await admin.get('/api/mail/tracking/summary').set(h()).expect(200)).body;
  await admin.post(`/api/mail/messages/${unread.id}/read`).set(h()).send({}).expect(200);
  await admin.post(`/api/mail/messages/${unread.id}/read`).set(h()).send({}).expect(200);
  expect((await admin.get('/api/mail/tracking/summary').set(h()).expect(200)).body.unread).toBe(
    before.unread - 1,
  );
  const others = (
    await member.get('/api/mail/messages').set(h()).query({ pending: 'all' }).expect(200)
  ).body.items;
  expect(others.every((m: { customer_id: string | null }) => m.customer_id === customer)).toBe(
    true,
  );
  const unknown = all.items.find((m: { customer_id: string | null }) => m.customer_id === null);
  await member.post(`/api/mail/messages/${unknown.id}/read`).set(h()).send({}).expect(404);
});
