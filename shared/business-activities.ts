export type ActivityFieldKind =
  | 'text'
  | 'number'
  | 'currency'
  | 'date'
  | 'timestamp'
  | 'checkbox'
  | 'rating'
  | 'select'
  | 'multi_select'
  | 'record_reference'
  | 'actor_reference';
export type ActivityValue = string | number | boolean | string[] | null;
export interface ActivityField {
  id: string;
  name: string;
  kind: ActivityFieldKind;
  options: string[];
  required: boolean;
  ai_enabled: boolean;
  guidance: string;
  currency?: string;
  system?: boolean;
  read_only?: boolean;
  default_field?: boolean;
  inherited?: boolean;
  source_schema_id?: string;
  source_schema_name?: string;
}
export interface ActivitySchema {
  id: string;
  name: string;
  description: string;
  parent_id: string | null;
  depth: 1 | 2;
  fields: ActivityField[];
  effective_fields: ActivityField[];
  version: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
}
export interface BusinessActivityType {
  id: string;
  name: string;
  description: string;
  schema_id: string;
  fields: ActivityField[];
  effective_fields: ActivityField[];
  schema_name: string;
  guidance: string;
  version: number;
  archived: boolean;
  schema_revision?: string;
}
export interface ActivitySource {
  id: string;
  record_id: string;
  channel: 'email' | 'wechat' | 'record';
  title: string;
  body: string;
  occurred_at: string;
  person_ids: string[];
  project_id: string | null;
  speaker: string;
  speaker_side?: string;
  activity_count?: number;
}
export interface ActivityEvidence {
  source_id: string;
  record_id: string;
  quote: string;
  char_start: number;
  char_end: number;
}
export interface ActivityFieldProvenance {
  origin: 'ai' | 'manual' | 'system';
  actor_id?: string;
  updated_at: string;
  evidence: ActivityEvidence[];
  record_id?: string;
  explanation?: string;
}
export interface BusinessActivity {
  id: string;
  customer_id: string;
  project_id: string | null;
  type_id: string;
  type_name: string;
  title: string;
  summary: string | null;
  occurred_at: string | null;
  handler_id: string | null;
  linked_person_ids: string[];
  values: Record<string, ActivityValue>;
  ai_values: Record<string, ActivityValue>;
  field_provenance: Record<string, ActivityFieldProvenance>;
  fields: ActivityField[];
  version: number;
  archived: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  missing_required_fields?: string[];
}
export interface ActivityComment {
  id: string;
  activity_id: string;
  body: string;
  created_by: string;
  created_at: string;
}
export type ActivityTaskStatus = 'open' | 'in_progress' | 'completed';
export const collaborationAttachmentLimit = 1024 * 1024;
export const collaborationAttachmentTypes = {
  pdf: 'application/pdf',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const;
export interface CollaborationAttachmentMetadata {
  filename: string;
  content_type: (typeof collaborationAttachmentTypes)[keyof typeof collaborationAttachmentTypes];
  size_bytes: number;
}
export interface CollaborationTaskAttachment extends CollaborationAttachmentMetadata {
  content_base64: string;
}
export interface ActivityTask {
  id: string;
  activity_id: string;
  customer_id: string;
  project_id: string | null;
  title: string;
  assignee_id: string;
  assignee_display_name?: string | null;
  created_by: string;
  status: ActivityTaskStatus;
  due_date: string | null;
  result: string | null;
  result_record_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  task_only?: boolean;
  collaboration_brief?: string | null;
  attachment_required?: boolean;
  mail_cc_actor_id?: string | null;
  revoked_at?: string | null;
  attachment?: CollaborationAttachmentMetadata | null;
}
export interface CollaborationTask {
  id: string;
  task_only: true;
  collaboration_brief: string;
  title: string;
  status: ActivityTaskStatus;
  due_date: string | null;
  result: string | null;
  result_record_id?: never;
  version: number;
  created_at: string;
  updated_at: string;
  attachment_required: boolean;
  attachment: CollaborationAttachmentMetadata | null;
}
export type AssignedActivityTask = ActivityTask | CollaborationTask;
export interface ActivityTaskMailDraft {
  draft_id: string;
  customer_id: string;
  project_id: string | null;
  result: string;
  attachment: CollaborationTaskAttachment;
  cc: { actor_id: string; display_name: string; email: string } | null;
}
export interface ActivityDetail extends BusinessActivity {
  can_edit?: boolean;
  comments: ActivityComment[];
  tasks: ActivityTask[];
  sources: ActivitySource[];
}
export interface ActivityMember {
  actor_id: string;
  display_name: string;
  can_assign: boolean;
}
export interface ActivityCollaborationMember {
  actor_id: string;
  display_name: string;
  workspace_mode: 'crm' | 'tasks';
  can_receive_cc: boolean;
}
export interface GenerateActivitiesInput {
  customer_id: string;
  project_id?: string | null;
  type_id: string;
  source_ids: string[];
  linked_person_ids?: string[];
  handler_id?: string | null;
  request_id: string;
}
export interface ActivityGenerationResult {
  run_id: string;
  state: 'completed';
  activities: BusinessActivity[];
  reused: boolean;
}
export const activityBaseField = {
  title: 'base:title',
  customer: 'base:customer_id',
  project: 'base:project_id',
  occurred: 'base:occurred_at',
  handler: 'base:handler_id',
  summary: 'base:summary',
} as const;
export const ordinaryActivityFieldKinds = [
  'text',
  'number',
  'currency',
  'date',
  'timestamp',
  'checkbox',
  'rating',
  'select',
  'multi_select',
] as const;
