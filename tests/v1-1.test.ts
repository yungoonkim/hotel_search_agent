import { describe, it, expect } from 'vitest';
import { resolveRoomIdentity, normalizeTitleForMatching } from '../src/room-identity.js';
import { normalize, type PublicRecord } from '../src/normalize.js';
import { analyze, priority, weights, qualityReport } from '../src/quality.js';
import { checkEgoAvailability, EgoBrowser, enrichHotel, MockBrowser, type BrowserResult, type BrowserRequest } from '../src/browser.js';
import { buildDocuments, indexHotel, MockEmbeddingProvider } from '../src/rag.js';
import { MemoryRepository } from '../src/repository.js';
import { makeFixtures } from '../src/fixtures.js';
import { attr, emptyAttributes, roomFields, stableId, type Room } from '../src/model.js';

describe('Data Collection Agent v1.1 Improvements', () => {
  describe('Room Identity Stabilization (Step 2)', () => {
    it('normalizes room titles ignoring spacing, casing, and punctuation', () => {
      expect(normalizeTitleForMatching('  Deluxe Double  ')).toBe('deluxedouble');
      expect(normalizeTitleForMatching('스위트 (오션 뷰)')).toBe('스위트오션뷰');
      expect(normalizeTitleForMatching('STANDARD-TWIN')).toBe('standardtwin');
    });

    it('resolves explicit roomcode directly with 100% priority', () => {
      const res = resolveRoomIdentity({
        hotelContentId: '1001',
        raw: { roomcode: 'RC99', roomtitle: 'Executive Suite' },
        rawIndex: 0,
        allRawRooms: [{ roomcode: 'RC99', roomtitle: 'Executive Suite' }],
        existingRooms: [],
      });
      expect(res.matchBasis).toBe('exact_roomcode');
      expect(res.externalId).toBe('1001:RC99');
    });

    it('preserves room_id across arbitrary raw array reordering', () => {
      const rawA = { roomcode: '', roomtitle: 'Deluxe Ocean', roomsize2: '35', roombasecount: '2', roommaxcount: '2' };
      const rawB = { roomcode: '', roomtitle: 'Standard City', roomsize2: '24', roombasecount: '2', roommaxcount: '2' };
      const rawC = { roomcode: '', roomtitle: 'Presidential Suite', roomsize2: '90', roombasecount: '4', roommaxcount: '6' };

      // Initial batch: A, B, C
      const initialRooms: Room[] = [
        {
          roomId: stableId('tourapi:room:2001:Deluxe Ocean:1'),
          hotelId: stableId('tourapi:hotel:2001'),
          sources: [{ source: 'tourapi', id: '2001:Deluxe Ocean:1' }],
          attributes: {
            ...emptyAttributes(roomFields),
            roomName: attr('Deluxe Ocean', null),
            roomSize: attr(35, null),
            baseOccupancy: attr(2, null),
            maxOccupancy: attr(2, null),
          },
        },
        {
          roomId: stableId('tourapi:room:2001:Standard City:2'),
          hotelId: stableId('tourapi:hotel:2001'),
          sources: [{ source: 'tourapi', id: '2001:Standard City:2' }],
          attributes: {
            ...emptyAttributes(roomFields),
            roomName: attr('Standard City', null),
            roomSize: attr(24, null),
            baseOccupancy: attr(2, null),
            maxOccupancy: attr(2, null),
          },
        },
        {
          roomId: stableId('tourapi:room:2001:Presidential Suite:3'),
          hotelId: stableId('tourapi:hotel:2001'),
          sources: [{ source: 'tourapi', id: '2001:Presidential Suite:3' }],
          attributes: {
            ...emptyAttributes(roomFields),
            roomName: attr('Presidential Suite', null),
            roomSize: attr(90, null),
            baseOccupancy: attr(4, null),
            maxOccupancy: attr(6, null),
          },
        },
      ];

      // Second batch with reordered records: C, A, B
      const reorderedRaw = [rawC, rawA, rawB];

      const matchC = resolveRoomIdentity({
        hotelContentId: '2001',
        raw: rawC,
        rawIndex: 0,
        allRawRooms: reorderedRaw,
        existingRooms: initialRooms,
      });
      const matchA = resolveRoomIdentity({
        hotelContentId: '2001',
        raw: rawA,
        rawIndex: 1,
        allRawRooms: reorderedRaw,
        existingRooms: initialRooms,
      });
      const matchB = resolveRoomIdentity({
        hotelContentId: '2001',
        raw: rawB,
        rawIndex: 2,
        allRawRooms: reorderedRaw,
        existingRooms: initialRooms,
      });

      // Matches must identify the exact existing room IDs, NOT indices!
      expect(matchC.roomId).toBe(initialRooms[2]!.roomId);
      expect(matchA.roomId).toBe(initialRooms[0]!.roomId);
      expect(matchB.roomId).toBe(initialRooms[1]!.roomId);
      expect(matchC.matchBasis).toBe('unique_title');
    });

    it('disambiguates duplicate room titles using attributes (size, occupancy, bath)', () => {
      // Like Homers Hotel duplicate '스위트 테라스 오션 트윈'
      const existingRooms: Room[] = [
        {
          roomId: stableId('tourapi:room:398319:스위트 테라스 오션 트윈:1'),
          hotelId: stableId('tourapi:hotel:398319'),
          sources: [{ source: 'tourapi', id: '398319:스위트 테라스 오션 트윈:1' }],
          attributes: {
            ...emptyAttributes(roomFields),
            roomName: attr('스위트 테라스 오션 트윈', null),
            roomSize: attr(79.2, null),
            baseOccupancy: attr(2, null),
            maxOccupancy: attr(4, null),
            bathtub: attr(true, null),
          },
        },
        {
          roomId: stableId('tourapi:room:398319:스위트 테라스 오션 트윈:2'),
          hotelId: stableId('tourapi:hotel:398319'),
          sources: [{ source: 'tourapi', id: '398319:스위트 테라스 오션 트윈:2' }],
          attributes: {
            ...emptyAttributes(roomFields),
            roomName: attr('스위트 테라스 오션 트윈', null),
            roomSize: attr(45.0, null),
            baseOccupancy: attr(2, null),
            maxOccupancy: attr(2, null),
            bathtub: attr(false, null),
          },
        },
      ];

      const incomingRaw = {
        roomcode: '',
        roomtitle: '스위트 테라스 오션 트윈',
        roomsize2: '45.0',
        roombasecount: '2',
        roommaxcount: '2',
        roombath: '0',
      };

      const match = resolveRoomIdentity({
        hotelContentId: '398319',
        raw: incomingRaw,
        rawIndex: 1,
        allRawRooms: [incomingRaw],
        existingRooms,
      });

      expect(match.roomId).toBe(existingRooms[1]!.roomId);
      expect(match.matchBasis).toBe('disambiguated_attributes');
      expect(match.isReviewCandidate).toBe(false);
    });

    it('flags ambiguous duplicate titles without attribute distinctions for human review', () => {
      const existingRooms: Room[] = [
        {
          roomId: stableId('tourapi:room:398319:스탠다드:1'),
          hotelId: stableId('tourapi:hotel:398319'),
          sources: [{ source: 'tourapi', id: '398319:스탠다드:1' }],
          attributes: {
            ...emptyAttributes(roomFields),
            roomName: attr('스탠다드', null),
            roomSize: attr(null, null),
            baseOccupancy: attr(2, null),
            maxOccupancy: attr(2, null),
          },
        },
        {
          roomId: stableId('tourapi:room:398319:스탠다드:2'),
          hotelId: stableId('tourapi:hotel:398319'),
          sources: [{ source: 'tourapi', id: '398319:스탠다드:2' }],
          attributes: {
            ...emptyAttributes(roomFields),
            roomName: attr('스탠다드', null),
            roomSize: attr(null, null),
            baseOccupancy: attr(2, null),
            maxOccupancy: attr(2, null),
          },
        },
      ];

      const incomingRaw = {
        roomcode: '',
        roomtitle: '스탠다드',
        roomsize2: '',
        roombasecount: '2',
        roommaxcount: '2',
      };

      const match = resolveRoomIdentity({
        hotelContentId: '398319',
        raw: incomingRaw,
        rawIndex: 99, // non-matching legacy index
        allRawRooms: [incomingRaw],
        existingRooms,
      });

      expect(match.isReviewCandidate).toBe(true);
      expect(match.reviewReason).toContain('AMBIGUOUS_DUPLICATE_ROOM_TITLE');
    });
  });

  describe('Data Gap Analyzer Improvements (Step 3)', () => {
    it('detects 0-room hotels with highest priority roomList gap (weight 10)', () => {
      const hotelFixture = normalize(makeFixtures(1)[0]!);
      const hotelWithoutRooms = { ...hotelFixture, rooms: [] };

      const gaps = analyze(hotelWithoutRooms);
      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps[0]?.field).toBe('roomList');
      expect(gaps[0]?.priority).toBe(10);
      expect(gaps[0]?.status).toBe('missing');
      expect(gaps[0]?.reason).toContain('HOTEL_LACKS_ROOMS');
    });

    it('enforces strict priority order: roomList(10) > beds(8) > view(7) > breakfast(6) > bathtub(5)', () => {
      expect(priority('roomList', 'missing')).toBe(10);
      expect(priority('beds', 'missing')).toBe(8);
      expect(priority('view', 'missing')).toBe(7);
      expect(priority('breakfast', 'missing')).toBe(6);
      expect(priority('bathtub', 'missing')).toBe(5);
      expect(priority('shower', 'missing')).toBe(5);
      expect(priority('parking', 'missing')).toBe(3);
      expect(priority('surroundings', 'missing')).toBe(2);
    });

    it('ranks conflicting status 1.5x higher than missing', () => {
      expect(priority('beds', 'conflicting')).toBe(12);
      expect(priority('beds', 'missing')).toBe(8);
    });

    it('computes quality report with hotelsWithoutRooms count and comprehensive coverage', () => {
      const hWithRooms = normalize(makeFixtures(1)[0]!);
      const hWithoutRooms = { ...normalize(makeFixtures(2)[1]!), rooms: [] };

      const report = qualityReport([hWithRooms, hWithoutRooms], {
        duplicates: 0,
        failures: 0,
        chunks: 2,
        embeddings: 2,
      });

      expect(report.hotels).toBe(2);
      expect(report.hotelsWithoutRooms).toBe(1);
      expect(report.fields.breakfast).toBeDefined();
      expect(report.fields.beds).toBeDefined();
      expect(report.fields.bathtub).toBeDefined();
      expect(report.fields.view).toBeDefined();
    });
  });

  describe('Browser Enrichment & Ego Adaptation (Step 4 & 5)', () => {
    it('checks ego availability safely on the host without throwing unhandled exceptions', () => {
      const status = checkEgoAvailability();
      expect(typeof status.available).toBe('boolean');
      if (!status.available) {
        expect(status.reason).toBeDefined();
      }
    });

    it('EgoBrowser throws UNAVAILABLE gracefully when ego is missing', async () => {
      const ego = new EgoBrowser();
      const req: BrowserRequest = {
        hotelId: stableId('test:hotel'),
        targetFields: ['breakfast'],
        candidateUrls: ['https://example.com'],
      };
      await expect(ego.enrich(req)).rejects.toThrow('UNAVAILABLE');
    });

    it('discovers rooms for 0-room hotels through browser enrichment', async () => {
      const hotelWithoutRooms = { ...normalize(makeFixtures(1)[0]!), rooms: [] };
      const sourceUrl = 'https://fixture.invalid/hotel';
      const allowedSources = [{
        url: sourceUrl,
        permissionReference: 'test-permission',
        reviewedAt: new Date().toISOString(),
      }];

      const mockDiscoveryResult = (r: BrowserRequest): BrowserResult => ({
        hotelId: r.hotelId,
        sourceUrl,
        collectedAt: new Date().toISOString(),
        extractedFields: { breakfast: true },
        evidence: { breakfast: '조식 뷔페 제공' },
        discoveredRooms: [
          {
            roomName: '슈페리어 더블',
            roomType: 'standard',
            beds: [{ type: 'double', count: 1 }],
            view: 'city',
            bathtub: true,
            roomSize: 28.5,
            baseOccupancy: 2,
            maxOccupancy: 2,
            evidenceText: '슈페리어 더블룸: 28.5m2, 더블침대 1개, 전용 욕조',
          },
        ],
      });

      const gaps = analyze(hotelWithoutRooms);
      const res = await enrichHotel(
        hotelWithoutRooms,
        gaps,
        new MockBrowser(mockDiscoveryResult),
        allowedSources,
        [sourceUrl]
      );

      expect(res.pending).toHaveLength(0);
      expect(res.hotel.rooms).toHaveLength(1);
      const room = res.hotel.rooms[0]!;
      expect(room.attributes.roomName?.value).toBe('슈페리어 더블');
      expect(room.attributes.bathtub?.value).toBe(true);
      expect(room.attributes.view?.value).toBe('city');
      expect(room.attributes.roomName?.status).toBe('unverified');
      expect(room.attributes.roomName?.evidence[0]?.source).toBe('browser');
    });
  });

  describe('RAG Context & Price Exclusion (Step 7)', () => {
    it('never includes price in chunk context or metadata', () => {
      const h = normalize(makeFixtures(1)[0]!);
      const docs = buildDocuments(h);
      for (const doc of docs) {
        expect(doc.context).not.toMatch(/\b(price|fee|cost|rate)\b|요금|가격/i);
        const metaAttrs = (doc.metadata as any).attributes ?? {};
        expect(metaAttrs.price).toBeUndefined();
        expect(metaAttrs.fee).toBeUndefined();
        expect(metaAttrs.cost).toBeUndefined();
      }
    });

    it('reuses cached embedding vector when only non-context metadata changes', async () => {
      const repo = new MemoryRepository();
      const p = new MockEmbeddingProvider();
      const h = normalize(makeFixtures(1)[0]!);

      // Initial indexing
      await indexHotel(h, repo, p);
      const initialCalls = p.calls;
      expect(initialCalls).toBeGreaterThan(0);

      // Change only evidence URL (metadata change, context unchanged)
      h.attributes.name!.evidence[0]!.url = 'https://updated.url/docs';
      await indexHotel(h, repo, p);
      expect(p.calls).toBe(initialCalls); // No re-embedding!

      // Now change actual verified context text
      const ev = h.attributes.name!.evidence[0]!;
      h.attributes.name = attr('새로운 호텔명', ev);
      await indexHotel(h, repo, p);
      expect(p.calls).toBe(initialCalls + 1); // Re-embedding triggered!
    });
  });
});
