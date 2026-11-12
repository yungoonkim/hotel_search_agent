import { z } from 'zod';
import { execSync } from 'node:child_process';
import { HotelSchema, FieldSchema, hotelFields, roomFields, valueSchemas, BedSchema, emptyAttributes, stableId, type Hotel, type Field, attr, mergeAttributes } from './model.js';
import { effectiveStatus, type Gap } from './quality.js';

export const DiscoveredRoomSchema = z.object({
  roomName: z.string().min(1),
  roomType: z.enum(['standard', 'deluxe', 'suite', 'other']).optional(),
  beds: z.array(BedSchema).optional(),
  view: z.enum(['ocean', 'city', 'mountain', 'garden', 'other']).optional(),
  shower: z.boolean().optional(),
  bathtub: z.boolean().optional(),
  roomSize: z.number().positive().optional(),
  baseOccupancy: z.number().int().positive().optional(),
  maxOccupancy: z.number().int().positive().optional(),
  evidenceText: z.string().min(1),
});
export type DiscoveredRoom = z.infer<typeof DiscoveredRoomSchema>;

export const BrowserRequestSchema = z.object({
  hotelId: z.string().uuid(),
  roomId: z.string().uuid().optional(),
  targetFields: z.array(FieldSchema).min(1),
  candidateUrls: z.array(z.string().url()).min(1),
});

export const BrowserResultSchema = z.object({
  hotelId: z.string().uuid(),
  roomId: z.string().uuid().optional(),
  extractedFields: z.record(FieldSchema, z.unknown()).default({}),
  discoveredRooms: z.array(DiscoveredRoomSchema).optional(),
  sourceUrl: z.string().url(),
  collectedAt: z.string().datetime(),
  evidence: z.record(FieldSchema, z.string().min(1)).default({}),
});

export type BrowserRequest = z.infer<typeof BrowserRequestSchema>;
export type BrowserResult = z.infer<typeof BrowserResultSchema>;

export interface BrowserTool {
  enrich(request: BrowserRequest): Promise<BrowserResult>;
}

export class BrowserError extends Error {
  constructor(public code: 'UNAVAILABLE' | 'ACCESS_DENIED' | 'EXTRACTION_FAILED' | 'NO_EVIDENCE' | 'SOURCE_NOT_ALLOWED' | 'INVALID_RESULT') {
    super(code);
  }
}

export function checkEgoAvailability(): { available: boolean; binary?: string; reason?: string } {
  const isWindows = process.platform === 'win32';
  const binaries = isWindows ? ['ego.exe', 'ego.cmd', 'ego', 'ego-lite.exe', 'ego-lite.cmd', 'ego-lite'] : ['ego', 'ego-lite'];
  for (const bin of binaries) {
    try {
      const cmd = isWindows ? `where.exe ${bin}` : `which ${bin}`;
      const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
      if (out) {
        return { available: true, binary: bin };
      }
    } catch {
      // ignore
    }
  }
  return {
    available: false,
    reason: 'ego / ego-lite binary not found on system PATH',
  };
}

export class EgoBrowser implements BrowserTool {
  constructor(private timeoutMs = 15000) {}

  async enrich(_request: BrowserRequest): Promise<BrowserResult> {
    const status = checkEgoAvailability();
    if (!status.available) {
      throw new BrowserError('UNAVAILABLE');
    }
    // CLI wrapper for ego when installed
    throw new BrowserError('UNAVAILABLE');
  }
}

export class UnavailableBrowser implements BrowserTool {
  async enrich(_request: BrowserRequest): Promise<BrowserResult> {
    throw new BrowserError('UNAVAILABLE');
  }
}

export class MockBrowser implements BrowserTool {
  constructor(private run: (r: BrowserRequest) => BrowserResult | Promise<BrowserResult>) {}
  async enrich(r: BrowserRequest) {
    return this.run(r);
  }
}

export interface AllowedSource {
  url: string;
  permissionReference: string;
  reviewedAt: string;
}

export function isAllowed(url: string, sources: AllowedSource[]): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && sources.some(s => s.permissionReference && Number.isFinite(Date.parse(s.reviewedAt)) && new URL(s.url).href === u.href);
  } catch {
    return false;
  }
}

