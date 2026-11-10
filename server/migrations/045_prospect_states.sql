-- One inquiry project is one purchase intention. Requirements are the task authority.
CREATE TABLE prospect_profiles (
 workspace_id uuid NOT NULL,customer_id uuid NOT NULL,project_id uuid NOT NULL,person_id uuid,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
 stage text NOT NULL DEFAULT 'new' CHECK(stage IN ('new','needs','proposal','decision')),
 lifecycle text NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','paused','closed')),
 outcome text CHECK(outcome IN ('won','lost','resolved','invalid','duplicate')),
 outcome_reason text NOT NULL DEFAULT '',summary text NOT NULL DEFAULT '',
 requirements jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(requirements)='array'),
 source_refs jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(source_refs)='array'),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,project_id),UNIQUE(workspace_id,customer_id,project_id),
 FOREIGN KEY(workspace_id,customer_id,project_id) REFERENCES projects(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,person_id) REFERENCES people(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,created_by) REFERENCES memberships(workspace_id,actor_id),
 CHECK((lifecycle='closed')=(outcome IS NOT NULL))
);
CREATE TABLE prospect_mutations (
 workspace_id uuid NOT NULL,actor_id uuid NOT NULL,customer_id uuid NOT NULL,request_id uuid NOT NULL,
 kind text NOT NULL,target_id uuid,payload_hash text NOT NULL,
 result_version integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,actor_id,request_id),
 FOREIGN KEY(workspace_id,customer_id,target_id) REFERENCES prospect_profiles(workspace_id,customer_id,project_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id)
);
CREATE TABLE prospect_events (
 workspace_id uuid NOT NULL,customer_id uuid NOT NULL,project_id uuid NOT NULL,id uuid NOT NULL,
 actor_id uuid NOT NULL,profile_version integer NOT NULL,kind text NOT NULL,change_summary jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id,project_id) REFERENCES prospect_profiles(workspace_id,customer_id,project_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id)
);
CREATE INDEX prospect_recent ON prospect_profiles(workspace_id,lifecycle,updated_at DESC,project_id);
ALTER TABLE prospect_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON prospect_profiles TO light_crm_app;
GRANT SELECT,INSERT,UPDATE ON prospect_mutations TO light_crm_app;
GRANT SELECT,INSERT ON prospect_events TO light_crm_app;
CREATE POLICY prospect_read ON prospect_profiles FOR SELECT USING(workspace_id=crm_workspace() AND crm_access(workspace_id,customer_id));
CREATE POLICY prospect_create ON prospect_profiles FOR INSERT WITH CHECK(workspace_id=crm_workspace() AND created_by=crm_actor() AND crm_access(workspace_id,customer_id,true));
CREATE POLICY prospect_edit ON prospect_profiles FOR UPDATE USING(workspace_id=crm_workspace() AND crm_access(workspace_id,customer_id,true)) WITH CHECK(workspace_id=crm_workspace() AND crm_access(workspace_id,customer_id,true));
CREATE POLICY prospect_mutation_private ON prospect_mutations FOR ALL USING(workspace_id=crm_workspace() AND actor_id=crm_actor() AND crm_access(workspace_id,customer_id)) WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true));
CREATE POLICY prospect_event_read ON prospect_events FOR SELECT USING(workspace_id=crm_workspace() AND crm_access(workspace_id,customer_id));
CREATE POLICY prospect_event_create ON prospect_events FOR INSERT WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true));

