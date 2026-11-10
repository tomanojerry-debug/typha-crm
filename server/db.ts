import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import pg from 'pg';
import { mkdir, readFile, readdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface Sql {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
}
export interface Database extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDatabase(
  options: { url?: string; dataDir?: string } = {},
): Promise<Database> {
  if (options.url) {
    const pool = new pg.Pool({ connectionString: options.url });
    const wrap = (client: pg.Pool | pg.PoolClient): Sql => ({
      query: async <T>(sql: string, params?: unknown[]) => ({
        rows: (await client.query(sql, params)).rows as T[],
      }),
      exec: (sql) => client.query(sql),
    });
    return {
      ...wrap(pool),
      async transaction(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const value = await fn(wrap(client));
          await client.query('COMMIT');
          return value;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  // A PGlite directory must only be opened by one process. Never silently
  // remove a lock left by a crash; the operator must verify the PID first.
  let lockPath: string | undefined;
  if (options.dataDir) {
    const directory = resolve(options.dataDir);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // initdb requires a completely empty new data directory.
    lockPath = `${directory}.light-crm.lock`;
    const lock = await open(lockPath, 'wx', 0o600).catch(() => {
      throw new Error(
        `本地数据库正在使用或遗留锁未清理：${lockPath}。请先停止其他应用进程并检查锁内 PID。`,
      );
    });
    await lock.writeFile(String(process.pid));
    await lock.close();
  }
  try {
    const db = await PGlite.create({ dataDir: options.dataDir, extensions: { vector } });
    return {
      query: (sql, params) => db.query(sql, params),
      exec: (sql) => db.exec(sql),
      transaction: (fn) => db.transaction((tx) => fn(tx)),
      async close() {
        await db.close();
        if (lockPath) await unlink(lockPath);
      },
    };
  } catch (error) {
    if (lockPath) await unlink(lockPath);
    throw error;
  }
}

export async function migrate(db: Database) {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const directory = new URL('./migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
    const existing = await db.query('SELECT name FROM schema_migrations WHERE name = $1', [name]);
    if (existing.rows.length) continue;
    await db.transaction(async (tx) => {
      await tx.exec(await readFile(new URL(name, directory), 'utf8'));
      await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    });
  }
}
