import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { runOutgoing, type OutgoingOptions } from '../server/outgoing.js';
import { scoped } from '../server/security.js';
import type { OutgoingContent, OutgoingMail } from '../shared/outgoing.js';
import { mailVariableText, type MailVariableDocument } from '../shared/mail-variables.js';
import type { ActivityTaskMailDraft } from '../shared/business-activities.js';

const origin = 'http://localhost:3100';
const password = 'sender-grant-fixture-password';
const ownerEmail = 'sender-owner@fixture.invalid';
const salespersonEmail = 'sender-salesperson@fixture.invalid';
const designerEmail = 'sender-designer@fixture.invalid';
const accountEmail = 'granted-sender@163.com';
const sent: OutgoingMail[] = [];
const key = randomBytes(32);
const options: OutgoingOptions = {
  key,
  transport: {
    async send(input) {
      expect(input.email).toBe(accountEmail);
      expect(input.password).toBe('synthetic-sender-grant-code');
      sent.push(input.mail);
    },
    async checkSent() {
      return true;
    },
  },
};
let db: Database;
let workspace: string;
let customer: string;
let account: string;
let otherAccount: string;
let salespersonId: string;
let designerId: string;
let ownerId: string;
let teammateId: string;
let admin: Agent;
let salesperson: Agent;
let designer: Agent;

const headers = () => ({ origin, 'x-workspace-id': workspace });
const grantPath = (actorId: string, accountId = account) =>
  `/api/mail-accounts/${accountId}/senders/${actorId}`;

async function login(agent: Agent, email: string) {
  await agent.post('/api/auth/login').set({ origin }).send({ email, password }).expect(200);
}
function saveDraft(accountId = account, patch: Partial<OutgoingContent> = {}) {
  return salesperson
    .post(`/api/customers/${customer}/outgoing`)
    .set(headers())
    .send({
      id: randomUUID(),
      version: 0,
      content: {
        account_id: accountId,
        project_id: null,
        to: ['client@fixture.invalid'],
        cc: ['teammate@fixture.invalid'],
        bcc: [],
        subject: '尺码确认（合成测试）',
        body: '请核对尺码表。',
        attachments: [
          { name: '尺寸.csv', content: Buffer.from('size,cm\nL,180').toString('base64') },
        ],
        ...patch,
      },
    });
}
function approve(mail: OutgoingMail, variablePreviewDigest?: string) {
  return salesperson
    .post(`/api/outgoing/${mail.id}/approve`)
    .set(headers())
    .send({ version: mail.version, variable_preview_digest: variablePreviewDigest });
}
function schedule(mail: OutgoingMail) {
  return salesperson
    .post(`/api/outgoing/${mail.id}/schedule`)
    .set(headers())
    .send({ version: mail.version, mode: 'now', timezone: 'Asia/Shanghai' });
}
async function getOutgoing(mail: OutgoingMail) {
  return (await salesperson.get(`/api/outgoing/${mail.id}`).set(headers()).expect(200))
    .body as OutgoingMail;
}
async function grant(allowed: boolean) {
  await admin.put(grantPath(salespersonId)).set(headers()).send({ allowed }).expect(200);
}

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: '发件授权测试',
    displayName: '管理员',
    email: ownerEmail,
    password,
  });
  workspace = seed.workspaceId;
  ownerId = seed.actorId;
  const app = createApp(db, { origin, mail: { key }, outgoing: options });
  admin = request.agent(app);
  salesperson = request.agent(app);
  designer = request.agent(app);
  await login(admin, ownerEmail);
  salespersonId = (
    await admin
      .post('/api/members')
      .set(headers())
      .send({ email: salespersonEmail, display_name: '外贸业务员', password })
      .expect(201)
  ).body.actor_id;
  designerId = (
    await admin
      .post('/api/members')
      .set(headers())
      .send({ email: designerEmail, display_name: '版师', password, workspace_mode: 'tasks' })
      .expect(201)
  ).body.actor_id;
  teammateId = (
    await admin
      .post('/api/members')
      .set(headers())
      .send({ email: 'teammate@fixture.invalid', display_name: '外贸同事', password })
      .expect(201)
  ).body.actor_id;
  await login(salesperson, salespersonEmail);
  await login(designer, designerEmail);
  customer = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({ name: '虚构舞团', type: 'group', source: 'other' })
      .expect(201)
  ).body.id;
  await admin
    .put(`/api/customers/${customer}/access/${salespersonId}`)
    .set(headers())
    .send({ access: 'editor' })
    .expect(200);
  for (const email of [accountEmail, 'other-sender@163.com']) {
    const id = (
      await admin
        .post('/api/mail/accounts')
        .set(headers())
        .send({ email, authorization_code: 'synthetic-sender-grant-code' })
        .expect(201)
    ).body.id;
    if (email === accountEmail) account = id;
    else otherAccount = id;
  }
}, 30000);

