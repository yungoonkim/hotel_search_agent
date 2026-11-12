import { stableId, type Room, type Field } from './model.js';
import { text, positive, bool, type Raw } from './normalize.js';

export type RoomMatchBasis =
  | 'exact_roomcode'
  | 'exact_source_id'
  | 'unique_title'
  | 'disambiguated_attributes'
  | 'legacy_fallback'
  | 'new_room_deterministic';

export interface RoomMatchResult {
  roomId: string;
  externalId: string;
  matchBasis: RoomMatchBasis;
  isReviewCandidate: boolean;
  reviewReason?: string;
  matchedExistingRoomId?: string;
}

export function normalizeTitleForMatching(title: unknown): string {
  const s = text(title);
  if (!s) return '';
  return s.toLowerCase().replace(/[\s\p{P}]/gu, '');
}

export interface ResolveRoomParams {
  hotelContentId: string;
  raw: Raw;
  rawIndex: number;
  allRawRooms: Raw[];
  existingRooms?: Room[];
  source?: string;
}

/**
 * Resolves a stable, deterministic room identity for an incoming raw room record.
 * Prioritizes:
 * 1. Explicit raw.roomcode
 * 2. Exact source ID match in existing rooms
 * 3. Unique normalized room title match against existing rooms
 * 4. Stable attribute disambiguation (size, occupancy, bath) for duplicate titles
 * 5. Legacy index fallback preservation for previously collected rooms
 * 6. Deterministic new room external ID generation when no match exists
 */
