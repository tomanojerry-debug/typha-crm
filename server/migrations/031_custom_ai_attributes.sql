ALTER TABLE custom_object_attributes ADD COLUMN description text NOT NULL DEFAULT '' CHECK(length(description)<=1000);
ALTER TABLE custom_object_attributes ADD COLUMN ai_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE custom_object_attributes ADD COLUMN guidance text NOT NULL DEFAULT '' CHECK(length(guidance)<=4000);
ALTER TABLE custom_object_records ADD COLUMN field_provenance jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(field_provenance)='object');
ALTER TABLE custom_object_records ADD UNIQUE(workspace_id,object_id,id,customer_id);

CREATE TABLE custom_attribute_runs (
 workspace_id uuid NOT NULL, object_id uuid NOT NULL, record_id uuid NOT NULL,
 customer_id uuid NOT NULL, attribute_id uuid NOT NULL, actor_id uuid NOT NULL, id uuid NOT NULL,
 object_version integer NOT NULL, attribute_version integer NOT NULL, record_version integer NOT NULL,
 context_digest text NOT NULL, retrieval_plan jsonb NOT NULL,
 guidance text NOT NULL, value jsonb NOT NULL, explanation text NOT NULL,
 missing jsonb NOT NULL, sources jsonb NOT NULL, evidence jsonb NOT NULL, warnings jsonb NOT NULL,
 model text NOT NULL, state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','applied')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,object_id,record_id,attribute_id,id),
 FOREIGN KEY(workspace_id,object_id,record_id,customer_id) REFERENCES custom_object_records(workspace_id,object_id,id,customer_id),
 FOREIGN KEY(workspace_id,object_id,attribute_id) REFERENCES custom_object_attributes(workspace_id,object_id,id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id)
);
ALTER TABLE custom_attribute_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON custom_attribute_runs TO light_crm_app;
CREATE POLICY custom_ai_run_read ON custom_attribute_runs FOR SELECT USING(actor_id=crm_actor() AND crm_access(workspace_id,customer_id));
CREATE POLICY custom_ai_run_create ON custom_attribute_runs FOR INSERT WITH CHECK(actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true));
CREATE POLICY custom_ai_run_edit ON custom_attribute_runs FOR UPDATE USING(actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true)) WITH CHECK(actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true));
CREATE FUNCTION crm_custom_ai_run_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR OLD.state='applied' THEN
  RAISE EXCEPTION 'custom attribute run immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER custom_ai_run_scope BEFORE UPDATE ON custom_attribute_runs FOR EACH ROW EXECUTE FUNCTION crm_custom_ai_run_scope();
