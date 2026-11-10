-- Activities have independent definitions/revisions. They do not enter entitySchema
-- or reuse customer_attributes/custom_object_attributes schema-change triggers.
CREATE TABLE activity_schemas (
 workspace_id uuid NOT NULL, id uuid NOT NULL, name text NOT NULL, description text NOT NULL DEFAULT '',
 parent_id uuid, fields jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(fields)='array'),
 version integer NOT NULL DEFAULT 1, archived boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), FOREIGN KEY(workspace_id,parent_id) REFERENCES activity_schemas(workspace_id,id)
);
CREATE TABLE activity_types (
 workspace_id uuid NOT NULL,id uuid NOT NULL,name text NOT NULL,description text NOT NULL DEFAULT '',
 schema_id uuid NOT NULL,fields jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(fields)='array'),guidance text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1,archived boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,schema_id) REFERENCES activity_schemas(workspace_id,id)
);
CREATE TABLE activity_runs (
 workspace_id uuid NOT NULL,customer_id uuid NOT NULL,id uuid NOT NULL,actor_id uuid NOT NULL,
 request_id uuid NOT NULL,input_digest text NOT NULL,config_digest text NOT NULL,type_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('running','completed','failed')),lease_token uuid NOT NULL,
 error text,source_ids jsonb NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,customer_id,id), UNIQUE(workspace_id,actor_id,request_id),
 UNIQUE(workspace_id,customer_id,actor_id,type_id,input_digest,config_digest),
 FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,type_id) REFERENCES activity_types(workspace_id,id)
);
CREATE TABLE business_activities (
 workspace_id uuid NOT NULL,customer_id uuid NOT NULL,id uuid NOT NULL,project_id uuid,
 type_id uuid NOT NULL,run_id uuid NOT NULL,event_key text NOT NULL,type_name text NOT NULL,
 title text NOT NULL,summary text,occurred_at timestamptz,handler_id uuid,
 fields jsonb NOT NULL,values jsonb NOT NULL,ai_values jsonb NOT NULL,field_provenance jsonb NOT NULL,source_versions jsonb NOT NULL,
 missing_required_fields jsonb NOT NULL DEFAULT '[]',version integer NOT NULL DEFAULT 1,archived boolean NOT NULL DEFAULT false,
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,customer_id,id),UNIQUE(workspace_id,run_id,event_key),
 FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id,project_id) REFERENCES projects(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,type_id) REFERENCES activity_types(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id,run_id) REFERENCES activity_runs(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,handler_id) REFERENCES memberships(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,actor_id)
);
CREATE INDEX business_activity_browse ON business_activities(workspace_id,customer_id,created_at DESC,id);
CREATE TABLE activity_people (
 workspace_id uuid NOT NULL,customer_id uuid NOT NULL,activity_id uuid NOT NULL,person_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,activity_id,person_id),
 FOREIGN KEY(workspace_id,customer_id,activity_id) REFERENCES business_activities(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,person_id) REFERENCES people(workspace_id,customer_id,id)
);
CREATE TABLE activity_evidence (
 workspace_id uuid NOT NULL,customer_id uuid NOT NULL,activity_id uuid NOT NULL,source_id text NOT NULL,record_id uuid NOT NULL,
 field_id text NOT NULL,quote text NOT NULL,char_start integer NOT NULL CHECK(char_start>=0),char_end integer NOT NULL CHECK(char_end>char_start),
 FOREIGN KEY(workspace_id,customer_id,activity_id) REFERENCES business_activities(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,record_id) REFERENCES customer_records(workspace_id,customer_id,id)
);
-- Preserve every authored correction, including earlier values superseded by a
-- later edit. Current field_provenance is a value pointer, not a history index.
CREATE TABLE activity_record_sources (
 workspace_id uuid NOT NULL,customer_id uuid NOT NULL,activity_id uuid NOT NULL,record_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,activity_id,record_id),
 FOREIGN KEY(workspace_id,customer_id,activity_id) REFERENCES business_activities(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,record_id) REFERENCES customer_records(workspace_id,customer_id,id)
);
CREATE TABLE activity_comments (
 workspace_id uuid NOT NULL,customer_id uuid NOT NULL,id uuid NOT NULL,activity_id uuid NOT NULL,
 body text NOT NULL CHECK(length(trim(body)) BETWEEN 1 AND 4000),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 request_id uuid NOT NULL DEFAULT gen_random_uuid(),request_digest text NOT NULL DEFAULT '',
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,customer_id,id),UNIQUE(workspace_id,created_by,request_id),
 FOREIGN KEY(workspace_id,customer_id,activity_id) REFERENCES business_activities(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,actor_id)
);
CREATE TABLE activity_tasks (
 workspace_id uuid NOT NULL,customer_id uuid NOT NULL,id uuid NOT NULL,activity_id uuid NOT NULL,comment_id uuid NOT NULL,
 project_id uuid,title text NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 500),assignee_id uuid NOT NULL,created_by uuid NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','completed')),due_date date,result text,result_record_id uuid,
 version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,comment_id),
 FOREIGN KEY(workspace_id,customer_id,activity_id) REFERENCES business_activities(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,comment_id) REFERENCES activity_comments(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,project_id) REFERENCES projects(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,assignee_id) REFERENCES memberships(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,customer_id,result_record_id) REFERENCES customer_records(workspace_id,customer_id,id)
);
CREATE INDEX activity_task_assignee ON activity_tasks(workspace_id,assignee_id,status,created_at DESC);

