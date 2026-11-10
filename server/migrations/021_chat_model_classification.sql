ALTER TABLE chat_messages
  ADD COLUMN model_classification jsonb,
  ADD COLUMN model_customer_id uuid,
  ADD COLUMN model_person_id uuid,
  ADD COLUMN model_project_id uuid,
  ADD CONSTRAINT chat_model_customer FOREIGN KEY (workspace_id,model_customer_id)
    REFERENCES customers(workspace_id,id),
  ADD CONSTRAINT chat_model_person FOREIGN KEY (workspace_id,model_customer_id,model_person_id)
    REFERENCES people(workspace_id,customer_id,id),
  ADD CONSTRAINT chat_model_project FOREIGN KEY (workspace_id,model_customer_id,model_project_id)
    REFERENCES projects(workspace_id,customer_id,id),
  ADD CONSTRAINT chat_model_scope CHECK (
    (model_person_id IS NULL OR model_customer_id IS NOT NULL)
    AND (model_project_id IS NULL OR model_customer_id IS NOT NULL)
    AND NOT (model_person_id IS NOT NULL AND model_project_id IS NOT NULL)
  ),
  ADD CONSTRAINT chat_model_classification_object CHECK (
    model_classification IS NULL OR jsonb_typeof(model_classification)='object'
  );

-- A private unbound chat can contain successive turns about different customers.
-- Apply current customer access to each persisted model turn as well as its chat.
DROP POLICY message_scope ON chat_messages;
CREATE POLICY message_scope ON chat_messages FOR ALL
  USING (
    EXISTS (SELECT 1 FROM agent_chats c WHERE c.workspace_id=chat_messages.workspace_id AND c.id=chat_messages.chat_id)
    AND (model_customer_id IS NULL OR crm_access(workspace_id,model_customer_id))
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(model_basis) s
      WHERE NOT coalesce(crm_access(workspace_id,(s->>'customer_id')::uuid),false))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM agent_chats c
      WHERE c.workspace_id=chat_messages.workspace_id AND c.id=chat_messages.chat_id
        AND (c.customer_id IS NULL OR model_customer_id IS NULL OR c.customer_id=model_customer_id))
    AND (model_customer_id IS NULL OR crm_access(workspace_id,model_customer_id))
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(model_basis) s
      WHERE NOT coalesce(crm_access(workspace_id,(s->>'customer_id')::uuid),false))
  );
