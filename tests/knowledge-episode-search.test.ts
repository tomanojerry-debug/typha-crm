import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { scoped, type Context } from '../server/security.js';
import * as service from '../server/service.js';
import * as people from '../server/people.js';
import { claimKey } from '../server/communication-pipeline.js';
import { knowledgeAgentSources, syncKnowledgeOnce } from '../server/knowledge.js';
import {
  prepareKnowledgeSearch,
  executeKnowledgeSearch,
  validateKnowledgeSearch,
  type KnowledgeSearchPlan,
  type KnowledgeSearchPrepared,
} from '../server/knowledge-search.js';
import type {
  KnowledgeEpisodeSearchResponse,
  KnowledgeSearchResponse,
} from '../shared/knowledge-search.js';

let db: Database,
  workspace: string,
  actor: string,
  customer: string,
  project: string,
  otherProject: string,
  person: string,
  otherPerson: string;
const admin = <T>(run: (ctx: Context) => Promise<T>) => scoped(db, actor, workspace, run);

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const created = await createWorkspace(db, {
    name: 'Episode search fixture',
    email: 'episode-service@example.invalid',
    displayName: 'Admin',
    password: 'episode-fixture-password',
  });
  workspace = created.workspaceId;
  actor = created.actorId;
});
afterAll(async () => db?.close());
beforeEach(async () => {
  await admin(async (ctx) => {
    customer = String(
      (
        await service.insert(ctx, 'customers', {
          name: '原文搜索客户',
          type: 'group',
          source: 'email',
        })
      ).id,
    );
    project = String(
      (
        await service.insert(ctx, 'projects', {
          customer_id: customer,
          name: '目标项目',
          type: 'purchase',
        })
      ).id,
    );
    otherProject = String(
      (
        await service.insert(ctx, 'projects', {
          customer_id: customer,
          name: '其他项目',
          type: 'purchase',
        })
      ).id,
    );
    person = String(
      (await people.createPerson(ctx, { customer_id: customer, name: '目标联系人' })).id,
    );
    otherPerson = String(
      (await people.createPerson(ctx, { customer_id: customer, name: '其他联系人' })).id,
    );
  });
});

async function record(body: string, offset = 0, projectId: string | null = project) {
  return String(
    (
      await admin((ctx) =>
        service.insert(ctx, 'customer_records', {
          customer_id: customer,
          project_id: projectId,
          kind: 'customer_quote',
          body,
          created_by: actor,
          occurred_at: new Date(Date.UTC(2026, 0, 1 + offset)).toISOString(),
        }),
      )
    ).id,
  );
}
async function fragment(recordId: string, personId: string, body: string) {
  await admin((ctx) =>
    ctx.tx.query(
      'INSERT INTO knowledge_wechat_evidence(workspace_id,id,customer_id,record_id,project_id,person_id,occurred_at,speaker,body,source_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        workspace,
        randomUUID(),
        customer,
        recordId,
        project,
        personId,
        '2026-01-01T00:00:00Z',
        '说话人',
        body,
        randomUUID(),
        actor,
      ],
    ),
  );
}
async function publish() {
  await syncKnowledgeOnce(
    db,
    {
      async sync() {
        return [];
      },
      async discard() {},
    },
    {
      workspace_id: workspace,
      customer_id: customer,
    },
  );
  // A production bridge can publish Episodes with zero extracted facts. There
  // are intentionally no graph facts to help this test retrieve its source.
  await db.query('UPDATE knowledge_sync SET graph=$1::jsonb WHERE customer_id=$2', [
    JSON.stringify({ nodes: [], edges: [] }),
    customer,
  ]);
}
const prepare = (query = '公司主打服装', filter = {}) =>
  admin((ctx) => prepareKnowledgeSearch(ctx, customer, query, filter));
function response(
  prepared: KnowledgeSearchPrepared,
  recordIds: string[],
): KnowledgeEpisodeSearchResponse {
  return {
    protocol: 'graphiti-episode-search-v1',
    strategy: 'graphiti-episode-bm25',
    hits: recordIds.map((id, index) => ({
      episode_id: claimKey(id, 'episode'),
      group: prepared.episode_candidates!.find((candidate) => candidate.record_ids.includes(id))!
        .group,
      rank: index + 1,
      score: 1 / (61 + index),
    })),
    diagnostics: {
      partitions: prepared.episode_request!.partitions.length,
      keyword_candidates: recordIds.length,
    },
  };
}
const noFactSearch = async (): Promise<KnowledgeSearchResponse> => {
  throw new Error('No facts must mean no fact search');
};

