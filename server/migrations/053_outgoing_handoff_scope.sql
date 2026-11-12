ALTER TABLE activity_tasks
  ADD CONSTRAINT activity_tasks_customer_identity UNIQUE (workspace_id, customer_id, id);

ALTER TABLE outgoing_mail
  ADD COLUMN handoff_task_id uuid,
  ADD CONSTRAINT outgoing_handoff_task_fk
    FOREIGN KEY (workspace_id, customer_id, handoff_task_id)
    REFERENCES activity_tasks(workspace_id, customer_id, id);

CREATE FUNCTION crm_outgoing_handoff_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.handoff_task_id IS DISTINCT FROM OLD.handoff_task_id
      OR (OLD.handoff_task_id IS NOT NULL AND NEW.project_id IS DISTINCT FROM OLD.project_id)
    THEN
      RAISE EXCEPTION 'outgoing handoff scope is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.handoff_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM activity_tasks task
    WHERE task.workspace_id = NEW.workspace_id AND task.customer_id = NEW.customer_id
      AND task.id = NEW.handoff_task_id AND task.project_id IS NOT DISTINCT FROM NEW.project_id
      AND task.task_only AND task.revoked_at IS NULL AND task.status = 'completed'
  ) THEN
    RAISE EXCEPTION 'outgoing handoff scope does not match the completed task' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER outgoing_handoff_scope BEFORE INSERT OR UPDATE ON outgoing_mail
  FOR EACH ROW EXECUTE FUNCTION crm_outgoing_handoff_scope();
