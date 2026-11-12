import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { createApp } from '../server/app.js';
import { scoped } from '../server/security.js';
import { validateActivityHandoffForOutgoing } from '../server/business-activities.js';
import {
  collaborationAttachmentLimit,
  type ActivityTask,
  type CollaborationTask,
} from '../shared/business-activities.js';

const origin = 'http://localhost:3100';
const password = 'fictional-collaboration-password';
const internalNote = '仅内部可看：私人报价及完整历史';
const brief = '请核对三件舞服的特殊尺码，提交尺码汇总表。';
const result = '三位队员需单独改版，已整理对应尺码。';
const content = Buffer.from(`队员,尺码\n${'虚构数据,M\n'.repeat(12000)}`);
const attachment = {
  filename: '虚构舞服尺码汇总.csv',
  content_type: 'text/csv',
  content_base64: content.toString('base64'),
};
const metadata = {
  filename: attachment.filename,
  content_type: attachment.content_type,
  size_bytes: content.length,
};
let db: Database;
let workspace: string;
let customer: string;
let project: string;
let activity: string;
let admin: Agent;
let editor: Agent;
let viewer: Agent;
let designer: Agent;
let otherDesigner: Agent;
let otherSales: Agent;
let editorId: string;
let viewerId: string;
let designerId: string;
let otherDesignerId: string;
let otherSalesId: string;
const headers = () => ({ origin, 'x-workspace-id': workspace });
const comments = () => `/api/activities/${activity}/comments`;
const filePath = (task: string) => `/api/task-collaborations/${task}/attachment`;
const revokePath = (task: string) => `/api/task-collaborations/${task}/revoke`;
const mailPath = (task: string) => `/api/activities/${activity}/task-mail-draft/${task}`;
const access = (actor: string, level: 'editor' | 'viewer' | null) =>
  admin
    .put(`/api/customers/${customer}/access/${actor}`)
    .set(headers())
    .send({ access: level })
    .expect(200);

async function issue(
  issuer: Agent,
  recipient: string,
  overrides: Record<string, unknown> = {},
): Promise<ActivityTask> {
  return (
    await issuer
      .post(comments())
      .set(headers())
      .send({
        body: internalNote,
        assignee_id: recipient,
        task_title: '核对特殊尺码',
        due_date: '2030-03-05',
        task_only: true,
        collaboration_brief: brief,
        attachment_required: true,
        ...overrides,
      })
      .expect(201)
  ).body.task;
}

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const owner = await createWorkspace(db, {
    name: '虚构协作工作空间',
    email: 'owner-collab@example.invalid',
    displayName: '虚构管理员',
    password,
  });
  workspace = owner.workspaceId;
  const app = createApp(db, { origin });
  admin = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'owner-collab@example.invalid', password })
    .expect(200);

  async function member(label: string, workspaceMode: 'crm' | 'tasks') {
    const email = `${label}-collab@example.invalid`;
    const created = await admin
      .post('/api/members')
      .set(headers())
      .send({ email, display_name: label, workspace_mode: workspaceMode, password })
      .expect(201);
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('origin', origin).send({ email, password }).expect(200);
    return { agent, id: created.body.actor_id as string };
  }
  ({ agent: editor, id: editorId } = await member('editor', 'crm'));
  ({ agent: viewer, id: viewerId } = await member('viewer', 'crm'));
  ({ agent: designer, id: designerId } = await member('designer', 'tasks'));
  ({ agent: otherDesigner, id: otherDesignerId } = await member('other-designer', 'tasks'));
  ({ agent: otherSales, id: otherSalesId } = await member('other-sales', 'crm'));
  customer = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({ name: '虚构客户原名', type: 'group', source: 'other' })
      .expect(201)
  ).body.id;
  project = (
    await admin
      .post(`/api/customers/${customer}/projects`)
      .set(headers())
      .send({ name: '虚构项目原名', type: 'custom' })
      .expect(201)
  ).body.id;
  await access(editorId, 'editor');
  await access(viewerId, 'viewer');
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
  activity = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query(
      "SELECT set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
      [workspace, owner.actorId],
    );
    await tx.query(
      `INSERT INTO activity_runs(workspace_id,customer_id,id,actor_id,request_id,input_digest,config_digest,type_id,state,lease_token,source_ids,snapshot)
       VALUES($1,$2,$3,$4,$5,'fixture-input','fixture-config',$6,'completed',$7,'[]','{}')`,
      [workspace, customer, run, owner.actorId, randomUUID(), type, randomUUID()],
    );
    await tx.query(
      `INSERT INTO business_activities(workspace_id,customer_id,id,project_id,type_id,run_id,event_key,type_name,title,summary,fields,values,ai_values,field_provenance,source_versions,created_by)
       VALUES($1,$2,$3,$4,$5,$6,'fixture','虚构类型','虚构活动原名','完整客户交接上下文','[]','{}','{}','{}','{}',$7)`,
      [workspace, customer, activity, project, type, run, owner.actorId],
    );
    await tx.query(
      `INSERT INTO customer_records(workspace_id,customer_id,project_id,id,kind,body,created_by,source_kind,occurred_at)
       VALUES($1,$2,$3,$4,'inference','虚构私有客户原文',$5,'manual',now())`,
      [workspace, customer, project, randomUUID(), owner.actorId],
    );
  });
}, 30000);

