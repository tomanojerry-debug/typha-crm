-- Keep the authoritative candidate order separately from model-selected citations.
-- Existing message RLS checks every customer in model_basis for this turn.
ALTER TABLE chat_messages ADD COLUMN model_retrieval jsonb,
  ADD CONSTRAINT chat_model_retrieval_object CHECK (
    model_retrieval IS NULL OR jsonb_typeof(model_retrieval)='object'
  );
