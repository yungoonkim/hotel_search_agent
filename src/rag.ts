import { hash,stableId,type Hotel,type Attributes } from './model.js';
import { effectiveStatus } from './quality.js';
import { RagChunkSchema,type RagChunk } from './contracts.js';
import type { DataRepository } from './repository.js';
export interface EmbeddingProvider {model:string;version:string;dimensions:number;embed(context:string):Promise<number[]>;}
/** Deterministic test vectors; no semantic retrieval quality. */
export class MockEmbeddingProvider implements EmbeddingProvider {
 model='mock-hash';version='1';dimensions=8;calls=0;
 async embed(context:string){this.calls++;return Array.from({length:this.dimensions},(_,i)=>parseInt(hash(context).slice(i*2,i*2+2),16)/255);}
}
export const normalizeContext=(text:string)=>text.normalize('NFKC').replace(/\s+/g,' ').trim();
export function buildDocuments(h:Hotel,now=new Date()) {
 const build=(a:Attributes)=>normalizeContext(Object.entries(a).filter(([,v])=>effectiveStatus(v,now)==='verified').sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}: ${JSON.stringify(v.value)}`).join('. '));
 const entityDocs=[{roomId:null as string|null,attributes:h.attributes},...h.rooms.map(r=>({roomId:r.roomId,attributes:r.attributes}))];
 return entityDocs.map(e=>{
 const valid=Object.fromEntries(Object.entries(e.attributes).filter(([,v])=>effectiveStatus(v,now)==='verified'));
 const times=Object.values(valid).flatMap(a=>a.evidence.filter(e=>e.verified).map(e=>e.collectedAt)).sort();
 return {chunkId:stableId(`chunk:${h.hotelId}:${e.roomId??'hotel'}:description`),hotelId:h.hotelId,roomId:e.roomId,context:build(e.attributes),metadata:{hotel_id:h.hotelId,room_id:e.roomId,chunk_type:e.roomId?'room_description':'hotel_description',city:effectiveStatus(h.attributes.city,now)==='verified'?h.attributes.city?.value:null,attributes:Object.fromEntries(Object.entries(valid).map(([k,v])=>[k,v.value])),sources:[...new Set(Object.values(valid).flatMap(v=>v.evidence.map(e=>e.source)))],verified_at:times.at(-1)??null,evidence:Object.fromEntries(Object.entries(valid).map(([k,v])=>[k,v.evidence]))}};
 });
}
export async function indexHotel(h:Hotel,repo:DataRepository,provider:EmbeddingProvider,now=new Date()) {
 let generated=0,failures=0;const existing=await repo.getRagChunks([h.hotelId]);
 for(const doc of buildDocuments(h,now)){
 const contextHash=hash(doc.context),old=existing.find(c=>c.chunkId===doc.chunkId);
 const compatible=(c:RagChunk)=>c.contextHash===contextHash&&c.model===provider.model&&c.version===provider.version&&c.dimensions===provider.dimensions;
 const cached=existing.find(compatible);
 try{
 // An empty verified context has no searchable meaning; retain a zero vector with no API call.
 const embedding=cached?.embedding??(doc.context?await provider.embed(doc.context):Array(provider.dimensions).fill(0) as number[]);
 const chunk=RagChunkSchema.parse({...doc,contextHash,model:provider.model,version:provider.version,dimensions:provider.dimensions,embedding});
 await repo.saveChunk(chunk);if(!cached&&doc.context)generated++;
 }catch{failures++;
 // Changed facts must never retain a searchable old document when embedding fails.
 if(old&&old.contextHash!==contextHash)await repo.saveChunk({...old,context:'',contextHash:hash(''),embedding:Array(old.dimensions).fill(0) as number[],metadata:{...doc.metadata,index_error:true}});
 }
 }return {generated,failures};
}
