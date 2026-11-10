CREATE TABLE custom_objects (
 workspace_id uuid NOT NULL REFERENCES workspaces(id), id uuid NOT NULL,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60),
 singular_name text NOT NULL CHECK(length(trim(singular_name)) BETWEEN 1 AND 60),
 slug text NOT NULL CHECK(slug ~ '^[a-z][a-z0-9_]{1,47}$'),
 icon text NOT NULL, color text NOT NULL,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,slug)
);
CREATE UNIQUE INDEX custom_object_name ON custom_objects(workspace_id,lower(name));
CREATE TABLE custom_object_attributes (
 workspace_id uuid NOT NULL, object_id uuid NOT NULL, id uuid NOT NULL,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60),
 kind text NOT NULL CHECK(kind IN ('text','number','currency','date','timestamp','checkbox','rating','select','multi_select')),
 options jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(options)='array'),
 required boolean NOT NULL DEFAULT false, is_unique boolean NOT NULL DEFAULT false,
 currency text NOT NULL DEFAULT 'CNY' CHECK(currency IN ('CNY','USD','EUR','GBP','JPY')), archived boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,object_id,id),
 FOREIGN KEY(workspace_id,object_id) REFERENCES custom_objects(workspace_id,id)
);
CREATE UNIQUE INDEX custom_object_attribute_name ON custom_object_attributes(workspace_id,object_id,lower(name)) WHERE NOT archived;
CREATE TABLE custom_object_records (
 workspace_id uuid NOT NULL, object_id uuid NOT NULL, id uuid NOT NULL,
 customer_id uuid NOT NULL, project_id uuid,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
 values jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(values)='object'),
 created_by uuid NOT NULL, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
 PRIMARY KEY(workspace_id,object_id,id),
 FOREIGN KEY(workspace_id,object_id) REFERENCES custom_objects(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id,project_id) REFERENCES projects(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,actor_id)
);
CREATE INDEX custom_record_browse ON custom_object_records(workspace_id,object_id,updated_at DESC,id);
CREATE INDEX custom_record_customer ON custom_object_records(workspace_id,customer_id);
ALTER TABLE custom_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_object_attributes ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_object_records ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON custom_objects,custom_object_attributes,custom_object_records TO light_crm_app;
CREATE POLICY custom_object_read ON custom_objects FOR SELECT USING(workspace_id=crm_workspace());
CREATE POLICY custom_object_create ON custom_objects FOR INSERT WITH CHECK(crm_admin(workspace_id));
CREATE POLICY custom_object_edit ON custom_objects FOR UPDATE USING(crm_admin(workspace_id)) WITH CHECK(crm_admin(workspace_id));
CREATE POLICY custom_field_read ON custom_object_attributes FOR SELECT USING(workspace_id=crm_workspace());
CREATE POLICY custom_field_create ON custom_object_attributes FOR INSERT WITH CHECK(crm_admin(workspace_id));
CREATE POLICY custom_field_edit ON custom_object_attributes FOR UPDATE USING(crm_admin(workspace_id)) WITH CHECK(crm_admin(workspace_id));
CREATE POLICY custom_record_read ON custom_object_records FOR SELECT USING(crm_access(workspace_id,customer_id));
CREATE POLICY custom_record_create ON custom_object_records FOR INSERT WITH CHECK(crm_access(workspace_id,customer_id,true) AND created_by=crm_actor());
CREATE POLICY custom_record_edit ON custom_object_records FOR UPDATE USING(crm_access(workspace_id,customer_id,true)) WITH CHECK(crm_access(workspace_id,customer_id,true));
CREATE FUNCTION crm_custom_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.workspace_id,NEW.id) IS DISTINCT FROM (OLD.workspace_id,OLD.id) THEN RAISE EXCEPTION 'custom scope immutable' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='custom_objects' THEN
  IF NEW.slug<>OLD.slug THEN RAISE EXCEPTION 'object slug immutable' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.object_id<>OLD.object_id THEN RAISE EXCEPTION 'object immutable' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='custom_object_attributes' THEN
   IF NEW.kind<>OLD.kind THEN RAISE EXCEPTION 'field kind immutable' USING ERRCODE='23514'; END IF;
  ELSE
   IF (NEW.customer_id,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.customer_id,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'record owner immutable' USING ERRCODE='23514'; END IF;
   NEW.updated_at:=now();
  END IF;
 END IF;
 NEW.version:=OLD.version+1; RETURN NEW;
END $$;
CREATE TRIGGER custom_object_scope BEFORE UPDATE ON custom_objects FOR EACH ROW EXECUTE FUNCTION crm_custom_scope();
CREATE TRIGGER custom_field_scope BEFORE UPDATE ON custom_object_attributes FOR EACH ROW EXECUTE FUNCTION crm_custom_scope();
CREATE TRIGGER custom_record_scope BEFORE UPDATE ON custom_object_records FOR EACH ROW EXECUTE FUNCTION crm_custom_scope();
CREATE TRIGGER custom_record_audit AFTER INSERT OR UPDATE ON custom_object_records FOR EACH ROW EXECUTE FUNCTION crm_audit();

-- Separate keys enforce uniqueness across all customers without exposing their rows.
CREATE TABLE custom_unique_values (
 workspace_id uuid NOT NULL, object_id uuid NOT NULL, attribute_id uuid NOT NULL, record_id uuid NOT NULL,
 value text NOT NULL CHECK(length(value)<=600),
 PRIMARY KEY(workspace_id,object_id,attribute_id,record_id),
 UNIQUE(workspace_id,object_id,attribute_id,value),
 FOREIGN KEY(workspace_id,object_id,attribute_id) REFERENCES custom_object_attributes(workspace_id,object_id,id),
 FOREIGN KEY(workspace_id,object_id,record_id) REFERENCES custom_object_records(workspace_id,object_id,id)
);
REVOKE ALL ON custom_unique_values FROM PUBLIC,light_crm_app;
CREATE FUNCTION crm_custom_unique() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF TG_TABLE_NAME='custom_object_records' THEN
  DELETE FROM custom_unique_values WHERE workspace_id=NEW.workspace_id AND object_id=NEW.object_id AND record_id=NEW.id;
  INSERT INTO custom_unique_values(workspace_id,object_id,attribute_id,record_id,value)
   SELECT NEW.workspace_id,NEW.object_id,a.id,NEW.id,(NEW.values->a.id::text)::text FROM custom_object_attributes a
   WHERE a.workspace_id=NEW.workspace_id AND a.object_id=NEW.object_id AND a.is_unique AND NOT a.archived AND NEW.values->a.id::text IS NOT NULL AND NEW.values->a.id::text<>'null'::jsonb;
 ELSE
  DELETE FROM custom_unique_values WHERE workspace_id=NEW.workspace_id AND object_id=NEW.object_id AND attribute_id=NEW.id;
  IF NEW.is_unique AND NOT NEW.archived THEN
   INSERT INTO custom_unique_values(workspace_id,object_id,attribute_id,record_id,value)
    SELECT NEW.workspace_id,NEW.object_id,NEW.id,r.id,(r.values->NEW.id::text)::text FROM custom_object_records r
    WHERE r.workspace_id=NEW.workspace_id AND r.object_id=NEW.object_id AND r.values->NEW.id::text IS NOT NULL AND r.values->NEW.id::text<>'null'::jsonb;
  END IF;
 END IF; RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crm_custom_unique() FROM PUBLIC;
CREATE TRIGGER custom_record_unique AFTER INSERT OR UPDATE ON custom_object_records FOR EACH ROW EXECUTE FUNCTION crm_custom_unique();
CREATE TRIGGER custom_field_unique AFTER INSERT OR UPDATE ON custom_object_attributes FOR EACH ROW EXECUTE FUNCTION crm_custom_unique();
