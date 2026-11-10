import { beforeAll, afterAll, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { scoped, type Context } from '../server/security.js';
import * as service from '../server/service.js';
import * as people from '../server/people.js';
import * as activities from '../server/business-activities.js';
import * as attributes from '../server/attributes.js';
import { entitySchema } from '../server/entity-schema.js';
import { ensureCommunicationRecords } from '../server/knowledge.js';
import {
  activityBaseField as base,
  type ActivitySchema,
  type BusinessActivityType,
} from '../shared/business-activities.js';
import type {
  ActivityModelInput,
  ActivityModelOptions,
  ActivityModelOutput,
} from '../server/activity-model.js';

let db: Database,
  w: string,
  actor: string,
  viewer: string,
  denied: string,
  customer: string,
  otherCustomer: string,
  p: string,
  q: string,
  foreignPerson: string,
  mailId: string,
  companyField: string;
let root: ActivitySchema,
  child: ActivitySchema,
  type: BusinessActivityType,
  activityId: string,
  quantityField: string,
  manualField: string,
  unknownField: string;
let revisionBefore: string,
  calls = 0;
const body = '客户：希望60套B12蓝色舞服，交期未定。\n我方：请补尺码表，核对后再报价。';
const run = <T>(fn: (ctx: Context) => Promise<T>, who?: string) => scoped(db, who || actor, w, fn);
const options: ActivityModelOptions = {
  transport: {
    async generate(input: ActivityModelInput) {
      calls++;
      if (input.mode === 'verify')
        return {
          events: input.candidate!.events.map((e) => ({
            event_id: e.event_id,
            supported: true,
            reason: 'fixture semantic verdict',
            fields: e.fields.map((f) => ({
              field_id: f.field_id,
              supported: true,
              reason: 'fixture field verdict',
            })),
          })),
        };
      const s = input.sources[0];
      return {
        events: [
          {
            event_id: 'event-1',
            source_ids: [s.id],
            fields: input.fields.map((f) => {
              let value: unknown = null;
              if (f.id === base.title) value = '60套B12询单';
              else if (f.id === base.summary) value = '客户询问60套舞服，我方请求尺码资料后核价。';
              else if (f.id === base.occurred) value = s.occurred_at;
              else if (f.name === '需求数量') value = 60;
              else if (f.name === '后续安排') value = '我方请客户补尺码表，收到后再报价。';
              return {
                field_id: f.id,
                value,
                evidence: value === null ? [] : [{ source_id: s.id, quote: s.body }],
              };
            }),
          },
        ],
      };
    },
  },
};
async function input() {
  const source = await run((ctx) =>
    activities.sources(ctx, { customer_id: customer, person_id: p }),
  );
  return {
    customer_id: customer,
    type_id: type.id,
    source_ids: source.map((s) => s.id),
    linked_person_ids: [p],
    request_id: randomUUID(),
  };
}

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Activities fixture',
    email: 'activity-core@example.invalid',
    displayName: 'Admin',
    password: 'activity-fixture-password',
  });
  w = seed.workspaceId;
  actor = seed.actorId;
  customer = String(
    (
      await run((ctx) =>
        service.insert(ctx, 'customers', { name: 'A fixture', type: 'group', source: 'other' }),
      )
    ).id,
  );
  otherCustomer = String(
    (
      await run((ctx) =>
        service.insert(ctx, 'customers', { name: 'B fixture', type: 'group', source: 'other' }),
      )
    ).id,
  );
  p = (await run((ctx) => people.createPerson(ctx, { customer_id: customer, name: 'P' }))).id;
  q = (await run((ctx) => people.createPerson(ctx, { customer_id: customer, name: 'Q' }))).id;
  foreignPerson = (
    await run((ctx) => people.createPerson(ctx, { customer_id: otherCustomer, name: 'R' }))
  ).id;
  viewer = randomUUID();
  denied = randomUUID();
  for (const [id, label] of [
    [viewer, 'viewer'],
    [denied, 'denied'],
  ]) {
    await db.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      id,
      `${label}-activity@example.invalid`,
      label,
      'not-used',
    ]);
    await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
      w,
      id,
    ]);
  }
  await run((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'viewer')",
      [w, customer, viewer],
    ),
  );
  const account = randomUUID();
  mailId = randomUUID();
  await run(async (ctx) => {
    await ctx.tx.query(
      'INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by) VALUES($1,$2,$3,$4,$5)',
      [w, account, 'activity@example.invalid', 'synthetic-only', actor],
    );
    await ctx.tx.query(
      "INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason) VALUES($1,$2,$3,$4,$5,$6,'询单',$7,'[]','[]','[]','2026-10-26T09:00:00+08:00','inbound',$8,'email')",
      [
        w,
        mailId,
        account,
        'activity@example.invalid',
        customer,
        'activity-fixture-message',
        JSON.stringify([{ name: 'P', address: 'p@example.invalid' }]),
        body,
      ],
    );
    await ctx.tx.query(
      'INSERT INTO mail_people(workspace_id,customer_id,message_id,person_id) VALUES($1,$2,$3,$4)',
      [w, customer, mailId, p],
    );
    await ensureCommunicationRecords(ctx, customer);
  });
  const field = await run((ctx) =>
    attributes.createField(ctx, { name: '需求数量', kind: 'number' }),
  );
  companyField = field.id;
  await run((ctx) =>
    attributes.saveValue(ctx, customer, field.id, {
      value: 777,
      version: 0,
      attribute_version: field.version,
    }),
  );
  revisionBefore = await run(async (ctx) => (await entitySchema(ctx)).revision);
}, 30000);
afterAll(() => db.close());

