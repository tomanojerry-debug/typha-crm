import { describe, expect, it } from 'vitest';
import type {
  ActivityAnalysisInput,
  ActivityAnalysisResult,
  ActivityAnalysisRow,
} from '../shared/activity-analysis.js';
import type { ActivityField } from '../shared/business-activities.js';
import {
  activityFeedbackCsv,
  feedbackActivityIds,
  feedbackDate,
  feedbackMappingFields,
} from '../src/ActivityFeedbackReport.js';
import { activityFeedbackReportTemplate, reportTemplates } from '../src/report-templates.js';

const row: ActivityAnalysisRow = {
  id: 'activity-a',
  title: '=HYPERLINK("https://invalid.example")',
  customer_id: 'customer-a',
  customer_name: '客户, "甲"',
  project_id: null,
  occurred_at: null,
  product: '0',
  issues: ['肩带偏长', '不同意见'],
  version: 'false',
  size: null,
  color: null,
  stage: '样衣',
  case_id: 'case-a',
  merged_ids: ['activity-a', 'activity-b', 'activity-b'],
  source_count: 2,
  review_required: false,
  review_reason: null,
};
const result: ActivityAnalysisResult = {
  summary: { feedback_count: 2, customer_count: 1, activity_count: 3, source_count: 2 },
  groups: { product: [], issue: [], version: [], size: [], color: [], stage: [] },
  coverage: {
    scanned_count: 8,
    invalid_source_count: 4,
    unknown_date_count: 1,
    unknown_date_excluded_count: 1,
    pending_review_count: 1,
    duplicate_activity_count: 1,
    missing_values: { product: 1 },
    deduplication: '同客户的明确事项编号及内容一致时去重；待核实明细不计入统计。',
    max_activities: 5000,
  },
  rows: [row, { ...row, id: 'activity-c', review_required: true, review_reason: 'case_conflict' }],
  total: 31,
  offset: 20,
  limit: 20,
};
const input: ActivityAnalysisInput = {
  config: { typeId: 'type-a', fields: { product: 'field-product', issue: 'field-issue' } },
  startDate: '2026-11-01',
  endDate: '2026-11-10',
  stage: '样衣',
  offset: 20,
  limit: 20,
};

describe('activity feedback report presentation', () => {
  it('keeps the configured template separate from the three immediately usable templates', () => {
    expect(reportTemplates).toHaveLength(3);
    expect(activityFeedbackReportTemplate.requiresActivityMapping).toBe(true);
    expect(activityFeedbackReportTemplate.widgets).toEqual([]);
    expect(activityFeedbackReportTemplate.activity_analysis).toBeUndefined();
  });

  it('offers only the actual compatible fields without inventing product fields', () => {
    const field = (id: string, kind: ActivityField['kind']): ActivityField => ({
      id,
      name: '实际字段',
      kind,
      options: [],
      required: false,
      ai_enabled: false,
      guidance: '',
    });
    const actual = [
      field('base:title', 'text'),
      field('saved-select', 'select'),
      field('saved-multiple', 'multi_select'),
      field('saved-number', 'number'),
      field('saved-owner', 'actor_reference'),
    ];
    expect(feedbackMappingFields(actual, 'product').map((item) => item.id)).toEqual([
      'base:title',
      'saved-select',
    ]);
    expect(feedbackMappingFields(actual, 'issue').map((item) => item.id)).toEqual([
      'base:title',
      'saved-select',
      'saved-multiple',
    ]);
    expect(feedbackMappingFields([], 'version')).toEqual([]);
  });

  it('labels unknown occurrence dates and preserves access to every merged activity', () => {
    expect(feedbackDate(null)).toBe('日期不详');
    expect(feedbackDate('invalid')).toBe('日期不详');
    expect(feedbackDate('2026-11-09T20:00:00Z')).toBe('2026/11/10');
    expect(feedbackActivityIds(row)).toEqual(['activity-a', 'activity-b']);
    expect(feedbackActivityIds({ ...row, merged_ids: ['activity-b'] })).toEqual([
      'activity-a',
      'activity-b',
    ]);
  });

  it('exports a clearly bounded page with denominators, filters, unknowns and safe cells', () => {
    const csv = activityFeedbackCsv(result, input, '样衣与售后反馈');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"导出范围","当前页活动明细；不是全部明细"');
    expect(csv).toContain('"符合筛选的明细总数（含待核实）","31"');
    expect(csv).toContain('"本页起始序号","21"');
    expect(csv).toContain('"本页明细行数","2"');
    expect(csv).toContain('"计入统计的独立反馈","2"');
    expect(csv).toContain('"反馈阶段","样衣"');
    expect(csv).toContain('"开始日期","2026-11-01"');
    expect(csv).toContain('"来源失效或变化而排除的活动数","4"');
    expect(csv).toContain('"\'=HYPERLINK(""https://invalid.example"")"');
    expect(csv).toContain('"客户, ""甲"""');
    expect(csv).toContain('"日期不详","0","肩带偏长、不同意见","false"');
    expect(csv).toContain('"待核实，未计入统计"');
    expect(csv).toContain('"activity-a、activity-b"');
  });
});
