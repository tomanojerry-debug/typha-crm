CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (workspace_id, actor_id)
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE customers (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  type text NOT NULL CHECK (type IN ('distributor', 'group', 'retail')),
  source text NOT NULL CHECK (source IN ('email', 'taobao', 'douyin', 'store', 'referral', 'other')),
  region text NOT NULL DEFAULT '',
  contact_name text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'potential' CHECK (status IN ('potential', 'active', 'paused')),
  owner_id uuid,
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, owner_id) REFERENCES memberships(workspace_id, actor_id)
);
CREATE TABLE customer_access (
  workspace_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  access text NOT NULL CHECK (access IN ('viewer', 'editor')),
  PRIMARY KEY (workspace_id, customer_id, actor_id),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES customers(workspace_id, id),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES memberships(workspace_id, actor_id)
);
CREATE TABLE projects (
  workspace_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  type text NOT NULL CHECK (type IN ('inquiry', 'sample', 'custom', 'purchase')),
  stage text NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'in_progress', 'waiting_customer', 'completed', 'cancelled')),
  description text NOT NULL DEFAULT '',
  due_date date,
  owner_id uuid,
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, customer_id, id),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES customers(workspace_id, id),
  FOREIGN KEY (workspace_id, owner_id) REFERENCES memberships(workspace_id, actor_id)
);
CREATE TABLE customer_records (
  workspace_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  project_id uuid,
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('customer_quote', 'inference', 'company_confirmed')),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 10000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES customers(workspace_id, id),
  FOREIGN KEY (workspace_id, customer_id, project_id) REFERENCES projects(workspace_id, customer_id, id),
  FOREIGN KEY (workspace_id, created_by) REFERENCES memberships(workspace_id, actor_id)
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  project_id uuid,
  actor_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, customer_id) REFERENCES customers(workspace_id, id),
  FOREIGN KEY (workspace_id, customer_id, project_id) REFERENCES projects(workspace_id, customer_id, id),
  FOREIGN KEY (workspace_id, actor_id) REFERENCES memberships(workspace_id, actor_id)
);
CREATE INDEX customers_recent ON customers(workspace_id, updated_at DESC, id);
CREATE INDEX customer_access_actor ON customer_access(workspace_id, actor_id, customer_id);
CREATE INDEX projects_customer ON projects(workspace_id, customer_id, updated_at DESC);
CREATE INDEX records_customer ON customer_records(workspace_id, customer_id, created_at DESC);
CREATE INDEX audit_customer ON audit_events(workspace_id, customer_id, created_at DESC);

-- The app's authentication connection owns migrations. Every business transaction
-- explicitly switches to this restricted role: table owners would bypass RLS.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'light_crm_app') THEN
    CREATE ROLE light_crm_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO light_crm_app;

