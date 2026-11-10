import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { scoped, type Context } from '../server/security.js';
import * as service from '../server/service.js';
import * as people from '../server/people.js';
import * as attributes from '../server/attributes.js';
import {
  knowledgeAgentSources,
  knowledgeSnapshot,
  syncKnowledgeOnce,
} from '../server/knowledge.js';
import {
  prepareKnowledgeSearch,
  executeKnowledgeSearch,
  validateKnowledgeSearch,
  type KnowledgeSearchPrepared,
} from '../server/knowledge-search.js';
import type { KnowledgeFact, KnowledgeGraph, KnowledgeSnapshot } from '../shared/knowledge.js';
import type {
  KnowledgeSearchResponse,
  KnowledgeSearchTransport,
} from '../shared/knowledge-search.js';

let db: Database,
  workspace: string,
  actor: string,
  member: string,
  otherWorkspace: string,
  customer: string,
  otherCustomer: string,
  project: string,
  otherProject: string,
  person: string;
const admin = <T>(run: (ctx: Context) => Promise<T>) => scoped(db, actor, workspace, run);

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const first = await createWorkspace(db, {
    name: 'Hybrid service fixture',
    email: 'hybrid-service@example.invalid',
    displayName: 'Admin',
    password: 'hybrid-fixture-password',
  });
  actor = first.actorId;
  workspace = first.workspaceId;
  const second = await createWorkspace(db, {
    name: 'Other hybrid fixture',
    email: 'hybrid-service-other@example.invalid',
    displayName: 'Other',
    password: 'hybrid-fixture-password',
  });
  member = second.actorId;
  otherWorkspace = second.workspaceId;
  await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
    workspace,
    member,
  ]);
});
afterAll(async () => db?.close());
beforeEach(async () => {
  await admin(async (ctx) => {
    customer = String(
      (await service.insert(ctx, 'customers', { name: '检索客户', type: 'group', source: 'email' }))
        .id,
    );
    otherCustomer = String(
      (
        await service.insert(ctx, 'customers', {
          name: 'OTHER PRIVATE',
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
          customer_id: otherCustomer,
          name: 'OTHER PROJECT',
          type: 'purchase',
        })
      ).id,
    );
    person = String(
      (await people.createPerson(ctx, { customer_id: customer, name: '目标联系人' })).id,
    );
  });
});

async function record(body: string, at: string, projectId: string | null = project) {
  return String(
    (
      await admin((ctx) =>
        service.insert(ctx, 'customer_records', {
          customer_id: customer,
          project_id: projectId,
          body,
          kind: 'customer_quote',
          created_by: actor,
          occurred_at: at,
        }),
      )
    ).id,
  );
}
const groupOf = (projectId: string | null) =>
  'evidence_' +
  createHash('sha256')
    .update(`[${projectId ? JSON.stringify(projectId) : 'null'}, "customer_quote"]`)
    .digest('hex')
    .slice(0, 32);

function graphOf(
  snapshot: KnowledgeSnapshot,
  facts: KnowledgeFact[],
  changes: [string, string, string][],
) {
  const graph: KnowledgeGraph = { nodes: [], edges: [] };
  const sourceMap = new Map(snapshot.sources.map((source) => [source.id, source]));
  for (const fact of facts) {
    const group = groupOf(fact.project_id);
    const record_ids = [...new Set(fact.source_ids.map((id) => sourceMap.get(id)!.record_id))];
    const key = `${group}:${fact.id}`;
    graph.nodes.push({
      key,
      id: fact.id,
      group,
      name: fact.relation,
      labels: ['Claim'],
      origin: 'claim',
      object_id: null,
      attributes: {},
      source_ids: fact.source_ids,
      record_ids,
    });
    const change = changes.find(([id]) => id === fact.id);
    graph.edges.push({
      key,
      id: fact.id,
      group,
      source: change ? `${group}:${change[1]}` : key,
      target: change ? `${group}:${change[2]}` : key,
      label: fact.relation,
      fact: fact.fact,
      kind: change ? 'explicit_correction' : 'attribute_candidate',
      valid_at: fact.valid_at,
      invalid_at: fact.invalid_at,
      source_ids: fact.source_ids,
      record_ids,
      project_id: fact.project_id,
      trust: fact.trust,
    });
  }
  return graph;
}

