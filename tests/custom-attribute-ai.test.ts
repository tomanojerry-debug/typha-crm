import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { createApp } from '../server/app.js';
import request from 'supertest';
import { sanitizeAttributeSources } from '../server/attribute-source-visibility.js';
import { scoped, ApiError } from '../server/security.js';
import { insert } from '../server/service.js';
import * as custom from '../server/custom-objects.js';
import * as ai from '../server/custom-attribute-ai.js';
import type { AttributeModelInput, AttributeModelOptions } from '../server/attribute-model.js';
import type {
  CustomAttribute,
  CustomObject,
  CustomRecord,
  CustomValue,
} from '../shared/custom-objects.js';

let db: Database,
  actor: string,
  workspace: string,
  customer: string,
  otherCustomer: string,
  project: string,
  otherProject: string,
  object: CustomObject;
let fields: CustomAttribute[], editor: string, viewer: string;
const quote = '客户明确介绍：公司主打服装为芭蕾练功服。';
const sourceText = `${quote} 数量0，金额0 CNY，是否加急：否，评分3，日期2026-11-18，时间2026-11-18T09:00:00+08:00，单选练功服，多选练功服和演出服。`;
const inScope = <T>(fn: Parameters<typeof scoped<T>>[3]) => scoped(db, actor, workspace, fn);
const kinds: { kind: CustomAttribute['kind']; value: CustomValue; options?: string[] }[] = [
  { kind: 'text', value: '芭蕾练功服' },
  { kind: 'number', value: 0 },
  { kind: 'currency', value: 0 },
  { kind: 'date', value: '2026-11-18' },
  { kind: 'timestamp', value: '2026-11-18T09:00:00+08:00' },
  { kind: 'checkbox', value: false },
  { kind: 'rating', value: 3 },
  { kind: 'select', value: '练功服', options: ['练功服', '演出服'] },
  { kind: 'multi_select', value: ['练功服', '演出服'], options: ['练功服', '演出服'] },
];
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Custom AI synthetic',
    email: 'custom-ai@example.invalid',
    password: 'custom-ai-fixture-password',
    displayName: 'Admin',
  });
  actor = seed.actorId;
  workspace = seed.workspaceId;
  await inScope(async (ctx) => {
    customer = String(
      (await insert(ctx, 'customers', { name: '客户 A（虚构）', type: 'group', source: 'other' }))
        .id,
    );
    otherCustomer = String(
      (await insert(ctx, 'customers', { name: '客户 B（虚构）', type: 'group', source: 'other' }))
        .id,
    );
    project = String(
      (await insert(ctx, 'projects', { customer_id: customer, name: 'A 正确项目', type: 'sample' }))
        .id,
    );
    otherProject = String(
      (
        await insert(ctx, 'projects', {
          customer_id: customer,
          name: 'A 另一个项目',
          type: 'sample',
        })
      ).id,
    );
    await insert(ctx, 'customer_records', {
      customer_id: customer,
      project_id: project,
      kind: 'customer_quote',
      body: sourceText,
      created_by: actor,
    });
    await insert(ctx, 'customer_records', {
      customer_id: customer,
      project_id: otherProject,
      kind: 'customer_quote',
      body: 'OTHER_PROJECT_PRIVATE_SENTINEL',
      created_by: actor,
    });
    await insert(ctx, 'customer_records', {
      customer_id: otherCustomer,
      kind: 'customer_quote',
      body: 'OTHER_CUSTOMER_PRIVATE_SENTINEL',
      created_by: actor,
    });
    object = await custom.createObject(ctx, {
      name: '采购资料（虚构）',
      singular_name: '采购资料',
      slug: 'custom_ai_fixture',
      icon: 'box',
      color: 'blue',
    });
    fields = [];
    for (const item of kinds)
      fields.push(
        await custom.saveField(ctx, object.id, null, {
          name: `AI ${item.kind}`,
          kind: item.kind,
          options: item.options || [],
          description: '按客户原话填写，不将需求视为公司确认',
          ai_enabled: true,
          guidance: '仅按明确资料填写，没有信息则返回null。',
        }),
      );
    object = await custom.object(ctx, object.id);
  });
  for (const role of ['editor', 'viewer']) {
    const id = randomUUID();
    if (role === 'editor') editor = id;
    else viewer = id;
    await db.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      id,
      `${role}-custom-ai@example.invalid`,
      role,
      'test-only-no-login',
    ]);
    await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
      workspace,
      id,
    ]);
    await inScope((ctx) =>
      ctx.tx.query(
        'INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,$4)',
        [workspace, customer, id, role],
      ),
    );
  }
}, 30000);
afterAll(() => db.close());
async function freshRow(extra: Record<string, unknown> = {}) {
  return inScope(async (ctx) => {
    object = await custom.object(ctx, object.id);
    return custom.saveRecord(ctx, object.id, null, {
      name: `合成记录 ${randomUUID()}`,
      customer_id: customer,
      project_id: project,
      object_version: object.version,
      values: {},
      ...extra,
    });
  });
}
const options = (
  value: CustomValue,
  hook?: (input: AttributeModelInput) => Promise<void>,
): AttributeModelOptions => ({
  transport: {
    generate: async (input) => {
      expect(JSON.stringify(input)).not.toContain('OTHER_CUSTOMER_PRIVATE_SENTINEL');
      expect(JSON.stringify(input)).not.toContain('OTHER_PROJECT_PRIVATE_SENTINEL');
      await hook?.(input);
      const source = input.sources.find(
        (s) => s.kind === 'record' && s.body.includes('客户明确介绍'),
      );
      if (value === null)
        return {
          value,
          explanation: '本次检索没有支持该属性的相关信息。',
          missing: ['无相关信息'],
          source_ids: [],
          evidence: [],
        };
      if (!source) throw new Error('Missing scoped fixture record');
      return {
        value,
        explanation: '仅按当前公司及项目的客户原话整理。',
        missing: [],
        source_ids: [source.id],
        evidence: [{ source_id: source.id, quote }],
      };
    },
  },
});
function generate(row: CustomRecord, field: CustomAttribute, model: AttributeModelOptions) {
  return ai.generate(
    db,
    actor,
    workspace,
    object.id,
    row.id,
    {
      attribute_id: field.id,
      attribute_version: field.version,
      object_version: object.version,
      record_version: row.version,
      use_saved_guidance: true,
    },
    model,
  );
}
function apply(row: CustomRecord, runId: string) {
  return inScope((ctx) => ai.applyRun(ctx, object.id, row.id, runId));
}

