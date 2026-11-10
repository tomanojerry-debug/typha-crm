import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { scoped, type Context } from '../server/security.js';
import { insert } from '../server/service.js';
import { createPerson } from '../server/people.js';
import { modelSnapshot } from '../server/ask.js';
import { snapshotDigest } from '../server/agent-model.js';
import * as custom from '../server/custom-objects.js';
import { entitySchema } from '../server/entity-schema.js';
import { knowledgeSnapshot, knowledgeAgentSources } from '../server/knowledge.js';
import { communicationInputs, extractSnapshot } from '../server/communication-pipeline.js';
import {
  validateCommunicationExtraction,
  type CommunicationExtractionInput,
} from '../server/communication-extraction.js';

let db: Database,
  workspace: string,
  actor: string,
  company: string,
  foreign: string,
  project: string,
  person: string,
  object: string,
  row: string,
  quantity: string,
  choice: string,
  amount: string;
const run = <T>(fn: (ctx: Context) => Promise<T>) => scoped(db, actor, workspace, fn);
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'Schema v2 synthetic',
    email: 'schema-v2@example.invalid',
    displayName: 'Admin',
    password: 'synthetic-schema-password',
  });
  workspace = seed.workspaceId;
  actor = seed.actorId;
  company = String(
    (
      await run((ctx) =>
        insert(ctx, 'customers', { name: '合成舞团', type: 'group', source: 'email' }),
      )
    ).id,
  );
  foreign = String(
    (
      await run((ctx) =>
        insert(ctx, 'customers', { name: 'OTHER PRIVATE', type: 'group', source: 'email' }),
      )
    ).id,
  );
  project = String(
    (
      await run((ctx) =>
        insert(ctx, 'projects', { name: '合成样衣', type: 'sample', customer_id: company }),
      )
    ).id,
  );
  person = (await run((ctx) => createPerson(ctx, { customer_id: company, name: '合成联系人' }))).id;
  object = (
    await run((ctx) =>
      custom.createObject(ctx, {
        name: '样衣反馈',
        singular_name: '反馈',
        slug: 'sample_feedback',
        icon: 'box',
        color: 'gray',
      }),
    )
  ).id;
  quantity = (
    await run((ctx) => custom.saveField(ctx, object, null, { name: '数量', kind: 'number' }))
  ).id;
  choice = (
    await run((ctx) =>
      custom.saveField(ctx, object, null, {
        name: '颜色',
        kind: 'multi_select',
        options: ['蓝', '黑'],
      }),
    )
  ).id;
  amount = (
    await run((ctx) =>
      custom.saveField(ctx, object, null, { name: '预算', kind: 'currency', currency: 'CNY' }),
    )
  ).id;
  const version = (await run((ctx) => custom.object(ctx, object))).version;
  row = (
    await run((ctx) =>
      custom.saveRecord(ctx, object, null, {
        name: 'V2反馈',
        customer_id: company,
        project_id: project,
        object_version: version,
        values: { [quantity]: 100, [choice]: ['蓝'], [amount]: 5000 },
      }),
    )
  ).id;
  await run((ctx) =>
    custom.saveRecord(ctx, object, null, {
      name: 'OTHER PRIVATE ROW',
      customer_id: foreign,
      object_version: version,
      values: { [quantity]: 99999 },
    }),
  );
  await run((ctx) =>
    insert(ctx, 'customer_records', {
      customer_id: company,
      project_id: project,
      kind: 'customer_quote',
      created_by: actor,
      body: 'V2反馈数量改为80件，颜色蓝和黑，预算5000元；尚未批准修改。',
    }),
  );
});
afterAll(async () => {
  await db?.close();
});

