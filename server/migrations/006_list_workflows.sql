CREATE TABLE list_fields (
  workspace_id uuid NOT NULL, actor_id uuid NOT NULL, list_id uuid NOT NULL, id uuid NOT NULL,
  name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60),
  kind text NOT NULL CHECK(kind IN ('stage','member','date','currency','text')),
  options jsonb NOT NULL DEFAULT '[]', currency text NOT NULL DEFAULT 'CNY' CHECK(currency IN ('CNY','USD','EUR')),
  position integer NOT NULL DEFAULT 0, archived boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,list_id) REFERENCES record_lists(workspace_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX list_field_name ON list_fields(workspace_id,list_id,lower(trim(name))) WHERE NOT archived;
ALTER TABLE list_fields ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON list_fields TO light_crm_app;
CREATE POLICY list_field_owner ON list_fields FOR ALL
 USING(workspace_id=crm_workspace() AND actor_id=crm_actor() AND EXISTS(SELECT 1 FROM record_lists l WHERE l.workspace_id=list_fields.workspace_id AND l.id=list_fields.list_id AND l.actor_id=list_fields.actor_id))
 WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor() AND EXISTS(SELECT 1 FROM record_lists l WHERE l.workspace_id=list_fields.workspace_id AND l.id=list_fields.list_id AND l.actor_id=list_fields.actor_id));
CREATE FUNCTION crm_list_field_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.workspace_id<>OLD.workspace_id OR NEW.actor_id<>OLD.actor_id OR NEW.list_id<>OLD.list_id OR NEW.id<>OLD.id OR NEW.kind<>OLD.kind OR NEW.currency<>OLD.currency THEN
  RAISE EXCEPTION 'list field scope and type are immutable' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(OLD.options) o WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.options) n WHERE n->>'id'=o->>'id')) THEN
  RAISE EXCEPTION 'existing stages must retain their IDs' USING ERRCODE='23514'; END IF;
 NEW.version:=OLD.version+1; NEW.updated_at:=now(); RETURN NEW;
END $$;
CREATE TRIGGER list_field_scope BEFORE UPDATE ON list_fields FOR EACH ROW EXECUTE FUNCTION crm_list_field_scope();
CREATE FUNCTION crm_seed_list_fields(w uuid,a uuid,l uuid) RETURNS void LANGUAGE sql AS $$
 INSERT INTO list_fields(workspace_id,actor_id,list_id,id,name,kind,position,options)
 SELECT w,a,l,gen_random_uuid(),n,k,p,CASE WHEN k='stage' THEN jsonb_build_array(
  jsonb_build_object('id',gen_random_uuid(),'label','待联系','color','gray'),
  jsonb_build_object('id',gen_random_uuid(),'label','沟通中','color','blue'),
  jsonb_build_object('id',gen_random_uuid(),'label','方案确认','color','orange'),
  jsonb_build_object('id',gen_random_uuid(),'label','已完成','color','green')) ELSE '[]'::jsonb END
 FROM (VALUES('阶段','stage',0),('负责人','member',1),('目标日期','date',2),('预计金额','currency',3)) AS fields(n,k,p)
$$;
REVOKE ALL ON FUNCTION crm_seed_list_fields(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_seed_list_fields(uuid,uuid,uuid) TO light_crm_app;
SELECT crm_seed_list_fields(workspace_id,actor_id,id) FROM record_lists;
CREATE FUNCTION crm_list_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM crm_seed_list_fields(NEW.workspace_id,NEW.actor_id,NEW.id); RETURN NEW; END $$;
CREATE TRIGGER list_defaults AFTER INSERT ON record_lists FOR EACH ROW EXECUTE FUNCTION crm_list_defaults();

ALTER TABLE list_entries ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE list_entries ADD PRIMARY KEY(workspace_id,id);
ALTER TABLE list_entries ADD COLUMN field_values jsonb NOT NULL DEFAULT '{}';
ALTER TABLE list_entries ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE list_entries ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
GRANT UPDATE(field_values) ON list_entries TO light_crm_app;
DROP POLICY personal_list_entries ON list_entries;
CREATE POLICY list_entry_read ON list_entries FOR SELECT USING(workspace_id=crm_workspace() AND actor_id=crm_actor() AND crm_access(workspace_id,customer_id));
CREATE POLICY list_entry_create ON list_entries FOR INSERT WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor() AND crm_access(workspace_id,customer_id));
CREATE POLICY list_entry_remove ON list_entries FOR DELETE USING(workspace_id=crm_workspace() AND actor_id=crm_actor() AND crm_access(workspace_id,customer_id));
CREATE POLICY list_entry_edit ON list_entries FOR UPDATE USING(workspace_id=crm_workspace() AND actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true)) WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true));
CREATE FUNCTION crm_list_values() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; f list_fields; field_text text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.actor_id<>OLD.actor_id OR NEW.list_id<>OLD.list_id OR NEW.id<>OLD.id OR NEW.customer_id<>OLD.customer_id OR NEW.object<>OLD.object OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.person_id IS DISTINCT FROM OLD.person_id THEN RAISE EXCEPTION 'entry scope is immutable' USING ERRCODE='23514'; END IF;
  NEW.version:=OLD.version+1; NEW.updated_at:=now();
 END IF;
 IF TG_OP='INSERT' AND NEW.field_values<>'{}'::jsonb AND NOT crm_access(NEW.workspace_id,NEW.customer_id,true) THEN RAISE EXCEPTION 'entry edit access required' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(NEW.field_values)<>'object' THEN RAISE EXCEPTION 'invalid values' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT * FROM jsonb_each(NEW.field_values) LOOP
  IF TG_OP='UPDATE' AND OLD.field_values->item.key IS NOT DISTINCT FROM item.value THEN CONTINUE; END IF;
  SELECT * INTO f FROM list_fields WHERE workspace_id=NEW.workspace_id AND list_id=NEW.list_id AND id=item.key::uuid AND NOT archived;
  IF f.id IS NULL THEN RAISE EXCEPTION 'field not in list' USING ERRCODE='23514'; END IF;
  IF item.value='null'::jsonb THEN CONTINUE; END IF;
  IF jsonb_typeof(item.value)<>'string' THEN RAISE EXCEPTION 'invalid field field_text' USING ERRCODE='23514'; END IF;
  field_text:=item.value#>>'{}';
  IF f.kind='stage' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(f.options) o WHERE o->>'id'=field_text) THEN RAISE EXCEPTION 'unknown stage' USING ERRCODE='23514'; END IF;
  IF f.kind='member' AND NOT EXISTS(SELECT 1 FROM workspace_people m WHERE m.workspace_id=NEW.workspace_id AND m.actor_id::text=field_text AND active) THEN RAISE EXCEPTION 'unknown member' USING ERRCODE='23514'; END IF;
  IF f.kind='date' THEN
   IF field_text !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'invalid date' USING ERRCODE='23514'; END IF;
   PERFORM field_text::date;
  END IF;
  IF f.kind='currency' AND field_text !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$' THEN RAISE EXCEPTION 'invalid amount' USING ERRCODE='23514'; END IF;
  IF length(field_text)>2000 THEN RAISE EXCEPTION 'field_text too long' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER list_entry_values BEFORE INSERT OR UPDATE ON list_entries FOR EACH ROW EXECUTE FUNCTION crm_list_values();
CREATE TRIGGER list_entry_audit AFTER INSERT OR UPDATE OR DELETE ON list_entries FOR EACH ROW EXECUTE FUNCTION crm_audit();