afterAll(async () => {
  await db?.close();
});

it('delivers only the assigned briefing, requires the selected file and returns the same result to the original activity', async () => {
  const directory = (
    await editor
      .get(`/api/activity-collaboration-members?customer_id=${customer}`)
      .set(headers())
      .expect(200)
  ).body;
  expect(directory).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        actor_id: designerId,
        workspace_mode: 'tasks',
        can_receive_cc: false,
      }),
      expect.objectContaining({ actor_id: viewerId, workspace_mode: 'crm', can_receive_cc: true }),
    ]),
  );
  expect(JSON.stringify(directory)).not.toContain('@example.invalid');
  await editor
    .post(comments())
    .set(headers())
    .send({
      body: internalNote,
      assignee_id: designerId,
      task_title: '缺少单独说明',
      task_only: true,
    })
    .expect(400);
  await editor
    .post(comments())
    .set(headers())
    .send({
      body: internalNote,
      assignee_id: designerId,
      task_title: '无权抄送',
      task_only: true,
      collaboration_brief: brief,
      mail_cc_actor_id: otherDesignerId,
    })
    .expect(400);
  const requestId = randomUUID();
  const task = await issue(editor, designerId, {
    mail_cc_actor_id: viewerId,
    request_id: requestId,
  });
  expect(
    (await issue(editor, designerId, { mail_cc_actor_id: viewerId, request_id: requestId })).id,
  ).toBe(task.id);
  const listed = (await designer.get('/api/tasks').set(headers()).expect(200))
    .body as CollaborationTask[];
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    id: task.id,
    task_only: true,
    collaboration_brief: brief,
    attachment_required: true,
    due_date: '2030-03-05',
    status: 'open',
    attachment: null,
  });
  for (const hidden of [
    customer,
    project,
    activity,
    internalNote,
    editorId,
    viewerId,
    '虚构客户原名',
  ])
    expect(JSON.stringify(listed)).not.toContain(hidden);
  expect((await otherDesigner.get('/api/tasks').set(headers()).expect(200)).body).toEqual([]);
  expect((await otherSales.get('/api/tasks').set(headers()).expect(200)).body).toEqual([]);
  await designer.get(`/api/customers/${customer}`).set(headers()).expect(403);
  await designer.get(`/api/customers/${customer}/records`).set(headers()).expect(403);
  await designer.get(`/api/activities/${activity}`).set(headers()).expect(403);
  await otherSales.get(`/api/activities/${activity}`).set(headers()).expect(404);
  for (const member of [otherDesigner, otherSales])
    await member
      .patch(`/api/tasks/${task.id}`)
      .set(headers())
      .send({ version: task.version, status: 'in_progress' })
      .expect(404);
  await designer.get(filePath(task.id)).set(headers()).expect(404);
  const payload = { version: task.version, status: 'completed', result };
  await designer.patch(`/api/tasks/${task.id}`).set(headers()).send(payload).expect(400);
  await designer
    .patch(`/api/tasks/${task.id}`)
    .set(headers())
    .send({ ...payload, attachment: { ...attachment, filename: '../越界.csv' } })
    .expect(400);
  await designer
    .patch(`/api/tasks/${task.id}`)
    .set(headers())
    .send({
      ...payload,
      attachment: {
        ...attachment,
        content_base64: Buffer.alloc(collaborationAttachmentLimit + 4, 'A').toString('base64'),
      },
    })
    .expect(413);
  expect(attachment.content_base64.length).toBeGreaterThan(128 * 1024);
  const completed = (
    await designer
      .patch(`/api/tasks/${task.id}`)
      .set(headers())
      .send({ ...payload, attachment })
      .expect(200)
  ).body;
  expect(completed).toMatchObject({
    id: task.id,
    result,
    status: 'completed',
    attachment: metadata,
  });
  expect(completed).not.toHaveProperty('activity_id');
  expect(JSON.stringify(completed)).not.toContain(attachment.content_base64);
  const replay = (
    await designer
      .patch(`/api/tasks/${task.id}`)
      .set(headers())
      .send({ ...payload, attachment })
      .expect(200)
  ).body;
  expect(replay.version).toBe(completed.version);
  await designer
    .patch(`/api/tasks/${task.id}`)
    .set(headers())
    .send({ ...payload, result: '错误地重写旧结果', attachment })
    .expect(409);
  expect((await designer.get(filePath(task.id)).set(headers()).expect(200)).body).toEqual({
    ...attachment,
    size_bytes: content.length,
  });
  for (const member of [otherDesigner, otherSales, viewer])
    await member.get(filePath(task.id)).set(headers()).expect(404);
  await designer.get(mailPath(task.id)).set(headers()).expect(403);
  await otherSales.get(mailPath(task.id)).set(headers()).expect(404);
  await viewer.get(mailPath(task.id)).set(headers()).expect(403);

  const detail = (await editor.get(`/api/activities/${activity}`).set(headers()).expect(200)).body;
  expect(detail.tasks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: task.id,
        result,
        result_record_id: null,
        attachment: metadata,
        assignee_display_name: 'designer',
      }),
    ]),
  );
  expect(JSON.stringify(detail)).not.toContain(attachment.content_base64);
  const recordCount = (
    await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM customer_records WHERE workspace_id=$1 AND customer_id=$2',
      [workspace, customer],
    )
  ).rows[0].count;
  expect(recordCount).toBe(1);
  const draft = (await editor.get(mailPath(task.id)).set(headers()).expect(200)).body;
  expect(draft).toMatchObject({
    customer_id: customer,
    project_id: project,
    result,
    cc: { actor_id: viewerId, email: 'viewer-collab@example.invalid' },
    attachment: { ...attachment, size_bytes: content.length },
  });
  expect(draft.draft_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect((await editor.get(mailPath(task.id)).set(headers()).expect(200)).body.draft_id).toBe(
    draft.draft_id,
  );
  expect((await admin.get(mailPath(task.id)).set(headers()).expect(200)).body.draft_id).not.toBe(
    draft.draft_id,
  );
  const validateOutgoing = (cc: string[], draftId = draft.draft_id) =>
    scoped(db, editorId, workspace, (ctx) =>
      validateActivityHandoffForOutgoing(ctx, {
        taskId: task.id,
        draftId,
        customerId: customer,
        projectId: project,
        cc,
      }),
    );
  await expect(validateOutgoing(['viewer-collab@example.invalid'])).resolves.toBeUndefined();
  await expect(validateOutgoing([], randomUUID())).rejects.toThrow('草稿与当前账号');
  await access(viewerId, null);
  expect((await editor.get(mailPath(task.id)).set(headers()).expect(200)).body.cc).toBeNull();
  await expect(validateOutgoing(['viewer-collab@example.invalid'])).rejects.toThrow('移除此抄送');
  await expect(validateOutgoing([])).resolves.toBeUndefined();
  await access(viewerId, 'viewer');

  await viewer
    .post(revokePath(task.id))
    .set(headers())
    .send({ version: completed.version })
    .expect(403);
  await editor.post(revokePath(task.id)).set(headers()).send({ version: task.version }).expect(409);
  const revoked = (
    await editor
      .post(revokePath(task.id))
      .set(headers())
      .send({ version: completed.version })
      .expect(200)
  ).body;
  expect(revoked.revoked_at).toBeTruthy();
  expect((await designer.get('/api/tasks').set(headers()).expect(200)).body).toEqual([]);
  await designer.get(filePath(task.id)).set(headers()).expect(404);
  await designer
    .patch(`/api/tasks/${task.id}`)
    .set(headers())
    .send({ ...payload, attachment })
    .expect(404);
  await editor.get(mailPath(task.id)).set(headers()).expect(404);
  await expect(validateOutgoing([])).rejects.toThrow('附件已失效');
  const retained = (await editor.get(`/api/activities/${activity}`).set(headers()).expect(200)).body
    .tasks[0];
  expect(retained).toMatchObject({ id: task.id, result, revoked_at: revoked.revoked_at });
});

