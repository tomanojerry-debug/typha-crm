-- Accepted inputs and provisional output are separate from atomic, validated
-- chat message pairs. A disconnected browser does not own this queue.
CREATE TABLE agent_runs (
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  id uuid NOT NULL,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('message','ask','workflow')),
  status text NOT NULL CHECK(status IN ('queued','running','cancelling','completed','failed','cancelled','interrupted')),
  question text NOT NULL,
  payload jsonb NOT NULL,
  fingerprint text NOT NULL,
  answer text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1,
  attempt integer NOT NULL DEFAULT 1,
  token uuid NOT NULL,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,actor_id,request_id),
  FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id),
  FOREIGN KEY(workspace_id,chat_id) REFERENCES agent_chats(workspace_id,id)
);
CREATE UNIQUE INDEX agent_run_one_active ON agent_runs(workspace_id,actor_id,chat_id)
  WHERE status IN ('queued','running','cancelling');
CREATE INDEX agent_run_chat_recent ON agent_runs(workspace_id,actor_id,chat_id,created_at DESC,id DESC);
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON agent_runs TO light_crm_app;
CREATE POLICY agent_run_private ON agent_runs FOR ALL
  USING (workspace_id=crm_workspace() AND actor_id=crm_actor() AND EXISTS (
    SELECT 1 FROM agent_chats c WHERE c.workspace_id=agent_runs.workspace_id AND c.id=agent_runs.chat_id AND c.actor_id=crm_actor()
  ))
  WITH CHECK (workspace_id=crm_workspace() AND actor_id=crm_actor() AND EXISTS (
    SELECT 1 FROM agent_chats c WHERE c.workspace_id=agent_runs.workspace_id AND c.id=agent_runs.chat_id AND c.actor_id=crm_actor()
  ));
