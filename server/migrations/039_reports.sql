CREATE TABLE report_dashboards (
 workspace_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 id uuid NOT NULL,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=1000),
 widgets jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(widgets)='array' AND jsonb_array_length(widgets)<=24),
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id)
);
ALTER TABLE report_dashboards ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON report_dashboards TO light_crm_app;
CREATE POLICY report_dashboard_private ON report_dashboards FOR ALL
 USING(workspace_id=crm_workspace() AND actor_id=crm_actor())
 WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor());
CREATE FUNCTION crm_report_dashboard_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.workspace_id,NEW.actor_id,NEW.id,NEW.created_at) IS DISTINCT FROM (OLD.workspace_id,OLD.actor_id,OLD.id,OLD.created_at) THEN
  RAISE EXCEPTION 'report dashboard identity is immutable' USING ERRCODE='23514';
 END IF;
 NEW.version:=OLD.version+1;
 NEW.updated_at:=now();
 RETURN NEW;
END $$;
CREATE TRIGGER report_dashboard_touch BEFORE UPDATE ON report_dashboards FOR EACH ROW EXECUTE FUNCTION crm_report_dashboard_touch();
CREATE INDEX report_dashboard_recent ON report_dashboards(workspace_id,actor_id,updated_at DESC,id);
