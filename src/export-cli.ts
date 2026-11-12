import 'dotenv/config';
import pg from 'pg';
import { exportToCsv } from './export.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing in environment.');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const result = await exportToCsv(pool);
  console.log(JSON.stringify({
    event: 'export_completed',
    outputDir: result.outputDir,
    counts: {
      hotels: result.hotels,
      rooms: result.rooms,
      room_beds: result.roomBeds,
      hotel_amenities: result.hotelAmenities,
      attribute_evidence: result.attributeEvidence,
      data_quality: result.dataQuality
    },
    files: result.files
  }, null, 2));
} finally {
  await pool.end();
}
