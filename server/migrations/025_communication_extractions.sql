-- Candidate projections inherit knowledge_sync RLS and atomic generation publication.
ALTER TABLE knowledge_sync ADD COLUMN extractions jsonb NOT NULL DEFAULT '[]';
-- Only newly reviewed evidence receives direction; never infer old private messages.
ALTER TABLE knowledge_wechat_evidence ADD COLUMN message_id text;
ALTER TABLE knowledge_wechat_evidence ADD COLUMN from_me boolean;
