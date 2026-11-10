ALTER TABLE chat_messages ADD COLUMN customer_lookup_kind text
  CHECK (customer_lookup_kind IS NULL OR customer_lookup_kind IN ('email','name'));
ALTER TABLE chat_messages DROP CONSTRAINT chat_messages_customer_lookup_query_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_customer_lookup_query_check
  CHECK (customer_lookup_query IS NULL OR length(customer_lookup_query) BETWEEN 2 AND 254);
