import type { AskSource } from './ask.js';
import type { ChatRetrieval } from './chat-intent.js';
import type { EntitySchema } from './entity-schema.js';
export interface AgentSource {
  id: string;
  title: string;
  body: string;
  ref?: AskSource;
}
export interface AgentMailDirectoryCompany {
  id: string;
  name: string;
  type: string;
  region: string;
  contact_name: string;
  email: string;
  phone: string;
  status: string;
  version: number;
}
/** Current authorized directory fields, never a business Record or send approval. */
export interface AgentMailDirectory {
  source_nature: 'authorized_basic_directory';
  current_company: AgentMailDirectoryCompany;
  selected_contact: {
    id: string;
    name: string;
    email: string;
    phone: string;
    job_title: string;
    company_id: string;
    version: number;
  } | null;
  recipient_basis: 'explicit_compose_target' | 'reply_envelope_not_resolved';
  recipient: {
    kind: 'person' | 'company';
    id: string;
    name: string;
    email: string;
    phone: string;
    job_title?: string;
    company_id: string;
    version: number;
  } | null;
  recipient_company: AgentMailDirectoryCompany | null;
  project: {
    id: string;
    name: string;
    type: string;
    stage: string;
    due_date: string | null;
    version: number;
  } | null;
}
export interface AgentSnapshot {
  mail_directory?: AgentMailDirectory;
  task_state?: Record<string, unknown>;
  schema?: EntitySchema;
  label: string;
  sources: AgentSource[];
  warnings: string[];
  retrieval?: ChatRetrieval;
}
export interface AgentModelStatus {
  configured: boolean;
  can_manage: boolean;
  model: string;
  region: 'cn' | 'global';
}
export interface AgentCapabilities {
  prospects?: boolean;
  prospect_intake?: boolean;
  notes?: true;
  background_runs?: true;
  home_workflows?: boolean;
  mail_template_workflows?: true;
  workflow_task_actions?: true;
  model: boolean;
  model_name: string;
  can_manage: boolean;
  region: 'cn' | 'global';
  web_research: false;
  structured_import: true;
  customer_overview: true;
  customer_activity: true;
  accepted_files: string[];
  max_file_bytes: number;
}
