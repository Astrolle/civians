import 'dotenv/config';
import express from 'express';
import path from 'path';
import { connectDB, connectMongo } from './services/db';
import profileRoutes from './routes/profile';
import notificationRoutes from './routes/notifications';
import reportRoutes from './routes/reports';
import mediaRoutes from './routes/media';
import collectionCenterRoutes from './routes/collectionCenters';
import deceasedRoutes from './routes/deceased';
import migrateRoutes from './routes/migrate';

const app  = express();
const PORT = process.env.PORT || 3000;

// Only parse JSON for non-multipart requests — multer handles multipart/form-data
app.use((req, res, next) => {
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('multipart/form-data')) return next();
  express.json()(req, res, next);
});
app.use((req, res, next) => {
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('multipart/form-data')) return next();
  express.urlencoded({ extended: true })(req, res, next);
});

// Increase timeout for large video uploads (10 minutes)
app.use((req, res, next) => {
  res.setTimeout(10 * 60 * 1000);
  next();
});

app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'index.html'));
});

app.get('/centrosdeacopio', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'centrosdeacopio.html'));
});

app.get('/health', (_, res) => res.json({
  status: 'ok', service: 'civians-api', ts: new Date().toISOString(),
}));

app.use('/profile', profileRoutes);
app.use('/notifications', notificationRoutes);
app.use('/reports', reportRoutes);
app.use('/media', mediaRoutes);
app.use('/collection-centers', collectionCenterRoutes);
app.use('/deceased', deceasedRoutes);
app.use('/admin', migrateRoutes); // TEMPORARY — remove after migration

app.use((_, res) => res.status(404).json({ error: 'Route not found' }));

(async () => {
  await connectDB();      // BunnyDB (profiles)
  await connectMongo();   // MongoDB (notifications + reports)

  app.listen(PORT, () => {
    console.log(`\n🚨 Civians API — port ${PORT}`);
    console.log(`\n   [BunnyDB]`);
    console.log(`   POST   /profile                      → Register device`);
    console.log(`   PATCH  /profile/me/location          → Update GPS`);
    console.log(`\n   [MongoDB - 2dsphere]`);
    console.log(`   POST   /notifications/official       → Create (push 5km)`);
    console.log(`   GET    /notifications/official       → List by city radius`);
    console.log(`   POST   /notifications/unofficial     → Create (push 5km)`);
    console.log(`   GET    /notifications/unofficial     → List by city radius`);
    console.log(`   GET    /notifications/map            → All pins for map`);
    console.log(`   POST   /reports                      → Submit (multipart)`);
    console.log(`   GET    /reports                      → List within 5km`);
    console.log(`   GET    /reports/map                  → All pins for map`);
    console.log(`   POST   /collection-centers           → Create center`);
    console.log(`   GET    /collection-centers           → List by proximity`);
    console.log(`   GET    /collection-centers/map       → All pins for map (device auth)`);
    console.log(`   GET    /collection-centers/public/map → All pins for map (no auth, public)`);
    console.log(`   GET    /collection-centers/external  → For partner apps (x-api-key)`);
    console.log(`   PATCH  /collection-centers/:id/collapse → Update status`);
    console.log(`\n   [Web]`);
    console.log(`   GET    /centrosdeacopio              → Public map view\n`);
  });
})();
