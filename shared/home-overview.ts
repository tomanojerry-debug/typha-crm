import type { FilterGroup } from './filters.js';
import type { WorkflowKind } from './home-workflows.js';

export type HomeOverviewKind =
  'mail' | 'draft' | 'outgoing_issue' | 'document' | 'wechat' | 'workflow';

export interface HomeOverviewItem {
  kind: HomeOverviewKind;
  id: string;
  title: string;
  subtitle: string;
  updated_at: string;
  customer_id: string | null;
  customer_name: string | null;
  person_id: string | null;
  project_id: string | null;
  chat_id: string | null;
  workflow_kind?: WorkflowKind | null;
  status: string;
  action_label: string;
}

export interface HomeOverview {
  items: HomeOverviewItem[];
  total: number;
  counts: Record<HomeOverviewKind, number>;
}

// Use the business calendar date in Shanghai. This exclusive bound includes
// all of the thirtieth day, regardless of the browser's local time zone.
export function homeProjectDateLimit(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  const exclusive = new Date(Date.UTC(value('year'), value('month') - 1, value('day') + 31));
  return exclusive.toISOString().slice(0, 10);
}

export function homeProjectFilters(now = new Date()): FilterGroup {
  return {
    match: 'all',
    rules: [
      { field: 'stage', operator: 'is_not', value: 'completed' },
      { field: 'stage', operator: 'is_not', value: 'cancelled' },
      { field: 'due_date', operator: 'not_empty', value: '' },
      { field: 'due_date', operator: 'before', value: homeProjectDateLimit(now) },
    ],
  };
}
