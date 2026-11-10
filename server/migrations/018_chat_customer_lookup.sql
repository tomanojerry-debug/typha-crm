-- Persist only the private search term; results are recomputed under current RLS.
ALTER TABLE chat_messages ADD COLUMN customer_lookup_query text
  CHECK (customer_lookup_query IS NULL OR length(customer_lookup_query) BETWEEN 3 AND 254);
