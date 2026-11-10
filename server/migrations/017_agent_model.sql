-- Read-only Agent usage shares the encrypted workspace MiniMax setting.
-- Credentials never cross the HTTP boundary. The identity is set by scoped().
CREATE FUNCTION crm_agent_model_config(w uuid,c uuid DEFAULT NULL)
RETURNS TABLE(region text,encrypted_key text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT s.region,s.encrypted_key FROM attribute_model_settings s
 WHERE s.workspace_id=w AND w=crm_workspace()
 AND EXISTS(SELECT 1 FROM memberships m WHERE m.workspace_id=w AND m.actor_id=crm_actor() AND m.active)
 AND (c IS NULL OR crm_access(w,c))
$$;
REVOKE ALL ON FUNCTION crm_agent_model_config(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_agent_model_config(uuid,uuid) TO light_crm_app;

ALTER TABLE chat_messages ADD COLUMN model text;
ALTER TABLE chat_messages ADD COLUMN sources jsonb NOT NULL DEFAULT '[]';
ALTER TABLE chat_messages ADD COLUMN model_basis jsonb NOT NULL DEFAULT '[]';
ALTER TABLE chat_messages ADD COLUMN model_context_digest text;
