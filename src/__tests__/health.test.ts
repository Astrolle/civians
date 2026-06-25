import request from 'supertest';
import { buildApp } from './app';
import redisMock, { redisMock as redis } from '../__mocks__/redis';
import { readDBMock, writeDBMock } from '../__mocks__/db';
import * as onesignalMock from '../__mocks__/onesignal';



const app = buildApp();

beforeEach(() => {
  readDBMock._reset();
  redisMock._reset();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('does not require authentication', async () => {
    const res = await request(app).get('/health');
    expect(res.status).not.toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Auth middleware', () => {
  it('rejects request with no api key', async () => {
    const res = await request(app).get('/profile/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/API key required/i);
  });

  it('rejects request with unknown device_id', async () => {
    const res = await request(app)
      .get('/profile/me')
      .set('x-api-key', 'ghost-device-id');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid API key/i);
  });

  it('accepts x-api-key header', async () => {
    readDBMock._profiles['device-a'] = {
      device_id: 'device-a', name: 'Test', phone: '+57300',
    };
    const res = await request(app)
      .get('/profile/me')
      .set('x-api-key', 'device-a');
    expect(res.status).toBe(200);
  });

  it('accepts Authorization: Bearer header', async () => {
    readDBMock._profiles['device-b'] = {
      device_id: 'device-b', name: 'Test', phone: '+57300',
    };
    const res = await request(app)
      .get('/profile/me')
      .set('Authorization', 'Bearer device-b');
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('404 handler', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/ruta-que-no-existe');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Route not found');
  });
});
