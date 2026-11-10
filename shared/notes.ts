/** Notes are customer-scoped documents. Drafts are actor-private; only publication creates knowledge. */
export type NoteBlockKind = 'paragraph' | 'heading' | 'bullet' | 'numbered' | 'quote';
export interface NoteSourceRef {
  record_id: string;
  source_hash: string;
  quote: string;
  source_id?: string;
  title?: string;
}
export interface NoteBlock {
  id: string;
  type: NoteBlockKind;
  text: string;
  origin: 'original' | 'quote' | 'derived';
  sources: NoteSourceRef[];
}
export interface NoteContent {
  title: string;
  customer_id: string | null;
  project_id: string | null;
  person_ids: string[];
  blocks: NoteBlock[];
}
export interface NoteDraft extends NoteContent {
  id: string;
  note_id: string | null;
  base_revision: number;
  version: number;
  created_at: string;
  updated_at: string;
  /** Server-maintained dependency retained when sourced blocks are removed. */
  title_sources?: NoteSourceRef[];
}
export interface NoteSummary {
  id: string;
  title: string;
  excerpt: string;
  customer_id: string;
  customer_name: string;
  project_id: string | null;
  project_name: string | null;
  person_ids: string[];
  people: { id: string; name: string }[];
  version: number;
  revision_id: string;
  revision_version: number;
  content_hash: string;
  created_by: string;
  created_by_name: string;
  edited_by: string;
  edited_by_name: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  can_edit: boolean;
  knowledge_state: 'ready' | 'pending' | 'failed' | 'not_required' | 'unavailable';
  record_id: string | null;
  knowledge_versions?: {
    graph: NoteKnowledgeVersion | null;
    vector: NoteKnowledgeVersion | null;
  };
}
export interface NoteKnowledgeVersion {
  requested_version: number;
  applied_version: number;
  state: string;
  digest: string | null;
  generation?: string | null;
  schema_revision?: string | null;
  model_revision?: string | null;
}
export interface NoteDetail extends NoteSummary {
  blocks: NoteBlock[];
  sources: NoteSourceRef[];
  source_warning?: string;
  title_sources?: NoteSourceRef[];
}
export interface NoteListResponse {
  notes: NoteSummary[];
  drafts: NoteDraft[];
  total: number;
  offset: number;
  limit: number;
  has_more: boolean;
}
export interface SaveNoteDraft extends NoteContent {
  request_id: string;
  version: number;
  note_id: string | null;
  base_revision: number;
}
export interface PublishNote {
  request_id: string;
  draft_id: string;
  draft_version: number;
  base_revision: number;
}
export interface NoteTemplate {
  id: string;
  name: string;
  blocks: Pick<NoteBlock, 'id' | 'type' | 'text'>[];
  created_at: string;
}
export const noteLimits = { title: 200, text: 10000, blocks: 100, sources: 30 } as const;
