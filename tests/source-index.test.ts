import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { scoped, type Context } from '../server/security.js';
import { insert, update } from '../server/service.js';
import {
  ensureSourceIndex,
  prepareSourceSearch,
  executeSourceSearch,
  validateSourceSearch,
  sourceMaterials,
  syncSourceIndexOnce,
} from '../server/source-index.js';
import { sourceEmbeddingModel, type LocalEmbeddingTransport } from '../shared/source-search.js';

let db: Database, w: string, actor: string, c: string, b: string, p: string, otherProject: string;
let calls: string[][];
const vector = (target = false) =>
  Array.from({ length: 384 }, (_, i) => (i === (target ? 0 : 1) ? 1 : 0));
const embedding: LocalEmbeddingTransport = {
  async embed({ texts }) {
    calls.push(texts);
    return {
      model: sourceEmbeddingModel,
      dimensions: 384,
      vectors: texts.map((t) => vector(t.includes('芭蕾裙') || t.includes('主打服装'))),
    };
  },
};
const run = <T>(fn: (ctx: Context) => Promise<T>) => scoped(db, actor, w, fn);
async function record(body: string, projectId: string | null = p, customerId = c) {
  return String(
    (
      await run((ctx) =>
        insert(ctx, 'customer_records', {
          customer_id: customerId,
          project_id: projectId,
          body,
          kind: 'customer_quote',
          created_by: actor,
        }),
      )
    ).id,
  );
}
async function search(filter = {}) {
  const prepared = await run((ctx) => prepareSourceSearch(ctx, c, '公司主打服装', filter));
  const plan = await executeSourceSearch(prepared, embedding);
  return run((ctx) => validateSourceSearch(ctx, plan));
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const fixture = await createWorkspace(db, {
    name: 'Source vectors',
    email: 'source-vectors@example.invalid',
    displayName: 'Admin',
    password: 'fixture-password-only',
  });
  w = fixture.workspaceId;
  actor = fixture.actorId;
}, 30000);
afterAll(() => db.close());
beforeEach(async () => {
  calls = [];
  await run(async (ctx) => {
    c = String(
      (await insert(ctx, 'customers', { name: '虚构舞服公司', type: 'group', source: 'other' })).id,
    );
    b = String(
      (await insert(ctx, 'customers', { name: '另一个客户', type: 'group', source: 'other' })).id,
    );
    p = String(
      (await insert(ctx, 'projects', { customer_id: c, name: '当前项目', type: 'purchase' })).id,
    );
    otherProject = String(
      (await insert(ctx, 'projects', { customer_id: c, name: '同客户其他项目', type: 'sample' }))
        .id,
    );
  });
});

it('recalls unextracted old raw text beyond 200 records, recent windows and the first 6000 characters', async () => {
  const old = await record('资料说明。'.repeat(1300) + '我们主要生产儿童芭蕾裙，使用柔软里布。');
  await run(async (ctx) => {
    for (let i = 0; i < 205; i++)
      await insert(ctx, 'customer_records', {
        customer_id: c,
        project_id: p,
        body: `无关噪声：第${i}次物流查询。`,
        kind: 'customer_quote',
        created_by: actor,
      });
  });
  await ensureSourceIndex(db, actor, w, c, embedding);
  expect((await run((ctx) => sourceMaterials(ctx, c))).length).toBe(206);
  const result = await search();
  expect(result.record_ids).toEqual([old]);
  expect(result.sources[0].id).toBe(`record::${old}`);
  expect(result.sources[0].body).toContain('我们主要生产儿童芭蕾裙');
  expect(result.sources[0].body).toContain('不是独立证据');
}, 30000);

