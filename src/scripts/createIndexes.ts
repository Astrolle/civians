import 'dotenv/config';
import { connectMongo, getMongo } from '../services/db';

async function createIndexes() {
  await connectMongo();
  const db = getMongo();

  console.log('Creating indexes...\n');

  // notifications
  await db.collection('notifications').createIndex({ 'location.geo': '2dsphere' });
  console.log('✅ notifications: location.geo 2dsphere');
  await db.collection('notifications').createIndex({ kind: 1, is_active: 1 });
  console.log('✅ notifications: kind + is_active');
  await db.collection('notifications').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  console.log('✅ notifications: expires_at TTL');

  // reports
  await db.collection('reports').createIndex({ 'location.geo': '2dsphere' });
  console.log('✅ reports: location.geo 2dsphere');
  await db.collection('reports').createIndex({ device_id: 1 });
  console.log('✅ reports: device_id');
  await db.collection('reports').createIndex({ type: 1, is_active: 1 });
  console.log('✅ reports: type + is_active');
  await db.collection('reports').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  console.log('✅ reports: expires_at TTL');

  // collection_centers
  await db.collection('collection_centers').createIndex({ 'location.geo': '2dsphere' });
  console.log('✅ collection_centers: location.geo 2dsphere');
  await db.collection('collection_centers').createIndex({ is_active: 1 });
  console.log('✅ collection_centers: is_active');

  console.log('\n✅ All indexes created successfully');
  process.exit(0);
}

createIndexes().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
