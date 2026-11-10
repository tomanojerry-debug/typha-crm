CREATE TABLE wechat_connectors (
 workspace_id uuid NOT NULL, actor_id uuid NOT NULL,
 encrypted_credentials text NOT NULL,
 user_hash text NOT NULL CHECK(length(user_hash)=64),
 bound_at timestamptz NOT NULL DEFAULT now(),
 verified_account_key text,
 PRIMARY KEY(workspace_id,actor_id),
 UNIQUE(workspace_id,user_hash),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id)
);
ALTER TABLE wechat_connectors ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,DELETE ON wechat_connectors TO light_crm_app;
CREATE POLICY wechat_connector_private ON wechat_connectors
 USING(workspace_id=crm_workspace() AND actor_id=crm_actor())
 WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor());
