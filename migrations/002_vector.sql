CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS embedding_vector vector;
UPDATE rag_chunks SET embedding_vector=embedding::vector WHERE embedding_vector IS NULL;
-- Vector dimensions intentionally unbounded: build a model/dimension-specific partial
-- expression index when the real embedding provider is selected. Never compare models.
CREATE OR REPLACE FUNCTION sync_rag_vector() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.embedding_vector := NEW.embedding::vector; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS rag_vector_sync ON rag_chunks;
CREATE TRIGGER rag_vector_sync BEFORE INSERT OR UPDATE ON rag_chunks FOR EACH ROW EXECUTE FUNCTION sync_rag_vector();
