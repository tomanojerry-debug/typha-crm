CREATE TABLE record_lists (
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  id uuid NOT NULL,
  object text NOT NULL CHECK (object IN ('customers', 'projects')),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, actor_id, id, object),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES memberships(workspace_id, actor_id)
);
ALTER TABLE record_lists ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON record_lists TO light_crm_app;
CREATE POLICY personal_lists ON record_lists FOR ALL
  USING (workspace_id = crm_workspace() AND actor_id = crm_actor() AND EXISTS (
    SELECT 1 FROM workspace_people m WHERE m.workspace_id = record_lists.workspace_id AND m.actor_id = crm_actor() AND m.active))
  WITH CHECK (workspace_id = crm_workspace() AND actor_id = crm_actor());
CREATE TRIGGER record_list_scope BEFORE UPDATE ON record_lists FOR EACH ROW EXECUTE FUNCTION crm_view_scope();

CREATE TABLE list_entries (
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  list_id uuid NOT NULL,
  object text NOT NULL,
  customer_id uuid NOT NULL,
  project_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((object = 'customers' AND project_id IS NULL) OR (object = 'projects' AND project_id IS NOT NULL)),
  FOREIGN KEY (workspace_id, actor_id, list_id, object) REFERENCES record_lists(workspace_id, actor_id, id, object) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, customer_id) REFERENCES customers(workspace_id, id),
  FOREIGN KEY (workspace_id, customer_id, project_id) REFERENCES projects(workspace_id, customer_id, id)
);
CREATE UNIQUE INDEX list_customer_entry ON list_entries(workspace_id, list_id, customer_id) WHERE project_id IS NULL;
CREATE UNIQUE INDEX list_project_entry ON list_entries(workspace_id, list_id, project_id) WHERE project_id IS NOT NULL;
ALTER TABLE list_entries ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON list_entries TO light_crm_app;
CREATE POLICY personal_list_entries ON list_entries FOR ALL
  USING (workspace_id = crm_workspace() AND actor_id = crm_actor() AND crm_access(workspace_id, customer_id))
  WITH CHECK (workspace_id = crm_workspace() AND actor_id = crm_actor() AND crm_access(workspace_id, customer_id));

ALTER TABLE saved_views ADD COLUMN list_id uuid;
ALTER TABLE saved_views ADD FOREIGN KEY (workspace_id, actor_id, list_id, object)
  REFERENCES record_lists(workspace_id, actor_id, id, object) ON DELETE CASCADE;
CREATE FUNCTION crm_saved_view_list_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.list_id IS DISTINCT FROM OLD.list_id THEN
    RAISE EXCEPTION 'view list scope is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER saved_view_list_scope BEFORE UPDATE ON saved_views FOR EACH ROW EXECUTE FUNCTION crm_saved_view_list_scope();
