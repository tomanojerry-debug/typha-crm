ALTER TABLE outgoing_mail ADD COLUMN variable_snapshot jsonb;
ALTER TABLE outgoing_mail ADD CHECK(variable_snapshot IS NULL OR
  (jsonb_typeof(variable_snapshot)='object' AND variable_snapshot->>'version'='1'
   AND jsonb_typeof(variable_snapshot->'messages')='array'));
ALTER TABLE mail_templates ADD COLUMN variable_document jsonb;
ALTER TABLE mail_templates ADD CHECK(variable_document IS NULL OR
  (jsonb_typeof(variable_document)='object' AND variable_document->>'version'='1'
   AND jsonb_typeof(variable_document->'subject')='array'
   AND jsonb_typeof(variable_document->'body')='array'));

-- Keep the prior scope, version and all submitted/uncertain/partial locks.
-- Approval writes its server-rendered snapshot separately from content: it does
-- not itself create a new draft version or invalidate the version being approved.
CREATE OR REPLACE FUNCTION crm_outgoing_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR
     NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR
     NEW.reply_to_message_id IS DISTINCT FROM OLD.reply_to_message_id OR NEW.in_reply_to IS DISTINCT FROM OLD.in_reply_to OR NEW.reference_ids IS DISTINCT FROM OLD.reference_ids THEN
    RAISE EXCEPTION 'outgoing scope is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.variable_snapshot IS DISTINCT FROM OLD.variable_snapshot AND OLD.status IN ('sending','submitted','sent_confirmed','uncertain','partial') THEN
    RAISE EXCEPTION 'submitted snapshot is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    IF OLD.status IN ('sending','submitted','sent_confirmed','uncertain','partial') THEN
      RAISE EXCEPTION 'submitted content is immutable' USING ERRCODE='23514';
    END IF;
    NEW.version := OLD.version+1;
    NEW.status := 'draft'; NEW.approved_version := NULL; NEW.approved_at := NULL; NEW.approved_digest := NULL;
    NEW.scheduled_at := NULL; NEW.timezone := NULL; NEW.message_id := NULL; NEW.from_email := NULL; NEW.error := NULL;
    NEW.variable_snapshot := NULL;
  END IF;
  NEW.updated_at := now(); RETURN NEW;
END $$;
