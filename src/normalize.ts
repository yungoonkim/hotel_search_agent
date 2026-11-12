import { attr, emptyAttributes, hotelFields, roomFields, stableId, HotelSchema, type Hotel, type Room, type Evidence, type Field } from './model.js';
import { resolveRoomIdentity } from './room-identity.js';
export type Raw = Record<string,unknown>;
export interface PublicRecord { common:Raw; intro:Raw; rooms:Raw[]; source:string; collectedAt:string; city:string; }
export interface NormalizeOptions { existingRooms?: Room[]; }
export const text = (v:unknown):string|null => typeof v==='string'&&v.trim()?v.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').normalize('NFKC').replace(/\s+/g,' ').trim():null;
export const bool = (v:unknown):boolean|null => /^(1|y|yes|true|있음|가능)$/i.test(String(v).trim())?true:/^(0|n|no|false|없음|불가)$/i.test(String(v).trim())?false:null;
export const positive = (v:unknown):number|null => v!==''&&v!=null&&Number.isFinite(Number(v))&&Number(v)>0?Number(v):null;

export function isParkingAvailable(v: unknown): boolean | null {
  const b = bool(v);
  if (b !== null) return b;
  const s = text(v);
  if (!s) return null;
  if (/^(주차\s*가능|가능.*)/.test(s) && !/불가/.test(s)) return true;
  if (/^(주차\s*불가|불가.*)/.test(s)) return false;
  return null;
}

