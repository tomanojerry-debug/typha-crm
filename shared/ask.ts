import type { RecordObject } from './views.js';
import type { ListConfig } from './list-workflow.js';
import type { PreferenceChange } from './user-preferences.js';

export type AskScope =
  | { kind: 'entity'; object: RecordObject; customer_id: string; record_id: string }
  | { kind: 'records'; object: RecordObject; query: string; selected_ids: string[] }
  | {
      kind: 'list';
      list_id: string;
      config: ListConfig;
      query: string;
      page: number;
      selected_ids: string[];
    }
  | { kind: 'page'; page: 'mail' | 'wechat' | 'relationships' | 'chat' };

export type AskAction = 'overview' | 'relationships' | 'records' | 'emails';
export interface AskContext {
  label: string;
  description: string;
  suggestions: { action: AskAction; text: string }[];
  model: boolean;
  model_name?: string;
  can_manage?: boolean;
  region?: 'cn' | 'global';
}
export interface AskSource {
  kind: 'entity' | 'record' | 'mail';
  id: string;
  title: string;
  description: string;
  customer_id: string;
  // Basic directory metadata only; optional for historical saved sources.
  company_name?: string;
  directory_fields?: { label: string; value: string }[];
  object?: RecordObject;
  project_id?: string;
  person_id?: string;
  note_id?: string;
  note_revision_id?: string;
  note_version?: number;
  source_hash?: string;
}
export interface AskAnswer {
  chat_id?: string;
  preference?: PreferenceChange;
  body: string;
  sources: AskSource[];
  generated_at: string;
  mode: 'local' | 'model';
  model?: string;
  continuation?: string;
}
export interface AskEvidence {
  title: string;
  body: string;
}
