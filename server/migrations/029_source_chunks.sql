-- PGlite bundles pgvector. External PostgreSQL must install the pgvector extension.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE source_index_sync (
 workspace_id uuid NOT NULL, customer_id uuid NOT NULL, actor_id uuid NOT NULL,
 requested_version bigint NOT NULL DEFAULT 1, applied_version bigint NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','indexing','ready','failed')),
 lease_token uuid, lease_until timestamptz, digest text, model_revision text,
 attempts integer NOT NULL DEFAULT 0, retry_at timestamptz, error text,
 indexed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,customer_id),
 FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id)
);
CREATE TABLE source_chunks (
 workspace_id uuid NOT NULL, customer_id uuid NOT NULL, id uuid NOT NULL,
 record_id uuid NOT NULL, source_id text NOT NULL, project_id uuid, person_ids uuid[] NOT NULL,
 source_hash text NOT NULL, start_offset integer NOT NULL, end_offset integer NOT NULL,
 body text NOT NULL, model_revision text NOT NULL, chunker_revision text NOT NULL,
 embedding vector(384) NOT NULL,
 PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id,record_id) REFERENCES customer_records(workspace_id,customer_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,customer_id,project_id) REFERENCES projects(workspace_id,customer_id,id),
 CHECK(start_offset>=0 AND end_offset>start_offset AND length(body)>0)
);
CREATE INDEX source_chunks_customer ON source_chunks(workspace_id,customer_id,project_id);
ALTER TABLE source_index_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_chunks ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON source_index_sync,source_chunks TO light_crm_app;
CREATE POLICY source_index_read ON source_index_sync FOR SELECT USING(crm_access(workspace_id,customer_id));
CREATE POLICY source_index_write ON source_index_sync FOR ALL USING(crm_access(workspace_id,customer_id,true)) WITH CHECK(crm_access(workspace_id,customer_id,true));
CREATE POLICY source_chunk_read ON source_chunks FOR SELECT USING(
 crm_access(workspace_id,customer_id)
);
CREATE POLICY source_chunk_write ON source_chunks FOR ALL USING(crm_access(workspace_id,customer_id,true)) WITH CHECK(crm_access(workspace_id,customer_id,true));
CREATE POLICY source_chunk_evidence_visible ON source_chunks AS RESTRICTIVE FOR SELECT USING(
 EXISTS(SELECT 1 FROM customer_records r WHERE r.workspace_id=source_chunks.workspace_id AND r.customer_id=source_chunks.customer_id AND r.id=record_id)
);
-- Excluded mail is invisible under SELECT RLS, including to a DELETE statement.
-- A narrow cache-only prune can remove those stale vectors after scope checking.
CREATE FUNCTION crm_prune_source_chunks(w uuid,c uuid,retained uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT crm_access(w,c,true) THEN RAISE EXCEPTION 'customer editor required' USING ERRCODE='42501'; END IF;
 DELETE FROM source_chunks s WHERE s.workspace_id=w AND s.customer_id=c AND NOT(s.id=ANY(retained));
END $$;
REVOKE ALL ON FUNCTION crm_prune_source_chunks(uuid,uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_prune_source_chunks(uuid,uuid,uuid[]) TO light_crm_app;
CREATE FUNCTION crm_source_index_touch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb; w uuid; c uuid; a uuid;
BEGIN
 r := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 w := (r->>'workspace_id')::uuid; a := crm_actor();
 IF a IS NULL OR w IS DISTINCT FROM crm_workspace() THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='mail_exclusions' THEN
   INSERT INTO source_index_sync(workspace_id,customer_id,actor_id)
   SELECT w,id,a FROM customers WHERE workspace_id=w AND archived_at IS NULL
   ON CONFLICT(workspace_id,customer_id) DO UPDATE SET requested_version=source_index_sync.requested_version+1,actor_id=a,state='pending',attempts=0,error=NULL,retry_at=NULL,updated_at=now();
 ELSE
   c := CASE WHEN TG_TABLE_NAME='customers' THEN (r->>'id')::uuid ELSE (r->>'customer_id')::uuid END;
   IF c IS NOT NULL THEN
     INSERT INTO source_index_sync(workspace_id,customer_id,actor_id) VALUES(w,c,a)
     ON CONFLICT(workspace_id,customer_id) DO UPDATE SET requested_version=source_index_sync.requested_version+1,actor_id=a,state='pending',attempts=0,error=NULL,retry_at=NULL,updated_at=now();
   END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crm_source_index_touch() FROM PUBLIC;
CREATE TRIGGER source_index_record AFTER INSERT OR UPDATE OR DELETE ON customer_records FOR EACH ROW EXECUTE FUNCTION crm_source_index_touch();
CREATE TRIGGER source_index_mail AFTER INSERT OR UPDATE OR DELETE ON mail_messages FOR EACH ROW EXECUTE FUNCTION crm_source_index_touch();
CREATE TRIGGER source_index_wechat AFTER INSERT OR UPDATE OR DELETE ON knowledge_wechat_evidence FOR EACH ROW EXECUTE FUNCTION crm_source_index_touch();
CREATE TRIGGER source_index_mail_person AFTER INSERT OR DELETE ON mail_people FOR EACH ROW EXECUTE FUNCTION crm_source_index_touch();
CREATE TRIGGER source_index_person AFTER UPDATE ON people FOR EACH ROW EXECUTE FUNCTION crm_source_index_touch();
CREATE TRIGGER source_index_project AFTER UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION crm_source_index_touch();
CREATE TRIGGER source_index_customer AFTER UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION crm_source_index_touch();
CREATE TRIGGER source_index_exclusions AFTER INSERT OR UPDATE OR DELETE ON mail_exclusions FOR EACH ROW EXECUTE FUNCTION crm_source_index_touch();
