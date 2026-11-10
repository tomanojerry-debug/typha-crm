-- Templates are explicitly created, private to their author and workspace.
-- Customer templates never become personal or company-wide knowledge implicitly.
CREATE TABLE mail_templates (
  workspace_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  id uuid NOT NULL,
  request_id uuid NOT NULL DEFAULT gen_random_uuid(),
  scope text NOT NULL DEFAULT 'customer' CHECK (scope IN ('customer', 'personal')),
  customer_id uuid,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80 AND name !~ E'[\\r\\n]'),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 200),
  subject text NOT NULL CHECK (length(subject) <= 500 AND subject !~ E'[\\r\\n]'),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, actor_id, request_id),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES memberships(workspace_id, actor_id),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES customers(workspace_id, id),
  CHECK ((scope = 'customer' AND customer_id IS NOT NULL)
    OR (scope = 'personal' AND customer_id IS NULL))
);
CREATE INDEX mail_templates_owner ON mail_templates(workspace_id, actor_id, customer_id, created_at DESC);
ALTER TABLE mail_templates ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON mail_templates TO light_crm_app;
CREATE POLICY mail_template_read ON mail_templates FOR SELECT
  USING (workspace_id = crm_workspace() AND actor_id = crm_actor() AND EXISTS (
    SELECT 1 FROM workspace_people m WHERE m.workspace_id = mail_templates.workspace_id
      AND m.actor_id = crm_actor() AND m.active
  ) AND (customer_id IS NULL OR (crm_access(workspace_id, customer_id) AND EXISTS (
    SELECT 1 FROM customers c WHERE c.workspace_id = mail_templates.workspace_id
      AND c.id = mail_templates.customer_id AND c.archived_at IS NULL
  ))));
CREATE POLICY mail_template_create ON mail_templates FOR INSERT
  WITH CHECK (workspace_id = crm_workspace() AND actor_id = crm_actor() AND EXISTS (
    SELECT 1 FROM workspace_people m WHERE m.workspace_id = mail_templates.workspace_id
      AND m.actor_id = crm_actor() AND m.active
  ) AND (customer_id IS NULL OR (crm_access(workspace_id, customer_id, true) AND EXISTS (
    SELECT 1 FROM customers c WHERE c.workspace_id = mail_templates.workspace_id
      AND c.id = mail_templates.customer_id AND c.archived_at IS NULL
  ))));
CREATE FUNCTION crm_mail_template_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    RAISE EXCEPTION 'mail template scope is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mail_template_scope BEFORE UPDATE ON mail_templates
  FOR EACH ROW EXECUTE FUNCTION crm_mail_template_scope();
