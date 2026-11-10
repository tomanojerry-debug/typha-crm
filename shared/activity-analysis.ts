import type { ActivityField } from './business-activities.js';

export type ActivityAnalysisDimension =
  'product' | 'issue' | 'version' | 'size' | 'color' | 'stage';

export interface ActivityAnalysisConfig {
  typeId: string;
  fields: {
    product: string;
    issue: string;
    version?: string;
    size?: string;
    color?: string;
    stage?: string;
    case?: string;
  };
}

export interface ActivityAnalysisCatalog {
  types: { id: string; name: string; schema_name: string; fields: ActivityField[] }[];
}

export interface ActivityAnalysisInput {
  config: ActivityAnalysisConfig;
  startDate?: string;
  endDate?: string;
  customerId?: string;
  customerType?: 'distributor' | 'group' | 'retail';
  product?: string;
  version?: string;
  issue?: string;
  stage?: string;
  size?: string;
  color?: string;
  offset?: number;
  limit?: number;
}

export interface ActivityAnalysisBucket {
  key: string | null;
  label: string;
  feedback_count: number;
  customer_count: number;
}

export interface ActivityAnalysisRow {
  id: string;
  title: string;
  customer_id: string;
  customer_name: string;
  project_id: string | null;
  occurred_at: string | null;
  product: string | null;
  issues: string[];
  version: string | null;
  size: string | null;
  color: string | null;
  stage: string | null;
  case_id: string | null;
  merged_ids: string[];
  source_count: number;
  review_required: boolean;
  review_reason: 'case_conflict' | 'invalid_value' | null;
}

export interface ActivityAnalysisResult {
  summary: {
    feedback_count: number;
    customer_count: number;
    activity_count: number;
    source_count: number;
  };
  groups: Record<ActivityAnalysisDimension, ActivityAnalysisBucket[]>;
  coverage: {
    /** Current RLS/type/customer scope before date and dimension filters. */
    scanned_count: number;
    /** Original activities whose current source validation failed in that scope. */
    invalid_source_count: number;
    /** Source-valid original activities with no event date, before dedup/filter. */
    unknown_date_count: number;
    /** Original activities excluded because their deduplicated feedback has no date. */
    unknown_date_excluded_count: number;
    /** Metadata rows in this filtered result excluded from formal counts. */
    pending_review_count: number;
    /** Extra original activities folded into this result's formal feedback rows. */
    duplicate_activity_count: number;
    missing_values: Partial<Record<ActivityAnalysisDimension, number>>;
    deduplication: string;
    max_activities: 5000;
  };
  /** Includes pending-review metadata rows; these do not enter summary/groups. */
  rows: ActivityAnalysisRow[];
  total: number;
  offset: number;
  limit: number;
}