it('creates only generic defaults, independent schema revisions and at most two layers', async () => {
  const before = await run((ctx) =>
    ctx.tx.query('SELECT * FROM knowledge_sync WHERE workspace_id=$1 ORDER BY customer_id', [w]),
  );
  root = await run((ctx) => activities.createSchema(ctx, { name: '任意业务名称' }));
  expect(root.effective_fields).toHaveLength(10);
  expect(root.fields.filter((f) => f.system)).toHaveLength(4);
  expect(root.fields.some((f) => f.name === '需求数量')).toBe(false);
  child = await run((ctx) =>
    activities.createSchema(ctx, {
      name: '售前',
      parent_id: root.id,
      fields: [
        { name: '需求数量', kind: 'number', ai_enabled: true, guidance: '只填原文明确数量' },
        { name: '未知内容', kind: 'text', ai_enabled: true, guidance: '无依据保持null' },
        { name: '内部已核对', kind: 'checkbox' },
      ],
    }),
  );
  quantityField = child.fields.find((f) => f.name === '需求数量')!.id;
  manualField = child.fields.find((f) => f.name === '内部已核对')!.id;
  unknownField = child.fields.find((f) => f.name === '未知内容')!.id;
  expect(child.depth).toBe(2);
  expect(child.effective_fields).toHaveLength(13);
  await expect(
    run((ctx) => activities.createSchema(ctx, { name: '第三层', parent_id: child.id })),
  ).rejects.toThrow('一级');
  await expect(
    run((ctx) =>
      ctx.tx.query(
        'INSERT INTO activity_schemas(workspace_id,id,name,parent_id) VALUES($1,$2,$3,$4)',
        [w, randomUUID(), 'bad-third', child.id],
      ),
    ),
  ).rejects.toThrow('two levels');
  type = await run((ctx) =>
    activities.createType(ctx, {
      name: '微信售前',
      schema_id: child.id,
      fields: [
        {
          name: '后续安排',
          kind: 'text',
          ai_enabled: true,
          guidance: '保留我方请求与客户答应的区别',
        },
      ],
    }),
  );
  expect(type.effective_fields).toHaveLength(14);
  expect(await run(async (ctx) => (await entitySchema(ctx)).revision)).toBe(revisionBefore);
  expect(
    await run((ctx) =>
      ctx.tx.query('SELECT * FROM knowledge_sync WHERE workspace_id=$1 ORDER BY customer_id', [w]),
    ),
  ).toEqual(before);
});
it('keeps configuration admin-only and rejects inherited name collisions', async () => {
  await expect(
    run((ctx) => activities.createSchema(ctx, { name: 'Not admin' }), viewer),
  ).rejects.toThrow('管理员');
  await expect(
    run((ctx) =>
      activities.createSchema(ctx, {
        name: '重复',
        parent_id: root.id,
        fields: [{ name: '标题', kind: 'text' }],
      }),
    ),
  ).rejects.toThrow('重复');
  root = await run((ctx) =>
    activities.updateSchema(ctx, root.id, { version: root.version, name: '客户业务沟通' }),
  );
  expect(root.name).toBe('客户业务沟通');
});
it('rejects disabling AI for the title required by activity generation', async () => {
  const before = await run((ctx) => activities.schemas(ctx));
  await expect(
    run((ctx) =>
      activities.updateSchema(ctx, root.id, {
        version: root.version,
        fields: root.fields.map((field) => ({
          ...field,
          ai_enabled: field.id === base.title ? false : field.ai_enabled,
        })),
      }),
    ),
  ).rejects.toThrow('不能关闭AI生成');
  expect(await run((ctx) => activities.schemas(ctx))).toEqual(before);
});
it('generates with short source handles, exact evidence, null unknowns and same-ID company/person views', async () => {
  const request = await input();
  const original = await run((ctx) =>
    ctx.tx.query('SELECT * FROM customer_records WHERE workspace_id=$1 ORDER BY id', [w]),
  );
  calls = 0;
  const result = await activities.generateActivities(db, actor, w, request, options);
  expect(calls).toBe(2);
  expect(result.activities).toHaveLength(1);
  const activity = result.activities[0];
  activityId = activity.id;
  expect(activity.values[quantityField]).toBe(60);
  expect(activity.values[unknownField]).toBeNull();
  expect(activity.values[manualField]).toBeNull();
  expect(activity.occurred_at).toBeTruthy();
  expect(activity.field_provenance[quantityField].evidence[0].quote).toBe(body);
  expect(
    await run((ctx) =>
      ctx.tx.query('SELECT * FROM customer_records WHERE workspace_id=$1 ORDER BY id', [w]),
    ),
  ).toEqual(original);
  const same = await activities.generateActivities(db, actor, w, request, options);
  expect(same.reused).toBe(true);
  expect(same.activities[0].id).toBe(activityId);
  const repeatedSource = await activities.generateActivities(
    db,
    actor,
    w,
    { ...request, request_id: randomUUID() },
    options,
  );
  expect(repeatedSource.reused).toBe(true);
  expect(repeatedSource.activities[0].id).toBe(activityId);
  expect(calls).toBe(2);
  const company = await run((ctx) => activities.browse(ctx, { customer_id: customer }));
  const person = await run((ctx) =>
    activities.browse(ctx, { customer_id: customer, person_id: p }),
  );
  expect(company.items.map((a) => a.id)).toEqual(person.items.map((a) => a.id));
  expect(
    (await run((ctx) => activities.browse(ctx, { customer_id: customer, person_id: q }))).items,
  ).toEqual([]);
  await expect(run((ctx) => activities.detail(ctx, activityId, { person_id: q }))).rejects.toThrow(
    '未关联',
  );
});
it('rejects foreign contacts and sources before any model call', async () => {
  const request = await input();
  const before = calls;
  await expect(
    activities.generateActivities(
      db,
      actor,
      w,
      { ...request, linked_person_ids: [foreignPerson] },
      options,
    ),
  ).rejects.toThrow('当前客户');
  await expect(
    activities.generateActivities(
      db,
      actor,
      w,
      { ...request, source_ids: ['record:foreign'] },
      options,
    ),
  ).rejects.toThrow('来源');
  expect(calls).toBe(before);
});
it('rejects unlisted aliases, invented quotes and semantic failure without persisting activities', async () => {
  const before = (await run((ctx) => activities.browse(ctx, { customer_id: customer }))).items
    .length;
  const broken: ActivityModelOptions = {
    transport: {
      async generate(v) {
        const raw = (await options.transport!.generate(v)) as ActivityModelOutput;
        if (v.mode === 'extract') raw.events[0].fields[0].evidence[0].source_id = 'S999';
        return raw;
      },
    },
  };
  await expect(
    activities.generateActivities(
      db,
      actor,
      w,
      { ...(await input()), linked_person_ids: [q] },
      broken,
    ),
  ).rejects.toThrow('原文');
  const rejected: ActivityModelOptions = {
    transport: {
      async generate(v) {
        if (v.mode === 'verify')
          return {
            events: v.candidate!.events.map((e) => ({
              event_id: e.event_id,
              supported: false,
              reason: 'unsupported',
              fields: e.fields.map((f) => ({
                field_id: f.field_id,
                supported: false,
                reason: 'unsupported',
              })),
            })),
          };
        return options.transport!.generate(v);
      },
    },
  };
  await expect(
    activities.generateActivities(
      db,
      actor,
      w,
      { ...(await input()), linked_person_ids: [q] },
      rejected,
    ),
  ).rejects.toThrow('语义');
  expect(
    (await run((ctx) => activities.browse(ctx, { customer_id: customer }))).items,
  ).toHaveLength(before);
});
it('revalidates source content and config versions after model work outside transactions', async () => {
  const firstRequest = { ...(await input()), handler_id: actor };
  const prepared = await run((ctx) => activities.prepareGeneration(ctx, firstRequest, options));
  const output = await activities.executeGeneration(prepared);
  await run((ctx) =>
    ctx.tx.query('UPDATE mail_messages SET body=$3 WHERE workspace_id=$1 AND id=$2', [
      w,
      mailId,
      'changed original',
    ]),
  );
  await expect(run((ctx) => activities.finishGeneration(ctx, prepared, output))).rejects.toThrow(
    '来源',
  );
  await run((ctx) =>
    ctx.tx.query('UPDATE mail_messages SET body=$3 WHERE workspace_id=$1 AND id=$2', [
      w,
      mailId,
      body,
    ]),
  );
  const request = { ...(await input()), handler_id: actor, linked_person_ids: [p, q] };
  const second = await run((ctx) => activities.prepareGeneration(ctx, request, options));
  const output2 = await activities.executeGeneration(second);
  type = await run((ctx) =>
    activities.updateType(ctx, type.id, {
      version: type.version,
      guidance: 'new grouping meaning',
    }),
  );
  await expect(run((ctx) => activities.finishGeneration(ctx, second, output2))).rejects.toThrow(
    '配置',
  );
});
it('records manual 65 separately from original AI 60, preserving entity values and source text', async () => {
  const before = await run((ctx) => activities.detail(ctx, activityId));
  const modified = await run((ctx) =>
    activities.update(ctx, activityId, {
      version: before.version,
      values: { [quantityField]: 65, [manualField]: false },
    }),
  );
  expect(modified.values[quantityField]).toBe(65);
  expect(modified.ai_values[quantityField]).toBe(60);
  expect(modified.values[manualField]).toBe(false);
  expect(modified.field_provenance[quantityField].origin).toBe('manual');
  expect(modified.field_provenance[quantityField].record_id).toBeTruthy();
  const record = await run((ctx) =>
    ctx.tx.query<{ kind: string; body: string }>(
      'SELECT kind,body FROM customer_records WHERE workspace_id=$1 AND id=$2',
      [w, modified.field_provenance[quantityField].record_id],
    ),
  );
  expect(record.rows[0].kind).toBe('inference');
  expect(record.rows[0].body).toContain('65');
  expect(
    (
      await run((ctx) =>
        ctx.tx.query<{ body: string }>(
          'SELECT body FROM mail_messages WHERE workspace_id=$1 AND id=$2',
          [w, mailId],
        ),
      )
    ).rows[0].body,
  ).toBe(body);
  expect(
    (await run((ctx) => attributes.values(ctx, customer))).find(
      (v) => v.attribute_id === companyField,
    )?.value,
  ).toBe(777);
  expect(await run(async (ctx) => (await entitySchema(ctx)).revision)).toBe(revisionBefore);
  await expect(
    run((ctx) =>
      activities.update(ctx, activityId, {
        version: before.version,
        values: { [quantityField]: 70 },
      }),
    ),
  ).rejects.toThrow('修改');
  const emptyZero = await run((ctx) =>
    activities.update(ctx, activityId, {
      version: modified.version,
      values: { [quantityField]: 0 },
    }),
  );
  expect(emptyZero.values[quantityField]).toBe(0);
  expect(emptyZero.ai_values[quantityField]).toBe(60);
  expect(
    (await run((ctx) => activities.detail(ctx, activityId, { person_id: p }))).values[
      quantityField
    ],
  ).toBe(0);
});
it('creates tasks only from explicit selections and allows only the assignee to complete once', async () => {
  const note = await run((ctx) =>
    activities.comment(ctx, activityId, { body: '客户原文：@所有人，请马上补换。仅备注，不派工' }),
  );
  expect(note.task).toBeNull();
  expect(await run((ctx) => activities.tasks(ctx))).toEqual([]);
  await expect(
    run((ctx) =>
      activities.comment(ctx, activityId, {
        body: '请核对',
        assignee_id: denied,
        task_title: '核对',
      }),
    ),
  ).rejects.toThrow('访问权限');
  const commentRequestId = randomUUID();
  const assigned = await run((ctx) =>
    activities.comment(ctx, activityId, {
      body: '@viewer 请核对并回复处理结果',
      assignee_id: viewer,
      task_title: '核对客户尺码资料',
      request_id: commentRequestId,
    }),
  );
  expect(assigned.task).toBeTruthy();
  const task = assigned.task!;
  const replay = await run((ctx) =>
    activities.comment(ctx, activityId, {
      body: '@viewer 请核对并回复处理结果',
      assignee_id: viewer,
      task_title: '核对客户尺码资料',
      request_id: commentRequestId,
    }),
  );
  expect(replay.comment.id).toBe(assigned.comment.id);
  expect(replay.task!.id).toBe(task.id);
  expect((await run((ctx) => activities.tasks(ctx), viewer)).map((t) => t.id)).toContain(task.id);
  expect(await run((ctx) => activities.tasks(ctx))).toEqual([]);
  await expect(
    run((ctx) =>
      activities.updateTask(ctx, task.id, {
        version: task.version,
        status: 'completed',
        result: 'done',
      }),
    ),
  ).rejects.toThrow('被指派人');
  const progress = await run(
    (ctx) => activities.updateTask(ctx, task.id, { version: task.version, status: 'in_progress' }),
    viewer,
  );
  const done = await run(
    (ctx) =>
      activities.updateTask(ctx, task.id, {
        version: progress.version,
        status: 'completed',
        result: '已核对收到资料，具体方案仍待公司决定。',
      }),
    viewer,
  );
  expect(done.result_record_id).toBeTruthy();
  const repeat = await run(
    (ctx) =>
      activities.updateTask(ctx, task.id, {
        version: progress.version,
        status: 'completed',
        result: '已核对收到资料，具体方案仍待公司决定。',
      }),
    viewer,
  );
  expect(repeat.result_record_id).toBe(done.result_record_id);
  expect((await run((ctx) => activities.detail(ctx, activityId))).tasks[0].status).toBe(
    'completed',
  );
  const record = await run((ctx) =>
    ctx.tx.query<{ kind: string; created_by: string }>(
      'SELECT kind,created_by FROM customer_records WHERE workspace_id=$1 AND id=$2',
      [w, done.result_record_id],
    ),
  );
  expect(record.rows[0]).toEqual({ kind: 'inference', created_by: viewer });
});
it('enforces customer RLS for activity rows, evidence, tasks and originals', async () => {
  const result = await run(
    async (ctx) => ({
      rows: (await ctx.tx.query('SELECT * FROM business_activities WHERE workspace_id=$1', [w]))
        .rows,
      evidence: (await ctx.tx.query('SELECT * FROM activity_evidence WHERE workspace_id=$1', [w]))
        .rows,
      tasks: (await ctx.tx.query('SELECT * FROM activity_tasks WHERE workspace_id=$1', [w])).rows,
      records: (await ctx.tx.query('SELECT * FROM customer_records WHERE workspace_id=$1', [w]))
        .rows,
    }),
    denied,
  );
  expect(Object.values(result).every((rows) => rows.length === 0)).toBe(true);
  await expect(run((ctx) => activities.detail(ctx, activityId), denied)).rejects.toThrow('无权');
});
it('reports current edit rights for task-entry details and blocks archived customer sources', async () => {
  expect((await run((ctx) => activities.detail(ctx, activityId))).can_edit).toBe(true);
  expect((await run((ctx) => activities.detail(ctx, activityId), viewer)).can_edit).toBe(false);
  await run((ctx) =>
    ctx.tx.query('UPDATE customers SET archived_at=now() WHERE workspace_id=$1 AND id=$2', [
      w,
      customer,
    ]),
  );
  try {
    await expect(run((ctx) => activities.detail(ctx, activityId))).rejects.toThrow('已归档');
  } finally {
    await run((ctx) =>
      ctx.tx.query('UPDATE customers SET archived_at=NULL WHERE workspace_id=$1 AND id=$2', [
        w,
        customer,
      ]),
    );
  }
});
it('recovers an abandoned generation lease while rejecting a late old result', async () => {
  const request = { ...(await input()), handler_id: viewer, linked_person_ids: [p, q] };
  const abandoned = await run((ctx) => activities.prepareGeneration(ctx, request, options));
  await expect(run((ctx) => activities.prepareGeneration(ctx, request, options))).rejects.toThrow(
    '正在整理',
  );
  await run((ctx) =>
    ctx.tx.query(
      "UPDATE activity_runs SET updated_at=now()-interval '11 minutes' WHERE workspace_id=$1 AND id=$2",
      [w, abandoned.run_id],
    ),
  );
  const recovered = await run((ctx) => activities.prepareGeneration(ctx, request, options));
  expect(recovered.run_id).toBe(abandoned.run_id);
  expect(recovered.lease_token).not.toBe(abandoned.lease_token);
  const output = await activities.executeGeneration(recovered);
  await expect(run((ctx) => activities.finishGeneration(ctx, abandoned, output))).rejects.toThrow(
    '失效',
  );
  const saved = await run((ctx) => activities.finishGeneration(ctx, recovered, output));
  expect(saved.activities).toHaveLength(1);
  const replay = await activities.generateActivities(db, actor, w, request, options);
  expect(replay.reused).toBe(true);
  expect(replay.activities[0].id).toBe(saved.activities[0].id);
});
