import { type Hotel,HotelSchema,mergeHotel,type Field } from './model.js';
import { duplicateDecision } from './normalize.js';
import { effectiveStatus } from './quality.js';
import { HotelSearchFiltersSchema,type HotelSearchRepository,type HotelSearchFilters,type RagChunk } from './contracts.js';
export interface Job {jobId:string;source:string;status:'running'|'completed'|'partial'|'failed';startedAt:string;finishedAt:string|null;recordsCollected:number;errorMessage:string|null;report:unknown;}
export interface DataRepository extends HotelSearchRepository {
 listHotels():Promise<Hotel[]>;
 upsert(h:Hotel):Promise<{hotel:Hotel;duplicate:boolean}>;
 saveChunk(c:RagChunk):Promise<void>;
 saveJob(j:Job):Promise<void>;
}
function validateOwnership(h:Hotel,all:Hotel[]){
 for(const r of h.rooms)for(const old of all.flatMap(x=>x.rooms)){
 if(r.roomId===old.roomId&&r.hotelId!==old.hotelId)throw new Error('ROOM_OWNERSHIP_CONFLICT');
 if(r.sources.some(s=>old.sources.some(t=>s.source===t.source&&s.id===t.id))&&r.roomId!==old.roomId)throw new Error('ROOM_SOURCE_ID_CONFLICT');
 }return h;
}
export function prepareUpsert(h:Hotel,all:Hotel[]){
 HotelSchema.parse(h);let duplicate=false;
 for(const candidate of all){const decision=duplicateDecision(candidate,h);
 if(decision==='same'){
 duplicate=true;
 // Cross-source room names never constitute identity; preserve each external room ID.
 h={...h,hotelId:candidate.hotelId,rooms:h.rooms.map(r=>({...r,hotelId:candidate.hotelId}))};
 return {hotel:validateOwnership(mergeHotel(candidate,h),all),duplicate};
 } if(decision==='review')h.reviewCandidates=[...new Set([...h.reviewCandidates,candidate.hotelId])];
 }return {hotel:validateOwnership(h,all),duplicate};
}
export abstract class ReadRepository implements HotelSearchRepository {
 abstract listHotels():Promise<Hotel[]>;
 abstract getRagChunks(ids:string[]):Promise<RagChunk[]>;
 async getHotelDetails(id:string){return (await this.listHotels()).find(h=>h.hotelId===id)??null;}
 async getRooms(id:string){return (await this.getHotelDetails(id))?.rooms??[];}
 async findHotelsByFilters(input:HotelSearchFilters){const f=HotelSearchFiltersSchema.parse(input),result=[];
 for(const h of await this.listHotels()){
 const verified=(a:Hotel['attributes'],key:Field,v:unknown)=>effectiveStatus(a[key])==='verified'&&a[key]?.value===v;
 if((['city','parking','breakfast','pool','gym','sauna','businessCenter'] as const).some(k=>f[k]!==undefined&&!verified(h.attributes,k,f[k])))continue;
 const roomFilter=f.bathtub!==undefined||f.shower!==undefined||f.view!==undefined||f.beds!==undefined||f.minOccupancy!==undefined;
 const rooms=h.rooms.filter(r=>{
 if((['bathtub','shower','view'] as const).some(k=>f[k]!==undefined&&!verified(r.attributes,k,f[k])))return false;
 if(f.minOccupancy!==undefined&&(effectiveStatus(r.attributes.maxOccupancy)!=='verified'||Number(r.attributes.maxOccupancy?.value)<f.minOccupancy))return false;
 if(f.beds){const a=r.attributes.beds;if(effectiveStatus(a)!=='verified'||!Array.isArray(a?.value))return false;for(const b of f.beds)if(!a.value.some((v:{type:string;count:number})=>v.type===b.type&&v.count>=b.count))return false;}return true;
 });
 if(!roomFilter||rooms.length)result.push({hotelId:h.hotelId,roomIds:rooms.map(r=>r.roomId)});
 }return result;
 }
}
export class MemoryRepository extends ReadRepository implements DataRepository {
 hotels=new Map<string,Hotel>();chunks=new Map<string,RagChunk>();jobs=new Map<string,Job>();
 async listHotels(){return structuredClone([...this.hotels.values()]);}
 async upsert(h:Hotel){const result=prepareUpsert(structuredClone(h),await this.listHotels());this.hotels.set(result.hotel.hotelId,structuredClone(result.hotel));return result;}
 async getRagChunks(ids:string[]){return structuredClone([...this.chunks.values()].filter(c=>ids.includes(c.hotelId)));}
 async saveChunk(c:RagChunk){this.chunks.set(c.chunkId,structuredClone(c));}
 async saveJob(j:Job){this.jobs.set(j.jobId,structuredClone(j));}
}
