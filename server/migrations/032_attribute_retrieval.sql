-- Private fixed search plan; apply revalidates this plan and never reruns model/search.
ALTER TABLE customer_attribute_runs ADD COLUMN retrieval_plan jsonb;
