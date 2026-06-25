import express from 'express';
import profileRoutes from '../routes/profile';
import notificationRoutes from '../routes/notifications';
import reportRoutes from '../routes/reports';

export function buildApp() {
  const app = express();
  app.use(express.json());
  app.get('/health', (_, res) => res.json({ status: 'ok' }));
  app.use('/profile', profileRoutes);
  app.use('/notifications', notificationRoutes);
  app.use('/reports', reportRoutes);
  app.use((_, res) => res.status(404).json({ error: 'Route not found' }));
  return app;
}
