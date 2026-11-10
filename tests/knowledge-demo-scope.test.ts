import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { scoped } from '../server/security.js';
import { insert } from '../server/service.js';
import { syncKnowledgeOnce, type KnowledgeTransport } from '../server/knowledge.js';

let db: Database;
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
});
afterAll(async () => {
  await db?.close();
});

it('a scoped sync only claims the selected workspace/customer and preserves older pending jobs', async () => {
  const makeWorkspace = () =>
    createWorkspace(db, {
      name: 'Synthetic scope test',
      email: `${randomUUID()}@example.invalid`,
      displayName: 'Test',
      password: 'synthetic-test-password',
    });
  const first = await makeWorkspace(),
    other = await makeWorkspace();
  const customer = async (seed: typeof first, name: string) =>
    String(
      (
        await scoped(db, seed.actorId, seed.workspaceId, (ctx) =>
          insert(ctx, 'customers', { name, type: 'group', source: 'other' }),
        )
      ).id,
    );
  const oldest = await customer(first, 'Keep this pending');
  const outside = await customer(other, 'Other workspace stays pending');
  const chosen = await customer(first, 'Sync this one');
  const before = (
    await db.query(
      'SELECT to_jsonb(k) AS row FROM knowledge_sync k WHERE customer_id IN ($1,$2) ORDER BY customer_id',
      [oldest, outside],
    )
  ).rows;
  const calls: string[] = [];
  const transport: KnowledgeTransport = {
    async sync(snapshot) {
      calls.push(snapshot.customer_id);
      return [];
    },
    async discard() {},
  };
  expect(
    await syncKnowledgeOnce(db, transport, {
      workspace_id: first.workspaceId,
      customer_id: outside,
    }),
  ).toBe(false);
  expect(calls).toEqual([]);
  expect(
    await syncKnowledgeOnce(db, transport, {
      workspace_id: first.workspaceId,
      customer_id: chosen,
    }),
  ).toBe(true);
  expect(calls).toEqual([chosen]);
  expect(
    (
      await db.query(
        'SELECT to_jsonb(k) AS row FROM knowledge_sync k WHERE customer_id IN ($1,$2) ORDER BY customer_id',
        [oldest, outside],
      )
    ).rows,
  ).toEqual(before);
  expect(
    (
      await db.query<{ state: string }>(
        'SELECT state FROM knowledge_sync WHERE workspace_id=$1 AND customer_id=$2',
        [first.workspaceId, chosen],
      )
    ).rows[0].state,
  ).toBe('ready');
  await expect(
    syncKnowledgeOnce(db, transport, { workspace_id: 'invalid', customer_id: chosen }),
  ).rejects.toThrow();
});
