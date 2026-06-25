import 'dotenv/config';
import express from 'express';
import path from 'path';
import { connectRedis } from './services/redis';
import { connectDB } from './services/db';
import profileRoutes from './routes/profile';
import notificationRoutes from './routes/notifications';
import reportRoutes from './routes/reports';
import mediaRoutes from './routes/media';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'index.html'));
});

app.get('/health', (_, res) => res.json({
  status: 'ok', service: 'civians-api', ts: new Date().toISOString(),
}));

app.use('/profile', profileRoutes);
app.use('/notifications', notificationRoutes);
app.use('/reports', reportRoutes);
app.use('/media', mediaRoutes);

app.use((_, res) => res.status(404).json({ error: 'Route not found' }));

(async () => {
  await connectDB();
  await connectRedis();

  app.listen(PORT, () => {
    console.log(`\n🚨 Civians API — port ${PORT}`);
    console.log(`\n   [BunnyDB]`);
    console.log(`   POST   /profile                      → Register device`);
    console.log(`   GET    /profile/me                   → My profile`);
    console.log(`   PUT    /profile/me                   → Update profile`);
    console.log(`   PATCH  /profile/me/location          → Update GPS`);
    console.log(`\n   [Redis — Official, TTL 7d]`);
    console.log(`   POST   /notifications/official       → Create`);
    console.log(`   GET    /notifications/official       → List`);
    console.log(`\n   [Redis — Unofficial, TTL 3d]`);
    console.log(`   POST   /notifications/unofficial     → Create`);
    console.log(`   GET    /notifications/unofficial     → List`);
    console.log(`\n   [Redis — Shared]`);
    console.log(`   GET    /notifications/:id            → Single`);
    console.log(`   PATCH  /notifications/:id            → Edit (owner only)`);
    console.log(`   DELETE /notifications/:id            → Delete (owner only)`);
    console.log(`   POST   /notifications/:id/confirm    → Confirm`);
    console.log(`   DELETE /notifications/:id/confirm    → Remove confirm`);
    console.log(`\n   [Redis — Reports, TTL 24h]`);
    console.log(`   POST   /reports                      → Submit`);
    console.log(`\n   [Bunny CDN - media upload]`);
    console.log(`   POST   /media/upload               → Upload photos/videos (multipart)`);
    console.log(`   GET    /reports                      → List (?type=...)\n`);
  });
})();
