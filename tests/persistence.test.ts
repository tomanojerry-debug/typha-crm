import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrate, openDatabase } from '../server/db.js';
import { createWorkspace, seedDemo } from '../server/bootstrap.js';
import { scoped } from '../server/security.js';
import { defaultView } from '../shared/views.js';

it('persists a workspace across restarts and rejects a second process opening its local database', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'light-crm-test-'));
  const dataDir = join(temporary, 'postgres');
  try {
    const db = await openDatabase({ dataDir });
    let space: { workspaceId: string; actorId: string };
    try {
      await migrate(db);
      space = await createWorkspace(db, {
        name: 'Persistence test',
        email: 'test@example.com',
        displayName: 'Test',
        password: 'test-only-password-14356',
      });
      await seedDemo(db, space.workspaceId, space.actorId);
      await scoped(db, space.actorId, space.workspaceId, async ({ tx }) => {
        const customer = (await tx.query<{ id: string }>('SELECT id FROM customers LIMIT 1'))
          .rows[0];
        const listId = randomUUID();
        await tx.query(
          "INSERT INTO record_lists(workspace_id,actor_id,id,object,name) VALUES($1,$2,$3,'customers','Persistent list')",
          [space.workspaceId, space.actorId, listId],
        );
        await tx.query(
          "INSERT INTO list_entries(workspace_id,actor_id,list_id,object,customer_id) VALUES($1,$2,$3,'customers',$4)",
          [space.workspaceId, space.actorId, listId, customer.id],
        );
        await tx.query(
          `INSERT INTO saved_views (workspace_id, actor_id, id, object, name, config)
           VALUES ($1, $2, $3, 'projects', 'Saved across restart', $4)`,
          [
            space.workspaceId,
            space.actorId,
            randomUUID(),
            JSON.stringify({ ...defaultView('projects'), owner: 'me', layout: 'board' }),
          ],
        );
      });
      await expect(openDatabase({ dataDir })).rejects.toThrow('本地数据库正在使用');
    } finally {
      await db.close();
    }
    const reopened = await openDatabase({ dataDir });
    try {
      await migrate(reopened);
      await scoped(reopened, space.actorId, space.workspaceId, async ({ tx }) => {
        const result = await tx.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM customers',
        );
        expect(result.rows[0].count).toBe(5);
        expect(
          (await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM people')).rows[0]
            .count,
        ).toBe(5);
        expect(
          (await tx.query<{ name: string }>('SELECT name FROM record_lists')).rows[0].name,
        ).toBe('Persistent list');
        expect(
          (await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM list_entries'))
            .rows[0].count,
        ).toBe(1);
        const saved = await tx.query<{ name: string; config: unknown; version: number }>(
          'SELECT name, config, version FROM saved_views',
        );
        expect(saved.rows).toEqual([
          {
            name: 'Saved across restart',
            config: { ...defaultView('projects'), owner: 'me', layout: 'board' },
            version: 1,
          },
        ]);
      });
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 30000);
