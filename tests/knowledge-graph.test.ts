import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { openDatabase, migrate, type Database } from '../server/db.js';
import { createWorkspace } from '../server/bootstrap.js';
import { scoped, type Context } from '../server/security.js';
import * as service from '../server/service.js';
import * as attributes from '../server/attributes.js';
import { createApp } from '../server/app.js';
import { extractSnapshot } from '../server/communication-pipeline.js';
import {
  knowledgeGraphView,
  syncKnowledgeOnce,
  type KnowledgeTransport,
} from '../server/knowledge.js';
import type { KnowledgeGraph, KnowledgeFact } from '../shared/knowledge.js';

let db: Database, workspace: string, actor: string, outsider: string, foreignWorkspace: string;
let customer: string,
  foreignCustomer: string,
  project: string,
  secondProject: string,
  unrelatedPerson: string;
const admin = <T>(fn: (ctx: Context) => Promise<T>) => scoped(db, actor, workspace, fn);
const password = 'graph-fixture-password';
const stableId = (...parts: string[]) => {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

beforeAll(async () => {
  db = await openDatabase();
  await migrate(db);
  const first = await createWorkspace(db, {
    name: 'Graph UI contracts',
    email: 'graph-ui@example.invalid',
    displayName: 'Graph Admin',
    password,
  });
  workspace = first.workspaceId;
  actor = first.actorId;
  const other = await createWorkspace(db, {
    name: 'Foreign graph',
    email: 'foreign-graph-ui@example.invalid',
    displayName: 'Other',
    password,
  });
  outsider = other.actorId;
  foreignWorkspace = other.workspaceId;
  await db.query("INSERT INTO memberships(workspace_id,actor_id,role) VALUES($1,$2,'member')", [
    workspace,
    outsider,
  ]);
  foreignCustomer = String(
    (
      await scoped(db, outsider, foreignWorkspace, (ctx) =>
        service.insert(ctx, 'customers', {
          name: 'FOREIGN PRIVATE',
          type: 'group',
          source: 'email',
        }),
      )
    ).id,
  );
});
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await admin(async (ctx) => {
    customer = String(
      (
        await service.insert(ctx, 'customers', {
          name: '合成图谱客户',
          type: 'group',
          source: 'email',
        })
      ).id,
    );
    project = String(
      (
        await service.insert(ctx, 'projects', {
          customer_id: customer,
          name: '项目一',
          type: 'purchase',
        })
      ).id,
    );
    secondProject = String(
      (
        await service.insert(ctx, 'projects', {
          customer_id: customer,
          name: '项目二私有要求',
          type: 'purchase',
        })
      ).id,
    );
    unrelatedPerson = randomUUID();
    await ctx.tx.query('INSERT INTO people(workspace_id,customer_id,id,name) VALUES($1,$2,$3,$4)', [
      workspace,
      customer,
      unrelatedPerson,
      '未参与项目的联系人',
    ]);
    for (const id of [project, secondProject])
      await service.insert(ctx, 'customer_records', {
        customer_id: customer,
        project_id: id,
        body: '预计采购80件',
        kind: 'customer_quote',
        created_by: actor,
      });
  });
  await db.query('DELETE FROM knowledge_sync WHERE customer_id<>$1', [customer]);
});

