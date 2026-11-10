CREATE TABLE relationship_definitions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL,
  source_object text NOT NULL CHECK(source_object IN ('customers','people','projects')),
  target_object text NOT NULL CHECK(target_object IN ('customers','people','projects')),
  source_label text NOT NULL CHECK(length(trim(source_label)) BETWEEN 1 AND 60),
  target_label text NOT NULL CHECK(length(trim(target_label)) BETWEEN 1 AND 60),
  cardinality text NOT NULL CHECK(cardinality IN ('one_to_one','one_to_many','many_to_one','many_to_many')),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,id,source_object,target_object),
  UNIQUE(workspace_id,source_object,target_object,source_label,target_label)
);
CREATE TABLE relationship_edges (
  workspace_id uuid NOT NULL, customer_id uuid NOT NULL, id uuid NOT NULL,
  definition_id uuid NOT NULL, source_object text NOT NULL, target_object text NOT NULL,
  source_id uuid NOT NULL, target_id uuid NOT NULL,
  source_person_id uuid, source_project_id uuid, target_person_id uuid, target_project_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,definition_id,source_id,target_id),
  FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
  FOREIGN KEY(workspace_id,definition_id,source_object,target_object) REFERENCES relationship_definitions(workspace_id,id,source_object,target_object),
  FOREIGN KEY(workspace_id,customer_id,source_person_id) REFERENCES people(workspace_id,customer_id,id),
  FOREIGN KEY(workspace_id,customer_id,target_person_id) REFERENCES people(workspace_id,customer_id,id),
  FOREIGN KEY(workspace_id,customer_id,source_project_id) REFERENCES projects(workspace_id,customer_id,id),
  FOREIGN KEY(workspace_id,customer_id,target_project_id) REFERENCES projects(workspace_id,customer_id,id),
  CHECK((source_object='customers' AND source_id=customer_id AND source_person_id IS NULL AND source_project_id IS NULL) OR (source_object='people' AND source_person_id IS NOT NULL AND source_id=source_person_id AND source_project_id IS NULL) OR (source_object='projects' AND source_project_id IS NOT NULL AND source_id=source_project_id AND source_person_id IS NULL)),
  CHECK((target_object='customers' AND target_id=customer_id AND target_person_id IS NULL AND target_project_id IS NULL) OR (target_object='people' AND target_person_id IS NOT NULL AND target_id=target_person_id AND target_project_id IS NULL) OR (target_object='projects' AND target_project_id IS NOT NULL AND target_id=target_project_id AND target_person_id IS NULL)),
  CHECK(source_object<>target_object OR source_id<>target_id)
);
CREATE FUNCTION crm_relationship_cardinality() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c text;
BEGIN
  SELECT cardinality INTO c FROM relationship_definitions WHERE workspace_id=NEW.workspace_id AND id=NEW.definition_id FOR UPDATE;
  IF c IN ('one_to_one','many_to_one') AND EXISTS(SELECT 1 FROM relationship_edges WHERE workspace_id=NEW.workspace_id AND definition_id=NEW.definition_id AND source_id=NEW.source_id) THEN
    RAISE EXCEPTION 'source relationship already occupied' USING ERRCODE='23505';
  END IF;
  IF c IN ('one_to_one','one_to_many') AND EXISTS(SELECT 1 FROM relationship_edges WHERE workspace_id=NEW.workspace_id AND definition_id=NEW.definition_id AND target_id=NEW.target_id) THEN
    RAISE EXCEPTION 'target relationship already occupied' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;
-- SECURITY DEFINER takes only a definition lock; it must see all edges when enforcing uniqueness.
ALTER FUNCTION crm_relationship_cardinality() SECURITY DEFINER;
ALTER FUNCTION crm_relationship_cardinality() SET search_path=public,pg_temp;
CREATE TRIGGER relationship_cardinality BEFORE INSERT ON relationship_edges FOR EACH ROW EXECUTE FUNCTION crm_relationship_cardinality();
CREATE TRIGGER relationship_audit AFTER INSERT OR DELETE ON relationship_edges FOR EACH ROW EXECUTE FUNCTION crm_audit();
ALTER TABLE relationship_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_edges ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON relationship_definitions TO light_crm_app;
GRANT SELECT,INSERT,DELETE ON relationship_edges TO light_crm_app;
CREATE POLICY relationship_def_read ON relationship_definitions FOR SELECT USING(workspace_id=crm_workspace() AND EXISTS(SELECT 1 FROM workspace_people WHERE actor_id=crm_actor() AND active));
CREATE POLICY relationship_def_create ON relationship_definitions FOR INSERT WITH CHECK(crm_admin(workspace_id));
CREATE POLICY relationship_edge_read ON relationship_edges FOR SELECT USING(crm_access(workspace_id,customer_id));
CREATE POLICY relationship_edge_create ON relationship_edges FOR INSERT WITH CHECK(crm_access(workspace_id,customer_id,true));
CREATE POLICY relationship_edge_delete ON relationship_edges FOR DELETE USING(crm_access(workspace_id,customer_id,true));

