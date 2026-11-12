CREATE TABLE mail_sender_grants (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  grant_id uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (workspace_id, account_id, actor_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES mail_accounts(workspace_id, id),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES memberships(workspace_id, actor_id)
);
CREATE INDEX mail_sender_grants_actor ON mail_sender_grants(workspace_id, actor_id);
ALTER TABLE mail_sender_grants ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON mail_sender_grants TO light_crm_app;
CREATE POLICY mail_sender_grants_admin ON mail_sender_grants FOR ALL
  USING (crm_admin(workspace_id)) WITH CHECK (crm_admin(workspace_id));

CREATE FUNCTION crm_member_sender_accounts(w uuid)
RETURNS TABLE(id uuid, email text, grant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT account.id, account.email, g.grant_id
  FROM mail_sender_grants g
  JOIN mail_accounts account ON (account.workspace_id, account.id) = (g.workspace_id, g.account_id)
  JOIN memberships m ON (m.workspace_id, m.actor_id) = (g.workspace_id, g.actor_id)
  WHERE w = crm_workspace() AND g.workspace_id = w AND g.actor_id = crm_actor()
    AND m.active AND m.role = 'member' AND m.workspace_mode = 'crm' AND account.enabled
  ORDER BY account.created_at, account.id
$$;

-- Only the current author of an approved outgoing version can resolve its
-- sealed credential after the worker has claimed it, or when reconciling it.
CREATE FUNCTION crm_member_outgoing_sender(w uuid, outgoing_id uuid, expected_version int, expected_message text, expected_grant uuid)
RETURNS TABLE(id uuid, email text, secret text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT account.id, account.email, account.secret
  FROM outgoing_mail outgoing
  JOIN mail_sender_grants g ON (g.workspace_id, g.account_id, g.actor_id) = (outgoing.workspace_id, outgoing.account_id, outgoing.created_by)
  JOIN mail_accounts account ON (account.workspace_id, account.id) = (g.workspace_id, g.account_id)
  JOIN memberships m ON (m.workspace_id, m.actor_id) = (g.workspace_id, g.actor_id)
  JOIN customer_access permission ON (permission.workspace_id, permission.customer_id, permission.actor_id) = (outgoing.workspace_id, outgoing.customer_id, outgoing.created_by)
  WHERE w = crm_workspace() AND outgoing.workspace_id = w AND outgoing.id = outgoing_id
    AND outgoing.created_by = crm_actor() AND outgoing.version = expected_version
    AND outgoing.message_id = expected_message AND outgoing.approved_version = outgoing.version
    AND outgoing.approved_digest IS NOT NULL AND outgoing.from_email = account.email
    AND outgoing.status IN ('sending', 'uncertain', 'submitted', 'sent_confirmed', 'partial')
    AND g.grant_id = expected_grant AND m.active AND m.role = 'member' AND m.workspace_mode = 'crm'
    AND account.enabled AND permission.access = 'editor'
  FOR SHARE OF account, g, permission
$$;

REVOKE ALL ON FUNCTION crm_member_sender_accounts(uuid),
  crm_member_outgoing_sender(uuid, uuid, int, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_member_sender_accounts(uuid),
  crm_member_outgoing_sender(uuid, uuid, int, text, uuid) TO light_crm_app;