afterAll(() => db?.close());
beforeEach(() => grant(false));

it('lets admins grant exactly one send-only mailbox to an active CRM member', async () => {
  expect(
    (await salesperson.get('/api/mail-sender-capability').set(headers()).expect(200)).body,
  ).toEqual({ can_send: false });
  await saveDraft().expect(403);
  await salesperson
    .put(grantPath(salespersonId))
    .set(headers())
    .send({ allowed: true })
    .expect(403);
  await admin.put(grantPath(designerId)).set(headers()).send({ allowed: true }).expect(400);
  await admin.put(grantPath(randomUUID())).set(headers()).send({ allowed: true }).expect(400);
  await admin.get(`/api/mail-accounts/${randomUUID()}/senders`).set(headers()).expect(404);
  const memberPath = `/api/members/${salespersonId}`;
  await admin.patch(memberPath).set(headers()).send({ active: false }).expect(200);
  try {
    await admin.put(grantPath(salespersonId)).set(headers()).send({ allowed: true }).expect(400);
  } finally {
    await admin.patch(memberPath).set(headers()).send({ active: true }).expect(200);
  }
  await grant(true);
  expect(
    (await admin.get(`/api/mail-accounts/${account}/senders`).set(headers()).expect(200)).body,
  ).toEqual([{ actor_id: salespersonId }]);
  expect(
    (await salesperson.get('/api/mail-sender-capability').set(headers()).expect(200)).body,
  ).toEqual({ can_send: true });
  const composer = (
    await salesperson.get(`/api/customers/${customer}/compose-options`).set(headers()).expect(200)
  ).body;
  expect(composer.accounts).toEqual([{ id: account, email: accountEmail }]);
  expect(composer.can_test_sender).toBe(false);
  await salesperson.get('/api/mail/accounts').set(headers()).expect(403);
  await salesperson
    .post(`/api/mail/accounts/${account}/test-smtp`)
    .set(headers())
    .send({})
    .expect(403);
  await salesperson.get(`/api/mail-accounts/${account}/senders`).set(headers()).expect(403);
  await designer.get('/api/mail-sender-capability').set(headers()).expect(403);
  await saveDraft(otherAccount).expect(403);
  await saveDraft('malformed').expect(400);
  expect(
    (
      await scoped(db, salespersonId, workspace, (ctx) =>
        ctx.tx.query('SELECT * FROM mail_accounts'),
      )
    ).rows,
  ).toEqual([]);
});

