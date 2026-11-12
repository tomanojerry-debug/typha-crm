ALTER TABLE activity_tasks
  ADD COLUMN task_only boolean NOT NULL DEFAULT false,
  ADD COLUMN collaboration_brief text,
  ADD COLUMN attachment_required boolean NOT NULL DEFAULT false,
  ADD COLUMN mail_cc_actor_id uuid,
  ADD COLUMN revoked_at timestamptz,
  ADD CONSTRAINT activity_task_collaboration_fields CHECK (
    (NOT task_only AND collaboration_brief IS NULL AND NOT attachment_required AND mail_cc_actor_id IS NULL AND revoked_at IS NULL)
    OR (task_only AND collaboration_brief IS NOT NULL AND length(trim(collaboration_brief)) BETWEEN 1 AND 4000)
  ),
  ADD FOREIGN KEY (workspace_id,mail_cc_actor_id) REFERENCES memberships(workspace_id,actor_id);

-- Only an existing assignee or a customer editor may check a delegation.
-- The activity itself, its source Records, and its comments keep their existing policies.
CREATE FUNCTION crm_activity_collaboration_scope(w uuid,c uuid,a uuid,p uuid,issuer uuid,recipient uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT w=crm_workspace() AND EXISTS (
    SELECT 1 FROM business_activities activity
    JOIN customers customer ON customer.workspace_id=activity.workspace_id AND customer.id=activity.customer_id
    JOIN memberships author ON author.workspace_id=activity.workspace_id AND author.actor_id=issuer
    JOIN memberships assignee ON assignee.workspace_id=activity.workspace_id AND assignee.actor_id=recipient
    WHERE activity.workspace_id=w AND activity.customer_id=c AND activity.id=a
      AND activity.project_id IS NOT DISTINCT FROM p AND NOT activity.archived
      AND customer.archived_at IS NULL AND author.active AND author.workspace_mode='crm' AND assignee.active
      AND (p IS NULL OR EXISTS (
        SELECT 1 FROM projects project WHERE project.workspace_id=w AND project.customer_id=c
          AND project.id=p AND project.archived_at IS NULL
      ))
      AND (author.role='admin' OR EXISTS (
        SELECT 1 FROM customer_access permission
        WHERE permission.workspace_id=w AND permission.customer_id=c AND permission.actor_id=issuer
          AND permission.access='editor'
      ))
  )
$$;
CREATE FUNCTION crm_activity_collaboration_grantable(w uuid,c uuid,a uuid,p uuid,recipient uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT crm_access(w,c,true) AND crm_activity_collaboration_scope(w,c,a,p,crm_actor(),recipient)
$$;
CREATE FUNCTION crm_activity_collaboration_current(w uuid,t uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT w=crm_workspace() AND EXISTS (
    SELECT 1 FROM activity_tasks task
    WHERE task.workspace_id=w AND task.id=t AND task.task_only AND task.revoked_at IS NULL
      AND (task.assignee_id=crm_actor() OR crm_access(w,task.customer_id,true))
      AND crm_activity_collaboration_scope(w,task.customer_id,task.activity_id,task.project_id,task.created_by,task.assignee_id)
  )
$$;
REVOKE ALL ON FUNCTION crm_activity_collaboration_scope(uuid,uuid,uuid,uuid,uuid,uuid),
  crm_activity_collaboration_grantable(uuid,uuid,uuid,uuid,uuid),crm_activity_collaboration_current(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_activity_collaboration_grantable(uuid,uuid,uuid,uuid,uuid),
  crm_activity_collaboration_current(uuid,uuid) TO light_crm_app;

ALTER POLICY activity_task_read ON activity_tasks USING (
  crm_access(workspace_id,customer_id)
  OR (task_only AND revoked_at IS NULL AND assignee_id=crm_actor()
    AND crm_activity_collaboration_current(workspace_id,id))
);
ALTER POLICY activity_task_create ON activity_tasks WITH CHECK (
  created_by=crm_actor() AND crm_access(workspace_id,customer_id,true)
  AND (
    (NOT task_only AND crm_activity_member_access(workspace_id,customer_id,assignee_id))
    OR (task_only AND revoked_at IS NULL AND status='open' AND result IS NULL AND result_record_id IS NULL
      AND crm_activity_collaboration_grantable(workspace_id,customer_id,activity_id,project_id,assignee_id))
  )
);
ALTER POLICY activity_task_update ON activity_tasks USING (
  assignee_id=crm_actor() AND (
    (NOT task_only AND crm_access(workspace_id,customer_id))
    OR (task_only AND revoked_at IS NULL
      AND crm_activity_collaboration_current(workspace_id,id))
  )
) WITH CHECK (
  assignee_id=crm_actor() AND (
    (NOT task_only AND crm_access(workspace_id,customer_id))
    OR (task_only AND revoked_at IS NULL
      AND crm_activity_collaboration_current(workspace_id,id))
  )
);
CREATE POLICY activity_task_revoke ON activity_tasks FOR UPDATE
  USING (task_only AND revoked_at IS NULL AND crm_access(workspace_id,customer_id,true))
  WITH CHECK (task_only AND revoked_at IS NOT NULL AND crm_access(workspace_id,customer_id,true));

CREATE OR REPLACE FUNCTION crm_activity_task_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rid uuid;
BEGIN
  IF (NEW.workspace_id,NEW.customer_id,NEW.id,NEW.activity_id,NEW.comment_id,NEW.project_id,NEW.assignee_id,NEW.created_by,NEW.created_at,NEW.title,NEW.due_date,NEW.task_only,NEW.collaboration_brief,NEW.attachment_required,NEW.mail_cc_actor_id)
  IS DISTINCT FROM (OLD.workspace_id,OLD.customer_id,OLD.id,OLD.activity_id,OLD.comment_id,OLD.project_id,OLD.assignee_id,OLD.created_by,OLD.created_at,OLD.title,OLD.due_date,OLD.task_only,OLD.collaboration_brief,OLD.attachment_required,OLD.mail_cc_actor_id)
  OR NEW.result_record_id IS DISTINCT FROM OLD.result_record_id
  THEN RAISE EXCEPTION 'task attribution immutable' USING ERRCODE='23514'; END IF;

  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    IF NOT OLD.task_only OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
      OR NOT crm_access(OLD.workspace_id,OLD.customer_id,true)
      OR (NEW.status,NEW.result) IS DISTINCT FROM (OLD.status,OLD.result)
    THEN RAISE EXCEPTION 'invalid task revocation' USING ERRCODE='42501'; END IF;
    NEW.revoked_at=now();
  ELSE
    IF OLD.status='completed' THEN RAISE EXCEPTION 'completed task immutable' USING ERRCODE='23514'; END IF;
    IF NEW.assignee_id IS DISTINCT FROM crm_actor() THEN
      RAISE EXCEPTION 'only assignee may update task' USING ERRCODE='42501';
    END IF;

    IF NEW.task_only THEN
      PERFORM 1 FROM memberships WHERE workspace_id=NEW.workspace_id AND actor_id=NEW.created_by FOR SHARE;
      PERFORM 1 FROM customers WHERE workspace_id=NEW.workspace_id AND id=NEW.customer_id FOR SHARE;
      PERFORM 1 FROM customer_access WHERE workspace_id=NEW.workspace_id AND customer_id=NEW.customer_id AND actor_id=NEW.created_by FOR SHARE;
      PERFORM 1 FROM projects WHERE workspace_id=NEW.workspace_id AND customer_id=NEW.customer_id AND id=NEW.project_id FOR SHARE;
      PERFORM 1 FROM business_activities WHERE workspace_id=NEW.workspace_id AND id=NEW.activity_id FOR SHARE;
      IF OLD.revoked_at IS NOT NULL OR NOT crm_activity_collaboration_scope(NEW.workspace_id,NEW.customer_id,NEW.activity_id,NEW.project_id,NEW.created_by,NEW.assignee_id)
      THEN RAISE EXCEPTION 'task delegation is no longer active' USING ERRCODE='42501'; END IF;
      IF NEW.status NOT IN ('in_progress','completed') THEN
        RAISE EXCEPTION 'invalid collaboration task state' USING ERRCODE='23514';
      END IF;
    ELSIF NOT crm_access(NEW.workspace_id,NEW.customer_id) THEN
      RAISE EXCEPTION 'only assignee may update task' USING ERRCODE='42501';
    END IF;

    IF NEW.status='completed' THEN
      IF NEW.result IS NULL OR length(trim(NEW.result)) NOT BETWEEN 1 AND 4000 THEN
        RAISE EXCEPTION 'task result required' USING ERRCODE='23514';
      END IF;
      IF NOT NEW.task_only THEN
        rid=gen_random_uuid();
        INSERT INTO customer_records(workspace_id,customer_id,project_id,id,kind,body,created_by,source_kind,occurred_at)
        VALUES(NEW.workspace_id,NEW.customer_id,NEW.project_id,rid,'inference','活动待办「'||NEW.title||'」处理结果（本人内部报告，不代表公司正式确认）：'||NEW.result,crm_actor(),'manual',now());
        INSERT INTO activity_record_sources(workspace_id,customer_id,activity_id,record_id)
        VALUES(NEW.workspace_id,NEW.customer_id,NEW.activity_id,rid);
        IF EXISTS (
          SELECT 1 FROM memberships m WHERE m.workspace_id=NEW.workspace_id AND m.actor_id=NEW.created_by AND m.active
            AND m.workspace_mode='crm'
            AND (m.role='admin' OR EXISTS(SELECT 1 FROM customer_access ca WHERE ca.workspace_id=m.workspace_id AND ca.customer_id=NEW.customer_id AND ca.actor_id=m.actor_id AND ca.access='editor'))
        ) THEN
          UPDATE knowledge_sync SET actor_id=NEW.created_by WHERE workspace_id=NEW.workspace_id AND customer_id=NEW.customer_id;
          UPDATE source_index_sync SET actor_id=NEW.created_by WHERE workspace_id=NEW.workspace_id AND customer_id=NEW.customer_id;
        ELSE
          UPDATE knowledge_sync SET state='failed',attempts=3,error='处理结果已保存；知识索引等待有客户编辑权限的成员重新整理',retry_at=NULL WHERE workspace_id=NEW.workspace_id AND customer_id=NEW.customer_id;
          UPDATE source_index_sync SET state='failed',attempts=3,error='处理结果已保存；原文索引等待有客户编辑权限的成员重新整理',retry_at=NULL WHERE workspace_id=NEW.workspace_id AND customer_id=NEW.customer_id;
        END IF;
        NEW.result_record_id=rid;
      END IF;
    END IF;
  END IF;
  NEW.version=OLD.version+1;
  NEW.updated_at=now();
  RETURN NEW;
END $$;

CREATE TABLE activity_task_attachments (
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  filename text NOT NULL CHECK (length(trim(filename)) BETWEEN 1 AND 160),
  content_type text NOT NULL CHECK (content_type IN ('application/pdf','text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 1048576),
  size_bytes integer GENERATED ALWAYS AS (octet_length(content)) STORED,
  PRIMARY KEY(workspace_id,task_id),
  FOREIGN KEY(workspace_id,task_id) REFERENCES activity_tasks(workspace_id,id)
);
ALTER TABLE activity_task_attachments ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON activity_task_attachments TO light_crm_app;
CREATE POLICY activity_task_attachment_read ON activity_task_attachments FOR SELECT USING (
  workspace_id=crm_workspace() AND EXISTS (
    SELECT 1 FROM activity_tasks task
    WHERE task.workspace_id=activity_task_attachments.workspace_id AND task.id=activity_task_attachments.task_id
      AND task.task_only AND task.status='completed' AND (
        crm_access(task.workspace_id,task.customer_id,true)
        OR (task.assignee_id=crm_actor() AND task.revoked_at IS NULL
          AND crm_activity_collaboration_current(task.workspace_id,task.id))
      )
  )
);
CREATE POLICY activity_task_attachment_create ON activity_task_attachments FOR INSERT WITH CHECK (
  workspace_id=crm_workspace() AND EXISTS (
    SELECT 1 FROM activity_tasks task
    WHERE task.workspace_id=activity_task_attachments.workspace_id AND task.id=activity_task_attachments.task_id
      AND task.task_only AND task.status='completed' AND task.revoked_at IS NULL AND task.assignee_id=crm_actor()
      AND crm_activity_collaboration_current(task.workspace_id,task.id)
  )
);