it('reuses ready vectors and only embeds new chunks after a source change', async () => {
  await record('我们主打芭蕾裙。');
  await ensureSourceIndex(db, actor, w, c, embedding);
  const first = calls.flat().length;
  await ensureSourceIndex(db, actor, w, c, embedding);
  expect(calls.flat().length).toBe(first);
  await record('新消息：这次不涉及衣服。');
  await ensureSourceIndex(db, actor, w, c, embedding);
  expect(calls.flat().length).toBe(first + 1);
  expect(
    (await run((ctx) => ctx.tx.query('SELECT id FROM source_chunks WHERE customer_id=$1', [c])))
      .rows,
  ).toHaveLength(2);
});

it('filters project and customer inside SQL before top-k', async () => {
  const target = await record('本项目需要芭蕾裙。');
  for (let i = 0; i < 20; i++) await record(`其他项目芭蕾裙${i}`, otherProject);
  await record('另客户机密芭蕾裙', null, b);
  await ensureSourceIndex(db, actor, w, c, embedding);
  await ensureSourceIndex(db, actor, w, b, embedding);
  const result = await search({ project_id: p });
  expect(result.record_ids).toEqual([target]);
  expect(result.sources[0].body).not.toContain('其他项目');
  expect(result.sources[0].body).not.toContain('机密');
});