async function publish(recordIds: string[], withChange = false) {
  const ids = recordIds.map(() => randomUUID());
  const changeId = randomUUID();
  let facts: KnowledgeFact[] = [];
  await syncKnowledgeOnce(
    db,
    {
      async sync(snapshot) {
        facts = recordIds.map((recordId, index) => {
          const source = snapshot.sources.find((item) => item.record_id === recordId)!;
          return {
            id: ids[index],
            fact: source.body,
            relation: '采购数量',
            source_ids: [source.id],
            project_id: source.project_id,
            trust: source.trust,
            valid_at: null,
            invalid_at: null,
          };
        });
        if (withChange)
          facts.push({
            ...facts[1],
            id: changeId,
            relation: '明确纠正候选',
            fact: '原100件改为80件；没有自动成为公司确认',
            source_ids: [facts[0].source_ids[0], facts[1].source_ids[0]],
          });
        // The production bridge publishes newest evidence first. This makes
        // the baseline 60-fact and 40-Record windows a meaningful comparison.
        const sourceMap = new Map(snapshot.sources.map((source) => [source.id, source]));
        const observedAt = (fact: KnowledgeFact) =>
          Math.max(...fact.source_ids.map((id) => Date.parse(sourceMap.get(id)!.occurred_at)));
        facts.sort((left, right) => observedAt(right) - observedAt(left));
        return facts;
      },
      async discard() {},
    },
    { workspace_id: workspace, customer_id: customer },
  );
  const snapshot = await admin((ctx) => knowledgeSnapshot(ctx, customer));
  const graph = graphOf(snapshot, facts, withChange ? [[changeId, ids[1], ids[0]]] : []);
  await db.query('UPDATE knowledge_sync SET graph=$1::jsonb WHERE customer_id=$2', [
    JSON.stringify(graph),
    customer,
  ]);
  return { ids, changeId, facts };
}
function response(prepared: KnowledgeSearchPrepared, ids: string[]): KnowledgeSearchResponse {
  return {
    protocol: 'graphiti-hybrid-search-v1',
    strategy: 'graphiti-bm25-cosine-rrf',
    hits: ids.map((id, index) => ({
      fact_id: id,
      group: prepared.candidates.find((candidate) => candidate.id === id)!.group,
      rank: index + 1,
      score: 1 / (61 + index),
    })),
    diagnostics: {
      embedding_dimensions: 384,
      partitions: prepared.request!.partitions.length,
      keyword_candidates: ids.length,
      vector_candidates: ids.length,
    },
  };
}
const prepare = (query = '之前采购件数有没有改变？', filter = {}) =>
  admin((ctx) => prepareKnowledgeSearch(ctx, customer, query, filter));

it('binds query, current actor, publication and permitted physical partitions', async () => {
  const first = await record('100件', '2026-01-01T00:00:00Z');
  const company = await record('公司层信息', '2026-01-02T00:00:00Z', null);
  const published = await publish([first, company]);
  const prepared = await prepare('旧订单是多少？', { project_id: project });
  expect(prepared.status).toBe('ready');
  expect(prepared.scope).toEqual({
    actor_id: actor,
    workspace_id: workspace,
    customer_id: customer,
    filter: { project_id: project },
  });
  expect(prepared.request).toMatchObject({ query: '旧订单是多少？', limit: 30 });
  expect(prepared.request!.partitions).toEqual([
    { group: groupOf(project), fact_ids: [published.ids[0]] },
  ]);
  expect(prepared.publication.source_digest).toMatch(/^[a-f0-9]{64}$/);
  await expect(prepare('问题', { project_id: otherProject })).rejects.toThrow();
  await expect(
    scoped(db, member, workspace, (ctx) => prepareKnowledgeSearch(ctx, customer, '私人资料')),
  ).rejects.toThrow();
  await expect(
    scoped(db, actor, otherWorkspace, (ctx) => prepareKnowledgeSearch(ctx, customer, '私人资料')),
  ).rejects.toThrow();
});

