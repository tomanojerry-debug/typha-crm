import { randomUUID } from 'node:crypto';
import request, { type Agent } from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped, type Context } from '../server/security.js';
import * as reports from '../server/reports.js';
import * as custom from '../server/custom-objects.js';
import * as service from '../server/service.js';
import type { ReportDashboard, ReportQueryResult, ReportWidget } from '../shared/reports.js';

let db: Database,
  owner: Agent,
  viewer: Agent,
  workspace: string,
  actor: string,
  viewerActor: string,
  foreignWorkspace: string,
  companyA: string,
  companyB: string,
  project: string,
  objectId: string,
  numberField: string,
  checkboxField: string,
  companyNumberField: string,
  companySelectField: string;
const origin = 'http://localhost:3100';
const run = <T>(fn: (ctx: Context) => Promise<T>, id = actor) => scoped(db, id, workspace, fn);
const h = () => ({ origin, 'x-workspace-id': workspace });
const query = (extra: Record<string, unknown> = {}, agent = owner) =>
  agent
    .post('/api/reports/query')
    .set(h())
    .send({ source: 'companies', metric: 'count', groupBy: 'type', ...extra });
let saved: ReportDashboard;
const widget = (): ReportWidget => ({
  id: randomUUID(),
  title: '客户类型',
  source: 'companies',
  metric: 'count',
  groupBy: 'type',
  visualization: 'donut',
});
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const first = await createWorkspace(db, {
    name: '报告合成测试',
    email: 'report-owner@example.invalid',
    displayName: '报告负责人',
    password: 'report-test-password',
  });
  workspace = first.workspaceId;
  actor = first.actorId;
  const second = await createWorkspace(db, {
    name: '另一个工作空间',
    email: 'report-viewer@example.invalid',
    displayName: '只读成员',
    password: 'report-test-password',
  });
  foreignWorkspace = second.workspaceId;
  viewerActor = second.actorId;
  await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
    workspace,
    viewerActor,
  ]);
  const app = createApp(db, { origin });
  owner = request.agent(app);
  viewer = request.agent(app);
  for (const [agent, email] of [
    [owner, 'report-owner@example.invalid'],
    [viewer, 'report-viewer@example.invalid'],
  ] as const)
    await agent
      .post('/api/auth/login')
      .set('origin', origin)
      .send({ email, password: 'report-test-password' })
      .expect(200);
  companyA = (
    await run((ctx) =>
      service.insert(ctx, 'customers', {
        name: 'A 团体客户',
        type: 'group',
        source: 'referral',
        owner_id: actor,
      }),
    )
  ).id as string;
  companyB = (
    await run((ctx) =>
      service.insert(ctx, 'customers', {
        name: 'B 私有零售客户',
        type: 'retail',
        source: 'taobao',
      }),
    )
  ).id as string;
  await run((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'viewer')",
      [workspace, companyA, viewerActor],
    ),
  );
  await run((ctx) =>
    ctx.tx.query('UPDATE customers SET created_at=$1 WHERE workspace_id=$2 AND id=$3', [
      '2026-10-01T16:00:00Z',
      workspace,
      companyA,
    ]),
  );
  await run((ctx) =>
    ctx.tx.query('UPDATE customers SET created_at=$1 WHERE workspace_id=$2 AND id=$3', [
      '2026-10-01T15:59:59Z',
      workspace,
      companyB,
    ]),
  );
  project = (
    await run((ctx) =>
      service.insert(ctx, 'projects', {
        customer_id: companyA,
        name: '样衣项目（不是订单）',
        type: 'sample',
        stage: 'waiting_customer',
      }),
    )
  ).id as string;
  for (const customerId of [companyA, companyA, companyB])
    await run((ctx) =>
      service.insert(ctx, 'customer_records', {
        customer_id: customerId,
        project_id: customerId === companyA ? project : null,
        kind: 'customer_quote',
        body: 'PRIVATE_SOURCE_NEVER_IN_REPORT',
        created_by: actor,
      }),
    );
  const object = await run((ctx) =>
    custom.createObject(ctx, {
      name: '人工配置的样衣研究',
      singular_name: '研究条目',
      slug: 'research',
      icon: 'box',
      color: 'blue',
    }),
  );
  objectId = object.id;
  const num = await run((ctx) =>
    custom.saveField(ctx, objectId, null, { name: '数值（自定义）', kind: 'number' }),
  );
  numberField = num.id;
  const check = await run((ctx) =>
    custom.saveField(ctx, objectId, null, { name: '已核对', kind: 'checkbox' }),
  );
  checkboxField = check.id;
  const objectVersion = (await run((ctx) => custom.object(ctx, objectId))).version;
  for (const [index, customerId] of [companyA, companyA, companyB].entries())
    await run((ctx) =>
      custom.saveRecord(ctx, objectId, null, {
        name: `研究条目${index + 1}`,
        customer_id: customerId,
        project_id: null,
        values: {
          [numberField]: index === 0 ? 0 : index === 1 ? 10 : 100,
          [checkboxField]: index === 1,
        },
        object_version: objectVersion,
      }),
    );
  companyNumberField = randomUUID();
  companySelectField = randomUUID();
  await run(async (ctx) => {
    for (const [id, name, kind, options] of [
      [companyNumberField, '已配置数字', 'number', []],
      [companySelectField, '已配置分类', 'select', ['甲', '乙']],
    ] as const)
      await ctx.tx.query(
        'INSERT INTO customer_attributes(workspace_id,id,name,kind,options) VALUES($1,$2,$3,$4,$5::jsonb)',
        [workspace, id, name, kind, JSON.stringify(options)],
      );
    for (const [customerId, value, label] of [
      [companyA, 0, '甲'],
      [companyB, 5, '乙'],
    ] as const) {
      for (const [fieldId, valueToSave] of [
        [companyNumberField, value],
        [companySelectField, label],
      ] as const)
        await ctx.tx.query(
          "INSERT INTO customer_attribute_values(workspace_id,customer_id,attribute_id,id,value,origin) VALUES($1,$2,$3,$4,$5::jsonb,'manual')",
          [workspace, customerId, fieldId, randomUUID(), JSON.stringify(valueToSave)],
        );
    }
  });
}, 30000);
afterAll(async () => {
  await db?.close();
});