// This transport simulates persisted readback for API/authorization tests. The
// separate end-to-end fixture exercises the real MiniMax and Graphiti runtime.
function transport(tamper?: (graph: KnowledgeGraph) => void): KnowledgeTransport {
  return {
    async discard() {},
    async sync(snapshot) {
      const extracted = await extractSnapshot(snapshot, [], async (input) => {
        const m = input.messages[0];
        return {
          version: input.version,
          record_id: input.record_id,
          trust: 'unconfirmed',
          entities: [
            {
              ref: 'company',
              kind: 'company',
              object_id: 'customers',
              canonical_id: customer,
              name: '合成图谱客户',
              evidence: [{ message_id: m.id, quote: m.text }],
            },
          ],
          attributes: [
            {
              id: 'quantity',
              entity_ref: 'company',
              field_id: null,
              field_label: '数量',
              value: { type: 'number', value: 80, unit: '件' },
              speaker_id: m.speaker_id,
              modality: 'estimated',
              effective_at: null,
              evidence: [{ message_id: m.id, quote: m.text }],
            },
          ],
          relations: [],
          changes: [],
          uncertainties: [],
        };
      });
      const graph: KnowledgeGraph = {
        nodes: snapshot.entities.map((e) => ({
          key: `crm:${e.id}`,
          id: e.id,
          group: 'crm',
          name: e.name,
          labels: ['Entity'],
          origin: 'crm',
          object_id: e.object,
          attributes: e.attributes,
          source_ids: [],
          record_ids: [],
        })),
        edges: [],
      };
      const facts: KnowledgeFact[] = [];
      for (const r of snapshot.relationships) {
        const definition = [
          ...snapshot.schema.relationships,
          ...(snapshot.schema.references || []),
        ].find((d) => d.id === r.definition_id)!;
        graph.edges.push({
          key: `crm:${r.id}`,
          id: r.id,
          group: 'crm',
          source: `crm:${r.source_id}`,
          target: `crm:${r.target_id}`,
          label: definition.source_label,
          fact: JSON.stringify(definition),
          kind: 'crm_relationship',
          valid_at: null,
          invalid_at: null,
          source_ids: [],
          record_ids: [],
          project_id: null,
          trust: null,
        });
      }
      for (const r of extracted.records) {
        const group =
          'evidence_' +
          createHash('sha256')
            .update(
              `[${r.project_id ? JSON.stringify(r.project_id) : 'null'}, ${JSON.stringify(r.trust)}]`,
            )
            .digest('hex')
            .slice(0, 32);
        const c = r.output.attributes[0],
          id = stableId(r.output.record_id, c.id);
        const claimSources = [...new Set(c.evidence.map((e) => e.message_id))];
        graph.nodes.push({
          key: `${group}:${customer}`,
          id: customer,
          group,
          name: '合成图谱客户',
          labels: ['Entity', 'Company'],
          origin: 'candidate',
          object_id: 'customers',
          attributes: { canonical_id: customer, candidate: true, object_id: 'customers' },
          source_ids: r.source_ids,
          record_ids: [r.output.record_id],
        });
        graph.nodes.push({
          key: `${group}:${id}`,
          id,
          group,
          name: c.field_label,
          labels: ['Entity', 'Claim'],
          origin: 'claim',
          object_id: null,
          attributes: {
            ...c,
            observed_at: [r.input.messages[0].occurred_at],
            speaker: r.input.speakers[0].name,
          },
          source_ids: claimSources,
          record_ids: [r.output.record_id],
        });
        const fact = {
          id,
          fact: `${r.input.speakers[0].name}（预估）：合成图谱客户 — 数量：80件`,
          relation: c.field_label,
          valid_at: null,
          invalid_at: null,
          source_ids: claimSources,
          project_id: r.project_id,
          trust: r.trust,
        };
        facts.push(fact);
        graph.edges.push({
          key: `${group}:${id}`,
          id,
          group,
          source: `${group}:${customer}`,
          target: `${group}:${id}`,
          label: c.field_label,
          fact: fact.fact,
          kind: 'attribute_candidate',
          valid_at: null,
          invalid_at: null,
          source_ids: claimSources,
          record_ids: [r.output.record_id],
          project_id: r.project_id,
          trust: r.trust,
        });
      }
      tamper?.(graph);
      return { graph, facts, extractions: extracted.extractions };
    },
  };
}
const view = (filter = {}) => admin((ctx) => knowledgeGraphView(ctx, customer, filter));

