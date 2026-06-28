import { createClient, Client } from '@libsql/client';
import { MongoClient, Db, Collection } from 'mongodb';

// ─── BunnyDB (libSQL) — profiles ─────────────────────────────────────────────

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

  await writeDB.execute(`
    CREATE TABLE IF NOT EXISTS profiles (
      device_id     TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      phone         TEXT NOT NULL,
      city          TEXT,
      country       TEXT,
      latitude         REAL,
      longitude        REAL,
      search_radius_km REAL NOT NULL DEFAULT 5,
      is_official      INTEGER NOT NULL DEFAULT 0,  -- 0 = citizen, 1 = official
      official_org     TEXT,                         -- organization name (SGC, Cruz Roja, etc.)
      official_role    TEXT,                         -- role (Director, Coordinador, etc.)
      registered_at    TEXT NOT NULL,
      updated_at       TEXT
    )
  `);

  console.log('[BunnyDB] Connected and ready');
};

export const getWriteDB = (): Client => {
  if (!writeDB) throw new Error('DB not initialized. Call connectDB() first.');
  return writeDB;
};

export const getReadDB = (): Client => {
  if (!readDB) throw new Error('DB not initialized. Call connectDB() first.');
  return readDB;
};

// ─── MongoDB — notifications & reports ───────────────────────────────────────

let mongoClient: MongoClient;
let mongoDB: Db;

export const connectMongo = async (): Promise<void> => {
  mongoClient = new MongoClient(process.env.MONGODB_URI!);
  await mongoClient.connect();
  mongoDB = mongoClient.db('civians');

  // Force-create collections first so indexes can be applied immediately
  const existingCols = (await mongoDB.listCollections().toArray()).map((c) => c.name);

  for (const colName of ['notifications', 'reports', 'collection_centers']) {
    if (!existingCols.includes(colName)) {
      await mongoDB.createCollection(colName);
      console.log(`[MongoDB] Created collection: ${colName}`);
    }
  }

  // ── Notifications ──────────────────────────────────────────────────────────
  const notifications = mongoDB.collection('notifications');
  await notifications.createIndex({ 'location.geo': '2dsphere' });
  await notifications.createIndex({ kind: 1, is_active: 1 });
  await notifications.createIndex({ country: 1, kind: 1 });
  await notifications.createIndex({ event_type: 1 });
  await notifications.createIndex({ severity: 1 });
  await notifications.createIndex({ created_by: 1 });
  await notifications.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

  // ── Reports ────────────────────────────────────────────────────────────────
  const reports = mongoDB.collection('reports');
  await reports.createIndex({ 'location.geo': '2dsphere' });
  await reports.createIndex({ type: 1, is_active: 1 });
  await reports.createIndex({ device_id: 1 });
  await reports.createIndex({ category: 1 });
  await reports.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

  // ── Collection Centers ────────────────────────────────────────────────────
  const centers = mongoDB.collection('collection_centers');
  await centers.createIndex({ 'location.geo': '2dsphere' });
  await centers.createIndex({ is_active: 1 });
  await centers.createIndex({ created_by: 1 });
  await centers.createIndex({ collapse_pct: 1 });

  console.log('[MongoDB] Connected and indexes created');
};

export const getMongo = (): Db => {
  if (!mongoDB) throw new Error('MongoDB not initialized. Call connectMongo() first.');
  return mongoDB;
};

export const getCollection = (name: string): Collection => {
  return getMongo().collection(name);
};
