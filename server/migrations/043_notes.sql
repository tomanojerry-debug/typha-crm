-- Published notes are versioned customer knowledge. Autosaves remain actor-private.
CREATE TABLE notes (
 workspace_id uuid NOT NULL,id uuid NOT NULL,customer_id uuid NOT NULL,current_revision_id uuid,
 created_by uuid NOT NULL,version integer NOT NULL DEFAULT 0,archived_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,actor_id)
);
CREATE TABLE note_revisions (
 workspace_id uuid NOT NULL,customer_id uuid NOT NULL,note_id uuid NOT NULL,id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),title text NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
 project_id uuid,blocks jsonb NOT NULL CHECK(jsonb_typeof(blocks)='array'),title_sources jsonb NOT NULL DEFAULT '[]',
 content_hash text NOT NULL CHECK(length(content_hash)=64),record_id uuid,created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,customer_id,id),UNIQUE(workspace_id,note_id,version),
 FOREIGN KEY(workspace_id,customer_id,note_id) REFERENCES notes(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,project_id) REFERENCES projects(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,record_id) REFERENCES customer_records(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,actor_id)
);
ALTER TABLE notes ADD FOREIGN KEY(workspace_id,customer_id,current_revision_id) REFERENCES note_revisions(workspace_id,customer_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX note_revision_record ON note_revisions(workspace_id,record_id) WHERE record_id IS NOT NULL;
CREATE TABLE note_people (
 workspace_id uuid NOT NULL,customer_id uuid NOT NULL,revision_id uuid NOT NULL,person_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,revision_id,person_id),
 FOREIGN KEY(workspace_id,customer_id,revision_id) REFERENCES note_revisions(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,person_id) REFERENCES people(workspace_id,customer_id,id)
);
CREATE TABLE note_source_refs (
 workspace_id uuid NOT NULL,customer_id uuid NOT NULL,revision_id uuid NOT NULL,record_id uuid NOT NULL,
 source_hash text NOT NULL CHECK(length(source_hash)=64),
 PRIMARY KEY(workspace_id,revision_id,record_id),
 FOREIGN KEY(workspace_id,customer_id,revision_id) REFERENCES note_revisions(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,record_id) REFERENCES customer_records(workspace_id,customer_id,id)
);
CREATE TABLE note_drafts (
 workspace_id uuid NOT NULL,actor_id uuid NOT NULL,id uuid NOT NULL,note_id uuid,customer_id uuid,project_id uuid,
 base_revision integer NOT NULL DEFAULT 0,version integer NOT NULL DEFAULT 1,
 title text NOT NULL DEFAULT '',blocks jsonb NOT NULL DEFAULT '[]',title_sources jsonb NOT NULL DEFAULT '[]',person_ids uuid[] NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id,project_id) REFERENCES projects(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,note_id) REFERENCES notes(workspace_id,id),
 CHECK(customer_id IS NOT NULL OR (project_id IS NULL AND cardinality(person_ids)=0))
);
CREATE TABLE note_mutations (
 workspace_id uuid NOT NULL,actor_id uuid NOT NULL,request_id uuid NOT NULL,kind text NOT NULL,
 target_id uuid NOT NULL,payload_hash text NOT NULL,response jsonb NOT NULL,
 PRIMARY KEY(workspace_id,actor_id,request_id),FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id)
);
CREATE TABLE note_templates (
 workspace_id uuid NOT NULL,actor_id uuid NOT NULL,id uuid NOT NULL,name text NOT NULL,
 blocks jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id)
);
CREATE TABLE note_agent_requests (
 workspace_id uuid NOT NULL,actor_id uuid NOT NULL,request_id uuid NOT NULL,input_hash text NOT NULL,draft_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('running','completed')),claim_token uuid NOT NULL,lease_until timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,actor_id,request_id),FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id)
);
CREATE INDEX notes_customer_recent ON notes(workspace_id,customer_id,updated_at DESC,id);
CREATE INDEX note_drafts_actor_recent ON note_drafts(workspace_id,actor_id,updated_at DESC,id);

