CREATE UNIQUE INDEX customer_record_scope_id ON customer_records(workspace_id,customer_id,id);
CREATE TABLE wechat_queries (
 workspace_id uuid NOT NULL, actor_id uuid NOT NULL, id uuid NOT NULL, request_id uuid NOT NULL,
 chat_id uuid, account_key text NOT NULL, identity jsonb NOT NULL,
 start_date date NOT NULL, end_date date NOT NULL, messages jsonb NOT NULL, entities jsonb NOT NULL, relations jsonb NOT NULL, warnings jsonb NOT NULL DEFAULT '[]',
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','associated')),
 customer_id uuid, person_id uuid, project_id uuid, record_id uuid, selected jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,actor_id,request_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,chat_id) REFERENCES agent_chats(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id,person_id) REFERENCES people(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,project_id) REFERENCES projects(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,record_id) REFERENCES customer_records(workspace_id,customer_id,id),
 CHECK(end_date>=start_date AND end_date-start_date<=30),
 CHECK((state='pending' AND customer_id IS NULL AND person_id IS NULL AND project_id IS NULL AND record_id IS NULL) OR (state='associated' AND customer_id IS NOT NULL AND record_id IS NOT NULL))
);
ALTER TABLE wechat_queries ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON wechat_queries TO light_crm_app;
CREATE POLICY wechat_query_private_read ON wechat_queries FOR SELECT USING(workspace_id=crm_workspace() AND actor_id=crm_actor() AND (customer_id IS NULL OR crm_access(workspace_id,customer_id)));
CREATE POLICY wechat_query_private_create ON wechat_queries FOR INSERT WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor() AND state='pending' AND customer_id IS NULL AND (chat_id IS NULL OR EXISTS(SELECT 1 FROM agent_chats c WHERE c.workspace_id=wechat_queries.workspace_id AND c.id=wechat_queries.chat_id AND c.actor_id=crm_actor())));
CREATE POLICY wechat_query_private_update ON wechat_queries FOR UPDATE USING(workspace_id=crm_workspace() AND actor_id=crm_actor() AND (customer_id IS NULL OR crm_access(workspace_id,customer_id,true))) WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor() AND state='associated' AND crm_access(workspace_id,customer_id,true));
CREATE FUNCTION crm_wechat_query_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.workspace_id<>OLD.workspace_id OR NEW.actor_id<>OLD.actor_id OR NEW.id<>OLD.id OR NEW.request_id<>OLD.request_id OR NEW.chat_id IS DISTINCT FROM OLD.chat_id OR NEW.account_key<>OLD.account_key OR NEW.identity<>OLD.identity OR NEW.messages<>OLD.messages OR NEW.entities<>OLD.entities OR NEW.relations<>OLD.relations OR NEW.start_date<>OLD.start_date OR NEW.end_date<>OLD.end_date OR NEW.warnings<>OLD.warnings OR OLD.state<>'pending' THEN RAISE EXCEPTION 'wechat query scope is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER wechat_query_scope BEFORE UPDATE ON wechat_queries FOR EACH ROW EXECUTE FUNCTION crm_wechat_query_scope();
