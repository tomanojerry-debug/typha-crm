ALTER TABLE outgoing_mail DROP CONSTRAINT outgoing_mail_status_check;
ALTER TABLE outgoing_mail ADD CHECK(status IN ('draft','approved','scheduled','sending','submitted','sent_confirmed','uncertain','partial','failed','cancelled','needs_review'));
ALTER TABLE outgoing_mail ADD CHECK(status<>'partial' OR (approved_version=version AND approved_at IS NOT NULL AND scheduled_at IS NOT NULL AND message_id IS NOT NULL));
ALTER TABLE outgoing_mail ADD UNIQUE(workspace_id,customer_id,id);
CREATE TABLE outgoing_deliveries (
 workspace_id uuid NOT NULL, customer_id uuid NOT NULL, outgoing_id uuid NOT NULL,
 id uuid NOT NULL, version integer NOT NULL, batch_id text NOT NULL,
 recipient text NOT NULL, message_id text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','submitted','sent_confirmed','uncertain','failed','stopped')),
 error text, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,message_id),
 UNIQUE(workspace_id,outgoing_id,batch_id,recipient),
 FOREIGN KEY(workspace_id,customer_id,outgoing_id) REFERENCES outgoing_mail(workspace_id,customer_id,id)
);
ALTER TABLE outgoing_deliveries ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON outgoing_deliveries TO light_crm_app;
CREATE POLICY delivery_read ON outgoing_deliveries FOR SELECT USING(EXISTS(SELECT 1 FROM outgoing_mail m WHERE m.workspace_id=outgoing_deliveries.workspace_id AND m.id=outgoing_id));
CREATE POLICY delivery_create ON outgoing_deliveries FOR INSERT WITH CHECK(EXISTS(SELECT 1 FROM outgoing_mail m WHERE m.workspace_id=outgoing_deliveries.workspace_id AND m.id=outgoing_id AND m.status='scheduled' AND m.version=outgoing_deliveries.version AND m.message_id=batch_id AND m.content->>'mass_sending'='true' AND m.content->'to' ? recipient));
CREATE POLICY delivery_update ON outgoing_deliveries FOR UPDATE USING(crm_access(workspace_id,customer_id,true) AND EXISTS(SELECT 1 FROM outgoing_mail m WHERE m.workspace_id=outgoing_deliveries.workspace_id AND m.id=outgoing_id)) WITH CHECK(crm_access(workspace_id,customer_id,true) AND EXISTS(SELECT 1 FROM outgoing_mail m WHERE m.workspace_id=outgoing_deliveries.workspace_id AND m.id=outgoing_id));
CREATE FUNCTION crm_delivery_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.workspace_id,NEW.customer_id,NEW.outgoing_id,NEW.id,NEW.version,NEW.batch_id,NEW.recipient,NEW.message_id) IS DISTINCT FROM (OLD.workspace_id,OLD.customer_id,OLD.outgoing_id,OLD.id,OLD.version,OLD.batch_id,OLD.recipient,OLD.message_id) THEN
  RAISE EXCEPTION 'delivery scope is immutable' USING ERRCODE='23514';
 END IF;
 NEW.updated_at := now(); RETURN NEW;
END $$;
CREATE TRIGGER delivery_scope BEFORE UPDATE ON outgoing_deliveries FOR EACH ROW EXECUTE FUNCTION crm_delivery_scope();
CREATE OR REPLACE FUNCTION crm_is_outgoing_message(w uuid,a uuid,m text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT crm_admin(w) AND (EXISTS(SELECT 1 FROM outgoing_mail WHERE workspace_id=w AND account_id=a AND message_id=m) OR EXISTS(SELECT 1 FROM outgoing_deliveries d JOIN outgoing_mail o ON o.workspace_id=d.workspace_id AND o.id=d.outgoing_id WHERE d.workspace_id=w AND o.account_id=a AND d.message_id=m))
$$;
CREATE OR REPLACE FUNCTION crm_outgoing_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR
     NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR
     NEW.reply_to_message_id IS DISTINCT FROM OLD.reply_to_message_id OR NEW.in_reply_to IS DISTINCT FROM OLD.in_reply_to OR NEW.reference_ids IS DISTINCT FROM OLD.reference_ids THEN
    RAISE EXCEPTION 'outgoing scope is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.content IS DISTINCT FROM OLD.content OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    IF OLD.status IN ('sending','submitted','sent_confirmed','uncertain','partial') THEN
      RAISE EXCEPTION 'submitted content is immutable' USING ERRCODE='23514';
    END IF;
    NEW.version := OLD.version+1;
    NEW.status := 'draft'; NEW.approved_version := NULL; NEW.approved_at := NULL; NEW.approved_digest := NULL;
    NEW.scheduled_at := NULL; NEW.timezone := NULL; NEW.message_id := NULL; NEW.from_email := NULL; NEW.error := NULL;
  END IF;
  NEW.updated_at := now(); RETURN NEW;
END $$;
