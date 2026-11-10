import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { catalog, query, validateConfig } from '../server/activity-analysis.js';
import * as activities from '../server/business-activities.js';
import { insert } from '../server/service.js';
import { sourceMaterials } from '../server/source-index.js';
import { scoped, type Context } from '../server/security.js';
import {
  activityBaseField as base,
  type ActivitySchema,
  type BusinessActivityType,
  type ActivityValue,
} from '../shared/business-activities.js';
import type { ActivityAnalysisConfig, ActivityAnalysisInput } from '../shared/activity-analysis.js';
import type { KnowledgeSource } from '../shared/knowledge.js';

let db: Database,
  workspace: string,
  actor: string,
  viewer: string,
  foreignWorkspace: string,
  foreignActor: string,
  customer: string,
  otherCustomer: string,
  schema: ActivitySchema;
const run = <T>(fn: (ctx: Context) => Promise<T>, who = actor, space = workspace) =>
  scoped(db, who, space, fn);
const analyze = (
  config: ActivityAnalysisConfig,
  input: Omit<ActivityAnalysisInput, 'config'> = {},
  who = actor,
) => run((ctx) => query(ctx, { config, ...input }), who);
type Fixture = { type: BusinessActivityType; config: ActivityAnalysisConfig };

async function fixture(): Promise<Fixture> {
  const type = await run((ctx) =>
    activities.createType(ctx, {
      name: `任意业务活动-${randomUUID()}`,
      schema_id: schema.id,
      fields: [
        { name: '明确选择的款式字段', kind: 'text' },
        {
          name: '明确选择的问题字段',
          kind: 'multi_select',
          options: ['偏长', '偏短', '面料', '0', 'false'],
        },
        { name: '明确选择的版本字段', kind: 'text' },
        { name: '明确选择的尺码字段', kind: 'select', options: ['S', 'M', '0'] },
        { name: '明确选择的颜色字段', kind: 'text' },
        { name: '明确选择的阶段字段', kind: 'select', options: ['待核实', '已处理'] },
        { name: '明确选择的事项字段', kind: 'text' },
        { name: '不能作为分类的数字', kind: 'number' },
      ],
    }),
  );
  const fields = type.fields.map((field) => field.id);
  return {
    type,
    config: {
      typeId: type.id,
      fields: {
        product: fields[0],
        issue: fields[1],
        version: fields[2],
        size: fields[3],
        color: fields[4],
        stage: fields[5],
        case: fields[6],
      },
    },
  };
}

function version(source: KnowledgeSource) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: source.id,
        record_id: source.record_id,
        body: source.body,
        occurred_at: source.occurred_at,
        project_id: source.project_id,
        person_ids: source.person_ids,
        speaker: source.speaker,
        speaker_side: source.speaker_side,
        channel: source.channel,
        trust: source.trust,
      }),
    )
    .digest('hex');
}

async function source(customerId = customer, body = 'PRIVATE_FEEDBACK_ORIGINAL_NOT_FOR_AGGREGATE') {
  const record = await run((ctx) =>
    insert(ctx, 'customer_records', {
      customer_id: customerId,
      project_id: null,
      kind: 'customer_quote',
      source_kind: 'manual',
      occurred_at: '2026-11-01T04:00:00Z',
      created_by: actor,
      body,
    }),
  );
  return (await run((ctx) => sourceMaterials(ctx, customerId))).find(
    (item) => item.record_id === record.id,
  )!;
}

