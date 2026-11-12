ALTER TABLE memberships
  ADD COLUMN workspace_mode text NOT NULL DEFAULT 'crm',
  ADD CONSTRAINT memberships_workspace_mode_check
    CHECK (workspace_mode IN ('crm', 'tasks') AND (role <> 'admin' OR workspace_mode = 'crm'));

CREATE OR REPLACE VIEW workspace_people WITH (security_barrier = true) AS
  SELECT m.workspace_id, m.actor_id, m.role, m.active, u.display_name, u.email, m.workspace_mode
  FROM memberships m JOIN users u ON u.id = m.actor_id
  WHERE m.workspace_id = crm_workspace() AND EXISTS (
    SELECT 1 FROM memberships self
    WHERE self.workspace_id = m.workspace_id AND self.actor_id = crm_actor() AND self.active
  );

CREATE OR REPLACE FUNCTION crm_access(w uuid, c uuid, editing boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w = crm_workspace() AND EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.workspace_id = w AND m.actor_id = crm_actor() AND m.active AND m.workspace_mode = 'crm'
      AND (m.role = 'admin' OR EXISTS (
        SELECT 1 FROM customer_access a
        WHERE a.workspace_id = w AND a.customer_id = c AND a.actor_id = m.actor_id
          AND (NOT editing OR a.access = 'editor')
      ))
  )
$$;

CREATE OR REPLACE FUNCTION crm_activity_member_access(w uuid, c uuid, a uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w = crm_workspace() AND crm_access(w, c) AND EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.workspace_id = w AND m.actor_id = a AND m.active AND m.workspace_mode = 'crm'
      AND (m.role = 'admin' OR EXISTS (
        SELECT 1 FROM customer_access permission
        WHERE permission.workspace_id = w AND permission.customer_id = c AND permission.actor_id = a
      ))
  )
$$;