export async function enrichHotel(h: Hotel, gaps: Gap[], browser: BrowserTool, sources: AllowedSource[], urls: string[], now = new Date()) {
  let hotel = structuredClone(h);
  const pending: { roomId?: string; code: string }[] = [];

  const groups = new Map<string, Field[]>();
  let hasRoomListGap = false;
  for (const gap of gaps) {
    if (gap.field === 'roomList') {
      hasRoomListGap = true;
      continue;
    }
    const key = gap.roomId ?? '';
    groups.set(key, [...(groups.get(key) ?? []), gap.field as Field]);
  }

  // If hotel has 0 rooms and no hotel-level field gaps, add an entry to allow room discovery
  if (hasRoomListGap && !groups.has('')) {
    groups.set('', []);
  }

  for (const [roomId, targetFields] of groups) {
    const candidateUrls = urls.filter(u => isAllowed(u, sources));
    if (!candidateUrls.length) {
      pending.push({ roomId: roomId || undefined, code: 'SOURCE_NOT_ALLOWED' });
      continue;
    }
    try {
      const candidate = structuredClone(hotel);
      const reqFields = targetFields.length ? targetFields : (roomId ? ['roomName' as Field] : ['name' as Field]);
      const request = BrowserRequestSchema.parse({
        hotelId: h.hotelId,
        ...(roomId ? { roomId } : {}),
        targetFields: reqFields,
        candidateUrls,
      });

      const rawResult = await browser.enrich(request);
      const result = BrowserResultSchema.parse(rawResult);

      if (
        result.hotelId !== h.hotelId ||
        result.roomId !== request.roomId ||
        !candidateUrls.includes(result.sourceUrl) ||
        !isAllowed(result.sourceUrl, sources) ||
        Date.parse(result.collectedAt) > now.getTime() + 60000
      ) {
        throw new BrowserError('INVALID_RESULT');
      }

      let count = 0;
      const entity = roomId ? candidate.rooms.find(r => r.roomId === roomId) : candidate;
      if (!entity) throw new BrowserError('INVALID_RESULT');

      for (const [key, value] of Object.entries(result.extractedFields ?? {})) {
        const field = key as Field;
        if (!targetFields.includes(field) || !(roomId ? roomFields : hotelFields).includes(field)) {
          throw new BrowserError('INVALID_RESULT');
        }
        if (effectiveStatus(entity.attributes[field], now) === 'verified') continue;
        if (value == null || !result.evidence?.[field]) continue;
        const parsed = valueSchemas[field].safeParse(value);
        if (!parsed.success) throw new BrowserError('INVALID_RESULT');

        entity.attributes = mergeAttributes(entity.attributes, {
          [field]: attr(parsed.data, {
            source: 'browser',
            recordId: roomId || h.hotelId,
            url: result.sourceUrl,
            collectedAt: result.collectedAt,
            quote: result.evidence[field]!,
            verified: false,
          }),
        });
        count++;
      }

      // Discover rooms for hotels lacking rooms
      if (!roomId && result.discoveredRooms && result.discoveredRooms.length > 0 && candidate.rooms.length === 0) {
        for (let i = 0; i < result.discoveredRooms.length; i++) {
          const disc = result.discoveredRooms[i]!;
          const rid = `${candidate.hotelId}:browser:${disc.roomName}:${i + 1}`;
          const newRoomId = stableId(`browser:room:${rid}`);
          const a = emptyAttributes(roomFields);
          const evidence = {
            source: 'browser',
            recordId: rid,
            url: result.sourceUrl,
            collectedAt: result.collectedAt,
            quote: disc.evidenceText,
            verified: false,
          };
          const put = (k: Field, v: unknown) => {
            a[k] = attr(v, v == null ? null : evidence);
          };
          put('roomName', disc.roomName);
          if (disc.roomType) put('roomType', disc.roomType);
          if (disc.beds) put('beds', disc.beds);
          if (disc.view) put('view', disc.view);
          if (disc.shower !== undefined) put('shower', disc.shower);
          if (disc.bathtub !== undefined) put('bathtub', disc.bathtub);
          if (disc.roomSize !== undefined) put('roomSize', disc.roomSize);
          if (disc.baseOccupancy !== undefined) put('baseOccupancy', disc.baseOccupancy);
          if (disc.maxOccupancy !== undefined) put('maxOccupancy', disc.maxOccupancy);

          candidate.rooms.push({
            roomId: newRoomId,
            hotelId: candidate.hotelId,
            sources: [{ source: 'browser', id: rid }],
            attributes: a,
          });
          count++;
        }
      }

      if (!count) throw new BrowserError('NO_EVIDENCE');
      hotel = HotelSchema.parse(candidate);
    } catch (e) {
      pending.push({ roomId: roomId || undefined, code: e instanceof BrowserError ? e.code : 'EXTRACTION_FAILED' });
    }
  }
  return { hotel, pending };
}
