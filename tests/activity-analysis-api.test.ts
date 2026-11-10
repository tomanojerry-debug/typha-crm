import { afterAll, beforeAll, expect, it } from 'vitest';
import request, { type Agent } from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped, type Context } from '../server/security.js';
import * as activities from '../server/business-activities.js';
import * as service from '../server/service.js';
import { activityBaseField as base, type ActivitySchema } from '../shared/business-activities.js';
import type { ActivityModelOptions } from '../server/activity-model.js';
import type {
  ActivityAnalysisConfig,
  ActivityAnalysisResult,
} from '../shared/activity-analysis.js';
import type { ReportDashboard } from '../shared/reports.js';

const origin = 'http://localhost:3100';
const password = 'analysis-api-fixture-password';
const sourceBody = 'API_FEEDBACK_ORIGINAL：A214 v2 S码肩带偏长。售后反馈。';
let db: Database, owner: Agent, viewer: Agent;
let workspace: string, actor: string, viewerActor: string, foreignWorkspace: string;
let customerA: string, customerB: string, activityA: string, activityB: string, mailB: string;
let config: ActivityAnalysisConfig, board: ReportDashboard;
let fieldValues: Record<string, string> = {};
const h = () => ({ origin, 'x-workspace-id': workspace });
const run = <T>(fn: (ctx: Context) => Promise<T>) => scoped(db, actor, workspace, fn);
const query = (agent = owner, extra: Record<string, unknown> = {}) =>
  agent
    .post('/api/reports/activity-analysis/query')
    .set(h())
    .send({ config, ...extra });
const fakeModel: ActivityModelOptions = {
  transport: {
    async generate(input) {
      if (input.mode === 'verify')
        return {
          events: input.candidate!.events.map((event) => ({
            event_id: event.event_id,
            supported: true,
            reason: 'synthetic API fixture',
            fields: event.fields.map((field) => ({
              field_id: field.field_id,
              supported: true,
              reason: 'synthetic API fixture',
            })),
          })),
        };
      const source = input.sources[0];
      return {
        events: [
          {
            event_id: 'feedback',
            source_ids: [source.id],
            fields: input.fields.map((field) => {
              const value =
                field.id === base.title
                  ? 'A214肩带反馈'
                  : field.id === base.occurred
                    ? source.occurred_at
                    : (fieldValues[field.id] ?? null);
              return {
                field_id: field.id,
                value,
                evidence: value === null ? [] : [{ source_id: source.id, quote: source.body }],
              };
            }),
          },
        ],
      };
    },
  },
};

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Feedback report API fixture',
    email: 'analysis-owner@example.invalid',
    displayName: 'Fixture owner',
    password,
  });
  workspace = seed.workspaceId;
  actor = seed.actorId;
  const foreign = await createWorkspace(db, {
    name: 'Other feedback fixture',
    email: 'analysis-viewer@example.invalid',
    displayName: 'Fixture viewer',
    password,
  });
  viewerActor = foreign.actorId;
  foreignWorkspace = foreign.workspaceId;
  await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
    workspace,
    viewerActor,
  ]);
  const app = createApp(db, { origin, activities: fakeModel });
  owner = request.agent(app);
  viewer = request.agent(app);
  for (const [agent, email] of [
    [owner, 'analysis-owner@example.invalid'],
    [viewer, 'analysis-viewer@example.invalid'],
  ] as const)
    await agent.post('/api/auth/login').set('origin', origin).send({ email, password }).expect(200);
  const customerIds: string[] = [];
  for (const name of ['Synthetic dealer A', 'Synthetic dealer B'])
    customerIds.push(
      String(
        (
          await run((ctx) =>
            service.insert(ctx, 'customers', { name, type: 'distributor', source: 'email' }),
          )
        ).id,
      ),
    );
  [customerA, customerB] = customerIds;
  await owner
    .put(`/api/customers/${customerA}/access/${viewerActor}`)
    .set(h())
    .send({ access: 'viewer' })
    .expect(200);
  const schema: ActivitySchema = (
    await owner
      .post('/api/activity-schemas')
      .set(h())
      .send({
        name: 'Explicitly configured feedback',
        fields: [
          { name: '货号', kind: 'text', ai_enabled: true, guidance: '仅取原文明确货号' },
          {
            name: '现象',
            kind: 'select',
            options: ['肩带偏长', '肩带偏短'],
            ai_enabled: true,
            guidance: '仅取原文明确问题',
          },
          { name: '修订', kind: 'text', ai_enabled: true, guidance: '仅取原文明确版本' },
          {
            name: '环节',
            kind: 'select',
            options: ['售后', '样衣'],
            ai_enabled: true,
            guidance: '仅取原文明确反馈环节',
          },
        ],
      })
      .expect(201)
  ).body;
  const field = (name: string) => schema.fields.find((item) => item.name === name)!.id;
  const type = (
    await owner
      .post('/api/activity-types')
      .set(h())
      .send({ name: 'Feedback fixture', schema_id: schema.id })
      .expect(201)
  ).body;
  config = {
    typeId: type.id,
    fields: {
      product: field('货号'),
      issue: field('现象'),
      version: field('修订'),
      stage: field('环节'),
    },
  };
  fieldValues = {
    [field('货号')]: 'A214',
    [field('现象')]: '肩带偏长',
    [field('修订')]: 'v2',
    [field('环节')]: '售后',
  };
  const ids: string[] = [];
  const accountId = randomUUID();
  await run((ctx) =>
    ctx.tx.query(
      'INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by) VALUES($1,$2,$3,$4,$5)',
      [workspace, accountId, 'feedback-api@163.com', 'synthetic-unused-secret', actor],
    ),
  );
  for (const customerId of customerIds) {
    const mailId = randomUUID();
    await run((ctx) =>
      ctx.tx.query(
        `INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,
fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason)
VALUES($1,$2,$3,'feedback-api@163.com',$4,$2::uuid::text,'合成售后反馈',$5::jsonb,'[]','[]','[]',
'2026-11-10T08:00:00+08:00','inbound',$6,'fixture')`,
        [
          workspace,
          mailId,
          accountId,
          customerId,
          JSON.stringify([{ name: 'Synthetic buyer', address: 'buyer@example.invalid' }]),
          sourceBody,
        ],
      ),
    );
    if (customerId === customerB) mailB = mailId;
    const sources = await run((ctx) => activities.sources(ctx, { customer_id: customerId }));
    const source = sources.find((item) => item.body === sourceBody)!;
    const result = await activities.generateActivities(
      db,
      actor,
      workspace,
      {
        customer_id: customerId,
        type_id: type.id,
        source_ids: [source.id],
        request_id: randomUUID(),
      },
      fakeModel,
    );
    ids.push(result.activities[0].id);
  }
  [activityA, activityB] = ids;
}, 30_000);
afterAll(async () => {
  await db?.close();
});

