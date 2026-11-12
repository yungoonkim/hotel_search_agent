import pg from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function formatCsvValue(v: unknown): string {
  if (v === null || v === undefined) {
    return '';
  }
  if (typeof v === 'boolean') {
    return v ? 'true' : 'false';
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? String(v) : '';
  }
  if (v instanceof Date) {
    return v.toISOString();
  }
  if (typeof v === 'object') {
    v = JSON.stringify(v);
  }
  const s = String(v);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r') || s === '') {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsvString(headers: string[], rows: Record<string, unknown>[]): string {
  const BOM = '\uFEFF';
  const headerLine = headers.map(h => formatCsvValue(h)).join(',');
  const lines = [headerLine];
  for (const row of rows) {
    lines.push(headers.map(h => formatCsvValue(row[h])).join(','));
  }
  return BOM + lines.join('\r\n') + '\r\n';
}

export interface ExportResult {
  hotels: number;
  rooms: number;
  roomBeds: number;
  hotelAmenities: number;
  attributeEvidence: number;
  dataQuality: number;
  outputDir: string;
  files: string[];
}

export interface DbConnection {
  query(queryText: string, values?: any[]): Promise<{ rows: any[] }>;
}

export async function exportToCsv(pool: DbConnection, outputDir = 'data/exports'): Promise<ExportResult> {
  await mkdir(outputDir, { recursive: true });

  // 1. hotels.csv
  const hotelsRes = await pool.query(`
    SELECT hotel_id, name, name_en, address, latitude, longitude, hotel_type, description, created_at, updated_at
    FROM hotels
    ORDER BY hotel_id ASC
  `);
  const hotelsHeaders = ['hotel_id', 'name', 'name_en', 'address', 'latitude', 'longitude', 'hotel_type', 'description', 'created_at', 'updated_at'];
  await writeFile(join(outputDir, 'hotels.csv'), toCsvString(hotelsHeaders, hotelsRes.rows), 'utf-8');

  // 2. rooms.csv
  const roomsRes = await pool.query(`
    SELECT room_id, hotel_id, room_name, room_size, base_occupancy, max_occupancy, view_type, shower, bathtub, created_at, updated_at
    FROM rooms
    ORDER BY hotel_id ASC, room_id ASC
  `);
  const roomsHeaders = ['room_id', 'hotel_id', 'room_name', 'room_size', 'base_occupancy', 'max_occupancy', 'view_type', 'shower', 'bathtub', 'created_at', 'updated_at'];
  await writeFile(join(outputDir, 'rooms.csv'), toCsvString(roomsHeaders, roomsRes.rows), 'utf-8');

  // 3. room_beds.csv
  const bedsRes = await pool.query(`
    SELECT room_id, bed_type, count
    FROM room_beds
    ORDER BY room_id ASC, bed_type ASC
  `);
  const bedsHeaders = ['room_id', 'bed_type', 'count'];
  await writeFile(join(outputDir, 'room_beds.csv'), toCsvString(bedsHeaders, bedsRes.rows), 'utf-8');

  // 4. hotel_amenities.csv
  const amenitiesRes = await pool.query(`
    SELECT hotel_id, amenity, value, status
    FROM hotel_amenities
    ORDER BY hotel_id ASC, amenity ASC
  `);
  const amenitiesHeaders = ['hotel_id', 'amenity', 'value', 'status'];
  await writeFile(join(outputDir, 'hotel_amenities.csv'), toCsvString(amenitiesHeaders, amenitiesRes.rows), 'utf-8');

  // 5. attribute_evidence.csv
  const evidenceRes = await pool.query(`
    SELECT evidence_id, hotel_id, room_id, attribute, value, status, source, record_id, source_url, collected_at, evidence_text
    FROM attribute_evidence
    ORDER BY evidence_id ASC
  `);
  const evidenceHeaders = ['evidence_id', 'hotel_id', 'room_id', 'attribute', 'value', 'status', 'source', 'record_id', 'source_url', 'collected_at', 'evidence_text'];
  await writeFile(join(outputDir, 'attribute_evidence.csv'), toCsvString(evidenceHeaders, evidenceRes.rows), 'utf-8');

  // 6. data_quality.csv
  const qualityRes = await pool.query(`
    SELECT 
      h.hotel_id,
      h.name,
      h.hotel_type,
      COUNT(DISTINCT r.room_id)::int AS room_count,
      COUNT(DISTINCT CASE WHEN r.attributes->'roomName'->>'value' IS NOT NULL THEN r.room_id END)::int AS verified_room_count,
      COUNT(DISTINCT CASE WHEN ha.status = 'verified' THEN ha.amenity END)::int AS verified_amenity_count,
      COUNT(DISTINCT CASE WHEN ha.status = 'missing' THEN ha.amenity END)::int AS missing_amenity_count,
      ROUND(COUNT(DISTINCT CASE WHEN ha.status = 'verified' THEN ha.amenity END)::numeric / 6.0, 4) AS amenity_verified_ratio,
      CASE 
        WHEN COUNT(DISTINCT CASE WHEN ha.status = 'missing' THEN ha.amenity END) > 0 OR COUNT(DISTINCT r.room_id) = 0 THEN true 
        ELSE false 
      END AS needs_enrichment
    FROM hotels h
    LEFT JOIN rooms r ON h.hotel_id = r.hotel_id
    LEFT JOIN hotel_amenities ha ON h.hotel_id = ha.hotel_id
    GROUP BY h.hotel_id, h.name, h.hotel_type
    ORDER BY h.hotel_id ASC
  `);
  const qualityHeaders = ['hotel_id', 'name', 'hotel_type', 'room_count', 'verified_room_count', 'verified_amenity_count', 'missing_amenity_count', 'amenity_verified_ratio', 'needs_enrichment'];
  await writeFile(join(outputDir, 'data_quality.csv'), toCsvString(qualityHeaders, qualityRes.rows), 'utf-8');

  return {
    hotels: hotelsRes.rows.length,
    rooms: roomsRes.rows.length,
    roomBeds: bedsRes.rows.length,
    hotelAmenities: amenitiesRes.rows.length,
    attributeEvidence: evidenceRes.rows.length,
    dataQuality: qualityRes.rows.length,
    outputDir,
    files: [
      'hotels.csv',
      'rooms.csv',
      'room_beds.csv',
      'hotel_amenities.csv',
      'attribute_evidence.csv',
      'data_quality.csv'
    ]
  };
}
