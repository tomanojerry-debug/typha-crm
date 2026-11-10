import type {
  MailRecipientBinding,
  MailVariableCatalog,
  MailVariableDocument,
  MailVariableSnapshot,
} from './mail-variables.js';

export type OutgoingStatus =
  | 'draft'
  | 'approved'
  | 'scheduled'
  | 'sending'
  | 'submitted'
  | 'sent_confirmed'
  | 'uncertain'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'needs_review';
export const outgoingLabels: Record<OutgoingStatus, string> = {
  draft: '草稿',
  approved: '内容已确认',
  scheduled: '等待发送',
  sending: '正在发送',
  submitted: '邮箱已接受',
  sent_confirmed: '已核对发件记录',
  uncertain: '结果待核对',
  partial: '部分已发送',
  failed: '发送失败',
  cancelled: '已取消',
  needs_review: '需要重新确认',
};
export interface OutgoingAttachment {
  name: string;
  content: string;
}
export interface OutgoingContent {
  variable_document?: MailVariableDocument;
  recipient_bindings?: MailRecipientBinding[];
  mass_sending?: boolean;
  account_id: string | null;
  project_id: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: OutgoingAttachment[];
}
export interface OutgoingMail extends OutgoingContent {
  variable_snapshot?: MailVariableSnapshot | null;
  deliveries?: OutgoingDelivery[];
  id: string;
  workspace_id: string;
  customer_id: string;
  person_id: string | null;
  created_by: string;
  version: number;
  status: OutgoingStatus;
  from_email: string | null;
  approved_version: number | null;
  approved_at: string | null;
  scheduled_at: string | null;
  timezone: string | null;
  submitted_at: string | null;
  message_id: string | null;
  reply_to_message_id: string | null;
  in_reply_to: string | null;
  reference_ids: string[];
  error: string | null;
  updated_at: string;
}
export interface OutgoingDelivery {
  id: string;
  recipient: string;
  message_id: string;
  status:
    'pending' | 'sending' | 'submitted' | 'sent_confirmed' | 'uncertain' | 'failed' | 'stopped';
  error: string | null;
}
export type OutgoingSummary = Pick<
  OutgoingMail,
  'id' | 'subject' | 'status' | 'scheduled_at' | 'updated_at'
>;
export interface ComposeOptions {
  mail_variables?: MailVariableCatalog;
  accounts: { id: string; email: string }[];
  projects: { id: string; name: string }[];
  sender_notice: string | null;
}
export interface ReplyOptions {
  source_id: string;
  kind: 'people' | 'customers';
  target: { id: string; name: string; email: string; customer_id: string; customer_name: string };
  options: ComposeOptions;
  content: OutgoingContent;
  in_reply_to: string | null;
  reference_ids: string[];
}
export const lockedOutgoing = (status: OutgoingStatus) =>
  ['sending', 'submitted', 'sent_confirmed', 'uncertain', 'partial'].includes(status);