it('sends a confirmed sales draft with the reviewed attachment and CC through its one granted mailbox', async () => {
  await grant(true);
  const variableDocument: MailVariableDocument = {
    version: 1,
    subject: [{ type: 'text', text: '尺码确认（合成测试）' }],
    body: [
      { type: 'text', text: '请核对尺码表。发件人：' },
      { type: 'variable', id: randomUUID(), root: 'sender', field: 'mail_accounts:email' },
    ],
  };
  const mail = (
    await saveDraft(account, {
      body: mailVariableText(variableDocument.body),
      variable_document: variableDocument,
    }).expect(200)
  ).body as OutgoingMail;
  const preview = (
    await salesperson
      .post(`/api/outgoing/${mail.id}/variable-preview`)
      .set(headers())
      .send({ version: mail.version })
      .expect(200)
  ).body;
  expect(preview.can_confirm).toBe(true);
  expect(preview.messages[0].body).toContain(accountEmail);
  await schedule(mail).expect(409);
  await approve(mail, preview.digest).expect(200);
  await schedule(mail).expect(200);
  const before = sent.length;
  await runOutgoing(db, options);
  expect(sent.slice(before)).toHaveLength(1);
  expect(sent.at(-1)).toMatchObject({
    id: mail.id,
    to: mail.to,
    cc: mail.cc,
    body: preview.messages[0].body,
    attachments: mail.attachments,
  });
  expect((await getOutgoing(mail)).status).toBe('submitted');
  await salesperson
    .post(`/api/outgoing/${mail.id}/reconcile`)
    .set(headers())
    .send({ version: mail.version })
    .expect(200);
  expect((await getOutgoing(mail)).status).toBe('sent_confirmed');
});

it('requires fresh confirmation after a queued authorization is revoked or replaced', async () => {
  for (const regrantBeforeWorker of [false, true]) {
    await grant(true);
    const mail = (await saveDraft().expect(200)).body as OutgoingMail;
    await approve(mail).expect(200);
    await schedule(mail).expect(200);
    await grant(false);
    if (regrantBeforeWorker) await grant(true);
    const before = sent.length;
    await runOutgoing(db, options);
    expect(sent).toHaveLength(before);
    expect((await getOutgoing(mail)).status).toBe('needs_review');
  }
});

it('rechecks mailbox and customer scope when a confirmed message is due', async () => {
  await grant(true);
  const before = sent.length;
  const paused = (await saveDraft().expect(200)).body as OutgoingMail;
  await approve(paused).expect(200);
  await schedule(paused).expect(200);
  await admin
    .patch(`/api/mail/accounts/${account}`)
    .set(headers())
    .send({ enabled: false })
    .expect(200);
  try {
    await saveDraft().expect(403);
    await admin.put(grantPath(salespersonId)).set(headers()).send({ allowed: true }).expect(409);
    await runOutgoing(db, options);
    expect((await getOutgoing(paused)).status).toBe('needs_review');
  } finally {
    await admin
      .patch(`/api/mail/accounts/${account}`)
      .set(headers())
      .send({ enabled: true })
      .expect(200);
  }
  const customerAccess = `/api/customers/${customer}/access/${salespersonId}`;
  const readOnly = (await saveDraft().expect(200)).body as OutgoingMail;
  await approve(readOnly).expect(200);
  await schedule(readOnly).expect(200);
  await admin.put(customerAccess).set(headers()).send({ access: 'viewer' }).expect(200);
  try {
    await saveDraft().expect(403);
    await runOutgoing(db, options);
    expect((await getOutgoing(readOnly)).status).toBe('needs_review');
  } finally {
    await admin.put(customerAccess).set(headers()).send({ access: 'editor' }).expect(200);
  }
  expect(sent).toHaveLength(before);
});

