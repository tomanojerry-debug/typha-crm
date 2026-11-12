import type { EmailMetrics } from './communications.js';
export const customerTypes = {
  distributor: '经销商',
  group: '团体定制',
  retail: '个人零售',
} as const;
export const sources = {
  email: '邮件',
  taobao: '淘宝',
  douyin: '抖音',
  store: '门店',
  referral: '转介绍',
  other: '其他',
} as const;
export const customerStatuses = {
  potential: '待建立合作',
  active: '合作中',
  paused: '暂缓跟进',
} as const;
export const projectTypes = {
  inquiry: '询盘',
  sample: '样衣',
  custom: '定制',
  purchase: '采购',
} as const;
export const projectStages = {
  new: '新建',
  in_progress: '进行中',
  waiting_customer: '待客户确认',
  completed: '已完成',
  cancelled: '已取消',
} as const;
export const recordKinds = {
  customer_quote: '客户原话',
  inference: '内部推断',
  company_confirmed: '公司确认',
} as const;
export interface Customer extends Partial<EmailMetrics> {
  workspace_id: string;
  id: string;
  name: string;
  type: keyof typeof customerTypes;
  source: keyof typeof sources;
  region: string;
  contact_name: string;
  email: string;
  phone: string;
  status: keyof typeof customerStatuses;
  owner_id: string | null;
  archived_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  project_count?: number;
  can_edit: boolean;
}
export interface Project {
  workspace_id: string;
  customer_id: string;
  id: string;
  name: string;
  type: keyof typeof projectTypes;
  stage: keyof typeof projectStages;
  description: string;
  due_date: string | null;
  owner_id: string | null;
  archived_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}
export interface CustomerRecord {
  source_kind?: 'manual' | 'email' | 'wechat' | 'document' | 'note';
  source_mail_id?: string | null;
  occurred_at?: string;
  id: string;
  customer_id: string;
  project_id: string | null;
  kind: keyof typeof recordKinds;
  body: string;
  created_by: string;
  created_at: string;
}
export type WorkspaceMode = 'crm' | 'tasks';
export interface Member {
  actor_id: string;
  display_name: string;
  email: string;
  role: 'admin' | 'member';
  active: boolean;
  workspace_mode?: WorkspaceMode;
}
export interface SessionInfo {
  auth_mode: 'local' | 'password';
  actor: { id: string; email: string; display_name: string };
  workspaces: {
    id: string;
    name: string;
    role: 'admin' | 'member';
    workspace_mode?: WorkspaceMode;
  }[];
}
export interface AuditEvent {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string;
  created_at: string;
}

export interface Person extends Partial<EmailMetrics> {
  workspace_id: string;
  customer_id: string;
  id: string;
  name: string;
  job_title: string;
  email: string;
  phone: string;
  description: string;
  is_primary: boolean;
  archived_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  customer_name: string;
  customer_version: number;
  customer_archived_at: string | null;
  owner_id: string | null;
  can_edit: boolean;
}
