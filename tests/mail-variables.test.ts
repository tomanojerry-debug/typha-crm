import { afterAll, beforeAll, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { runOutgoing } from '../server/outgoing.js';
import { scoped } from '../server/security.js';
import { mailVariableDocumentSchema } from '../server/mail-variables.js';
import { SubmissionError, type SendTransport } from '../server/smtp-transport.js';
import {
  mailVariableText,
  type MailInlineNode,
  type MailVariableDocument,
  type MailVariableNode,
  type MailVariablePreview,
} from '../shared/mail-variables.js';
import type { OutgoingContent, OutgoingMail } from '../shared/outgoing.js';

const origin = 'http://localhost:3100',
  password = 'synthetic-variable-password',
  key = randomBytes(32);
let db: Database,
  admin: Agent,
  otherActor: Agent,
  workspace: string,
  actor: string,
  customer: string,
  foreign: string,
  person: string,
  secondPerson: string,
  foreignPerson: string,
  account: string,
  project: string,
  field: string;
const sent: OutgoingMail[] = [];
let failure: Error | null = null;
const transport: SendTransport = {
  async send(input) {
    sent.push(input.mail);
    if (failure) throw failure;
  },
  async checkSent() {
    return false;
  },
};
const h = () => ({ origin, 'x-workspace-id': workspace });
const write = (sql: string, params: unknown[]) =>
  scoped(db, actor, workspace, (ctx) => ctx.tx.query(sql, params));
const text = (value: string): MailInlineNode => ({ type: 'text', text: value });
const variable = (
  root: MailVariableNode['root'],
  field: string,
  fallback?: string,
): MailVariableNode => ({
  type: 'variable',
  id: randomUUID(),
  root,
  field,
  ...(fallback !== undefined ? { fallback } : {}),
});
const doc = (
  body: MailInlineNode[],
  subject: MailInlineNode[] = [text('合成变量邮件')],
): MailVariableDocument => ({ version: 1, subject, body });
const content = (
  document: MailVariableDocument,
  patch: Partial<OutgoingContent> = {},
): OutgoingContent => ({
  account_id: account,
  project_id: project,
  to: ['shen.one@example.test'],
  cc: [],
  bcc: [],
  subject: mailVariableText(document.subject),
  body: mailVariableText(document.body),
  attachments: [],
  variable_document: document,
  recipient_bindings: [{ email: 'shen.one@example.test', person_id: person }],
  ...patch,
});
async function draft(document: MailVariableDocument, patch: Partial<OutgoingContent> = {}) {
  return (
    await admin
      .post(`/api/people/${person}/outgoing`)
      .set(h())
      .send({ id: randomUUID(), version: 0, content: content(document, patch) })
      .expect(200)
  ).body as OutgoingMail;
}
async function preview(mail: OutgoingMail) {
  return (
    await admin
      .post(`/api/outgoing/${mail.id}/variable-preview`)
      .set(h())
      .send({ version: mail.version })
      .expect(200)
  ).body as MailVariablePreview;
}
async function approve(mail: OutgoingMail, p?: MailVariablePreview) {
  const current = p || (await preview(mail));
  return (
    await admin
      .post(`/api/outgoing/${mail.id}/approve`)
      .set(h())
      .send({ version: mail.version, variable_preview_digest: current.digest })
      .expect(200)
  ).body as OutgoingMail;
}
async function schedule(mail: OutgoingMail) {
  return (
    await admin
      .post(`/api/outgoing/${mail.id}/schedule`)
      .set(h())
      .send({ version: mail.version, mode: 'now', timezone: 'Asia/Shanghai' })
      .expect(200)
  ).body as OutgoingMail;
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Synthetic variable workspace',
    email: 'variables@example.test',
    password,
    displayName: 'Synthetic admin',
  });
  workspace = seed.workspaceId;
  actor = seed.actorId;
  const app = createApp(db, { origin, mail: { key }, outgoing: { key, transport } });
  admin = request.agent(app);
  otherActor = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'variables@example.test', password })
    .expect(200);
  const otherId = (
    await admin
      .post('/api/members')
      .set(h())
      .send({ email: 'variables-other@example.test', password, display_name: 'Other' })
      .expect(201)
  ).body.actor_id;
  await otherActor
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'variables-other@example.test', password })
    .expect(200);
  customer = (
    await admin
      .post('/api/customers')
      .set(h())
      .send({
        name: '合成公司甲',
        type: 'group',
        source: 'email',
        contact_name: '合成沈甲',
        email: 'shen.one@example.test',
        region: '华东合成地区',
      })
      .expect(201)
  ).body.id;
  foreign = (
    await admin
      .post('/api/customers')
      .set(h())
      .send({
        name: '合成公司乙',
        type: 'group',
        source: 'email',
        contact_name: '合成另一人',
        email: 'foreign@example.test',
      })
      .expect(201)
  ).body.id;
  person = (await admin.get('/api/people').set(h()).query({ customer_id: customer }).expect(200))
    .body.items[0].id;
  foreignPerson = (
    await admin.get('/api/people').set(h()).query({ customer_id: foreign }).expect(200)
  ).body.items[0].id;
  secondPerson = (
    await admin
      .post('/api/people')
      .set(h())
      .send({ customer_id: customer, name: '合成沈乙', email: 'shen.two@example.test' })
      .expect(201)
  ).body.id;
  account = (
    await admin
      .post('/api/mail/accounts')
      .set(h())
      .send({ email: 'variables@163.com', authorization_code: 'synthetic-auth-code' })
      .expect(201)
  ).body.id;
  project = (
    await admin
      .post(`/api/customers/${customer}/projects`)
      .set(h())
      .send({ name: '合成项目', type: 'sample', due_date: '2027-01-02' })
      .expect(201)
  ).body.id;
  field = (
    await admin
      .post('/api/attributes')
      .set(h())
      .send({ name: '合成数量', kind: 'number' })
      .expect(201)
  ).body.id;
  await admin
    .put(`/api/customers/${customer}/access/${otherId}`)
    .set(h())
    .send({ access: 'editor' })
    .expect(200);
}, 30000);
afterAll(() => db?.close());

