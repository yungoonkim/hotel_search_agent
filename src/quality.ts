import { hotelFields, roomFields, type Attributes, type Field, type Hotel } from './model.js';

export type GapField = Field | 'roomList';

export interface Gap {
  hotelId: string;
  roomId?: string;
  field: GapField;
  scope: 'hotel' | 'room';
  status: string;
  priority: number;
  reason?: string;
}

export const weights: Record<GapField, number> = {
  roomList: 10,
  beds: 8,
  view: 7,
  breakfast: 6,
  bathtub: 5,
  shower: 5,
  maxOccupancy: 5,
  baseOccupancy: 4,
  roomSize: 4,
  roomName: 4,
  pool: 3,
  gym: 3,
  sauna: 3,
  businessCenter: 3,
  parking: 3,
  phone: 3,
  hotelType: 3,
  name: 5,
  address: 5,
  city: 4,
  latitude: 4,
  longitude: 4,
  description: 3,
  image: 3,
  surroundings: 2,
  roomType: 3,
  nameEn: 2,
};

export function effectiveStatus(a: Attributes[Field] | undefined, now = new Date(), ttlDays = 180): string {
  if (!a || a.value === null) return 'missing';
  if (a.status === 'conflicting') return 'conflicting';
  if (!a.evidence || a.evidence.length === 0) return a.status;
  const latest = Math.max(...a.evidence.map(e => Date.parse(e.collectedAt)));
  return now.getTime() - latest > ttlDays * 86400000 ? 'stale' : a.status;
}

export function priority(field: GapField, status: string, custom: Partial<Record<GapField, number>> = weights): number {
  const multiplier = ({ missing: 1, conflicting: 1.5, stale: 0.8, unverified: 0.6, verified: 0 } as Record<string, number>)[status] ?? 0;
  return (custom[field] ?? 1) * multiplier;
}

export function analyze(h: Hotel, now = new Date()): Gap[] {
  const gaps: Gap[] = [];

  // 1. Highest priority gap: 0-room hotel
  if (h.rooms.length === 0) {
    gaps.push({
      hotelId: h.hotelId,
      field: 'roomList',
      scope: 'hotel',
      status: 'missing',
      priority: priority('roomList', 'missing'),
      reason: 'HOTEL_LACKS_ROOMS: TourAPI lacks room records, requires browser/web discovery',
    });
  }

  // 2. Hotel attributes gaps
  for (const field of hotelFields) {
    const status = effectiveStatus(h.attributes[field], now);
    if (status !== 'verified') {
      gaps.push({
        hotelId: h.hotelId,
        field,
        scope: 'hotel',
        status,
        priority: priority(field, status),
      });
    }
  }

  // 3. Room attributes gaps
  for (const r of h.rooms) {
    for (const field of roomFields) {
      const status = effectiveStatus(r.attributes[field], now);
      if (status !== 'verified') {
        gaps.push({
          hotelId: h.hotelId,
          roomId: r.roomId,
          field,
          scope: 'room',
          status,
          priority: priority(field, status),
        });
      }
    }
  }

  return gaps.sort((a, b) => b.priority - a.priority);
}

export function qualityReport(
  hotels: Hotel[],
  stats: { duplicates: number; failures: number; chunks: number; embeddings: number },
  now = new Date()
) {
  const rooms = hotels.flatMap(h => h.rooms);
  const entities = [...hotels, ...rooms];

  const coverage = (attrs: Attributes[], fields: Field[]) => {
    const states = { verified: 0, unverified: 0, missing: 0, conflicting: 0, stale: 0 };
    let known = 0;
    for (const a of attrs) {
      const s = fields.map(f => effectiveStatus(a[f], now));
      if (fields.every(f => a[f]?.value != null)) known++;
      const worst = s.includes('missing') ? 'missing'
        : s.includes('conflicting') ? 'conflicting'
        : s.includes('stale') ? 'stale'
        : s.includes('unverified') ? 'unverified'
        : 'verified';
      states[worst]++;
    }
    return { total: attrs.length, known, knownRate: attrs.length ? known / attrs.length : 0, ...states };
  };

  const ha = hotels.map(h => h.attributes);
  const ra = rooms.map(r => r.attributes);
  const values = entities.flatMap(e => Object.values(e.attributes)).filter(a => a.value != null);

  return {
    hotels: hotels.length,
    rooms: rooms.length,
    hotelsWithoutRooms: hotels.filter(h => h.rooms.length === 0).length,
    fields: {
      address: coverage(ha, ['address']),
      coordinates: coverage(ha, ['latitude', 'longitude']),
      parking: coverage(ha, ['parking']),
      breakfast: coverage(ha, ['breakfast']),
      pool: coverage(ha, ['pool']),
      gym: coverage(ha, ['gym']),
      sauna: coverage(ha, ['sauna']),
      businessCenter: coverage(ha, ['businessCenter']),
      phone: coverage(ha, ['phone']),
      hotelType: coverage(ha, ['hotelType']),
      beds: coverage(ra, ['beds']),
      bathtub: coverage(ra, ['bathtub']),
      shower: coverage(ra, ['shower']),
      view: coverage(ra, ['view']),
      roomSize: coverage(ra, ['roomSize']),
      occupancy: coverage(ra, ['baseOccupancy', 'maxOccupancy']),
    },
    sourceTraceability: values.length ? values.filter(a => a.evidence.some(e => e.recordId && e.source)).length / values.length : 0,
    needsEnrichment: hotels.filter(h => analyze(h, now).length > 0).length,
    completeness: hotels.map(h => ({
      hotelId: h.hotelId,
      roomCount: h.rooms.length,
      verifiedRatio: hotelFields.filter(f => effectiveStatus(h.attributes[f], now) === 'verified').length / hotelFields.length,
      rooms: h.rooms.map(r => ({
        roomId: r.roomId,
        verifiedRatio: roomFields.filter(f => effectiveStatus(r.attributes[f], now) === 'verified').length / roomFields.length,
      })),
    })),
    ...stats,
  };
}
