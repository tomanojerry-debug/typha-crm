// Controlled persisted-result substitute for integration tests. Real local
// Graphiti embeddings/search are exercised by verify-graphiti-retrieval.ts.
import { createHash } from 'node:crypto';
import { claimKey, extractSnapshot } from '../../server/communication-pipeline.js';
import { deterministicRetrievalExtraction } from '../../scripts/fixtures/graphiti-retrieval.js';
import type { KnowledgeSnapshot, KnowledgeGraph, KnowledgeFact } from '../../shared/knowledge.js';

export const groupOf = (project: string | null, trust: string) =>
  'evidence_' +
  createHash('sha256')
    .update(`[${project ? JSON.stringify(project) : 'null'}, ${JSON.stringify(trust)}]`)
    .digest('hex')
    .slice(0, 32);

export async function retrievalProjection(snapshot: KnowledgeSnapshot) {
  const extracted = await extractSnapshot(snapshot, [], deterministicRetrievalExtraction);
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
  const sources = new Map(snapshot.sources.map((s) => [s.id, s]));
  const nodeMap = new Map(graph.nodes.map((n) => [n.key, n]));
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
  const claimSources = new Map<string, string[]>();
  const factMap = new Map<string, KnowledgeFact>();
  for (const r of extracted.records) {
    const group = groupOf(r.project_id, r.trust),
      rid = r.output.record_id;
    const identities = new Map(
      r.output.entities.map((e) => [e.ref, e.canonical_id || claimKey(rid, `entity-${e.ref}`)]),
    );
    for (const e of r.output.entities) {
      const id = identities.get(e.ref)!,
        key = `${group}:${id}`;
      const existing = nodeMap.get(key);
      nodeMap.set(key, {
        key,
        id,
        group,
        name: e.name,
        labels: ['Entity', e.kind],
        origin: 'candidate',
        object_id: e.object_id || null,
        attributes: {
          canonical_id: e.canonical_id || '',
          candidate: true,
          object_id: e.object_id || '',
        },
        source_ids: [...new Set([...(existing?.source_ids || []), ...r.source_ids])],
        record_ids: [...new Set([...(existing?.record_ids || []), rid])],
      });
    }
    for (const c of r.output.attributes) {
      const id = claimKey(rid, c.id),
        key = `${group}:${id}`;
      const ids = [...new Set(c.evidence.map((e) => e.message_id))];
      claimSources.set(id, ids);
      const observed = [
        ...new Set(
          c.evidence.map((e) => r.input.messages.find((m) => m.id === e.message_id)!.occurred_at),
        ),
      ];
      nodeMap.set(key, {
        key,
        id,
        group,
        name: c.field_label,
        labels: ['Entity', 'Claim'],
        origin: 'claim',
        object_id: null,
        attributes: {
          ...c,
          observed_at: observed,
          speaker: r.input.speakers.find((s) => s.id === c.speaker_id)!.name,
        },
        source_ids: ids,
        record_ids: [rid],
      });
      const fact = {
        id,
        fact: `${r.input.speakers[0].name}：${c.field_label}：${String(c.value.value)}${c.value.unit || ''}`,
        relation: c.field_label,
        valid_at: null,
        invalid_at: null,
        source_ids: ids,
        project_id: r.project_id,
        trust: r.trust,
      };
      facts.push(fact);
      factMap.set(id, fact);
      graph.edges.push({
        key,
        id,
        group,
        source: `${group}:${identities.get(c.entity_ref)}`,
        target: key,
        label: c.field_label,
        fact: fact.fact,
        kind: 'attribute_candidate',
        valid_at: null,
        invalid_at: null,
        source_ids: ids,
        record_ids: [rid],
        project_id: r.project_id,
        trust: r.trust,
      });
    }
    r.output.changes.forEach((c, i) => {
      const old = c.old_claim_id,
        newer = claimKey(rid, c.new_claim_id);
      // The bridge's stable_id has three arguments for a change edge.
      const hex = createHash('sha256')
        .update(JSON.stringify([rid, 'change', String(i)]))
        .digest('hex');
      const changeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      const ids = [
        ...new Set([
          ...c.evidence.map((e) => e.message_id),
          ...(claimSources.get(old) || []),
          ...(claimSources.get(newer) || []),
        ]),
      ];
      const records = [...new Set(ids.map((s) => sources.get(s)!.record_id))];
      const fact = {
        id: changeId,
        fact: `明确纠正候选：先前「${factMap.get(old)!.fact}」；后续「${factMap.get(newer)!.fact}」。保留原记录，不代表公司确认。`,
        relation: '明确纠正候选',
        valid_at: null,
        invalid_at: null,
        source_ids: ids,
        project_id: r.project_id,
        trust: r.trust,
      };
      facts.push(fact);
      factMap.set(changeId, fact);
      graph.edges.push({
        key: `${group}:${changeId}`,
        id: changeId,
        group,
        source: `${group}:${newer}`,
        target: `${group}:${old}`,
        label: '明确纠正候选',
        fact: fact.fact,
        kind: 'explicit_correction',
        valid_at: null,
        invalid_at: null,
        source_ids: ids,
        record_ids: records,
        project_id: r.project_id,
        trust: r.trust,
      });
      for (const endpoint of [old, newer]) {
        const node = nodeMap.get(`${group}:${endpoint}`)!;
        node.source_ids = [...new Set([...node.source_ids, ...ids])];
        node.record_ids = [...new Set([...node.record_ids, ...records])];
      }
    });
  }
  graph.nodes = [...nodeMap.values()];
  facts.sort(
    (a, b) =>
      Math.max(...b.source_ids.map((s) => Date.parse(sources.get(s)!.occurred_at))) -
      Math.max(...a.source_ids.map((s) => Date.parse(sources.get(s)!.occurred_at))),
  );
  return { facts, graph, extractions: extracted.extractions };
}