it('returns 409 after source mutation, archival, scope substitution or revoked permissions', async () => {
  await record('主要生产芭蕾裙。');
  await ensureSourceIndex(db, actor, w, c, embedding);
  const plan = await executeSourceSearch(
    await run((ctx) => prepareSourceSearch(ctx, c, '公司主打服装')),
    embedding,
  );
  await expect(
    run((ctx) =>
      validateSourceSearch(ctx, { ...plan, scope: { ...plan.scope, workspace_id: randomUUID() } }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await record('新的客户说法。');
  await expect(run((ctx) => validateSourceSearch(ctx, plan))).rejects.toMatchObject({
    status: 409,
  });
  await ensureSourceIndex(db, actor, w, c, embedding);
  const next = await executeSourceSearch(
    await run((ctx) => prepareSourceSearch(ctx, c, '公司主打服装')),
    embedding,
  );
  await run((ctx) => update(ctx, 'customers', c, { version: 1, archived: true }));
  await expect(run((ctx) => validateSourceSearch(ctx, next))).rejects.toMatchObject({
    status: 409,
  });
});

it('rejects a stale publication if text changes during embedding and retries safely', async () => {
  await record('我们主要生产芭蕾裙。');
  let mutated = false;
  const racing: LocalEmbeddingTransport = {
    async embed(input) {
      if (!mutated) {
        mutated = true;
        await record('索引过程中新增消息。');
      }
      return embedding.embed(input);
    },
  };
  await expect(ensureSourceIndex(db, actor, w, c, racing)).rejects.toMatchObject({ status: 409 });
  expect(
    (await db.query('SELECT id FROM source_chunks WHERE customer_id=$1', [c])).rows,
  ).toHaveLength(0);
  await ensureSourceIndex(db, actor, w, c, embedding);
  expect((await search()).sources[0].body).toContain('芭蕾裙');
});

it('keeps WeChat speaker and Record provenance, and applies a person scope before retrieval', async () => {
  const one = randomUUID(),
    two = randomUUID();
  await run(async (ctx) => {
    for (const [id, name] of [
      [one, '甲'],
      [two, '乙'],
    ])
      await ctx.tx.query(
        'INSERT INTO people(workspace_id,customer_id,id,name) VALUES($1,$2,$3,$4)',
        [w, c, id, name],
      );
  });
  const r1 = await record('微信归档摘要。'),
    r2 = await record('第二段微信归档摘要。');
  await run(async (ctx) => {
    for (const [rid, pid, speaker] of [
      [r1, one, '甲'],
      [r2, two, '乙'],
    ])
      await ctx.tx.query(
        `INSERT INTO knowledge_wechat_evidence(workspace_id,customer_id,id,source_key,record_id,project_id,person_id,occurred_at,speaker,body,created_by,from_me)
      VALUES($1,$2,$3::uuid,$3::text,$4,$5,$6,now(),$7,'我们主要生产芭蕾裙。',$8,false)`,
        [w, c, randomUUID(), rid, p, pid, speaker, actor],
      );
  });
  await ensureSourceIndex(db, actor, w, c, embedding);
  expect(await run((ctx) => sourceMaterials(ctx, c))).toHaveLength(2);
  const result = await search({ person_id: one });
  expect(result.record_ids).toEqual([r1]);
  expect(result.sources[0].body).toContain('"speaker":"甲"');
});

it('fails explicitly without a model or with invalid embeddings, and bounds inaccessible worker retries', async () => {
  await record('我们主要生产芭蕾裙。');
  await expect(ensureSourceIndex(db, actor, w, c)).rejects.toMatchObject({ status: 503 });
  await expect(
    ensureSourceIndex(db, actor, w, c, {
      async embed() {
        return { model: sourceEmbeddingModel, dimensions: 384, vectors: [[1]] };
      },
    }),
  ).rejects.toThrow('Invalid local embedding vectors');
  await db.query(
    "UPDATE source_index_sync SET attempts=0,retry_at=NULL,state='pending' WHERE workspace_id=$1 AND customer_id=$2",
    [w, c],
  );
  await run((ctx) => update(ctx, 'customers', c, { version: 1, archived: true }));
  await db.query(
    "UPDATE source_index_sync SET retry_at=now()+interval '1 day' WHERE customer_id<>$1",
    [c],
  );
  expect(await syncSourceIndexOnce(db, embedding)).toBe(true);
  const state = (
    await db.query<{ attempts: number; state: string }>(
      'SELECT attempts,state FROM source_index_sync WHERE customer_id=$1',
      [c],
    )
  ).rows[0];
  expect(state).toMatchObject({ attempts: 1, state: 'failed' });
});

it('backfills legacy email Records independently and immediately hides excluded source chunks under RLS', async () => {
  const account = randomUUID(),
    mail = randomUUID();
  await db.query(
    `INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by,enabled) VALUES($1,$2,'legacy@example.invalid','synthetic-disabled-credential',$3,false)`,
    [w, account, actor],
  );
  await run((ctx) =>
    ctx.tx.query(
      `INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,project_id,fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason)
    VALUES($1,$2::uuid,$3,'legacy@example.invalid',$4,$5,$2::text,'虚构公司产品介绍','[{"name":"虚构客户","address":"customer@example.invalid"}]','[]','[]','["customer@example.invalid"]',now(),'inbound','我们主要生产儿童芭蕾裙。','synthetic fixture')`,
      [w, mail, account, c, p],
    ),
  );
  // Remove only this in-memory fixture's auto-created Record to represent mail
  // imported before the provenance migration existed.
  await db.query('DELETE FROM customer_records WHERE source_mail_id=$1', [mail]);
  expect(
    (await db.query('SELECT id FROM customer_records WHERE source_mail_id=$1', [mail])).rows,
  ).toHaveLength(0);
  await ensureSourceIndex(db, actor, w, c, embedding);
  const records = (
    await db.query<{ id: string }>('SELECT id FROM customer_records WHERE source_mail_id=$1', [
      mail,
    ])
  ).rows;
  expect(records).toHaveLength(1);
  expect((await search()).record_ids).toEqual([records[0].id]);
  await run((ctx) =>
    ctx.tx.query(
      `INSERT INTO mail_exclusions(workspace_id,rules) VALUES($1,'["customer@example.invalid"]') ON CONFLICT(workspace_id) DO UPDATE SET rules=EXCLUDED.rules`,
      [w],
    ),
  );
  expect(
    (await run((ctx) => ctx.tx.query('SELECT body FROM source_chunks WHERE customer_id=$1', [c])))
      .rows,
  ).toHaveLength(0);
  await ensureSourceIndex(db, actor, w, c, embedding);
  expect(
    (await db.query('SELECT id FROM source_chunks WHERE customer_id=$1', [c])).rows,
  ).toHaveLength(0);
  expect((await search()).sources).toHaveLength(0);
});

it('does not expose another customer chunks and invalidates a search after a member loses access', async () => {
  await record('本客户主要生产芭蕾裙。');
  await record('其他客户机密芭蕾裙。', null, b);
  await ensureSourceIndex(db, actor, w, c, embedding);
  await ensureSourceIndex(db, actor, w, b, embedding);
  const member = await createWorkspace(db, {
    name: 'Other workspace',
    email: `source-member-${randomUUID()}@example.invalid`,
    displayName: 'Member',
    password: 'fixture-password-only',
  });
  await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
    w,
    member.actorId,
  ]);
  await run((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'viewer')",
      [w, c, member.actorId],
    ),
  );
  const asMember = <T>(fn: (ctx: Context) => Promise<T>) => scoped(db, member.actorId, w, fn);
  const visible = (
    await asMember((ctx) =>
      ctx.tx.query<{ customer_id: string }>('SELECT customer_id FROM source_chunks'),
    )
  ).rows;
  expect(visible.length).toBeGreaterThan(0);
  expect(visible.every((row) => row.customer_id === c)).toBe(true);
  const plan = await executeSourceSearch(
    await asMember((ctx) => prepareSourceSearch(ctx, c, '公司主打服装')),
    embedding,
  );
  await run((ctx) =>
    ctx.tx.query(
      'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
      [w, c, member.actorId],
    ),
  );
  await expect(asMember((ctx) => validateSourceSearch(ctx, plan))).rejects.toMatchObject({
    status: 409,
  });
});

