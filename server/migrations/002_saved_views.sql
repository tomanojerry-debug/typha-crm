CREATE TABLE saved_views (
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  id uuid NOT NULL,
  object text NOT NULL CHECK (object IN ('customers', 'projects')),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES memberships(workspace_id, actor_id)
);
CREATE INDEX saved_views_owner ON saved_views(workspace_id, actor_id, created_at);
ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON saved_views TO light_crm_app;
CREATE POLICY personal_views ON saved_views FOR ALL
  USING (workspace_id = crm_workspace() AND actor_id = crm_actor() AND EXISTS (
    SELECT 1 FROM workspace_people m WHERE m.workspace_id = saved_views.workspace_id
      AND m.actor_id = crm_actor() AND m.active
  ))
  WITH CHECK (workspace_id = crm_workspace() AND actor_id = crm_actor() AND EXISTS (
    SELECT 1 FROM workspace_people m WHERE m.workspace_id = saved_views.workspace_id
      AND m.actor_id = crm_actor() AND m.active
  ));
CREATE FUNCTION crm_view_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id
     OR NEW.actor_id <> OLD.actor_id OR NEW.object <> OLD.object THEN
    RAISE EXCEPTION 'view scope is immutable' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER saved_view_scope BEFORE UPDATE ON saved_views
  FOR EACH ROW EXECUTE FUNCTION crm_view_scope();
