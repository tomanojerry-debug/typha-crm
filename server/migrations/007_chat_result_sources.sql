ALTER TABLE chat_messages ADD COLUMN action text CHECK(action IN ('message','overview','activity','web_research'));