export function resolveRoomIdentity(params: ResolveRoomParams): RoomMatchResult {
  const { hotelContentId, raw, rawIndex, allRawRooms, existingRooms = [], source = 'tourapi' } = params;

  // 1. Explicit roomcode
  const explicitCode = text(raw.roomcode);
  if (explicitCode) {
    const targetExtId = `${hotelContentId}:${explicitCode}`;
    const existing = existingRooms.find(r =>
      r.sources.some(s => s.source === source && s.id === targetExtId)
    );
    if (existing) {
      return {
        roomId: existing.roomId,
        externalId: targetExtId,
        matchBasis: 'exact_roomcode',
        isReviewCandidate: false,
        matchedExistingRoomId: existing.roomId
      };
    }
    return {
      roomId: stableId(`${source}:room:${targetExtId}`),
      externalId: targetExtId,
      matchBasis: 'exact_roomcode',
      isReviewCandidate: false
    };
  }

  // 2. Roomcode missing: extract raw attributes
  const rawTitle = text(raw.roomtitle) ?? 'room';
  const normRawTitle = normalizeTitleForMatching(rawTitle);
  const rawSize = positive(raw.roomsize2);
  const rawBase = positive(raw.roombasecount);
  const rawMax = positive(raw.roommaxcount);
  const rawBath = bool(raw.roombath);

  // Check matching against existing rooms of this hotel
  if (existingRooms.length > 0) {
    const titleCandidates = existingRooms.filter(r => {
      const existingTitle = text(r.attributes.roomName?.value);
      return normalizeTitleForMatching(existingTitle) === normRawTitle;
    });

    // Count how many raw rooms in this batch have this same normalized title
    const incomingWithSameTitle = allRawRooms.filter(r =>
      normalizeTitleForMatching(r.roomtitle) === normRawTitle
    );

    // Scenario A: Exactly 1 candidate in existing rooms AND exactly 1 incoming room with this title
    if (titleCandidates.length === 1 && incomingWithSameTitle.length === 1) {
      const candidate = titleCandidates[0]!;
      const oldSize = candidate.attributes.roomSize?.value as number | null;
      const oldBase = candidate.attributes.baseOccupancy?.value as number | null;
      const oldMax = candidate.attributes.maxOccupancy?.value as number | null;

      // Check for severe attribute contradiction
      let hasConflict = false;
      let conflictReason: string | undefined;
      if (typeof oldSize === 'number' && typeof rawSize === 'number' && Math.abs(oldSize - rawSize) > 20) {
        hasConflict = true;
        conflictReason = `ROOM_SIZE_DIVERGENCE: existing=${oldSize}m2, incoming=${rawSize}m2`;
      } else if (typeof oldMax === 'number' && typeof rawMax === 'number' && Math.abs(oldMax - rawMax) >= 3) {
        hasConflict = true;
        conflictReason = `ROOM_OCCUPANCY_DIVERGENCE: existing=${oldMax}, incoming=${rawMax}`;
      }

      const existingSourceId = candidate.sources.find(s => s.source === source)?.id ?? `${hotelContentId}:${rawTitle}`;
      return {
        roomId: candidate.roomId,
        externalId: existingSourceId,
        matchBasis: 'unique_title',
        isReviewCandidate: hasConflict,
        reviewReason: conflictReason,
        matchedExistingRoomId: candidate.roomId
      };
    }

    // Scenario B: Multiple candidates in existing rooms with this title
    if (titleCandidates.length > 1) {
      const scored = titleCandidates.map(c => {
        let score = 0;
        const oldSize = c.attributes.roomSize?.value as number | null;
        const oldBase = c.attributes.baseOccupancy?.value as number | null;
        const oldMax = c.attributes.maxOccupancy?.value as number | null;
        const oldBath = c.attributes.bathtub?.value as boolean | null;

        if (typeof oldSize === 'number' && typeof rawSize === 'number') {
          if (Math.abs(oldSize - rawSize) < 0.5) score += 4;
          else if (Math.abs(oldSize - rawSize) < 3.0) score += 2;
        }
        if (typeof oldBase === 'number' && typeof rawBase === 'number' && oldBase === rawBase) score += 3;
        if (typeof oldMax === 'number' && typeof rawMax === 'number' && oldMax === rawMax) score += 3;
        if (typeof oldBath === 'boolean' && typeof rawBath === 'boolean' && oldBath === rawBath) score += 1;

        // Legacy external_id match bonus
        const legacyId = `${hotelContentId}:${rawTitle}:${rawIndex + 1}`;
        if (c.sources.some(s => s.id === legacyId)) score += 2;

        return { candidate: c, score };
      }).sort((a, b) => b.score - a.score);

      const top = scored[0]!;
      const runnerUp = scored[1];
      const isConfident = top.score >= 3 && (!runnerUp || top.score > runnerUp.score);

      if (isConfident) {
        const candidate = top.candidate;
        const existingSourceId = candidate.sources.find(s => s.source === source)?.id ?? `${hotelContentId}:${rawTitle}:${rawIndex + 1}`;
        return {
          roomId: candidate.roomId,
          externalId: existingSourceId,
          matchBasis: 'disambiguated_attributes',
          isReviewCandidate: false,
          matchedExistingRoomId: candidate.roomId
        };
      }

      // Check direct legacy index match
      const legacyCandidate = titleCandidates.find(c =>
        c.sources.some(s => s.id === `${hotelContentId}:${rawTitle}:${rawIndex + 1}`)
      );
      if (legacyCandidate) {
        return {
          roomId: legacyCandidate.roomId,
          externalId: `${hotelContentId}:${rawTitle}:${rawIndex + 1}`,
          matchBasis: 'legacy_fallback',
          isReviewCandidate: false,
          matchedExistingRoomId: legacyCandidate.roomId
        };
      }

      // Ambiguous match among duplicate titles
      const fallbackCandidate = top.candidate;
      return {
        roomId: fallbackCandidate.roomId,
        externalId: fallbackCandidate.sources.find(s => s.source === source)?.id ?? `${hotelContentId}:${rawTitle}:${rawIndex + 1}`,
        matchBasis: 'disambiguated_attributes',
        isReviewCandidate: true,
        reviewReason: `AMBIGUOUS_DUPLICATE_ROOM_TITLE: ${rawTitle}`,
        matchedExistingRoomId: fallbackCandidate.roomId
      };
    }
  }

  // 3. New room without prior matching candidate
  const duplicateTitlesInBatch = allRawRooms.filter(r =>
    normalizeTitleForMatching(r.roomtitle) === normRawTitle
  );

  let generatedCode: string;
  if (duplicateTitlesInBatch.length <= 1) {
    generatedCode = rawTitle;
  } else {
    // Disambiguate duplicate titles within same incoming batch
    const disc = rawSize ? `s${rawSize}` : (rawBase ? `b${rawBase}` : `${rawIndex + 1}`);
    generatedCode = `${rawTitle}:${disc}`;
  }

  const newExtId = `${hotelContentId}:${generatedCode}`;
  return {
    roomId: stableId(`${source}:room:${newExtId}`),
    externalId: newExtId,
    matchBasis: 'new_room_deterministic',
    isReviewCandidate: false
  };
}
