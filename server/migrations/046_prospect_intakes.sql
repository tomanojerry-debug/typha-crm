-- AI intake candidates are private preparation, never a new source of customer evidence.
CREATE TABLE prospect_intakes (
 workspace_id uuid NOT NULL,id uuid NOT NULL,actor_id uuid NOT NULL,customer_id uuid NOT NULL,
 request_id uuid NOT NULL,input_hash text NOT NULL,claim_token uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('generating','ready','accepted')),
 source_refs jsonb NOT NULL CHECK(jsonb_typeof(source_refs)='array'),
 candidate jsonb,version integer NOT NULL DEFAULT 1,
 accepted_request_id uuid,accepted_hash text,prospect_id uuid,
 lease_until timestamptz NOT NULL DEFAULT now()+interval '3 minutes',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,id),UNIQUE(workspace_id,actor_id,request_id),
 FOREIGN KEY(workspace_id,actor_id) REFERENCES memberships(workspace_id,actor_id),
 FOREIGN KEY(workspace_id,customer_id) REFERENCES customers(workspace_id,id),
 FOREIGN KEY(workspace_id,customer_id,prospect_id) REFERENCES projects(workspace_id,customer_id,id),
 CHECK((state='generating' AND candidate IS NULL) OR (state IN ('ready','accepted') AND candidate IS NOT NULL)),
 CHECK((state='accepted')=(prospect_id IS NOT NULL))
);
ALTER TABLE prospect_intakes ENABLE ROW LEVEL SECURITY;
CREATE POLICY prospect_intakes_private ON prospect_intakes
 USING(workspace_id=crm_workspace() AND actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true)
 AND EXISTS(SELECT 1 FROM customers c WHERE c.workspace_id=prospect_intakes.workspace_id AND c.id=customer_id AND c.archived_at IS NULL))
 WITH CHECK(workspace_id=crm_workspace() AND actor_id=crm_actor() AND crm_access(workspace_id,customer_id,true));
GRANT SELECT,INSERT,UPDATE,DELETE ON prospect_intakes TO light_crm_app;
CREATE INDEX prospect_intakes_actor_recent ON prospect_intakes(workspace_id,actor_id,updated_at DESC,id);