it('checks project archiving, the issuer losing edit access and assignee disablement on existing sessions', async () => {
  const task = await issue(editor, otherDesignerId, { attachment_required: false });
  const own = () => otherDesigner.get('/api/tasks').set(headers());
  expect((await own().expect(200)).body.map((item: CollaborationTask) => item.id)).toEqual([
    task.id,
  ]);
  const changeProject = async (archived: boolean) => {
    const current = (
      await admin.get(`/api/customers/${customer}/projects/${project}`).set(headers()).expect(200)
    ).body;
    await admin
      .patch(`/api/customers/${customer}/projects/${project}`)
      .set(headers())
      .send({ version: current.version, archived })
      .expect(200);
  };
  await changeProject(true);
  expect((await own().expect(200)).body).toEqual([]);
  await otherDesigner
    .patch(`/api/tasks/${task.id}`)
    .set(headers())
    .send({ version: task.version, status: 'completed', result })
    .expect(404);
  await changeProject(false);
  await access(editorId, 'viewer');
  expect((await own().expect(200)).body).toEqual([]);
  await otherDesigner.get(filePath(task.id)).set(headers()).expect(404);
  await access(editorId, 'editor');
  const completed = (
    await otherDesigner
      .patch(`/api/tasks/${task.id}`)
      .set(headers())
      .send({ version: task.version, status: 'completed', result })
      .expect(200)
  ).body;
  expect(completed).toMatchObject({ status: 'completed', attachment: null });
  await admin
    .patch(`/api/members/${otherDesignerId}`)
    .set(headers())
    .send({ active: false })
    .expect(200);
  await own().expect(404);
  await otherDesigner.get(filePath(task.id)).set(headers()).expect(404);
});

it('permits a CRM user to complete an explicitly delegated task without granting access to the customer', async () => {
  const task = await issue(editor, otherSalesId, { attachment_required: false });
  const rows = (await otherSales.get('/api/tasks').set(headers()).expect(200)).body;
  expect(rows).toEqual([
    expect.objectContaining({ id: task.id, task_only: true, collaboration_brief: brief }),
  ]);
  expect(rows[0]).not.toHaveProperty('customer_id');
  await otherSales.get(`/api/customers/${customer}`).set(headers()).expect(404);
  await otherSales.get(`/api/activities/${activity}`).set(headers()).expect(404);
  await otherSales
    .patch(`/api/tasks/${task.id}`)
    .set(headers())
    .send({ version: task.version, status: 'completed', result })
    .expect(200);
  await otherSales.get(`/api/customers/${customer}`).set(headers()).expect(404);
  const original = (await editor.get(`/api/activities/${activity}`).set(headers()).expect(200))
    .body;
  expect(original.tasks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: task.id, result, result_record_id: null }),
    ]),
  );
});
