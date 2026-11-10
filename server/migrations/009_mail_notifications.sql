-- Only mail received after an account was connected produces a new-mail reminder.
ALTER TABLE mail_messages ADD COLUMN received_after_connection boolean NOT NULL DEFAULT false;
-- A metadata backfill is not a customer edit and has no acting user.
ALTER TABLE mail_messages DISABLE TRIGGER mail_audit;
UPDATE mail_messages m SET received_after_connection = (m.occurred_at >= a.created_at)
FROM mail_accounts a WHERE a.workspace_id=m.workspace_id AND a.id=m.account_id;
ALTER TABLE mail_messages ENABLE TRIGGER mail_audit;
CREATE TABLE mail_notification_reads (
  workspace_id uuid NOT NULL, actor_id uuid NOT NULL, message_id uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,actor_id,message_id),
  FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id),
  FOREIGN KEY(workspace_id,message_id) REFERENCES mail_messages(workspace_id,id)
);
ALTER TABLE mail_notification_reads ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON mail_notification_reads TO light_crm_app;
CREATE POLICY mail_notification_private ON mail_notification_reads FOR ALL
USING(workspace_id=crm_workspace() AND actor_id=crm_actor() AND EXISTS(
  SELECT 1 FROM mail_messages m WHERE m.workspace_id=mail_notification_reads.workspace_id AND m.id=message_id
)) WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor() AND EXISTS(
  SELECT 1 FROM mail_messages m WHERE m.workspace_id=mail_notification_reads.workspace_id AND m.id=message_id
));
CREATE INDEX mail_notification_recent ON mail_messages(workspace_id,occurred_at DESC,id)
WHERE received_after_connection AND direction='inbound';
