import 'dotenv/config';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { hash } from './model.js';
export async function migrate(pool:pg.Pool,vector=true){const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(7331022)');await c.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
 for(const file of ['001_core.sql',...(vector?['002_vector.sql']:[])]){const sql=await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'),checksum=hash(sql);const found=await c.query('SELECT checksum FROM schema_migrations WHERE name=$1',[file]);if(found.rowCount){if(found.rows[0].checksum!==checksum)throw new Error('MIGRATION_CHECKSUM_MISMATCH');continue;}await c.query(sql);await c.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[file,checksum]);}await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL_MISSING');const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});try{await migrate(pool);console.log(JSON.stringify({event:'migration_completed'}));}finally{await pool.end();}}
