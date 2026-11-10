CREATE TABLE agent_chats (
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  id uuid NOT NULL,
  customer_id uuid,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,id),
  FOREIGN KEY (workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id),
  FOREIGN KEY (workspace_id,customer_id) REFERENCES customers(workspace_id,id)
);
ALTER TABLE agent_chats ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON agent_chats TO light_crm_app;
CREATE POLICY chat_private ON agent_chats FOR ALL
  USING (workspace_id=crm_workspace() AND actor_id=crm_actor() AND EXISTS (
    SELECT 1 FROM workspace_people WHERE workspace_id=crm_workspace() AND actor_id=crm_actor() AND active
  ) AND (customer_id IS NULL OR crm_access(workspace_id,customer_id)))
  WITH CHECK (workspace_id=crm_workspace() AND actor_id=crm_actor() AND (customer_id IS NULL OR crm_access(workspace_id,customer_id)));
CREATE FUNCTION crm_chat_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.actor_id<>OLD.actor_id OR NEW.id<>OLD.id OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'chat scope is immutable' USING ERRCODE='23514';
  END IF;
  NEW.updated_at:=now(); RETURN NEW;
END $$;
CREATE TRIGGER chat_scope BEFORE UPDATE ON agent_chats FOR EACH ROW EXECUTE FUNCTION crm_chat_scope();

CREATE TABLE chat_messages (
  workspace_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  id uuid NOT NULL,
  request_id uuid NOT NULL,
  position bigint GENERATED ALWAYS AS IDENTITY,
  role text NOT NULL CHECK(role IN ('user','assistant')),
  body text NOT NULL,
  material jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,chat_id,request_id,role),
  FOREIGN KEY(workspace_id,chat_id) REFERENCES agent_chats(workspace_id,id)
);
CREATE TABLE chat_imports (
  workspace_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  id uuid NOT NULL,
  request_id uuid NOT NULL,
  object text NOT NULL CHECK(object IN ('customers','people','projects')),
  source_text text NOT NULL,
  columns jsonb NOT NULL,
  rows jsonb NOT NULL,
  list_name text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,chat_id,request_id),
  FOREIGN KEY(workspace_id,chat_id) REFERENCES agent_chats(workspace_id,id)
);
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_imports ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON chat_messages TO light_crm_app;
GRANT USAGE ON SEQUENCE chat_messages_position_seq TO light_crm_app;
GRANT SELECT,INSERT ON chat_imports TO light_crm_app;
GRANT UPDATE(result) ON chat_imports TO light_crm_app;
CREATE POLICY message_scope ON chat_messages FOR ALL
  USING (EXISTS (SELECT 1 FROM agent_chats c WHERE c.workspace_id=chat_messages.workspace_id AND c.id=chat_messages.chat_id))
  WITH CHECK (EXISTS (SELECT 1 FROM agent_chats c WHERE c.workspace_id=chat_messages.workspace_id AND c.id=chat_messages.chat_id));
CREATE POLICY import_scope ON chat_imports FOR ALL
  USING (EXISTS (SELECT 1 FROM agent_chats c WHERE c.workspace_id=chat_imports.workspace_id AND c.id=chat_imports.chat_id))
  WITH CHECK (EXISTS (SELECT 1 FROM agent_chats c WHERE c.workspace_id=chat_imports.workspace_id AND c.id=chat_imports.chat_id));
CREATE INDEX chat_recent ON agent_chats(workspace_id,actor_id,updated_at DESC);
CREATE INDEX chat_message_order ON chat_messages(workspace_id,chat_id,position);

-- Serialize imports within a workspace so two chats cannot import the same
-- name between duplicate validation and creation. This table holds no material.
CREATE TABLE workspace_import_guard (workspace_id uuid PRIMARY KEY REFERENCES workspaces(id));
ALTER TABLE workspace_import_guard ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON workspace_import_guard TO light_crm_app;
CREATE POLICY import_guard_scope ON workspace_import_guard FOR ALL
  USING (workspace_id=crm_workspace()) WITH CHECK (workspace_id=crm_workspace());
