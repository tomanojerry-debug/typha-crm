CREATE TABLE outgoing_mail (
  workspace_id uuid NOT NULL, customer_id uuid NOT NULL, person_id uuid,
  id uuid NOT NULL, created_by uuid NOT NULL REFERENCES users(id),
  account_id uuid, project_id uuid, from_email text,
  content jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','scheduled','sending','submitted','sent_confirmed','uncertain','failed','cancelled','needs_review')),
  approved_version integer, approved_at timestamptz, approved_digest text,
  scheduled_at timestamptz, timezone text, started_at timestamptz, submitted_at timestamptz,
  message_id text, error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,message_id),
  FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
  FOREIGN KEY(workspace_id,customer_id,person_id) REFERENCES people(workspace_id,customer_id,id),
  FOREIGN KEY(workspace_id,customer_id,project_id) REFERENCES projects(workspace_id,customer_id,id),
  FOREIGN KEY(workspace_id,account_id) REFERENCES mail_accounts(workspace_id,id),
  CHECK(approved_version IS NULL OR approved_version=version),
  CHECK(status NOT IN ('approved','scheduled','sending','submitted','sent_confirmed','uncertain') OR
    (approved_version=version AND approved_version IS NOT NULL AND approved_at IS NOT NULL AND approved_digest IS NOT NULL AND account_id IS NOT NULL AND from_email IS NOT NULL)),
  CHECK(status NOT IN ('scheduled','sending','submitted','sent_confirmed','uncertain') OR (scheduled_at IS NOT NULL AND timezone IS NOT NULL AND message_id IS NOT NULL))
);
CREATE INDEX outgoing_due ON outgoing_mail(scheduled_at) WHERE status='scheduled';
ALTER TABLE outgoing_mail ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON outgoing_mail TO light_crm_app;
CREATE POLICY outgoing_read ON outgoing_mail FOR SELECT USING(created_by=crm_actor() AND crm_access(workspace_id,customer_id));
CREATE POLICY outgoing_create ON outgoing_mail FOR INSERT WITH CHECK(created_by=crm_actor() AND crm_access(workspace_id,customer_id,true));
CREATE POLICY outgoing_edit ON outgoing_mail FOR UPDATE USING(created_by=crm_actor() AND crm_access(workspace_id,customer_id,true)) WITH CHECK(created_by=crm_actor() AND crm_access(workspace_id,customer_id,true));
CREATE FUNCTION crm_outgoing_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.customer_id<>OLD.customer_id OR NEW.person_id<>OLD.person_id OR NEW.id<>OLD.id OR NEW.created_by<>OLD.created_by THEN
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
CREATE TRIGGER outgoing_scope BEFORE UPDATE ON outgoing_mail FOR EACH ROW EXECUTE FUNCTION crm_outgoing_scope();
CREATE TRIGGER outgoing_audit AFTER INSERT OR UPDATE ON outgoing_mail FOR EACH ROW EXECUTE FUNCTION crm_audit();
ALTER TABLE mail_messages ADD COLUMN message_id text;
CREATE INDEX mail_message_identifier ON mail_messages(workspace_id,account_id,message_id) WHERE message_id IS NOT NULL;
-- IMAP synchronization must not re-import a CRM submission, even when another
-- administrator owns the account sync. Only identifiers are exposed to admins.
CREATE FUNCTION crm_is_outgoing_message(w uuid,a uuid,m text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT crm_admin(w) AND EXISTS(SELECT 1 FROM outgoing_mail WHERE workspace_id=w AND account_id=a AND message_id=m)
$$;
REVOKE ALL ON FUNCTION crm_is_outgoing_message(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_is_outgoing_message(uuid,uuid,text) TO light_crm_app;
CREATE FUNCTION crm_outgoing_archive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
    UPDATE outgoing_mail SET status='needs_review',error='关联档案已归档，请恢复后重新确认发送'
    WHERE workspace_id=NEW.workspace_id AND status IN ('approved','scheduled') AND
      ((TG_TABLE_NAME='people' AND person_id=NEW.id) OR
       (TG_TABLE_NAME='customers' AND customer_id=NEW.id) OR
       (TG_TABLE_NAME='projects' AND project_id=NEW.id));
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crm_outgoing_archive() FROM PUBLIC;
CREATE TRIGGER person_outgoing_archive AFTER UPDATE ON people FOR EACH ROW EXECUTE FUNCTION crm_outgoing_archive();
CREATE TRIGGER customer_outgoing_archive AFTER UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION crm_outgoing_archive();
CREATE TRIGGER project_outgoing_archive AFTER UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION crm_outgoing_archive();