it('keeps the original task attached to the draft and blocks a queued handoff after its default CC loses access', async () => {
  await grant(true);
  const teammateAccess = `/api/customers/${customer}/access/${teammateId}`;
  await admin.put(teammateAccess).set(headers()).send({ access: 'viewer' }).expect(200);
  const schema = (
    await admin
      .post('/api/activity-schemas')
      .set(headers())
      .send({ name: '虚构活动表单' })
      .expect(201)
  ).body.id;
  const type = (
    await admin
      .post('/api/activity-types')
      .set(headers())
      .send({ name: '虚构活动类型', schema_id: schema })
      .expect(201)
  ).body.id;
  const run = randomUUID();
  const activity = randomUUID();
  await scoped(db, ownerId, workspace, async (ctx) => {
    await ctx.tx.query(
      `INSERT INTO activity_runs(workspace_id,customer_id,id,actor_id,request_id,input_digest,config_digest,type_id,state,lease_token,source_ids,snapshot)
       VALUES($1,$2,$3,$4,$5,'fixture-input','fixture-config',$6,'completed',$7,'[]','{}')`,
      [workspace, customer, run, ownerId, randomUUID(), type, randomUUID()],
    );
    await ctx.tx.query(
      `INSERT INTO business_activities(workspace_id,customer_id,id,type_id,run_id,event_key,type_name,title,summary,fields,values,ai_values,field_provenance,source_versions,created_by)
       VALUES($1,$2,$3,$4,$5,'fixture','虚构类型','虚构活动','虚构交接','[]','{}','{}','{}','{}',$6)`,
      [workspace, customer, activity, type, run, ownerId],
    );
  });
  const task = (
    await salesperson
      .post(`/api/activities/${activity}/comments`)
      .set(headers())
      .send({
        body: '内部备注（虚构）',
        task_only: true,
        collaboration_brief: '请核对样衣尺寸',
        assignee_id: designerId,
        task_title: '核对样衣尺寸',
        attachment_required: true,
        mail_cc_actor_id: teammateId,
      })
      .expect(201)
  ).body.task;
  await designer
    .patch(`/api/tasks/${task.id}`)
    .set(headers())
    .send({
      version: task.version,
      status: 'completed',
      result: '尺寸已核对（虚构）',
      attachment: {
        filename: '尺码.csv',
        content_type: 'text/csv',
        content_base64: Buffer.from('size,cm\nL,180').toString('base64'),
      },
    })
    .expect(200);
  const handoff = (
    await salesperson
      .get(`/api/activities/${activity}/task-mail-draft/${task.id}`)
      .set(headers())
      .expect(200)
  ).body as ActivityTaskMailDraft;
  expect(handoff.cc?.email).toBe('teammate@fixture.invalid');
  const draftContent: OutgoingContent = {
    account_id: account,
    project_id: handoff.project_id,
    to: ['client@fixture.invalid'],
    cc: [handoff.cc!.email],
    bcc: [],
    subject: '确认尺码（虚构）',
    body: handoff.result,
    attachments: [
      { name: handoff.attachment.filename, content: handoff.attachment.content_base64 },
    ],
  };
  const save = (
    version: number,
    content: OutgoingContent,
    overrides: Record<string, unknown> = {},
  ) =>
    salesperson
      .post(`/api/customers/${customer}/outgoing`)
      .set(headers())
      .send({ id: handoff.draft_id, version, content, handoff_task_id: task.id, ...overrides });
  await save(0, draftContent, { id: randomUUID() }).expect(409);
  const linked = (await save(0, draftContent).expect(200)).body as OutgoingMail;
  expect(linked.handoff_task_id).toBe(task.id);
  await save(0, draftContent, { handoff_task_id: undefined }).expect(409);
  await expect(
    scoped(db, salespersonId, workspace, (ctx) =>
      ctx.tx.query('UPDATE outgoing_mail SET handoff_task_id=NULL WHERE id=$1', [linked.id]),
    ),
  ).rejects.toThrow('outgoing handoff scope is immutable');
  await approve(linked).expect(200);
  await schedule(linked).expect(200);
  await admin.put(teammateAccess).set(headers()).send({ access: null }).expect(200);
  const before = sent.length;
  await runOutgoing(db, options);
  expect(sent).toHaveLength(before);
  expect(await getOutgoing(linked)).toMatchObject({
    status: 'needs_review',
    handoff_task_id: task.id,
    error: expect.stringContaining('默认抄送成员已失去此客户访问权限'),
  });
  await save(
    linked.version,
    { ...draftContent, cc: [], bcc: draftContent.cc },
    { handoff_task_id: undefined },
  ).expect(409);
  const corrected = (
    await save(linked.version, { ...draftContent, cc: [] }, { handoff_task_id: undefined }).expect(
      200,
    )
  ).body as OutgoingMail;
  expect(corrected.handoff_task_id).toBe(task.id);
  await approve(corrected).expect(200);
  await schedule(corrected).expect(200);
  await runOutgoing(db, options);
  expect(sent.slice(before)).toHaveLength(1);
  expect(sent.at(-1)).toMatchObject({ cc: [], attachments: draftContent.attachments });
});