it('exposes real configured fields and aggregates without returning original bodies', async () => {
  const catalog = (await owner.get('/api/reports/activity-analysis/catalog').set(h()).expect(200))
    .body;
  expect(catalog.types.find((type: { id: string }) => type.id === config.typeId).fields).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: config.fields.product })]),
  );
  const result: ActivityAnalysisResult = (await query().expect(200)).body;
  expect(result.summary).toMatchObject({ feedback_count: 2, customer_count: 2 });
  expect(result.rows.map((row) => row.id)).toEqual(expect.arrayContaining([activityA, activityB]));
  expect(JSON.stringify(result)).not.toContain(sourceBody);
  expect(JSON.stringify(catalog)).not.toContain(sourceBody);
});

it('saves analysis mappings in private report CRUD and preserves them for compatible title edits', async () => {
  board = (
    await owner
      .post('/api/reports/dashboards')
      .set(h())
      .send({ name: '售后反馈与产品改进', widgets: [], activity_analysis: config })
      .expect(201)
  ).body;
  expect(board.activity_analysis).toEqual(config);
  expect(
    (await owner.get(`/api/reports/dashboards/${board.id}`).set(h()).expect(200)).body
      .activity_analysis,
  ).toEqual(config);
  board = (
    await owner
      .patch(`/api/reports/dashboards/${board.id}`)
      .set(h())
      .send({ name: '我的反馈报告', description: '', widgets: [], version: board.version })
      .expect(200)
  ).body;
  expect(board.activity_analysis).toEqual(config);
  const copy = (
    await owner
      .post('/api/reports/dashboards')
      .set(h())
      .send({ name: '反馈副本', widgets: [], activity_analysis: board.activity_analysis })
      .expect(201)
  ).body;
  expect(copy.id).not.toBe(board.id);
  expect(copy.activity_analysis).toEqual(config);
  await viewer.get(`/api/reports/dashboards/${board.id}`).set(h()).expect(404);
  await owner
    .patch(`/api/reports/dashboards/${board.id}`)
    .set(h())
    .send({ name: '过时修改', widgets: [], activity_analysis: config, version: board.version - 1 })
    .expect(409);
});

