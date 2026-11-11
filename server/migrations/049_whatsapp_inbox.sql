CREATE TABLE whatsapp_inbox_messages (
 workspace_id uuid NOT NULL, actor_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(),
 waba_id text NOT NULL, phone_number_id text NOT NULL,
 message_id text NOT NULL CHECK(length(message_id) BETWEEN 1 AND 250),
 sender_id text NOT NULL CHECK(length(sender_id) BETWEEN 1 AND 250),
 sender_name text CHECK(length(sender_name) BETWEEN 1 AND 120),
 occurred_at timestamptz NOT NULL, text text CHECK(length(text) BETWEEN 1 AND 8000),
 customer_id uuid, project_id uuid, record_id uuid,
 PRIMARY KEY(workspace_id,id),
 UNIQUE(workspace_id,actor_id,waba_id,phone_number_id,message_id),
 UNIQUE(workspace_id,record_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,customer_id,project_id) REFERENCES projects(workspace_id,customer_id,id),
 FOREIGN KEY(workspace_id,customer_id,record_id) REFERENCES customer_records(workspace_id,customer_id,id),
 CHECK((record_id IS NULL AND customer_id IS NULL AND project_id IS NULL AND text IS NOT NULL)
    OR (record_id IS NOT NULL AND customer_id IS NOT NULL AND text IS NULL AND sender_name IS NULL))
);
CREATE INDEX whatsapp_inbox_pending ON whatsapp_inbox_messages
 (workspace_id,actor_id,waba_id,phone_number_id,occurred_at DESC,id) WHERE record_id IS NULL;
ALTER TABLE whatsapp_inbox_messages ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON whatsapp_inbox_messages TO light_crm_app;
GRANT UPDATE (customer_id,project_id,record_id,text,sender_name) ON whatsapp_inbox_messages TO light_crm_app;

CREATE POLICY whatsapp_inbox_read ON whatsapp_inbox_messages FOR SELECT
 USING(workspace_id=crm_workspace() AND actor_id=crm_actor()
   AND (customer_id IS NULL OR crm_access(workspace_id,customer_id)));
CREATE POLICY whatsapp_inbox_receive ON whatsapp_inbox_messages FOR INSERT
 WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor() AND record_id IS NULL);
CREATE POLICY whatsapp_inbox_archive ON whatsapp_inbox_messages FOR UPDATE
 USING(workspace_id=crm_workspace() AND actor_id=crm_actor()
   AND (customer_id IS NULL OR crm_access(workspace_id,customer_id)))
 WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor() AND record_id IS NOT NULL
   AND crm_access(workspace_id,customer_id,true)
   AND EXISTS(SELECT 1 FROM customers c WHERE c.workspace_id=whatsapp_inbox_messages.workspace_id
     AND c.id=whatsapp_inbox_messages.customer_id AND c.archived_at IS NULL)
   AND (project_id IS NULL OR EXISTS(SELECT 1 FROM projects p WHERE p.workspace_id=whatsapp_inbox_messages.workspace_id
     AND p.customer_id=whatsapp_inbox_messages.customer_id AND p.id=whatsapp_inbox_messages.project_id AND p.archived_at IS NULL))
   AND EXISTS(SELECT 1 FROM customer_records r WHERE r.workspace_id=whatsapp_inbox_messages.workspace_id
     AND r.customer_id=whatsapp_inbox_messages.customer_id AND r.id=whatsapp_inbox_messages.record_id
     AND r.project_id IS NOT DISTINCT FROM whatsapp_inbox_messages.project_id
     AND r.kind='customer_quote' AND r.source_kind='manual' AND r.created_by=crm_actor()));

-- Archived rows can be locked and checked for replay, but not reassigned.
CREATE FUNCTION crm_whatsapp_archive_once() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.record_id IS NOT NULL THEN
   RAISE EXCEPTION 'WhatsApp message is already archived' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER whatsapp_archive_once BEFORE UPDATE ON whatsapp_inbox_messages
 FOR EACH ROW EXECUTE FUNCTION crm_whatsapp_archive_once();
