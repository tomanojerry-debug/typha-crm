import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWorkspace } from '../server/bootstrap.js';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped, type Context } from '../server/security.js';
import { insert } from '../server/service.js';
import { createPerson } from '../server/people.js';
import { archiveNote, publishNote, saveNoteDraft, listNotes } from '../server/notes.js';
import { currentNoteKnowledgeSources, resolveNoteSource } from '../server/note-sources.js';
import { knowledgeSnapshot, knowledgeView, syncKnowledgeOnce } from '../server/knowledge.js';
import {
  prepareKnowledgeSearch,
  executeKnowledgeSearch,
  validateKnowledgeSearch,
} from '../server/knowledge-search.js';
import {
  ensureSourceIndex,
  prepareSourceSearch,
  executeSourceSearch,
  validateSourceSearch,
  sourceMaterials,
} from '../server/source-index.js';
import {
  prepareNoteRetrieval,
  executeNoteRetrieval,
  noteRetrievedSources,
} from '../server/note-retrieval.js';
import { modelQuery, modelSnapshot } from '../server/ask.js';
import { createChat, sendWithModel } from '../server/chats.js';
import type { AgentModelInput, AgentModelOptions } from '../server/agent-model.js';
import type { NoteBlock, NoteDetail, SaveNoteDraft } from '../shared/notes.js';
import { sourceEmbeddingModel, type LocalEmbeddingTransport } from '../shared/source-search.js';

let db: Database,
  w: string,
  actor: string,
  c: string,
  p: string,
  otherProject: string,
  person: string,
  otherPerson: string;
const run = <T>(fn: (ctx: Context) => Promise<T>) => scoped(db, actor, w, fn);
const block = (text: string): NoteBlock => ({
  id: randomUUID(),
  type: 'paragraph',
  text,
  origin: 'original',
  sources: [],
});
const embedding: LocalEmbeddingTransport = {
  async embed({ texts }) {
    return {
      model: sourceEmbeddingModel,
      dimensions: 384,
      vectors: texts.map((text) =>
        Array.from({ length: 384 }, (_, i) =>
          i === (/袖口摩擦|穿着不舒服/.test(text) ? 0 : 1) ? 1 : 0,
        ),
      ),
    };
  },
};
const scope = (object: 'customers' | 'projects' | 'people' = 'customers', id?: string) => ({
  kind: 'entity' as const,
  object,
  customer_id: c,
  record_id: id || (object === 'customers' ? c : object === 'projects' ? p : person),
});
async function publish(patch: Partial<SaveNoteDraft> = {}, existing?: NoteDetail) {
  const draft = await run((ctx) =>
    saveNoteDraft(ctx, randomUUID(), {
      request_id: randomUUID(),
      version: 0,
      note_id: existing?.id || null,
      base_revision: existing?.version || 0,
      title: existing?.title || '合成项目跟进',
      customer_id: c,
      project_id: p,
      person_ids: [person],
      blocks: [block('排期尚待核实')],
      ...patch,
    }),
  );
  return run((ctx) =>
    publishNote(ctx, {
      request_id: randomUUID(),
      draft_id: draft.id,
      draft_version: draft.version,
      base_revision: draft.base_revision,
    }),
  );
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const first = await createWorkspace(db, {
    name: '笔记知识合成验收',
    email: 'notes-knowledge@example.invalid',
    displayName: '合成记录者',
    password: 'notes-fixture-password',
  });
  w = first.workspaceId;
  actor = first.actorId;
}, 30000);
beforeEach(async () => {
  c = String(
    (
      await run((ctx) =>
        insert(ctx, 'customers', {
          name: `合成笔记公司-${randomUUID()}`,
          type: 'group',
          source: 'other',
        }),
      )
    ).id,
  );
  p = String(
    (
      await run((ctx) =>
        insert(ctx, 'projects', { customer_id: c, name: '当前项目', type: 'sample' }),
      )
    ).id,
  );
  otherProject = String(
    (
      await run((ctx) =>
        insert(ctx, 'projects', { customer_id: c, name: '另一项目', type: 'sample' }),
      )
    ).id,
  );
  person = (await run((ctx) => createPerson(ctx, { customer_id: c, name: '合成甲老师' }))).id;
  otherPerson = (await run((ctx) => createPerson(ctx, { customer_id: c, name: '合成乙老师' }))).id;
});
afterAll(() => db.close());