CREATE FUNCTION crm_workspace() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.workspace_id', true), '')::uuid
$$;
CREATE FUNCTION crm_actor() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.actor_id', true), '')::uuid
$$;
CREATE FUNCTION crm_admin(w uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w = crm_workspace() AND EXISTS (
    SELECT 1 FROM memberships WHERE workspace_id = w AND actor_id = crm_actor() AND active AND role = 'admin'
  )
$$;
CREATE FUNCTION crm_access(w uuid, c uuid, editing boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w = crm_workspace() AND EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.workspace_id = w AND m.actor_id = crm_actor() AND m.active
      AND (m.role = 'admin' OR EXISTS (
        SELECT 1 FROM customer_access a
        WHERE a.workspace_id = w AND a.customer_id = c AND a.actor_id = m.actor_id
          AND (NOT editing OR a.access = 'editor')
      ))
  )
$$;
REVOKE ALL ON FUNCTION crm_admin(uuid), crm_access(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_admin(uuid), crm_access(uuid, uuid, boolean) TO light_crm_app;

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON customers, projects TO light_crm_app;
GRANT SELECT, INSERT ON customer_records TO light_crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_access TO light_crm_app;
GRANT SELECT ON audit_events TO light_crm_app;
CREATE POLICY customer_read ON customers FOR SELECT USING (crm_access(workspace_id, id));
CREATE POLICY customer_create ON customers FOR INSERT WITH CHECK (crm_admin(workspace_id));
CREATE POLICY customer_edit ON customers FOR UPDATE USING (crm_access(workspace_id, id, true)) WITH CHECK (crm_access(workspace_id, id, true));
CREATE POLICY project_read ON projects FOR SELECT USING (crm_access(workspace_id, customer_id));
CREATE POLICY project_create ON projects FOR INSERT WITH CHECK (crm_access(workspace_id, customer_id, true));
CREATE POLICY project_edit ON projects FOR UPDATE USING (crm_access(workspace_id, customer_id, true)) WITH CHECK (crm_access(workspace_id, customer_id, true));
CREATE POLICY record_read ON customer_records FOR SELECT USING (crm_access(workspace_id, customer_id));
CREATE POLICY record_create ON customer_records FOR INSERT WITH CHECK (crm_access(workspace_id, customer_id, true) AND created_by = crm_actor());
CREATE POLICY access_read ON customer_access FOR SELECT USING (crm_admin(workspace_id));
CREATE POLICY access_create ON customer_access FOR INSERT WITH CHECK (crm_admin(workspace_id));
CREATE POLICY access_edit ON customer_access FOR UPDATE USING (crm_admin(workspace_id)) WITH CHECK (crm_admin(workspace_id));
CREATE POLICY access_delete ON customer_access FOR DELETE USING (crm_admin(workspace_id));
CREATE POLICY audit_read ON audit_events FOR SELECT USING (crm_access(workspace_id, customer_id));

-- Expose only the directory fields needed for assignment, never password hashes
-- or another workspace's membership. The view runs as the migration owner.
CREATE VIEW workspace_people WITH (security_barrier = true) AS
  SELECT m.workspace_id, m.actor_id, m.role, m.active, u.display_name, u.email
  FROM memberships m JOIN users u ON u.id = m.actor_id
  WHERE m.workspace_id = crm_workspace() AND EXISTS (
    SELECT 1 FROM memberships self
    WHERE self.workspace_id = m.workspace_id AND self.actor_id = crm_actor() AND self.active
  );
GRANT SELECT ON workspace_people TO light_crm_app;

CREATE FUNCTION crm_immutable_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id THEN
    RAISE EXCEPTION 'scope is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'projects' THEN
    IF NEW.customer_id <> OLD.customer_id THEN
      RAISE EXCEPTION 'project customer is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_scope BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION crm_immutable_scope();
CREATE TRIGGER project_scope BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION crm_immutable_scope();

CREATE FUNCTION crm_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r jsonb; old_r jsonb; c uuid; p uuid; a text;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  c := CASE WHEN TG_TABLE_NAME = 'customers' THEN (r->>'id')::uuid ELSE (r->>'customer_id')::uuid END;
  p := CASE WHEN TG_TABLE_NAME = 'projects' THEN (r->>'id')::uuid ELSE (r->>'project_id')::uuid END;
  a := lower(TG_OP);
  IF TG_OP = 'UPDATE' THEN
    old_r := to_jsonb(OLD);
    IF old_r->>'archived_at' IS NULL AND r->>'archived_at' IS NOT NULL THEN a := 'archive';
    ELSIF old_r->>'archived_at' IS NOT NULL AND r->>'archived_at' IS NULL THEN a := 'restore';
    END IF;
  END IF;
  INSERT INTO audit_events(workspace_id, customer_id, project_id, actor_id, entity_type, entity_id, action)
  VALUES ((r->>'workspace_id')::uuid, c, p, crm_actor(), TG_TABLE_NAME,
    coalesce((r->>'id')::uuid, (r->>'actor_id')::uuid), a);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crm_audit() FROM PUBLIC;
CREATE TRIGGER customer_audit AFTER INSERT OR UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION crm_audit();
CREATE TRIGGER project_audit AFTER INSERT OR UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION crm_audit();
CREATE TRIGGER record_audit AFTER INSERT ON customer_records FOR EACH ROW EXECUTE FUNCTION crm_audit();
CREATE TRIGGER access_audit AFTER INSERT OR UPDATE OR DELETE ON customer_access FOR EACH ROW EXECUTE FUNCTION crm_audit();