it('supports nine configured types, preserves zero/false, and persists exact evidence', async () => {
  let row = await freshRow();
  for (const [i, item] of kinds.entries()) {
    const run = await generate(row, fields[i], options(item.value));
    row = await apply(row, run.id);
    expect(row.values[fields[i].id]).toEqual(item.value);
    expect(row.field_provenance[fields[i].id]).toMatchObject({
      origin: 'ai',
      state: 'filled',
      evidence: [{ quote }],
      run_id: run.id,
    });
    expect(await apply(row, run.id)).toEqual(row);
  }
  const snapshot = await inScope(async (ctx) =>
    (await import('../server/knowledge.js')).knowledgeSnapshot(ctx, customer),
  );
  const stored = snapshot.entities.find((e) => e.id === row.id)!;
  expect(JSON.stringify(stored.attributes.field_provenance)).not.toContain(quote);
  expect(stored.attributes.field_provenance).toMatchObject({
    [fields[0].id]: { origin: 'ai', state: 'filled' },
  });
});

it('stores an explicit no-information state while keeping the business value null across reload', async () => {
  const row = await freshRow();
  const run = await generate(row, fields[0], options(null));
  await apply(row, run.id);
  const stored = await inScope((ctx) => custom.record(ctx, object.id, row.id));
  expect(stored.values[fields[0].id]).toBeNull();
  expect(stored.field_provenance[fields[0].id]).toMatchObject({
    origin: 'ai',
    state: 'no_information',
    sources: [],
    evidence: [],
  });
  const retry = await generate(stored, fields[0], options('芭蕾练功服'));
  expect((await apply(stored, retry.id)).values[fields[0].id]).toBe('芭蕾练功服');
});