async function input() {
  return communicationInputs(await run((ctx) => knowledgeSnapshot(ctx, company)))[0];
}
function candidate(data: CommunicationExtractionInput) {
  const message = data.messages[0];
  return {
    version: data.version,
    record_id: data.record_id,
    trust: 'unconfirmed',
    entities: [
      {
        ref: 'feedback',
        kind: 'custom',
        object_id: object,
        name: 'V2反馈',
        canonical_id: row,
        evidence: [{ message_id: message.id, quote: 'V2反馈' }],
      },
    ],
    attributes: [
      {
        id: 'quantity',
        entity_ref: 'feedback',
        field_id: quantity,
        field_label: '数量',
        value: { type: 'number', value: 80, unit: '件' },
        speaker_id: message.speaker_id,
        modality: 'requested',
        effective_at: null,
        evidence: [{ message_id: message.id, quote: '数量改为80件' }],
      },
    ],
    relations: [],
    changes: [],
    uncertainties: [],
  };
}

it('publishes an executable catalog with six generic defaults and active field metadata', async () => {
  const schema = await run(entitySchema),
    objectSchema = schema.objects!.find((o) => o.id === object)!;
  expect(objectSchema.kind).toBe('custom');
  expect(objectSchema.attributes.filter((a) => a.system)).toHaveLength(6);
  expect(objectSchema.attributes.find((a) => a.id === choice)).toMatchObject({
    type: 'select',
    multiple: true,
    options: ['蓝', '黑'],
    writable: true,
  });
  expect(objectSchema.attributes.find((a) => a.id === amount)).toMatchObject({
    type: 'currency',
    currency: 'CNY',
  });
  expect(
    schema.references!.filter((r) => r.source_object === object).every((r) => !r.bidirectional),
  ).toBe(true);
  expect(
    schema.objects!.find((o) => o.id === 'people')!.attributes.find((a) => a.name === '主要联系人')
      ?.type,
  ).toBe('checkbox');
  const companySchema = schema.objects!.find((o) => o.id === 'customers')!;
  expect(companySchema.attributes.find((a) => a.id === 'customers:email_count')).toMatchObject({
    type: 'number',
    computed: true,
    extraction_supported: false,
  });
  expect(companySchema.attributes.find((a) => a.id === 'customers:type')).toMatchObject({
    options: ['distributor', 'group', 'retail'],
    option_labels: { group: '团体定制' },
  });
  expect(companySchema.attributes.find((a) => a.id === 'customers:contact')?.storage_key).toBe(
    'contact_name',
  );
  expect(companySchema.attributes.find((a) => a.id === 'customers:owner')?.storage_key).toBe(
    'owner_id',
  );
});
it('keeps custom canonical records, references and model inputs inside one customer', async () => {
  const snapshot = await run((ctx) => knowledgeSnapshot(ctx, company));
  expect(snapshot.entities.find((e) => e.id === row)?.object).toBe(object);
  expect(JSON.stringify(snapshot)).not.toContain('OTHER PRIVATE');
  expect(snapshot.relationships).toContainEqual(
    expect.objectContaining({
      definition_id: `custom-project:${object}`,
      source_id: row,
      target_id: project,
    }),
  );
  const data = communicationInputs(snapshot)[0];
  expect(data.known_entities).toContainEqual(
    expect.objectContaining({ id: row, kind: 'custom', object_id: object }),
  );
  expect(validateCommunicationExtraction(candidate(data), data).attributes[0].field_id).toBe(
    quantity,
  );
});
it('rejects mismatched custom identity, invented canonical IDs and readonly field mappings', async () => {
  const data = await input();
  for (const mutate of [
    (v: ReturnType<typeof candidate>) => {
      v.entities[0].object_id = randomUUID();
    },
    (v: ReturnType<typeof candidate>) => {
      v.entities[0].canonical_id = randomUUID();
    },
    (v: ReturnType<typeof candidate>) => {
      v.attributes[0].field_id = `${object}:created_at`;
    },
  ]) {
    const v = candidate(data);
    mutate(v);
    expect(() => validateCommunicationExtraction(v, data)).toThrow();
  }
});
it('rejects wrong types, invalid multi options, duplicate options and currency mismatch', async () => {
  const data = await input();
  const check = (field: string, value: unknown, valid: boolean) => {
    const v: any = candidate(data);
    v.attributes[0].field_id = field;
    v.attributes[0].field_label = data.attributes.find((f) => f.id === field)!.name;
    v.attributes[0].value = value;
    if (valid) expect(() => validateCommunicationExtraction(v, data)).not.toThrow();
    else expect(() => validateCommunicationExtraction(v, data)).toThrow();
  };
  check(quantity, { type: 'text', value: '80', unit: null }, false);
  check(choice, { type: 'select', value: ['蓝', '黑'], unit: null }, true);
  check(choice, { type: 'select', value: '蓝', unit: null }, false);
  check(choice, { type: 'select', value: ['蓝', '紫'], unit: null }, false);
  check(choice, { type: 'select', value: ['蓝', '蓝'], unit: null }, false);
  check(amount, { type: 'currency', value: 5000, currency: 'CNY', unit: null }, true);
  check(amount, { type: 'currency', value: 5000, currency: 'USD', unit: null }, false);
});
it('accepts all nine configured attribute kinds without treating zero or false as missing', async () => {
  const data = await input();
  const cases = [
    ['text', false, { type: 'text', value: 'V2', unit: null }],
    ['number', false, { type: 'number', value: 0, unit: '件' }],
    ['currency', false, { type: 'currency', value: 0, currency: 'CNY', unit: null }],
    ['date', false, { type: 'date', value: '2026-10-23', unit: null }],
    ['timestamp', false, { type: 'timestamp', value: '2026-10-23T09:30:00+08:00', unit: null }],
    ['checkbox', false, { type: 'checkbox', value: false, unit: null }],
    ['rating', false, { type: 'rating', value: 5, unit: null }],
    ['select', false, { type: 'select', value: '蓝', unit: null }],
    ['select', true, { type: 'select', value: ['蓝', '黑'], unit: null }],
  ] as const;
  for (const [type, multiple, value] of cases) {
    const id = randomUUID();
    data.attributes.push({
      id,
      object_id: object,
      entity_kind: 'custom',
      name: '测试字段',
      value_type: type,
      multiple,
      options: ['蓝', '黑'],
      currency: 'CNY',
      required: true,
      writable: true,
      extraction_supported: true,
    });
    const v: any = candidate(data);
    v.attributes[0].field_id = id;
    v.attributes[0].field_label = '测试字段';
    v.attributes[0].value = value;
    expect(() => validateCommunicationExtraction(v, data)).not.toThrow();
  }
});
it('only connects changes for the same registered field and canonical subject', async () => {
  const data = await input();
  data.prior_claims.push({
    id: 'prior-quantity',
    description: '旧数量100件',
    claim_kind: 'attribute',
    field_id: quantity,
    object_id: object,
    canonical_id: row,
    entity_kind: 'custom',
  });
  const v: any = candidate(data);
  v.changes.push({
    new_claim_id: 'quantity',
    old_claim_id: 'prior-quantity',
    kind: 'proposed_change',
    evidence: v.attributes[0].evidence,
  });
  expect(() => validateCommunicationExtraction(v, data)).not.toThrow();
  data.prior_claims[0].field_id = amount;
  expect(() => validateCommunicationExtraction(v, data)).toThrow();
  data.prior_claims[0].field_id = quantity;
  data.prior_claims[0].canonical_id = randomUUID();
  expect(() => validateCommunicationExtraction(v, data)).toThrow();
  data.prior_claims = [];
  v.attributes.push({
    ...v.attributes[0],
    id: 'other',
    field_id: amount,
    field_label: '预算',
    value: { type: 'currency', value: 5000, currency: 'CNY', unit: null },
  });
  v.changes[0].old_claim_id = 'other';
  expect(() => validateCommunicationExtraction(v, data)).toThrow();
});
it('exposes existing custom rows to company/project Agent scopes without creating evidence Records', async () => {
  const before = (await db.query('SELECT count(*)::int AS n FROM customer_records')).rows[0].n;
  const companySources = await run((ctx) => knowledgeAgentSources(ctx, company));
  expect(companySources.find((s) => s.id === `custom::${object}::${row}`)?.body).toContain('数量');
  expect(
    (await run((ctx) => knowledgeAgentSources(ctx, company, { project_id: project }))).some((s) =>
      s.id.startsWith('custom::'),
    ),
  ).toBe(true);
  expect(
    (await run((ctx) => knowledgeAgentSources(ctx, company, { person_id: person }))).some((s) =>
      s.id.startsWith('custom::'),
    ),
  ).toBe(false);
  expect(JSON.stringify(companySources)).not.toContain('OTHER PRIVATE');
  expect((await db.query('SELECT count(*)::int AS n FROM customer_records')).rows[0].n).toBe(
    before,
  );
});
it('queues a changed custom row and changes the Agent digest before an answer can publish', async () => {
  const scope = {
    kind: 'entity' as const,
    object: 'customers' as const,
    customer_id: company,
    record_id: company,
  };
  const before = await run((ctx) => modelSnapshot(ctx, scope));
  const saved = await run((ctx) => custom.record(ctx, object, row));
  const currentObject = await run((ctx) => custom.object(ctx, object));
  const beforeQueue = Number(
    (await db.query('SELECT requested_version FROM knowledge_sync WHERE customer_id=$1', [company]))
      .rows[0].requested_version,
  );
  await run((ctx) =>
    custom.saveRecord(ctx, object, row, {
      name: 'V2反馈已人工更新',
      customer_id: company,
      project_id: project,
      values: saved.values,
      version: saved.version,
      object_version: currentObject.version,
    }),
  );
  const after = await run((ctx) => modelSnapshot(ctx, scope));
  expect(snapshotDigest(after)).not.toBe(snapshotDigest(before));
  expect(
    Number(
      (
        await db.query('SELECT requested_version FROM knowledge_sync WHERE customer_id=$1', [
          company,
        ])
      ).rows[0].requested_version,
    ),
  ).toBeGreaterThan(beforeQueue);
  expect(after.sources.find((s) => s.id === `custom::${object}::${row}`)?.body).toContain(
    '"version":2',
  );
});
it('invalidates cached extraction after field changes and never overwrites the saved row', async () => {
  const first = await run((ctx) => knowledgeSnapshot(ctx, company));
  const result = await extractSnapshot(first, [], async (data) => candidate(data));
  const field = (await run((ctx) => custom.fields(ctx, object))).find((a) => a.id === quantity)!;
  const beforeQueue = Number(
    (await db.query('SELECT requested_version FROM knowledge_sync WHERE customer_id=$1', [company]))
      .rows[0].requested_version,
  );
  const { id: _id, object_id: _objectId, ...config } = field;
  await run((ctx) =>
    custom.saveField(ctx, object, quantity, { ...config, version: field.version, archived: true }),
  );
  const changed = await run((ctx) => knowledgeSnapshot(ctx, company));
  expect(changed.schema.revision).not.toBe(first.schema.revision);
  expect(
    Number(
      (
        await db.query('SELECT requested_version FROM knowledge_sync WHERE customer_id=$1', [
          company,
        ])
      ).rows[0].requested_version,
    ),
  ).toBeGreaterThan(beforeQueue);
  expect(
    changed.schema.objects!.find((o) => o.id === object)!.attributes.some((a) => a.id === quantity),
  ).toBe(false);
  expect(changed.entities.find((e) => e.id === row)!.attributes.values).not.toHaveProperty(
    quantity,
  );
  await expect(
    extractSnapshot(changed, result.extractions, async () => {
      throw new Error('cache invalidated');
    }),
  ).rejects.toThrow();
  expect((await run((ctx) => custom.record(ctx, object, row))).values[quantity]).toBe(100);
});
