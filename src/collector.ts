import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PublicRecord,Raw } from './normalize.js';
const RowSchema=z.record(z.unknown());
const Envelope=z.object({response:z.object({header:z.object({resultCode:z.union([z.string(),z.number()]),resultMsg:z.string().optional()}),body:z.object({items:z.union([z.literal(''),z.object({item:z.union([z.array(RowSchema),RowSchema]).optional()})]).optional(),totalCount:z.coerce.number().optional()}).optional()})});
export function parseResponse(input:unknown):{rows:Raw[];total:number} {
 const {response:r}=Envelope.parse(input);
 if(!['0000','00','0'].includes(String(r.header.resultCode)))throw new Error(`TOUR_API_ERROR:${r.header.resultCode}`);
 const item=r.body?.items&&r.body.items.item;
 const rows=item?Array.isArray(item)?item:[item]:[];
 return {rows,total:r.body?.totalCount??rows.length};
}
export interface Collector {collect(limit:number):Promise<{records:PublicRecord[];failures:number}>;}
export class TourApiCollector implements Collector {
 private requests=0;
 constructor(private key:string|undefined,private options:{baseUrl?:string;region?:string;city?:string;delayMs?:number;budget?:number;archiveDir?:string;fetcher?:typeof fetch}={}){}
 async request(endpoint:string,params:Record<string,string>):Promise<{rows:Raw[];total:number}> {
 if(!this.key)throw new Error('TOUR_API_KEY_MISSING');
 if(++this.requests>(this.options.budget??200))throw new Error('TOUR_API_REQUEST_BUDGET_EXCEEDED');
 await new Promise(resolve=>setTimeout(resolve,this.options.delayMs??300));
 const base=new URL(this.options.baseUrl??'https://apis.data.go.kr/B551011/KorService2/');
 if(base.protocol!=='https:'||base.hostname!=='apis.data.go.kr')throw new Error('INVALID_TOUR_API_HOST');
 const url=new URL(endpoint,base);
 url.search=new URLSearchParams({serviceKey:this.key,MobileOS:'ETC',MobileApp:'HotelDataCollector',_type:'json',numOfRows:'100',pageNo:'1',...params}).toString();
 let response:Response;
 try{response=await (this.options.fetcher??fetch)(url,{signal:AbortSignal.timeout(20000),redirect:'error'});}catch{throw new Error('TOUR_API_CONNECTION_FAILED');}
 if(!response.ok)throw new Error(`TOUR_API_HTTP_${response.status}`);
 try{return parseResponse(await response.json());}catch(e){if(e instanceof Error&&e.message.startsWith('TOUR_API_ERROR'))throw e;throw new Error('TOUR_API_INVALID_RESPONSE');}
 }
 async collect(limit:number) {
 if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('INVALID_COLLECTION_LIMIT');
 const records:PublicRecord[]=[],seen=new Set<string>();let failures=0;
 for(let page=1;records.length<limit;page++){
 const list=await this.request('searchStay2',{lDongRegnCd:this.options.region??'26',pageNo:String(page),numOfRows:String(Math.min(limit,100)),arrange:'C'});
 if(!list.rows.length)break;
 for(const row of list.rows){const id=String(row.contentid??'');if(!id||seen.has(id))continue;seen.add(id);
 try{
 const common=await this.request('detailCommon2',{contentId:id});
 const intro=await this.request('detailIntro2',{contentId:id,contentTypeId:'32'});
 const rooms:Raw[]=[];
 for(let rp=1;;rp++){const result=await this.request('detailInfo2',{contentId:id,contentTypeId:'32',pageNo:String(rp)});rooms.push(...result.rows);if(!result.rows.length||rooms.length>=result.total)break;}
 const record:PublicRecord={common:{...row,...common.rows[0]},intro:intro.rows[0]??{},rooms,source:'tourapi',collectedAt:new Date().toISOString(),city:this.options.city??'부산'};
 if(this.options.archiveDir){
  try{
   await mkdir(this.options.archiveDir,{recursive:true});
   const payload={source:'tourapi',version:'v4.4',contentId:id,collectedAt:record.collectedAt,operations:{searchStay2:row,detailCommon2:common.rows,detailIntro2:intro.rows,detailInfo2:rooms},record};
   await writeFile(join(this.options.archiveDir,`${id}.json`),JSON.stringify(payload,null,2),'utf-8');
  }catch{}
 }
 records.push(record);
 }catch{failures++;} if(records.length>=limit)break;
 }
 if(page* Math.min(limit,100)>=list.total)break;
 }
 return {records,failures};
 }
}
export class FixtureCollector implements Collector {
 constructor(private records:PublicRecord[]){}
 async collect(limit:number){return {records:structuredClone(this.records.slice(0,limit)),failures:0};}
}