CREATE FUNCTION crm_activity_member_access(w uuid,c uuid,a uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT w=crm_workspace() AND crm_access(w,c) AND EXISTS(
 SELECT 1 FROM memberships m WHERE m.workspace_id=w AND m.actor_id=a AND m.active
 AND (m.role='admin' OR EXISTS(SELECT 1 FROM customer_access ca WHERE ca.workspace_id=w AND ca.customer_id=c AND ca.actor_id=a)))
$$;
REVOKE ALL ON FUNCTION crm_activity_member_access(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_activity_member_access(uuid,uuid,uuid) TO light_crm_app;

-- Existing evidence tables intentionally grant no UPDATE to the application.
-- Row locks therefore use this bounded, customer-authorized routine instead of
-- broadening UPDATE grants merely to acquire FOR SHARE locks.
CREATE FUNCTION crm_activity_lock_sources(w uuid,c uuid,ids uuid[],t uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF w IS DISTINCT FROM crm_workspace() OR NOT crm_access(w,c,true) OR cardinality(ids) NOT BETWEEN 1 AND 60
 THEN RAISE EXCEPTION 'customer editor required' USING ERRCODE='42501'; END IF;
 PERFORM id FROM customers WHERE workspace_id=w AND id=c FOR SHARE;
 PERFORM id FROM projects WHERE workspace_id=w AND customer_id=c ORDER BY id FOR SHARE;
 PERFORM id FROM people WHERE workspace_id=w AND customer_id=c ORDER BY id FOR SHARE;
 PERFORM id FROM activity_types WHERE workspace_id=w AND id=t FOR SHARE;
 PERFORM s.id FROM activity_schemas s JOIN activity_types at ON at.workspace_id=s.workspace_id
 WHERE s.workspace_id=w AND at.id=t AND (s.id=at.schema_id OR s.id=(SELECT parent_id FROM activity_schemas WHERE workspace_id=w AND id=at.schema_id)) ORDER BY s.id FOR SHARE OF s;
 PERFORM actor_id FROM customer_access WHERE workspace_id=w AND customer_id=c AND actor_id=crm_actor() FOR SHARE;
 PERFORM id FROM customer_records WHERE workspace_id=w AND customer_id=c AND id=ANY(ids) ORDER BY id FOR SHARE;
 IF (SELECT count(*) FROM customer_records WHERE workspace_id=w AND customer_id=c AND id=ANY(ids))<>cardinality(ids)
 THEN RAISE EXCEPTION 'source scope mismatch' USING ERRCODE='42501'; END IF;
 PERFORM m.id FROM mail_messages m JOIN customer_records r ON r.workspace_id=m.workspace_id AND r.source_mail_id=m.id
 WHERE r.workspace_id=w AND r.customer_id=c AND r.id=ANY(ids) ORDER BY m.id FOR SHARE OF m;
 PERFORM id FROM knowledge_wechat_evidence WHERE workspace_id=w AND customer_id=c AND record_id=ANY(ids) ORDER BY id FOR SHARE;
END $$;
REVOKE ALL ON FUNCTION crm_activity_lock_sources(uuid,uuid,uuid[],uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_activity_lock_sources(uuid,uuid,uuid[],uuid) TO light_crm_app;

CREATE FUNCTION crm_activity_schema_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.parent_id=NEW.id THEN RAISE EXCEPTION 'schema cycle' USING ERRCODE='23514'; END IF;
 IF NEW.parent_id IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM activity_schemas s WHERE s.workspace_id=NEW.workspace_id AND s.id=NEW.parent_id AND s.parent_id IS NULL) OR EXISTS(SELECT 1 FROM activity_schemas s WHERE s.workspace_id=NEW.workspace_id AND s.parent_id=NEW.id))
 THEN RAISE EXCEPTION 'activity schemas support at most two levels' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
 IF (NEW.workspace_id,NEW.id) IS DISTINCT FROM (OLD.workspace_id,OLD.id) THEN RAISE EXCEPTION 'schema scope immutable' USING ERRCODE='23514'; END IF;
 NEW.version=OLD.version+1;NEW.updated_at=now();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER activity_schema_guard BEFORE INSERT OR UPDATE ON activity_schemas FOR EACH ROW EXECUTE FUNCTION crm_activity_schema_guard();
CREATE FUNCTION crm_activity_type_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.workspace_id,NEW.id) IS DISTINCT FROM (OLD.workspace_id,OLD.id) THEN RAISE EXCEPTION 'type scope immutable' USING ERRCODE='23514'; END IF;
 NEW.version=OLD.version+1;NEW.updated_at=now();RETURN NEW;
END $$;
CREATE TRIGGER activity_type_guard BEFORE UPDATE ON activity_types FOR EACH ROW EXECUTE FUNCTION crm_activity_type_guard();
CREATE FUNCTION crm_business_activity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.workspace_id,NEW.customer_id,NEW.id,NEW.type_id,NEW.run_id,NEW.created_by,NEW.created_at,NEW.project_id,NEW.fields,NEW.ai_values,NEW.source_versions)
 IS DISTINCT FROM (OLD.workspace_id,OLD.customer_id,OLD.id,OLD.type_id,OLD.run_id,OLD.created_by,OLD.created_at,OLD.project_id,OLD.fields,OLD.ai_values,OLD.source_versions)
 THEN RAISE EXCEPTION 'activity identity/source snapshot immutable' USING ERRCODE='23514'; END IF;
 NEW.version=OLD.version+1;NEW.updated_at=now();RETURN NEW;
