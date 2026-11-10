import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { scoped, type Context } from '../server/security.js';
import * as service from '../server/service.js';
import * as docs from '../server/documents.js';
import { sourceMaterials } from '../server/source-index.js';
import { documentKnowledgeSources } from '../server/document-sources.js';
import { createApp } from '../server/app.js';
import type { DocumentDetail } from '../shared/documents.js';

let db: Database,
  w: string,
  owner: string,
  editor: string,
  viewer: string,
  otherActor: string,
  otherWorkspace: string,
  a: string,
  b: string,
  p: string,
  wrongProject: string;
const mockParser: NonNullable<docs.DocumentOptions['parser']> = async () => ({
  format: 'pdf',
  mime: 'application/pdf',
  size: 100,
  sections: [
    { label: '第 1 页', text: '合成星澜公司的主营业务为少儿舞蹈课程，行业排名没有依据。' },
  ],
  warnings: ['图片未解析'],
});
const uploadInput = (
  customer_id: string | null = a,
  project_id: string | null = null,
  patch = {},
) => ({
  name: '合成公司介绍.pdf',
  content_base64: Buffer.from(`%PDF-1.7\nfixture ${randomUUID()}`).toString('base64'),
  request_id: randomUUID(),
  customer_id,
  project_id,
  ...patch,
});
const run = <T>(fn: (ctx: Context) => Promise<T>, actor = owner, workspace = w) =>
  scoped(db, actor, workspace, fn);
async function processed(
  customerId: string | null = a,
  projectId: string | null = null,
  actor = owner,
) {
  const d = await run((ctx) => docs.uploadDocument(ctx, uploadInput(customerId, projectId)), actor);
  await docs.processDocument(db, actor, w, d.id, { parser: mockParser });
  return run((ctx) => docs.documentDetail(ctx, d.id), actor);
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const first = await createWorkspace(db, {
    name: '文档合成验收',
    email: 'document-owner@example.com',
    displayName: 'Owner',
    password: 'document-fixture-password',
  });
  w = first.workspaceId;
  owner = first.actorId;
  const second = await createWorkspace(db, {
    name: '第二空间',
    email: 'document-other@example.com',
    displayName: 'Other',
    password: 'document-fixture-password',
  });
  otherWorkspace = second.workspaceId;
  otherActor = second.actorId;
  editor = randomUUID();
  viewer = randomUUID();
  for (const [id, email] of [
    [editor, 'document-editor@example.com'],
    [viewer, 'document-viewer@example.com'],
  ]) {
    await db.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      id,
      email,
      'Member',
      'unused',
    ]);
    await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
      w,
      id,
    ]);
  }
  await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'admin')", [
    w,
    otherActor,
  ]);
  a = (
    await run((ctx) =>
      service.insert(ctx, 'customers', { name: '星澜（合成）', type: 'group', source: 'other' }),
    )
  ).id as string;
  b = (
    await run((ctx) =>
      service.insert(ctx, 'customers', {
        name: '无权公司（合成）',
        type: 'group',
        source: 'other',
      }),
    )
  ).id as string;
  p = (
    await run((ctx) =>
      service.insert(ctx, 'projects', { customer_id: a, name: '星澜采购', type: 'purchase' }),
    )
  ).id as string;
  wrongProject = (
    await run((ctx) =>
      service.insert(ctx, 'projects', { customer_id: b, name: '其他项目', type: 'sample' }),
    )
  ).id as string;
  await run((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor'),($1,$2,$4,'viewer')",
      [w, a, editor, viewer],
    ),
  );
}, 30000);
afterAll(() => db?.close());

/** Deterministically exercise the SQL zero-row fence without touching real data. */
function zeroRowsFor(pattern: RegExp): Database {
  return {
    ...db,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          ...tx,
          query: async <T>(sql: string, params?: unknown[]) =>
            pattern.test(sql) ? { rows: [] as T[] } : tx.query<T>(sql, params),
        }),
      ),
  };
}
async function documentRecordCount() {
  return Number(
    (
      await db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM customer_records WHERE workspace_id=$1 AND source_kind='document'",
        [w],
      )
    ).rows[0].count,
  );
}

