-- Adds configurable mail composition and a persisted template-choice gate.
-- Existing workflow rows and business records remain unchanged.
ALTER TABLE home_workflows DROP CONSTRAINT home_workflows_kind_check;
ALTER TABLE home_workflows ADD CONSTRAINT home_workflows_kind_check
  CHECK(kind IN ('summary','reply','compose','update'));
ALTER TABLE home_workflows DROP CONSTRAINT home_workflows_step_check;
ALTER TABLE home_workflows ADD CONSTRAINT home_workflows_step_check
  CHECK(step IN ('configure','template','ready','decision','review','completed','cancelled'));