it('returns persisted graph partitions with closed endpoints and keeps canonical candidate properties separate', async () => {
  await syncKnowledgeOnce(db, transport());
  const result = await view();
  expect(result.state).toBe('ready');
  expect(result.provenance).toBe('graphiti_persisted');
  expect(result.nodes.filter((n) => n.id === customer)).toHaveLength(3);
  const keys = new Set(result.nodes.map((n) => n.key));
  expect(result.edges.every((e) => keys.has(e.source) && keys.has(e.target))).toBe(true);
  expect(result.nodes.find((n) => n.key === `crm:${customer}`)!.attributes).not.toHaveProperty(
    'candidate',
  );
  expect(
    result.nodes.filter((n) => n.origin === 'claim').every((n) => n.record_ids.length === 1),
  ).toBe(true);
});

it('filters every evidence source and excludes other projects and contacts without explicit project participation', async () => {
  await syncKnowledgeOnce(db, transport());
  const result = await view({ project_id: project });
  expect(result.nodes.some((n) => n.id === customer)).toBe(true);
  expect(result.nodes.some((n) => n.id === secondProject || n.id === unrelatedPerson)).toBe(false);
  expect(result.edges.filter((e) => e.kind !== 'crm_relationship')).toHaveLength(1);
  expect(result.facts.every((f) => f.project_id === project)).toBe(true);
  await expect(view({ project_id: randomUUID() })).rejects.toThrow();
});

it('keeps complete WeChat entity nodes when a reviewed greeting produces no claim', async () => {
  await admin(async (ctx) => {
    const record = (
      await ctx.tx.query<{ id: string }>(
        'SELECT id FROM customer_records WHERE customer_id=$1 AND project_id=$2',
        [customer, project],
      )
    ).rows[0].id;
    for (const [index, body] of ['预计采购80件', '收到，谢谢'].entries())
      await ctx.tx.query(
        'INSERT INTO knowledge_wechat_evidence(workspace_id,customer_id,id,source_key,record_id,project_id,occurred_at,speaker,body,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          workspace,
          customer,
          randomUUID(),
          randomUUID(),
          record,
          project,
          `2026-10-22T01:0${index}:00Z`,
          '顾老师',
          body,
          actor,
        ],
      );
  });
  await syncKnowledgeOnce(db, transport());
  const full = await view(),
    filtered = await view({ project_id: project });
  const stored = (
    await db.query<{ graph: KnowledgeGraph }>(
      'SELECT graph FROM knowledge_sync WHERE customer_id=$1',
      [customer],
    )
  ).rows[0].graph;
  expect(full.state).toBe('ready');
  expect(full.nodes).toHaveLength(stored.nodes.length);
  expect(full.edges).toHaveLength(stored.edges.length);
  expect(filtered.nodes.filter((n) => n.origin === 'candidate')).toHaveLength(1);
  expect(filtered.edges.filter((e) => e.kind === 'attribute_candidate')).toHaveLength(1);
  expect(filtered.sources).toHaveLength(2);
  expect(new Set(filtered.facts.flatMap((f) => f.source_ids)).size).toBe(1);
  expect(filtered.nodes.find((n) => n.origin === 'candidate')!.source_ids).toHaveLength(2);
});

it('hides stale graphs after source edits, schema changes, disabled runtime or customer archival', async () => {
  await syncKnowledgeOnce(db, transport());
  await db.query(
    "UPDATE customer_records SET body='maintenance changed source' WHERE customer_id=$1",
    [customer],
  );
  expect((await view()).nodes).toEqual([]);
  expect((await view()).state).toBe('pending');
  await db.query("UPDATE knowledge_sync SET state='pending' WHERE customer_id=$1", [customer]);
  await syncKnowledgeOnce(db, transport());
  await admin((ctx) => attributes.createField(ctx, { name: '新增字段', kind: 'text' }));
  expect((await view()).nodes).toEqual([]);
  expect((await admin((ctx) => knowledgeGraphView(ctx, customer, {}, false))).provenance).toBe(
    'unavailable',
  );
  await admin((ctx) =>
    ctx.tx.query('UPDATE customers SET archived_at=now() WHERE id=$1', [customer]),
  );
  expect((await view()).nodes).toEqual([]);
});

