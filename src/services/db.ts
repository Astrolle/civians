import { createClient, Client } from '@libsql/client';

let writeDB: Client;
let readDB: Client;

export const connectDB = async (): Promise<void> => {
  writeDB = createClient({
    url: process.env.BUNNY_DATABASE_URL!,
    authToken: process.env.BUNNY_DATABASE_AUTH_TOKEN!,
  });

  readDB = createClient({
    url: process.env.BUNNY_DATABASE_URL!,
    authToken: process.env.BUNNY_DATABASE_READ_ONLY_AUTH_TOKEN!,
  });

  // Init schema (write client)
  await writeDB.execute(`
    CREATE TABLE IF NOT EXISTS profiles (
      device_id     TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      phone         TEXT NOT NULL,
      city          TEXT,
      country       TEXT,
      latitude      REAL,
      longitude     REAL,
      registered_at TEXT NOT NULL,
      updated_at    TEXT
    )
  `);

  console.log('[BunnyDB] Connected and ready');
};

/** Use for INSERT / UPDATE / DELETE */
export const getWriteDB = (): Client => {
  if (!writeDB) throw new Error('DB not initialized. Call connectDB() first.');
  return writeDB;
};

/** Use for SELECT */
export const getReadDB = (): Client => {
  if (!readDB) throw new Error('DB not initialized. Call connectDB() first.');
  return readDB;
};
