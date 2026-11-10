ALTER TABLE mail_accounts
  ADD COLUMN intake_mode text NOT NULL DEFAULT 'review' CHECK(intake_mode IN ('review','manual')),
  ADD COLUMN notify_unknown boolean NOT NULL DEFAULT true,
  ADD COLUMN notify_known boolean NOT NULL DEFAULT true,
  ADD COLUMN muted_senders jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN settings_version integer NOT NULL DEFAULT 1,
  ADD COLUMN settings_updated_at timestamptz;
-- Processing preferences are snapshots: changing an account never rewrites old mail.
ALTER TABLE mail_messages
  ADD COLUMN intake_mode text NOT NULL DEFAULT 'review' CHECK(intake_mode IN ('review','manual')),
  ADD COLUMN intake_suggestions jsonb,
  ADD COLUMN notification_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE mail_exclusions (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  rules jsonb NOT NULL DEFAULT '[]',
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mail_exclusions ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON mail_exclusions TO light_crm_app;
CREATE POLICY mail_exclusions_admin ON mail_exclusions FOR ALL
USING(crm_admin(workspace_id)) WITH CHECK(crm_admin(workspace_id));

CREATE TABLE mail_settings_audit (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  actor_id uuid NOT NULL,
  account_id uuid,
  kind text NOT NULL CHECK(kind IN ('processing','exclusions')),
  settings jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id),
  FOREIGN KEY(workspace_id,account_id) REFERENCES mail_accounts(workspace_id,id)
);
ALTER TABLE mail_settings_audit ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON mail_settings_audit TO light_crm_app;
CREATE POLICY mail_settings_audit_admin ON mail_settings_audit FOR ALL
USING(crm_admin(workspace_id))
WITH CHECK(crm_admin(workspace_id) AND actor_id=crm_actor());

CREATE FUNCTION crm_mail_matches(addresses jsonb, rules jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT EXISTS(
    SELECT 1 FROM jsonb_array_elements_text(addresses) a(address), jsonb_array_elements_text(rules) r(rule)
    WHERE CASE WHEN position('@' in r.rule)>0 THEN lower(trim(a.address))=r.rule
      ELSE split_part(lower(trim(a.address)),'@',2)=r.rule
        OR right(split_part(lower(trim(a.address)),'@',2),length(r.rule)+1)='.'||r.rule END
  )
$$;
-- Only a boolean is exposed, never another workspace's exclusions or mail.
CREATE FUNCTION crm_mail_excluded(w uuid, addresses jsonb) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN w IS DISTINCT FROM crm_workspace() THEN true ELSE
    coalesce((SELECT crm_mail_matches(addresses,rules) FROM mail_exclusions WHERE workspace_id=w),false) END
$$;
REVOKE ALL ON FUNCTION crm_mail_excluded(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_mail_excluded(uuid,jsonb) TO light_crm_app;
CREATE POLICY mail_exclusion_read ON mail_messages AS RESTRICTIVE FOR SELECT
USING(NOT crm_mail_excluded(workspace_id,participants));
CREATE POLICY mail_exclusion_insert ON mail_messages AS RESTRICTIVE FOR INSERT
WITH CHECK(NOT crm_mail_excluded(workspace_id,participants));
CREATE POLICY mail_people_exclusion_read ON mail_people AS RESTRICTIVE FOR SELECT
USING(EXISTS(SELECT 1 FROM mail_messages m WHERE m.workspace_id=mail_people.workspace_id AND m.id=message_id));

-- Admin-only counts include currently hidden mail so restoring a rule can be previewed.
CREATE FUNCTION crm_mail_exclusion_impact(proposed jsonb)
RETURNS TABLE(account_id uuid,email text,to_hide integer,to_restore integer,hidden integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT crm_admin(crm_workspace()) THEN RAISE EXCEPTION 'administrator required' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT a.id,a.email,
    count(m.id) FILTER(WHERE crm_mail_matches(m.participants,proposed) AND NOT crm_mail_excluded(m.workspace_id,m.participants))::integer,
    count(m.id) FILTER(WHERE NOT crm_mail_matches(m.participants,proposed) AND crm_mail_excluded(m.workspace_id,m.participants))::integer,
    count(m.id) FILTER(WHERE crm_mail_matches(m.participants,proposed))::integer
  FROM mail_accounts a LEFT JOIN mail_messages m ON m.workspace_id=a.workspace_id AND m.account_id=a.id
  WHERE a.workspace_id=crm_workspace() GROUP BY a.id,a.email ORDER BY a.email;
END $$;
REVOKE ALL ON FUNCTION crm_mail_exclusion_impact(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_mail_exclusion_impact(jsonb) TO light_crm_app;