it('rejects nonexistent mappings, malformed filters and foreign workspace at API boundaries', async () => {
  const bad = { ...config, fields: { ...config.fields, product: randomUUID() } };
  await query(owner, { config: bad }).expect(400);
  await owner
    .post('/api/reports/dashboards')
    .set(h())
    .send({ name: 'bad', widgets: [], activity_analysis: bad })
    .expect(400);
  await query(owner, { startDate: '2026-11-11', endDate: '2026-11-10' }).expect(400);
  await query(owner, { limit: 0 }).expect(400);
  await owner
    .get('/api/reports/activity-analysis/catalog')
    .set({ origin, 'x-workspace-id': foreignWorkspace })
    .expect(404);
  await owner
    .post('/api/reports/activity-analysis/query')
    .set('x-workspace-id', workspace)
    .send({ config })
    .expect(403);
});

it('filters authorized data, drills into current evidence and hides revoked access', async () => {
  const visible: ActivityAnalysisResult = (await query(viewer).expect(200)).body;
  expect(visible.summary).toMatchObject({ feedback_count: 1, customer_count: 1 });
  expect(visible.rows.map((row) => row.id)).toEqual([activityA]);
  expect(JSON.stringify(visible)).not.toContain(customerB);
  expect(
    (await viewer.get(`/api/activities/${activityA}`).set(h()).expect(200)).body.sources[0].body,
  ).toContain(sourceBody);
  await viewer.get(`/api/activities/${activityB}`).set(h()).expect(404);
  await owner
    .put(`/api/customers/${customerA}/access/${viewerActor}`)
    .set(h())
    .send({ access: null })
    .expect(200);
  expect((await query(viewer).expect(200)).body.summary.feedback_count).toBe(0);
  await viewer.get(`/api/activities/${activityA}`).set(h()).expect(404);
});

it('excludes changed evidence while leaving activity, customer and task business data intact', async () => {
  const before = (await db.query('SELECT id,values,version FROM business_activities ORDER BY id'))
    .rows;
  await run((ctx) =>
    ctx.tx.query('UPDATE mail_messages SET body=$3 WHERE workspace_id=$1 AND id=$2', [
      workspace,
      mailB,
      'Changed synthetic source',
    ]),
  );
  const result: ActivityAnalysisResult = (await query().expect(200)).body;
  expect(result.summary.feedback_count).toBe(1);
  expect(result.coverage.invalid_source_count).toBe(1);
  expect(result.rows.map((row) => row.id)).toEqual([activityA]);
  await owner.get(`/api/activities/${activityB}`).set(h()).expect(404);
  expect(
    (await db.query('SELECT id,values,version FROM business_activities ORDER BY id')).rows,
  ).toEqual(before);
  expect((await db.query('SELECT * FROM activity_tasks')).rows).toHaveLength(0);
  expect((await db.query('SELECT * FROM outgoing_mail')).rows).toHaveLength(0);
});