it('preserves initial denials but returns 409 if an editor becomes a viewer during indexing', async () => {
  await record('本客户主要生产芭蕾裙。');
  const member = await createWorkspace(db, {
    name: 'Index race',
    email: `source-index-race-${randomUUID()}@example.invalid`,
    displayName: 'Member',
    password: 'fixture-password-only',
  });
  await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
    w,
    member.actorId,
  ]);
  await expect(ensureSourceIndex(db, member.actorId, w, c, embedding)).rejects.toMatchObject({
    status: 404,
  });
  await run((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor')",
      [w, c, member.actorId],
    ),
  );
  const racing: LocalEmbeddingTransport = {
    async embed(input) {
      await run((ctx) =>
        ctx.tx.query(
          "UPDATE customer_access SET access='viewer' WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3",
          [w, c, member.actorId],
        ),
      );
      return embedding.embed(input);
    },
  };
  await expect(ensureSourceIndex(db, member.actorId, w, c, racing)).rejects.toMatchObject({
    status: 409,
  });
  expect(
    (await db.query('SELECT id FROM source_chunks WHERE customer_id=$1', [c])).rows,
  ).toHaveLength(0);
  await expect(ensureSourceIndex(db, member.actorId, w, c, embedding)).rejects.toMatchObject({
    status: 403,
  });
});

it('keeps emoji whole at both UTF-16 chunk boundaries and preserves original offsets', async () => {
  const body = '文'.repeat(191) + '🩰' + '字'.repeat(62) + '👗' + '尾'.repeat(300);
  const id = await record(body);
  await ensureSourceIndex(db, actor, w, c, embedding);
  const chunks = (
    await run((ctx) =>
      ctx.tx.query<{ body: string; start_offset: number; end_offset: number }>(
        'SELECT body,start_offset,end_offset FROM source_chunks WHERE workspace_id=$1 AND customer_id=$2 AND record_id=$3 ORDER BY start_offset',
        [w, c, id],
      ),
    )
  ).rows;
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks) {
    expect(Buffer.from(chunk.body, 'utf8').toString('utf8')).toBe(chunk.body);
    expect(chunk.body).toBe(body.slice(chunk.start_offset, chunk.end_offset));
  }
  expect(chunks.some((chunk) => chunk.body.includes('🩰'))).toBe(true);
  expect(chunks.some((chunk) => chunk.body.includes('👗'))).toBe(true);
});
