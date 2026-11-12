import 'dotenv/config';
import pg from 'pg';
import { mkdir,writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { FixtureCollector,TourApiCollector } from './collector.js';
import { MemoryRepository } from './repository.js';
import { PostgresRepository } from './postgres.js';
import { makeFixtures } from './fixtures.js';
import { MockEmbeddingProvider } from './rag.js';
import { runCollection } from './pipeline.js';
import { exportToCsv } from './export.js';
const mode=z.enum(['fixture','live']).parse(process.argv[2]??'fixture');
const limit=z.coerce.number().int().min(1).max(1000).parse(process.env.COLLECTION_LIMIT??30);
if(mode==='live'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL_MISSING');
if(mode==='live'&&!process.env.TOUR_API_KEY)throw new Error('TOUR_API_KEY_MISSING');
const pool=process.env.DATABASE_URL?new pg.Pool({connectionString:process.env.DATABASE_URL}):null;
try{
 const repo=pool?new PostgresRepository(pool):new MemoryRepository();
 const collector=mode==='fixture'?new FixtureCollector(makeFixtures(limit)):new TourApiCollector(process.env.TOUR_API_KEY,{baseUrl:process.env.TOUR_API_BASE_URL,region:process.env.TOUR_API_REGION_CODE??'26',city:process.env.TOUR_API_CITY??'부산',delayMs:z.coerce.number().nonnegative().parse(process.env.TOUR_API_DELAY_MS??300),budget:z.coerce.number().int().positive().parse(process.env.TOUR_API_REQUEST_BUDGET??200),archiveDir:'data/raw/tourapi'});
 const result=await runCollection({collector,repo,embedding:new MockEmbeddingProvider(),limit,source:mode==='fixture'?'fixture':'tourapi'});
 await mkdir('reports',{recursive:true});await writeFile('reports/latest.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify({event:'report_written',path:'reports/latest.json',mode,storage:pool?'postgresql':'memory',report:result.report}));
 if(pool&&process.env.AUTO_EXPORT_CSV!=='false'){
  const exported=await exportToCsv(pool);
  console.log(JSON.stringify({event:'csv_auto_exported',outputDir:exported.outputDir,counts:{hotels:exported.hotels,rooms:exported.rooms,amenities:exported.hotelAmenities}}));
 }
 if(result.status!=='completed')process.exitCode=1;
}finally{await pool?.end();}