export function beds(v:unknown) { const s=text(v); if(!s)return null; const result=[];
 for(const m of s.matchAll(/(single|double|queen|king|싱글|더블|퀸|킹)\s*(?:(?:beds?|침대)\s*)?(\d+)\s*(?:개)?/gi)) {const type=({싱글:'single',더블:'double',퀸:'queen',킹:'king'} as Record<string,string>)[m[1]!]??m[1]!.toLowerCase(); result.push({type,count:Number(m[2])});}
 for(const m of s.matchAll(/(\d+)\s*(single|double|queen|king)\s*beds?/gi))result.push({type:m[2]!.toLowerCase(),count:Number(m[1])});
 return result.length?result:null; // Twin Room alone proves neither size nor count.
}
export function normalize(r:PublicRecord, options?: NormalizeOptions):Hotel {
 const id=text(r.common.contentid); if(!id)throw new Error('MISSING_CONTENT_ID');
 const hotelId=stableId(`${r.source}:hotel:${id}`),attributes=emptyAttributes(hotelFields);
 const evidence=(recordId:string,quote:string):Evidence=>({source:r.source,recordId,url:r.source==='tourapi'?`https://www.data.go.kr/data/15101578/openapi.do`:null,collectedAt:r.collectedAt,quote,verified:r.source==='tourapi'||r.source==='fixture'});
 const set=(key:Field,value:unknown,raw:unknown)=>{attributes[key]=attr(value,value==null?null:evidence(id,String(raw)));};
 set('name',text(r.common.title),r.common.title);set('address',text([r.common.addr1,r.common.addr2].filter(Boolean).join(' ')),r.common.addr1);set('city',r.city,r.city);
 for(const [k,raw,max] of [['latitude',r.common.mapy,90],['longitude',r.common.mapx,180]] as const){const n=Number(raw);set(k,raw!==''&&raw!=null&&Number.isFinite(n)&&Math.abs(n)<=max&&n!==0?n:null,raw);}
 
 const phoneVal = text(r.common.tel) ?? text(r.intro.infocenterlodging);
 const phoneRaw = r.common.tel || r.intro.infocenterlodging;
 set('phone', phoneVal, phoneRaw);
 set('description', text(r.common.overview), r.common.overview);
 set('image', text(r.common.firstimage), r.common.firstimage);
 if(attributes.image?.value && !/^https?:\/\//.test(String(attributes.image.value)))set('image',null,null);

 const typeCode = text(r.common.lclsSystm2) ?? text(r.common.lclsSystm1);
 const mappedType = typeCode === 'AC01' ? 'hotel'
   : (typeCode === 'AC02' || typeCode === 'VE05') ? 'resort'
   : (typeCode === 'AC03' || typeCode === 'AC06') ? 'guesthouse'
   : typeCode === 'AC04' ? 'motel'
   : typeCode === 'AC05' ? 'other'
   : normalizeHotelType(r.common.hotel_type ?? r.common.title);
 set('hotelType', mappedType, r.common.lclsSystm2 ?? r.common.hotel_type ?? r.common.title);

 set('parking', isParkingAvailable(r.intro.parkinglodging), r.intro.parkinglodging);

 const sub = text(r.intro.subfacility) ?? '';
 const bizCenter = bool(r.intro.businesscenter) ?? (/비즈니스\s*(센터|코너)/i.test(sub) ? true : null);
 set('businessCenter', bizCenter, r.intro.businesscenter ?? (bizCenter ? r.intro.subfacility : null));

 let gymVal = bool(r.intro.fitness);
 let gymRaw: unknown = r.intro.fitness;
 if (gymVal !== true && /피트니스|휘트니스|fitness/i.test(sub)) {
   gymVal = true;
   gymRaw = r.intro.subfacility;
 }
 set('gym', gymVal, gymRaw);

 let saunaVal = bool(r.intro.sauna);
 let saunaRaw: unknown = r.intro.sauna;
 if (saunaVal !== true && /사우나/i.test(sub)) {
   saunaVal = true;
   saunaRaw = r.intro.subfacility;
 }
 set('sauna', saunaVal, saunaRaw);

 // publicbath is a public bath, not a swimming pool: never map it to pool.
 let poolVal: boolean | null = null;
 let poolRaw: unknown = null;
 if (/수영장|인피니티\s*풀|풀\s*스위트|swimming\s*pool/i.test(sub)) {
   poolVal = true;
   poolRaw = r.intro.subfacility;
 }
 set('pool', poolVal, poolRaw);

 const reviewCandidates: string[] = [];
 const rooms=r.rooms.flatMap((raw, index)=>{
  const identity = resolveRoomIdentity({
    hotelContentId: id,
    raw,
    rawIndex: index,
    allRawRooms: r.rooms,
    existingRooms: options?.existingRooms,
    source: r.source,
  });
  if (identity.isReviewCandidate && identity.reviewReason) {
    reviewCandidates.push(`room:${identity.roomId}:${identity.reviewReason}`);
  }
  const rid = identity.externalId;
  const a=emptyAttributes(roomFields);
  const put=(k:Field,v:unknown,original:unknown)=>{a[k]=attr(v,v==null?null:evidence(rid,String(original)));};
  put('roomName',text(raw.roomtitle),raw.roomtitle);
  put('beds',beds(raw.roomintro),raw.roomintro);
  put('roomType',normalizeRoomType(raw.roomtitle),raw.roomtitle);
  put('view',normalizeView(raw.roomtitle),raw.roomtitle);
  
  const baseOcc = positive(raw.roombasecount);
  const maxOcc = positive(raw.roommaxcount);
  if (typeof baseOcc === 'number' && typeof maxOcc === 'number' && baseOcc > maxOcc) {
    put('baseOccupancy', baseOcc, raw.roombasecount);
    put('maxOccupancy', baseOcc, raw.roombasecount);
  } else {
    put('baseOccupancy', baseOcc, raw.roombasecount);
    put('maxOccupancy', maxOcc, raw.roommaxcount);
  }
  put('roomSize', positive(raw.roomsize2), raw.roomsize2);
  put('bathtub',bool(raw.roombath),raw.roombath);
  // roombathfacility means bathroom facilities, not necessarily shower: leave shower unknown.
  put('shower',null,null);
  return [{roomId:identity.roomId,hotelId,sources:[{source:r.source,id:rid}],attributes:a}];
 });
 return HotelSchema.parse({hotelId,sources:[{source:r.source,id}],attributes,rooms,reviewCandidates:[...new Set(reviewCandidates)]});
}
export function duplicateDecision(a:Hotel,b:Hotel):'same'|'review'|'different' {
 if(a.sources.some(s=>b.sources.some(t=>s.source===t.source&&s.id===t.id)))return 'same';
 const get=(h:Hotel,k:Field)=>text(h.attributes[k]?.value)?.toLowerCase().replace(/[\s\p{P}]/gu,'');
 const same=(k:Field)=>!!get(a,k)&&get(a,k)===get(b,k);
 const near=['latitude','longitude'].every(k=>typeof a.attributes[k as Field]?.value==='number'&&typeof b.attributes[k as Field]?.value==='number'&&Math.abs(Number(a.attributes[k as Field]?.value)-Number(b.attributes[k as Field]?.value))<0.0005);
 if(same('name')&&same('address')&&(same('phone')||near))return 'same';
 return same('name')||same('address')||same('phone')||near?'review':'different';
}

export function normalizeRoomType(v:unknown) {const s=text(v)?.toLowerCase();if(!s)return null;if(/suite|스위트/.test(s))return 'suite';if(/deluxe|디럭스/.test(s))return 'deluxe';if(/standard|스탠다드/.test(s))return 'standard';return null;}
export function normalizeHotelType(v:unknown) {const s=text(v)?.toLowerCase();return ({hotel:'hotel','호텔':'hotel',motel:'motel','모텔':'motel',resort:'resort','리조트':'resort',guesthouse:'guesthouse','게스트하우스':'guesthouse'} as const)[s as 'hotel']??null;}
export function normalizeView(v:unknown) {const s=text(v)?.toLowerCase();return ({ocean:'ocean','오션뷰':'ocean','바다 전망':'ocean',city:'city','시티뷰':'city',mountain:'mountain','산 전망':'mountain',garden:'garden','정원 전망':'garden'} as const)[s as 'ocean']??null;}