it('exposes real allowed schema fields, stable IDs and no invented location or sender name', async () => {
  const catalog = (await admin.get(`/api/people/${person}/compose-options`).set(h()).expect(200))
    .body.mail_variables;
  expect(catalog.fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ root: 'recipient', field: 'people:name', label: '姓名' }),
      expect.objectContaining({
        root: 'recipient_company',
        field: 'customers:region',
        path: ['收件人', '所属公司', '地区'],
      }),
      expect.objectContaining({ root: 'sender', field: 'mail_accounts:email' }),
      expect.objectContaining({ root: 'customer', field }),
    ]),
  );
  expect(
    catalog.fields.some((f: { field: string }) =>
      /description|owner|city|first_name|last_name|display_name|email_strength/.test(f.field),
    ),
  ).toBe(false);
});
it('previews explicit recipient/company/project/sender paths without changing the saved draft', async () => {
  const r = await draft(
    doc([
      variable('recipient', 'people:name'),
      text('，'),
      variable('recipient_company', 'customers:name'),
      text('／'),
      variable('customer', 'customers:region'),
      text('／'),
      variable('project', 'projects:due_date'),
      text('／'),
      variable('sender', 'mail_accounts:email'),
    ]),
  );
  const before = (await admin.get(`/api/outgoing/${r.id}`).set(h()).expect(200)).body;
  const result = await preview(r);
  expect(result.can_confirm).toBe(true);
  expect(result.messages[0].body).toBe(
    '合成沈甲，合成公司甲／华东合成地区／2027-01-02／variables@163.com',
  );
  expect(result.messages[0].values[0]).toMatchObject({ record_id: person, record_version: 1 });
  expect((await admin.get(`/api/outgoing/${r.id}`).set(h()).expect(200)).body).toEqual(before);
});
it('does not expose another actor draft or another workspace through preview', async () => {
  const r = await draft(doc([variable('customer', 'customers:name')]));
  await otherActor
    .post(`/api/outgoing/${r.id}/variable-preview`)
    .set(h())
    .send({ version: r.version })
    .expect(404);
  await admin
    .post(`/api/outgoing/${r.id}/variable-preview`)
    .set({ ...h(), 'x-workspace-id': randomUUID() })
    .send({ version: r.version })
    .expect(404);
});
it('automatically resolves one exact authorized email and freezes its binding for send-time revalidation', async () => {
  const email = 'auto.unique@example.test';
  const chosen = (
    await admin
      .post('/api/people')
      .set(h())
      .send({ customer_id: customer, name: '合成唯一人', email })
      .expect(201)
  ).body.id;
  let r = await draft(
    doc([
      variable('recipient', 'people:name'),
      text('／'),
      variable('recipient_company', 'customers:name'),
    ]),
    { to: [email], recipient_bindings: [] },
  );
  const p = await preview(r);
  expect(p.can_confirm).toBe(true);
  expect(p.messages[0].body).toBe('合成唯一人／合成公司甲');
  expect(p.recipient_choices).toEqual([]);
  expect(p.recipient_bindings).toEqual([{ email, person_id: chosen }]);
  expect(p.messages[0].values[1].source).toContain(`people:${chosen}/customers:${customer}`);
  r = await approve(r, p);
  expect(r.variable_snapshot?.recipient_bindings).toEqual(p.recipient_bindings);
  await schedule(r);
  await write('UPDATE people SET email=$3 WHERE workspace_id=$1 AND id=$2', [
    workspace,
    chosen,
    'auto.changed@example.test',
  ]);
  const start = sent.length;
  await runOutgoing(db, { key, transport });
  expect(sent).toHaveLength(start);
  expect((await admin.get(`/api/outgoing/${r.id}`).set(h()).expect(200)).body.status).toBe(
    'needs_review',
  );
});
it('never replaces a frozen unique-email record with a new same-email candidate', async () => {
  const email = 'auto.frozen@example.test';
  const chosen = (
    await admin
      .post('/api/people')
      .set(h())
      .send({ customer_id: customer, name: '合成原来的人', email })
      .expect(201)
  ).body.id;
  let r = await draft(doc([variable('recipient', 'people:name')]), {
    to: [email],
    recipient_bindings: [],
  });
  r = await approve(r);
  await admin
    .post('/api/people')
    .set(h())
    .send({ customer_id: customer, name: 'AAA合成新同邮箱', email })
    .expect(201);
  expect(r.variable_snapshot?.recipient_bindings).toEqual([{ email, person_id: chosen }]);
  await schedule(r);
  const start = sent.length;
  await runOutgoing(db, { key, transport });
  expect(sent[start].body).toBe('合成原来的人');
  expect(sent[start].variable_snapshot?.recipient_bindings).toEqual([{ email, person_id: chosen }]);
  const linked = (
    await db.query<{ person_id: string }>(
      'SELECT mp.person_id FROM mail_people mp JOIN mail_messages m ON m.workspace_id=mp.workspace_id AND m.id=mp.message_id WHERE m.workspace_id=$1 AND m.message_id=$2',
      [workspace, sent[start].message_id],
    )
  ).rows.map((r) => r.person_id);
  expect(linked).toEqual([chosen]);
});
it('rejects cross-customer IDs, mismatched emails and stale To bindings', async () => {
  const document = doc([variable('recipient', 'people:name', '不能绕过')]);
  for (const binding of [
    { email: 'shen.one@example.test', person_id: foreignPerson },
    { email: 'external@example.test', person_id: person },
  ]) {
    await admin
      .post(`/api/people/${person}/outgoing`)
      .set(h())
      .send({
        id: randomUUID(),
        version: 0,
        content: content(document, { recipient_bindings: [binding] }),
      })
      .expect(409);
  }
});
it('requires explicit selection for duplicate-email candidates and never picks the first record', async () => {
  const duplicate = (
    await admin
      .post('/api/people')
      .set(h())
      .send({ customer_id: customer, name: '合成同邮箱人', email: 'shen.one@example.test' })
      .expect(201)
  ).body.id;
  const r = await draft(doc([variable('recipient', 'people:name', '不能替代选择')]), {
    recipient_bindings: [],
  });
  const p = await preview(r);
  expect(p.can_confirm).toBe(false);
  expect(p.messages[0].values[0].state).toBe('unbound');
  expect(p.recipient_choices[0].candidates.map((c) => c.person_id)).toEqual(
    expect.arrayContaining([person, duplicate]),
  );
  const chosen = await draft(doc([variable('recipient', 'people:name')]), {
    recipient_bindings: [{ email: 'shen.one@example.test', person_id: duplicate }],
  });
  expect((await preview(chosen)).messages[0].body).toBe('合成同邮箱人');
});
it('does not use fallback for unbound external email, absent project or absent sender', async () => {
  const external = await draft(doc([variable('recipient', 'people:name', '备用')]), {
    to: ['external@example.test'],
    recipient_bindings: [],
  });
  expect((await preview(external)).messages[0].values[0]).toMatchObject({
    state: 'unbound',
    value: null,
  });
  const noProject = await draft(doc([variable('project', 'projects:name', '备用')]), {
    project_id: null,
  });
  expect((await preview(noProject)).can_confirm).toBe(false);
  const noAccount = await draft(doc([variable('sender', 'mail_accounts:email', '备用')]), {
    account_id: null,
  });
  expect((await preview(noAccount)).can_confirm).toBe(false);
});
it('only uses fallback for a loaded empty field, including explicitly empty fallback', async () => {
  const r = await draft(
    doc([
      text('职位：'),
      variable('recipient', 'people:job_title', ''),
      text('／电话：'),
      variable('recipient', 'people:phone', '待补'),
    ]),
  );
  const p = await preview(r);
  expect(p.can_confirm).toBe(true);
  expect(p.messages[0].body).toBe('职位：／电话：待补');
  expect(p.messages[0].values.map((v) => v.state)).toEqual(['fallback', 'fallback']);
});
it('disables personal variables for ordinary multiple To even with a fallback, while common company variables work', async () => {
  const patch = { to: ['shen.one@example.test', 'shen.two@example.test'], recipient_bindings: [] };
  const r = await draft(doc([variable('recipient', 'people:name', '各位')]), patch);
  expect((await preview(r)).messages[0].values[0].state).toBe('invalid');
  const common = await draft(doc([variable('customer', 'customers:name')]), patch);
  expect((await preview(common)).can_confirm).toBe(true);
});
it('validates AST IDs, visible strings and current allowed fields before saving', async () => {
  const node = variable('recipient', 'people:name');
  expect(mailVariableDocumentSchema.safeParse(doc([node, node])).success).toBe(false);
  expect(
    mailVariableDocumentSchema.safeParse(doc([text('正文')], [text('主题\n注入')])).success,
  ).toBe(false);
  const invalid = doc([variable('customer', 'customers:description', '不能掩盖')]);
  await admin
    .post(`/api/people/${person}/outgoing`)
    .set(h())
    .send({ id: randomUUID(), version: 0, content: content(invalid) })
    .expect(400);
  const valid = doc([node]);
  await admin
    .post(`/api/people/${person}/outgoing`)
    .set(h())
    .send({ id: randomUUID(), version: 0, content: content(valid, { body: '隐藏不同AST' }) })
    .expect(400);
});
it('formats stored custom zero and multiselect values without triggering AI', async () => {
  await write(
    "INSERT INTO customer_attribute_values(workspace_id,customer_id,attribute_id,id,value,origin) VALUES($1,$2,$3,$4,$5::jsonb,'manual')",
    [workspace, customer, field, randomUUID(), '0'],
  );
  const r = await draft(doc([text('数量：'), variable('customer', field, '缺少')]));
  expect((await preview(r)).messages[0].body).toBe('数量：0');
  const multi = (
    await admin
      .post('/api/attributes')
      .set(h())
      .send({ name: '合成多选', kind: 'multi_select', options: ['甲', '乙'] })
      .expect(201)
  ).body.id;
  await write(
    "INSERT INTO customer_attribute_values(workspace_id,customer_id,attribute_id,id,value,origin) VALUES($1,$2,$3,$4,$5::jsonb,'manual')",
    [workspace, customer, multi, randomUUID(), '["乙","甲"]'],
  );
  expect((await preview(await draft(doc([variable('customer', multi)])))).messages[0].body).toBe(
    '乙、甲',
  );
});
it('marks removed AI evidence stale and refuses to use its value or fallback', async () => {
  const ai = (
    await admin
      .post('/api/attributes')
      .set(h())
      .send({ name: '合成AI摘要', kind: 'text', ai_enabled: true, guidance: '仅合成测试' })
      .expect(201)
  ).body.id;
  await write(
    "INSERT INTO customer_attribute_values(workspace_id,customer_id,attribute_id,id,value,origin,sources) VALUES($1,$2,$3,$4,$5::jsonb,'ai',$6::jsonb)",
    [
      workspace,
      customer,
      ai,
      randomUUID(),
      '"不可继续回显的旧值"',
      JSON.stringify([
        { id: `record:${randomUUID()}`, kind: 'record', title: '已失效合成来源', body: '旧原文' },
      ]),
    ],
  );
  const p = await preview(await draft(doc([variable('customer', ai, '备用也不可绕过')])));
  expect(p.can_confirm).toBe(false);
  expect(p.messages[0].values[0]).toMatchObject({ state: 'stale', value: null, origin: 'ai' });
  expect(JSON.stringify(p)).not.toContain('不可继续回显的旧值');
  expect(JSON.stringify(p)).not.toContain('旧原文');
});
it('requires the current preview digest and does not increment version when freezing approval', async () => {
  const r = await draft(doc([variable('customer', 'customers:name')]));
  const p = await preview(r);
  await admin
    .post(`/api/outgoing/${r.id}/approve`)
    .set(h())
    .send({ version: r.version })
    .expect(409);
  await write('UPDATE customers SET region=$3 WHERE workspace_id=$1 AND id=$2', [
    workspace,
    customer,
    '合成地区已更新',
  ]);
  await admin
    .post(`/api/outgoing/${r.id}/approve`)
    .set(h())
    .send({ version: r.version, variable_preview_digest: p.digest })
    .expect(409);
  const approved = await approve(r);
  expect(approved.version).toBe(r.version);
  expect(approved.variable_snapshot?.messages[0].body).toBe('合成公司甲');
});
it('sends and archives the confirmed frozen text after CRM values change, then never blindly resends', async () => {
  let r = await draft(
    doc([
      text('您好'),
      variable('recipient', 'people:name'),
      text('，'),
      variable('customer', 'customers:name'),
    ]),
  );
  r = await approve(r);
  const frozen = r.variable_snapshot!.messages[0].body;
  await write('UPDATE people SET name=$3 WHERE workspace_id=$1 AND id=$2', [
    workspace,
    person,
    '合成新姓名',
  ]);
  await write('UPDATE customers SET name=$3 WHERE workspace_id=$1 AND id=$2', [
    workspace,
    customer,
    '合成公司新名',
  ]);
  await schedule(r);
  const count = sent.length;
  await runOutgoing(db, { key, transport });
  expect(sent).toHaveLength(count + 1);
  expect(sent[count].body).toBe(frozen);
  const archive = (
    await db.query<{ body: string }>(
      'SELECT body FROM mail_messages WHERE workspace_id=$1 AND message_id=$2',
      [workspace, sent[count].message_id],
    )
  ).rows;
  expect(archive[0].body).toBe(frozen);
  await runOutgoing(db, { key, transport });
  expect(sent).toHaveLength(count + 1);
});
it('invalidates the snapshot, confirmation and schedule on actual content edits', async () => {
  let r = await approve(await draft(doc([variable('customer', 'customers:name')])));
  r = await schedule(r);
  const document = doc([text('新的 '), variable('customer', 'customers:name')]);
  const changed = (
    await admin
      .post(`/api/people/${person}/outgoing`)
      .set(h())
      .send({ id: r.id, version: r.version, content: content(document) })
      .expect(200)
  ).body;
  expect(changed).toMatchObject({
    version: r.version + 1,
    status: 'draft',
    variable_snapshot: null,
    approved_version: null,
    scheduled_at: null,
  });
  await admin
    .post(`/api/outgoing/${r.id}/variable-preview`)
    .set(h())
    .send({ version: r.version })
    .expect(409);
});
it('renders, freezes, sends and archives different mass copies by each explicit recipient binding', async () => {
  const document = doc(
    [text('您好'), variable('recipient', 'people:name')],
    [text('致'), variable('recipient', 'people:name')],
  );
  let r = await draft(document, {
    mass_sending: true,
    to: ['shen.one@example.test', 'shen.two@example.test'],
    recipient_bindings: [
      { email: 'shen.one@example.test', person_id: person },
      { email: 'shen.two@example.test', person_id: secondPerson },
    ],
  });
  const p = await preview(r);
  expect(p.can_confirm).toBe(true);
  expect(new Set(p.messages.map((m) => m.body)).size).toBe(2);
  r = await approve(r, p);
  await schedule(r);
  const start = sent.length;
  await runOutgoing(db, { key, transport });
  expect(sent.slice(start).map((m) => [m.to[0], m.subject, m.body])).toEqual(
    p.messages.map((m) => [m.recipient, m.subject, m.body]),
  );
  for (const m of sent.slice(start)) {
    const archive = (
      await db.query<{ subject: string; body: string }>(
        'SELECT subject,body FROM mail_messages WHERE workspace_id=$1 AND message_id=$2',
        [workspace, m.message_id],
      )
    ).rows[0];
    expect(archive).toEqual({ subject: m.subject, body: m.body });
    const linked = (
      await db.query<{ person_id: string }>(
        'SELECT mp.person_id FROM mail_people mp JOIN mail_messages m ON m.workspace_id=mp.workspace_id AND m.id=mp.message_id WHERE m.workspace_id=$1 AND m.message_id=$2',
        [workspace, m.message_id],
      )
    ).rows.map((r) => r.person_id);
    expect(linked).toEqual([
      r.variable_snapshot!.recipient_bindings.find((b) => b.email === m.to[0])!.person_id,
    ]);
  }
});
it('stops a variable mass batch on uncertain submission without blindly resending any copy', async () => {
  const r = await approve(
    await draft(doc([variable('recipient', 'people:name')]), {
      mass_sending: true,
      to: ['shen.one@example.test', 'shen.two@example.test'],
      recipient_bindings: [
        { email: 'shen.one@example.test', person_id: person },
        { email: 'shen.two@example.test', person_id: secondPerson },
      ],
    }),
  );
  await schedule(r);
  failure = new SubmissionError('synthetic ambiguous submission', false);
  const start = sent.length;
  try {
    await runOutgoing(db, { key, transport });
  } finally {
    failure = null;
  }
  await runOutgoing(db, { key, transport });
  expect(sent).toHaveLength(start + 1);
  const current = (await admin.get(`/api/outgoing/${r.id}`).set(h()).expect(200)).body;
  expect(current.status).toBe('uncertain');
  expect(current.deliveries.map((d: { status: string }) => d.status)).toEqual([
    'uncertain',
    'stopped',
  ]);
});
it('revalidates recipient email binding before sending a frozen draft', async () => {
  const r = await approve(await draft(doc([variable('recipient', 'people:name')])));
  await schedule(r);
  await write('UPDATE people SET email=$3 WHERE workspace_id=$1 AND id=$2', [
    workspace,
    person,
    'changed@example.test',
  ]);
  const start = sent.length;
  await runOutgoing(db, { key, transport });
  expect(sent).toHaveLength(start);
  expect((await admin.get(`/api/outgoing/${r.id}`).set(h()).expect(200)).body.status).toBe(
    'needs_review',
  );
  await write('UPDATE people SET email=$3 WHERE workspace_id=$1 AND id=$2', [
    workspace,
    person,
    'shen.one@example.test',
  ]);
});
it('retains exactly the legacy approval digest for mail without a variable AST', async () => {
  const plain = { ...content(doc([text('旧普通邮件')])) };
  delete plain.variable_document;
  delete plain.recipient_bindings;
  const r = (
    await admin
      .post(`/api/people/${person}/outgoing`)
      .set(h())
      .send({ id: randomUUID(), version: 0, content: plain })
      .expect(200)
  ).body as OutgoingMail;
  const before = (await admin.get(`/api/outgoing/${r.id}`).set(h()).expect(200)).body;
  const p = await preview(r);
  expect(p.can_confirm).toBe(true);
  expect(p.messages[0].body).toBe(plain.body);
  expect((await admin.get(`/api/outgoing/${r.id}`).set(h()).expect(200)).body).toEqual(before);
  expect(before).not.toHaveProperty('variable_document');
  await admin
    .post(`/api/outgoing/${r.id}/approve`)
    .set(h())
    .send({ version: r.version })
    .expect(200);
  const legacy = createHash('sha256')
    .update(
      JSON.stringify([
        workspace,
        customer,
        person,
        project,
        account,
        'variables@163.com',
        r.version,
        plain.to,
        plain.cc,
        plain.bcc,
        plain.subject,
        plain.body,
        [],
      ]),
    )
    .digest('hex');
  expect(
    (
      await db.query<{ approved_digest: string; variable_snapshot: unknown }>(
        'SELECT approved_digest,variable_snapshot FROM outgoing_mail WHERE workspace_id=$1 AND id=$2',
        [workspace, r.id],
      )
    ).rows[0],
  ).toEqual({ approved_digest: legacy, variable_snapshot: null });
});
it('keeps snapshot private to the author and locks submitted snapshot mutations', async () => {
  const r = await approve(await draft(doc([variable('customer', 'customers:name')])));
  await schedule(r);
  await runOutgoing(db, { key, transport });
  await expect(
    scoped(db, actor, workspace, (ctx) =>
      ctx.tx.query(
        'UPDATE outgoing_mail SET variable_snapshot=NULL WHERE workspace_id=$1 AND id=$2',
        [workspace, r.id],
      ),
    ),
  ).rejects.toThrow('submitted snapshot is immutable');
  expect(
    (await otherActor.get(`/api/outgoing/${r.id}`).set(h()).expect(404)).body,
  ).not.toHaveProperty('variable_snapshot');
});
