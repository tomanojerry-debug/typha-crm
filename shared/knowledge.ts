import type { AskSource } from './ask.js';
import type { EntitySchema } from './entity-schema.js';

export interface KnowledgeSource {
  id: string;
  record_id: string;
  channel: 'email' | 'wechat' | 'record';
  trust: 'customer_quote' | 'inference' | 'company_confirmed';
  project_id: string | null;
  person_ids: string[];
  occurred_at: string;
  title: string;
  speaker: string;
  speaker_side?: 'internal' | 'external' | 'unknown';
  message_id?: string;
  body: string;
  ref: AskSource;
  /** Immutable note publication identity; included in source digests and every derived index. */
  note?: { id: string; revision_id: string; version: number; content_hash: string };
}
export interface KnowledgeSnapshot {
  workspace_id: string;
  customer_id: string;
  actor_id: string;
  schema: EntitySchema;
  entities: { id: string; object: string; name: string; attributes: Record<string, unknown> }[];
  relationships: { id: string; definition_id: string; source_id: string; target_id: string }[];
  sources: KnowledgeSource[];
}
export interface KnowledgeFact {
  id: string;
  fact: string;
  relation: string;
  valid_at: string | null;
  invalid_at: string | null;
  source_ids: string[];
  project_id: string | null;
  trust: KnowledgeSource['trust'];
}
export interface KnowledgeView {
  state: 'not_synced' | 'pending' | 'syncing' | 'ready' | 'failed' | 'disabled';
  schema_revision: string;
  synced_at: string | null;
  error: string | null;
  can_sync: boolean;
  facts: (KnowledgeFact & {
    sources: (Pick<
      KnowledgeSource,
      'id' | 'record_id' | 'channel' | 'title' | 'speaker' | 'occurred_at' | 'ref'
    > & { excerpt: string })[];
  })[];
}

// Keys include the physical graph partition. The same CRM UUID in a candidate
// partition must never merge its properties into the authoritative CRM node.
export interface KnowledgeGraphNode {
  key: string;
  id: string;
  group: string;
  name: string;
  labels: string[];
  origin: 'crm' | 'candidate' | 'claim';
  object_id: string | null;
  attributes: Record<string, unknown>;
  source_ids: string[];
  record_ids: string[];
}
export interface KnowledgeGraphEdge {
  key: string;
  id: string;
  group: string;
  source: string;
  target: string;
  label: string;
  fact: string;
  kind:
    | 'crm_relationship'
    | 'attribute_candidate'
    | 'relation_candidate'
    | 'explicit_correction'
    | 'proposed_change';
  valid_at: string | null;
  invalid_at: string | null;
  source_ids: string[];
  record_ids: string[];
  project_id: string | null;
  trust: KnowledgeSource['trust'] | null;
}
export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}
export interface KnowledgeGraphView extends KnowledgeView, KnowledgeGraph {
  generation: string | null;
  provenance: 'graphiti_persisted' | 'unavailable';
  sources: KnowledgeView['facts'][number]['sources'];
}
