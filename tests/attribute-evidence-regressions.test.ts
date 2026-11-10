import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWorkspace } from '../server/bootstrap.js';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { scoped, type Context } from '../server/security.js';
import { insert } from '../server/service.js';
import { createField, generate, applyRun } from '../server/attributes.js';
import type { AttributeModelOptions } from '../server/attribute-model.js';
import { sourceEmbeddingModel } from '../shared/source-search.js';

let db: Database, actor: string, workspace: string, customer: string, editor: string;
const scope = <T>(fn: (ctx: Context) => Promise<T>) => scoped(db, actor, workspace, fn);
const original = '客户自述：公司主打儿童芭蕾练功服。';
const options: AttributeModelOptions = {
  embeddings: {
    async embed({ texts }) {
      return {
        model: sourceEmbeddingModel,
        dimensions: 384,
        vectors: texts.map(() => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))),
      };
    },
  },
  transport: {
    async generate(input) {
      const source = input.sources.find((s) => s.kind === 'record' && s.body.includes(original))!;
      return {
        value: '儿童芭蕾练功服',
        explanation: '依据当前客户原话，不表示公司正式确认。',
        source_ids: [source.id],
        evidence: [{ source_id: source.id, quote: original }],
        missing: [],
      };
    },
  },
};
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const seed = await createWorkspace(db, {
    name: 'AI evidence regression（虚构）',
    email: 'ai-evidence-regression@example.invalid',
    displayName: '验收',
    password: 'synthetic-only-password',
  });
  actor = seed.actorId;
  workspace = seed.workspaceId;
  const other = await createWorkspace(db, {
    name: 'Other workspace（虚构）',
    email: 'ai-evidence-editor@example.invalid',
    displayName: 'Editor',
    password: 'synthetic-only-password',
  });
  editor = other.actorId;
  customer = String(
    (
      await scope((ctx) =>
        insert(ctx, 'customers', {
          name: '芭蕾服公司（虚构）',
          type: 'group',
          source: 'other',
        }),
      )
    ).id,
  );
  await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
    workspace,
    editor,
  ]);
  await scope((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor')",
      [workspace, customer, editor],
    ),
  );
}, 30000);
afterAll(() => db.close());
async function fixture() {
  const record = await scope((ctx) =>
    insert(ctx, 'customer_records', {
      customer_id: customer,
      kind: 'customer_quote',
      body: original,
      created_by: actor,
    }),
  );
  const field = await scope((ctx) =>
    createField(ctx, {
      name: `主打服装 ${randomUUID().slice(0, 8)}`,
      kind: 'text',
      ai_enabled: true,
      guidance: '只依据原文，无直接依据则返回null。',
    }),
  );
  return {
    record,
    field,
    request: {
      attribute_id: field.id,
      attribute_version: field.version,
      use_saved_guidance: true,
      only_empty: true,
    },
  };
}
it('applies an unchanged result after its fixed source search plan round-trips through JSONB', async () => {
  const f = await fixture();
  const result = await generate(db, actor, workspace, customer, f.request, options);
  const stored = (
    await db.query<{
      retrieval_plan: { source: { vector: number[]; scope: { customer_id: string } } };
    }>('SELECT retrieval_plan FROM customer_attribute_runs WHERE id=$1', [result.id])
  ).rows[0];
  expect(stored.retrieval_plan.source.vector).toHaveLength(384);
  expect(stored.retrieval_plan.source.scope.customer_id).toBe(customer);
  expect(result).not.toHaveProperty('retrieval_plan');
  const value = await scope((ctx) => applyRun(ctx, customer, result.id));
  expect(value).toMatchObject({ value: '儿童芭蕾练功服', origin: 'ai' });
  expect(value.sources[0].quote).toBe(original);
});
it('invalidates a pending result and cascades its raw chunks when underlying original Records are removed', async () => {
  const f = await fixture();
  const result = await generate(db, actor, workspace, customer, f.request, options);
  expect(
    (await db.query('SELECT id FROM source_chunks WHERE record_id=$1', [f.record.id])).rows.length,
  ).toBeGreaterThan(0);
  // Owner-level deletion models loss of a source; the public Record API does not
  // offer deletion and no artificial application write endpoint is introduced.
  await db.query('DELETE FROM customer_records WHERE workspace_id=$1 AND customer_id=$2', [
    workspace,
    customer,
  ]);
  expect(
    (await db.query('SELECT id FROM source_chunks WHERE customer_id=$1', [customer])).rows,
  ).toHaveLength(0);
  await expect(scope((ctx) => applyRun(ctx, customer, result.id))).rejects.toMatchObject({
    status: 409,
  });
});
it('refuses to persist a generated result after customer edit permission is revoked during the model call', async () => {
  const f = await fixture();
  const before = (
    await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM customer_attribute_runs WHERE actor_id=$1',
      [editor],
    )
  ).rows[0].n;
  const racing: AttributeModelOptions = {
    ...options,
    transport: {
      async generate(input) {
        await scope((ctx) =>
          ctx.tx.query(
            'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
            [workspace, customer, editor],
          ),
        );
        return options.transport!.generate(input);
      },
    },
  };
  await expect(generate(db, editor, workspace, customer, f.request, racing)).rejects.toMatchObject({
    status: 404,
  });
  expect(
    (
      await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM customer_attribute_runs WHERE actor_id=$1',
        [editor],
      )
    ).rows[0].n,
  ).toBe(before);
});
