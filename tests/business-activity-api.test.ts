import { beforeAll, afterAll, it, expect } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { createApp } from '../server/app.js';
import { scoped } from '../server/security.js';
import {
  ensureCommunicationRecords,
  recordEvidence,
  syncKnowledgeOnce,
} from '../server/knowledge.js';
import { sourceMaterials, syncSourceIndexOnce } from '../server/source-index.js';
import { sourceEmbeddingModel } from '../shared/source-search.js';
import {
  activityBaseField as base,
  type BusinessActivityType,
} from '../shared/business-activities.js';
import type { ActivityModelInput, ActivityModelOutput } from '../server/activity-model.js';

const origin = 'http://localhost:3100',
  password = 'activity-api-fixture-password';
let db: Database,
  admin: Agent,
  editor: Agent,
  viewer: Agent,
  denied: Agent,
  outsider: Agent,
  w: string,
  actor: string,
  editorId: string,
  viewerId: string,
  deniedId: string,
  customer: string,
  otherCustomer: string,
  person: string,
  otherPerson: string,
  foreignPerson: string,
  mailId: string,
  activityId: string;
let activityType: BusinessActivityType,
  calls = 0,
  mode: 'ok' | 'throw' | 'badquote' | 'reject' = 'ok';
let messages = [
  {
    id: 'api-wechat-one',
    at: '2026-10-26T10:00:00+08:00',
    speaker: '张API老师',
    from_me: false,
    text: '本批只询问蓝色款式，请先核对。',
  },
];
const mailBody =
  '客户：想定制60套蓝色舞服。\n我方：请补尺码表，我核对后回复可行方案，尚需公司确认。';
const headers = () => ({ origin, 'x-workspace-id': w });
const run = <T>(fn: (ctx: import('../server/security.js').Context) => Promise<T>) =>
  scoped(db, actor, w, fn);