END $$;
CREATE TRIGGER business_activity_guard BEFORE UPDATE ON business_activities FOR EACH ROW EXECUTE FUNCTION crm_business_activity_guard();

-- A customer viewer explicitly assigned a task may report its result. This narrow
-- trigger creates only that task's inference Record; it does not grant CRM editing.
CREATE FUNCTION crm_activity_task_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rid uuid;
BEGIN
 IF (NEW.workspace_id,NEW.customer_id,NEW.id,NEW.activity_id,NEW.comment_id,NEW.project_id,NEW.assignee_id,NEW.created_by,NEW.created_at,NEW.title,NEW.due_date)
 IS DISTINCT FROM (OLD.workspace_id,OLD.customer_id,OLD.id,OLD.activity_id,OLD.comment_id,OLD.project_id,OLD.assignee_id,OLD.created_by,OLD.created_at,OLD.title,OLD.due_date)
 OR NEW.result_record_id IS DISTINCT FROM OLD.result_record_id
 THEN RAISE EXCEPTION 'task attribution immutable' USING ERRCODE='23514'; END IF;
 IF OLD.status='completed' THEN RAISE EXCEPTION 'completed task immutable' USING ERRCODE='23514'; END IF;
 IF NEW.assignee_id<>crm_actor() OR NOT crm_access(NEW.workspace_id,NEW.customer_id) THEN RAISE EXCEPTION 'only assignee may update task' USING ERRCODE='42501'; END IF;
 IF NEW.status='completed' THEN
 IF NEW.result IS NULL OR length(trim(NEW.result)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'task result required' USING ERRCODE='23514'; END IF;
 rid=gen_random_uuid();
 INSERT INTO customer_records(workspace_id,customer_id,project_id,id,kind,body,created_by,source_kind,occurred_at)
 VALUES(NEW.workspace_id,NEW.customer_id,NEW.project_id,rid,'inference','活动待办「'||NEW.title||'」处理结果（本人内部报告，不代表公司正式确认）：'||NEW.result,crm_actor(),'manual',now());
 INSERT INTO activity_record_sources(workspace_id,customer_id,activity_id,record_id)
 VALUES(NEW.workspace_id,NEW.customer_id,NEW.activity_id,rid);
 -- The result author remains the assignee. Existing index workers require an
 -- editing principal; the human who explicitly delegated this task may execute
 -- that indexing only while their original customer editing grant is still valid.
 IF EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=NEW.workspace_id AND m.actor_id=NEW.created_by AND m.active
  AND (m.role='admin' OR EXISTS(SELECT 1 FROM customer_access ca WHERE ca.workspace_id=m.workspace_id AND ca.customer_id=NEW.customer_id AND ca.actor_id=m.actor_id AND ca.access='editor')))
 THEN
 UPDATE knowledge_sync SET actor_id=NEW.created_by WHERE workspace_id=NEW.workspace_id AND customer_id=NEW.customer_id;
 UPDATE source_index_sync SET actor_id=NEW.created_by WHERE workspace_id=NEW.workspace_id AND customer_id=NEW.customer_id;
 ELSE
 UPDATE knowledge_sync SET state='failed',attempts=3,error='处理结果已保存；知识索引等待有客户编辑权限的成员重新整理',retry_at=NULL WHERE workspace_id=NEW.workspace_id AND customer_id=NEW.customer_id;
 UPDATE source_index_sync SET state='failed',attempts=3,error='处理结果已保存；原文索引等待有客户编辑权限的成员重新整理',retry_at=NULL WHERE workspace_id=NEW.workspace_id AND customer_id=NEW.customer_id;
 END IF;
 NEW.result_record_id=rid;
 END IF;
 NEW.version=OLD.version+1;NEW.updated_at=now();RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION crm_activity_task_guard() FROM PUBLIC;
