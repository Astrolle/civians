import 'dotenv/config';
import { connectDB, getWriteDB } from '../services/db';

async function migrate() {
  await connectDB();
  const db = getWriteDB();

  console.log('⚠️  Dropping existing profiles table...');
  await db.execute('DROP TABLE IF EXISTS profiles');
  console.log('✅ Table dropped');

  console.log('Creating profiles table with all columns...');
  await db.execute(`
    CREATE TABLE profiles (
      device_id        TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      phone            TEXT NOT NULL,
      city             TEXT,
      country          TEXT,
      latitude         REAL,
      longitude        REAL,
      search_radius_km REAL NOT NULL DEFAULT 5,
      is_official      INTEGER NOT NULL DEFAULT 0,
      official_org     TEXT,
      official_role    TEXT,
      registered_at    TEXT NOT NULL,
      updated_at       TEXT
    )
  `);
  console.log('✅ Table created with all columns');

  console.log('\nSchema:');
  const info = await db.execute("PRAGMA table_info(profiles)");
  info.rows.forEach((row: any) => {
    console.log(`  ${row.name} ${row.type} ${row.notnull ? 'NOT NULL' : ''} ${row.dflt_value ? `DEFAULT ${row.dflt_value}` : ''}`);
  });

  console.log('\n✅ Migration complete — all users will need to re-register.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
