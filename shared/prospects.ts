import type { Customer } from './domain.js';

export const prospectStages = {
  new: '新咨询',
  needs: '需求确认',
  proposal: '方案沟通',
  decision: '待客户决定',
} as const;
export const prospectLifecycles = {
  active: '进行中',
  paused: '暂缓',
  closed: '已结束',
} as const;
export const prospectOutcomes = {
  won: '确认成交',
  lost: '未成交',
  resolved: '咨询已解决',
  invalid: '无效咨询',
  duplicate: '重复询盘',
} as const;
export const prospectRequirementStatuses = {
  missing: '待补充',
  in_progress: '处理中',
  satisfied: '已满足',
  not_applicable: '不适用',
} as const;
export const prospectWaitingOn = { us: '我方', customer: '客户', internal: '内部协作方' } as const;
export interface ProspectSourceRef {
  record_id: string;
  source_hash: string;
  title?: string;
}
export interface ProspectRequirement {
  id: string;
  title: string;
  status: keyof typeof prospectRequirementStatuses;
  waiting_on: keyof typeof prospectWaitingOn | null;
  assignee_id: string | null;
  due_date: string | null;
  result: string;
  source_record_ids?: string[];
}
export interface Prospect {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_type: Customer['type'];
  name: string;
  owner_id: string | null;
  owner_name: string | null;
  person_id: string | null;
  person_name: string | null;
  stage: keyof typeof prospectStages;
  lifecycle: keyof typeof prospectLifecycles;
  outcome: keyof typeof prospectOutcomes | null;
  outcome_reason: string;
  summary: string;
  requirements: ProspectRequirement[];
  source_refs: ProspectSourceRef[];
  version: number;
  can_edit: boolean;
  created_at: string;
  updated_at: string;
  sources_valid: boolean;
  source_warning?: string;
}
export interface CreateProspect {
  request_id: string;
  customer_id: string;
  existing_project_id?: string;
  name: string;
  owner_id?: string | null;
  person_id?: string | null;
  summary?: string;
  requirements?: ProspectRequirement[];
  source_refs?: ProspectSourceRef[];
}
export interface UpdateProspect {
  request_id: string;
  version: number;
  name?: string;
  owner_id?: string | null;
  person_id?: string | null;
  stage?: Prospect['stage'];
  lifecycle?: Prospect['lifecycle'];
  outcome?: Prospect['outcome'];
  outcome_reason?: string;
  summary?: string;
  /** Whole-array replacement; IDs are stable and retained for existing requirements. */
  requirements?: ProspectRequirement[];
  source_refs?: ProspectSourceRef[];
  /** Explicit acknowledgement keeps unresolved business states on closure. */
  acknowledge_open_requirements?: boolean;
}
export interface ProspectListResponse {
  items: Prospect[];
  total: number;
  page: number;
  page_size: number;
}
export interface ProspectTask extends ProspectRequirement {
  prospect_id: string;
  prospect_name: string;
  prospect_version: number;
  customer_id: string;
  customer_name: string;
  customer_type: Customer['type'];
  effective_assignee_id: string | null;
  lifecycle: Prospect['lifecycle'];
  can_edit: boolean;
  sources_valid: boolean;
}
export interface ProspectTaskListResponse {
  items: ProspectTask[];
  total: number;
  page: number;
  page_size: number;
}
