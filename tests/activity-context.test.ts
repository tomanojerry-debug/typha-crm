import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { scoped, type Context } from '../server/security.js';
import * as service from '../server/service.js';
import * as people from '../server/people.js';
import * as activities from '../server/business-activities.js';
import { activityBaseField as base } from '../shared/business-activities.js';
import { activityAgentSources } from '../server/activity-context.js';
import { ensureCommunicationRecords, knowledgeSnapshot } from '../server/knowledge.js';
import { sourceMaterials, sourceIndexStatus, ensureSourceIndex } from '../server/source-index.js';
import { sourceEmbeddingModel, sourceEmbeddingRevision } from '../shared/source-search.js';
import { modelSnapshot, evidence } from '../server/ask.js';
import { entitySchema } from '../server/entity-schema.js';
import type { ActivityModelInput } from '../server/activity-model.js';

let db: Database, w: string, actor: string, worker: string, denied: string;
let customer: string, person: string, otherPerson: string, project: string, otherProject: string;
let activityId: string,
  manualRecord: string,
  resultRecord: string,
  mailId: string,
  sizeField: string;
const run = <T>(fn: (ctx: Context) => Promise<T>, who = actor) => scoped(db, who, w, fn);
const rawBody = '客户希望60套蓝色舞服。我方请客户补尺码表后再核价。';
const scope = () => ({
  kind: 'entity' as const,
  object: 'people' as const,
  customer_id: customer,
  record_id: person,
});

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Activity context fixture',
    email: 'activity-context@example.invalid',
    displayName: '整理员甲',
    password: 'activity-context-fixture-password',
  });
  w = seed.workspaceId;
  actor = seed.actorId;
  worker = randomUUID();
  denied = randomUUID();
  for (const [id, name] of [
    [worker, '经办员乙'],
    [denied, '无权成员'],
  ] as const) {
    await db.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      id,
      `${id}@example.invalid`,
      name,
      'unused',
    ]);
    await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
      w,
      id,
    ]);
  }
  customer = String(
    (
      await run((ctx) =>
        service.insert(ctx, 'customers', {
          name: '虚构星澜学校',
          type: 'group',
          source: 'other',
        }),
      )
    ).id,
  );
  person = (
    await run((ctx) => people.createPerson(ctx, { customer_id: customer, name: '虚构张老师' }))
  ).id;
  otherPerson = (
    await run((ctx) => people.createPerson(ctx, { customer_id: customer, name: '虚构李老师' }))
  ).id;
  project = String(
    (
      await run((ctx) =>
        service.insert(ctx, 'projects', {
          customer_id: customer,
          name: '虚构60套演出服',
          type: 'custom',
        }),
      )
    ).id,
  );
  otherProject = String(
    (
      await run((ctx) =>
        service.insert(ctx, 'projects', {
          customer_id: customer,
          name: '另一项目',
          type: 'sample',
        }),
      )
    ).id,
  );
  await run((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'viewer')",
      [w, customer, worker],
    ),
  );
  await run(async (ctx) => {
    const account = randomUUID();
    mailId = randomUUID();
    await ctx.tx.query(
      'INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by) VALUES($1,$2,$3,$4,$5)',
      [w, account, 'fixture@example.invalid', 'unused-synthetic', actor],
    );
    await ctx.tx.query(
      `INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,project_id,
      fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason)
        VALUES($1,$2,$3,'fixture@example.invalid',$4,$5,$7,'虚构询单','[]','[]','[]','[]',
        '2026-10-26T01:00:00Z','inbound',$6,'fixture')`,
      [w, mailId, account, customer, project, rawBody, mailId],
    );
    await ctx.tx.query(
      'INSERT INTO mail_people(workspace_id,customer_id,message_id,person_id) VALUES($1,$2,$3,$4)',
      [w, customer, mailId, person],
    );
    await ensureCommunicationRecords(ctx, customer);
  });
  const root = await run((ctx) => activities.createSchema(ctx, { name: '显式自建结构' }));
  const type = await run((ctx) =>
    activities.createType(ctx, {
      name: '自建售前活动',
      schema_id: root.id,
      description: '只整理客户本次采购咨询',
      fields: [
        { name: '人工尺码配比', kind: 'text', guidance: '经办人核对后补充', ai_enabled: false },
      ],
    }),
  );
  sizeField = type.fields[0].id;
  const sources = await run((ctx) =>
    activities.sources(ctx, { customer_id: customer, person_id: person }),
  );
  const result = await activities.generateActivities(
    db,
    actor,
    w,
    {
      customer_id: customer,
      project_id: project,
      type_id: type.id,
      source_ids: sources.map((s) => s.id),
      linked_person_ids: [person],
      request_id: randomUUID(),
    },
    {
      transport: {
        async generate(input: ActivityModelInput) {
          if (input.mode === 'verify')
            return {
              events: input.candidate!.events.map((e) => ({
                event_id: e.event_id,
                supported: true,
                reason: 'test',
                fields: e.fields.map((f) => ({
                  field_id: f.field_id,
                  supported: true,
                  reason: 'test',
                })),
              })),
            };
          const source = input.sources[0];
          return {
            events: [
              {
                event_id: 'one',
                source_ids: [source.id],
                fields: input.fields.map((f) => {
                  const value =
                    f.id === base.title
                      ? '60套蓝色舞服咨询'
                      : f.id === base.summary
                        ? rawBody
                        : f.id === base.occurred
                          ? source.occurred_at
                          : null;
                  return {
                    field_id: f.id,
                    value,
                    evidence: value === null ? [] : [{ source_id: source.id, quote: source.body }],
                  };
                }),
              },
            ],
          };
        },
      },
    },
  );
  activityId = result.activities[0].id;
}, 30000);
afterAll(() => db.close());

