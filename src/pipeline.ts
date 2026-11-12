import { randomUUID } from 'node:crypto';
import type { Collector } from './collector.js';
import { normalize } from './normalize.js';
import { analyze,qualityReport } from './quality.js';
import { enrichHotel,UnavailableBrowser,type BrowserTool,type AllowedSource } from './browser.js';
import { indexHotel,type EmbeddingProvider } from './rag.js';
import type { DataRepository,Job } from './repository.js';
export async function runCollection(options:{collector:Collector;repo:DataRepository;embedding:EmbeddingProvider;limit?:number;source:string;browser?:BrowserTool;allowedSources?:AllowedSource[];candidateUrls?:(hotelId:string)=>string[];now?:Date;log?:(event:unknown)=>void}) {
 const {repo}=options,now=options.now??new Date(),log=options.log??((e:unknown)=>console.log(JSON.stringify(e)));
 const job:Job={jobId:randomUUID(),source:options.source,status:'running',startedAt:now.toISOString(),finishedAt:null,recordsCollected:0,errorMessage:null,report:null};
 await repo.saveJob(job);log({event:'collection_started',jobId:job.jobId});
 let duplicates=0,failures=0,embeddings=0;const pending:unknown[]=[],touched=new Set<string>();
 try{
 const result=await options.collector.collect(options.limit??30);failures+=result.failures;
 const allExisting=await repo.listHotels();
 for(const raw of result.records){try{
  const contentId=String(raw.common?.contentid??'');
  const existingHotel=allExisting.find(h=>h.sources.some(s=>s.source===options.source&&s.id===contentId));
  const normalized=normalize(raw,{existingRooms:existingHotel?.rooms});
  const saved=await repo.upsert(normalized);if(saved.duplicate)duplicates++;touched.add(saved.hotel.hotelId);job.recordsCollected++;
 }catch{failures++;log({event:'record_failed',jobId:job.jobId,code:'NORMALIZATION_OR_PERSISTENCE_FAILED'});}}
 for(const id of touched){let h=await repo.getHotelDetails(id);if(!h)continue;
 const enriched=await enrichHotel(h,analyze(h,now),options.browser??new UnavailableBrowser(),options.allowedSources??[],options.candidateUrls?.(id)??[],now);
 pending.push(...enriched.pending.map(p=>({hotelId:id,...p})));h=(await repo.upsert(enriched.hotel)).hotel;
 const indexed=await indexHotel(h,repo,options.embedding,now);embeddings+=indexed.generated;failures+=indexed.failures;
 }
 const all=await repo.listHotels(),chunks=await repo.getRagChunks(all.map(h=>h.hotelId));
 job.report={...qualityReport(all,{duplicates,failures,chunks:chunks.length,embeddings},now),pending,gaps:all.flatMap(h=>analyze(h,now)),fixture:options.source==='fixture'};job.status=failures?'partial':'completed';
 }catch{job.status='failed';job.errorMessage='COLLECTION_FAILED: inspect credentials, source availability and database';failures++;job.report={failures,pending};}
 job.finishedAt=new Date().toISOString();await repo.saveJob(job);log({event:'collection_finished',jobId:job.jobId,status:job.status,recordsCollected:job.recordsCollected,failures});return job;
}
