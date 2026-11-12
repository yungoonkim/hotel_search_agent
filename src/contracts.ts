import { z } from 'zod';
import { BedSchema,HotelSchema,RoomSchema } from './model.js';
export const HotelSearchFiltersSchema=z.object({city:z.string().optional(),parking:z.boolean().optional(),breakfast:z.boolean().optional(),pool:z.boolean().optional(),gym:z.boolean().optional(),sauna:z.boolean().optional(),businessCenter:z.boolean().optional(),bathtub:z.boolean().optional(),shower:z.boolean().optional(),view:z.enum(['ocean','city','mountain','garden','other']).optional(),beds:z.array(BedSchema).optional(),minOccupancy:z.number().int().positive().optional()}).strict();
export type HotelSearchFilters=z.infer<typeof HotelSearchFiltersSchema>;
export const HotelCandidateSchema=z.object({hotelId:z.string().uuid(),roomIds:z.array(z.string().uuid())});
export type HotelCandidate=z.infer<typeof HotelCandidateSchema>;
export const HotelDetailsSchema=HotelSchema;
export const RoomDetailsSchema=RoomSchema;
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v);
export const PriceLookupRequestSchema=z.object({hotelId:z.string().uuid(),roomId:z.string().uuid().optional(),checkIn:date,checkOut:date,adults:z.number().int().positive(),children:z.number().int().nonnegative().optional(),roomCount:z.number().int().positive()}).refine(v=>v.checkOut>v.checkIn,'checkOut must follow checkIn');
export type PriceLookupRequest=z.infer<typeof PriceLookupRequestSchema>;
export const RagChunkSchema=z.object({chunkId:z.string().uuid(),hotelId:z.string().uuid(),roomId:z.string().uuid().nullable(),context:z.string(),contextHash:z.string(),metadata:z.record(z.unknown()),model:z.string(),version:z.string(),dimensions:z.number().int().positive(),embedding:z.array(z.number().finite())}).refine(c=>c.embedding.length===c.dimensions);
export type RagChunk=z.infer<typeof RagChunkSchema>;
export interface HotelSearchRepository {
 findHotelsByFilters(filters:HotelSearchFilters):Promise<HotelCandidate[]>;
 getHotelDetails(hotelId:string):Promise<z.infer<typeof HotelDetailsSchema>|null>;
 getRooms(hotelId:string):Promise<z.infer<typeof RoomDetailsSchema>[]>;
 getRagChunks(hotelIds:string[]):Promise<RagChunk[]>;
}
