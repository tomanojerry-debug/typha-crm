import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { scoped, type Context } from '../server/security.js';
import * as service from '../server/service.js';
import { createPerson } from '../server/people.js';
import * as notes from '../server/notes.js';
import { currentNoteKnowledgeSources, resolveNoteSource } from '../server/note-sources.js';
import type { NoteBlock, SaveNoteDraft } from '../shared/notes.js';

let db: Database,
  w: string,
  owner: string,
  other: string,
  viewer: string,
  outsider: string,
  c: string,
  b: string,
  p: string,
  wrongProject: string,
  person: string,
  wrongPerson: string;
const run = <T>(fn: (ctx: Context) => Promise<T>, actor = owner) => scoped(db, actor, w, fn);
const block = (text = '工厂排期尚待核实'): NoteBlock => ({
  id: randomUUID(),
  type: 'paragraph',
  text,
  origin: 'original',
  sources: [],
});
const input = (patch: Partial<SaveNoteDraft> = {}): SaveNoteDraft => ({
  request_id: randomUUID(),
  version: 0,
  note_id: null,
  base_revision: 0,
  title: '跟进记录',
  customer_id: c,
  project_id: null,
  person_ids: [],
  blocks: [block()],
  ...patch,
});
async function draft(patch: Partial<SaveNoteDraft> = {}) {
  const value = input(patch);
  return run((ctx) => notes.saveNoteDraft(ctx, randomUUID(), value));
}
async function publish(patch: Partial<SaveNoteDraft> = {}) {
  const d = await draft(patch);
  return run((ctx) =>
    notes.publishNote(ctx, {
      request_id: randomUUID(),
      draft_id: d.id,
      draft_version: d.version,
      base_revision: d.base_revision,
    }),
  );
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const a = await createWorkspace(db, {
    name: '笔记合成验收',
    email: 'notes-owner@example.invalid',
    displayName: '笔记管理员',
    password: 'notes-fixture-password',
  });
  w = a.workspaceId;
  owner = a.actorId;
  for (const [name, role] of [
    ['other', 'member'],
    ['viewer', 'member'],
    ['outsider', 'member'],
  ] as const) {
    const id = randomUUID();
    await db.query('INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [
      id,
      `notes-${name}@example.invalid`,
      name,
      'unused',
    ]);
    await db.query('INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,$3)', [
      w,
      id,
      role,
    ]);
    if (name === 'other') other = id;
    else if (name === 'viewer') viewer = id;
    else outsider = id;
  }
  c = String(
    (
      await run((ctx) =>
        service.insert(ctx, 'customers', {
          name: '甲公司（合成）',
          type: 'group',
          source: 'other',
        }),
      )
    ).id,
  );
  b = String(
    (
      await run((ctx) =>
        service.insert(ctx, 'customers', {
          name: '乙公司（合成）',
          type: 'group',
          source: 'other',
        }),
      )
    ).id,
  );
  await run(async (ctx) => {
    for (const [actor, access] of [
      [other, 'editor'],
      [viewer, 'viewer'],
    ])
      await ctx.tx.query(
        'INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,$4)',
        [w, c, actor, access],
      );
  });
  p = String(
    (
      await run((ctx) =>
        service.insert(ctx, 'projects', {
          customer_id: c,
          name: '甲项目',
          type: 'custom',
          stage: 'new',
        }),
      )
    ).id,
  );
  wrongProject = String(
    (
      await run((ctx) =>
        service.insert(ctx, 'projects', {
          customer_id: b,
          name: '乙项目',
          type: 'custom',
          stage: 'new',
        }),
      )
    ).id,
  );
  person = (
    await run((ctx) =>
      createPerson(ctx, {
        customer_id: c,
        name: '甲联系人',
        job_title: '',
        email: '',
        phone: '',
        description: '',
      }),
    )
  ).id;
  wrongPerson = (
    await run((ctx) =>
      createPerson(ctx, {
        customer_id: b,
        name: '乙联系人',
        job_title: '',
        email: '',
        phone: '',
        description: '',
      }),
    )
  ).id;
}, 60000);
afterAll(async () => {
  await db?.close();
});