it('adds current activity context under the original Record without changing entity schema', async () => {
  const before = await run(async (ctx) => (await entitySchema(ctx)).revision);
  const snapshot = await run((ctx) => modelSnapshot(ctx, scope()));
  const bundles = snapshot.sources.filter((s) => s.body.includes('current_activity_context'));
  expect(bundles).toHaveLength(1);
  expect(bundles[0].ref?.kind).toBe('record');
  expect(bundles[0].body).toContain('自建售前活动');
  expect(snapshot.sources.filter((s) => s.id === bundles[0].id)).toHaveLength(1);
  expect(await run(async (ctx) => (await entitySchema(ctx)).revision)).toBe(before);
  expect(
    (await run((ctx) => activityAgentSources(ctx, customer, { person_id: otherPerson }))).sources,
  ).toHaveLength(0);
  expect(
    (await run((ctx) => activityAgentSources(ctx, customer, { project_id: otherProject }))).sources,
  ).toHaveLength(0);
  await expect(run((ctx) => activityAgentSources(ctx, customer), denied)).rejects.toMatchObject({
    status: 404,
  });
});

it('reports vector readiness only when sources, versions and model match, within person scope', async () => {
  expect((await run((ctx) => sourceIndexStatus(ctx, customer))).current).toBe(false);
  await ensureSourceIndex(db, actor, w, customer, {
    async embed({ texts }) {
      return {
        model: sourceEmbeddingModel,
        dimensions: 384,
        vectors: texts.map(() => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))),
      };
    },
  });
  const ready = await run((ctx) => sourceIndexStatus(ctx, customer, { person_id: person }), worker);
  expect(ready.state).toBe('ready');
  expect(ready.current).toBe(true);
  expect(ready.chunk_count).toBeGreaterThan(0);
  expect(ready.requested_version).toBe(ready.applied_version);
  expect(
    (await run((ctx) => sourceIndexStatus(ctx, customer, { person_id: otherPerson }))).chunk_count,
  ).toBe(0);
  await run((ctx) =>
    ctx.tx.query(
      'UPDATE source_index_sync SET model_revision=$3 WHERE workspace_id=$1 AND customer_id=$2',
      [w, customer, 'old-model'],
    ),
  );
  expect((await run((ctx) => sourceIndexStatus(ctx, customer))).state).toBe('pending');
  await run((ctx) =>
    ctx.tx.query(
      'UPDATE source_index_sync SET model_revision=$3 WHERE workspace_id=$1 AND customer_id=$2',
      [w, customer, sourceEmbeddingRevision],
    ),
  );
});

it('keeps manual values and assignee task completion as authored inference Records in person/project retrieval', async () => {
  const original = await run((ctx) => activities.detail(ctx, activityId));
  await run((ctx) =>
    activities.update(ctx, activityId, {
      version: original.version,
      values: { [sizeField]: 'M码30套，L码30套' },
    }),
  );
  const saved = await run((ctx) => activities.detail(ctx, activityId));
  manualRecord = saved.field_provenance[sizeField].record_id!;
  const assigned = await run((ctx) =>
    activities.comment(ctx, activityId, {
      body: '请核对尺码配比',
      task_title: '核对尺码配比',
      assignee_id: worker,
    }),
  );
  const started = await run(
    (ctx) =>
      activities.updateTask(ctx, assigned.task!.id, {
        version: assigned.task!.version,
        status: 'in_progress',
      }),
    worker,
  );
  const done = await run(
    (ctx) =>
      activities.updateTask(ctx, started.id, {
        version: started.version,
        status: 'completed',
        result: '已核对M码30套、L码30套，已向整理员反馈；交期仍待评估。',
      }),
    worker,
  );
  resultRecord = done.result_record_id!;
  expect((await run((ctx) => sourceIndexStatus(ctx, customer))).state).toBe('pending');
  for (const material of [
    await run((ctx) => sourceMaterials(ctx, customer)),
    (await run((ctx) => knowledgeSnapshot(ctx, customer))).sources,
  ]) {
    for (const id of [manualRecord, resultRecord]) {
      const source = material.find((s) => s.record_id === id)!;
      expect(source.trust).toBe('inference');
      expect(source.person_ids).toEqual([person]);
      expect(source.project_id).toBe(project);
      expect(source.speaker_side).toBe('internal');
    }
    expect(material.find((s) => s.record_id === resultRecord)?.speaker).toContain('经办员乙');
  }
  const snapshot = await run((ctx) => modelSnapshot(ctx, scope()), worker);
  const text = snapshot.sources.map((s) => s.body).join('\n');
  expect(text).toContain('M码30套');
  expect(text).toContain('completed');
  expect(text).toContain('经办员乙');
  const own = await run(
    (ctx) => evidence(ctx, { scope: scope(), kind: 'record', id: resultRecord }),
    worker,
  );
  expect(own.body).toContain('本人内部报告');
  await expect(
    run((ctx) =>
      evidence(ctx, {
        scope: { ...scope(), record_id: otherPerson },
        kind: 'record',
        id: resultRecord,
      }),
    ),
  ).rejects.toMatchObject({ status: 404 });
});

