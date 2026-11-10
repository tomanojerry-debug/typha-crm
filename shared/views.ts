import type { FilterGroup } from './filters.js';
import type { ListConfig } from './list-workflow.js';
import type { Customer, Project, Person } from './domain.js';
import { communicationColumns } from './communications.js';

export type RecordObject = 'customers' | 'projects' | 'people';
export const customerColumns = {
  name: '客户名称',
  type: '客户类型',
  status: '合作状态',
  contact: '联系人',
  email: '邮箱',
  phone: '电话',
  source: '来源',
  region: '地区',
  project_count: '项目',
  owner: '负责人',
  updated_at: '最近更新',
  ...communicationColumns,
};
export const projectColumns = {
  name: '项目名称',
  customer_name: '所属客户',
  type: '项目类型',
  stage: '项目阶段',
  owner: '负责人',
  due_date: '目标日期',
  updated_at: '最近更新',
};
export const personColumns = {
  name: '姓名',
  customer_name: '公司 / 客户',
  job_title: '职位',
  email: '邮箱',
  phone: '电话',
  owner: '负责人',
  updated_at: '最近更新',
  created_at: '创建时间',
  id: '记录编号',
  ...communicationColumns,
};
export const personSorts = { ...personColumns };
export const objectLabels = { customers: '公司', people: '联系人', projects: '项目' };
export const objectNames = { customers: '公司 / 客户', people: '联系人', projects: '项目' };
export const allViewNames = {
  customers: '全部公司与客户',
  people: '全部联系人',
  projects: '全部项目',
};
export const customerSorts = { ...customerColumns, created_at: '创建时间' };
export const projectSorts = { ...projectColumns, created_at: '创建时间' };
export interface ViewConfig {
  query: string;
  type: string;
  status: string;
  source: string;
  owner: string;
  region: string;
  archived: boolean;
  sort: string;
  direction: 'asc' | 'desc';
  layout: 'list' | 'board';
  columns: string[];
  filters?: FilterGroup;
  list_config?: ListConfig;
}
// JSONB may reorder object keys; column order remains significant.
export function equalViewConfig(a: ViewConfig, b: ViewConfig): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return (
    JSON.stringify(canonical({ ...a, filters: a.filters || { match: 'all', rules: [] } })) ===
    JSON.stringify(canonical({ ...b, filters: b.filters || { match: 'all', rules: [] } }))
  );
}
export function defaultView(object: RecordObject): ViewConfig {
  return {
    query: '',
    type: '',
    status: '',
    source: '',
    owner: '',
    region: '',
    archived: false,
    sort: 'updated_at',
    direction: 'desc',
    layout: 'list',
    columns:
      object === 'customers'
        ? [
            'name',
            'type',
            'status',
            'email_strength',
            'last_email_at',
            'contact',
            'email',
            'project_count',
            'owner',
          ]
        : object === 'people'
          ? [
              'name',
              'customer_name',
              'email_strength',
              'last_email_at',
              'job_title',
              'email',
              'owner',
            ]
          : ['name', 'customer_name', 'type', 'stage', 'owner', 'due_date'],
  };
}
export interface SavedView {
  id: string;
  object: RecordObject;
  name: string;
  config: ViewConfig;
  version: number;
  list_id?: string | null;
}
export interface ProjectRow extends Project {
  customer_name: string;
  customer_archived_at: string | null;
  can_edit: boolean;
}
export interface BrowseResult<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  groups: Record<string, number>;
}
export type CustomerList = BrowseResult<Customer> & {
  summary: { customers: number; active_customers: number; open_projects: number };
};
export type ProjectList = BrowseResult<ProjectRow>;

export interface RecordList {
  id: string;
  object: RecordObject;
  name: string;
  version: number;
  count?: number;
}

export type PeopleList = BrowseResult<Person>;
export type RecordRow = Customer | ProjectRow | Person;
export const isProject = (row: RecordRow): row is ProjectRow => 'stage' in row;
export const isPerson = (row: RecordRow): row is Person => 'job_title' in row;
export function listEntry(row: RecordRow) {
  return {
    customer_id: 'customer_id' in row ? row.customer_id : row.id,
    project_id: isProject(row) ? row.id : null,
    person_id: isPerson(row) ? row.id : null,
  };
}