it('finds old evidence beyond the recent window and keeps the complete correction chain first', async () => {
  const first = await record('预估100件', '2026-01-01T00:00:00Z');
  const revised = await record('请把100件纠正为80件', '2026-01-02T00:00:00Z');
  const noise: string[] = [];
  for (let index = 0; index < 70; index++)
    noise.push(
      await record(
        `近期无关包装噪声${index}`,
        new Date(Date.UTC(2026, 2, index + 1)).toISOString(),
      ),
    );
  const published = await publish([first, revised, ...noise], true);
  const baseline = await admin((ctx) => knowledgeAgentSources(ctx, customer));
  expect(baseline.some((source) => [first, revised].includes(source.ref?.id || ''))).toBe(false);
  const prepared = await prepare();
  let searches = 0;
  const plan = await executeKnowledgeSearch(prepared, {
    async search(request) {
      searches++;
      expect(request.query).toBe('之前采购件数有没有改变？');
      return response(prepared, [published.ids[0]]);
    },
  });
  expect(new Set(plan.selection.fact_ids)).toEqual(
    new Set([published.ids[0], published.ids[1], published.changeId]),
  );
  expect(plan.selection.atomic_record_groups).toHaveLength(1);
  expect(new Set(plan.selection.atomic_record_groups[0])).toEqual(new Set([first, revised]));
  await admin(async (ctx) => {
    const selection = await validateKnowledgeSearch(ctx, plan);
    await validateKnowledgeSearch(ctx, plan); // Stream rechecks use no transport or embedding.
    const bundles = await knowledgeAgentSources(ctx, customer, {}, selection);
    expect(new Set(bundles.slice(0, 2).map((source) => source.ref!.id))).toEqual(
      new Set([first, revised]),
    );
    expect(bundles.filter((source) => source.ref?.id === first)).toHaveLength(1);
    expect(bundles[0].body).toContain('derived_facts');
    expect(
      bundles.slice(2).every((source) => JSON.parse(source.body).derived_facts.length === 0),
    ).toBe(true);
  });
  expect(searches).toBe(1);
});

it('does not expose an isolated correction endpoint in a person scope', async () => {
  const first = await record('别人转述100件', '2026-01-01T00:00:00Z');
  const revised = await record('本人纠正80件', '2026-01-02T00:00:00Z');
  // Establish an explicit saved fragment link for the new statement only. A
  // person scope cannot read the other statement solely because it is nearby.
  await admin((ctx) =>
    ctx.tx.query(
      'INSERT INTO knowledge_wechat_evidence(workspace_id,id,customer_id,record_id,project_id,person_id,occurred_at,speaker,body,source_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        workspace,
        randomUUID(),
        customer,
        revised,
        project,
        person,
        '2026-01-02T00:00:00Z',
        '本人',
        '本人纠正80件',
        randomUUID(),
        actor,
      ],
    ),
  );
  await publish([first, revised], true);
  const prepared = await prepare('数量是否变化', { person_id: person });
  expect(prepared.status).toBe('ready');
  expect(prepared.request!.partitions).toEqual([]);
  expect(prepared.candidates).toEqual([]);
});

