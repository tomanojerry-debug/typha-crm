ALTER TABLE wechat_queries ADD COLUMN archive_automatic boolean NOT NULL DEFAULT false;
ALTER TABLE wechat_queries ADD COLUMN archive_new_records integer NOT NULL DEFAULT 0 CHECK(archive_new_records>=0);

-- A binding expresses only who owns a specifically read single-chat source.
-- Existing private previews are not assigned or backfilled by this migration.
CREATE TABLE wechat_source_bindings (
 workspace_id uuid NOT NULL, actor_id uuid NOT NULL, id uuid NOT NULL,
 account_key text NOT NULL, talker text NOT NULL,
 customer_id uuid NOT NULL, person_id uuid,
 source_query_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,actor_id,account_key,talker),
 UNIQUE(workspace_id,account_key,talker),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id,person_id) REFERENCES people(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,source_query_id) REFERENCES wechat_queries(workspace_id,id)
);
ALTER TABLE wechat_source_bindings ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON wechat_source_bindings TO light_crm_app;
CREATE POLICY wechat_source_binding_read ON wechat_source_bindings FOR SELECT
 USING(workspace_id=crm_workspace() AND actor_id=crm_actor() AND crm_access(workspace_id,customer_id));
CREATE POLICY wechat_source_binding_create ON wechat_source_bindings FOR INSERT
 WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true)
 AND EXISTS(SELECT 1 FROM wechat_queries q WHERE q.workspace_id=wechat_source_bindings.workspace_id AND q.id=source_query_id AND q.actor_id=crm_actor() AND q.account_key=wechat_source_bindings.account_key AND q.identity->>'id'=talker));
-- Row locking serializes concurrent batches. Attribution itself is immutable.
CREATE POLICY wechat_source_binding_lock ON wechat_source_bindings FOR UPDATE
 USING(workspace_id=crm_workspace() AND actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true))
 WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true));
CREATE FUNCTION crm_wechat_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'wechat source binding is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER wechat_source_binding_immutable BEFORE UPDATE ON wechat_source_bindings FOR EACH ROW EXECUTE FUNCTION crm_wechat_binding_immutable();
CREATE TRIGGER wechat_source_binding_audit AFTER INSERT ON wechat_source_bindings FOR EACH ROW EXECUTE FUNCTION crm_audit();

-- One immutable Record per source message version. Project/person are attribution,
-- never part of the message identity, so moving a query cannot clone its evidence.
CREATE TABLE wechat_message_records (
 workspace_id uuid NOT NULL, actor_id uuid NOT NULL,
 account_key text NOT NULL, talker text NOT NULL, message_id text NOT NULL, content_hash text NOT NULL CHECK(length(content_hash)=64),
 customer_id uuid NOT NULL, person_id uuid, project_id uuid, record_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,account_key,talker,message_id,content_hash),
 UNIQUE(workspace_id,record_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,customer_id,record_id) REFERENCES customer_records(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,person_id) REFERENCES people(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,project_id) REFERENCES projects(workspace_id,customer_id,id)
);
ALTER TABLE wechat_message_records ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON wechat_message_records TO light_crm_app;
CREATE POLICY wechat_message_record_read ON wechat_message_records FOR SELECT
 USING(workspace_id=crm_workspace() AND actor_id=crm_actor() AND crm_access(workspace_id,customer_id));
CREATE POLICY wechat_message_record_create ON wechat_message_records FOR INSERT
 WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true)
 AND EXISTS(SELECT 1 FROM wechat_source_bindings b WHERE b.workspace_id=wechat_message_records.workspace_id AND b.actor_id=crm_actor() AND b.account_key=wechat_message_records.account_key AND b.talker=wechat_message_records.talker AND b.customer_id=wechat_message_records.customer_id AND b.person_id IS NOT DISTINCT FROM wechat_message_records.person_id));

-- A read can contain multiple new and already archived source messages.
CREATE TABLE wechat_query_records (
 workspace_id uuid NOT NULL, query_id uuid NOT NULL, customer_id uuid NOT NULL, record_id uuid NOT NULL,
 PRIMARY KEY(workspace_id,query_id,record_id),
 FOREIGN KEY(workspace_id,query_id) REFERENCES wechat_queries(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id,record_id) REFERENCES customer_records(workspace_id,customer_id,id)
);
ALTER TABLE wechat_query_records ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON wechat_query_records TO light_crm_app;
CREATE POLICY wechat_query_record_read ON wechat_query_records FOR SELECT
 USING(workspace_id=crm_workspace() AND crm_access(workspace_id,customer_id)
 AND EXISTS(SELECT 1 FROM wechat_queries q WHERE q.workspace_id=wechat_query_records.workspace_id AND q.id=query_id AND q.actor_id=crm_actor()));
CREATE POLICY wechat_query_record_create ON wechat_query_records FOR INSERT
 WITH CHECK(workspace_id=crm_workspace() AND crm_access(workspace_id,customer_id,true)
 AND EXISTS(SELECT 1 FROM wechat_queries q WHERE q.workspace_id=wechat_query_records.workspace_id AND q.id=query_id AND q.actor_id=crm_actor())
 AND EXISTS(SELECT 1 FROM wechat_message_records m JOIN wechat_queries q ON q.workspace_id=m.workspace_id AND q.account_key=m.account_key AND q.identity->>'id'=m.talker WHERE q.workspace_id=wechat_query_records.workspace_id AND q.id=query_id AND m.record_id=wechat_query_records.record_id AND m.customer_id=wechat_query_records.customer_id));
