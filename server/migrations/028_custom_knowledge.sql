-- Saved custom rows are canonical CRM nodes, never extra evidence Records.
-- Every authorized mutation invalidates and queues the same customer generation.
CREATE TRIGGER knowledge_custom_record AFTER INSERT OR UPDATE ON custom_object_records
FOR EACH ROW EXECUTE FUNCTION crm_knowledge_touch();

CREATE FUNCTION crm_custom_knowledge_schema_touch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE w uuid; a uuid;
BEGIN
 w:=NEW.workspace_id; a:=crm_actor();
 IF a IS NULL OR w IS DISTINCT FROM crm_workspace() OR NOT crm_admin(w) THEN RETURN NULL; END IF;
 INSERT INTO knowledge_sync(workspace_id,customer_id,actor_id)
 SELECT w,id,a FROM customers WHERE workspace_id=w AND archived_at IS NULL AND crm_access(w,id,true)
 ON CONFLICT(workspace_id,customer_id) DO UPDATE SET
  requested_version=knowledge_sync.requested_version+1,actor_id=a,state='pending',
  attempts=0,error=NULL,retry_at=NULL,updated_at=now();
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crm_custom_knowledge_schema_touch() FROM PUBLIC;
CREATE TRIGGER knowledge_custom_object AFTER INSERT OR UPDATE ON custom_objects
FOR EACH ROW EXECUTE FUNCTION crm_custom_knowledge_schema_touch();
CREATE TRIGGER knowledge_custom_attribute AFTER INSERT OR UPDATE ON custom_object_attributes
FOR EACH ROW EXECUTE FUNCTION crm_custom_knowledge_schema_touch();