it('keeps autosaves out of knowledge and labels published originals with the exact revision', async () => {
  await run((ctx) =>
    saveNoteDraft(ctx, randomUUID(), {
      request_id: randomUUID(),
      version: 0,
      note_id: null,
      base_revision: 0,
      title: '本人草稿哨兵',
      customer_id: c,
      project_id: p,
      person_ids: [],
      blocks: [block('未发布内容不得检索')],
    }),
  );
  expect((await run((ctx) => knowledgeSnapshot(ctx, c))).sources).toHaveLength(0);
  expect(await run((ctx) => sourceMaterials(ctx, c))).toHaveLength(0);
  const note = await publish();
  for (const sources of [
    await run((ctx) => sourceMaterials(ctx, c)),
    (await run((ctx) => knowledgeSnapshot(ctx, c))).sources,
  ]) {
    expect(sources).toHaveLength(1);
    expect(sources[0].note).toEqual({
      id: note.id,
      revision_id: note.revision_id,
      version: 1,
      content_hash: note.content_hash,
    });
    expect(sources[0].trust).toBe('inference');
    expect(sources[0].ref.note_version).toBe(1);
    expect(sources[0].body).not.toContain('未发布内容');
  }
  const root = await run((ctx) => resolveNoteSource(ctx, c, { record_id: note.record_id! }));
  await publish({
    blocks: [
      {
        id: randomUUID(),
        type: 'paragraph',
        text: '整理刚才的内部跟进，仍待核实。',
        origin: 'derived',
        sources: [root],
      },
    ],
  });
  const plan = await executeNoteRetrieval(
    db,
    await run((ctx) => prepareNoteRetrieval(ctx, c, '总结笔记', { project_id: p })),
    {},
  );
  const snapshot = await run((ctx) => modelSnapshot(ctx, scope('projects'), undefined, plan));
  expect(snapshot.sources.find((s) => s.ref?.id === note.record_id)?.ref?.note_version).toBe(1);
});

it('indexes only original blocks and reuses root Record identity for quotation and summaries', async () => {
  const root = String(
    (
      await run((ctx) =>
        insert(ctx, 'customer_records', {
          customer_id: c,
          project_id: p,
          body: '客户原文：希望核对尺寸，不是公司承诺。',
          kind: 'customer_quote',
          created_by: actor,
        }),
      )
    ).id,
  );
  const ref = await run((ctx) => resolveNoteSource(ctx, c, { record_id: root }));
  const derived: NoteBlock = {
    id: randomUUID(),
    type: 'paragraph',
    text: 'DERIVED_ONLY摘要不作为独立图事实',
    origin: 'derived',
    sources: [ref],
  };
  const pure = await publish({ person_ids: [], blocks: [derived] });
  expect(pure.record_id).toBeNull();
  const mixed = await publish({
    person_ids: [],
    blocks: [derived, block('ORIGINAL_ONLY本人核实目前仍待回复')],
  });
  const sources = await run((ctx) => sourceMaterials(ctx, c));
  expect(sources).toHaveLength(2);
  expect(sources.find((s) => s.record_id === mixed.record_id)?.body).toBe(
    'ORIGINAL_ONLY本人核实目前仍待回复',
  );
  expect(JSON.stringify((await run((ctx) => knowledgeSnapshot(ctx, c))).sources)).not.toContain(
    'DERIVED_ONLY',
  );
  const prepared = await run((ctx) => prepareNoteRetrieval(ctx, c, '总结笔记', { project_id: p }));
  const plan = await executeNoteRetrieval(db, prepared, {});
  const snapshot = await run((ctx) => modelSnapshot(ctx, scope('projects'), undefined, plan));
  expect(snapshot.sources.filter((s) => s.id === `record::${root}`)).toHaveLength(1);
  expect(snapshot.sources.some((s) => s.id === `note-view:${pure.id}`)).toBe(true);
});