CREATE TABLE mail_accounts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL, email text NOT NULL,
  secret text NOT NULL, aliases jsonb NOT NULL DEFAULT '[]', enabled boolean NOT NULL DEFAULT true, connected_by uuid NOT NULL REFERENCES users(id),
  cursors jsonb NOT NULL DEFAULT '{}', sent_folder text,
  sync_token uuid, sync_started_at timestamptz, last_sync_at timestamptz, sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,email)
);
CREATE TABLE mail_messages (
  workspace_id uuid NOT NULL, id uuid NOT NULL, account_id uuid NOT NULL, account_email text NOT NULL,
  customer_id uuid, project_id uuid, fingerprint text NOT NULL,
  subject text NOT NULL, sender jsonb NOT NULL, recipients jsonb NOT NULL, cc jsonb NOT NULL,
  participants jsonb NOT NULL, occurred_at timestamptz NOT NULL,
  direction text NOT NULL CHECK(direction IN ('inbound','outbound')),
  body text NOT NULL, body_notice text, attachments jsonb NOT NULL DEFAULT '[]',
  match_reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,account_id,fingerprint), UNIQUE(workspace_id,customer_id,id),
  FOREIGN KEY(workspace_id,account_id) REFERENCES mail_accounts(workspace_id,id),
  FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
  FOREIGN KEY(workspace_id,customer_id,project_id) REFERENCES projects(workspace_id,customer_id,id),
  CHECK(project_id IS NULL OR customer_id IS NOT NULL)
);
CREATE TABLE mail_people (
  workspace_id uuid NOT NULL, customer_id uuid NOT NULL, message_id uuid NOT NULL, person_id uuid NOT NULL,
  PRIMARY KEY(workspace_id,message_id,person_id),
  FOREIGN KEY(workspace_id,customer_id,message_id) REFERENCES mail_messages(workspace_id,customer_id,id),
  FOREIGN KEY(workspace_id,customer_id,person_id) REFERENCES people(workspace_id,customer_id,id)
);
CREATE INDEX mail_customer_date ON mail_messages(workspace_id,customer_id,occurred_at DESC,id);
CREATE INDEX mail_person ON mail_people(workspace_id,person_id,message_id);
ALTER TABLE mail_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_people ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON mail_accounts,mail_messages TO light_crm_app;
GRANT SELECT,INSERT,DELETE ON mail_people TO light_crm_app;
CREATE POLICY mail_account_admin ON mail_accounts FOR ALL USING(crm_admin(workspace_id)) WITH CHECK(crm_admin(workspace_id));
CREATE POLICY mail_read ON mail_messages FOR SELECT USING(CASE WHEN customer_id IS NULL THEN crm_admin(workspace_id) ELSE crm_access(workspace_id,customer_id) END);
CREATE POLICY mail_create ON mail_messages FOR INSERT WITH CHECK(crm_admin(workspace_id));
CREATE POLICY mail_edit ON mail_messages FOR UPDATE USING(crm_admin(workspace_id)) WITH CHECK(crm_admin(workspace_id));
CREATE POLICY mail_people_read ON mail_people FOR SELECT USING(crm_access(workspace_id,customer_id));
CREATE POLICY mail_people_write ON mail_people FOR ALL USING(crm_admin(workspace_id)) WITH CHECK(crm_admin(workspace_id));
CREATE FUNCTION crm_mail_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.fingerprint<>OLD.fingerprint OR (OLD.customer_id IS NOT NULL AND NEW.customer_id IS DISTINCT FROM OLD.customer_id) THEN
    RAISE EXCEPTION 'mail scope is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mail_scope BEFORE UPDATE ON mail_messages FOR EACH ROW EXECUTE FUNCTION crm_mail_scope();
CREATE TRIGGER mail_audit AFTER INSERT OR UPDATE ON mail_messages FOR EACH ROW WHEN(NEW.customer_id IS NOT NULL) EXECUTE FUNCTION crm_audit();