-- Source payload is never returned directly by an unguarded SECURITY DEFINER.
CREATE FUNCTION crm_note_source_payload(w uuid,rid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r customer_records%ROWTYPE; payload jsonb; extra jsonb;
BEGIN
 IF w IS DISTINCT FROM crm_workspace() THEN RETURN NULL; END IF;
 SELECT * INTO r FROM customer_records WHERE workspace_id=w AND id=rid;
 IF r.id IS NULL OR NOT crm_access(w,r.customer_id) THEN RETURN NULL; END IF;
 payload:=jsonb_build_object('record_id',r.id,'customer_id',r.customer_id,'project_id',r.project_id,'kind',r.kind,'source_kind',r.source_kind,'body',r.body,'occurred_at',r.occurred_at,'person_ids','[]'::jsonb);
 IF r.source_kind='email' THEN
  SELECT jsonb_build_object('body',m.body,'title',m.subject,'person_ids',coalesce((SELECT jsonb_agg(p.person_id ORDER BY p.person_id) FROM mail_people p WHERE p.workspace_id=w AND p.message_id=m.id),'[]'::jsonb),'mail_version',to_jsonb(m)) INTO extra FROM mail_messages m WHERE m.workspace_id=w AND m.id=r.source_mail_id AND m.customer_id=r.customer_id;
 ELSIF r.source_kind='document' THEN
  SELECT jsonb_build_object('body',(SELECT string_agg('【'||(s->>'label')||'】'||E'\n'||(s->>'text'),E'\n\n') FROM jsonb_array_elements(d.sections) s),'title',d.name,'document_version',d.version) INTO extra FROM documents d WHERE d.workspace_id=w AND d.record_id=rid AND d.status='ready';
 ELSIF r.source_kind='note' THEN
  SELECT jsonb_build_object('title',nr.title,'note_id',n.id,'revision_id',nr.id,'note_version',nr.version,'content_hash',nr.content_hash,'person_ids',coalesce((SELECT jsonb_agg(p.person_id ORDER BY p.person_id) FROM note_people p WHERE p.workspace_id=w AND p.revision_id=nr.id),'[]'::jsonb)) INTO extra FROM note_revisions nr JOIN notes n ON n.workspace_id=nr.workspace_id AND n.id=nr.note_id WHERE nr.workspace_id=w AND nr.record_id=rid;
 ELSE
  SELECT jsonb_build_object('body',string_agg(e.body,E'\n\n' ORDER BY e.occurred_at,e.id),'person_ids',coalesce(jsonb_agg(DISTINCT e.person_id) FILTER(WHERE e.person_id IS NOT NULL),'[]'::jsonb),'person_scope_complete',count(DISTINCT e.person_id)=1 AND bool_and(e.person_id IS NOT NULL),'project_scope_complete',bool_and(e.project_id IS NOT DISTINCT FROM r.project_id)) INTO extra FROM knowledge_wechat_evidence e WHERE e.workspace_id=w AND e.record_id=rid HAVING count(*)>0;
  IF extra IS NULL THEN
   SELECT jsonb_build_object('person_ids',coalesce(jsonb_agg(DISTINCT ap.person_id),'[]'::jsonb)) INTO extra FROM activity_record_sources ars JOIN activity_people ap ON ap.workspace_id=ars.workspace_id AND ap.activity_id=ars.activity_id WHERE ars.workspace_id=w AND ars.record_id=rid;
  END IF;
 END IF;
 RETURN payload||coalesce(extra,'{}'::jsonb);
END $$;
REVOKE ALL ON FUNCTION crm_note_source_payload(uuid,uuid) FROM PUBLIC;
CREATE FUNCTION crm_note_source_hash(w uuid,rid uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT encode(sha256(convert_to(crm_note_source_payload(w,rid)::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION crm_note_source_hash(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION crm_note_record_readable(w uuid,rid uuid,seen uuid[] DEFAULT '{}') RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r customer_records%ROWTYPE; nr note_revisions%ROWTYPE; n notes%ROWTYPE; s record;
BEGIN
 IF w IS DISTINCT FROM crm_workspace() OR rid=ANY(seen) OR cardinality(seen)>=12 THEN RETURN false; END IF;
 SELECT * INTO r FROM customer_records WHERE workspace_id=w AND id=rid;
 IF r.id IS NULL OR NOT crm_access(w,r.customer_id) OR NOT EXISTS(SELECT 1 FROM customers WHERE workspace_id=w AND id=r.customer_id AND archived_at IS NULL) THEN RETURN false; END IF;
 IF r.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE workspace_id=w AND customer_id=r.customer_id AND id=r.project_id AND archived_at IS NULL) THEN RETURN false; END IF;
 IF r.source_kind='email' THEN
  RETURN EXISTS(SELECT 1 FROM mail_messages m WHERE m.workspace_id=w AND m.id=r.source_mail_id AND m.customer_id=r.customer_id AND NOT crm_mail_excluded(w,m.participants));
 ELSIF r.source_kind='document' THEN
  RETURN EXISTS(SELECT 1 FROM documents d WHERE d.workspace_id=w AND d.customer_id=r.customer_id AND d.record_id=rid AND d.status='ready');
 ELSIF r.source_kind='note' THEN
  SELECT * INTO nr FROM note_revisions WHERE workspace_id=w AND record_id=rid;
  SELECT * INTO n FROM notes WHERE workspace_id=w AND id=nr.note_id;
  IF nr.id IS NULL OR n.archived_at IS NOT NULL OR n.current_revision_id IS DISTINCT FROM nr.id THEN RETURN false; END IF;
  FOR s IN SELECT * FROM note_source_refs WHERE workspace_id=w AND revision_id=nr.id LOOP
   IF NOT crm_note_record_readable(w,s.record_id,array_append(seen,rid)) OR crm_note_source_hash(w,s.record_id) IS DISTINCT FROM s.source_hash THEN RETURN false; END IF;
  END LOOP;
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION crm_note_record_readable(uuid,uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_note_record_readable(uuid,uuid,uuid[]) TO light_crm_app;
CREATE FUNCTION crm_note_readable(w uuid,nid uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n notes%ROWTYPE; s record;
BEGIN
 IF w IS DISTINCT FROM crm_workspace() THEN RETURN false; END IF;
 SELECT * INTO n FROM notes WHERE workspace_id=w AND id=nid;
 IF n.id IS NULL OR NOT crm_access(w,n.customer_id) OR NOT EXISTS(SELECT 1 FROM customers WHERE workspace_id=w AND id=n.customer_id AND archived_at IS NULL) THEN RETURN false; END IF;
 IF n.current_revision_id IS NULL THEN RETURN n.created_by=crm_actor(); END IF;
 FOR s IN SELECT * FROM note_source_refs WHERE workspace_id=w AND revision_id=n.current_revision_id LOOP
  IF NOT crm_note_record_readable(w,s.record_id) OR crm_note_source_hash(w,s.record_id) IS DISTINCT FROM s.source_hash THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION crm_note_readable(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_note_readable(uuid,uuid) TO light_crm_app;
CREATE FUNCTION crm_note_read_source(w uuid,rid uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE payload jsonb;
BEGIN
 IF NOT crm_note_record_readable(w,rid) THEN RETURN NULL; END IF;
 payload:=crm_note_source_payload(w,rid);
 RETURN payload||jsonb_build_object('source_hash',crm_note_source_hash(w,rid));
END $$;
REVOKE ALL ON FUNCTION crm_note_read_source(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_note_read_source(uuid,uuid) TO light_crm_app;

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_source_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_agent_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON notes TO light_crm_app;
GRANT SELECT,INSERT ON note_revisions,note_people,note_source_refs TO light_crm_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON note_drafts,note_templates TO light_crm_app;
GRANT SELECT,INSERT ON note_mutations TO light_crm_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON note_agent_requests TO light_crm_app;
CREATE POLICY note_read ON notes FOR SELECT USING(crm_note_readable(workspace_id,id));
CREATE POLICY note_create ON notes FOR INSERT WITH CHECK(workspace_id=crm_workspace() AND created_by=crm_actor() AND crm_access(workspace_id,customer_id,true));
CREATE POLICY note_edit ON notes FOR UPDATE USING(crm_access(workspace_id,customer_id,true)) WITH CHECK(workspace_id=crm_workspace() AND crm_access(workspace_id,customer_id,true));
CREATE POLICY note_revision_read ON note_revisions FOR SELECT USING(EXISTS(SELECT 1 FROM notes n WHERE n.workspace_id=note_revisions.workspace_id AND n.id=note_id AND n.current_revision_id=note_revisions.id));
CREATE POLICY note_revision_create ON note_revisions FOR INSERT WITH CHECK(workspace_id=crm_workspace() AND created_by=crm_actor() AND crm_access(workspace_id,customer_id,true));
CREATE POLICY note_people_read ON note_people FOR SELECT USING(EXISTS(SELECT 1 FROM note_revisions r WHERE r.workspace_id=note_people.workspace_id AND r.id=revision_id));
CREATE POLICY note_people_create ON note_people FOR INSERT WITH CHECK(workspace_id=crm_workspace() AND crm_access(workspace_id,customer_id,true));
CREATE POLICY note_source_read ON note_source_refs FOR SELECT USING(EXISTS(SELECT 1 FROM note_revisions r WHERE r.workspace_id=note_source_refs.workspace_id AND r.id=revision_id));
CREATE POLICY note_source_create ON note_source_refs FOR INSERT WITH CHECK(workspace_id=crm_workspace() AND crm_access(workspace_id,customer_id,true));
CREATE POLICY note_draft_private ON note_drafts FOR ALL USING(workspace_id=crm_workspace() AND actor_id=crm_actor() AND (customer_id IS NULL OR (crm_access(workspace_id,customer_id) AND EXISTS(SELECT 1 FROM customers c WHERE c.workspace_id=note_drafts.workspace_id AND c.id=customer_id AND c.archived_at IS NULL)))) WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor() AND (customer_id IS NULL OR crm_access(workspace_id,customer_id,true)));
CREATE FUNCTION crm_note_draft_sources_visible(w uuid,did uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d note_drafts%ROWTYPE; b jsonb; s jsonb;
BEGIN
 IF w IS DISTINCT FROM crm_workspace() THEN RETURN false; END IF;
 SELECT * INTO d FROM note_drafts WHERE workspace_id=w AND id=did AND actor_id=crm_actor();
 IF d.id IS NULL OR (d.customer_id IS NOT NULL AND NOT crm_access(w,d.customer_id)) THEN RETURN false; END IF;
 FOR b IN SELECT * FROM jsonb_array_elements(d.blocks) LOOP
  FOR s IN SELECT * FROM jsonb_array_elements(coalesce(b->'sources','[]'::jsonb)) LOOP
   IF NOT crm_note_record_readable(w,(s->>'record_id')::uuid) OR crm_note_source_hash(w,(s->>'record_id')::uuid) IS DISTINCT FROM s->>'source_hash' THEN RETURN false; END IF;
  END LOOP;
 END LOOP;
 FOR s IN SELECT * FROM jsonb_array_elements(d.title_sources) LOOP
  IF NOT crm_note_record_readable(w,(s->>'record_id')::uuid) OR crm_note_source_hash(w,(s->>'record_id')::uuid) IS DISTINCT FROM s->>'source_hash' THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION crm_note_draft_sources_visible(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_note_draft_sources_visible(uuid,uuid) TO light_crm_app;
CREATE POLICY note_draft_source_visible ON note_drafts AS RESTRICTIVE FOR SELECT USING(crm_note_draft_sources_visible(workspace_id,id));
CREATE POLICY note_mutation_private ON note_mutations FOR ALL USING(workspace_id=crm_workspace() AND actor_id=crm_actor()) WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor());
CREATE POLICY note_template_private ON note_templates FOR ALL USING(workspace_id=crm_workspace() AND actor_id=crm_actor()) WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor());
CREATE POLICY note_agent_request_private ON note_agent_requests FOR ALL USING(workspace_id=crm_workspace() AND actor_id=crm_actor()) WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor());
ALTER TABLE customer_records DROP CONSTRAINT customer_records_source_kind_check;
ALTER TABLE customer_records ADD CHECK(source_kind IN ('manual','email','wechat','document','note'));
CREATE POLICY record_note_visible ON customer_records AS RESTRICTIVE FOR SELECT USING(source_kind<>'note' OR crm_note_record_readable(workspace_id,id));
CREATE TRIGGER notes_knowledge AFTER INSERT OR UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION crm_knowledge_touch();
CREATE TRIGGER notes_source_index AFTER INSERT OR UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION crm_source_index_touch();
CREATE TRIGGER notes_audit AFTER INSERT OR UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION crm_audit();
CREATE FUNCTION crm_note_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN
 IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'note identity is immutable' USING ERRCODE='23514'; END IF;
 IF NEW.version<>OLD.version+1 OR (NEW.current_revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM note_revisions r WHERE r.workspace_id=NEW.workspace_id AND r.customer_id=NEW.customer_id AND r.note_id=NEW.id AND r.id=NEW.current_revision_id)) THEN RAISE EXCEPTION 'note version or revision identity mismatch' USING ERRCODE='23514'; END IF;
 NEW.updated_at=now(); RETURN NEW;
END $$;
CREATE TRIGGER note_identity BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION crm_note_identity();
REVOKE ALL ON FUNCTION crm_note_identity() FROM PUBLIC;
-- Historical revisions expose safe metadata only; their old text is not returned
-- through current Record APIs or used by normal knowledge retrieval.
CREATE FUNCTION crm_note_versions(w uuid,nid uuid)
RETURNS TABLE(revision_id uuid,version integer,content_hash text,edited_by uuid,created_at timestamptz,current boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT crm_note_readable(w,nid) THEN RAISE EXCEPTION 'note unavailable' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT r.id,r.version,r.content_hash,r.created_by,r.created_at,r.id=n.current_revision_id
 FROM note_revisions r JOIN notes n ON n.workspace_id=r.workspace_id AND n.id=r.note_id
 WHERE r.workspace_id=w AND r.note_id=nid ORDER BY r.version DESC;
END $$;
REVOKE ALL ON FUNCTION crm_note_versions(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_note_versions(uuid,uuid) TO light_crm_app;
