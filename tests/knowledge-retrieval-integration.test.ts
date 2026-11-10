import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate, openDatabase, type Database } from '../server/db.js';
import { scoped } from '../server/security.js';
import { customer, insert, update } from '../server/service.js';
import { createChat, sendWithModel } from '../server/chats.js';
import { modelQuery, modelSnapshot } from '../server/ask.js';
import { knowledgeView, syncKnowledgeOnce } from '../server/knowledge.js';
import type { AgentModelInput, AgentModelOptions } from '../server/agent-model.js';
import type {
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
} from '../shared/knowledge-search.js';
import type { AskScope } from '../shared/ask.js';
import { claimKey } from '../server/communication-pipeline.js';
import { retrievalFixture, seedRetrievalFixture } from '../scripts/fixtures/graphiti-retrieval.js';
import { retrievalProjection } from './fixtures/retrieval-projection.js';

const integration = (name: string, fn: () => Promise<void>) => it(name, fn, 30000);

let db: Database, fixture: Awaited<ReturnType<typeof seedRetrievalFixture>>;
let seen: AgentModelInput[] = [],
  searched: KnowledgeSearchRequest[] = [];
let classifier: (input: AgentModelInput) => unknown;
let failSearch = false;
let searchHook: (() => Promise<void>) | undefined;
const run = <T>(fn: Parameters<typeof scoped<T>>[3]) =>
  scoped(db, fixture.actorId, fixture.workspaceId, fn);
const scope = (object: 'customers' | 'projects' = 'customers'): AskScope => ({
  kind: 'entity',
  object,
  customer_id: fixture.customer,
  record_id: object === 'customers' ? fixture.customer : fixture.project,
});
const classification = (
  target: string,
  action = 'lookup_entity',
  entity_type = 'company',
  extra: Record<string, unknown> = {},
) => ({
  mail_action: null,
  intent: '查询资料',
  action,
  entity_type,
  target,
  match_mode: 'name',
  candidate_index: null,
  data_source: 'records',
  missing: [],
  reply: '查询虚构验收资料。',
  ...extra,
});
function options(): AgentModelOptions {
  return {
    knowledgeSearch: {
      async search(request) {
        searched.push(structuredClone(request));
        if (failSearch) throw new Error('controlled runner failure');
        await searchHook?.();
        const record = request.query.includes('里面') ? fixture.comfortRecord : fixture.oldRecord;
        const id = claimKey(record, 'claim');
        const partition = request.partitions.find((p) => p.fact_ids.includes(id));
        if (!partition)
          throw new Error('Expected authorized historical fact absent from search request');
        return {
          protocol: 'graphiti-hybrid-search-v1',
          strategy: 'graphiti-bm25-cosine-rrf',
          hits: [{ fact_id: id, group: partition.group, rank: 1, score: 1 }],
          diagnostics: {
            embedding_dimensions: 384,
            partitions: request.partitions.length,
            keyword_candidates: 1,
            vector_candidates: 1,
          },
        } satisfies KnowledgeSearchResponse;
      },
    },
    transport: {
      async generate(input) {
        seen.push(structuredClone(input));
        if (input.phase === 'classify') return classifier(input);
        return answer(input);
      },
      async stream(input, stream) {
        seen.push(structuredClone(input));
        await stream.onText('已找到历史需求。');
        await stream.onText('保留原说法与纠正。');
        return answer(input);
      },
    },
  };
}
function answer(input: AgentModelInput) {
  return {
    answer: '客户先预计100件，后纠正为80件；尚未成为公司承诺。',
    source_ids: input.snapshot.sources
      .filter((s) =>
        [fixture.oldRecord, fixture.revisedRecord, fixture.comfortRecord].some(
          (id) => s.id === `record::${id}`,
        ),
      )
      .map((s) => s.id),
  };
}
async function chat() {
  return (
    await run((ctx) =>
      createChat(ctx, { id: randomUUID(), title: '虚构混合召回集成', customer_id: null }),
    )
  ).id;
}
async function send(id: string, body: string) {
  return sendWithModel(
    db,
    fixture.actorId,
    fixture.workspaceId,
    id,
    { request_id: randomUUID(), action: 'message', body },
    options(),
  );
}
beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  fixture = await seedRetrievalFixture(db);
  await syncKnowledgeOnce(
    db,
    { sync: retrievalProjection, async discard() {} },
    { workspace_id: fixture.workspaceId, customer_id: fixture.customer },
  );
  expect((await run((ctx) => knowledgeView(ctx, fixture.customer))).state).toBe('ready');
}, 30000);
afterAll(() => db.close());
beforeEach(() => {
  seen = [];
  searched = [];
  failSearch = false;
  searchHook = undefined;
  classifier = () => classification(retrievalFixture.company);
});

