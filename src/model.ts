import { z } from 'zod';
import { createHash } from 'node:crypto';
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const stableId = (s: string) => { const h = hash(s); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; };
export const StatusSchema = z.enum(['verified','unverified','missing','conflicting','stale']);
export const BedSchema = z.object({type:z.enum(['single','double','queen','king','sofa','bunk','unknown']),count:z.number().int().positive()});
export const valueSchemas = {
 name:z.string().min(1), nameEn:z.string(), address:z.string().min(1), city:z.string(), latitude:z.number().min(-90).max(90), longitude:z.number().min(-180).max(180),
 hotelType:z.enum(['hotel','motel','resort','guesthouse','other']), description:z.string(), phone:z.string(), image:z.string().url(), surroundings:z.string(),
 parking:z.boolean(), breakfast:z.boolean(), pool:z.boolean(), gym:z.boolean(), sauna:z.boolean(), businessCenter:z.boolean(),
 roomName:z.string().min(1), roomType:z.enum(['standard','deluxe','suite','other']), beds:z.array(BedSchema).min(1), view:z.enum(['ocean','city','mountain','garden','other']),
 shower:z.boolean(), bathtub:z.boolean(), roomSize:z.number().positive(), baseOccupancy:z.number().int().positive(), maxOccupancy:z.number().int().positive()
} as const;
export type Field = keyof typeof valueSchemas;
export const FieldSchema = z.enum(Object.keys(valueSchemas) as [Field,...Field[]]);
export const EvidenceSchema = z.object({source:z.string().min(1),recordId:z.string().min(1),url:z.string().url().nullable(),collectedAt:z.string().datetime(),quote:z.string().min(1),verified:z.boolean(),observedValue:z.unknown().optional()});
export type Evidence = z.infer<typeof EvidenceSchema>;
export const AttributeSchema = z.object({value:z.unknown().nullable(),status:StatusSchema,evidence:z.array(EvidenceSchema)}).superRefine((a,c)=>{
 if(a.value === null && a.status !== 'missing') c.addIssue({code:'custom',message:'null must be missing'});
 if(a.value !== null && a.status === 'missing') c.addIssue({code:'custom',message:'missing must be null'});
 if(a.value !== null && !a.evidence.length) c.addIssue({code:'custom',message:'value requires evidence'});
 if(a.status === 'verified' && !a.evidence.some(e=>e.verified)) c.addIssue({code:'custom',message:'verified evidence required'});
});
export type Attribute = z.infer<typeof AttributeSchema>;
export const hotelFields: Field[] = ['name','nameEn','address','city','latitude','longitude','hotelType','description','phone','image','surroundings','parking','breakfast','pool','gym','sauna','businessCenter'];
export const roomFields: Field[] = ['roomName','roomType','beds','view','shower','bathtub','roomSize','baseOccupancy','maxOccupancy'];
export const AttributesSchema = z.record(FieldSchema,AttributeSchema).superRefine((attrs,c)=>{
 for(const [k,a] of Object.entries(attrs)) if(a.value !== null && !valueSchemas[k as Field].safeParse(a.value).success) c.addIssue({code:'custom',message:`Invalid ${k}`});
});
export type Attributes = Partial<Record<Field,Attribute>>;
export const SourceIdSchema = z.object({source:z.string(),id:z.string()});
export const RoomSchema = z.object({roomId:z.string().uuid(),hotelId:z.string().uuid(),sources:z.array(SourceIdSchema),attributes:AttributesSchema});
export const HotelSchema = z.object({hotelId:z.string().uuid(),sources:z.array(SourceIdSchema),attributes:AttributesSchema,rooms:z.array(RoomSchema),reviewCandidates:z.array(z.string()).default([])}).superRefine((h,c)=>{
 for(const key of Object.keys(h.attributes))if(!hotelFields.includes(key as Field))c.addIssue({code:'custom',message:'Invalid hotel attribute scope'});
 for(const r of h.rooms) { for(const key of Object.keys(r.attributes))if(!roomFields.includes(key as Field))c.addIssue({code:'custom',message:'Invalid room attribute scope'});
 if(r.hotelId!==h.hotelId)c.addIssue({code:'custom',message:'Room belongs to another hotel'});
 const base=r.attributes.baseOccupancy?.value,max=r.attributes.maxOccupancy?.value;
 if(typeof base==='number'&&typeof max==='number'&&base>max)c.addIssue({code:'custom',message:'base exceeds max occupancy'}); }
 if(new Set(h.rooms.map(r=>r.roomId)).size!==h.rooms.length)c.addIssue({code:'custom',message:'Duplicate room ID'});
});
export type Hotel = z.infer<typeof HotelSchema>;
export type Room = z.infer<typeof RoomSchema>;
export const attr = (value:unknown,e:Evidence|null):Attribute => ({value:value??null,status:value==null?'missing':e?.verified?'verified':'unverified',evidence:value==null||!e?[]:[{...e,observedValue:value}]});
export const emptyAttributes = (fields:Field[]):Attributes => Object.fromEntries(fields.map(f=>[f,attr(null,null)]));
export function mergeAttributes(old:Attributes,incoming:Attributes):Attributes {
 const out=structuredClone(old);
 for(const [key,b] of Object.entries(incoming)) {
 const k=key as Field,a=out[k]; if(!a||a.value===null){out[k]=b;continue;} if(b.value===null)continue;
 const evidence=[...new Map([...a.evidence,...b.evidence].map(e=>[hash(JSON.stringify(e)),e])).values()];
 if(JSON.stringify(a.value)!==JSON.stringify(b.value))out[k]={...a,status:'conflicting',evidence};
 else out[k]={...a,status:a.status==='conflicting'?'conflicting':b.status==='verified'?'verified':a.status,evidence};
 } return out;
}
export function mergeHotel(a:Hotel,b:Hotel):Hotel {
 const rooms=new Map(a.rooms.map(r=>[r.roomId,r]));
 const reviewCandidates=[...new Set([...a.reviewCandidates,...b.reviewCandidates])];
 for(const r of b.rooms){
  let old=rooms.get(r.roomId);
  if(!old){
   old=[...rooms.values()].find(candidate=>r.sources.some(s=>candidate.sources.some(t=>s.source===t.source&&s.id===t.id)));
  }
  if(!old){
   const rName=r.attributes.roomName?.value;
   if(typeof rName==='string'&&rName.trim()){
    const nameMatches=[...rooms.values()].filter(c=>c.attributes.roomName?.value===rName);
    if(nameMatches.length===1){
     old=nameMatches[0];
    }else if(nameMatches.length>1){
     const attrMatches=nameMatches.filter(c=>c.attributes.roomSize?.value===r.attributes.roomSize?.value&&c.attributes.baseOccupancy?.value===r.attributes.baseOccupancy?.value);
     if(attrMatches.length===1){
      old=attrMatches[0];
     }else{
      reviewCandidates.push(`room:ambiguous:${r.roomId}:${rName}`);
     }
    }
   }
  }
  if(old){
   const mergedSources=[...new Map([...old.sources,...r.sources].map(s=>[s.source+':'+s.id,s])).values()];
   rooms.set(old.roomId,{...old,sources:mergedSources,attributes:mergeAttributes(old.attributes,r.attributes)});
  }else{
   rooms.set(r.roomId,r);
  }
 }
 return HotelSchema.parse({...a,attributes:mergeAttributes(a.attributes,b.attributes),sources:[...new Map([...a.sources,...b.sources].map(s=>[s.source+':'+s.id,s])).values()],rooms:[...rooms.values()],reviewCandidates});
}
