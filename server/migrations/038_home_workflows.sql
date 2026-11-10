CREATE TABLE home_workflows (
 workspace_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 id uuid NOT NULL,
 chat_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('summary','reply','update')),
 step text NOT NULL DEFAULT 'configure' CHECK(step IN ('configure','ready','decision','review','completed','cancelled')),
 customer_id uuid,
 person_id uuid,
 project_id uuid,
 config jsonb NOT NULL,
 config_generation uuid NOT NULL DEFAULT gen_random_uuid(),
 result jsonb,
 result_digest text,
 draft_id uuid,
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,chat_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,chat_id) REFERENCES agent_chats(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id,person_id) REFERENCES people(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,project_id) REFERENCES projects(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,draft_id) REFERENCES outgoing_mail(workspace_id,id),
 CHECK((person_id IS NULL AND project_id IS NULL) OR customer_id IS NOT NULL),
 CHECK(jsonb_typeof(config)='object'),
 CHECK((config->>'customer_id')::uuid IS NOT DISTINCT FROM customer_id),
 CHECK((config->>'person_id')::uuid IS NOT DISTINCT FROM person_id),
 CHECK((config->>'project_id')::uuid IS NOT DISTINCT FROM project_id)
);
ALTER TABLE home_workflows ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON home_workflows TO light_crm_app;
CREATE POLICY home_workflow_private ON home_workflows FOR ALL
 USING(workspace_id=crm_workspace() AND actor_id=crm_actor()
   AND (customer_id IS NULL OR crm_access(workspace_id,customer_id))
   AND EXISTS(SELECT 1 FROM agent_chats c WHERE c.workspace_id=home_workflows.workspace_id AND c.id=home_workflows.chat_id AND c.actor_id=crm_actor()))
 WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor()
   AND (customer_id IS NULL OR crm_access(workspace_id,customer_id))
   AND EXISTS(SELECT 1 FROM agent_chats c WHERE c.workspace_id=home_workflows.workspace_id AND c.id=home_workflows.chat_id AND c.actor_id=crm_actor()
     AND (c.customer_id IS NULL OR c.customer_id=home_workflows.customer_id)));
CREATE FUNCTION crm_home_workflow_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.workspace_id<>OLD.workspace_id OR NEW.actor_id<>OLD.actor_id OR NEW.id<>OLD.id OR NEW.chat_id<>OLD.chat_id THEN
   RAISE EXCEPTION 'workflow identity is immutable' USING ERRCODE='23514';
 END IF;
 NEW.version:=OLD.version+1;
 NEW.updated_at:=now();
 RETURN NEW;
END $$;
CREATE TRIGGER home_workflow_touch BEFORE UPDATE ON home_workflows FOR EACH ROW EXECUTE FUNCTION crm_home_workflow_touch();
CREATE INDEX home_workflow_recent ON home_workflows(workspace_id,actor_id,updated_at DESC);

CREATE TABLE home_workflow_requests (
 workspace_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 request_id uuid NOT NULL,
 workflow_id uuid NOT NULL,
 config_generation uuid NOT NULL,
 fingerprint text NOT NULL,
 PRIMARY KEY(workspace_id,actor_id,request_id),
 FOREIGN KEY(workspace_id,workflow_id) REFERENCES home_workflows(workspace_id,id)
);
ALTER TABLE home_workflow_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON home_workflow_requests TO light_crm_app;
CREATE POLICY home_workflow_request_private ON home_workflow_requests FOR ALL
 USING(workspace_id=crm_workspace() AND actor_id=crm_actor()
   AND EXISTS(SELECT 1 FROM home_workflows w WHERE w.workspace_id=home_workflow_requests.workspace_id AND w.id=home_workflow_requests.workflow_id))
 WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor()
   AND EXISTS(SELECT 1 FROM home_workflows w WHERE w.workspace_id=home_workflow_requests.workspace_id AND w.id=home_workflow_requests.workflow_id));