integration(
  'places the target history outside both baseline windows before testing retrieval',
  async () => {
    expect(fixture.recordCount).toBeGreaterThan(80);
    const baseline = await run((ctx) => modelSnapshot(ctx, scope()));
    for (const id of [fixture.oldRecord, fixture.revisedRecord, fixture.comfortRecord])
      expect(baseline.sources.map((s) => s.id)).not.toContain(`record::${id}`);
    expect(JSON.stringify(baseline)).not.toContain(retrievalFixture.comfort);
  },
);
integration(
  'passes the actual Ask question to search and prioritizes the recalled old Record',
  async () => {
    const question = retrievalFixture.semanticQuestion;
    const result = await modelQuery(
      db,
      fixture.actorId,
      fixture.workspaceId,
      { scope: scope('projects'), question },
      options(),
    );
    expect(searched).toHaveLength(1);
    expect(searched[0].query).toBe(question);
    const model = seen.find((s) => s.phase !== 'classify')!;
    expect(model.snapshot.sources.some((s) => s.id === `record::${fixture.comfortRecord}`)).toBe(
      true,
    );
    expect(
      model.snapshot.sources.findIndex((s) => s.id === `record::${fixture.comfortRecord}`),
    ).toBeLessThan(10);
    expect(JSON.stringify(model.snapshot)).toContain(retrievalFixture.comfort);
    expect(JSON.stringify(model.snapshot)).not.toContain(retrievalFixture.sentinels[1]);
    expect(result!.sources.some((s) => s.id === fixture.comfortRecord && s.kind === 'record')).toBe(
      true,
    );
  },
);
integration(
  'runs homepage classification, unique directory lookup, hybrid search and sourced answer in order',
  async () => {
    const question = `请查${retrievalFixture.company}：${retrievalFixture.correctionQuestion}`;
    const result = await send(await chat(), question);
    expect(seen.map((s) => s.phase)).toEqual(['classify', 'answer']);
    expect(seen[0].snapshot.sources).toEqual([]);
    expect(searched).toHaveLength(1);
    expect(searched[0].query).toBe(question);
    const recordIds = seen[1].snapshot.sources.map((s) => s.id);
    expect(recordIds).toContain(`record::${fixture.oldRecord}`);
    expect(recordIds).toContain(`record::${fixture.revisedRecord}`);
    expect(JSON.stringify(seen[1].snapshot)).toContain('明确纠正候选');
    expect(result!.messages.at(-1)!.sources?.map((s) => s.id)).toEqual(
      expect.arrayContaining([fixture.oldRecord, fixture.revisedRecord]),
    );
    expect(JSON.stringify(seen)).not.toContain(retrievalFixture.sentinels[2]);
    expect(JSON.stringify(seen)).not.toContain(retrievalFixture.sentinels[3]);
  },
);
integration(
  'keeps candidate lookup directory-only and searches the saved original question after a selection',
  async () => {
    let selectedIndex = 1;
    classifier = (input) =>
      input.question === '第一个'
        ? classification('', 'select_candidate', 'person', {
            target: null,
            match_mode: null,
            candidate_index: selectedIndex,
          })
        : classification('沈', 'search_candidates', 'person', { match_mode: 'surname' });
    const id = await chat(),
      question = '查姓沈的联系人之前采购数量怎么纠正的，是否已经承诺？';
    const listed = await send(id, question);
    selectedIndex =
      listed!.messages.at(-1)!.retrieval!.candidates.findIndex((c) => c.id === fixture.person) + 1;
    expect(selectedIndex).toBeGreaterThan(0);
    expect(searched).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain('最初预计采购100件');
    await send(id, '第一个');
    expect(searched).toHaveLength(1);
    expect(searched[0].query).toBe(question);
    const last = seen.at(-1)!;
    expect(last.snapshot.sources.some((s) => s.id === `record::${fixture.oldRecord}`)).toBe(true);
    expect(JSON.stringify(last.snapshot)).not.toContain(retrievalFixture.sentinels[0]);
  },
);
integration(
  'keeps Ask continuation valid for another question and searches only once per streamed answer',
  async () => {
    const first = await modelQuery(
      db,
      fixture.actorId,
      fixture.workspaceId,
      { scope: scope('projects'), question: '最初采购多少件？' },
      options(),
    );
    const chunks: string[] = [];
    const second = await modelQuery(
      db,
      fixture.actorId,
      fixture.workspaceId,
      { scope: scope('projects'), question: '后来怎么纠正？', continuation: first!.continuation },
      options(),
      {
        signal: new AbortController().signal,
        async onText(text) {
          chunks.push(text);
        },
      },
    );
    expect(second!.mode).toBe('model');
    expect(searched).toHaveLength(2);
    expect(chunks).toHaveLength(2);
    expect(seen.at(-1)!.history).toHaveLength(2);
  },
);
integration(
  'does not invoke the answer model or persist a chat reply after a runner failure',
  async () => {
    failSearch = true;
    const id = await chat();
    await expect(send(id, retrievalFixture.correctionQuestion)).rejects.toThrow();
    expect(seen.map((s) => s.phase)).toEqual(['classify']);
    expect(
      (await db.query('SELECT count(*)::int AS n FROM chat_messages WHERE chat_id=$1', [id]))
        .rows[0].n,
    ).toBe(0);
  },
);