it('keeps unknown originals and extracted text private even from another workspace admin', async () => {
  const d = await processed(null);
  expect(d.status).toBe('pending_association');
  expect(d.record_id).toBeNull();
  await expect(run((ctx) => docs.documentDetail(ctx, d.id), otherActor)).rejects.toThrow('无权');
  await expect(run((ctx) => docs.originalDocument(ctx, d.id), otherActor)).rejects.toThrow('无权');
  expect(
    (await run((ctx) => docs.listDocuments(ctx, { view: 'pending' }), otherActor)).files.some(
      (f) => f.id === d.id,
    ),
  ).toBe(false);
  expect(
    (
      await run((ctx) =>
        ctx.tx.query("SELECT id FROM customer_records WHERE source_kind='document'"),
      )
    ).rows,
  ).toHaveLength(0);
});
it('associates a private parsed file only after authorization and publishes one canonical Record', async () => {
  const d = await processed(null);
  const saved = await run((ctx) =>
    docs.associateDocument(ctx, d.id, { customer_id: a, version: d.version }),
  );
  expect(saved.status).toBe('ready');
  expect(saved.record_id).toBeTruthy();
  expect(saved.project_id).toBeNull();
  const original = await run((ctx) => docs.originalDocument(ctx, d.id));
  expect(Buffer.from(original.content_base64, 'base64').toString()).toContain('%PDF');
  const sources = await run((ctx) => sourceMaterials(ctx, a));
  expect(sources.find((s) => s.record_id === saved.record_id)?.body).toContain('第 1 页');
  expect(sources.filter((s) => s.record_id === saved.record_id)).toHaveLength(1);
  await docs.processDocument(db, owner, w, d.id, { parser: mockParser });
  expect((await run((ctx) => docs.documentDetail(ctx, d.id))).record_id).toBe(saved.record_id);
  await expect(
    run((ctx) => docs.associateDocument(ctx, d.id, { customer_id: b, version: saved.version })),
  ).rejects.toThrow('不能自动转移');
});
it('validates workspace, customer access, viewer writes and joint project ownership', async () => {
  await expect(
    run((ctx) => docs.uploadDocument(ctx, uploadInput(a, wrongProject))),
  ).rejects.toThrow('不属于');
  await expect(run((ctx) => docs.uploadDocument(ctx, uploadInput(null, p)))).rejects.toThrow(
    '所属公司',
  );
  await expect(run((ctx) => docs.uploadDocument(ctx, uploadInput(b)), editor)).rejects.toThrow(
    '无权',
  );
  await expect(run((ctx) => docs.uploadDocument(ctx, uploadInput(a)), viewer)).rejects.toThrow(
    '只读',
  );
  const d = await processed(a, p);
  await expect(
    run((ctx) => docs.documentDetail(ctx, d.id), otherActor, otherWorkspace),
  ).rejects.toThrow('无权');
  expect((await run((ctx) => docs.documentDetail(ctx, d.id), viewer)).can_edit).toBe(false);
  expect(
    (await run((ctx) => docs.listDocuments(ctx, { customer_id: a, project_id: p }))).files.some(
      (f) => f.id === d.id,
    ),
  ).toBe(true);
  await expect(run((ctx) => docs.listDocuments(ctx, { project_id: p }))).rejects.toThrow(
    '明确公司',
  );
});
it('makes requests and same-scope duplicate content idempotent without cross-customer deduplication', async () => {
  const input = uploadInput(a);
  const first = await run((ctx) => docs.uploadDocument(ctx, input));
  expect((await run((ctx) => docs.uploadDocument(ctx, input))).id).toBe(first.id);
  expect(
    (await run((ctx) => docs.uploadDocument(ctx, { ...input, request_id: randomUUID() }))).id,
  ).toBe(first.id);
  await expect(
    run((ctx) => docs.uploadDocument(ctx, { ...input, name: '其他.pdf' })),
  ).rejects.toThrow('不同文件');
  const second = await run((ctx) =>
    docs.uploadDocument(ctx, { ...input, request_id: randomUUID(), customer_id: b }),
  );
  expect(second.id).not.toBe(first.id);
});
it('persists failures and originals, then retries from the same file without duplicating Record', async () => {
  const d = await run((ctx) => docs.uploadDocument(ctx, uploadInput()));
  await docs.processDocument(db, owner, w, d.id, {
    parser: async () => {
      throw new Error('未提取到文字，请使用文字版PDF');
    },
  });
  const failed = await run((ctx) => docs.documentDetail(ctx, d.id));
  expect(failed).toMatchObject({ status: 'failed', record_id: null });
  expect(failed.error).toContain('文字');
  expect((await run((ctx) => docs.originalDocument(ctx, d.id))).content_base64).toBeTruthy();
  expect(
    (await run((ctx) => docs.listDocuments(ctx, { view: 'failed' }))).files.some(
      (f) => f.id === d.id,
    ),
  ).toBe(true);
  await expect(run((ctx) => docs.retryDocument(ctx, d.id, { version: d.version }))).rejects.toThrow(
    '状态已变化',
  );
  await run((ctx) => docs.retryDocument(ctx, d.id, { version: failed.version }));
  await docs.processDocument(db, owner, w, d.id, { parser: mockParser });
  const ready = await run((ctx) => docs.documentDetail(ctx, d.id));
  expect(ready.status).toBe('ready');
  expect(ready.record_id).toBeTruthy();
  await expect(
    run((ctx) => docs.retryDocument(ctx, d.id, { version: ready.version })),
  ).rejects.toThrow('无需重试');
});
it('rejects spoofed bytes, unsupported formats, malformed Base64 and empty data before storage', async () => {
  for (const patch of [
    { name: 'old.doc' },
    { name: 'fake.docx' },
    { content_base64: '%%%%' },
    { content_base64: '' },
    { name: '../escape.pdf' },
  ])
    await expect(
      run((ctx) => docs.uploadDocument(ctx, uploadInput(a, null, patch))),
    ).rejects.toThrow();
});
it('cannot publish parsed text if permission is revoked during the parser call', async () => {
  const d = await run((ctx) => docs.uploadDocument(ctx, uploadInput()), editor);
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((r) => {
    started = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const job = docs.processDocument(db, editor, w, d.id, {
    parser: async () => {
      started();
      await gate;
      return mockParser({ name: 'x', content_base64: '' });
    },
  });
  await entered;
  await run((ctx) =>
    ctx.tx.query(
      'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
      [w, a, editor],
    ),
  );
  release();
  await job;
  expect(
    (
      await db.query<{ record_id: string | null }>(
        'SELECT record_id FROM documents WHERE workspace_id=$1 AND id=$2',
        [w, d.id],
      )
    ).rows[0].record_id,
  ).toBeNull();
  await expect(run((ctx) => docs.documentDetail(ctx, d.id), editor)).rejects.toThrow('无权');
  await run((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor')",
      [w, a, editor],
    ),
  );
});
it('fences concurrent workers and never republishes the same completed document', async () => {
  const d = await run((ctx) => docs.uploadDocument(ctx, uploadInput()));
  let calls = 0;
  const parser: typeof mockParser = async (input) => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return mockParser(input);
  };
  await Promise.all([
    docs.processDocument(db, owner, w, d.id, { parser }),
    docs.processDocument(db, owner, w, d.id, { parser }),
  ]);
  expect(calls).toBe(1);
  const ready = await run((ctx) => docs.documentDetail(ctx, d.id));
  expect(ready.record_id).toBeTruthy();
});
it('rolls back a new Record when a concurrent association makes the versioned update affect no rows', async () => {
  const d = await processed(null),
    before = await documentRecordCount();
  const fenced = zeroRowsFor(/^UPDATE documents SET customer_id=/);
  await expect(
    scoped(fenced, owner, w, (ctx) =>
      docs.associateDocument(ctx, d.id, {
        customer_id: a,
        version: d.version,
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(await documentRecordCount()).toBe(before);
  expect(await run((ctx) => docs.documentDetail(ctx, d.id))).toMatchObject({
    status: 'pending_association',
    customer_id: null,
    record_id: null,
  });
});
it('does not publish or fail a task when its completion update loses the version fence', async () => {
  const d = await run((ctx) => docs.uploadDocument(ctx, uploadInput()));
  const before = await documentRecordCount();
  await docs.processDocument(zeroRowsFor(/^UPDATE documents SET sections=/), owner, w, d.id, {
    parser: mockParser,
  });
  expect(await documentRecordCount()).toBe(before);
  expect(await run((ctx) => docs.documentDetail(ctx, d.id))).toMatchObject({
    status: 'processing',
    record_id: null,
    error: null,
  });
});
it('rejects a stale retry update and preserves the current task actor until a successful retry', async () => {
  const d = await run((ctx) => docs.uploadDocument(ctx, uploadInput()));
  await docs.processDocument(db, owner, w, d.id, {
    parser: async () => {
      throw new Error('合成解析失败');
    },
  });
  const failed = await run((ctx) => docs.documentDetail(ctx, d.id));
  await expect(
    scoped(zeroRowsFor(/^UPDATE documents SET status='queued'/), editor, w, (ctx) =>
      docs.retryDocument(ctx, d.id, { version: failed.version }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (
      await db.query<{ task_actor_id: string }>(
        'SELECT task_actor_id FROM documents WHERE workspace_id=$1 AND id=$2',
        [w, d.id],
      )
    ).rows[0].task_actor_id,
  ).toBe(owner);
  const queued = await run(
    (ctx) => docs.retryDocument(ctx, d.id, { version: failed.version }),
    editor,
  );
  expect(queued.status).toBe('queued');
  expect(
    (
      await db.query<{ task_actor_id: string }>(
        'SELECT task_actor_id FROM documents WHERE workspace_id=$1 AND id=$2',
        [w, d.id],
      )
    ).rows[0].task_actor_id,
  ).toBe(editor);
});
it('leaves the new worker result intact when an expired old lease returns later', async () => {
  const d = await run((ctx) => docs.uploadDocument(ctx, uploadInput()));
  let start!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const old = docs.processDocument(db, owner, w, d.id, {
    parser: async (input) => {
      start();
      await blocked;
      return mockParser(input);
    },
  });
  await started;
  await run((ctx) =>
    ctx.tx.query(
      "UPDATE documents SET lease_until=now()-interval '3 minutes' WHERE workspace_id=$1 AND id=$2",
      [w, d.id],
    ),
  );
  await docs.processDocument(db, owner, w, d.id, { parser: mockParser });
  const newest = await run((ctx) => docs.documentDetail(ctx, d.id));
  expect(newest.status).toBe('ready');
  const count = await documentRecordCount();
  release();
  await old;
  expect(await run((ctx) => docs.documentDetail(ctx, d.id))).toMatchObject({
    status: 'ready',
    record_id: newest.record_id,
    version: newest.version,
    error: null,
  });
  expect(await documentRecordCount()).toBe(count);
});
it('protects the immutable original and scope at database level', async () => {
  const d = await processed();
  for (const [sql, args] of [
    ['UPDATE documents SET customer_id=$3 WHERE workspace_id=$1 AND id=$2', [w, d.id, b]],
    ["UPDATE documents SET original_base64='spoof' WHERE workspace_id=$1 AND id=$2", [w, d.id]],
  ] as const)
    await expect(run((ctx) => ctx.tx.query(sql, [...args]))).rejects.toThrow('immutable');
});
it('keeps explicit content versions and historical originals without overwriting their evidence', async () => {
  const first = await processed(a, p);
  const input = uploadInput(a, p, { supersedes_id: first.id });
  const next = await run((ctx) => docs.uploadDocument(ctx, input));
  expect(next.edition).toBe(2);
  expect(next.supersedes_id).toBe(first.id);
  expect(
    (await run((ctx) => docs.listDocuments(ctx, { customer_id: a, project_id: p }))).files.some(
      (f) => f.id === first.id,
    ),
  ).toBe(true);
  await docs.processDocument(db, owner, w, next.id, { parser: mockParser });
  const current = await run((ctx) => docs.documentDetail(ctx, next.id));
  expect(current.status).toBe('ready');
  expect(current.record_id).not.toBe(first.record_id);
  const listed = (await run((ctx) => docs.listDocuments(ctx, { customer_id: a, project_id: p })))
    .files;
  expect(listed.some((f) => f.id === first.id)).toBe(false);
  expect(listed.some((f) => f.id === next.id)).toBe(true);
  expect((await run((ctx) => docs.documentVersions(ctx, next.id))).files.map((f) => f.id)).toEqual([
    next.id,
    first.id,
  ]);
  expect((await run((ctx) => docs.originalDocument(ctx, first.id))).content_base64).toBeTruthy();
  expect(
    (await run((ctx) => sourceMaterials(ctx, a))).filter((s) =>
      [first.record_id, current.record_id].includes(s.record_id),
    ),
  ).toHaveLength(2);
  await expect(
    run((ctx) => docs.uploadDocument(ctx, uploadInput(a, p, { supersedes_id: first.id }))),
  ).rejects.toThrow('后续版本');
  await expect(
    run((ctx) => docs.uploadDocument(ctx, uploadInput(b, null, { supersedes_id: next.id }))),
  ).rejects.toThrow('沿用');
});
it('does not mark a newly queued file ready from an older company graph and waits for both indexes', async () => {
  await run(async (ctx) => {
    for (const table of ['knowledge_sync', 'source_index_sync'])
      await ctx.tx.query(
        `UPDATE ${table} SET state='ready',applied_version=requested_version WHERE workspace_id=$1 AND customer_id=$2`,
        [w, a],
      );
  });
  const fresh = await run((ctx) =>
    docs.uploadDocument(ctx, uploadInput(), { knowledgeEnabled: true }),
  );
  expect(fresh.knowledge_state).toBe('queued');
  await docs.processDocument(db, owner, w, fresh.id, { parser: mockParser });
  await run((ctx) =>
    ctx.tx.query(
      "UPDATE knowledge_sync SET state='ready',applied_version=requested_version WHERE workspace_id=$1 AND customer_id=$2",
      [w, a],
    ),
  );
  expect(
    (await run((ctx) => docs.documentDetail(ctx, fresh.id, { knowledgeEnabled: true })))
      .knowledge_state,
  ).toBe('queued');
  await run((ctx) =>
    ctx.tx.query(
      "UPDATE source_index_sync SET state='ready',applied_version=requested_version WHERE workspace_id=$1 AND customer_id=$2",
      [w, a],
    ),
  );
  expect(
    (await run((ctx) => docs.documentDetail(ctx, fresh.id, { knowledgeEnabled: true })))
      .knowledge_state,
  ).toBe('ready');
});
it('skips revoked queued owners so later authorized files are not starved', async () => {
  const blocked: DocumentDetail[] = [];
  for (let i = 0; i < 5; i++)
    blocked.push(await run((ctx) => docs.uploadDocument(ctx, uploadInput()), editor));
  await run((ctx) =>
    ctx.tx.query(
      'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
      [w, a, editor],
    ),
  );
  const valid = await run((ctx) => docs.uploadDocument(ctx, uploadInput()));
  const stop = docs.startDocumentWorker(db, { parser: mockParser });
  try {
    for (let i = 0; i < 250; i++) {
      if ((await run((ctx) => docs.documentDetail(ctx, valid.id))).status === 'ready') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await run((ctx) => docs.documentDetail(ctx, valid.id))).status).toBe('ready');
    expect(
      (
        await db.query<{ status: string }>(
          'SELECT status FROM documents WHERE id=ANY($1::uuid[])',
          [blocked.map((d) => d.id)],
        )
      ).rows.every((d) => d.status === 'failed'),
    ).toBe(true);
    const blockedFile = await run((ctx) => docs.documentDetail(ctx, blocked[0].id));
    await run((ctx) => docs.retryDocument(ctx, blockedFile.id, { version: blockedFile.version }));
    for (let i = 0; i < 200; i++) {
      if ((await run((ctx) => docs.documentDetail(ctx, blockedFile.id))).status === 'ready') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await run((ctx) => docs.documentDetail(ctx, blockedFile.id))).status).toBe('ready');
    expect(
      (
        await db.query<{ uploaded_by: string; task_actor_id: string }>(
          'SELECT uploaded_by,task_actor_id FROM documents WHERE id=$1',
          [blockedFile.id],
        )
      ).rows[0],
    ).toEqual({ uploaded_by: editor, task_actor_id: owner });
  } finally {
    await stop();
    await run((ctx) =>
      ctx.tx.query(
        "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor')",
        [w, a, editor],
      ),
    );
  }
});
it('asks about only the selected document and revalidates permission before replying', async () => {
  const d = await processed(a, null, editor);
  let seen: string[] = [];
  const answer = await docs.askDocument(
    db,
    editor,
    w,
    d.id,
    { question: '公司主营什么？' },
    {
      transport: {
        generate: async (input) => {
          seen = input.snapshot.sources.map((s) => s.body);
          return { answer: '公司提供少儿舞蹈课程。', source_ids: [input.snapshot.sources[0].id] };
        },
      },
    },
  );
  expect(answer.answer).toContain('舞蹈');
  expect(seen).toEqual(d.sections.map((s) => s.text));
  expect(answer.evidence[0].label).toContain('第 1 页');
  await expect(
    docs.askDocument(
      db,
      editor,
      w,
      d.id,
      { question: 'x' },
      {
        transport: {
          generate: async (input) => {
            await run((ctx) =>
              ctx.tx.query(
                'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
                [w, a, editor],
              ),
            );
            return { answer: '资料', source_ids: [input.snapshot.sources[0].id] };
          },
        },
      },
    ),
  ).rejects.toThrow('无权');
  await run((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor')",
      [w, a, editor],
    ),
  );
});
it('hides archived customer documents, canonical sources and Record evidence', async () => {
  const temp = (
    await run((ctx) =>
      service.insert(ctx, 'customers', { name: '将归档公司', type: 'group', source: 'other' }),
    )
  ).id as string;
  const d = await processed(temp);
  await run(async (ctx) => {
    const c = await service.customer(ctx, temp);
    await service.update(ctx, 'customers', temp, { version: c.version, archived: true });
  });
  await expect(run((ctx) => docs.documentDetail(ctx, d.id))).rejects.toThrow('无权');
  expect(await run((ctx) => documentKnowledgeSources(ctx, temp))).toEqual([]);
  expect(
    (
      await run((ctx) =>
        ctx.tx.query('SELECT id FROM customer_records WHERE workspace_id=$1 AND id=$2', [
          w,
          d.record_id,
        ]),
      )
    ).rows,
  ).toHaveLength(0);
});
it('exposes authenticated JSON endpoints, polling state and original download without leaking raw bytes in lists', async () => {
  const origin = 'http://localhost:3100';
  const app = createApp(db, {
    origin,
    development: true,
    documents: { parser: mockParser },
  });
  const agent = request.agent(app);
  await agent
    .post('/api/auth/login')
    .set('origin', origin)
    .send({ email: 'document-owner@example.com', password: 'document-fixture-password' })
    .expect(200);
  const headers = { origin, 'x-workspace-id': w };
  const created = (await agent.post('/api/documents').set(headers).send(uploadInput()).expect(201))
    .body as DocumentDetail;
  let latest = created;
  for (let i = 0; i < 30 && latest.status !== 'ready'; i++) {
    await new Promise((r) => setTimeout(r, 10));
    latest = (await agent.get(`/api/documents/${created.id}`).set(headers).expect(200)).body;
  }
  expect(latest.status).toBe('ready');
  const listed = (await agent.get('/api/documents').set(headers).expect(200)).body;
  expect(JSON.stringify(listed)).not.toContain('content_base64');
  expect(JSON.stringify(listed)).not.toContain(mockParser.toString());
  const original = (
    await agent.get(`/api/documents/${created.id}/original`).set(headers).expect(200)
  ).body;
  expect(original.content_base64).toBeTruthy();
  await agent
    .post('/api/documents')
    .set({ ...headers, origin: 'http://evil.example' })
    .send(uploadInput())
    .expect(403);
  await agent.get('/api/documents').set({ origin }).expect(400);
});
