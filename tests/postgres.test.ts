import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { migrate } from '../src/migrate.js';
import { PostgresRepository } from '../src/postgres.js';
import { normalize } from '../src/normalize.js';
import { makeFixtures } from '../src/fixtures.js';
import { attr } from '../src/model.js';
import { MockEmbeddingProvider,indexHotel } from '../src/rag.js';

it('SQL core schema applies in embedded PostgreSQL and foreign keys protect orphan rooms',async()=>{
 const db=new PGlite();try{await db.exec(await readFile(new URL('../migrations/001_core.sql',import.meta.url),'utf8'));await expect(db.query('INSERT INTO rooms(room_id,hotel_id,attributes) VALUES($1,$2,$3)',[randomUUID(),randomUUID(),'{}'])).rejects.toThrow();}finally{await db.close();}
});
describe.skipIf(!process.env.TEST_DATABASE_URL)('real PostgreSQL + pgvector (isolated schema)',()=>{
 const schema='hotel_test_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
 const repo=new PostgresRepository(pool);
 beforeAll(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await migrate(pool);},30000);
 afterAll(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 it('upsert, evidence history, vector sync, room relationship and repeated embedding',async()=>{
 const h=normalize(makeFixtures(2)[1]!);await repo.upsert(h);await repo.upsert(h);
 expect(await repo.listHotels()).toHaveLength(1);expect(await repo.getRooms(h.hotelId)).toHaveLength(2);
 const count=await pool.query('SELECT count(*)::int n FROM attribute_evidence');expect(count.rows[0].n).toBeGreaterThan(0);
 const p=new MockEmbeddingProvider();await indexHotel(h,repo,p);await indexHotel(h,repo,p);expect(p.calls).toBe(3);
 const result=await pool.query('SELECT vector_dims(embedding_vector) d FROM rag_chunks');expect(result.rows).toHaveLength(3);expect(result.rows.every(r=>r.d===8)).toBe(true);
 await expect(pool.query('INSERT INTO rooms(room_id,hotel_id,attributes) VALUES($1,$2,$3)',[randomUUID(),randomUUID(),'{}'])).rejects.toThrow();
 const bad=structuredClone(h);bad.rooms[0]!.attributes.maxOccupancy=attr(1,bad.rooms[0]!.attributes.maxOccupancy!.evidence[0]!);await expect(repo.upsert(bad)).rejects.toThrow();expect(await repo.getRooms(h.hotelId)).toHaveLength(2);
 const changed=structuredClone(h);changed.attributes.parking=attr(false,{...h.attributes.parking!.evidence[0]!,source:'other',quote:'no parking'});await repo.upsert(changed);expect((await repo.getHotelDetails(h.hotelId))?.attributes.parking?.status).toBe('conflicting');
 expect((await pool.query('SELECT count(*)::int n FROM attribute_evidence')).rows[0].n).toBeGreaterThan(count.rows[0].n);
 });
 it('parallel upserts serialize and maintain source uniqueness',async()=>{const h=normalize(makeFixtures(3)[2]!);await Promise.all([repo.upsert(h),repo.upsert(h)]);expect((await pool.query('SELECT count(*)::int n FROM hotel_source_ids WHERE external_id=$1',[h.sources[0]!.id])).rows[0].n).toBe(1);});
});
