CREATE TABLE people (
  workspace_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  job_title text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  is_primary boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,customer_id,id),
  FOREIGN KEY (workspace_id,customer_id) REFERENCES customers(workspace_id,id)
);
CREATE UNIQUE INDEX people_primary ON people(workspace_id,customer_id) WHERE is_primary;
CREATE INDEX people_customer ON people(workspace_id,customer_id,updated_at DESC);
-- Preserve explicit legacy contacts only; a company inbox alone is not evidence of a person.
INSERT INTO people(workspace_id,customer_id,id,name,email,phone,is_primary,created_at,updated_at)
  SELECT workspace_id,id,gen_random_uuid(),contact_name,email,phone,true,created_at,updated_at
  FROM customers WHERE trim(contact_name) <> '';
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON people TO light_crm_app;
CREATE POLICY people_read ON people FOR SELECT USING (crm_access(workspace_id,customer_id));
CREATE POLICY people_create ON people FOR INSERT WITH CHECK (crm_access(workspace_id,customer_id,true));
CREATE POLICY people_edit ON people FOR UPDATE USING (crm_access(workspace_id,customer_id,true)) WITH CHECK (crm_access(workspace_id,customer_id,true));
CREATE FUNCTION crm_person_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.customer_id <> OLD.customer_id OR NEW.is_primary <> OLD.is_primary THEN
    RAISE EXCEPTION 'person scope is immutable' USING ERRCODE = '23514';
  END IF;
  NEW.version := OLD.version + 1; NEW.updated_at := now(); RETURN NEW;
END $$;
CREATE TRIGGER person_scope BEFORE UPDATE ON people FOR EACH ROW EXECUTE FUNCTION crm_person_scope();
CREATE TRIGGER person_audit AFTER INSERT OR UPDATE ON people FOR EACH ROW EXECUTE FUNCTION crm_audit();
ALTER TABLE record_lists DROP CONSTRAINT record_lists_object_check;
ALTER TABLE record_lists ADD CHECK (object IN ('customers','projects','people'));
ALTER TABLE saved_views DROP CONSTRAINT saved_views_object_check;
ALTER TABLE saved_views ADD CHECK (object IN ('customers','projects','people'));
ALTER TABLE list_entries ADD COLUMN person_id uuid;
ALTER TABLE list_entries ADD FOREIGN KEY(workspace_id,customer_id,person_id) REFERENCES people(workspace_id,customer_id,id);
ALTER TABLE list_entries DROP CONSTRAINT list_entries_check;
ALTER TABLE list_entries ADD CHECK (
  (object='customers' AND project_id IS NULL AND person_id IS NULL) OR
  (object='projects' AND project_id IS NOT NULL AND person_id IS NULL) OR
  (object='people' AND project_id IS NULL AND person_id IS NOT NULL)
);
DROP INDEX list_customer_entry;
CREATE UNIQUE INDEX list_customer_entry ON list_entries(workspace_id,list_id,customer_id) WHERE object='customers';
CREATE UNIQUE INDEX list_person_entry ON list_entries(workspace_id,list_id,person_id) WHERE object='people';
