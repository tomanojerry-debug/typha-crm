-- The graph is a rebuildable projection, never an authority for CRM field writes.
CREATE TABLE knowledge_sync (
 workspace_id uuid NOT NULL, customer_id uuid NOT NULL, actor_id uuid NOT NULL,
 requested_version bigint NOT NULL DEFAULT 1, applied_version bigint NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','syncing','ready','failed')),
 lease_token uuid, lease_until timestamptz, retry_at timestamptz,
 digest text, schema_revision text, generation uuid, facts jsonb NOT NULL DEFAULT '[]',
 attempts integer NOT NULL DEFAULT 0, error text, synced_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,customer_id),
 FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id)
);
ALTER TABLE knowledge_sync ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON knowledge_sync TO light_crm_app;
CREATE POLICY knowledge_read ON knowledge_sync FOR SELECT USING(crm_access(workspace_id,customer_id));
CREATE POLICY knowledge_write ON knowledge_sync FOR ALL USING(crm_access(workspace_id,customer_id,true)) WITH CHECK(crm_access(workspace_id,customer_id,true));

-- Only selected, reviewed WeChat evidence is copied out of the actor-private preview.
CREATE TABLE knowledge_wechat_evidence (
 workspace_id uuid NOT NULL, customer_id uuid NOT NULL, id uuid NOT NULL,
 source_key text NOT NULL, record_id uuid NOT NULL, project_id uuid, person_id uuid,
 occurred_at timestamptz NOT NULL, speaker text NOT NULL, body text NOT NULL,
 created_by uuid NOT NULL,
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,customer_id,source_key),
 FOREIGN KEY(workspace_id,customer_id,record_id) REFERENCES customer_records(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,project_id) REFERENCES projects(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,person_id) REFERENCES people(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,actor_id)
);
ALTER TABLE knowledge_wechat_evidence ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON knowledge_wechat_evidence TO light_crm_app;
CREATE POLICY knowledge_evidence_read ON knowledge_wechat_evidence FOR SELECT USING(crm_access(workspace_id,customer_id));
CREATE POLICY knowledge_evidence_create ON knowledge_wechat_evidence FOR INSERT WITH CHECK(created_by=crm_actor() AND crm_access(workspace_id,customer_id,true));

CREATE FUNCTION crm_knowledge_touch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb; w uuid; c uuid; a uuid;
BEGIN
 r := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 w := (r->>'workspace_id')::uuid; a := crm_actor();
 IF a IS NULL OR w IS DISTINCT FROM crm_workspace() THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME IN ('customer_attributes','relationship_definitions','mail_exclusions') THEN
   INSERT INTO knowledge_sync(workspace_id,customer_id,actor_id)
   SELECT w,id,a FROM customers WHERE workspace_id=w AND archived_at IS NULL
   ON CONFLICT(workspace_id,customer_id) DO UPDATE SET
    requested_version=knowledge_sync.requested_version+1,actor_id=a,state='pending',attempts=0,error=NULL,retry_at=NULL,updated_at=now();
 ELSE
   c := CASE WHEN TG_TABLE_NAME='customers' THEN (r->>'id')::uuid ELSE (r->>'customer_id')::uuid END;
   IF c IS NOT NULL THEN
     INSERT INTO knowledge_sync(workspace_id,customer_id,actor_id) VALUES(w,c,a)
     ON CONFLICT(workspace_id,customer_id) DO UPDATE SET
      requested_version=knowledge_sync.requested_version+1,actor_id=a,state='pending',attempts=0,error=NULL,retry_at=NULL,updated_at=now();
   END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crm_knowledge_touch() FROM PUBLIC;
CREATE TRIGGER knowledge_customer AFTER INSERT OR UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION crm_knowledge_touch();
CREATE TRIGGER knowledge_person AFTER INSERT OR UPDATE ON people FOR EACH ROW EXECUTE FUNCTION crm_knowledge_touch();
CREATE TRIGGER knowledge_project AFTER INSERT OR UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION crm_knowledge_touch();
CREATE TRIGGER knowledge_record AFTER INSERT ON customer_records FOR EACH ROW EXECUTE FUNCTION crm_knowledge_touch();
CREATE TRIGGER knowledge_attribute AFTER INSERT OR UPDATE ON customer_attributes FOR EACH ROW EXECUTE FUNCTION crm_knowledge_touch();
CREATE TRIGGER knowledge_value AFTER INSERT OR UPDATE ON customer_attribute_values FOR EACH ROW EXECUTE FUNCTION crm_knowledge_touch();
CREATE TRIGGER knowledge_definition AFTER INSERT ON relationship_definitions FOR EACH ROW EXECUTE FUNCTION crm_knowledge_touch();
CREATE TRIGGER knowledge_edge AFTER INSERT OR DELETE ON relationship_edges FOR EACH ROW EXECUTE FUNCTION crm_knowledge_touch();
CREATE TRIGGER knowledge_mail AFTER INSERT OR UPDATE ON mail_messages FOR EACH ROW EXECUTE FUNCTION crm_knowledge_touch();
CREATE TRIGGER knowledge_mail_person AFTER INSERT OR DELETE ON mail_people FOR EACH ROW EXECUTE FUNCTION crm_knowledge_touch();
CREATE TRIGGER knowledge_exclusion AFTER INSERT OR UPDATE OR DELETE ON mail_exclusions FOR EACH ROW EXECUTE FUNCTION crm_knowledge_touch();
CREATE TRIGGER knowledge_wechat AFTER INSERT ON knowledge_wechat_evidence FOR EACH ROW EXECUTE FUNCTION crm_knowledge_touch();