CREATE TRIGGER activity_task_guard BEFORE UPDATE ON activity_tasks FOR EACH ROW EXECUTE FUNCTION crm_activity_task_guard();

-- Contact links scope existing authored evidence. A link edit must republish
-- derived indices; creating an AI-only activity does not create new knowledge.
CREATE FUNCTION crm_activity_people_touch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record;
BEGIN
 IF TG_OP='DELETE' THEN r=OLD; ELSE r=NEW; END IF;
 IF r.workspace_id IS DISTINCT FROM crm_workspace() OR NOT crm_access(r.workspace_id,r.customer_id,true)
 OR NOT EXISTS(SELECT 1 FROM activity_record_sources s WHERE s.workspace_id=r.workspace_id AND s.activity_id=r.activity_id)
 THEN RETURN NULL; END IF;
 INSERT INTO knowledge_sync(workspace_id,customer_id,actor_id) VALUES(r.workspace_id,r.customer_id,crm_actor())
 ON CONFLICT(workspace_id,customer_id) DO UPDATE SET requested_version=knowledge_sync.requested_version+1,
 actor_id=crm_actor(),state='pending',attempts=0,error=NULL,retry_at=NULL,updated_at=now();
 INSERT INTO source_index_sync(workspace_id,customer_id,actor_id) VALUES(r.workspace_id,r.customer_id,crm_actor())
 ON CONFLICT(workspace_id,customer_id) DO UPDATE SET requested_version=source_index_sync.requested_version+1,
 actor_id=crm_actor(),state='pending',attempts=0,error=NULL,retry_at=NULL,updated_at=now();
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crm_activity_people_touch() FROM PUBLIC;
CREATE TRIGGER activity_people_touch AFTER INSERT OR DELETE ON activity_people FOR EACH ROW EXECUTE FUNCTION crm_activity_people_touch();

