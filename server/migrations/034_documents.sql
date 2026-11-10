-- Uploaded originals are customer-scoped, or uploader-private until explicitly associated.
CREATE TABLE documents (
 workspace_id uuid NOT NULL, id uuid NOT NULL, uploaded_by uuid NOT NULL, task_actor_id uuid NOT NULL,
 request_id uuid NOT NULL, customer_id uuid, project_id uuid, record_id uuid,
 supersedes_id uuid, edition integer NOT NULL DEFAULT 1 CHECK(edition>0),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 240 AND name !~ E'[\\r\\n]'),
 format text NOT NULL CHECK(format IN ('pdf','docx')),
 size integer NOT NULL CHECK(size BETWEEN 1 AND 10485760),
 content_hash text NOT NULL CHECK(length(content_hash)=64), original_base64 text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','pending_association','ready','failed')),
 sections jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(sections)='array'),
 warnings jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(warnings)='array'), error text,
 lease_until timestamptz, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,uploaded_by,request_id),
 FOREIGN KEY(workspace_id,uploaded_by) REFERENCES memberships(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,task_actor_id) REFERENCES memberships(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id,project_id) REFERENCES projects(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,record_id) REFERENCES customer_records(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,supersedes_id) REFERENCES documents(workspace_id,id),
 CHECK(customer_id IS NOT NULL OR (project_id IS NULL AND record_id IS NULL)),
 CHECK(status<>'ready' OR (customer_id IS NOT NULL AND record_id IS NOT NULL)),
 CHECK(status<>'pending_association' OR customer_id IS NULL)
);
CREATE UNIQUE INDEX documents_customer_duplicate ON documents(workspace_id,customer_id,
 coalesce(project_id,'00000000-0000-0000-0000-000000000000'::uuid),content_hash) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX documents_private_duplicate ON documents(workspace_id,uploaded_by,content_hash) WHERE customer_id IS NULL;
CREATE INDEX documents_recent ON documents(workspace_id,customer_id,created_at DESC);
CREATE INDEX documents_version_child ON documents(workspace_id,supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE UNIQUE INDEX documents_version_active_child ON documents(workspace_id,supersedes_id) WHERE supersedes_id IS NOT NULL AND status<>'failed';
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON documents TO light_crm_app;
CREATE POLICY document_read ON documents FOR SELECT USING(workspace_id=crm_workspace() AND (
 (customer_id IS NULL AND uploaded_by=crm_actor()) OR
 (customer_id IS NOT NULL AND crm_access(workspace_id,customer_id) AND EXISTS(
 SELECT 1 FROM customers c WHERE c.workspace_id=documents.workspace_id AND c.id=documents.customer_id AND c.archived_at IS NULL)
 AND (project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.workspace_id=documents.workspace_id AND p.id=documents.project_id AND p.customer_id=documents.customer_id AND p.archived_at IS NULL)))));
CREATE POLICY document_create ON documents FOR INSERT WITH CHECK(workspace_id=crm_workspace() AND uploaded_by=crm_actor() AND task_actor_id=crm_actor() AND (
 (customer_id IS NULL AND project_id IS NULL) OR (customer_id IS NOT NULL AND crm_access(workspace_id,customer_id,true))));
CREATE POLICY document_edit ON documents FOR UPDATE USING(workspace_id=crm_workspace() AND (
 (customer_id IS NULL AND uploaded_by=crm_actor()) OR (customer_id IS NOT NULL AND crm_access(workspace_id,customer_id,true))))
 WITH CHECK(workspace_id=crm_workspace() AND ((customer_id IS NULL AND uploaded_by=crm_actor()) OR
 (customer_id IS NOT NULL AND crm_access(workspace_id,customer_id,true))));
CREATE FUNCTION crm_document_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.task_actor_id IS DISTINCT FROM OLD.task_actor_id AND NEW.task_actor_id IS DISTINCT FROM crm_actor()) OR
 NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.id IS DISTINCT FROM OLD.id OR
 NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by OR NEW.request_id IS DISTINCT FROM OLD.request_id OR
 NEW.name IS DISTINCT FROM OLD.name OR NEW.format IS DISTINCT FROM OLD.format OR NEW.size IS DISTINCT FROM OLD.size OR
 NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.original_base64 IS DISTINCT FROM OLD.original_base64 OR
 NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id OR NEW.edition IS DISTINCT FROM OLD.edition OR
 (OLD.customer_id IS NOT NULL AND (NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.project_id IS DISTINCT FROM OLD.project_id)) OR
 (OLD.record_id IS NOT NULL AND NEW.record_id IS DISTINCT FROM OLD.record_id) THEN
 RAISE EXCEPTION 'document identity and associated scope are immutable' USING ERRCODE='23514';
 END IF;
 NEW.version=OLD.version+1; NEW.updated_at=now(); RETURN NEW;
END $$;
CREATE TRIGGER document_identity BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION crm_document_identity();
CREATE FUNCTION crm_document_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent documents%ROWTYPE;
BEGIN
 IF NEW.supersedes_id IS NULL THEN
  IF NEW.edition<>1 THEN RAISE EXCEPTION 'initial document edition must be one' USING ERRCODE='23514'; END IF;
 ELSE
  SELECT * INTO parent FROM documents WHERE workspace_id=NEW.workspace_id AND id=NEW.supersedes_id;
  IF parent.id IS NULL OR parent.status<>'ready' OR parent.customer_id IS NULL OR
   parent.customer_id IS DISTINCT FROM NEW.customer_id OR parent.project_id IS DISTINCT FROM NEW.project_id OR
   NEW.edition<=parent.edition THEN RAISE EXCEPTION 'document version scope mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER document_version BEFORE INSERT ON documents FOR EACH ROW EXECUTE FUNCTION crm_document_version();
-- RLS can hide rows from SELECT ... FOR SHARE when the caller lacks table UPDATE
-- rights. This narrow function locks the already-authorized editing scope as owner.
CREATE FUNCTION crm_lock_document_attribute_scope(w uuid,c uuid,ids uuid[]) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF w IS DISTINCT FROM crm_workspace() OR NOT crm_access(w,c,true) OR cardinality(ids)>10 OR cardinality(ids)<1 THEN
  RAISE EXCEPTION 'document attribute editor required' USING ERRCODE='42501';
 END IF;
 PERFORM 1 FROM customers WHERE workspace_id=w AND id=c AND archived_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'active customer required' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM customer_access WHERE workspace_id=w AND customer_id=c AND actor_id=crm_actor() FOR SHARE;
 PERFORM 1 FROM customer_attributes WHERE workspace_id=w AND id=ANY(ids) ORDER BY id FOR SHARE;
 IF NOT crm_access(w,c,true) THEN RAISE EXCEPTION 'document attribute editor required' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION crm_lock_document_attribute_scope(uuid,uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_lock_document_attribute_scope(uuid,uuid,uuid[]) TO light_crm_app;
ALTER TABLE customer_records DROP CONSTRAINT customer_records_source_kind_check;
ALTER TABLE customer_records ADD CHECK(source_kind IN ('manual','email','wechat','document'));
-- A canonical document Record cannot be read after its original is no longer authorized.
CREATE POLICY record_document_visible ON customer_records AS RESTRICTIVE FOR SELECT USING(
 source_kind<>'document' OR EXISTS(SELECT 1 FROM documents d WHERE d.workspace_id=customer_records.workspace_id AND d.customer_id=customer_records.customer_id AND d.record_id=customer_records.id AND d.status='ready'));
