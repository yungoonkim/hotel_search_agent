import pg from 'pg';
import { hash,HotelSchema,type Hotel,type Attributes } from './model.js';
import { ReadRepository,prepareUpsert,type DataRepository,type Job } from './repository.js';
import { RagChunkSchema,type RagChunk } from './contracts.js';
type Connection=Pick<pg.PoolClient,'query'>;
async function load(db:Connection):Promise<Hotel[]> {
 const hs=await db.query('SELECT * FROM hotels');
 const rs=await db.query('SELECT * FROM rooms');
 const hids=await db.query('SELECT * FROM hotel_source_ids');
 const rids=await db.query('SELECT * FROM room_source_ids');
 return hs.rows.map(h=>HotelSchema.parse({hotelId:h.hotel_id,attributes:h.attributes,reviewCandidates:h.review_candidates,sources:hids.rows.filter(s=>s.hotel_id===h.hotel_id).map(s=>({source:s.source,id:s.external_id})),rooms:rs.rows.filter(r=>r.hotel_id===h.hotel_id).map(r=>({roomId:r.room_id,hotelId:r.hotel_id,attributes:r.attributes,sources:rids.rows.filter(s=>s.room_id===r.room_id).map(s=>({source:s.source,id:s.external_id}))}))}));
}
export class PostgresRepository extends ReadRepository implements DataRepository {
 constructor(public pool:pg.Pool){super();}
 async listHotels(){return load(this.pool);}
 async upsert(input:Hotel){
 const db=await this.pool.connect();
 try{await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(7331021)");
 const result=prepareUpsert(structuredClone(input),await load(db)),h=result.hotel;
 const v=(a:Attributes,k:keyof Attributes)=>a[k]?.value??null;
 await db.query(`INSERT INTO hotels(hotel_id,name,name_en,address,latitude,longitude,hotel_type,description,attributes,review_candidates) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(hotel_id) DO UPDATE SET name=excluded.name,name_en=excluded.name_en,address=excluded.address,latitude=excluded.latitude,longitude=excluded.longitude,hotel_type=excluded.hotel_type,description=excluded.description,attributes=excluded.attributes,review_candidates=excluded.review_candidates,updated_at=now()`,[h.hotelId,...(['name','nameEn','address','latitude','longitude','hotelType','description'] as const).map(k=>v(h.attributes,k)),JSON.stringify(h.attributes),JSON.stringify(h.reviewCandidates)]);
 for(const s of h.sources)await db.query('INSERT INTO hotel_source_ids(source,external_id,hotel_id) VALUES($1,$2,$3) ON CONFLICT(source,external_id) DO NOTHING',[s.source,s.id,h.hotelId]);
 for(const r of h.rooms){
 await db.query(`INSERT INTO rooms(room_id,hotel_id,room_name,room_size,base_occupancy,max_occupancy,view_type,shower,bathtub,attributes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(room_id) DO UPDATE SET room_name=excluded.room_name,room_size=excluded.room_size,base_occupancy=excluded.base_occupancy,max_occupancy=excluded.max_occupancy,view_type=excluded.view_type,shower=excluded.shower,bathtub=excluded.bathtub,attributes=excluded.attributes,updated_at=now()`,[r.roomId,h.hotelId,...(['roomName','roomSize','baseOccupancy','maxOccupancy','view','shower','bathtub'] as const).map(k=>v(r.attributes,k)),JSON.stringify(r.attributes)]);
 for(const s of r.sources)await db.query('INSERT INTO room_source_ids(source,external_id,room_id,hotel_id) VALUES($1,$2,$3,$4) ON CONFLICT(source,external_id) DO NOTHING',[s.source,s.id,r.roomId,h.hotelId]);
 const beds=v(r.attributes,'beds');if(Array.isArray(beds))for(const b of beds as {type:string;count:number}[])await db.query('INSERT INTO room_beds(room_id,bed_type,count) VALUES($1,$2,$3) ON CONFLICT(room_id,bed_type) DO UPDATE SET count=excluded.count',[r.roomId,b.type,b.count]);
 }
 for(const key of ['parking','breakfast','pool','gym','sauna','businessCenter'] as const){const a=h.attributes[key];await db.query('INSERT INTO hotel_amenities(hotel_id,amenity,value,status) VALUES($1,$2,$3,$4) ON CONFLICT(hotel_id,amenity) DO UPDATE SET value=excluded.value,status=excluded.status',[h.hotelId,key,a?.value??null,a?.status??'missing']);}
 for(const entity of [{roomId:null as string|null,attributes:h.attributes},...h.rooms])for(const [key,a] of Object.entries(entity.attributes))for(const e of a.evidence){
 const evidenceId=hash(JSON.stringify([h.hotelId,entity.roomId,key,e]));
 await db.query('INSERT INTO attribute_evidence(evidence_id,hotel_id,room_id,attribute,value,status,source,record_id,source_url,collected_at,evidence_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(evidence_id) DO NOTHING',[evidenceId,h.hotelId,entity.roomId,key,JSON.stringify(e.observedValue??a.value),e.verified?'verified':'unverified',e.source,e.recordId,e.url,e.collectedAt,e.quote]);
 }
 await db.query('COMMIT');return result;
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 async getRagChunks(ids:string[]){if(!ids.length)return [];const r=await this.pool.query('SELECT * FROM rag_chunks WHERE hotel_id=ANY($1::uuid[])',[ids]);return r.rows.map(c=>RagChunkSchema.parse({chunkId:c.chunk_id,hotelId:c.hotel_id,roomId:c.room_id,context:c.context,contextHash:c.context_hash,metadata:c.metadata,model:c.embedding_model,version:c.embedding_version,dimensions:c.dimensions,embedding:c.embedding}));}
 async saveChunk(c:RagChunk){RagChunkSchema.parse(c);await this.pool.query(`INSERT INTO rag_chunks(chunk_id,hotel_id,room_id,context,context_hash,metadata,embedding_model,embedding_version,dimensions,embedding) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(chunk_id) DO UPDATE SET context=excluded.context,context_hash=excluded.context_hash,metadata=excluded.metadata,embedding_model=excluded.embedding_model,embedding_version=excluded.embedding_version,dimensions=excluded.dimensions,embedding=excluded.embedding,updated_at=now()`,[c.chunkId,c.hotelId,c.roomId,c.context,c.contextHash,JSON.stringify(c.metadata),c.model,c.version,c.dimensions,c.embedding]);}
 async saveJob(j:Job){await this.pool.query(`INSERT INTO collection_jobs(job_id,source,status,started_at,finished_at,records_collected,error_message,report) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,finished_at=excluded.finished_at,records_collected=excluded.records_collected,error_message=excluded.error_message,report=excluded.report`,[j.jobId,j.source,j.status,j.startedAt,j.finishedAt,j.recordsCollected,j.errorMessage,JSON.stringify(j.report)]);}
}