async function model(input: ActivityModelInput): Promise<unknown> {
  calls++;
  if (mode === 'throw') throw new Error('synthetic provider failure');
  if (input.mode === 'verify')
    return {
      events: input.candidate!.events.map((e) => ({
        event_id: e.event_id,
        supported: mode !== 'reject',
        reason: 'synthetic semantic verdict',
        fields: e.fields.map((f) => ({
          field_id: f.field_id,
          supported: mode !== 'reject',
          reason: 'synthetic field verdict',
        })),
      })),
    };
  const source = input.sources[0];
  const output: ActivityModelOutput = {
    events: [
      {
        event_id: 'event-1',
        source_ids: [source.id],
        fields: input.fields.map((field) => {
          let value: string | number | null = null;
          if (field.id === base.title) value = '60套舞服询单';
          else if (field.id === base.summary) value = '客户询问60套，我方请求尺码表后核实方案。';
          else if (field.id === base.occurred) value = source.occurred_at;
          else if (field.name === '需求数量') value = 60;
          else if (field.name === '后续安排')
            value = '我方请客户补尺码表，核对后回复，方案待公司确认。';
          return {
            field_id: field.id,
            value,
            evidence: value === null ? [] : [{ source_id: source.id, quote: source.body }],
          };
        }),
      },
    ],
  };
  if (mode === 'badquote') output.events[0].fields[0].evidence[0].quote = '原文中不存在的引文';
  return output;
}
async function sourceInput(extra: Record<string, unknown> = {}) {
  const source = (
    await admin
      .get(`/api/activity-sources?customer_id=${customer}&mail_id=${mailId}`)
      .set(headers())
      .expect(200)
  ).body;
  return {
    customer_id: customer,
    type_id: activityType.id,
    source_ids: source.map((s: { id: string }) => s.id),
    linked_person_ids: [person],
    request_id: randomUUID(),
    ...extra,
  };
}
async function queues() {
  return run(async (ctx) => ({
    knowledge: (
      await ctx.tx.query<{ actor_id: string; requested_version: number; state: string }>(
        'SELECT actor_id,requested_version,state FROM knowledge_sync WHERE workspace_id=$1 AND customer_id=$2',
        [w, customer],
      )
    ).rows[0],
    raw: (
      await ctx.tx.query<{ actor_id: string; requested_version: number; state: string }>(
        'SELECT actor_id,requested_version,state FROM source_index_sync WHERE workspace_id=$1 AND customer_id=$2',
        [w, customer],
      )
    ).rows[0],
  }));
}

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Activity API fixture',
    email: 'activity-api-admin@example.invalid',
    displayName: 'API Admin',
    password,
  });
  w = seed.workspaceId;
  actor = seed.actorId;
  const app = createApp(db, {
    origin,
    activities: { transport: { generate: model } },
    wechat: {
      actorId: actor,
      connectorRequired: false,
      connectorBindingEnabled: false,
      transport: {
        async status() {
          return { state: 'ready', message: 'fiction fixture', account_key: 'api-fiction-account' };
        },
        async resolve() {
          return [
            {
              id: 'api-fiction-talker',
              name: '张API老师',
              remark: '',
              wechat_id: 'api-fiction-only',
            },
          ];
        },
        async openApp() {},
        async history() {
          return { warnings: [], messages };
        },
      },
    },
  });
  admin = request.agent(app);
  editor = request.agent(app);
  viewer = request.agent(app);
  denied = request.agent(app);
  outsider = request.agent(app);
  await admin
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'activity-api-admin@example.invalid', password })
    .expect(200);
  for (const [agent, label] of [
    [editor, 'editor'],
    [viewer, 'viewer'],
    [denied, 'denied'],
  ] as const) {
    const row = (
      await admin
        .post('/api/members')
        .set(headers())
        .send({
          email: `activity-api-${label}@example.invalid`,
          display_name: `API ${label}`,
          password,
        })
        .expect(201)
    ).body;
    if (label === 'editor') editorId = row.actor_id;
    else if (label === 'viewer') viewerId = row.actor_id;
    else deniedId = row.actor_id;
    await agent
      .post('/api/auth/login')
      .set('origin', origin)
      .send({ email: `activity-api-${label}@example.invalid`, password })
      .expect(200);
  }
  await createWorkspace(db, {
    name: 'Other workspace',
    email: 'activity-api-outsider@example.invalid',
    displayName: 'Outsider',
    password,
  });
  await outsider
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'activity-api-outsider@example.invalid', password })
    .expect(200);
  customer = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({ name: 'API A fixture', type: 'group', source: 'other' })
      .expect(201)
  ).body.id;
  otherCustomer = (
    await admin
      .post('/api/customers')
      .set(headers())
      .send({ name: 'API B private fixture', type: 'group', source: 'other' })
      .expect(201)
  ).body.id;
  for (const [member, access] of [
    [editorId, 'editor'],
    [viewerId, 'viewer'],
  ])
    await admin
      .put(`/api/customers/${customer}/access/${member}`)
      .set(headers())
      .send({ access })
      .expect(200);
  person = (
    await admin
      .post('/api/people')
      .set(headers())
      .send({ customer_id: customer, name: '张API老师' })
      .expect(201)
  ).body.id;
  otherPerson = (
    await admin
      .post('/api/people')
      .set(headers())
      .send({ customer_id: customer, name: '李API老师' })
      .expect(201)
  ).body.id;
  foreignPerson = (
    await admin
      .post('/api/people')
      .set(headers())
      .send({ customer_id: otherCustomer, name: '陈API老师' })
      .expect(201)
  ).body.id;
  const root = (
    await admin
      .post('/api/activity-schemas')
      .set(headers())
      .send({ name: '客户业务沟通' })
      .expect(201)
  ).body;
  const child = (
    await admin
      .post('/api/activity-schemas')
      .set(headers())
      .send({
        name: '本业务询单',
        parent_id: root.id,
        fields: [
          { name: '需求数量', kind: 'number', ai_enabled: true, guidance: '只填本次原文明说数量' },
          { name: '未提供规格', kind: 'text', ai_enabled: true, guidance: '无信息保持null' },
        ],
      })
      .expect(201)
  ).body;
  activityType = (
    await admin
      .post('/api/activity-types')
      .set(headers())
      .send({
        name: '员工常用询单',
        schema_id: child.id,
        fields: [
          {
            name: '后续安排',
            kind: 'text',
            ai_enabled: true,
            guidance: '保留我方请求，不代替客户接受或公司确认',
          },
        ],
      })
      .expect(201)
  ).body;
  const account = randomUUID();
  mailId = randomUUID();
  await run(async (ctx) => {
    await ctx.tx.query(
      'INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by) VALUES($1,$2,$3,$4,$5)',
      [w, account, 'activity-api@example.invalid', 'fiction-only', actor],
    );
    await ctx.tx.query(
      "INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason) VALUES($1,$2,$3,$4,$5,$6,'API询单',$7,'[]','[]','[]','2026-10-26T09:00:00+08:00','inbound',$8,'email')",
      [
        w,
        mailId,
        account,
        'activity-api@example.invalid',
        customer,
        'api-fiction-mail',
        JSON.stringify([{ name: '张API老师', address: 'api-zhang@example.invalid' }]),
        mailBody,
      ],
    );
    await ctx.tx.query(
      'INSERT INTO mail_people(workspace_id,customer_id,message_id,person_id) VALUES($1,$2,$3,$4)',
      [w, customer, mailId, person],
    );
    await ensureCommunicationRecords(ctx, customer);
  });
}, 30000);
afterAll(() => db.close());