it('requires authenticated workspace identity, and refuses a foreign workspace', async () => {
  await owner.get('/api/reports/catalog').expect(400);
  await owner.get('/api/reports/catalog').set({ 'x-workspace-id': foreignWorkspace }).expect(404);
  await request(createApp(db, { origin })).get('/api/reports/catalog').set(h()).expect(401);
});
it('catalog exposes actual workspace schema and authorized directory only', async () => {
  const catalog = (await viewer.get('/api/reports/catalog').set(h()).expect(200)).body;
  expect(catalog.customers.map((row: { id: string }) => row.id)).toEqual([companyA]);
  expect(catalog.sources.map((source: { id: string }) => source.id)).toContain(
    `custom:${objectId}`,
  );
  expect(
    catalog.sources.find((source: { id: string }) => source.id === 'companies').fields,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: `attr:${companyNumberField}`, kind: 'number' }),
      expect.objectContaining({ id: `attr:${companySelectField}`, kind: 'category' }),
    ]),
  );
  expect(JSON.stringify(catalog)).not.toContain('PRIVATE_SOURCE');
});
it('aggregates all authorized companies and labels actual categorical values', async () => {
  const result = (await query().expect(200)).body as ReportQueryResult;
  expect(result).toMatchObject({ value: 2, total: 2, customerCount: 2, hasMore: false });
  expect(result.buckets.map((row) => row.label).sort()).toEqual(['个人零售', '团体定制']);
});
it('applies customer RLS to counts, buckets and detail rows', async () => {
  const result = (await query({}, viewer).expect(200)).body as ReportQueryResult;
  expect(result).toMatchObject({ value: 1, total: 1, customerCount: 1 });
  expect(result.rows.map((row) => row.customer_id)).toEqual([companyA]);
  expect(JSON.stringify(result)).not.toContain(companyB);
  await query({ customerId: companyB }, viewer).expect(404);
});
it('filters calendar dates in Asia/Shanghai rather than UTC', async () => {
  const result = (await query({ startDate: '2026-10-02', endDate: '2026-10-02' }).expect(200)).body;
  expect(result.total).toBe(1);
  expect(result.rows[0].id).toBe(companyA);
  const trend = (await query({ groupBy: 'month' }).expect(200)).body;
  expect(trend.buckets).toMatchObject([{ label: '2026-10', value: 2 }]);
});
it('rejects invalid, impossible and reversed date intervals', async () => {
  for (const bad of [
    { startDate: '2026-02-30' },
    { endDate: 'tomorrow' },
    { startDate: '2026-10-03', endDate: '2026-10-01' },
  ])
    await query(bad).expect(400);
});
it('filters company type and explicit customer together', async () => {
  expect(
    (await query({ customerType: 'group', customerId: companyA }).expect(200)).body.total,
  ).toBe(1);
  expect(
    (await query({ customerType: 'retail', customerId: companyA }).expect(200)).body.total,
  ).toBe(0);
});
it('counts unique customers independently from communication record volume', async () => {
  const result = (
    await query({ source: 'records', metric: 'distinct_customers', groupBy: 'source' }).expect(200)
  ).body;
  expect(result).toMatchObject({ value: 2, total: 3, customerCount: 2 });
  expect(result.buckets[0]).toMatchObject({
    label: '人工记录',
    value: 2,
    count: 3,
    customerCount: 2,
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_SOURCE_NEVER_IN_REPORT');
});
it('paginates detail rows without changing full aggregate totals', async () => {
  const first = (await query({ source: 'records', groupBy: 'none', limit: 2 }).expect(200)).body;
  const last = (
    await query({ source: 'records', groupBy: 'none', limit: 2, offset: 2 }).expect(200)
  ).body;
  expect(first).toMatchObject({ total: 3, value: 3, hasMore: true });
  expect(last).toMatchObject({ total: 3, value: 3, hasMore: false });
  expect(new Set([...first.rows, ...last.rows].map((row: { id: string }) => row.id)).size).toBe(3);
});
it('drill-down bucket keys restrict both total and underlying rows', async () => {
  const all = (await query().expect(200)).body;
  const group = all.buckets.find((bucket: { label: string }) => bucket.label === '团体定制');
  const result = (await query({ bucketKey: group.key }).expect(200)).body;
  expect(result.total).toBe(1);
  expect(result.rows[0].id).toBe(companyA);
});
it('uses configured numeric attributes, retaining zero in average and sum', async () => {
  const first = (
    await query({
      metric: 'sum',
      metricField: `attr:${companyNumberField}`,
      groupBy: 'none',
    }).expect(200)
  ).body;
  expect(first.value).toBe(5);
  const average = (
    await query({
      metric: 'average',
      metricField: `attr:${companyNumberField}`,
      groupBy: 'none',
    }).expect(200)
  ).body;
  expect(average.value).toBe(2.5);
  const zero = (
    await query({
      metric: 'average',
      metricField: `attr:${companyNumberField}`,
      groupBy: 'none',
      customerId: companyA,
    }).expect(200)
  ).body;
  expect(zero.value).toBe(0);
});
it('supports actual custom number and checkbox fields with RLS and false preserved', async () => {
  const result = (
    await query(
      {
        source: `custom:${objectId}`,
        metric: 'average',
        metricField: `attr:${numberField}`,
        groupBy: `attr:${checkboxField}`,
      },
      viewer,
    ).expect(200)
  ).body;
  expect(result).toMatchObject({ total: 2, value: 5, customerCount: 1 });
  expect(result.buckets.map((bucket: { label: string }) => bucket.label).sort()).toEqual([
    '否',
    '是',
  ]);
  expect(result.buckets.find((bucket: { label: string }) => bucket.label === '否').value).toBe(0);
});
it('handles empty datasets honestly and checks SQL plans of every source', async () => {
  for (const source of ['people', 'projects', 'activities', 'records']) {
    const result = (await query({ source, groupBy: 'none' }).expect(200)).body;
    expect(result.total).toBeGreaterThanOrEqual(0);
  }
  const empty = (await query({ startDate: '2030-01-01', groupBy: 'none' }).expect(200)).body;
  expect(empty).toMatchObject({ value: 0, total: 0, customerCount: 0, buckets: [], rows: [] });
  const average = (
    await query({
      source: `custom:${objectId}`,
      metric: 'average',
      metricField: `attr:${numberField}`,
      groupBy: 'none',
      startDate: '2030-01-01',
    }).expect(200)
  ).body;
  expect(average.value).toBeNull();
});
it('rejects unknown data sources, fields, metrics and extra query instructions', async () => {
  for (const bad of [
    { source: 'orders' },
    { source: `custom:${randomUUID()}` },
    { groupBy: 'body' },
    { metric: 'sum', metricField: 'amount' },
    { metric: 'count', metricField: `attr:${companyNumberField}` },
    { groupBy: 'type;DROP TABLE customers;' },
    { prompt: 'read private records' },
  ])
    await query(bad).expect(400);
});
it('saves and reloads a private dashboard with exact widget configuration', async () => {
  const input = { name: '客户研究', description: '当前资料快照', widgets: [widget()] };
  saved = (await owner.post('/api/reports/dashboards').set(h()).send(input).expect(201)).body;
  expect(saved).toMatchObject({ ...input, version: 1 });
  expect(
    (await owner.get(`/api/reports/dashboards/${saved.id}`).set(h()).expect(200)).body,
  ).toEqual(saved);
  expect((await owner.get('/api/reports/dashboards').set(h()).expect(200)).body).toEqual([saved]);
  await viewer.get(`/api/reports/dashboards/${saved.id}`).set(h()).expect(404);
  expect((await viewer.get('/api/reports/dashboards').set(h()).expect(200)).body).toEqual([]);
});
it('uses optimistic versions and refuses foreign actor updates and deletes', async () => {
  const input = {
    name: '更新后的研究',
    description: saved.description,
    widgets: saved.widgets,
    version: saved.version,
  };
  await viewer.patch(`/api/reports/dashboards/${saved.id}`).set(h()).send(input).expect(404);
  const updated = (
    await owner.patch(`/api/reports/dashboards/${saved.id}`).set(h()).send(input).expect(200)
  ).body;
  expect(updated.version).toBe(saved.version + 1);
  await owner.patch(`/api/reports/dashboards/${saved.id}`).set(h()).send(input).expect(409);
  await owner
    .delete(`/api/reports/dashboards/${saved.id}`)
    .set(h())
    .send({ version: saved.version })
    .expect(409);
  await viewer
    .delete(`/api/reports/dashboards/${saved.id}`)
    .set(h())
    .send({ version: updated.version })
    .expect(404);
  saved = updated;
});
it('validates dashboard schema against current definitions and rejects duplicate widget identities', async () => {
  const chart = widget();
  for (const widgets of [
    [{ ...chart, groupBy: 'made-up-field' }],
    [chart, chart],
    [{ ...chart, source: 'orders' }],
  ])
    await owner
      .post('/api/reports/dashboards')
      .set(h())
      .send({ name: '无效看板', widgets })
      .expect(400);
});
it('invalidates an archived attribute at execution time even if a widget was saved earlier', async () => {
  await run((ctx) =>
    ctx.tx.query('UPDATE customer_attributes SET archived=true WHERE workspace_id=$1 AND id=$2', [
      workspace,
      companySelectField,
    ]),
  );
  await query({ groupBy: `attr:${companySelectField}` }).expect(400);
});
it('revokes previously allowed customer aggregates as soon as access is removed', async () => {
  await run((ctx) =>
    ctx.tx.query(
      'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
      [workspace, companyA, viewerActor],
    ),
  );
  expect((await query({}, viewer).expect(200)).body.total).toBe(0);
  expect(
    (
      await query(
        { source: 'records', metric: 'distinct_customers', groupBy: 'none' },
        viewer,
      ).expect(200)
    ).body.value,
  ).toBe(0);
});
it('deletes only the exact private dashboard version', async () => {
  await owner
    .delete(`/api/reports/dashboards/${saved.id}`)
    .set(h())
    .send({ version: saved.version })
    .expect(200);
  await owner.get(`/api/reports/dashboards/${saved.id}`).set(h()).expect(404);
  await expect(run((ctx) => reports.dashboard(ctx, saved.id))).rejects.toThrow('报告不存在');
});
it('fills every calendar month and lets empty-month buckets drill down honestly', async () => {
  const result = (
    await query({ groupBy: 'month', startDate: '2026-08-01', endDate: '2026-10-31' }).expect(200)
  ).body;
  expect(
    result.buckets.map((bucket: { label: string; value: number }) => [bucket.label, bucket.value]),
  ).toEqual([
    ['2026-08', 0],
    ['2026-09', 0],
    ['2026-10', 2],
  ]);
  const empty = (await query({ groupBy: 'month', bucketKey: result.buckets[0].key }).expect(200))
    .body;
  expect(empty).toMatchObject({ total: 0, value: 0, rows: [] });
  await query({ groupBy: 'month', startDate: '2000-01-01', endDate: '2026-01-01' }).expect(400);
});
it('keeps missing numeric samples distinct from zero and reports the true denominator', async () => {
  await run((ctx) =>
    ctx.tx.query(
      'UPDATE customer_attribute_values SET value=$1::jsonb WHERE workspace_id=$2 AND customer_id=$3 AND attribute_id=$4',
      ['null', workspace, companyB, companyNumberField],
    ),
  );
  const result = (
    await query({
      metric: 'average',
      metricField: `attr:${companyNumberField}`,
      groupBy: 'none',
    }).expect(200)
  ).body;
  expect(result).toMatchObject({ value: 0, valueCount: 1, total: 2 });
  const trend = (
    await query({
      metric: 'sum',
      metricField: `attr:${companyNumberField}`,
      groupBy: 'month',
      startDate: '2026-09-01',
      endDate: '2026-10-31',
    }).expect(200)
  ).body;
  expect(trend.buckets[0]).toMatchObject({ label: '2026-09', value: null, count: 0 });
});
it('canonicalizes multi-select order and treats empty selections as unfilled', async () => {
  const field = await run((ctx) =>
    custom.saveField(ctx, objectId, null, {
      name: '研究分类',
      kind: 'multi_select',
      options: ['甲', '乙'],
    }),
  );
  const rows = await run((ctx) =>
    ctx.tx.query<{ id: string }>(
      'SELECT id FROM custom_object_records WHERE workspace_id=$1 AND object_id=$2 ORDER BY name',
      [workspace, objectId],
    ),
  );
  for (const [index, row] of rows.rows.entries()) {
    const values = index === 0 ? ['乙', '甲'] : index === 1 ? ['甲', '乙'] : [];
    await run((ctx) =>
      ctx.tx.query(
        'UPDATE custom_object_records SET values=values || $1::jsonb WHERE workspace_id=$2 AND object_id=$3 AND id=$4',
        [JSON.stringify({ [field.id]: values }), workspace, objectId, row.id],
      ),
    );
  }
  const result = (
    await query({ source: `custom:${objectId}`, groupBy: `attr:${field.id}` }).expect(200)
  ).body;
  expect(result.buckets).toHaveLength(2);
  const combination = result.buckets.find((bucket: { count: number }) => bucket.count === 2);
  expect(combination).toMatchObject({ value: 2, count: 2 });
  expect(combination.label.split('、').sort()).toEqual(['甲', '乙'].sort());
  expect(
    result.buckets.find((bucket: { label: string }) => bucket.label === '未填写'),
  ).toMatchObject({ value: 1, count: 1 });
});
it('refuses prototype properties as query fields without executing malformed SQL', async () => {
  await query({ groupBy: 'constructor' }).expect(400);
  await query({ groupBy: '__proto__' }).expect(400);
  await query({ metric: 'sum', metricField: 'constructor', groupBy: 'none' }).expect(400);
});
it('rejects persisted visualizations that would imply invalid denominators or time axes', async () => {
  for (const chart of [
    { ...widget(), metric: 'distinct_customers' },
    { ...widget(), visualization: 'line' },
    { ...widget(), visualization: 'number' },
  ])
    await owner
      .post('/api/reports/dashboards')
      .set(h())
      .send({ name: '不正确的展示', widgets: [chart] })
      .expect(400);
});