it('does not call the model for existing manual values, numeric zero, or false', async () => {
  const row = await freshRow({
    values: { [fields[0].id]: '手工内容', [fields[1].id]: 0, [fields[5].id]: false },
  });
  let calls = 0;
  for (const field of [fields[0], fields[1], fields[5]])
    await expect(
      generate(
        row,
        field,
        options('不该调用', async () => {
          calls++;
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
  expect(calls).toBe(0);
});

it('preserves an intervening manual edit during generation and before apply', async () => {
  let row = await freshRow();
  await expect(
    generate(
      row,
      fields[0],
      options('芭蕾练功服', async () => {
        row = await inScope((ctx) =>
          custom.saveRecord(ctx, object.id, row.id, {
            name: row.name,
            customer_id: customer,
            project_id: project,
            object_version: object.version,
            version: row.version,
            values: { ...row.values, [fields[0].id]: '人工在生成中修改' },
          }),
        );
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(row.values[fields[0].id]).toBe('人工在生成中修改');
  row = await freshRow();
  const run = await generate(row, fields[0], options('芭蕾练功服'));
  row = await inScope((ctx) =>
    custom.saveRecord(ctx, object.id, row.id, {
      name: row.name,
      customer_id: customer,
      project_id: project,
      object_version: object.version,
      version: row.version,
      values: { ...row.values, [fields[0].id]: '人工在应用前修改' },
    }),
  );
  await expect(apply(row, run.id)).rejects.toMatchObject({ status: 409 });
  expect(row.values[fields[0].id]).toBe('人工在应用前修改');
});

it('manual editing clears only changed AI provenance and preserves other field evidence', async () => {
  let row = await freshRow();
  row = await apply(row, (await generate(row, fields[0], options('芭蕾练功服'))).id);
  row = await apply(row, (await generate(row, fields[1], options(0))).id);
  row = await inScope((ctx) =>
    custom.saveRecord(ctx, object.id, row.id, {
      name: row.name,
      customer_id: customer,
      project_id: project,
      object_version: object.version,
      version: row.version,
      values: { ...row.values, [fields[0].id]: '用户重新填写' },
    }),
  );
  expect(row.field_provenance[fields[0].id]).toMatchObject({
    origin: 'manual',
    sources: [],
    evidence: [],
    run_id: null,
  });
  expect(row.field_provenance[fields[1].id]).toMatchObject({
    origin: 'ai',
    state: 'filled',
    evidence: [{ quote }],
  });
});

it('rejects invented citations, quotes and wrong field types without persisting runs', async () => {
  const row = await freshRow();
  const before = (
    await db.query<{ n: number }>('SELECT count(*)::int AS n FROM custom_attribute_runs')
  ).rows[0].n;
  for (const result of [
    {
      value: '伪造',
      source_ids: ['record:other'],
      evidence: [{ source_id: 'record:other', quote }],
    },
    { value: '伪造', source_ids: [], evidence: [] },
    { value: 42, source_ids: [], evidence: [] },
  ])
    await expect(
      generate(row, fields[0], {
        transport: {
          generate: async () => ({ ...result, explanation: '拒绝无依据值', missing: [] }),
        },
      }),
    ).rejects.toBeInstanceOf(ApiError);
  await expect(
    generate(row, fields[0], {
      transport: {
        generate: async (input) => {
          const source = input.sources.find((s) => s.kind === 'record')!;
          return {
            value: '伪造',
            explanation: '拒绝伪造摘录',
            missing: [],
            source_ids: [source.id],
            evidence: [{ source_id: source.id, quote: '这是一句原文从未出现过的话' }],
          };
        },
      },
    }),
  ).rejects.toMatchObject({ status: 502 });
  await expect(generate(row, fields[0], options(42))).rejects.toMatchObject({ status: 502 });
  expect(
    (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM custom_attribute_runs')).rows[0]
      .n,
  ).toBe(before);
});

it('does not turn model/transport failures into a no-information value', async () => {
  const row = await freshRow();
  await expect(
    generate(row, fields[0], {
      transport: {
        generate: async () => {
          throw new ApiError(503, '服务不可用');
        },
      },
    }),
  ).rejects.toMatchObject({ status: 503 });
  const stored = await inScope((ctx) => custom.record(ctx, object.id, row.id));
  expect(stored.field_provenance[fields[0].id].origin).toBe('manual');
  expect(stored.field_provenance[fields[0].id].state).toBe('filled');
});

it('revalidates original sources and rejects a run addressed to another record', async () => {
  const row = await freshRow(),
    other = await freshRow();
  const run = await generate(row, fields[0], options('芭蕾练功服'));
  await expect(apply(other, run.id)).rejects.toMatchObject({ status: 404 });
  await inScope((ctx) =>
    insert(ctx, 'customer_records', {
      customer_id: customer,
      project_id: project,
      kind: 'customer_quote',
      body: '补充后的最新资料',
      created_by: actor,
    }),
  );
  await expect(apply(row, run.id)).rejects.toMatchObject({ status: 409 });
});

it('revalidates property configuration between generation and apply', async () => {
  const row = await freshRow();
  const run = await generate(row, fields[0], options('芭蕾练功服'));
  fields[0] = await inScope((ctx) => {
    const { id, object_id, version, ...rest } = fields[0];
    return custom.saveField(ctx, object.id, id, {
      ...rest,
      version,
      guidance: '新的指引：无依据时不填写。',
    });
  });
  await expect(apply(row, run.id)).rejects.toMatchObject({ status: 409 });
});

it('keeps a required field unknown when evidence is absent, without bypassing later manual validation', async () => {
  const fixture = await inScope(async (ctx) => {
    const definition = await custom.createObject(ctx, {
      name: '必填列验收',
      singular_name: '必填记录',
      slug: 'required_ai_fixture',
      icon: 'box',
      color: 'gray',
    });
    const row = await custom.saveRecord(ctx, definition.id, null, {
      name: '属性添加前的历史行',
      customer_id: customer,
      project_id: project,
      object_version: definition.version,
      values: {},
    });
    const field = await custom.saveField(ctx, definition.id, null, {
      name: '未提供的资料',
      kind: 'text',
      required: true,
      ai_enabled: true,
      guidance: '没有相关信息时返回null',
    });
    return { row, field, definition: await custom.object(ctx, definition.id) };
  });
  const run = await ai.generate(
    db,
    actor,
    workspace,
    fixture.definition.id,
    fixture.row.id,
    {
      attribute_id: fixture.field.id,
      attribute_version: fixture.field.version,
      object_version: fixture.definition.version,
      record_version: fixture.row.version,
      use_saved_guidance: true,
    },
    options(null),
  );
  const row = await inScope((ctx) =>
    ai.applyRun(ctx, fixture.definition.id, fixture.row.id, run.id),
  );
  expect(row.values[fixture.field.id]).toBeNull();
  expect(row.field_provenance[fixture.field.id].state).toBe('no_information');
  await expect(
    inScope((ctx) =>
      custom.saveRecord(ctx, fixture.definition.id, row.id, {
        name: row.name,
        customer_id: customer,
        project_id: project,
        object_version: fixture.definition.version,
        version: row.version,
        values: row.values,
      }),
    ),
  ).rejects.toMatchObject({ status: 400 });
});

it('requires editor access and keeps generation results private to their actor', async () => {
  const row = await freshRow();
  const body = {
    attribute_id: fields[0].id,
    attribute_version: fields[0].version,
    object_version: object.version,
    record_version: row.version,
    use_saved_guidance: true,
  };
  await expect(
    ai.generate(db, viewer, workspace, object.id, row.id, body, options('芭蕾练功服')),
  ).rejects.toMatchObject({ status: 403 });
  const run = await generate(row, fields[0], options('芭蕾练功服'));
  await expect(
    scoped(db, editor, workspace, (ctx) => ai.applyRun(ctx, object.id, row.id, run.id)),
  ).rejects.toMatchObject({ status: 404 });
  const editorRun = await ai.generate(
    db,
    editor,
    workspace,
    object.id,
    row.id,
    body,
    options('芭蕾练功服'),
  );
  await inScope((ctx) =>
    ctx.tx.query(
      "UPDATE customer_access SET access='viewer' WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3",
      [workspace, customer, editor],
    ),
  );
  await expect(
    scoped(db, editor, workspace, (ctx) => ai.applyRun(ctx, object.id, row.id, editorRun.id)),
  ).rejects.toMatchObject({ status: 404 });
  await inScope((ctx) =>
    ctx.tx.query(
      "UPDATE customer_access SET access='editor' WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3",
      [workspace, customer, editor],
    ),
  );
  await expect(
    ai.generate(
      db,
      editor,
      workspace,
      object.id,
      row.id,
      body,
      options('芭蕾练功服', async () => {
        await inScope((ctx) =>
          ctx.tx.query(
            'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
            [workspace, customer, editor],
          ),
        );
      }),
    ),
  ).rejects.toMatchObject({ status: 404 });
});

it('exposes the configured field and saves a no-information result through the real HTTP routes', async () => {
  const row = await freshRow();
  const origin = 'http://localhost:3100';
  const client = request.agent(createApp(db, { origin, attributes: options(null) }));
  await client
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'custom-ai@example.invalid', password: 'custom-ai-fixture-password' })
    .expect(200);
  const headers = { origin, 'x-workspace-id': workspace };
  const definitions = (
    await client.get(`/api/custom-objects/${object.id}/attributes`).set(headers).expect(200)
  ).body as CustomAttribute[];
  expect(definitions.find((field) => field.id === fields[0].id)).toMatchObject({
    ai_enabled: true,
    guidance: fields[0].guidance,
    description: fields[0].description,
  });
  const path = `/api/custom-objects/${object.id}/records/${row.id}/attribute-runs`;
  const run = (
    await client
      .post(path)
      .set(headers)
      .send({
        attribute_id: fields[0].id,
        attribute_version: fields[0].version,
        object_version: object.version,
        record_version: row.version,
        use_saved_guidance: true,
      })
      .expect(201)
  ).body;
  expect(run).not.toHaveProperty('retrieval_plan');
  const stored = (await client.post(`${path}/${run.id}/apply`).set(headers).send({}).expect(200))
    .body as CustomRecord;
  expect(stored.values[fields[0].id]).toBeNull();
  expect(stored.field_provenance[fields[0].id]).toMatchObject({
    origin: 'ai',
    state: 'no_information',
  });
});

it('never treats target identity or graph metadata as original business evidence', async () => {
  const row = await freshRow();
  await expect(
    generate(row, fields[0], {
      transport: {
        generate: async (input) => {
          expect(input.sources.some((source) => source.id === `custom-row:${row.id}`)).toBe(false);
          return {
            value: '凭行名猜的业务值',
            explanation: '错误引用行名',
            missing: [],
            source_ids: [`custom-row:${row.id}`],
            evidence: [{ source_id: `custom-row:${row.id}`, quote: row.name }],
          };
        },
      },
    }),
  ).rejects.toMatchObject({ status: 502 });
  await inScope(async (ctx) => {
    const raw = (
      await ctx.tx.query<{ id: string }>(
        'SELECT id FROM customer_records WHERE workspace_id=$1 AND customer_id=$2 AND body=$3',
        [workspace, customer, sourceText],
      )
    ).rows[0];
    expect(
      await sanitizeAttributeSources(ctx, customer, [
        {
          id: `record:${raw.id}`,
          kind: 'record',
          title: '旧图来源',
          body: '仅元数据中存在的伪引文',
          quote: '仅元数据中存在的伪引文',
        },
      ]),
    ).toEqual({ sources: [], invalid: true });
    expect(
      await sanitizeAttributeSources(ctx, customer, [
        { id: `record:${raw.id}`, kind: 'record', title: '旧资料', body: sourceText },
      ]),
    ).toEqual({ sources: [], invalid: true });
  });
});

it('hides stale source snapshots when their project is archived while retaining the saved value', async () => {
  const row = await freshRow();
  const stored = await apply(row, (await generate(row, fields[0], options('芭蕾练功服'))).id);
  await inScope((ctx) =>
    ctx.tx.query(
      'UPDATE projects SET archived_at=now() WHERE workspace_id=$1 AND customer_id=$2 AND id=$3',
      [workspace, customer, project],
    ),
  );
  try {
    const fresh = await inScope((ctx) => custom.record(ctx, object.id, stored.id));
    expect(fresh.values[fields[0].id]).toBe('芭蕾练功服');
    expect(fresh.field_provenance[fields[0].id]).toMatchObject({
      origin: 'ai',
      sources_stale: true,
      sources: [],
      evidence: [],
    });
    expect(JSON.stringify(fresh.field_provenance[fields[0].id])).not.toContain(quote);
  } finally {
    await inScope((ctx) =>
      ctx.tx.query(
        'UPDATE projects SET archived_at=NULL WHERE workspace_id=$1 AND customer_id=$2 AND id=$3',
        [workspace, customer, project],
      ),
    );
  }
});