it('fails closed on configured transport failure, invalid protocol and out-of-scope hit identities', async () => {
  const first = await record('100件', '2026-01-01T00:00:00Z');
  const published = await publish([first]);
  const prepared = await prepare();
  await expect(
    executeKnowledgeSearch(prepared, {
      async search() {
        throw new Error('private failure');
      },
    }),
  ).rejects.toMatchObject({ status: 503 });
  await expect(
    executeKnowledgeSearch(prepared, {
      async search() {
        return {} as KnowledgeSearchResponse;
      },
    }),
  ).rejects.toMatchObject({ status: 502 });
  const invalid = response(prepared, [published.ids[0]]);
  invalid.hits[0].fact_id = randomUUID();
  await expect(
    executeKnowledgeSearch(prepared, {
      async search() {
        return invalid;
      },
    }),
  ).rejects.toMatchObject({ status: 502 });
  const wrongGroup = response(prepared, [published.ids[0]]);
  wrongGroup.hits[0].group = groupOf(null);
  await expect(
    executeKnowledgeSearch(prepared, {
      async search() {
        return wrongGroup;
      },
    }),
  ).rejects.toMatchObject({ status: 502 });
  const duplicate = response(prepared, [published.ids[0], published.ids[0]]);
  await expect(
    executeKnowledgeSearch(prepared, {
      async search() {
        return duplicate;
      },
    }),
  ).rejects.toMatchObject({ status: 502 });
});

it('reports unavailable graph or runtime accurately while preserving a fixed revalidation plan', async () => {
  await record('授权原文仍可读', '2026-01-01T00:00:00Z');
  const pending = await prepare();
  const plan = await executeKnowledgeSearch(pending);
  expect(plan.status).toBe('unavailable');
  expect(plan.selection.warning).toContain('pending');
  expect(plan.selection.fact_ids).toEqual([]);
  expect((await admin((ctx) => validateKnowledgeSearch(ctx, plan))).warning).toContain('未执行');
  await record('新原文', '2026-01-02T00:00:00Z');
  await expect(admin((ctx) => validateKnowledgeSearch(ctx, plan))).rejects.toMatchObject({
    status: 409,
  });
  const rows = (await admin((ctx) => knowledgeSnapshot(ctx, customer))).sources;
  await publish(rows.map((source) => source.record_id));
  const ready = await prepare();
  const noRuntime = await executeKnowledgeSearch(ready);
  expect(noRuntime.status).toBe('unavailable');
  expect(noRuntime.selection.warning).toContain('运行器未配置');
  expect((await admin((ctx) => validateKnowledgeSearch(ctx, noRuntime))).fact_ids).toEqual([]);
});

it('rejects changed generation, source, schema, actor and access before reusing IDs', async () => {
  const first = await record('100件', '2026-01-01T00:00:00Z');
  const published = await publish([first]);
  const prepared = await prepare();
  const transport: KnowledgeSearchTransport = {
    async search() {
      return response(prepared, [published.ids[0]]);
    },
  };
  const plan = await executeKnowledgeSearch(prepared, transport);
  await expect(
    scoped(db, member, workspace, (ctx) => validateKnowledgeSearch(ctx, plan)),
  ).rejects.toMatchObject({ status: 409 });
  const generation = prepared.publication.generation;
  await db.query('UPDATE knowledge_sync SET generation=$1 WHERE customer_id=$2', [
    randomUUID(),
    customer,
  ]);
  await expect(admin((ctx) => validateKnowledgeSearch(ctx, plan))).rejects.toMatchObject({
    status: 409,
  });
  await db.query('UPDATE knowledge_sync SET generation=$1 WHERE customer_id=$2', [
    generation,
    customer,
  ]);
  await admin((ctx) =>
    attributes.createField(ctx, { name: '检索字典变更' + customer, kind: 'text' }),
  );
  await expect(admin((ctx) => validateKnowledgeSearch(ctx, plan))).rejects.toMatchObject({
    status: 409,
  });
  await admin((ctx) =>
    ctx.tx.query(
      'INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,$4)',
      [workspace, customer, member, 'viewer'],
    ),
  );
  const memberPrepared = await scoped(db, member, workspace, (ctx) =>
    prepareKnowledgeSearch(ctx, customer, '问题'),
  );
  const memberPlan = await executeKnowledgeSearch(memberPrepared);
  await admin((ctx) =>
    ctx.tx.query('DELETE FROM customer_access WHERE customer_id=$1 AND actor_id=$2', [
      customer,
      member,
    ]),
  );
  await expect(
    scoped(db, member, workspace, (ctx) => validateKnowledgeSearch(ctx, memberPlan)),
  ).rejects.toThrow();
});
