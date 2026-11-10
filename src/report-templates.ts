import type { ReportWidget } from '../shared/reports';
import type { ActivityAnalysisConfig } from '../shared/activity-analysis';

export type ReportTemplate = {
  id: string;
  name: string;
  eyebrow: string;
  description: string;
  color: string;
  widgets: ReportWidget[];
  requiresActivityMapping?: boolean;
  activity_analysis?: ActivityAnalysisConfig | null;
};
const widget = (
  id: string,
  title: string,
  source: string,
  groupBy: string,
  visualization: ReportWidget['visualization'],
): ReportWidget => ({ id, title, source, groupBy, visualization, metric: 'count' });
export const reportTemplates: ReportTemplate[] = [
  {
    id: 'customers',
    name: '客户全景',
    eyebrow: 'CUSTOMER LANDSCAPE',
    color: 'blue',
    description: '了解客户从哪里来、由谁跟进，以及关系处在哪个阶段。',
    widgets: [
      widget('customer-total', '客户档案', 'companies', 'none', 'number'),
      widget('people-total', '已建立的联系人', 'people', 'none', 'number'),
      widget('customer-types', '我们在服务谁', 'companies', 'type', 'donut'),
      widget('customer-sources', '客户从哪里来', 'companies', 'source', 'bar'),
      widget('customer-status', '当前合作关系', 'companies', 'status', 'bar'),
      widget('customer-growth', '客户档案新增', 'companies', 'month', 'line'),
    ],
  },
  {
    id: 'projects',
    name: '项目进展',
    eyebrow: 'PROJECT PULSE',
    color: 'teal',
    description: '从询盘到样衣与定制，查看项目分布和当前进展。',
    widgets: [
      widget('projects-total', '项目档案', 'projects', 'none', 'number'),
      {
        ...widget('projects-customers', '有项目的客户', 'projects', 'none', 'number'),
        metric: 'distinct_customers',
      },
      widget('projects-stage', '项目目前进行到哪里', 'projects', 'stage', 'bar'),
      widget('projects-type', '项目类型构成', 'projects', 'type', 'donut'),
      widget('projects-owner', '项目负责人分布', 'projects', 'owner', 'bar'),
      widget('projects-month', '项目档案新增', 'projects', 'month', 'line'),
    ],
  },
  {
    id: 'communication',
    name: '沟通与跟进',
    eyebrow: 'RELATIONSHIP SIGNALS',
    color: 'amber',
    description: '查看已归档资料与活动覆盖，为下一次沟通找到依据。',
    widgets: [
      {
        ...widget('records-customers', '有资料的客户', 'records', 'none', 'number'),
        metric: 'distinct_customers',
      },
      widget('activities-total', '已整理的业务活动', 'activities', 'none', 'number'),
      widget('records-kind', '资料的事实层级', 'records', 'kind', 'donut'),
      widget('activities-type', '业务活动类型', 'activities', 'type', 'bar'),
      widget('records-month', '业务资料发生趋势', 'records', 'month', 'line'),
      widget('activities-month', '业务活动发生趋势', 'activities', 'month', 'line'),
    ],
  },
];

/** This template needs an explicit mapping to the workspace's real activity fields. */
export const activityFeedbackReportTemplate: ReportTemplate = {
  id: 'activity-feedback',
  name: '售后反馈与产品改进',
  eyebrow: 'PRODUCT FEEDBACK',
  color: 'teal',
  description: '按真实活动中的款式与问题整理反馈，回看原话，为产品改进提供依据。',
  widgets: [],
  requiresActivityMapping: true,
};

export function instantiateReportWidgets(widgets: ReportWidget[]): ReportWidget[] {
  return widgets.map((widget) => ({ ...widget, id: crypto.randomUUID() }));
}

/** CSV is deliberately plain data: never allow a name to become a formula. */
export function reportCsvCell(value: unknown) {
  const text = String(value ?? '');
  return `"${(/^[\s]*[=+\-@\t\r]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"`;
}
