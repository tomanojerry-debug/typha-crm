import type { AttributeValue, CompanyAttribute } from './attributes.js';

export const documentLimits = { bytes: 10 * 1024 * 1024, pages: 200, text: 1_000_000 };
export type DocumentFormat = 'pdf' | 'docx';
export type DocumentStatus = 'queued' | 'processing' | 'pending_association' | 'ready' | 'failed';
export type DocumentView = 'all' | 'pending' | 'processing' | 'failed';
export interface DocumentSection {
  label: string;
  text: string;
}
export interface DocumentFile {
  id: string;
  name: string;
  format: DocumentFormat;
  size: number;
  customer_id: string | null;
  customer_name: string | null;
  project_id: string | null;
  project_name: string | null;
  record_id: string | null;
  supersedes_id?: string | null;
  edition?: number;
  status: DocumentStatus;
  error: string | null;
  warnings: string[];
  section_count: number;
  version: number;
  created_at: string;
  updated_at: string;
  can_edit: boolean;
  knowledge_state: 'not_associated' | 'queued' | 'ready' | 'unavailable';
}
export interface DocumentDetail extends DocumentFile {
  sections: DocumentSection[];
}
export interface DocumentUploadInput {
  request_id: string;
  name: string;
  content_base64: string;
  customer_id?: string | null;
  project_id?: string | null;
  supersedes_id?: string | null;
}
export interface DocumentAttributeOutcome {
  attribute_id: string;
  name: string;
  status: 'filled' | 'preserved' | 'conflict' | 'missing';
  value: AttributeValue;
  explanation: string;
  evidence: { label: string; quote: string }[];
}
export interface DocumentAttributeResult {
  document_id: string;
  results: DocumentAttributeOutcome[];
}
export interface DocumentAttributeFields {
  fields: (CompanyAttribute & { current_value: AttributeValue })[];
}
export interface DocumentAnswer {
  answer: string;
  evidence: { label: string; quote: string }[];
}

// API (all routes require the existing authenticated actor + x-workspace-id):
// GET /documents?view=all|pending|processing|failed&customer_id=&project_id= -> {files:DocumentFile[]}
// POST /documents DocumentUploadInput -> DocumentDetail (persisted, then processed asynchronously)
// GET /documents/:id -> DocumentDetail
// GET /documents/:id/versions -> {files:DocumentFile[]} (explicit content versions; originals retained)
// GET /documents/:id/original -> {name:string;mime:string;content_base64:string}
// POST /documents/:id/associate {customer_id:string;project_id?:string|null;version:number} -> DocumentDetail
// POST /documents/:id/retry {version:number} -> DocumentDetail
// GET /documents/:id/attributes -> DocumentAttributeFields
// POST /documents/:id/attributes {attribute_ids:string[]} -> DocumentAttributeResult
// POST /documents/:id/ask {question:string} -> DocumentAnswer
// A nullable customer is uploader-private. A successful parse is not a ready knowledge index.
