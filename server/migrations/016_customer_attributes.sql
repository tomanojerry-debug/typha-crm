CREATE TABLE customer_attributes (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60),
 kind text NOT NULL CHECK(kind IN ('text','number','select','multi_select')),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=1000),
 options jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(options)='array'),
 ai_enabled boolean NOT NULL DEFAULT false,
 guidance text NOT NULL DEFAULT '' CHECK(length(guidance)<=4000),
 archived boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id)
);
CREATE UNIQUE INDEX customer_attribute_name ON customer_attributes(workspace_id,lower(name)) WHERE NOT archived;
ALTER TABLE customer_attributes ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON customer_attributes TO light_crm_app;
CREATE POLICY attribute_read ON customer_attributes FOR SELECT USING(workspace_id=crm_workspace());
CREATE POLICY attribute_create ON customer_attributes FOR INSERT WITH CHECK(crm_admin(workspace_id));
CREATE POLICY attribute_edit ON customer_attributes FOR UPDATE USING(crm_admin(workspace_id)) WITH CHECK(crm_admin(workspace_id));
CREATE FUNCTION crm_attribute_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.workspace_id,NEW.id,NEW.kind) IS DISTINCT FROM (OLD.workspace_id,OLD.id,OLD.kind) THEN
  RAISE EXCEPTION 'attribute scope and kind are immutable' USING ERRCODE='23514';
 END IF;
 NEW.version:=OLD.version+1; NEW.updated_at:=now(); RETURN NEW;
END $$;
CREATE TRIGGER attribute_scope BEFORE UPDATE ON customer_attributes FOR EACH ROW EXECUTE FUNCTION crm_attribute_scope();

CREATE TABLE customer_attribute_values (
 workspace_id uuid NOT NULL, customer_id uuid NOT NULL, attribute_id uuid NOT NULL, id uuid NOT NULL,
 value jsonb NOT NULL, origin text NOT NULL CHECK(origin IN ('manual','ai')),
 explanation text NOT NULL DEFAULT '', sources jsonb NOT NULL DEFAULT '[]',
 generated_at timestamptz, run_id uuid,
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,customer_id,attribute_id), UNIQUE(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
 FOREIGN KEY(workspace_id,attribute_id) REFERENCES customer_attributes(workspace_id,id)
);
ALTER TABLE customer_attribute_values ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON customer_attribute_values TO light_crm_app;
CREATE POLICY attribute_value_read ON customer_attribute_values FOR SELECT USING(crm_access(workspace_id,customer_id));
CREATE POLICY attribute_value_create ON customer_attribute_values FOR INSERT WITH CHECK(crm_access(workspace_id,customer_id,true));
CREATE POLICY attribute_value_edit ON customer_attribute_values FOR UPDATE USING(crm_access(workspace_id,customer_id,true)) WITH CHECK(crm_access(workspace_id,customer_id,true));
CREATE FUNCTION crm_attribute_value_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.workspace_id,NEW.customer_id,NEW.attribute_id,NEW.id) IS DISTINCT FROM (OLD.workspace_id,OLD.customer_id,OLD.attribute_id,OLD.id) THEN
  RAISE EXCEPTION 'attribute value scope is immutable' USING ERRCODE='23514';
 END IF;
 NEW.version:=OLD.version+1; NEW.updated_at:=now(); RETURN NEW;
END $$;
CREATE TRIGGER attribute_value_scope BEFORE UPDATE ON customer_attribute_values FOR EACH ROW EXECUTE FUNCTION crm_attribute_value_scope();
CREATE TRIGGER attribute_value_audit AFTER INSERT OR UPDATE ON customer_attribute_values FOR EACH ROW EXECUTE FUNCTION crm_audit();

CREATE TABLE customer_attribute_runs (
 workspace_id uuid NOT NULL, customer_id uuid NOT NULL, attribute_id uuid NOT NULL, actor_id uuid NOT NULL,
 id uuid NOT NULL, attribute_version integer NOT NULL, value_version integer NOT NULL,
 context_digest text NOT NULL, guidance text NOT NULL, value jsonb NOT NULL,
 explanation text NOT NULL, missing jsonb NOT NULL, sources jsonb NOT NULL, warnings jsonb NOT NULL,
 model text NOT NULL, state text NOT NULL DEFAULT 'preview' CHECK(state IN ('preview','applied')),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,customer_id,attribute_id,id),
 FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
 FOREIGN KEY(workspace_id,attribute_id) REFERENCES customer_attributes(workspace_id,id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id)
);
ALTER TABLE customer_attribute_values ADD FOREIGN KEY(workspace_id,customer_id,attribute_id,run_id) REFERENCES customer_attribute_runs(workspace_id,customer_id,attribute_id,id);
ALTER TABLE customer_attribute_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON customer_attribute_runs TO light_crm_app;
CREATE POLICY attribute_run_read ON customer_attribute_runs FOR SELECT USING(actor_id=crm_actor() AND crm_access(workspace_id,customer_id));
CREATE POLICY attribute_run_create ON customer_attribute_runs FOR INSERT WITH CHECK(actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true));
CREATE POLICY attribute_run_edit ON customer_attribute_runs FOR UPDATE USING(actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true)) WITH CHECK(actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true));
CREATE FUNCTION crm_attribute_run_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR OLD.state='applied' THEN
  RAISE EXCEPTION 'attribute preview is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attribute_run_scope BEFORE UPDATE ON customer_attribute_runs FOR EACH ROW EXECUTE FUNCTION crm_attribute_run_scope();

CREATE TABLE attribute_model_settings (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id), encrypted_key text NOT NULL,
 region text NOT NULL CHECK(region IN ('cn','global')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE attribute_model_settings ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON attribute_model_settings TO light_crm_app;
CREATE POLICY attribute_model_read ON attribute_model_settings FOR SELECT USING(crm_admin(workspace_id));
CREATE POLICY attribute_model_create ON attribute_model_settings FOR INSERT WITH CHECK(crm_admin(workspace_id));
CREATE POLICY attribute_model_edit ON attribute_model_settings FOR UPDATE USING(crm_admin(workspace_id)) WITH CHECK(crm_admin(workspace_id));
CREATE FUNCTION crm_attribute_model_config(w uuid,c uuid DEFAULT NULL) RETURNS TABLE(configured boolean,region text,encrypted_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT true,s.region,CASE WHEN crm_admin(w) OR (c IS NOT NULL AND crm_access(w,c,true)) THEN s.encrypted_key ELSE NULL END
 FROM attribute_model_settings s WHERE s.workspace_id=w AND w=crm_workspace()
 AND EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=w AND m.actor_id=crm_actor() AND m.active)
$$;
REVOKE ALL ON FUNCTION crm_attribute_model_config(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_attribute_model_config(uuid,uuid) TO light_crm_app;
