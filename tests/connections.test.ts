import { afterAll, beforeAll, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import { parseMail, type MailTransport } from '../server/mail-transport.js';
import { seal, unseal } from '../server/mail-secrets.js';
const origin = 'http://localhost:3100',
  password = 'connections-test-password',
  mailDate = new Date(Date.now() - 3600000).toUTCString(),
  own = 'studio@163.com',
  key = randomBytes(32);
let db: Database,
  admin: Agent,
  viewer: Agent,
  editor: Agent,
  w: string,
  actor: string,
  viewerId: string,
  editorId: string,
  a: string,
  b: string,
  p: string,
  project: string,
  otherProject: string,
  account: string;
let fail = false,
  validity = '1',
  fetches = 0;
function raw(from: string, to: string, subject: string, body = 'Please confirm the sample size.') {
  return Buffer.from(
    `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${mailDate}\r\nMessage-ID: <${subject}@fixture.invalid>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
  );
}
const fixtures = [
  raw('alice@studio.example', own, 'inbound'),
  raw(own, 'alice@studio.example', 'outbound'),
  raw('new@unknown.example', own, 'unknown'),
  raw('alice@studio.example', `${own}, bob@other.example`, 'conflict'),
  raw('stranger@studio.example', own, 'same-domain'),
];
const transport: MailTransport = {
  async run(input, save, discovered) {
    expect(input.password).toBe('synthetic-app-code');
    await discovered('Sent');
    const after = input.cursors.INBOX?.validity === validity ? input.cursors.INBOX.uid : 0;
    for (let i = 0; i < fixtures.length; i++) {
      if (i + 1 <= after) continue;
      if (fail && i === fixtures.length - 1)
        throw new Error('provider error with private information');
      fetches++;
      await save('INBOX', { validity, uid: i + 1 }, await parseMail(fixtures[i], new Date()));
    }
    await save('Sent', { validity, uid: 7 }, await parseMail(fixtures[1], new Date()));
  },
};
const h = () => ({ origin, 'x-workspace-id': w });
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Connections',
    email: 'connections@example.com',
    password,
    displayName: 'Admin',
  });
  w = seed.workspaceId;
  actor = seed.actorId;
  const app = createApp(db, { origin, mail: { key, transport } });
  admin = request.agent(app);
  viewer = request.agent(app);
  editor = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'connections@example.com', password })
    .expect(200);
  for (const [email, agent] of [
    ['viewer-connections@example.com', viewer],
    ['editor-connections@example.com', editor],
  ] as const) {
    const m = (
      await admin
        .post('/api/members')
        .set(h())
        .send({ email, display_name: email, password })
        .expect(201)
    ).body;
    await agent.post('/api/auth/login').set('origin', origin).send({ email, password }).expect(200);
    if (agent === viewer) viewerId = m.actor_id;
    else editorId = m.actor_id;
  }
  a = (
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
  b = (
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
  p = (await admin.get('/api/people').set(h()).query({ customer_id: a }).expect(200)).body.items[0]
    .id;
  project = (
    await admin
      .post(`/api/customers/${a}/projects`)
      .set(h())
      .send({ name: 'Sample', type: 'sample' })
      .expect(201)
  ).body.id;
  otherProject = (
    await admin
      .post(`/api/customers/${b}/projects`)
      .set(h())
      .send({ name: 'Other', type: 'sample' })
      .expect(201)
  ).body.id;
  for (const [id, access] of [
    [viewerId, 'viewer'],
    [editorId, 'editor'],
  ])
    await admin.put(`/api/customers/${a}/access/${id}`).set(h()).send({ access }).expect(200);
  account = (
    await admin
      .post('/api/mail/accounts')
      .set(h())
      .send({ email: own, authorization_code: 'synthetic-app-code' })
      .expect(201)
  ).body.id;
}, 30000);
afterAll(() => db.close());
it('keeps secrets encrypted and binds ciphertext to its workspace/account', async () => {
  const list = (await admin.get('/api/mail/accounts').set(h()).expect(200)).body;
  expect(JSON.stringify(list)).not.toContain('synthetic-app-code');
  expect(list[0]).not.toHaveProperty('secret');
  expect(list[0]).not.toHaveProperty('cursors');
  const secret = (
    await db.query<{ secret: string }>('SELECT secret FROM mail_accounts WHERE id=$1', [account])
  ).rows[0].secret;
  expect(secret).not.toContain('synthetic-app-code');
  expect(unseal(secret, key, `${w}:${account}`)).toBe('synthetic-app-code');
  expect(() => unseal(secret, key, `${w}:other`)).toThrow();
  expect(seal('a', key, 'ctx')).not.toBe(seal('a', key, 'ctx'));
  await viewer.get('/api/mail/accounts').set(h()).expect(403);
  await editor.post(`/api/mail/accounts/${account}/sync`).set(h()).send({}).expect(403);
  await admin
    .post('/api/mail/accounts')
    .set(h())
    .send({ email: 'x@gmail.com', authorization_code: 'synthetic-app-code' })
    .expect(400);
});
it('syncs exact identities to both company and person, retains outbound, deduplicates across folders and retries', async () => {
  const before = (await admin.get(`/api/customers/${a}`).set(h()).expect(200)).body;
  expect(before.email_count).toBe(0);
  await admin.post(`/api/mail/accounts/${account}/sync`).set(h()).send({}).expect(200);
  const company = (
    await admin.get('/api/mail/messages').set(h()).query({ customer_id: a }).expect(200)
  ).body;
  const person = (
    await viewer.get('/api/mail/messages').set(h()).query({ person_id: p }).expect(200)
  ).body;
  expect(company.total).toBe(2);
  expect(person.items.map((x: { id: string }) => x.id)).toEqual(
    company.items.map((x: { id: string }) => x.id),
  );
  expect(company.last_inbound).toBeTruthy();
  expect(company.last_outbound).toBeTruthy();
  expect(company.items.every((m: { project_id: string | null }) => m.project_id === null)).toBe(
    true,
  );
  expect(company.items.find((m: { subject: string }) => m.subject === 'outbound').direction).toBe(
    'outbound',
  );
  await admin.post(`/api/mail/accounts/${account}/sync`).set(h()).send({}).expect(200);
  expect(fetches).toBe(5);
  validity = '2';
  await admin.post(`/api/mail/accounts/${account}/sync`).set(h()).send({}).expect(200);
  expect(fetches).toBe(10);
  expect(
    (await admin.get('/api/mail/messages').set(h()).query({ customer_id: a }).expect(200)).body
      .total,
  ).toBe(2);
  const after = (await viewer.get(`/api/customers/${a}`).set(h()).expect(200)).body;
  const contact = (await viewer.get(`/api/people/${p}`).set(h()).expect(200)).body;
  expect(after).toMatchObject({
    email_count: 2,
    email_count_30d: 2,
    email_strength: 3,
    status: before.status,
    version: before.version,
    updated_at: before.updated_at,
  });
  expect(after.last_email_at).toBe(new Date(mailDate).toISOString());
  expect(contact.email_count).toBe(2);
  expect(contact.last_email_at).toBe(after.last_email_at);
});
it('quarantines unknown, same-domain and mixed-customer mail, and hides it from members and SQL', async () => {
  const pending = (
    await admin.get('/api/mail/messages').set(h()).query({ pending: 'true' }).expect(200)
  ).body;
  expect(pending.total).toBe(3);
  await viewer.get('/api/mail/messages').set(h()).query({ pending: 'true' }).expect(403);
  await viewer.get(`/api/mail/messages/${pending.items[0].id}`).set(h()).expect(404);
  const direct = await scoped(db, viewerId, w, (ctx) =>
    ctx.tx.query('SELECT id FROM mail_messages WHERE customer_id IS NULL'),
  );
  expect(direct.rows).toHaveLength(0);
  const conflict = pending.items.find((m: { subject: string }) => m.subject === 'conflict');
  await admin
    .post(`/api/mail/messages/${conflict.id}/assign`)
    .set(h())
    .send({ customer_id: a, reviewed: true })
    .expect(409);
});
it('requires explicit review and validates selected project and people on manual association', async () => {
  expect(
    (await admin.get(`/api/relationships/records/people/${p}/projects`).set(h()).expect(200)).body
      .total,
  ).toBe(0);
  const pending = (
    await admin.get('/api/mail/messages').set(h()).query({ pending: 'true' }).expect(200)
  ).body;
  const unknown = pending.items.find((m: { subject: string }) => m.subject === 'unknown');
  await admin
    .post(`/api/mail/messages/${unknown.id}/assign`)
    .set(h())
    .send({ customer_id: a })
    .expect(400);
  await admin
    .post(`/api/mail/messages/${unknown.id}/assign`)
    .set(h())
    .send({ customer_id: a, project_id: otherProject, reviewed: true })
    .expect(404);
  const result = (
    await admin
      .post(`/api/mail/messages/${unknown.id}/assign`)
      .set(h())
      .send({ customer_id: a, project_id: project, person_ids: [p], reviewed: true })
      .expect(200)
  ).body;
  expect(result.customer_id).toBe(a);
  expect(result.project_id).toBe(project);
  expect(result.people[0].id).toBe(p);
  expect((await viewer.get(`/api/people/${p}`).set(h()).expect(200)).body.email_count).toBe(3);
  expect((await viewer.get(`/api/customers/${a}`).set(h()).expect(200)).body.email_strength).toBe(
    4,
  );
  await viewer.get(`/api/mail/messages/${unknown.id}`).set(h()).expect(200);
  await admin
    .post(`/api/mail/messages/${unknown.id}/assign`)
    .set(h())
    .send({ customer_id: b, reviewed: true })
    .expect(409);
});
it('exposes a newly assigned incoming mail project on both detail endpoints and keeps it after repeated sync', async () => {
  for (let repeat = 0; repeat < 2; repeat++) {
    await admin.post(`/api/mail/accounts/${account}/sync`).set(h()).send({}).expect(200);
    const personLinks = (
      await viewer.get(`/api/relationships/records/people/${p}/projects`).set(h()).expect(200)
    ).body;
    expect(personLinks.total).toBe(1);
    expect(personLinks.items).toEqual([
      expect.objectContaining({
        id: project,
        customer_id: a,
        via_relationship: false,
        via_email: true,
      }),
    ]);
    const companyLinks = (
      await viewer.get(`/api/relationships/records/customers/${a}/projects`).set(h()).expect(200)
    ).body;
    expect(companyLinks.total).toBe(1);
    expect(companyLinks.items[0].id).toBe(project);
    const messages = (
      await viewer
        .get('/api/mail/messages')
        .set(h())
        .query({ customer_id: a, project_id: project, person_id: p })
        .expect(200)
    ).body;
    expect(messages.total).toBe(1);
    expect(messages.items[0].subject).toBe('unknown');
  }
});
it('commits each cursor with its mail and resumes after partial network failure without exposing provider errors', async () => {
  fixtures.push(
    raw('alice@studio.example', own, 'committed'),
    raw('alice@studio.example', own, 'later'),
  );
  fail = true;
  const failed = await admin
    .post(`/api/mail/accounts/${account}/sync`)
    .set(h())
    .send({})
    .expect(502);
  expect(JSON.stringify(failed.body)).not.toContain('private information');
  const cursor = (
    await db.query<{ cursors: { INBOX: { uid: number } } }>(
      'SELECT cursors FROM mail_accounts WHERE id=$1',
      [account],
    )
  ).rows[0].cursors;
  expect(cursor.INBOX.uid).toBe(6);
  fail = false;
  await admin.post(`/api/mail/accounts/${account}/sync`).set(h()).send({}).expect(200);
  expect(
    (await admin.get('/api/mail/messages').set(h()).query({ q: 'committed' }).expect(200)).body
      .total,
  ).toBe(1);
  expect(
    (await admin.get('/api/mail/messages').set(h()).query({ q: 'later' }).expect(200)).body.total,
  ).toBe(1);
});
it('respects paused connections and active sync lease', async () => {
  await admin.patch(`/api/mail/accounts/${account}`).set(h()).send({ enabled: false }).expect(200);
  await admin.post(`/api/mail/accounts/${account}/sync`).set(h()).send({}).expect(409);
  await admin.patch(`/api/mail/accounts/${account}`).set(h()).send({ enabled: true }).expect(200);
  await db.query('UPDATE mail_accounts SET sync_token=$2,sync_started_at=now() WHERE id=$1', [
    account,
    randomUUID(),
  ]);
  await admin.post(`/api/mail/accounts/${account}/sync`).set(h()).send({}).expect(409);
  await db.query('UPDATE mail_accounts SET sync_token=NULL,sync_started_at=NULL WHERE id=$1', [
    account,
  ]);
});
it('revocation immediately hides emails in list, detail and database reads', async () => {
  const mail = (await viewer.get('/api/mail/messages').set(h()).expect(200)).body.items[0];
  await admin
    .put(`/api/customers/${a}/access/${viewerId}`)
    .set(h())
    .send({ access: null })
    .expect(200);
  expect((await viewer.get('/api/mail/messages').set(h()).expect(200)).body.total).toBe(0);
  await viewer.get(`/api/mail/messages/${mail.id}`).set(h()).expect(404);
  await viewer.get(`/api/customers/${a}`).set(h()).expect(404);
  expect(
    (await viewer.get('/api/people').set(h()).query({ sort: 'last_email_at' }).expect(200)).body
      .total,
  ).toBe(0);
  expect(
    (await scoped(db, viewerId, w, (ctx) => ctx.tx.query('SELECT id FROM mail_messages'))).rows,
  ).toHaveLength(0);
  await admin
    .put(`/api/customers/${a}/access/${viewerId}`)
    .set(h())
    .send({ access: 'viewer' })
    .expect(200);
});
it('stores a bidirectional relationship once, supports inverse removal, and denies viewers and cross-customer links', async () => {
  const input = {
    source_object: 'projects',
    target_object: 'people',
    source_label: '项目联系人',
    target_label: '参与项目',
    cardinality: 'many_to_many',
  };
  await viewer.post('/api/relationships').set(h()).send(input).expect(403);
  const d = (await admin.post('/api/relationships').set(h()).send(input).expect(201)).body;
  const body = { definition_id: d.id, source_id: project, target_id: p };
  await viewer.post('/api/relationship-edges').set(h()).send(body).expect(403);
  const edge = (await editor.post('/api/relationship-edges').set(h()).send(body).expect(201)).body;
  expect(
    (await editor.post('/api/relationship-edges').set(h()).send(body).expect(201)).body.id,
  ).toBe(edge.id);
  const source = (
    await viewer.get(`/api/relationships/records/projects/${project}`).set(h()).expect(200)
  ).body;
  const target = (await viewer.get(`/api/relationships/records/people/${p}`).set(h()).expect(200))
    .body;
  expect(source.items[0].id).toBe(p);
  expect(target.items[0].id).toBe(project);
  expect(source.items[0].edge_id).toBe(target.items[0].edge_id);
  await admin
    .post('/api/relationship-edges')
    .set(h())
    .send({ ...body, source_id: otherProject })
    .expect(404);
  await viewer.delete(`/api/relationship-edges/${edge.id}`).set(h()).send({}).expect(403);
  await editor.delete(`/api/relationship-edges/${edge.id}`).set(h()).send({}).expect(200);
  expect(
    (await viewer.get(`/api/relationships/records/people/${p}`).set(h()).expect(200)).body.items,
  ).toHaveLength(0);
});
it('enforces one-to-many cardinality in database and permits multiple targets from one source', async () => {
  const d = (
    await admin
      .post('/api/relationships')
      .set(h())
      .send({
        source_object: 'projects',
        target_object: 'people',
        source_label: '唯一主项目成员',
        target_label: '主项目',
        cardinality: 'one_to_many',
      })
      .expect(201)
  ).body;
  const secondProject = (
    await admin
      .post(`/api/customers/${a}/projects`)
      .set(h())
      .send({ name: 'Second', type: 'sample' })
      .expect(201)
  ).body.id;
  const secondPerson = (
    await admin
      .post('/api/people')
      .set(h())
      .send({ customer_id: a, name: 'Second person' })
      .expect(201)
  ).body.id;
  await editor
    .post('/api/relationship-edges')
    .set(h())
    .send({ definition_id: d.id, source_id: project, target_id: p })
    .expect(201);
  await editor
    .post('/api/relationship-edges')
    .set(h())
    .send({ definition_id: d.id, source_id: secondProject, target_id: p })
    .expect(409);
  await editor
    .post('/api/relationship-edges')
    .set(h())
    .send({ definition_id: d.id, source_id: project, target_id: secondPerson })
    .expect(201);
  await expect(
    scoped(db, actor, w, (ctx) =>
      ctx.tx.query(
        "INSERT INTO relationship_edges(workspace_id,customer_id,id,definition_id,source_object,target_object,source_id,target_id,source_project_id,target_person_id) VALUES($1,$2,$3,$4,'projects','people',$5,$6,$5,$6)",
        [w, a, randomUUID(), d.id, otherProject, randomUUID()],
      ),
    ),
  ).rejects.toMatchObject({ code: '23503' });
});
it('parses encoded MIME text and retains attachment metadata without exposing HTML as executable UI', async () => {
  const source = Buffer.from(
    'From: Alice <alice@studio.example>\r\nTo: studio@163.com\r\nSubject: =?UTF-8?B?5qC36KGj56Gu6K6k?=\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="demo"\r\n\r\n--demo\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Sample ready</p><img src="https://tracker.invalid/pixel"><script>steal()</script>\r\n--demo\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="sample.txt"\r\n\r\nsynthetic attachment\r\n--demo--',
  );
  const mail = await parseMail(source, new Date());
  expect(mail.subject).toBe('样衣确认');
  expect(mail.body).toContain('Sample ready');
  expect(mail.body).not.toContain('<script>');
  expect(mail.attachments[0].name).toBe('sample.txt');
  expect(mail.attachments[0]).not.toHaveProperty('content');
});
