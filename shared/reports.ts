export type ReportMetric = 'count' | 'distinct_customers' | 'sum' | 'average';
export type ReportVisualization = 'number' | 'bar' | 'donut' | 'line';
export interface ReportField {
  id: string;
  label: string;
  kind: 'category' | 'date' | 'number';
  unit?: string;
}
export interface ReportSource {
  id: string;
  label: string;
  dateLabel: string;
  fields: ReportField[];
}
export interface ReportCatalog {
  sources: ReportSource[];
  customers: { id: string; name: string }[];
  customerTypes: { value: string; label: string }[];
}
export interface ReportWidget {
  id: string;
  title: string;
  source: string;
  metric: ReportMetric;
  metricField?: string;
  groupBy: string;
  visualization: ReportVisualization;
}
export interface ReportDashboard {
  id: string;
  name: string;
  description: string;
  widgets: ReportWidget[];
  activity_analysis?: ActivityAnalysisConfig | null;
  version: number;
  created_at: string;
  updated_at: string;
}
export interface ReportQuery {
  source: string;
  metric: ReportMetric;
  metricField?: string;
  groupBy: string;
  startDate?: string;
  endDate?: string;
  customerId?: string;
  customerType?: string;
  bucketKey?: string;
  offset?: number;
  limit?: number;
}
export interface ReportBucket {
  key: string;
  label: string;
  value: number | null;
  count: number;
  customerCount: number;
}
export interface ReportRow {
  id: string;
  name: string;
  customer_id: string;
  customer_name: string;
  project_id: string | null;
  person_id: string | null;
  date: string;
}
export interface ReportQueryResult {
  value: number | null;
  valueCount: number;
  total: number;
  customerCount: number;
  buckets: ReportBucket[];
  rows: ReportRow[];
  offset: number;
  limit: number;
  hasMore: boolean;
  dateLabel: string;
  generatedAt: string;
}
export const reportMetricLabels: Record<ReportMetric, string> = {
  count: '记录数量',
  distinct_customers: '去重公司数',
  sum: '合计',
  average: '平均值',
};
import type { ActivityAnalysisConfig } from './activity-analysis.js';