it('requires real sessions, workspace membership and write rights on routed mutations', async () => {
  const app = createApp(db, { origin, activities: { transport: { generate: model } } });
  await request(app).get(`/api/activities?customer_id=${customer}`).set(headers()).expect(401);
  await outsider.get('/api/activity-schemas').set(headers()).expect(404);
  await denied.get(`/api/activity-sources?customer_id=${customer}`).set(headers()).expect(404);
  await viewer.post('/api/activity-schemas').set(headers()).send({ name: 'forbidden' }).expect(403);
  const before = calls;
  const readOnlyInput = await sourceInput();
  await viewer.post('/api/activities/generate').set(headers()).send(readOnlyInput).expect(403);
  expect(calls).toBe(before);
  const foreign = (
    await viewer.get(`/api/activities?customer_id=${otherCustomer}`).set(headers()).expect(404)
  ).body;
  expect(JSON.stringify(foreign)).not.toContain('API B private');
});
it('limits source entrypoints to the exact archived WeChat batch or selected email', async () => {
  const first = (
    await admin
      .post('/api/wechat/queries')
      .set(headers())
      .send({
        identity: '张API老师',
        start: '2026-10-26',
        end: '2026-10-26',
        request_id: randomUUID(),
      })
      .expect(200)
  ).body.preview;
  await admin
    .post(`/api/wechat/queries/${first.id}/associate`)
    .set(headers())
    .send({ customer_id: customer, person_id: person })
    .expect(200);
  messages = [
    {
      id: 'api-wechat-two',
      at: '2026-10-26T11:00:00+08:00',
      speaker: '张API老师',
      from_me: false,
      text: '第二批是独立售后问题，不在第一批。',
    },
  ];
  const second = (
    await admin
      .post('/api/wechat/queries')
      .set(headers())
      .send({
        identity: '张API老师',
        start: '2026-10-26',
        end: '2026-10-26',
        request_id: randomUUID(),
      })
      .expect(200)
  ).body.preview;
  expect(second.state).toBe('associated');
  const batch = (
    await admin
      .get(`/api/activity-sources?customer_id=${customer}&wechat_query_id=${first.id}`)
      .set(headers())
      .expect(200)
  ).body;
  expect(batch).toHaveLength(1);
  expect(batch[0].body).toContain('本批只询问');
  expect(JSON.stringify(batch)).not.toContain('第二批');
  expect(batch[0].channel).toBe('wechat');
  await viewer
    .get(`/api/activity-sources?customer_id=${customer}&wechat_query_id=${first.id}`)
    .set(headers())
    .expect(404);
  await admin
    .get(`/api/activity-sources?customer_id=${otherCustomer}&wechat_query_id=${first.id}`)
    .set(headers())
    .expect(404);
  const mail = (
    await admin
      .get(`/api/activity-sources?customer_id=${customer}&mail_id=${mailId}`)
      .set(headers())
      .expect(200)
  ).body;
  expect(mail).toHaveLength(1);
  expect(mail[0].body).toBe(mailBody);
});
it('routes injected model extraction/verification and returns the same activity on company and explicit contact pages', async () => {
  mode = 'ok';
  const data = await sourceInput();
  const before = await run((ctx) =>
    ctx.tx.query('SELECT id,body FROM customer_records WHERE workspace_id=$1 ORDER BY id', [w]),
  );
  const output = (
    await admin.post('/api/activities/generate').set(headers()).send(data).expect(201)
  ).body;
  expect(output.activities).toHaveLength(1);
  activityId = output.activities[0].id;
  const quantity = activityType.effective_fields.find((f) => f.name === '需求数量')!.id;
  expect(output.activities[0].values[quantity]).toBe(60);
  expect(
    output.activities[0].values[
      activityType.effective_fields.find((f) => f.name === '未提供规格')!.id
    ],
  ).toBeNull();
  const again = (await admin.post('/api/activities/generate').set(headers()).send(data).expect(201))
    .body;
  expect(again.reused).toBe(true);
  expect(again.activities[0].id).toBe(activityId);
  expect(
    await run((ctx) =>
      ctx.tx.query('SELECT id,body FROM customer_records WHERE workspace_id=$1 ORDER BY id', [w]),
    ),
  ).toEqual(before);
  const company = (
    await admin.get(`/api/activities?customer_id=${customer}`).set(headers()).expect(200)
  ).body;
  const contact = (
    await admin
      .get(`/api/activities?customer_id=${customer}&person_id=${person}`)
      .set(headers())
      .expect(200)
  ).body;
  expect(company.items.map((a: { id: string }) => a.id)).toEqual(
    contact.items.map((a: { id: string }) => a.id),
  );
  expect(
    (
      await admin
        .get(`/api/activities?customer_id=${customer}&person_id=${otherPerson}`)
        .set(headers())
        .expect(200)
    ).body.items,
  ).toEqual([]);
  const detail = (
    await admin.get(`/api/activities/${activityId}?person_id=${person}`).set(headers()).expect(200)
  ).body;
  expect(detail.id).toBe(activityId);
  expect(detail.sources[0].body).toBe(mailBody);
  await admin
    .get(`/api/activities/${activityId}?person_id=${otherPerson}`)
    .set(headers())
    .expect(404);
  await denied.get(`/api/activities/${activityId}`).set(headers()).expect(404);
});
it('rejects forged contact/source attribution and reports model failures without a local fallback', async () => {
  const forged = await sourceInput({ linked_person_ids: [foreignPerson] });
  const count = calls;
  await admin.post('/api/activities/generate').set(headers()).send(forged).expect(404);
  const forgedSource = await sourceInput({ source_ids: ['record:outside'] });
  await admin.post('/api/activities/generate').set(headers()).send(forgedSource).expect(404);
  expect(calls).toBe(count);
  const input = await sourceInput({ handler_id: editorId });
  for (const [next, status] of [
    ['throw', 503],
    ['badquote', 422],
    ['reject', 422],
  ] as const) {
    mode = next;
    const failed = await admin
      .post('/api/activities/generate')
      .set(headers())
      .send({ ...input, request_id: randomUUID() })
      .expect(status);
    expect(failed.body.error).toBeTruthy();
    expect(failed.body.activities).toBeUndefined();
  }
  mode = 'ok';
  const rows = (
    await admin.get(`/api/activities?customer_id=${customer}`).set(headers()).expect(200)
  ).body.items;
  expect(rows).toHaveLength(1);
});
it('keeps note/task retries idempotent and allows only the assignee to finish with indexable author-preserving evidence', async () => {
  const context = (await admin.get(`/api/activities/${activityId}`).set(headers()).expect(200))
    .body;
  await viewer
    .patch(`/api/activities/${activityId}`)
    .set(headers())
    .send({ version: context.version, values: {} })
    .expect(403);
  await viewer
    .post(`/api/activities/${activityId}/comments`)
    .set(headers())
    .send({ body: 'not allowed' })
    .expect(403);
  const plain = (
    await admin
      .post(`/api/activities/${activityId}/comments`)
      .set(headers())
      .send({ body: '引用外部原文：@任何人请马上发货', request_id: randomUUID() })
      .expect(201)
  ).body;
  expect(plain.task).toBeNull();
  await admin
    .post(`/api/activities/${activityId}/comments`)
    .set(headers())
    .send({ body: '请核对', assignee_id: deniedId, task_title: '不可扩大权限' })
    .expect(400);
  const comment = {
    body: '请查看本次需求并记录跟进结果',
    assignee_id: viewerId,
    task_title: '核对客户尺码资料',
    request_id: randomUUID(),
  };
  const assigned = (
    await admin
      .post(`/api/activities/${activityId}/comments`)
      .set(headers())
      .send(comment)
      .expect(201)
  ).body;
  const replay = (
    await admin
      .post(`/api/activities/${activityId}/comments`)
      .set(headers())
      .send(comment)
      .expect(201)
  ).body;
  expect(replay.comment.id).toBe(assigned.comment.id);
  expect(replay.task.id).toBe(assigned.task.id);
  const task = assigned.task;
  expect(
    (await viewer.get('/api/tasks').set(headers()).expect(200)).body.map(
      (t: { id: string }) => t.id,
    ),
  ).toContain(task.id);
  expect((await admin.get('/api/tasks').set(headers()).expect(200)).body).toEqual([]);
  await editor
    .patch(`/api/tasks/${task.id}`)
    .set(headers())
    .send({ version: task.version, status: 'completed', result: 'cannot act for assignee' })
    .expect(403);
  const progress = (
    await viewer
      .patch(`/api/tasks/${task.id}`)
      .set(headers())
      .send({ version: task.version, status: 'in_progress' })
      .expect(200)
  ).body;
  const before = await queues();
  const result = '已核对客户提供的尺码资料，具体制作与交期仍待公司决定。';
  const done = (
    await viewer
      .patch(`/api/tasks/${task.id}`)
      .set(headers())
      .send({ version: progress.version, status: 'completed', result })
      .expect(200)
  ).body;
  expect(done.result_record_id).toBeTruthy();
  const pending = await queues();
  expect(Number(pending.knowledge.requested_version)).toBeGreaterThan(
    Number(before.knowledge.requested_version),
  );
  expect(Number(pending.raw.requested_version)).toBeGreaterThan(
    Number(before.raw.requested_version),
  );
  expect(pending.knowledge.state).toBe('pending');
  expect(pending.raw.state).toBe('pending');
  expect(pending.knowledge.actor_id).toBe(actor);
  expect(pending.raw.actor_id).toBe(actor);
  const original = await scoped(db, viewerId, w, (ctx) =>
    recordEvidence(ctx, customer, done.result_record_id),
  );
  expect(original.record.created_by).toBe(viewerId);
  expect(original.record.kind).toBe('inference');
  expect(original.sources.some((s) => s.body.includes(result))).toBe(true);
  const newDetail = (
    await viewer.get(`/api/activities/${activityId}?person_id=${person}`).set(headers()).expect(200)
  ).body;
  expect(newDetail.can_edit).toBe(false);
  expect(newDetail.tasks[0].status).toBe('completed');
  expect(
    newDetail.sources.some((s: { record_id: string }) => s.record_id === done.result_record_id),
  ).toBe(true);
  expect(
    (await run((ctx) => sourceMaterials(ctx, customer))).some(
      (s) => s.record_id === done.result_record_id,
    ),
  ).toBe(true);
  const replayDone = (
    await viewer
      .patch(`/api/tasks/${task.id}`)
      .set(headers())
      .send({ version: progress.version, status: 'completed', result })
      .expect(200)
  ).body;
  expect(replayDone.result_record_id).toBe(done.result_record_id);
  expect(await queues()).toEqual(pending);
  await viewer
    .post(`/api/customers/${customer}/records`)
    .set(headers())
    .send({ kind: 'inference', body: '任务完成不授予任意资料写入权' })
    .expect(403);
  // Fake worker transports exercise actual publication and vector persistence, not
  // a claim of real Graphiti/model quality or a running production worker.
  await syncKnowledgeOnce(
    db,
    {
      async sync() {
        return [];
      },
      async discard() {},
    },
    { workspace_id: w, customer_id: customer },
  );
  await syncSourceIndexOnce(db, {
    async embed({ texts }) {
      return {
        model: sourceEmbeddingModel,
        dimensions: 384,
        vectors: texts.map(() => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))),
      };
    },
  });
  const indexed = await queues();
  expect(indexed.knowledge.state).toBe('ready');
  expect(indexed.raw.state).toBe('ready');
});
