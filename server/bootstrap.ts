import { randomUUID } from 'node:crypto';
import type { Database } from './db.js';
import { hashPassword } from './security.js';

export async function createWorkspace(
  db: Database,
  input: { name: string; email: string; displayName: string; password: string },
) {
  const workspaceId = randomUUID(),
    actorId = randomUUID();
  const passwordHash = await hashPassword(input.password);
  await db.transaction(async (tx) => {
    await tx.query(
      'INSERT INTO users(id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)',
      [actorId, input.email.toLowerCase(), input.displayName, passwordHash],
    );
    await tx.query('INSERT INTO workspaces(id, name) VALUES ($1, $2)', [workspaceId, input.name]);
    await tx.query(
      "INSERT INTO memberships(workspace_id, actor_id, role) VALUES ($1, $2, 'admin')",
      [workspaceId, actorId],
    );
  });
  return { workspaceId, actorId };
}