it('retrieves a factless old Episode beyond recent Records and supplies one authoritative source', async () => {
  const old = await record('主打儿童芭蕾练功服和舞台演出裙，不经营婚纱。');
  for (let index = 0; index < 43; index++) await record(`无关包装资料${index}`, index + 1);
  await publish();
  expect(
    (await admin((ctx) => knowledgeAgentSources(ctx, customer))).some(
      (source) => source.ref?.id === old,
    ),
  ).toBe(false);
  const prepared = await prepare();
  expect(prepared.request!.partitions).toEqual([]);
  expect(prepared.episode_request!.query).toBe('公司主打服装');
  expect(
    prepared.episode_request!.partitions.flatMap((partition) => partition.episode_ids),
  ).toContain(claimKey(old, 'episode'));
  let calls = 0;
  const plan = await executeKnowledgeSearch(prepared, {
    search: noFactSearch,
    async searchEpisodes(request) {
      calls++;
      expect(request.generation).toBe(prepared.publication.generation);
      return response(prepared, [old]);
    },
  });
  expect(plan.selection.fact_ids).toEqual([]);
  expect(plan.selection.episode_record_ids).toEqual([old]);
  const sources = await admin(async (ctx) =>
    knowledgeAgentSources(ctx, customer, {}, await validateKnowledgeSearch(ctx, plan)),
  );
  expect(sources[0].ref?.id).toBe(old);
  expect(sources[0].body).toContain('儿童芭蕾练功服');
  expect(sources.filter((source) => source.ref?.id === old)).toHaveLength(1);
  expect(calls).toBe(1);
});

it('filters project Episode IDs before search rather than trimming search hits afterward', async () => {
  const own = await record('目标项目服装');
  const another = await record('其他项目私有服装', 1, otherProject);
  const company = await record('公司层资料', 2, null);
  await publish();
  const prepared = await prepare('服装', { project_id: project });
  const ids = prepared.episode_request!.partitions.flatMap((partition) => partition.episode_ids);
  expect(ids).toEqual([claimKey(own, 'episode')]);
  expect(ids).not.toContain(claimKey(another, 'episode'));
  expect(ids).not.toContain(claimKey(company, 'episode'));
});

it('excludes mixed-person Episodes entirely while retaining fully authorized Records', async () => {
  const mixed = await record('私有消息不得由整条Episode全文匹配');
  await fragment(mixed, person, '目标联系人可见内容');
  await fragment(mixed, otherPerson, 'PRIVATE_SENTINEL');
  const own = await record('全部属于目标联系人');
  await fragment(own, person, '可见的主营服装');
  await publish();
  const prepared = await prepare('PRIVATE_SENTINEL', { person_id: person });
  expect(prepared.episode_candidates!.flatMap((candidate) => candidate.record_ids)).toEqual([own]);
  const plan = await executeKnowledgeSearch(prepared, {
    search: noFactSearch,
    async searchEpisodes() {
      return response(prepared, [own]);
    },
  });
  const sources = await admin((ctx) =>
    knowledgeAgentSources(ctx, customer, { person_id: person }, plan.selection),
  );
  expect(sources.map((source) => source.body).join('')).not.toContain('PRIVATE_SENTINEL');
  const forged = { ...plan, selection: { ...plan.selection, episode_record_ids: [mixed] } };
  await expect(admin((ctx) => validateKnowledgeSearch(ctx, forged))).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    admin((ctx) => knowledgeAgentSources(ctx, customer, { person_id: person }, forged.selection)),
  ).rejects.toMatchObject({ status: 409 });
});

it('rejects Episode identity, partition, duplicate, rank and protocol errors', async () => {
  const id = await record('主营服装');
  await publish();
  const prepared = await prepare();
  const invalids = [
    { ...response(prepared, [id]), protocol: 'other' },
    {
      ...response(prepared, [id]),
      hits: [{ ...response(prepared, [id]).hits[0], episode_id: randomUUID() }],
    },
    {
      ...response(prepared, [id]),
      hits: [{ ...response(prepared, [id]).hits[0], group: 'evidence_' + 'f'.repeat(32) }],
    },
    response(prepared, [id, id]),
    { ...response(prepared, [id]), hits: [{ ...response(prepared, [id]).hits[0], rank: 2 }] },
    { ...response(prepared, [id]), diagnostics: { partitions: 0, keyword_candidates: 1 } },
  ];
  for (const invalid of invalids)
    await expect(
      executeKnowledgeSearch(prepared, {
        search: noFactSearch,
        async searchEpisodes() {
          return invalid as KnowledgeEpisodeSearchResponse;
        },
      }),
    ).rejects.toMatchObject({ status: 502 });
});

it('fails explicitly on a configured Episode runtime error', async () => {
  await record('主营服装');
  await publish();
  await expect(
    executeKnowledgeSearch(await prepare(), {
      search: noFactSearch,
      async searchEpisodes() {
        throw new Error('private details');
      },
    }),
  ).rejects.toMatchObject({ status: 503 });
});