CREATE FUNCTION crm_prospect_assignable(w uuid,c uuid,a uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT w=crm_workspace() AND crm_access(w,c) AND EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=w AND m.actor_id=a AND m.active AND (m.role='admin' OR EXISTS(SELECT 1 FROM customer_access x WHERE x.workspace_id=w AND x.customer_id=c AND x.actor_id=a AND x.access='editor')))
$$;
REVOKE ALL ON FUNCTION crm_prospect_assignable(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_prospect_assignable(uuid,uuid,uuid) TO light_crm_app;
CREATE FUNCTION crm_prospect_sources_valid(w uuid,c uuid,p uuid,refs jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ref jsonb; payload jsonb;
BEGIN
 IF w IS DISTINCT FROM crm_workspace() OR NOT crm_access(w,c) OR NOT EXISTS(SELECT 1 FROM customers WHERE workspace_id=w AND id=c AND archived_at IS NULL) THEN RETURN false; END IF;
 FOR ref IN SELECT * FROM jsonb_array_elements(refs) LOOP
  payload:=crm_note_read_source(w,(ref->>'record_id')::uuid);
  IF payload IS NULL OR payload->>'customer_id' IS DISTINCT FROM c::text OR payload->>'source_hash' IS DISTINCT FROM ref->>'source_hash' OR payload->>'project_scope_complete'='false' OR (payload->>'project_id' IS NOT NULL AND payload->>'project_id'<>p::text) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION crm_prospect_sources_valid(uuid,uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_prospect_sources_valid(uuid,uuid,uuid,jsonb) TO light_crm_app;
-- Reveal only the fact of a conflicting queued/uncertain send, never another actor's mail.
CREATE FUNCTION crm_prospect_pending_mail(w uuid,c uuid,p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT w=crm_workspace() AND crm_access(w,c,true) AND EXISTS(SELECT 1 FROM outgoing_mail o WHERE o.workspace_id=w AND o.customer_id=c AND o.project_id=p AND o.status IN ('approved','scheduled','sending','submitted','uncertain','partial'))
$$;
REVOKE ALL ON FUNCTION crm_prospect_pending_mail(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_prospect_pending_mail(uuid,uuid,uuid) TO light_crm_app;
CREATE FUNCTION crm_prospect_project_stage(s text,l text,o text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN l='closed' THEN CASE WHEN o IN ('won','resolved') THEN 'completed' ELSE 'cancelled' END WHEN l='paused' THEN 'in_progress' WHEN s='new' THEN 'new' ELSE 'in_progress' END
$$;
CREATE FUNCTION crm_prospect_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (NEW.workspace_id,NEW.customer_id,NEW.project_id,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.workspace_id,OLD.customer_id,OLD.project_id,OLD.created_by,OLD.created_at) OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'prospect identity or version mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM projects p WHERE p.workspace_id=NEW.workspace_id AND p.customer_id=NEW.customer_id AND p.id=NEW.project_id AND p.type='inquiry' AND p.archived_at IS NULL) THEN RAISE EXCEPTION 'prospect requires an active inquiry project' USING ERRCODE='23514'; END IF;
 NEW.updated_at:=now(); RETURN NEW;
END $$;
CREATE TRIGGER prospect_identity BEFORE INSERT OR UPDATE ON prospect_profiles FOR EACH ROW EXECUTE FUNCTION crm_prospect_identity();
CREATE FUNCTION crm_prospect_sync_stage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE projects SET stage=crm_prospect_project_stage(NEW.stage,NEW.lifecycle,NEW.outcome) WHERE workspace_id=NEW.workspace_id AND customer_id=NEW.customer_id AND id=NEW.project_id AND stage IS DISTINCT FROM crm_prospect_project_stage(NEW.stage,NEW.lifecycle,NEW.outcome);
 RETURN NEW;
END $$;
CREATE TRIGGER prospect_sync_stage AFTER INSERT OR UPDATE ON prospect_profiles FOR EACH ROW EXECUTE FUNCTION crm_prospect_sync_stage();
CREATE FUNCTION crm_prospect_project_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f prospect_profiles%ROWTYPE;
BEGIN
 SELECT * INTO f FROM prospect_profiles WHERE workspace_id=NEW.workspace_id AND project_id=NEW.id;
 IF f.project_id IS NOT NULL THEN
  IF NEW.type<>'inquiry' OR NEW.stage<>crm_prospect_project_stage(f.stage,f.lifecycle,f.outcome) THEN RAISE EXCEPTION 'managed inquiry stage and type are controlled by prospect state' USING ERRCODE='23514'; END IF;
  IF (NEW.name,NEW.owner_id) IS DISTINCT FROM (OLD.name,OLD.owner_id) AND current_setting('app.prospect_mutation',true) IS DISTINCT FROM NEW.id::text THEN RAISE EXCEPTION 'managed inquiry metadata must be edited through prospect state' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prospect_project_guard BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION crm_prospect_project_guard();
-- Serialize mail approval with closure on the same project row. Neither action cancels mail.
CREATE FUNCTION crm_prospect_outgoing_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.project_id IS NOT NULL AND NEW.status IN ('approved','scheduled') THEN
  PERFORM 1 FROM projects WHERE workspace_id=NEW.workspace_id AND customer_id=NEW.customer_id AND id=NEW.project_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM prospect_profiles WHERE workspace_id=NEW.workspace_id AND customer_id=NEW.customer_id AND project_id=NEW.project_id AND lifecycle='closed') THEN RAISE EXCEPTION 'closed inquiry cannot approve or schedule outgoing mail' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prospect_outgoing_guard BEFORE INSERT OR UPDATE ON outgoing_mail FOR EACH ROW EXECUTE FUNCTION crm_prospect_outgoing_guard();
