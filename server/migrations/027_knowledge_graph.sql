-- Same RLS and atomic generation publication as facts/extractions. No graph
-- database connection or arbitrary query endpoint is exposed to the browser.
ALTER TABLE knowledge_sync ADD COLUMN graph jsonb;
