CREATE TABLE IF NOT EXISTS hotels (
 hotel_id uuid PRIMARY KEY, name text, name_en text, address text, latitude double precision CHECK(latitude BETWEEN -90 AND 90), longitude double precision CHECK(longitude BETWEEN -180 AND 180), hotel_type text, description text, attributes jsonb NOT NULL, review_candidates jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rooms (
 room_id uuid PRIMARY KEY, hotel_id uuid NOT NULL REFERENCES hotels(hotel_id), room_name text, room_size numeric CHECK(room_size>0), base_occupancy int CHECK(base_occupancy>0), max_occupancy int CHECK(max_occupancy>0), view_type text, shower boolean, bathtub boolean, attributes jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(room_id,hotel_id), CHECK(base_occupancy<=max_occupancy)
);
CREATE TABLE IF NOT EXISTS room_beds (room_id uuid NOT NULL REFERENCES rooms(room_id), bed_type text NOT NULL, count int NOT NULL CHECK(count>0), PRIMARY KEY(room_id,bed_type));
CREATE TABLE IF NOT EXISTS hotel_amenities (hotel_id uuid NOT NULL REFERENCES hotels(hotel_id), amenity text NOT NULL, value boolean, status text NOT NULL CHECK(status IN ('verified','unverified','missing','conflicting','stale')), PRIMARY KEY(hotel_id,amenity));
CREATE TABLE IF NOT EXISTS hotel_source_ids (source text NOT NULL, external_id text NOT NULL, hotel_id uuid NOT NULL REFERENCES hotels(hotel_id), PRIMARY KEY(source,external_id));
CREATE TABLE IF NOT EXISTS room_source_ids (source text NOT NULL, external_id text NOT NULL, room_id uuid NOT NULL REFERENCES rooms(room_id), hotel_id uuid NOT NULL, FOREIGN KEY(room_id,hotel_id) REFERENCES rooms(room_id,hotel_id), PRIMARY KEY(source,external_id));
CREATE TABLE IF NOT EXISTS attribute_evidence (
 evidence_id text PRIMARY KEY, hotel_id uuid NOT NULL REFERENCES hotels(hotel_id), room_id uuid, attribute text NOT NULL, value jsonb, status text NOT NULL CHECK(status IN ('verified','unverified','missing','conflicting','stale')), source text NOT NULL, record_id text NOT NULL, source_url text, collected_at timestamptz NOT NULL, evidence_text text NOT NULL, FOREIGN KEY(room_id,hotel_id) REFERENCES rooms(room_id,hotel_id)
);
CREATE TABLE IF NOT EXISTS collection_jobs (job_id uuid PRIMARY KEY, source text NOT NULL, target_hotel_id uuid REFERENCES hotels(hotel_id), status text NOT NULL CHECK(status IN ('running','completed','partial','failed')), started_at timestamptz NOT NULL, finished_at timestamptz, records_collected int NOT NULL DEFAULT 0, error_message text, report jsonb);
CREATE TABLE IF NOT EXISTS rag_chunks (chunk_id uuid PRIMARY KEY, hotel_id uuid NOT NULL REFERENCES hotels(hotel_id), room_id uuid, context text NOT NULL, context_hash text NOT NULL, metadata jsonb NOT NULL, embedding_model text NOT NULL, embedding_version text NOT NULL, dimensions int NOT NULL CHECK(dimensions>0), embedding double precision[] NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(room_id,hotel_id) REFERENCES rooms(room_id,hotel_id), CHECK(array_length(embedding,1)=dimensions));
CREATE INDEX IF NOT EXISTS rooms_hotel_idx ON rooms(hotel_id);
CREATE INDEX IF NOT EXISTS rag_metadata_idx ON rag_chunks USING gin(metadata);
CREATE INDEX IF NOT EXISTS evidence_entity_idx ON attribute_evidence(hotel_id,room_id,attribute);