it('blocks stale manually corrected title/date in both analysis and the original activity detail', async () => {
  const current = (await owner.get(`/api/activities/${activityA}`).set(h()).expect(200)).body;
  const corrected = (
    await owner
      .patch(`/api/activities/${activityA}`)
      .set(h())
      .send({
        version: current.version,
        values: {
          [base.title]: '人工核对后的反馈标题',
          [base.occurred]: '2026-11-11T08:00:00+08:00',
        },
      })
      .expect(200)
  ).body;
  const before: ActivityAnalysisResult = (await query().expect(200)).body;
  expect(before.summary.feedback_count).toBe(1);
  expect(before.rows[0]).toMatchObject({
    id: activityA,
    title: '人工核对后的反馈标题',
    occurred_at: '2026-11-11T00:00:00.000Z',
  });
  await owner.get(`/api/activities/${activityA}`).set(h()).expect(200);
  const recordId = corrected.field_provenance[base.title].record_id;
  expect(recordId).toBe(corrected.field_provenance[base.occurred].record_id);
  // Pure in-memory maintenance simulates changed/revoked correction evidence;
  // the application still has no permission to rewrite customer Record bodies.
  await db.query('UPDATE customer_records SET body=$3 WHERE workspace_id=$1 AND id=$2', [
    workspace,
    recordId,
    'This correction source has changed and no longer supports the saved values.',
  ]);
  const after: ActivityAnalysisResult = (await query().expect(200)).body;
  expect(after.summary.feedback_count).toBe(0);
  expect(after.coverage.invalid_source_count).toBe(2);
  expect(after.rows).toEqual([]);
  await owner.get(`/api/activities/${activityA}`).set(h()).expect(404);
  expect(
    (
      await owner
        .get('/api/activities')
        .set(h())
        .query({ customer_id: customerA, type_id: config.typeId })
        .expect(200)
    ).body.items,
  ).toEqual([]);
});

async function correctedUnmappedActivity() {
  const mailId = randomUUID();
  await run(async (ctx) => {
    const account = (
      await ctx.tx.query<{ account_id: string }>(
        'SELECT account_id FROM mail_messages WHERE workspace_id=$1 AND id=$2',
        [workspace, mailB],
      )
    ).rows[0].account_id;
    await ctx.tx.query(
      `INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,
fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason)
VALUES($1,$2,$3,'feedback-api@163.com',$4,$2::uuid::text,'另一条合成售后反馈',
'[{"name":"Synthetic buyer","address":"buyer@example.invalid"}]','[]','[]','[]',
'2026-11-10T08:00:00+08:00','inbound',$5,'fixture')`,
      [workspace, mailId, account, customerA, sourceBody],
    );
  });
  const sources = await run((ctx) =>
    activities.sources(ctx, { customer_id: customerA, mail_id: mailId }),
  );
  const generated = await activities.generateActivities(
    db,
    actor,
    workspace,
    {
      customer_id: customerA,
      type_id: config.typeId,
      source_ids: [sources[0].id],
      request_id: randomUUID(),
    },
    fakeModel,
  );
  const id = generated.activities[0].id;
  const corrected = (
    await owner
      .patch(`/api/activities/${id}`)
      .set(h())
      .send({
        version: generated.activities[0].version,
        values: { [base.summary]: '这个未映射的人工补充同样保留其来源依赖。' },
      })
      .expect(200)
  ).body;
  expect(Object.values(config.fields)).not.toContain(base.summary);
  expect((await query().expect(200)).body.rows.map((row: { id: string }) => row.id)).toEqual([id]);
  await owner.get(`/api/activities/${id}`).set(h()).expect(200);
  return { id, corrected };
}

it('also excludes stale manual dependencies of fields not mapped into the report', async () => {
  const { id, corrected } = await correctedUnmappedActivity();
  await db.query('UPDATE customer_records SET body=$3 WHERE workspace_id=$1 AND id=$2', [
    workspace,
    corrected.field_provenance[base.summary].record_id,
    'The unmapped correction evidence has changed.',
  ]);
  const result: ActivityAnalysisResult = (await query().expect(200)).body;
  expect(result.summary.feedback_count).toBe(0);
  expect(result.coverage.invalid_source_count).toBe(3);
  expect(result.rows).toEqual([]);
  await owner.get(`/api/activities/${id}`).set(h()).expect(404);
});

it('also excludes an appended revocation on manual evidence of an unmapped field', async () => {
  const { id, corrected } = await correctedUnmappedActivity();
  const quote = corrected.field_provenance[base.summary].evidence[0].quote;
  const changed = (
    await db.query(
      'UPDATE customer_records SET body=body||$3 WHERE workspace_id=$1 AND id=$2 RETURNING body',
      [workspace, corrected.field_provenance[base.summary].record_id, '\n前述更正已撤回'],
    )
  ).rows[0];
  expect(changed.body).toBe(`${quote}\n前述更正已撤回`);
  const result: ActivityAnalysisResult = (await query().expect(200)).body;
  expect(result.summary.feedback_count).toBe(0);
  expect(result.coverage.invalid_source_count).toBe(4);
  expect(result.rows).toEqual([]);
  await owner.get(`/api/activities/${id}`).set(h()).expect(404);
});
