-- A Record is the canonical evidence identity. Email bodies stay in mail_messages;
-- approved WeChat excerpts stay attached to their reviewed Record.
ALTER TABLE customer_records ADD COLUMN source_kind text NOT NULL DEFAULT 'manual'
 CHECK(source_kind IN ('manual','email','wechat'));
ALTER TABLE customer_records ADD COLUMN source_mail_id uuid;
ALTER TABLE customer_records ADD COLUMN occurred_at timestamptz;
UPDATE customer_records SET occurred_at=created_at;
ALTER TABLE customer_records ALTER COLUMN occurred_at SET NOT NULL;
ALTER TABLE customer_records ALTER COLUMN occurred_at SET DEFAULT now();
ALTER TABLE customer_records ADD UNIQUE(workspace_id,source_mail_id);
ALTER TABLE customer_records ADD FOREIGN KEY(workspace_id,customer_id,source_mail_id)
 REFERENCES mail_messages(workspace_id,customer_id,id);
ALTER TABLE customer_records ADD CHECK((source_kind='email')=(source_mail_id IS NOT NULL));
CREATE POLICY record_mail_visible ON customer_records AS RESTRICTIVE FOR SELECT USING(
 source_mail_id IS NULL OR EXISTS(SELECT 1 FROM mail_messages m WHERE m.workspace_id=customer_records.workspace_id AND m.id=source_mail_id)
);

CREATE FUNCTION crm_capture_mail_record() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.customer_id IS NULL OR crm_actor() IS NULL OR NEW.workspace_id IS DISTINCT FROM crm_workspace() THEN RETURN NULL; END IF;
 INSERT INTO customer_records(workspace_id,customer_id,project_id,id,kind,body,created_by,source_kind,source_mail_id,occurred_at)
 VALUES(NEW.workspace_id,NEW.customer_id,NEW.project_id,gen_random_uuid(),'customer_quote',
  '邮件来源记录：'||left(NEW.subject,500)||E'\n完整原文保存在关联邮件中；沟通内容不代表公司正式确认。',crm_actor(),'email',NEW.id,NEW.occurred_at)
 ON CONFLICT(workspace_id,source_mail_id) DO UPDATE SET project_id=EXCLUDED.project_id,occurred_at=EXCLUDED.occurred_at,body=EXCLUDED.body;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION crm_capture_mail_record() FROM PUBLIC;
CREATE TRIGGER record_from_mail AFTER INSERT OR UPDATE ON mail_messages FOR EACH ROW EXECUTE FUNCTION crm_capture_mail_record();
