import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { exportToCsv, formatCsvValue, toCsvString } from '../src/export.js';
import { normalize, isParkingAvailable } from '../src/normalize.js';
import { makeFixtures } from '../src/fixtures.js';
import { attr, stableId } from '../src/model.js';

describe('CSV Formatter & escaping', () => {
  it('distinguishes null, false and true', () => {
    expect(formatCsvValue(null)).toBe('');
    expect(formatCsvValue(undefined)).toBe('');
    expect(formatCsvValue(false)).toBe('false');
    expect(formatCsvValue(true)).toBe('true');
  });

  it('escapes commas, quotes, and newlines properly', () => {
    expect(formatCsvValue('Hello, world')).toBe('"Hello, world"');
    expect(formatCsvValue('She said "Hello"')).toBe('"She said ""Hello"""');
    expect(formatCsvValue("Line 1\nLine 2")).toBe("\"Line 1\nLine 2\"");
    expect(formatCsvValue('')).toBe('""');
  });

  it('formats dates in ISO 8601', () => {
    const d = new Date('2026-11-12T12:00:00.000Z');
    expect(formatCsvValue(d)).toBe('2026-11-12T12:00:00.000Z');
  });

  it('generates UTF-8 BOM CSV string', () => {
    const csv = toCsvString(['name', 'city'], [{ name: '부산호텔', city: '부산' }]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('부산호텔,부산');
  });
});

describe('CSV Export database integration (PGlite)', () => {
  let db: PGlite;
  const testDir = 'data/test_exports_' + randomUUID().slice(0, 8);

  beforeAll(async () => {
    db = new PGlite();
    const ddl = await readFile(new URL('../migrations/001_core.sql', import.meta.url), 'utf8');
    await db.exec(ddl);
  });

  afterAll(async () => {
    await db.close();
    await rm(testDir, { recursive: true, force: true });
  });

  it('handles empty rooms table export gracefully', async () => {
    const res = await exportToCsv(db, testDir);
    expect(res.hotels).toBe(0);
    expect(res.rooms).toBe(0);

    const roomsCsv = await readFile(`${testDir}/rooms.csv`, 'utf8');
    expect(roomsCsv.startsWith('\uFEFF')).toBe(true);
    const lines = roomsCsv.trim().split('\r\n');
    expect(lines).toHaveLength(1); // header only
    expect(lines[0]).toContain('room_id,hotel_id');
  });

  it('exports populated data, preserves FK relations, Korean UTF-8, null/false distinction', async () => {
    const hotelId = '11111111-1111-1111-1111-111111111111';
    const roomId = '22222222-2222-2222-2222-222222222222';

    // Insert sample hotel with Korean, commas, and newlines
    await db.query(`
      INSERT INTO hotels(hotel_id, name, address, hotel_type, description, attributes)
      VALUES($1, $2, $3, $4, $5, $6)
    `, [
      hotelId,
      '해운대 그랜드 호텔',
      '부산광역시 해운대구 해운대해변로 123, 4층',
      'hotel',
      '바다 전망이 아름다운 호텔입니다.\n조용하고 아늑합니다.',
      JSON.stringify({})
    ]);

    // Insert room linked to hotel
    await db.query(`
      INSERT INTO rooms(room_id, hotel_id, room_name, room_size, base_occupancy, max_occupancy, bathtub, attributes)
      VALUES($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      roomId,
      hotelId,
      '디럭스 오션 더블',
      35.5,
      2,
      3,
      true,
      JSON.stringify({})
    ]);

    // Insert amenities with true, false, and null
    await db.query(`
      INSERT INTO hotel_amenities(hotel_id, amenity, value, status) VALUES
      ($1, 'parking', true, 'verified'),
      ($1, 'gym', false, 'verified'),
      ($1, 'breakfast', null, 'missing')
    `, [hotelId]);

    // Insert bed
    await db.query(`
      INSERT INTO room_beds(room_id, bed_type, count) VALUES($1, 'double', 1)
    `, [roomId]);

    // Insert evidence
    await db.query(`
      INSERT INTO attribute_evidence(evidence_id, hotel_id, room_id, attribute, value, status, source, record_id, source_url, collected_at, evidence_text)
      VALUES('ev-1', $1, $2, 'bathtub', 'true', 'verified', 'tourapi', '2393422', null, now(), '욕조 있음')
    `, [hotelId, roomId]);

    // Run export
    const res = await exportToCsv(db, testDir);
    expect(res.hotels).toBe(1);
    expect(res.rooms).toBe(1);
    expect(res.roomBeds).toBe(1);
    expect(res.hotelAmenities).toBe(3);
    expect(res.attributeEvidence).toBe(1);
    expect(res.dataQuality).toBe(1);

    // Verify hotel-room relation in CSV
    const hotelsCsv = await readFile(`${testDir}/hotels.csv`, 'utf8');
    const roomsCsv = await readFile(`${testDir}/rooms.csv`, 'utf8');
    expect(hotelsCsv).toContain(hotelId);
    expect(hotelsCsv).toContain('해운대 그랜드 호텔');
    expect(hotelsCsv).toContain('"부산광역시 해운대구 해운대해변로 123, 4층"');
    expect(roomsCsv).toContain(roomId);
    expect(roomsCsv).toContain(hotelId); // FK preserved

    // Verify null vs false in hotel_amenities.csv
    const amenitiesCsv = await readFile(`${testDir}/hotel_amenities.csv`, 'utf8');
    expect(amenitiesCsv).toContain(`${hotelId},breakfast,,missing`);
    expect(amenitiesCsv).toContain(`${hotelId},gym,false,verified`);
    expect(amenitiesCsv).toContain(`${hotelId},parking,true,verified`);

    // Verify repeated export is byte-for-byte identical (fixed ordering)
    const run1 = await readFile(`${testDir}/hotels.csv`, 'utf8');
    await exportToCsv(db, testDir);
    const run2 = await readFile(`${testDir}/hotels.csv`, 'utf8');
    expect(run1).toBe(run2);
  });
});

describe('TourAPI room normalization enhancements', () => {
  it('falls back to roomtitle:index when roomcode is empty string', () => {
    const raw = {
      source: 'tourapi',
      collectedAt: new Date().toISOString(),
      city: '부산',
      common: {
        contentid: '999001',
        title: '테스트 호텔',
        addr1: '부산광역시 중구',
        mapx: '129.0',
        mapy: '35.0'
      },
      intro: {
        parkinglodging: '주차 가능',
        infocenterlodging: '051-111-2222',
        subfacility: '비즈니스센터 / 사우나 / 피트니스 센터 / 실내 수영장'
      },
      rooms: [
        {
          roomcode: '', // empty in real TourAPI
          roomtitle: '디럭스 더블',
          roomsize2: '28.5',
          roombasecount: '2',
          roommaxcount: '2',
          roombath: 'Y',
          roomintro: '싱글 침대 2개'
        },
        {
          roomcode: '',
          roomtitle: '스탠다드',
          roomsize2: '20',
          roombasecount: '2',
          roommaxcount: '2',
          roombath: '',
          roomintro: ''
        }
      ]
    };

    const hotel = normalize(raw);
    expect(hotel.rooms).toHaveLength(2);
    expect(hotel.rooms[0]?.attributes.roomName?.value).toBe('디럭스 더블');
    expect(hotel.rooms[0]?.attributes.roomSize?.value).toBe(28.5);
    expect(hotel.rooms[0]?.attributes.bathtub?.value).toBe(true);
    expect(hotel.rooms[0]?.attributes.beds?.value).toEqual([{ type: 'single', count: 2 }]);
    expect(hotel.rooms[1]?.attributes.roomName?.value).toBe('스탠다드');
    expect(hotel.rooms[1]?.attributes.bathtub?.value).toBeNull();

    // Verify hotel-level enhancements
    expect(hotel.attributes.phone?.value).toBe('051-111-2222');
    expect(hotel.attributes.parking?.value).toBe(true);
    expect(hotel.attributes.businessCenter?.value).toBe(true);
    expect(hotel.attributes.gym?.value).toBe(true);
    expect(hotel.attributes.sauna?.value).toBe(true);
    expect(hotel.attributes.pool?.value).toBe(true);
    expect(hotel.attributes.breakfast?.value).toBeNull(); // Never fabricated
  });

  it('isParkingAvailable handles varied affirmative phrases', () => {
    expect(isParkingAvailable('가능')).toBe(true);
    expect(isParkingAvailable('주차 가능')).toBe(true);
    expect(isParkingAvailable('가능요금 (무료)')).toBe(true);
    expect(isParkingAvailable('가능(1객실당 1대 가능)')).toBe(true);
    expect(isParkingAvailable('주차 불가')).toBe(false);
    expect(isParkingAvailable('불가')).toBe(false);
    expect(isParkingAvailable('')).toBeNull();
  });
});