it('preserves earlier manual correction Records and republishes indices when activity contacts change', async () => {
  const before = await run((ctx) => activities.detail(ctx, activityId));
  await run((ctx) =>
    activities.update(ctx, activityId, {
      version: before.version,
      values: { [sizeField]: 'M码20套，L码40套（复核更正）' },
    }),
  );
  const revised = await run((ctx) => activities.detail(ctx, activityId));
  const revisedRecord = revised.field_provenance[sizeField].record_id!;
  expect(revisedRecord).not.toBe(manualRecord);
  for (const id of [manualRecord, revisedRecord, resultRecord]) {
    const source = (await run((ctx) => sourceMaterials(ctx, customer))).find(
      (s) => s.record_id === id,
    )!;
    expect(source.person_ids).toEqual([person]);
    expect(source.speaker_side).toBe('internal');
    expect(revised.sources.some((s) => s.record_id === id)).toBe(true);
    await expect(
      run((ctx) => evidence(ctx, { scope: scope(), kind: 'record', id })),
    ).resolves.toBeDefined();
  }
  const previousVersions = await run(async (ctx) => ({
    graph: (
      await ctx.tx.query<{ n: number }>(
        'SELECT requested_version AS n FROM knowledge_sync WHERE workspace_id=$1 AND customer_id=$2',
        [w, customer],
      )
    ).rows[0].n,
    vector: (await sourceIndexStatus(ctx, customer)).requested_version,
  }));
  await run((ctx) =>
    activities.update(ctx, activityId, {
      version: revised.version,
      linked_person_ids: [otherPerson],
    }),
  );
  const changed = await run(async (ctx) => ({
    graph: (
      await ctx.tx.query<{ n: number }>(
        'SELECT requested_version AS n FROM knowledge_sync WHERE workspace_id=$1 AND customer_id=$2',
        [w, customer],
      )
    ).rows[0].n,
    vector: await sourceIndexStatus(ctx, customer),
  }));
  expect(Number(changed.graph)).toBeGreaterThan(Number(previousVersions.graph));
  expect(changed.vector.requested_version).toBeGreaterThan(previousVersions.vector);
  // Explicitly linking the activity permits opening its canonical original too;
  // it must not produce an Ask citation that the source endpoint then rejects.
  const activityOriginal = revised.sources.find((s) => s.channel === 'email')!;
  await expect(
    run((ctx) =>
      evidence(ctx, {
        scope: { ...scope(), record_id: otherPerson },
        kind: 'record',
        id: activityOriginal.record_id,
      }),
    ),
  ).resolves.toBeDefined();
  const originalSource = (await run((ctx) => sourceMaterials(ctx, customer))).find(
    (s) => s.record_id === activityOriginal.record_id,
  )!;
  expect(originalSource.person_ids).toEqual([person]);
  for (const id of [manualRecord, revisedRecord, resultRecord]) {
    const source = (await run((ctx) => sourceMaterials(ctx, customer))).find(
      (s) => s.record_id === id,
    )!;
    expect(source.person_ids).toEqual([otherPerson]);
    await expect(
      run((ctx) => evidence(ctx, { scope: scope(), kind: 'record', id })),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      run((ctx) =>
        evidence(ctx, { scope: { ...scope(), record_id: otherPerson }, kind: 'record', id }),
      ),
    ).resolves.toBeDefined();
  }
  const current = await run((ctx) => activities.detail(ctx, activityId));
  await run((ctx) =>
    activities.update(ctx, activityId, { version: current.version, linked_person_ids: [person] }),
  );
});

it('hides cached AI fields and task context when the original activity source changed', async () => {
  await run((ctx) =>
    ctx.tx.query('UPDATE mail_messages SET body=$3 WHERE workspace_id=$1 AND id=$2', [
      w,
      mailId,
      '原文已更正，本次不再采购。',
    ]),
  );
  const result = await run((ctx) => activityAgentSources(ctx, customer, { person_id: person }));
  expect(result.sources).toHaveLength(0);
  // Human reports remain their own authorized canonical evidence, never fake
  // replacements for a changed original customer message.
  const source = (await run((ctx) => sourceMaterials(ctx, customer))).find(
    (s) => s.record_id === resultRecord,
  )!;
  expect(source.trust).toBe('inference');
  expect(source.person_ids).toEqual([person]);
});