it('invalidates graph, vector and note plans atomically when the published revision changes', async () => {
  const v1 = await publish({ blocks: [block('旧版本待确认40件')] });
  await syncKnowledgeOnce(
    db,
    { sync: async () => [], discard: async () => {} },
    { workspace_id: w, customer_id: c },
  );
  await ensureSourceIndex(db, actor, w, c, embedding);
  const graph = await executeKnowledgeSearch(
    await run((ctx) => prepareKnowledgeSearch(ctx, c, '数量')),
  );
  const vector = await executeSourceSearch(
    await run((ctx) => prepareSourceSearch(ctx, c, '数量', { note_only: true })),
    embedding,
  );
  const notePlan = await executeNoteRetrieval(
    db,
    await run((ctx) => prepareNoteRetrieval(ctx, c, '数量')),
    { embeddings: embedding },
  );
  const before = (
    await db.query<{ requested_version: number; generation: string }>(
      'SELECT requested_version,generation FROM knowledge_sync WHERE workspace_id=$1 AND customer_id=$2',
      [w, c],
    )
  ).rows[0];
  const v2 = await publish({ blocks: [block('新版本更正为30件，仍待公司核实')] }, v1);
  expect(v2.id).toBe(v1.id);
  expect(v2.version).toBe(2);
  expect(v2.revision_id).not.toBe(v1.revision_id);
  const after = (
    await db.query<{ requested_version: number; applied_version: number; state: string }>(
      'SELECT requested_version,applied_version,state FROM knowledge_sync WHERE workspace_id=$1 AND customer_id=$2',
      [w, c],
    )
  ).rows[0];
  expect(Number(after.requested_version)).toBeGreaterThan(Number(before.requested_version));
  expect(after.state).toBe('pending');
  expect(Number(after.applied_version)).toBeLessThan(Number(after.requested_version));
  expect(
    (
      await run((ctx) =>
        ctx.tx.query('SELECT id FROM customer_records WHERE workspace_id=$1 AND id=$2', [
          w,
          v1.record_id,
        ]),
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await run((ctx) =>
        ctx.tx.query('SELECT id FROM source_chunks WHERE workspace_id=$1 AND record_id=$2', [
          w,
          v1.record_id,
        ]),
      )
    ).rows,
  ).toHaveLength(0);
  await expect(run((ctx) => validateKnowledgeSearch(ctx, graph))).rejects.toMatchObject({
    status: 409,
  });
  await expect(run((ctx) => validateSourceSearch(ctx, vector))).rejects.toMatchObject({
    status: 409,
  });
  await expect(run((ctx) => noteRetrievedSources(ctx, notePlan))).rejects.toMatchObject({
    status: 409,
  });
  await syncKnowledgeOnce(
    db,
    { sync: async () => [], discard: async () => {} },
    { workspace_id: w, customer_id: c },
  );
  expect((await run((ctx) => knowledgeView(ctx, c))).state).toBe('ready');
  expect(
    (await run((ctx) => currentNoteKnowledgeSources(ctx, c))).map((s) => s.note?.version),
  ).toEqual([2]);
});

it('removes archived knowledge immediately and restores it only as a newly pending publication', async () => {
  const note = await publish();
  await ensureSourceIndex(db, actor, w, c, embedding);
  await run((ctx) =>
    archiveNote(ctx, note.id, { version: note.version, request_id: randomUUID() }, true),
  );
  expect(await run((ctx) => currentNoteKnowledgeSources(ctx, c))).toHaveLength(0);
  expect(
    (await run((ctx) => sourceMaterials(ctx, c))).some((s) => s.record_id === note.record_id),
  ).toBe(false);
  expect(
    (
      await run((ctx) =>
        ctx.tx.query('SELECT id FROM source_chunks WHERE workspace_id=$1 AND record_id=$2', [
          w,
          note.record_id,
        ]),
      )
    ).rows,
  ).toHaveLength(0);
  const archived = (await run((ctx) => listNotes(ctx, { customer_id: c, archived: 'true' })))
    .notes[0];
  await run((ctx) =>
    archiveNote(ctx, note.id, { version: archived.version, request_id: randomUUID() }, false),
  );
  expect(await run((ctx) => currentNoteKnowledgeSources(ctx, c))).toHaveLength(1);
  expect(
    (
      await db.query<{ state: string }>(
        'SELECT state FROM source_index_sync WHERE workspace_id=$1 AND customer_id=$2',
        [w, c],
      )
    ).rows[0].state,
  ).toBe('pending');
});

it('includes only explicitly linked people and the selected project in Agent evidence', async () => {
  const mine = await publish({ blocks: [block('本人项目笔记可见哨兵')] });
  await publish({
    person_ids: [otherPerson],
    project_id: otherProject,
    blocks: [block('OTHER_PERSON_PROJECT_SECRET')],
  });
  for (const selected of [scope('people'), scope('projects')]) {
    const prepared = await run((ctx) =>
      prepareNoteRetrieval(
        ctx,
        c,
        '跟进',
        selected.object === 'people' ? { person_id: person } : { project_id: p },
      ),
    );
    const plan = await executeNoteRetrieval(db, prepared, {});
    const snapshot = await run((ctx) => modelSnapshot(ctx, selected, undefined, plan));
    expect(JSON.stringify(snapshot.sources)).toContain(mine.record_id);
    expect(JSON.stringify(snapshot.sources)).not.toContain('OTHER_PERSON_PROJECT_SECRET');
  }
});

it('retrieves an old note beyond recent windows through the note-only semantic channel', async () => {
  const old = await publish({
    title: '历史穿着反馈',
    blocks: [block('旧样衣袖口摩擦，请核实，未批准修改。')],
  });
  const foreign = await publish({
    project_id: otherProject,
    person_ids: [otherPerson],
    blocks: [block('另一项目袖口摩擦保密哨兵')],
  });
  for (let i = 0; i < 42; i++)
    await publish({ title: `后续无关笔记${i}`, blocks: [block(`无关资料${i}`)] });
  const prepared = await run((ctx) =>
    prepareNoteRetrieval(ctx, c, '穿着不舒服', { project_id: p }),
  );
  const plan = await executeNoteRetrieval(db, prepared, { embeddings: embedding });
  const snapshot = await run((ctx) => modelSnapshot(ctx, scope('projects'), undefined, plan));
  expect(snapshot.sources.filter((s) => s.id === `record::${old.record_id}`)).toHaveLength(1);
  expect(JSON.stringify(snapshot.sources)).toContain('袖口摩擦');
  expect(JSON.stringify(snapshot.sources)).not.toContain(foreign.record_id);
}, 30000);

it('rejects a running model answer after the note is revised instead of saving stale knowledge', async () => {
  const old = await publish({ blocks: [block('旧版数量10')] });
  const options: AgentModelOptions = {
    transport: {
      async generate(input) {
        await publish({ blocks: [block('新版数量20')] }, old);
        return {
          answer: '旧数量为10。',
          source_ids: input.snapshot.sources
            .filter((s) => s.ref?.id === old.record_id)
            .map((s) => s.id),
        };
      },
    },
  };
  await expect(
    modelQuery(db, actor, w, { scope: scope('projects'), question: '数量是多少？' }, options),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    (
      await db.query('SELECT id FROM chat_messages WHERE workspace_id=$1 AND body=$2', [
        w,
        '旧数量为10。',
      ])
    ).rows,
  ).toHaveLength(0);
});

it('finds an old derived note by title without making another evidence Record', async () => {
  const root = String(
    (
      await run((ctx) =>
        insert(ctx, 'customer_records', {
          customer_id: c,
          project_id: p,
          body: '合成客户原文：样衣问题仍待核实。',
          kind: 'customer_quote',
          created_by: actor,
        }),
      )
    ).id,
  );
  const ref = await run((ctx) => resolveNoteSource(ctx, c, { record_id: root }));
  const derived: NoteBlock = {
    id: randomUUID(),
    type: 'paragraph',
    text: '基于原文整理，问题尚待确认。',
    origin: 'derived',
    sources: [ref],
  };
  const old = await publish({ title: '青竹旧款复核', person_ids: [], blocks: [derived] });
  for (let i = 0; i < 32; i++)
    await publish({
      title: `后续摘要${i}`,
      person_ids: [],
      blocks: [{ ...derived, id: randomUUID() }],
    });
  const prepared = await run((ctx) =>
    prepareNoteRetrieval(ctx, c, '找一下“青竹旧款复核”的笔记', { project_id: p }),
  );
  const plan = await executeNoteRetrieval(db, prepared, {});
  const snapshot = await run((ctx) => modelSnapshot(ctx, scope('projects'), undefined, plan));
  expect(snapshot.sources.some((s) => s.id === `note-view:${old.id}`)).toBe(true);
  expect(snapshot.sources.filter((s) => s.id === `record::${root}`)).toHaveLength(1);
  expect((await run((ctx) => sourceMaterials(ctx, c))).map((s) => s.record_id)).toEqual([root]);
}, 30000);

it('does not let a late graph worker publish the previous note revision', async () => {
  const old = await publish({ blocks: [block('旧内部核实40件')] });
  await syncKnowledgeOnce(
    db,
    {
      async sync() {
        await publish({ blocks: [block('新内部核实30件')] }, old);
        return [];
      },
      async discard() {},
    },
    { workspace_id: w, customer_id: c },
  );
  const state = (
    await db.query<{ state: string; requested_version: number; applied_version: number }>(
      'SELECT state,requested_version,applied_version FROM knowledge_sync WHERE workspace_id=$1 AND customer_id=$2',
      [w, c],
    )
  ).rows[0];
  expect(state.state).toBe('pending');
  expect(Number(state.applied_version)).toBeLessThan(Number(state.requested_version));
  expect((await run((ctx) => currentNoteKnowledgeSources(ctx, c)))[0].note?.version).toBe(2);
});

it('counts an original mail, its graph Record and a note summary as one canonical evidence source', async () => {
  const account = randomUUID(),
    mailId = randomUUID();
  await run(async (ctx) => {
    await ctx.tx.query(
      'INSERT INTO mail_accounts(workspace_id,id,email,secret,connected_by) VALUES($1,$2,$3,$4,$5)',
      [w, account, `${account}@example.invalid`, 'synthetic-only', actor],
    );
    await ctx.tx.query(
      "INSERT INTO mail_messages(workspace_id,id,account_id,account_email,customer_id,fingerprint,subject,sender,recipients,cc,participants,occurred_at,direction,body,match_reason) VALUES($1,$2,$3,$4,$5,$6,'合成原信','[]','[]','[]','[]',now(),'inbound','客户仅要求核实，尚未承诺。','fixture')",
      [w, mailId, account, `${account}@example.invalid`, c, randomUUID()],
    );
  });
  const root = String(
    (
      await run((ctx) =>
        ctx.tx.query<{ id: string }>(
          'SELECT id FROM customer_records WHERE workspace_id=$1 AND source_mail_id=$2',
          [w, mailId],
        ),
      )
    ).rows[0].id,
  );
  const ref = await run((ctx) => resolveNoteSource(ctx, c, { record_id: root }));
  await publish({
    project_id: null,
    person_ids: [],
    blocks: [
      {
        id: randomUUID(),
        type: 'paragraph',
        origin: 'derived',
        text: '原信整理：等待核实。',
        sources: [ref],
      },
    ],
  });
  const plan = await executeNoteRetrieval(
    db,
    await run((ctx) => prepareNoteRetrieval(ctx, c, '总结笔记')),
    {},
  );
  const snapshot = await run((ctx) => modelSnapshot(ctx, scope(), undefined, plan));
  expect(snapshot.sources.filter((s) => s.ref?.id === root)).toHaveLength(1);
  expect(snapshot.sources.some((s) => s.ref?.kind === 'mail' && s.ref.id === mailId)).toBe(false);
});

it('keeps Home classification and adds versioned note evidence only after resolving a single company', async () => {
  const note = await publish({
    project_id: null,
    person_ids: [],
    blocks: [block('合成公司新增内部跟进尚待确认')],
  });
  const chat = await run((ctx) =>
    createChat(ctx, { id: randomUUID(), title: '笔记首页模型验收', customer_id: c }),
  );
  const phases: (string | undefined)[] = [];
  await sendWithModel(
    db,
    actor,
    w,
    chat.id,
    { request_id: randomUUID(), action: 'message', body: '总结当前公司的笔记' },
    {
      transport: {
        async generate(input: AgentModelInput) {
          phases.push(input.phase);
          if (input.phase === 'classify')
            return {
              intent: '查询资料',
              action: 'lookup_entity',
              entity_type: 'company',
              target: null,
              match_mode: null,
              candidate_index: null,
              data_source: 'records',
              missing: [],
              reply: '读取当前公司笔记',
              mail_action: null,
            };
          expect(
            input.snapshot.sources.some(
              (s) => s.ref?.note_id === note.id && s.ref?.note_version === 1,
            ),
          ).toBe(true);
          return {
            answer: '内部跟进尚待确认。',
            source_ids: input.snapshot.sources
              .filter((s) => s.ref?.note_id === note.id)
              .map((s) => s.id),
          };
        },
      },
    },
  );
  expect(phases).toEqual(['classify', 'answer']);
});
