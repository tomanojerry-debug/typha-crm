import { beforeAll, afterAll, expect, it } from 'vitest';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { scoped, type Context } from '../server/security.js';
import { insert } from '../server/service.js';
import { createField, generate, applyRun, saveValue, values } from '../server/attributes.js';
import type { AttributeModelInput, AttributeModelOptions } from '../server/attribute-model.js';
import { sourceEmbeddingModel, type LocalEmbeddingTransport } from '../shared/source-search.js';
import {
  buildAttributeRetrieval,
  attributeRetrievedSources,
} from '../server/attribute-evidence.js';

let db: Database, workspace: string, actor: string, customer: string, target: string;
const run = <T>(fn: (ctx: Context) => Promise<T>) => scoped(db, actor, workspace, fn);
const text = '我们公司主打儿童芭蕾练功服和舞台演出裙，不经营婚纱。';
const embedding: LocalEmbeddingTransport = {
  async embed({ texts }) {
    return {
      model: sourceEmbeddingModel,
      dimensions: 384,
      vectors: texts.map((body) =>
        Array.from({ length: 384 }, (_, i) =>
          i === (body.includes('主打') || body.includes('价格') ? 0 : 1) ? 1 : 0,
        ),
      ),
    };
  },
};
let seen: AttributeModelInput[] = [];
const options: AttributeModelOptions = {
  embeddings: embedding,
  transport: {
    async generate(input) {
      seen.push(input);
      const source = input.sources.find((s) => s.id === `record:${target}`)!;
      return input.field.name.includes('价格')
        ? {
            value: null,
            explanation: '无相关信息',
            source_ids: [],
            evidence: [],
            missing: ['没有公司已确认价格'],
          }
        : {
            value: '儿童芭蕾练功服、舞台演出裙',
            explanation: '根据客户介绍其主营品类，非公司确认订单。',
            source_ids: [source.id],
            evidence: [{ source_id: source.id, quote: text }],
            missing: [],
          };
    },
  },
};
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: '属性原文召回（虚构）',
    email: 'attribute-raw@example.invalid',
    password: 'synthetic-password-only',
    displayName: '验收',
  });
  workspace = seed.workspaceId;
  actor = seed.actorId;
  await run(async (ctx) => {
    customer = String(
      (await insert(ctx, 'customers', { name: '虚构舞服公司', type: 'group', source: 'other' })).id,
    );
    target = String(
      (
        await insert(ctx, 'customer_records', {
          customer_id: customer,
          kind: 'customer_quote',
          body: text,
          occurred_at: '2020-01-01T00:00:00Z',
          created_by: actor,
        })
      ).id,
    );
    for (let i = 0; i < 205; i++)
      await insert(ctx, 'customer_records', {
        customer_id: customer,
        kind: 'customer_quote',
        body: `虚构物流编号${i}，无新增条件。`,
        created_by: actor,
      });
    const other = String(
      (await insert(ctx, 'customers', { name: '另一个客户', type: 'group', source: 'other' })).id,
    );
    await insert(ctx, 'customer_records', {
      customer_id: other,
      kind: 'customer_quote',
      body: '我们主打OTHER_CUSTOMER_PRIVATE婚纱',
      created_by: actor,
    });
  });
}, 30000);
afterAll(() => db.close());
async function field(name: string) {
  return run((ctx) =>
    createField(ctx, {
      name,
      kind: 'text',
      ai_enabled: true,
      guidance: '只依据本客户明确原文整理；无直接依据返回null，保留客户原话性质。',
    }),
  );
}
async function build(f: Awaited<ReturnType<typeof field>>, config = options) {
  return generate(
    db,
    actor,
    workspace,
    customer,
    {
      attribute_id: f.id,
      attribute_version: f.version,
      use_saved_guidance: true,
      only_empty: true,
    },
    config,
  );
}

it('keeps the Graphiti-only comparison free of raw index reads and embedding calls', async () => {
  const before = await run((ctx) => ctx.tx.query('SELECT id FROM source_chunks'));
  let embeddingCalls = 0;
  const plan = await buildAttributeRetrieval(db, actor, workspace, customer, '公司主打服装', {
    retrievalMode: 'graphiti',
    embeddings: {
      async embed() {
        embeddingCalls++;
        throw new Error('Graphiti-only must not query or populate the raw vector index');
      },
    },
  });
  expect(plan.mode).toBe('graphiti');
  expect(plan.source).toBeNull();
  expect(embeddingCalls).toBe(0);
  const after = await run((ctx) => ctx.tx.query('SELECT id FROM source_chunks'));
  expect(after.rows).toEqual(before.rows);
  const context = await run((ctx) => attributeRetrievedSources(ctx, plan));
  expect(context.warnings.join('')).toContain('未启用独立原文向量检索');
  expect(context.warnings.join('')).not.toContain('原文向量索引未配置');
}, 30000);

it('fills a newly added column from unextracted history beyond 200 Records with one cited Record', async () => {
  const f = await field('公司主打服装');
  const candidate = await build(f);
  expect(candidate.sources).toHaveLength(1);
  expect(candidate.sources[0].id).toBe(`record:${target}`);
  expect(JSON.stringify(seen.at(-1))).not.toContain('OTHER_CUSTOMER_PRIVATE');
  const saved = await run((ctx) => applyRun(ctx, customer, candidate.id));
  expect(saved).toMatchObject({ value: '儿童芭蕾练功服、舞台演出裙', origin: 'ai' });
  expect(saved.sources[0].quote).toBe(text);
}, 30000);
it('persists unsupported null as AI no-information, allows manual input and protects that input', async () => {
  const f = await field('公司已确认价格');
  const candidate = await build(f);
  const saved = await run((ctx) => applyRun(ctx, customer, candidate.id));
  expect(
    (await run((ctx) => values(ctx, customer))).find((v) => v.attribute_id === f.id),
  ).toMatchObject({ value: null, origin: 'ai' });
  await run((ctx) =>
    saveValue(ctx, customer, f.id, {
      value: '人工指定资料，需核对',
      version: saved.version,
      attribute_version: f.version,
    }),
  );
  const before = seen.length;
  await expect(build(f)).rejects.toMatchObject({ status: 409 });
  expect(seen.length).toBe(before);
}, 30000);
it('rejects applying a fixed result after its original evidence changes', async () => {
  const f = await field('主打服装变更复核');
  const candidate = await build(f);
  await run((ctx) =>
    insert(ctx, 'customer_records', {
      customer_id: customer,
      kind: 'customer_quote',
      body: '更正：旧介绍作废，主营情况未明确。',
      created_by: actor,
    }),
  );
  await expect(run((ctx) => applyRun(ctx, customer, candidate.id))).rejects.toMatchObject({
    status: 409,
  });
}, 30000);