it('empty private drafts publish nothing and are invisible to coworkers and admins', async () => {
  const d = await draft({ title: '', blocks: [] });
  expect(d.version).toBe(1);
  await expect(run((ctx) => notes.noteDraft(ctx, d.id), other)).rejects.toMatchObject({
    status: 404,
  });
  expect((await run((ctx) => notes.listNotes(ctx, { view: 'drafts' }), other)).drafts).toHaveLength(
    0,
  );
  await expect(
    run((ctx) =>
      notes.publishNote(ctx, {
        request_id: randomUUID(),
        draft_id: d.id,
        draft_version: d.version,
        base_revision: 0,
      }),
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(
    (await run((ctx) => ctx.tx.query("SELECT id FROM customer_records WHERE source_kind='note'")))
      .rows,
  ).toHaveLength(0);
});
it('draft autosave is versioned and retries cannot reuse a request for different text', async () => {
  const id = randomUUID(),
    value = input();
  const d = await run((ctx) => notes.saveNoteDraft(ctx, id, value));
  expect(await run((ctx) => notes.saveNoteDraft(ctx, id, value))).toEqual(d);
  await expect(
    run((ctx) => notes.saveNoteDraft(ctx, id, { ...value, title: '另一个标题' })),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    run((ctx) =>
      notes.saveNoteDraft(ctx, id, { ...value, request_id: randomUUID(), title: '过期输入' }),
    ),
  ).rejects.toMatchObject({ status: 409 });
});
it('requires current customer editor access for draft and publication', async () => {
  await expect(
    run((ctx) => notes.saveNoteDraft(ctx, randomUUID(), input()), viewer),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    run((ctx) => notes.saveNoteDraft(ctx, randomUUID(), input()), outsider),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    run((ctx) => notes.saveNoteDraft(ctx, randomUUID(), input({ project_id: wrongProject }))),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    run((ctx) => notes.saveNoteDraft(ctx, randomUUID(), input({ person_ids: [wrongPerson] }))),
  ).rejects.toMatchObject({ status: 404 });
});
it('publishes a single note identity across customer project and explicit contact pages', async () => {
  const n = await publish({ project_id: p, person_ids: [person] });
  expect(n.version).toBe(1);
  expect(n.record_id).toBeTruthy();
  expect(n.knowledge_state).toBe('pending');
  for (const filter of [
    { customer_id: c },
    { customer_id: c, project_id: p },
    { customer_id: c, person_id: person },
  ])
    expect(
      (await run((ctx) => notes.listNotes(ctx, filter))).notes.some((r) => r.id === n.id),
    ).toBe(true);
  expect((await run((ctx) => notes.noteDetail(ctx, n.id), viewer)).id).toBe(n.id);
  await expect(run((ctx) => notes.noteDetail(ctx, n.id), outsider)).rejects.toMatchObject({
    status: 404,
  });
});
it('knowledge source is internal, original-only, and explicitly version tagged', async () => {
  const n = await publish({ person_ids: [person], blocks: [block('仅内部新信息')] });
  const s = (await run((ctx) => currentNoteKnowledgeSources(ctx, c))).find(
    (s) => s.record_id === n.record_id,
  )!;
  expect(s.body).toBe('仅内部新信息');
  expect(s.trust).toBe('inference');
  expect(s.person_ids).toEqual([person]);
  expect(s.note).toEqual({
    id: n.id,
    revision_id: n.revision_id,
    version: 1,
    content_hash: n.content_hash,
  });
  expect(s.ref.note_version).toBe(1);
});
it('editing autosave keeps old published content until publication; old Record becomes unreadable', async () => {
  const n = await publish({ blocks: [block('第一版尚待核实')] });
  const d = await draft({
    note_id: n.id,
    base_revision: n.version,
    blocks: [block('第二版仍未确认')],
  });
  expect((await run((ctx) => notes.noteDetail(ctx, n.id), other)).blocks[0].text).toBe(
    '第一版尚待核实',
  );
  const newer = await run((ctx) =>
    notes.publishNote(ctx, {
      request_id: randomUUID(),
      draft_id: d.id,
      draft_version: d.version,
      base_revision: n.version,
    }),
  );
  expect(newer.version).toBe(2);
  expect(newer.id).toBe(n.id);
  expect(newer.revision_id).not.toBe(n.revision_id);
  expect(
    (
      await run((ctx) =>
        ctx.tx.query('SELECT id FROM customer_records WHERE workspace_id=$1 AND id=$2', [
          w,
          n.record_id,
        ]),
      )
    ).rows,
  ).toHaveLength(0);
  const ss = await run((ctx) => currentNoteKnowledgeSources(ctx, c));
  expect(ss.some((s) => s.record_id === n.record_id)).toBe(false);
  expect(ss.some((s) => s.record_id === newer.record_id)).toBe(true);
  const state = (
    await run((ctx) =>
      ctx.tx.query<{ requested_version: number; state: string }>(
        'SELECT requested_version,state FROM knowledge_sync WHERE workspace_id=$1 AND customer_id=$2',
        [w, c],
      ),
    )
  ).rows[0];
  expect(Number(state.requested_version)).toBeGreaterThan(1);
  expect(state.state).toBe('pending');
});
it('publication replay is idempotent and different replay payload is rejected', async () => {
  const d = await draft();
  const value = {
    request_id: randomUUID(),
    draft_id: d.id,
    draft_version: d.version,
    base_revision: 0,
  };
  const n = await run((ctx) => notes.publishNote(ctx, value));
  expect((await run((ctx) => notes.publishNote(ctx, value))).id).toBe(n.id);
  await expect(
    run((ctx) => notes.publishNote(ctx, { ...value, draft_version: 999 })),
  ).rejects.toMatchObject({ status: 409 });
});
it('concurrent editors retain private work when the base published version changes', async () => {
  const n = await publish();
  const d1 = await draft({ note_id: n.id, base_revision: n.version });
  const d2 = await run(
    (ctx) =>
      notes.saveNoteDraft(
        ctx,
        randomUUID(),
        input({ note_id: n.id, base_revision: n.version, title: '另一位同事修改' }),
      ),
    other,
  );
  await run((ctx) =>
    notes.publishNote(ctx, {
      request_id: randomUUID(),
      draft_id: d1.id,
      draft_version: d1.version,
      base_revision: n.version,
    }),
  );
  await expect(
    run(
      (ctx) =>
        notes.publishNote(ctx, {
          request_id: randomUUID(),
          draft_id: d2.id,
          draft_version: d2.version,
          base_revision: n.version,
        }),
      other,
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect((await run((ctx) => notes.noteDraft(ctx, d2.id), other)).title).toBe('另一位同事修改');
});
it('a pure source summary creates no new evidence Record and preserves original attribution', async () => {
  const r = await run((ctx) =>
    service.insert(ctx, 'customer_records', {
      customer_id: c,
      project_id: null,
      kind: 'customer_quote',
      body: '客户提出样衣修改要求，尚未得到公司确认。',
      created_by: owner,
      source_kind: 'manual',
    }),
  );
  const src = await run((ctx) => resolveNoteSource(ctx, c, { record_id: String(r.id) }));
  const n = await publish({
    blocks: [{ ...block('样衣要求待确认'), origin: 'derived', sources: [src] }],
  });
  expect(n.record_id).toBeNull();
  expect(n.knowledge_state).toBe('not_required');
  expect(n.sources[0].record_id).toBe(r.id);
  expect(
    (await run((ctx) => currentNoteKnowledgeSources(ctx, c))).some((s) => s.note?.id === n.id),
  ).toBe(false);
});
it('mixed notes index only new internal text and never duplicate cited summary', async () => {
  const r = await run((ctx) =>
    service.insert(ctx, 'customer_records', {
      customer_id: c,
      project_id: null,
      kind: 'customer_quote',
      body: '客户要求核实尺寸。',
      created_by: owner,
      source_kind: 'manual',
    }),
  );
  const src = await run((ctx) => resolveNoteSource(ctx, c, { record_id: String(r.id) }));
  const n = await publish({
    blocks: [
      { ...block('客户有尺寸问题'), origin: 'derived', sources: [src] },
      block('我今天已向工厂提出核实，回复尚未收到。'),
    ],
  });
  const s = (await run((ctx) => currentNoteKnowledgeSources(ctx, c))).find(
    (s) => s.record_id === n.record_id,
  )!;
  expect(s.body).toBe('我今天已向工厂提出核实，回复尚未收到。');
  expect(s.body).not.toContain('客户有尺寸问题');
});
it('invalid citations and cross customer sources cannot be laundered into notes', async () => {
  const r = await run((ctx) =>
    service.insert(ctx, 'customer_records', {
      customer_id: b,
      project_id: null,
      kind: 'customer_quote',
      body: '乙公司私有内容',
      created_by: owner,
      source_kind: 'manual',
    }),
  );
  const src = await run((ctx) => resolveNoteSource(ctx, b, { record_id: String(r.id) }));
  await expect(
    draft({ blocks: [{ ...block('引用'), origin: 'derived', sources: [src] }] }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    draft({
      blocks: [
        { ...block('引用'), origin: 'derived', sources: [{ ...src, record_id: randomUUID() }] },
      ],
    }),
  ).rejects.toMatchObject({ status: 404 });
});
it('archive hides source Records immediately and restore requests a new knowledge generation', async () => {
  const n = await publish();
  const a = await run((ctx) =>
    notes.archiveNote(ctx, n.id, { request_id: randomUUID(), version: n.version }),
  );
  expect(a.archived_at).toBeTruthy();
  expect(
    (await run((ctx) => currentNoteKnowledgeSources(ctx, c))).some(
      (s) => s.record_id === n.record_id,
    ),
  ).toBe(false);
  expect(
    (await run((ctx) => notes.listNotes(ctx, { archived: 'true' }))).notes.some(
      (s) => s.id === n.id,
    ),
  ).toBe(true);
  const restored = await run((ctx) =>
    notes.archiveNote(ctx, n.id, { request_id: randomUUID(), version: a.version }, false),
  );
  expect(restored.archived_at).toBeNull();
  expect(
    (await run((ctx) => currentNoteKnowledgeSources(ctx, c))).some(
      (s) => s.record_id === n.record_id,
    ),
  ).toBe(true);
});
it('draft content cannot change customer or promote existing derived blocks into original evidence', async () => {
  const r = await run((ctx) =>
    service.insert(ctx, 'customer_records', {
      customer_id: c,
      project_id: null,
      kind: 'customer_quote',
      body: '当前还没有承诺。',
      created_by: owner,
      source_kind: 'manual',
    }),
  );
  const src = await run((ctx) => resolveNoteSource(ctx, c, { record_id: String(r.id) }));
  const d = await draft({
    blocks: [{ ...block('目前待确认'), origin: 'derived', sources: [src] }],
  });
  await expect(
    run((ctx) =>
      notes.saveNoteDraft(ctx, d.id, {
        ...input(),
        request_id: randomUUID(),
        version: d.version,
        customer_id: b,
      }),
    ),
  ).rejects.toMatchObject({ status: 409 });
  const d2 = await run((ctx) =>
    notes.saveNoteDraft(ctx, d.id, {
      ...input(),
      request_id: randomUUID(),
      version: d.version,
      blocks: [{ ...d.blocks[0], origin: 'original', sources: [] }],
    }),
  );
  expect(d2.blocks[0].origin).toBe('derived');
  expect(d2.blocks[0].sources).toHaveLength(1);
});
it('personal templates do not expose another actor templates or accept source metadata', async () => {
  const t = await run((ctx) =>
    notes.createNoteTemplate(ctx, {
      name: '交接结构',
      blocks: [{ id: randomUUID(), type: 'heading', text: '待确认问题' }],
    }),
  );
  expect(
    (await run((ctx) => notes.listNoteTemplates(ctx))).templates.some((x) => x.id === t.id),
  ).toBe(true);
  expect((await run((ctx) => notes.listNoteTemplates(ctx), other)).templates).toHaveLength(0);
  await expect(
    run((ctx) => notes.createNoteTemplate(ctx, { name: '伪造引用', blocks: [block()] })),
  ).rejects.toThrow();
});
it('losing customer permission revokes private draft recovery too', async () => {
  const d = await run((ctx) => notes.saveNoteDraft(ctx, randomUUID(), input()), other);
  await run((ctx) =>
    ctx.tx.query(
      'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
      [w, c, other],
    ),
  );
  await expect(run((ctx) => notes.noteDraft(ctx, d.id), other)).rejects.toMatchObject({
    status: 404,
  });
  await run((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'editor')",
      [w, c, other],
    ),
  );
});

it('exposes revision history metadata without releasing historical text through Record APIs', async () => {
  const n = await publish({ blocks: [block('历史内部文字')] });
  const d = await draft({
    note_id: n.id,
    base_revision: n.version,
    blocks: [block('当前内部文字')],
  });
  const current = await run((ctx) =>
    notes.publishNote(ctx, {
      request_id: randomUUID(),
      draft_id: d.id,
      draft_version: d.version,
      base_revision: n.version,
    }),
  );
  const versions = await run((ctx) => notes.noteVersions(ctx, n.id));
  expect(versions.revisions.map((r) => r.version)).toEqual([2, 1]);
  expect(versions.revisions[0].current).toBe(true);
  expect(JSON.stringify(versions)).not.toContain('历史内部文字');
  expect(current.knowledge_versions?.graph?.requested_version).toBeGreaterThan(
    current.knowledge_versions?.graph?.applied_version || 0,
  );
  await expect(run((ctx) => notes.noteVersions(ctx, n.id), outsider)).rejects.toMatchObject({
    status: 404,
  });
});

it('newer autosaves cannot be silently replaced by a delayed old successful request', async () => {
  const id = randomUUID(),
    v = input();
  const first = await run((ctx) => notes.saveNoteDraft(ctx, id, v));
  await run((ctx) =>
    notes.saveNoteDraft(ctx, id, {
      ...v,
      version: first.version,
      request_id: randomUUID(),
      title: '已更新草稿',
    }),
  );
  await expect(run((ctx) => notes.saveNoteDraft(ctx, id, v))).rejects.toMatchObject({
    status: 409,
  });
  expect((await run((ctx) => notes.noteDraft(ctx, id))).title).toBe('已更新草稿');
});

it('recursive source withdrawal hides both notes and private source snapshots immediately', async () => {
  const a = await publish({ blocks: [block('上游内部核实结果')] });
  const source = await run((ctx) => resolveNoteSource(ctx, c, { record_id: a.record_id! }));
  const b = await publish({
    blocks: [
      { ...block('上游整理'), origin: 'derived', sources: [source] },
      block('第二篇内部补充'),
    ],
  });
  const downstream = await run((ctx) => resolveNoteSource(ctx, c, { record_id: b.record_id! }));
  const third = await publish({
    blocks: [{ ...block('二次整理'), origin: 'derived', sources: [downstream] }],
  });
  const privateDraft = await draft({
    blocks: [{ ...block('尚未发布整理'), origin: 'derived', sources: [source] }],
  });
  await run((ctx) =>
    notes.archiveNote(ctx, a.id, { request_id: randomUUID(), version: a.version }),
  );
  for (const id of [b.id, third.id])
    await expect(run((ctx) => notes.noteDetail(ctx, id))).rejects.toMatchObject({ status: 404 });
  await expect(run((ctx) => notes.noteDraft(ctx, privateDraft.id))).rejects.toMatchObject({
    status: 404,
  });
  expect(
    (
      await run((ctx) =>
        ctx.tx.query('SELECT id FROM note_drafts WHERE workspace_id=$1 AND id=$2', [
          w,
          privateDraft.id,
        ]),
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (await run((ctx) => currentNoteKnowledgeSources(ctx, c))).some(
      (s) => s.record_id === b.record_id,
    ),
  ).toBe(false);
});

it('mixed-contact WeChat Records cannot be cited into a single-contact scope', async () => {
  const another = (
    await run((ctx) =>
      createPerson(ctx, {
        customer_id: c,
        name: '另一位合成联系人',
        job_title: '',
        email: '',
        phone: '',
        description: '',
      }),
    )
  ).id;
  const r = await run((ctx) =>
    service.insert(ctx, 'customer_records', {
      customer_id: c,
      project_id: null,
      kind: 'customer_quote',
      body: '混合来源容器',
      created_by: owner,
      source_kind: 'wechat',
    }),
  );
  await run(async (ctx) => {
    for (const [pid, text] of [
      [person, '甲联系人部分'],
      [another, '其他联系人不可混入'],
    ])
      await ctx.tx.query(
        "INSERT INTO knowledge_wechat_evidence(workspace_id,customer_id,id,source_key,record_id,person_id,body,speaker,occurred_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'合成说话人',now(),$8)",
        [w, c, randomUUID(), randomUUID(), r.id, pid, text, owner],
      );
  });
  await expect(
    run((ctx) => resolveNoteSource(ctx, c, { record_id: String(r.id) }, { person_id: person })),
  ).rejects.toMatchObject({ status: 404 });
  const whole = await run((ctx) => resolveNoteSource(ctx, c, { record_id: String(r.id) }));
  await expect(
    draft({
      person_ids: [person],
      blocks: [{ ...block('混合摘要'), origin: 'derived', sources: [whole] }],
    }),
  ).rejects.toMatchObject({ status: 400 });
});

it('mail exclusion revokes published derived content including its title and search match', async () => {
  const account = randomUUID(),
    mailId = randomUUID();
  await run(async (ctx) => {
    await ctx.tx.query(
      'INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by) VALUES($1,$2,$3,$4,$5)',
      [w, account, 'notes-fixture@example.invalid', 'test-only', owner],
    );
    await ctx.tx.query(
      "INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason) VALUES($1,$2,$3,$4,$5,$6,'受限原信主题','{}','[]','[]',$7,now(),'inbound','请核对保密规格。','fixture')",
      [
        w,
        mailId,
        account,
        'notes-fixture@example.invalid',
        c,
        randomUUID(),
        JSON.stringify(['private@example.invalid']),
      ],
    );
  });
  const rid = String(
    (
      await run((ctx) =>
        ctx.tx.query<{ id: string }>(
          'SELECT id FROM customer_records WHERE workspace_id=$1 AND source_mail_id=$2',
          [w, mailId],
        ),
      )
    ).rows[0].id,
  );
  const src = await run((ctx) => resolveNoteSource(ctx, c, { record_id: rid }));
  expect(src.body).toBe('请核对保密规格。');
  const n = await publish({
    title: '保密规格摘要（合成）',
    blocks: [
      { ...block('保密规格需核对'), origin: 'derived', sources: [src] },
      block('内部补充也保守整篇隔离'),
    ],
  });
  await run((ctx) =>
    ctx.tx.query(
      'INSERT INTO mail_exclusions(workspace_id,rules) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET rules=EXCLUDED.rules',
      [w, JSON.stringify(['private@example.invalid'])],
    ),
  );
  await expect(run((ctx) => notes.noteDetail(ctx, n.id), viewer)).rejects.toMatchObject({
    status: 404,
  });
  expect(
    (await run((ctx) => notes.listNotes(ctx, { search: '保密规格' }), viewer)).notes,
  ).toHaveLength(0);
  expect(
    (
      await run(
        (ctx) =>
          ctx.tx.query('SELECT id FROM customer_records WHERE workspace_id=$1 AND id=$2', [
            w,
            n.record_id,
          ]),
        viewer,
      )
    ).rows,
  ).toHaveLength(0);
});

it('author and Beijing inclusive update-date filters use displayed content only', async () => {
  const n = await publish({ title: '日期筛选合成笔记', blocks: [block('正文精确标记')] });
  const day = new Date(new Date(n.updated_at).getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  expect(
    (
      await run((ctx) =>
        notes.listNotes(ctx, {
          search: '日期筛选合成笔记',
          author_id: owner,
          updated_from: day,
          updated_to: day,
        }),
      )
    ).notes.some((x) => x.id === n.id),
  ).toBe(true);
  expect(
    (await run((ctx) => notes.listNotes(ctx, { search: '日期筛选合成笔记', author_id: other })))
      .notes,
  ).toHaveLength(0);
  expect((await run((ctx) => notes.listNotes(ctx, { search: n.content_hash }))).notes).toHaveLength(
    0,
  );
  await expect(
    run((ctx) => notes.listNotes(ctx, { updated_from: '2026-11-01', updated_to: '2026-10-01' })),
  ).rejects.toMatchObject({ status: 400 });
});

it('archive concurrency tokens do not invent content revisions', async () => {
  const n = await publish();
  const archived = await run((ctx) =>
    notes.archiveNote(ctx, n.id, { request_id: randomUUID(), version: n.version }),
  );
  const restored = await run((ctx) =>
    notes.archiveNote(ctx, n.id, { request_id: randomUUID(), version: archived.version }, false),
  );
  expect(restored.version).toBe(3);
  expect(restored.revision_version).toBe(1);
  const d = await draft({
    note_id: n.id,
    base_revision: restored.version,
    blocks: [block('真正的第二版正文')],
  });
  const v2 = await run((ctx) =>
    notes.publishNote(ctx, {
      request_id: randomUUID(),
      draft_id: d.id,
      draft_version: d.version,
      base_revision: restored.version,
    }),
  );
  expect(v2.version).toBe(4);
  expect(v2.revision_version).toBe(2);
  expect(
    (await run((ctx) => notes.noteVersions(ctx, n.id))).revisions.map((r) => r.version),
  ).toEqual([2, 1]);
  const source = (await run((ctx) => currentNoteKnowledgeSources(ctx, c))).find(
    (s) => s.record_id === v2.record_id,
  )!;
  expect(source.note?.version).toBe(2);
});

it('first private edit of a published summary cannot relabel its derived block as original', async () => {
  const r = await run((ctx) =>
    service.insert(ctx, 'customer_records', {
      customer_id: c,
      project_id: null,
      kind: 'customer_quote',
      body: '来源原文没有正式承诺。',
      created_by: owner,
      source_kind: 'manual',
    }),
  );
  const src = await run((ctx) => resolveNoteSource(ctx, c, { record_id: String(r.id) }));
  const n = await publish({
    blocks: [{ ...block('原文整理结果'), origin: 'derived', sources: [src] }],
  });
  const d = await draft({
    note_id: n.id,
    base_revision: n.version,
    blocks: [{ ...n.blocks[0], origin: 'original', sources: [] }],
  });
  expect(d.blocks[0].origin).toBe('derived');
  expect(d.blocks[0].sources[0].record_id).toBe(r.id);
  const next = await run((ctx) =>
    notes.publishNote(ctx, {
      request_id: randomUUID(),
      draft_id: d.id,
      draft_version: d.version,
      base_revision: n.version,
    }),
  );
  expect(next.record_id).toBeNull();
});

it('removing sourced blocks retains the unchanged title dependency in drafts and publication', async () => {
  const parent = await publish({ title: '上游记录', blocks: [block('原始内部核实')] });
  const src = await run((ctx) => resolveNoteSource(ctx, c, { record_id: parent.record_id! }));
  const n = await publish({
    title: '依赖上游的标题',
    blocks: [{ ...block('整理'), origin: 'derived', sources: [src] }],
  });
  const d = await draft({
    note_id: n.id,
    base_revision: n.version,
    title: n.title,
    blocks: [block('仅保留自己的独立补充')],
  });
  expect(d.title_sources?.map((s) => s.record_id)).toEqual([parent.record_id]);
  const newer = await run((ctx) =>
    notes.publishNote(ctx, {
      request_id: randomUUID(),
      draft_id: d.id,
      draft_version: d.version,
      base_revision: n.version,
    }),
  );
  expect(newer.sources.map((s) => s.record_id)).toEqual([parent.record_id]);
  const unpublished = await draft({
    note_id: newer.id,
    base_revision: newer.version,
    title: newer.title,
    blocks: [block('尚未保存后续补充')],
  });
  await run((ctx) =>
    notes.archiveNote(ctx, parent.id, { version: parent.version, request_id: randomUUID() }),
  );
  await expect(run((ctx) => notes.noteDetail(ctx, newer.id))).rejects.toMatchObject({
    status: 404,
  });
  await expect(run((ctx) => notes.noteDraft(ctx, unpublished.id))).rejects.toMatchObject({
    status: 404,
  });
});