ALTER TABLE activity_schemas ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_types ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON activity_schemas,activity_types TO light_crm_app;
CREATE POLICY activity_schema_read ON activity_schemas FOR SELECT USING(workspace_id=crm_workspace());
CREATE POLICY activity_schema_create ON activity_schemas FOR INSERT WITH CHECK(crm_admin(workspace_id));
CREATE POLICY activity_schema_edit ON activity_schemas FOR UPDATE USING(crm_admin(workspace_id)) WITH CHECK(crm_admin(workspace_id));
CREATE POLICY activity_type_read ON activity_types FOR SELECT USING(workspace_id=crm_workspace());
CREATE POLICY activity_type_create ON activity_types FOR INSERT WITH CHECK(crm_admin(workspace_id));
CREATE POLICY activity_type_edit ON activity_types FOR UPDATE USING(crm_admin(workspace_id)) WITH CHECK(crm_admin(workspace_id));
ALTER TABLE activity_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON activity_runs TO light_crm_app;
CREATE POLICY activity_run_read ON activity_runs FOR SELECT USING(actor_id=crm_actor() AND crm_access(workspace_id,customer_id));
CREATE POLICY activity_run_create ON activity_runs FOR INSERT WITH CHECK(actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true));
CREATE POLICY activity_run_edit ON activity_runs FOR UPDATE USING(actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true)) WITH CHECK(actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true));
ALTER TABLE business_activities ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON business_activities TO light_crm_app;
CREATE POLICY activity_read ON business_activities FOR SELECT USING(crm_access(workspace_id,customer_id));
CREATE POLICY activity_create ON business_activities FOR INSERT WITH CHECK(created_by=crm_actor() AND crm_access(workspace_id,customer_id,true));
CREATE POLICY activity_edit ON business_activities FOR UPDATE USING(crm_access(workspace_id,customer_id,true)) WITH CHECK(crm_access(workspace_id,customer_id,true));
ALTER TABLE activity_people ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,DELETE ON activity_people TO light_crm_app;
CREATE POLICY activity_people_read ON activity_people FOR SELECT USING(crm_access(workspace_id,customer_id));
CREATE POLICY activity_people_create ON activity_people FOR INSERT WITH CHECK(crm_access(workspace_id,customer_id,true));
CREATE POLICY activity_people_delete ON activity_people FOR DELETE USING(crm_access(workspace_id,customer_id,true));
ALTER TABLE activity_evidence ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON activity_evidence TO light_crm_app;
CREATE POLICY activity_evidence_read ON activity_evidence FOR SELECT USING(crm_access(workspace_id,customer_id));
CREATE POLICY activity_evidence_create ON activity_evidence FOR INSERT WITH CHECK(crm_access(workspace_id,customer_id,true));
ALTER TABLE activity_record_sources ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON activity_record_sources TO light_crm_app;
CREATE POLICY activity_record_sources_read ON activity_record_sources FOR SELECT USING(crm_access(workspace_id,customer_id));
CREATE POLICY activity_record_sources_create ON activity_record_sources FOR INSERT WITH CHECK(crm_access(workspace_id,customer_id,true));
ALTER TABLE activity_comments ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON activity_comments TO light_crm_app;
CREATE POLICY activity_comment_read ON activity_comments FOR SELECT USING(crm_access(workspace_id,customer_id));
CREATE POLICY activity_comment_create ON activity_comments FOR INSERT WITH CHECK(created_by=crm_actor() AND crm_access(workspace_id,customer_id,true));
ALTER TABLE activity_tasks ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON activity_tasks TO light_crm_app;
CREATE POLICY activity_task_read ON activity_tasks FOR SELECT USING(crm_access(workspace_id,customer_id));
CREATE POLICY activity_task_create ON activity_tasks FOR INSERT WITH CHECK(created_by=crm_actor() AND crm_access(workspace_id,customer_id,true) AND crm_activity_member_access(workspace_id,customer_id,assignee_id));
CREATE POLICY activity_task_update ON activity_tasks FOR UPDATE USING(assignee_id=crm_actor() AND crm_access(workspace_id,customer_id)) WITH CHECK(assignee_id=crm_actor() AND crm_access(workspace_id,customer_id));
