-- Only explicit user presentation preferences; conversation/business knowledge stays in Records.
CREATE TABLE user_preferences (
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  id uuid NOT NULL,
  category text NOT NULL,
  value text NOT NULL,
  source_chat_id uuid NOT NULL,
  source_message_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, actor_id, category),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES memberships(workspace_id, actor_id),
  FOREIGN KEY (workspace_id, source_chat_id) REFERENCES agent_chats(workspace_id, id),
  FOREIGN KEY (workspace_id, source_message_id) REFERENCES chat_messages(workspace_id, id),
  CHECK ((category = 'response_length' AND value IN ('concise', 'detailed'))
    OR (category = 'response_format' AND value IN ('table', 'list', 'paragraph'))
    OR (category = 'response_language' AND value IN ('zh', 'en'))
    OR (category = 'contact_columns' AND value = 'name_company_email')
    OR (category = 'contact_format' AND value = 'table')
    OR (category IN ('email_tone', 'email_tone_en', 'email_tone_zh')
      AND value IN ('concise_direct', 'formal', 'warm')))
);
CREATE TABLE user_preference_requests (
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  source_chat_id uuid NOT NULL,
  source_message_id uuid NOT NULL,
  input_hash text NOT NULL,
  action text NOT NULL CHECK (action IN ('save', 'remove')),
  category text NOT NULL,
  PRIMARY KEY (workspace_id, actor_id, request_id),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES memberships(workspace_id, actor_id),
  FOREIGN KEY (workspace_id, source_chat_id) REFERENCES agent_chats(workspace_id, id),
  FOREIGN KEY (workspace_id, source_message_id) REFERENCES chat_messages(workspace_id, id)
);
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preference_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_preferences TO light_crm_app;
GRANT SELECT, INSERT ON user_preference_requests TO light_crm_app;
CREATE POLICY user_preferences_private ON user_preferences FOR ALL
  USING (workspace_id = crm_workspace() AND actor_id = crm_actor() AND EXISTS (
    SELECT 1 FROM workspace_people m WHERE m.workspace_id = user_preferences.workspace_id
      AND m.actor_id = crm_actor() AND m.active
  ))
  WITH CHECK (workspace_id = crm_workspace() AND actor_id = crm_actor() AND EXISTS (
    SELECT 1 FROM workspace_people m WHERE m.workspace_id = user_preferences.workspace_id
      AND m.actor_id = crm_actor() AND m.active
  ) AND EXISTS (
    SELECT 1 FROM chat_messages m JOIN agent_chats c ON c.workspace_id=m.workspace_id AND c.id=m.chat_id
      WHERE m.workspace_id=user_preferences.workspace_id AND m.id=user_preferences.source_message_id
        AND m.chat_id=user_preferences.source_chat_id AND m.role='user' AND m.material IS NULL
        AND c.actor_id=crm_actor()
  ));
CREATE POLICY user_preference_requests_private ON user_preference_requests FOR ALL
  USING (workspace_id = crm_workspace() AND actor_id = crm_actor() AND EXISTS (
    SELECT 1 FROM workspace_people m WHERE m.workspace_id = user_preference_requests.workspace_id
      AND m.actor_id = crm_actor() AND m.active
  ))
  WITH CHECK (workspace_id = crm_workspace() AND actor_id = crm_actor() AND EXISTS (
    SELECT 1 FROM workspace_people m WHERE m.workspace_id = user_preference_requests.workspace_id
      AND m.actor_id = crm_actor() AND m.active
  ) AND EXISTS (
    SELECT 1 FROM chat_messages m JOIN agent_chats c ON c.workspace_id=m.workspace_id AND c.id=m.chat_id
      WHERE m.workspace_id=user_preference_requests.workspace_id AND m.id=user_preference_requests.source_message_id
        AND m.chat_id=user_preference_requests.source_chat_id AND m.request_id=user_preference_requests.request_id
        AND m.role='user' AND m.material IS NULL AND c.actor_id=crm_actor()
  ));
CREATE FUNCTION crm_user_preference_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.id IS DISTINCT FROM OLD.id OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'user preference scope is immutable' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER user_preference_scope BEFORE UPDATE ON user_preferences
  FOR EACH ROW EXECUTE FUNCTION crm_user_preference_scope();
