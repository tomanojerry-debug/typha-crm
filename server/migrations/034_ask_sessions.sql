-- Ask sessions share the private chat history. The captured source is immutable.
ALTER TABLE agent_chats ADD COLUMN origin jsonb;
ALTER TABLE agent_chats ADD CONSTRAINT chat_origin_shape CHECK (
  origin IS NULL OR coalesce((
    jsonb_typeof(origin)='object' AND origin->>'kind'='ask'
    AND jsonb_typeof(origin->'label')='string'
    AND length(trim(origin->>'label')) BETWEEN 1 AND 240
    AND jsonb_typeof(origin->'scope')='object'
  ),false)
);
CREATE OR REPLACE FUNCTION crm_chat_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.actor_id<>OLD.actor_id OR NEW.id<>OLD.id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.origin IS DISTINCT FROM OLD.origin THEN
    RAISE EXCEPTION 'chat scope is immutable' USING ERRCODE='23514';
  END IF;
  NEW.updated_at:=now(); RETURN NEW;
END $$;
ALTER TABLE chat_messages ADD COLUMN ask_request_digest text;
ALTER TABLE chat_messages ADD COLUMN ask_response jsonb;

-- A short lease serializes each session while network/model work happens outside
-- a transaction. No chat or successful messages exist until generation succeeds.
CREATE TABLE ask_session_claims (
  workspace_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  token uuid NOT NULL,
  scope jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
  PRIMARY KEY(workspace_id,chat_id),
  FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id)
);
ALTER TABLE ask_session_claims ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON ask_session_claims TO light_crm_app;
CREATE POLICY ask_claim_private ON ask_session_claims FOR ALL
  USING (workspace_id=crm_workspace() AND actor_id=crm_actor())
  WITH CHECK (workspace_id=crm_workspace() AND actor_id=crm_actor());

-- Return no other actor's chat data, but reject an already-used private UUID
-- before spending a model call. All data reads still pass through chat RLS.
CREATE FUNCTION crm_ask_chat_available(w uuid,c uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT w=crm_workspace()
    AND EXISTS(SELECT 1 FROM memberships WHERE workspace_id=w AND actor_id=crm_actor() AND active)
    AND NOT EXISTS(SELECT 1 FROM agent_chats WHERE workspace_id=w AND id=c
      AND (actor_id<>crm_actor() OR (customer_id IS NOT NULL AND NOT crm_access(w,customer_id))))
$$;
REVOKE ALL ON FUNCTION crm_ask_chat_available(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_ask_chat_available(uuid,uuid) TO light_crm_app;
