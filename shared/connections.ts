import type { Project } from './domain.js';
import type { MailIntakeSuggestions } from './mail-intake.js';
export type ObjectKind = 'customers' | 'people' | 'projects';
export interface AssociatedProject extends Pick<
  Project,
  'id' | 'customer_id' | 'name' | 'stage' | 'archived_at'
> {
  via_relationship: boolean;
  via_email: boolean;
}
export interface AssociatedProjectsPage {
  items: AssociatedProject[];
  total: number;
  page: number;
  page_size: number;
}
export const objectNames: Record<ObjectKind, string> = {
  customers: '公司',
  people: '联系人',
  projects: '项目',
};
export type Cardinality = 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
export const cardinalities: Record<Cardinality, string> = {
  one_to_one: '一对一',
  one_to_many: '一对多',
  many_to_one: '多对一',
  many_to_many: '多对多',
};
export interface RelationDefinition {
  id: string;
  source_object: ObjectKind;
  target_object: ObjectKind;
  source_label: string;
  target_label: string;
  cardinality: Cardinality;
}
export interface RelatedRecord {
  edge_id: string;
  definition_id: string;
  side: 'source' | 'target';
  object: ObjectKind;
  id: string;
  customer_id: string;
  name: string;
  archived_at: string | null;
}
export interface MailProcessingSettings {
  intake_mode: 'review' | 'manual';
  notify_unknown: boolean;
  notify_known: boolean;
  muted_senders: string[];
  settings_version: number;
  settings_updated_at: string | null;
}
export interface MailExclusions {
  rules: string[];
  version: number;
  updated_at: string | null;
}
export interface ExclusionImpact {
  account_id: string;
  email: string;
  to_hide: number;
  to_restore: number;
  hidden: number;
}
export interface MailAccount extends MailProcessingSettings {
  id: string;
  email: string;
  aliases: string[];
  enabled: boolean;
  created_at: string;
  last_sync_at: string | null;
  sync_started_at: string | null;
  sync_error: string | null;
  synced_count: number;
  sent_folder: string | null;
}
export interface MailAddress {
  address: string;
  name: string;
}
export interface MailMessage {
  customer_recognition?: MailCustomerRecognition;
  unread?: boolean;
  intake_mode?: 'review' | 'manual';
  intake_suggestions?: MailIntakeSuggestions | null;
  id: string;
  account_id: string;
  account_email: string;
  customer_id: string | null;
  customer_name: string | null;
  project_id: string | null;
  subject: string;
  sender: MailAddress[];
  recipients: MailAddress[];
  cc: MailAddress[];
  occurred_at: string;
  direction: 'inbound' | 'outbound';
  preview: string;
  body?: string;
  reply_to?: MailAddress[];
  message_id?: string | null;
  reference_ids?: string[];
  project_name?: string | null;
  body_notice: string | null;
  attachments: { name: string; size: number; type: string }[];
  match_reason: string;
  people: { id: string; name: string }[];
}
export interface MailPage {
  items: MailMessage[];
  total: number;
  page: number;
  last_inbound: string | null;
  last_outbound: string | null;
}
export interface MailNotification extends Pick<
  MailMessage,
  'id' | 'subject' | 'sender' | 'occurred_at' | 'customer_id' | 'customer_name' | 'preview'
> {
  unread: boolean;
  customer_recognition: MailCustomerRecognition;
}
export interface MailCustomerRecognition {
  kind: 'known' | 'new' | 'possible' | 'ambiguous';
  reason: string;
  candidates: { id: string; name: string; archived: boolean }[];
}
export const mailCustomerLabels: Record<MailCustomerRecognition['kind'], string> = {
  known: '已有客户线索',
  new: '新客户线索',
  possible: '已有客户线索 · 待核对',
  ambiguous: '客户归属待核对',
};
export interface MailNotificationsPage {
  items: MailNotification[];
  total: number;
  page: number;
  unread: number;
  pending: number;
}
