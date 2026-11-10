-- A personal preference remains the owner's preference after its source becomes
-- inaccessible. Inserts and provenance changes still require a currently readable
-- direct user message; editing the normalized value need not reopen that source.
DROP POLICY user_preferences_private ON user_preferences;
CREATE POLICY user_preferences_owner ON user_preferences FOR ALL
  USING (workspace_id = crm_workspace() AND actor_id = crm_actor() AND EXISTS (
    SELECT 1 FROM workspace_people m WHERE m.workspace_id = user_preferences.workspace_id
      AND m.actor_id = crm_actor() AND m.active
  ))
  WITH CHECK (workspace_id = crm_workspace() AND actor_id = crm_actor() AND EXISTS (
    SELECT 1 FROM workspace_people m WHERE m.workspace_id = user_preferences.workspace_id
      AND m.actor_id = crm_actor() AND m.active
  ));
CREATE POLICY user_preferences_insert_source ON user_preferences AS RESTRICTIVE FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM chat_messages m JOIN agent_chats c ON c.workspace_id=m.workspace_id AND c.id=m.chat_id
      WHERE m.workspace_id=user_preferences.workspace_id AND m.id=user_preferences.source_message_id
        AND m.chat_id=user_preferences.source_chat_id AND m.role='user' AND m.material IS NULL
        AND c.actor_id=crm_actor()
  ));

CREATE OR REPLACE FUNCTION crm_user_preference_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'user preference scope is immutable' USING ERRCODE = '23514';
  END IF;
  IF (NEW.source_chat_id IS DISTINCT FROM OLD.source_chat_id
    OR NEW.source_message_id IS DISTINCT FROM OLD.source_message_id) AND NOT EXISTS (
      SELECT 1 FROM chat_messages m JOIN agent_chats c ON c.workspace_id=m.workspace_id AND c.id=m.chat_id
        WHERE m.workspace_id=NEW.workspace_id AND m.id=NEW.source_message_id
          AND m.chat_id=NEW.source_chat_id AND m.role='user' AND m.material IS NULL
          AND c.actor_id=crm_actor()
  ) THEN
    RAISE EXCEPTION 'user preference source is not a readable direct user message' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
