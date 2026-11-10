-- Company drafts have a NULL person_id. NULL-safe comparison also prevents a
-- company draft from being reassigned to a person after approval (or vice versa).
CREATE OR REPLACE FUNCTION crm_outgoing_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR
     NEW.customer_id IS DISTINCT FROM OLD.customer_id OR
     NEW.person_id IS DISTINCT FROM OLD.person_id OR
     NEW.id IS DISTINCT FROM OLD.id OR
     NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'outgoing scope is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    IF OLD.status IN ('sending','submitted','sent_confirmed','uncertain') THEN
      RAISE EXCEPTION 'submitted content is immutable' USING ERRCODE='23514';
    END IF;
    NEW.version := OLD.version+1;
    NEW.status := 'draft'; NEW.approved_version := NULL; NEW.approved_at := NULL; NEW.approved_digest := NULL;
    NEW.scheduled_at := NULL; NEW.timezone := NULL; NEW.message_id := NULL; NEW.from_email := NULL; NEW.error := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