it('runs both searches concurrently and preserves correction closure for an Episode-only hit', async () => {
  const old = await record('原预估100件');
  const revised = await record('纠正为80件', 1);
  await publish();
  const prepared = await prepare('数量');
  const group = prepared.episode_candidates![0].group;
  const [oldFact, newFact, correction] = [randomUUID(), randomUUID(), randomUUID()];
  prepared.candidates = [
    { id: oldFact, group, record_ids: [old] },
    { id: newFact, group, record_ids: [revised] },
    { id: correction, group, record_ids: [old, revised] },
  ];
  prepared.correction_groups = [[oldFact, newFact, correction]];
  prepared.request!.partitions = [{ group, fact_ids: [oldFact, newFact, correction] }];
  let factStarted = false,
    episodeStarted = false;
  let releaseFact!: () => void;
  const episodeHasStarted = new Promise<void>((resolve) => {
    releaseFact = resolve;
  });
  const plan = await executeKnowledgeSearch(prepared, {
    async search() {
      factStarted = true;
      await episodeHasStarted;
      expect(episodeStarted).toBe(true);
      return {
        protocol: 'graphiti-hybrid-search-v1',
        strategy: 'graphiti-bm25-cosine-rrf',
        hits: [],
        diagnostics: {
          embedding_dimensions: 384,
          partitions: 1,
          keyword_candidates: 0,
          vector_candidates: 0,
        },
      };
    },
    async searchEpisodes() {
      episodeStarted = true;
      expect(factStarted).toBe(true);
      releaseFact();
      return response(prepared, [old]);
    },
  });
  expect(new Set(plan.selection.fact_ids)).toEqual(new Set([oldFact, newFact, correction]));
  expect(plan.selection.episode_record_ids).toEqual([old]);
  expect(plan.selection.atomic_record_groups.map((ids) => new Set(ids))).toEqual([
    new Set([old, revised]),
  ]);
});

it('revalidates fixed Episode selections after source changes and actor changes', async () => {
  const id = await record('主营服装');
  await publish();
  const prepared = await prepare();
  const plan = await executeKnowledgeSearch(prepared, {
    search: noFactSearch,
    async searchEpisodes() {
      return response(prepared, [id]);
    },
  });
  expect((await admin((ctx) => validateKnowledgeSearch(ctx, plan))).episode_record_ids).toEqual([
    id,
  ]);
  await expect(
    admin((ctx) => validateKnowledgeSearch({ ...ctx, actorId: randomUUID() }, plan)),
  ).rejects.toMatchObject({ status: 409 });
  await record('新来源令代次过期', 1);
  await expect(admin((ctx) => validateKnowledgeSearch(ctx, plan))).rejects.toMatchObject({
    status: 409,
  });
});

it('accurately reports when a legacy runtime does not implement Episode search', async () => {
  await record('主营服装');
  await publish();
  const plan = await executeKnowledgeSearch(await prepare(), { search: noFactSearch });
  expect(plan.selection.episode_record_ids).toEqual([]);
  expect(plan.selection.warning).toContain('Episode原文检索运行器未配置');
  expect(plan.selection.warning).toContain('未命中不代表资料不存在');
});

it('keeps the same Episode selection after its fixed plan round-trips through JSONB', async () => {
  const id = await record('只有旧原文支持的主营服装');
  await publish();
  const prepared = await prepare();
  const plan = await executeKnowledgeSearch(prepared, {
    search: noFactSearch,
    async searchEpisodes() {
      return response(prepared, [id]);
    },
  });
  const stored = (
    await db.query<{ plan: KnowledgeSearchPlan }>('SELECT $1::jsonb AS plan', [
      JSON.stringify(plan),
    ])
  ).rows[0].plan;
  const sources = await admin(async (ctx) =>
    knowledgeAgentSources(ctx, customer, {}, await validateKnowledgeSearch(ctx, stored)),
  );
  expect(stored.selection.episode_record_ids).toEqual([id]);
  expect(sources.filter((source) => source.ref?.id === id)).toHaveLength(1);
  expect(sources[0].body).toContain('只有旧原文支持的主营服装');
});

it('rejects a fixed Episode plan when the same active member loses customer access', async () => {
  const member = await createWorkspace(db, {
    name: 'Episode permission fixture',
    email: `episode-member-${randomUUID()}@example.invalid`,
    displayName: 'Member',
    password: 'episode-member-fixture-password',
  });
  await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
    workspace,
    member.actorId,
  ]);
  await admin((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'viewer')",
      [workspace, customer, member.actorId],
    ),
  );
  const id = await record('授权存在时可以检索的原文');
  await publish();
  const prepared = await scoped(db, member.actorId, workspace, (ctx) =>
    prepareKnowledgeSearch(ctx, customer, '主营服装'),
  );
  const plan = await executeKnowledgeSearch(prepared, {
    search: noFactSearch,
    async searchEpisodes() {
      return response(prepared, [id]);
    },
  });
  expect(
    (await scoped(db, member.actorId, workspace, (ctx) => validateKnowledgeSearch(ctx, plan)))
      .episode_record_ids,
  ).toEqual([id]);
  await admin((ctx) =>
    ctx.tx.query(
      'DELETE FROM customer_access WHERE workspace_id=$1 AND customer_id=$2 AND actor_id=$3',
      [workspace, customer, member.actorId],
    ),
  );
  await expect(
    scoped(db, member.actorId, workspace, (ctx) => validateKnowledgeSearch(ctx, plan)),
  ).rejects.toMatchObject({ status: 409 });
});
