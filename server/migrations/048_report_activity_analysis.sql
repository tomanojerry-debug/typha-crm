ALTER TABLE report_dashboards ADD COLUMN activity_analysis jsonb;
ALTER TABLE report_dashboards ADD CONSTRAINT report_activity_analysis_object
CHECK(activity_analysis IS NULL OR jsonb_typeof(activity_analysis)='object');