async function activity(
  fixture: Fixture,
  patch: {
    customer?: string;
    source?: KnowledgeSource;
    values?: Partial<Record<keyof ActivityAnalysisConfig['fields'], ActivityValue>>;
    occurred?: string | null;
    project?: string | null;
    provenance?: boolean;
    manual?: boolean;
    emptyVersions?: boolean;
  } = {},
) {
  const customerId = patch.customer || customer;
  const original = patch.source || (await source(customerId));
  const runId = randomUUID(),
    id = randomUUID();
  const valueByRole = {
    product: 'B214',
    issue: ['偏长'],
    version: 'v1',
    size: 'S',
    color: '黑色',
    stage: '待核实',
    case: null,
    ...patch.values,
  };
  const occurred = patch.occurred === undefined ? '2026-11-01T04:00:00Z' : patch.occurred;
  const values: Record<string, ActivityValue> = Object.fromEntries(
    fixture.type.effective_fields.map((field) => [field.id, null]),
  );
  values[base.title] = '合成产品反馈';
  values[base.occurred] = occurred;
  for (const [role, field] of Object.entries(fixture.config.fields))
    values[field] = valueByRole[role as keyof typeof valueByRole] ?? null;
  const evidence = {
    source_id: original.id,
    record_id: original.record_id,
    quote: original.body,
    char_start: 0,
    char_end: original.body.length,
  };
  const provenance =
    patch.provenance === false
      ? {}
      : Object.fromEntries(
          Object.values(fixture.config.fields).map((fieldId) => [
            fieldId,
            {
              origin: patch.manual ? 'manual' : 'ai',
              ...(patch.manual ? { record_id: original.record_id } : {}),
              updated_at: '2026-11-01T04:00:00Z',
              evidence: [evidence],
            },
          ]),
        );
  await run(async (ctx) => {
    await ctx.tx.query(
      `INSERT INTO activity_runs(workspace_id,customer_id,id,actor_id,request_id,input_digest,config_digest,type_id,state,lease_token,source_ids,snapshot)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9,$10::jsonb,'{}')`,
      [
        workspace,
        customerId,
        runId,
        actor,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        fixture.type.id,
        randomUUID(),
        JSON.stringify([original.id]),
      ],
    );
    await ctx.tx.query(
      `INSERT INTO business_activities(workspace_id,customer_id,id,project_id,type_id,run_id,event_key,type_name,title,occurred_at,fields,values,ai_values,field_provenance,source_versions,created_by)
VALUES($1,$2,$3,$4,$5,$6,'event',$7,'合成产品反馈',$8,$9::jsonb,$10::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13)`,
      [
        workspace,
        customerId,
        id,
        patch.project || null,
        fixture.type.id,
        runId,
        fixture.type.name,
        occurred,
        JSON.stringify(fixture.type.effective_fields),
        JSON.stringify(values),
        JSON.stringify(provenance),
        JSON.stringify(patch.emptyVersions ? {} : { [original.id]: version(original) }),
        actor,
      ],
    );
    if (patch.provenance !== false)
      for (const fieldId of Object.values(fixture.config.fields))
        await ctx.tx.query(
          `INSERT INTO activity_evidence(workspace_id,customer_id,activity_id,source_id,record_id,field_id,quote,char_start,char_end)
VALUES($1,$2,$3,$4,$5,$6,$7,0,$8)`,
          [
            workspace,
            customerId,
            id,
            original.id,
            original.record_id,
            fieldId,
            original.body,
            original.body.length,
          ],
        );
  });
  return { id, source: original };
}

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: '只读活动分析',
    email: 'analysis@fixture.invalid',
    displayName: '合成老板',
    password: 'activity-analysis-fixture-password',
  });
  workspace = seed.workspaceId;
  actor = seed.actorId;
  const foreign = await createWorkspace(db, {
    name: '另一分析空间',
    email: 'analysis-foreign@fixture.invalid',
    displayName: '其他管理员',
    password: 'activity-analysis-fixture-password',
  });
  foreignWorkspace = foreign.workspaceId;
  foreignActor = foreign.actorId;
  viewer = randomUUID();
  await db.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [
    viewer,
    'analysis-viewer@fixture.invalid',
    '合成观察员',
    'unused-fixture-password',
  ]);
  await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
    workspace,
    viewer,
  ]);
  customer = await run(async (ctx) =>
    String(
      (await insert(ctx, 'customers', { name: '客户甲', type: 'distributor', source: 'email' })).id,
    ),
  );
  otherCustomer = await run(async (ctx) =>
    String(
      (await insert(ctx, 'customers', { name: '客户乙', type: 'retail', source: 'store' })).id,
    ),
  );
  await run((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'viewer')",
      [workspace, customer, viewer],
    ),
  );
  schema = await run((ctx) =>
    activities.createSchema(ctx, { name: '用户自行定义的业务结构', fields: [] }),
  );
}, 30000);
afterAll(() => db?.close());

