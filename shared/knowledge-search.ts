/** Server-validated, read-only search of an immutable customer graph generation. */
export interface KnowledgeSearchRequest {
  workspace_id: string;
  customer_id: string;
  generation: string;
  query: string;
  partitions: { group: string; fact_ids: string[] }[];
  limit: number;
}

export interface KnowledgeSearchResponse {
  protocol: 'graphiti-hybrid-search-v1';
  strategy: 'graphiti-bm25-cosine-rrf';
  hits: { fact_id: string; group: string; rank: number; score: number }[];
  diagnostics: {
    embedding_dimensions: 384;
    partitions: number;
    keyword_candidates: number;
    vector_candidates: number;
  };
}

export interface KnowledgeSearchTransport {
  search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse>;
  searchEpisodes?(request: KnowledgeEpisodeSearchRequest): Promise<KnowledgeEpisodeSearchResponse>;
}

/** Original Episode text is searched by Graphiti's BM25 path, without new embeddings. */
export interface KnowledgeEpisodeSearchRequest {
  workspace_id: string;
  customer_id: string;
  generation: string;
  query: string;
  partitions: { group: string; episode_ids: string[] }[];
  limit: number;
}

export interface KnowledgeEpisodeSearchResponse {
  protocol: 'graphiti-episode-search-v1';
  strategy: 'graphiti-episode-bm25';
  /** Scores are official RRF scores across partition-local BM25 rankings. */
  hits: { episode_id: string; group: string; rank: number; score: number }[];
  diagnostics: { partitions: number; keyword_candidates: number };
}

/** Validated IDs only; authoritative text is re-read under current CRM permissions. */
export interface KnowledgeSelection {
  fact_ids: string[];
  episode_record_ids?: string[];
  atomic_record_groups: string[][];
  warning: string;
}