async function isolatedRaceFixture(fn: () => Promise<void>) {
  const original = fixture;
  try {
    fixture = await seedRetrievalFixture(db, 0);
    await syncKnowledgeOnce(
      db,
      { sync: retrievalProjection, async discard() {} },
      { workspace_id: fixture.workspaceId, customer_id: fixture.customer },
    );
    expect((await run((ctx) => knowledgeView(ctx, fixture.customer))).state).toBe('ready');
    await fn();
  } finally {
    fixture = original;
    searchHook = undefined;
  }
}
async function assertRaceDoesNotAnswer(id: string) {
  // A previous business answer makes the prepared-history regression observable.
  const before = (
    await db.query<{ n: number }>('SELECT count(*)::int AS n FROM chat_messages WHERE chat_id=$1', [
      id,
    ])
  ).rows[0].n;
  expect(before).toBe(2);
  seen = [];
  searched = [];
  await expect(send(id, retrievalFixture.correctionQuestion)).rejects.toMatchObject({
    status: 409,
  });
  expect(searched).toHaveLength(1);
  expect(seen.map((input) => input.phase)).toEqual(['classify']);
  expect(
    (
      await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM chat_messages WHERE chat_id=$1',
        [id],
      )
    ).rows[0].n,
  ).toBe(before);
}
integration(
  'rejects an archived unique target after external search before reusing business history',
  async () => {
    await isolatedRaceFixture(async () => {
      const id = await chat();
      await send(id, retrievalFixture.correctionQuestion);
      searchHook = async () => {
        await run(async (ctx) => {
          const current = await customer(ctx, fixture.customer);
          await update(ctx, 'customers', fixture.customer, {
            version: current.version,
            archived: true,
          });
        });
      };
      await assertRaceDoesNotAnswer(id);
    });
  },
);
integration(
  'rejects newly ambiguous directory matches even when the searched publication is unchanged',
  async () => {
    await isolatedRaceFixture(async () => {
      const id = await chat();
      await send(id, retrievalFixture.correctionQuestion);
      const publication = async () =>
        (
          await db.query(
            'SELECT generation,digest,requested_version,applied_version FROM knowledge_sync WHERE workspace_id=$1 AND customer_id=$2',
            [fixture.workspaceId, fixture.customer],
          )
        ).rows[0];
      const before = await publication();
      searchHook = async () => {
        await run((ctx) =>
          insert(ctx, 'customers', {
            name: retrievalFixture.company,
            type: 'group',
            source: 'other',
          }),
        );
        expect(await publication()).toEqual(before);
      };
      await assertRaceDoesNotAnswer(id);
      expect(await publication()).toEqual(before);
    });
  },
);