it('enforces customer/workspace authorization and revocation for viewers on every graph request', async () => {
  await syncKnowledgeOnce(db, transport());
  await expect(
    scoped(db, outsider, workspace, (ctx) => knowledgeGraphView(ctx, customer)),
  ).rejects.toThrow();
  await admin((ctx) =>
    ctx.tx.query(
      "INSERT INTO customer_access(workspace_id,customer_id,actor_id,access) VALUES($1,$2,$3,'viewer')",
      [workspace, customer, outsider],
    ),
  );
  const allowed = await scoped(db, outsider, workspace, (ctx) => knowledgeGraphView(ctx, customer));
  expect(allowed.nodes.length).toBeGreaterThan(0);
  expect(allowed.can_sync).toBe(false);
  await admin((ctx) =>
    ctx.tx.query('DELETE FROM customer_access WHERE customer_id=$1 AND actor_id=$2', [
      customer,
      outsider,
    ]),
  );
  await expect(
    scoped(db, outsider, workspace, (ctx) => knowledgeGraphView(ctx, customer)),
  ).rejects.toThrow();
  await expect(admin((ctx) => knowledgeGraphView(ctx, foreignCustomer))).rejects.toThrow();
  const app = createApp(db, { origin: 'http://localhost:3100', knowledgeEnabled: true });
  const session = request.agent(app);
  await session
    .post('/api/auth/login')
    .set('origin', 'http://localhost:3100')
    .send({ email: 'graph-ui@example.invalid', password })
    .expect(200);
  const response = await session
    .get(`/api/customers/${customer}/knowledge/graph`)
    .set('x-workspace-id', workspace)
    .expect(200);
  expect(response.body.provenance).toBe('graphiti_persisted');
  await session
    .get(`/api/customers/${foreignCustomer}/knowledge/graph`)
    .set('x-workspace-id', workspace)
    .expect(404);
  await session
    .get(`/api/customers/${customer}/knowledge/graph?cypher=MATCH`)
    .set('x-workspace-id', workspace)
    .expect(400);
});

it.each([
  'crm',
  'record',
  'endpoint',
  'claim',
  'partition',
  'label',
  'effective',
  'invalidation',
  'definition',
] as const)('rejects graph readback tampering: %s', async (kind) => {
  await syncKnowledgeOnce(
    db,
    transport((graph) => {
      if (kind === 'crm')
        graph.nodes.find((n) => n.origin === 'crm')!.attributes = { name: 'FORGED' };
      if (kind === 'record')
        graph.nodes.find((n) => n.origin === 'claim')!.record_ids = [randomUUID()];
      if (kind === 'endpoint')
        graph.edges.find((e) => e.kind !== 'crm_relationship')!.target = `crm:${foreignCustomer}`;
      if (kind === 'claim')
        graph.nodes.find((n) => n.origin === 'claim')!.attributes.value = {
          type: 'number',
          value: 999,
          unit: '件',
        };
      if (kind === 'partition')
        graph.nodes.find((n) => n.origin === 'claim')!.source_ids = ['foreign-source'];
      if (kind === 'label')
        graph.edges.find((e) => e.kind !== 'crm_relationship')!.label = '伪造字段';
      if (kind === 'effective')
        graph.edges.find((e) => e.kind !== 'crm_relationship')!.valid_at = '2026-10-22T01:00:00Z';
      if (kind === 'invalidation')
        graph.edges.find((e) => e.kind !== 'crm_relationship')!.invalid_at = '2026-10-22T01:00:00Z';
      if (kind === 'definition')
        graph.edges.find((e) => e.kind === 'crm_relationship')!.fact = '{}';
    }),
  );
  const result = await view();
  expect(result.state).toBe('failed');
  expect(result.nodes).toEqual([]);
  expect(result.edges).toEqual([]);
});

it('does not invent nodes when an older facts-only transport has no persisted graph', async () => {
  await syncKnowledgeOnce(db, {
    async discard() {},
    async sync() {
      return [];
    },
  });
  const result = await view();
  expect(result.state).toBe('ready');
  expect(result.provenance).toBe('unavailable');
  expect(result.nodes).toEqual([]);
});
