import { createClient } from 'redis';

const client = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
    connectTimeout: 10000,
  },
});

client.on('error', (err) => console.error('[Redis] Error:', err));
client.on('connect', () => console.log('[Redis] Connected'));

export const connectRedis = async () => {
  await client.connect();
};

export default client;