it('binds only real effective field IDs and validates kind, ownership, duplicates and archival', async () => {
  const f = await fixture();
  const result = await run(catalog);
  expect(
    result.types.find((type) => type.id === f.type.id)?.fields.map((field) => field.id),
  ).toEqual(f.type.effective_fields.map((field) => field.id));
  expect(await run((ctx) => validateConfig(ctx, f.config))).toEqual(f.config);
  await expect(
    run((ctx) =>
      validateConfig(ctx, {
        ...f.config,
        fields: { ...f.config.fields, product: '明确选择的款式字段' },
      }),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    run((ctx) =>
      validateConfig(ctx, {
        ...f.config,
        fields: { ...f.config.fields, product: f.type.fields[7].id },
      }),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    run((ctx) =>
      validateConfig(ctx, {
        ...f.config,
        fields: { ...f.config.fields, product: f.config.fields.issue },
      }),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    run((ctx) =>
      validateConfig(ctx, {
        ...f.config,
        fields: { ...f.config.fields, version: f.config.fields.product },
      }),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    run((ctx) => validateConfig(ctx, f.config), foreignActor, foreignWorkspace),
  ).rejects.toMatchObject({ status: 400 });
  await run((ctx) =>
    activities.updateType(ctx, f.type.id, { version: f.type.version, archived: true }),
  );
  await expect(analyze(f.config)).rejects.toMatchObject({ status: 400 });
});

it('counts feedback and customers separately, keeps versions and opposite issues apart, and paginates after aggregation', async () => {
  const f = await fixture();
  await activity(f);
  await activity(f, { values: { issue: ['偏长', '面料'] } });
  await activity(f, {
    customer: otherCustomer,
    values: { issue: ['偏短'], version: 'v2', size: 'M', color: '蓝色', stage: '已处理' },
  });
  const full = await analyze(f.config);
  expect(full.summary).toMatchObject({
    feedback_count: 3,
    customer_count: 2,
    activity_count: 3,
    source_count: 3,
  });
  expect(full.groups.issue).toEqual(
    expect.arrayContaining([
      { key: '偏长', label: '偏长', feedback_count: 2, customer_count: 1 },
      { key: '面料', label: '面料', feedback_count: 1, customer_count: 1 },
      { key: '偏短', label: '偏短', feedback_count: 1, customer_count: 1 },
    ]),
  );
  const page = await analyze(f.config, { offset: 1, limit: 1 });
  expect(page.summary).toEqual(full.summary);
  expect(page.groups).toEqual(full.groups);
  expect(page.total).toBe(3);
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0]).toEqual(full.rows[1]);
  expect((await analyze(f.config, { version: 'v1' })).summary.feedback_count).toBe(2);
  expect((await analyze(f.config, { issue: '偏长' })).summary.feedback_count).toBe(2);
  expect(
    (await analyze(f.config, { product: 'B214', size: 'M', color: '蓝色', stage: '已处理' }))
      .summary.feedback_count,
  ).toBe(1);
  expect((await analyze(f.config, { customerType: 'retail' })).summary.customer_count).toBe(1);
  expect((await analyze(f.config, { customerId: customer })).summary.feedback_count).toBe(2);
  expect(JSON.stringify(full)).not.toContain('PRIVATE_FEEDBACK_ORIGINAL_NOT_FOR_AGGREGATE');
  expect(full.rows[0]).not.toHaveProperty('field_provenance');
  expect(full.rows[0]).not.toHaveProperty('source_versions');
});

it('keeps missing mapped values and unknown event dates explicit without borrowing created_at', async () => {
  const f = await fixture();
  const unknown = await activity(f, {
    occurred: null,
    values: { product: null, issue: [], version: null },
  });
  await activity(f, {
    occurred: '2026-11-01T16:30:00Z',
    values: { product: '0', issue: ['false'], size: '0', color: 'false' },
  });
  const result = await analyze(f.config);
  expect(result.rows.find((row) => row.id === unknown.id)?.occurred_at).toBeNull();
  expect(result.coverage).toMatchObject({
    unknown_date_count: 1,
    unknown_date_excluded_count: 0,
    missing_values: { product: 1, issue: 1, version: 1 },
  });
  expect(result.groups.product).toContainEqual({
    key: '0',
    label: '0',
    feedback_count: 1,
    customer_count: 1,
  });
  expect(result.groups.product).toContainEqual({
    key: null,
    label: '未填写',
    feedback_count: 1,
    customer_count: 1,
  });
  expect(
    (await analyze(f.config, { startDate: '2026-11-02', endDate: '2026-11-02' })).summary
      .feedback_count,
  ).toBe(1);
  const dateFiltered = await analyze(f.config, { startDate: '2026-11-01' });
  expect(dateFiltered.coverage.unknown_date_excluded_count).toBe(1);
  expect(dateFiltered.rows.some((row) => row.id === unknown.id)).toBe(false);
  expect((await analyze(f.config, { endDate: '2026-11-01' })).summary.feedback_count).toBe(0);
  const explicitCase = await fixture();
  await activity(explicitCase, { occurred: null, values: { case: 'one-confirmed-case' } });
  await activity(explicitCase, {
    occurred: '2026-11-01T04:00:00Z',
    values: { case: 'one-confirmed-case' },
  });
  const knownCase = await analyze(explicitCase.config, { startDate: '2026-11-01' });
  expect(knownCase.summary).toMatchObject({ feedback_count: 1, activity_count: 2 });
  expect(knownCase.coverage).toMatchObject({
    unknown_date_count: 1,
    unknown_date_excluded_count: 0,
  });
});

it('deduplicates only identical evidence and semantics, or an explicit same-customer case', async () => {
  const f = await fixture();
  const original = await source();
  const first = await activity(f, { source: original });
  const repeat = await activity(f, { source: original });
  await activity(f, { source: original, values: { version: 'v2' } });
  await activity(f, {
    source: await source(otherCustomer, original.body),
    customer: otherCustomer,
  });
  const sameCaseA = await activity(f, {
    values: { case: 'case-42' },
    occurred: '2026-11-01T04:00:00Z',
  });
  const sameCaseB = await activity(f, {
    values: { case: 'case-42' },
    occurred: '2026-11-02T04:00:00Z',
  });
  await activity(f, { customer: otherCustomer, values: { case: 'case-42' } });
  await activity(f, { values: { case: 'case-43' } });
  const result = await analyze(f.config);
  expect(result.summary).toMatchObject({ feedback_count: 6, activity_count: 8, customer_count: 2 });
  expect(result.coverage.duplicate_activity_count).toBe(2);
  expect(result.rows.find((row) => row.merged_ids.includes(first.id))?.merged_ids.sort()).toEqual(
    [first.id, repeat.id].sort(),
  );
  const caseRow = result.rows.find((row) => row.merged_ids.includes(sameCaseA.id));
  expect(caseRow?.merged_ids.sort()).toEqual([sameCaseA.id, sameCaseB.id].sort());
  expect(caseRow?.occurred_at).toBe('2026-11-01T04:00:00.000Z');
  expect(caseRow?.source_count).toBe(2);
});

it('does not infer duplicates from identical words, and case conflicts survive product/date filtering', async () => {
  const f = await fixture();
  await activity(f);
  await activity(f);
  const first = await activity(f, {
    values: { case: 'conflict', product: 'B214' },
    occurred: '2026-11-01T04:00:00Z',
  });
  await activity(f, {
    values: { case: 'conflict', product: 'B215' },
    occurred: '2026-11-03T04:00:00Z',
  });
  const result = await analyze(f.config);
  expect(result.summary.feedback_count).toBe(2);
  expect(result.coverage.pending_review_count).toBe(2);
  expect(result.total).toBe(4);
  expect(result.rows.find((row) => row.id === first.id)).toMatchObject({
    review_required: true,
    review_reason: 'case_conflict',
  });
  const narrowed = await analyze(f.config, { product: 'B214', endDate: '2026-11-01' });
  expect(narrowed.summary.feedback_count).toBe(2);
  expect(narrowed.coverage.pending_review_count).toBe(1);
  expect(narrowed.rows.find((row) => row.id === first.id)?.review_required).toBe(true);
});

it('excludes changed original or manual field sources instead of reusing old mapped facts', async () => {
  const f = await fixture();
  const original = await activity(f);
  const manual = await activity(f, { manual: true, emptyVersions: true });
  expect((await analyze(f.config)).summary.feedback_count).toBe(2);
  for (const record of [original.source.record_id, manual.source.record_id])
    await db.query('UPDATE customer_records SET body=$3 WHERE workspace_id=$1 AND id=$2', [
      workspace,
      record,
      'CHANGED_SOURCE_NOW_INVALID',
    ]);
  const result = await analyze(f.config);
  expect(result.summary.feedback_count).toBe(0);
  expect(result.rows).toEqual([]);
  expect(result.coverage.invalid_source_count).toBe(2);
});

it('validates source dependencies of manually corrected titles and event dates even when not mapped', async () => {
  const f = await fixture();
  const original = await activity(f);
  const corrected = await run((ctx) =>
    activities.update(ctx, original.id, {
      version: 1,
      values: { [base.title]: '人工更正标题', [base.occurred]: '2026-11-04T04:00:00Z' },
    }),
  );
  expect((await analyze(f.config)).rows[0]).toMatchObject({
    title: '人工更正标题',
    occurred_at: '2026-11-04T04:00:00.000Z',
  });
  const correction = corrected.field_provenance[base.title].record_id!;
  await db.query('UPDATE customer_records SET body=$3 WHERE workspace_id=$1 AND id=$2', [
    workspace,
    correction,
    '人工更正来源已经变化',
  ]);
  const result = await analyze(f.config);
  expect(result.summary.feedback_count).toBe(0);
  expect(result.coverage.invalid_source_count).toBe(1);
});

it('keeps customer ACL, revoked sources and archived customer/project boundaries in every aggregate', async () => {
  const f = await fixture();
  await activity(f);
  await activity(f, { customer: otherCustomer });
  expect((await analyze(f.config, {}, viewer)).summary).toMatchObject({
    feedback_count: 1,
    customer_count: 1,
  });
  await run((ctx) =>
    ctx.tx.query(
      'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
      [workspace, customer, viewer],
    ),
  );
  const revoked = await analyze(f.config, {}, viewer);
  expect(revoked.summary.feedback_count).toBe(0);
  expect(revoked.coverage.scanned_count).toBe(0);
  const project = await run((ctx) =>
    insert(ctx, 'projects', { customer_id: customer, name: '合成项目', type: 'sample' }),
  );
  await activity(f, { project: String(project.id) });
  await run((ctx) =>
    ctx.tx.query('UPDATE projects SET archived_at=now() WHERE workspace_id=$1 AND id=$2', [
      workspace,
      project.id,
    ]),
  );
  expect((await analyze(f.config)).summary.feedback_count).toBe(2);
  await run((ctx) =>
    ctx.tx.query('UPDATE customers SET archived_at=now() WHERE workspace_id=$1 AND id=$2', [
      workspace,
      otherCustomer,
    ]),
  );
  expect((await analyze(f.config)).summary.feedback_count).toBe(1);
});

it('rejects removed/changed field definitions and flags invalid historical values instead of treating 0/false as empty', async () => {
  const f = await fixture();
  await activity(f, { values: { product: 0, case: 'invalid-number' } });
  await activity(f, { values: { product: false, case: 'invalid-boolean' } });
  const invalid = await analyze(f.config);
  expect(invalid.summary.feedback_count).toBe(0);
  expect(invalid.coverage.pending_review_count).toBe(2);
  expect(invalid.rows.every((row) => row.review_reason === 'invalid_value')).toBe(true);
  const fields = f.type.fields.map((field, i) => (i === 0 ? { ...field, kind: 'number' } : field));
  await run((ctx) => activities.updateType(ctx, f.type.id, { version: f.type.version, fields }));
  await expect(analyze(f.config)).rejects.toMatchObject({ status: 400 });
  const removed = await fixture();
  await run((ctx) =>
    activities.updateType(ctx, removed.type.id, {
      version: removed.type.version,
      fields: removed.type.fields.filter((field) => field.id !== removed.config.fields.issue),
    }),
  );
  await expect(analyze(removed.config)).rejects.toMatchObject({ status: 400 });
});

it('preserves all business state and queues while returning only scoped metadata', async () => {
  const f = await fixture();
  await activity(f);
  const snapshot = async () =>
    (
      await db.query(`SELECT
(SELECT jsonb_agg(t ORDER BY id) FROM customer_records t) AS records,
(SELECT jsonb_agg(t ORDER BY id) FROM business_activities t) AS activities,
(SELECT jsonb_agg(t ORDER BY customer_id) FROM knowledge_sync t) AS knowledge,
(SELECT jsonb_agg(t ORDER BY customer_id) FROM source_index_sync t) AS vectors,
(SELECT count(*)::int FROM activity_runs) AS runs,
(SELECT count(*)::int FROM outgoing_mail) AS outgoing,
(SELECT count(*)::int FROM activity_tasks) AS tasks,
(SELECT count(*)::int FROM report_dashboards) AS dashboards`)
    ).rows;
  const before = await snapshot();
  const result = await analyze(f.config);
  await run(catalog);
  await run((ctx) => validateConfig(ctx, f.config));
  expect(await snapshot()).toEqual(before);
  expect(JSON.stringify(result)).not.toContain('PRIVATE_FEEDBACK_ORIGINAL_NOT_FOR_AGGREGATE');
  await expect(
    analyze(f.config, { startDate: '2026-11-04', endDate: '2026-11-01' }),
  ).rejects.toThrow();
  await expect(
    analyze(
      {
        typeId: f.type.id,
        fields: { product: f.config.fields.product, issue: f.config.fields.issue },
      },
      { size: 'S' },
    ),
  ).rejects.toMatchObject({ status: 400 });
});

it('refuses an over-limit full scope instead of silently treating a page as the total', async () => {
  const f = await fixture();
  const seed = await activity(f);
  await run((ctx) =>
    ctx.tx.query(
      `INSERT INTO business_activities(workspace_id,customer_id,id,type_id,run_id,event_key,type_name,title,fields,values,ai_values,field_provenance,source_versions,created_by)
SELECT a.workspace_id,a.customer_id,gen_random_uuid(),a.type_id,a.run_id,'bulk-'||n,a.type_name,a.title,a.fields,a.values,a.ai_values,a.field_provenance,a.source_versions,a.created_by
FROM business_activities a CROSS JOIN generate_series(1,5000) AS n WHERE a.workspace_id=$1 AND a.id=$2`,
      [workspace, seed.id],
    ),
  );
  await expect(analyze(f.config, { limit: 1 })).rejects.toMatchObject({ status: 413 });
});
