import type { AgentSource } from './agent.js';
import type { KnowledgeSearchFilter } from '../server/knowledge-search.js';

export const sourceEmbeddingModel = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';
export const sourceEmbeddingRevision =
  'fastembed-onnx-multilingual-minilm-l12-v2-384-token-pool-v1';
export interface LocalEmbeddingTransport {
  embed(input: { texts: string[] }): Promise<{
    model: string;
    dimensions: 384;
    vectors: number[][];
  }>;
}
export type SourceSearchFilter = KnowledgeSearchFilter & { note_only?: boolean };
export interface SourceSearchPrepared {
  scope: {
    workspace_id: string;
    actor_id: string;
    customer_id: string;
    filter: SourceSearchFilter;
  };
  query: string;
  source_digest: string;
  index_version: number;
  model_revision: string;
}
/** Only scope, digests and a query vector: no original business text is persisted here. */
export interface SourceSearchPlan extends Omit<SourceSearchPrepared, 'query'> {
  vector: number[];
}
export interface SourceSearchSelection {
  sources: AgentSource[];
  record_ids: string[];
  digest: string;
  warnings: string[];
}
