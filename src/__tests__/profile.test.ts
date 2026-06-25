import request from 'supertest';
import { buildApp } from './app';
import redisMock, { redisMock as redis } from '../__mocks__/redis';
import { readDBMock, writeDBMock } from '../__mocks__/db';
import * as onesignalMock from '../__mocks__/onesignal';

// ─── Module mocks ─────────────────────────────────────────────────────────────


// ─── Setup ────────────────────────────────────────────────────────────────────
const app = buildApp();

const DEVICE_ID = 'test-device-001';
const PROFILE   = { device_id: DEVICE_ID, name: 'Juan Pérez', phone: '+573001234567' };

// Seed a profile in the mock DB so auth middleware finds it
function seedProfile(overrides = {}) {
  readDBMock._profiles[DEVICE_ID] = { ...PROFILE, ...overrides };
}

beforeEach(() => {
  readDBMock._reset();
  redisMock._reset();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /profile', () => {
  it('registers a new device and returns the api_key', async () => {
    const res = await request(app).post('/profile').send(PROFILE);

    expect(res.status).toBe(201);
    expect(res.body.api_key).toBe(DEVICE_ID);
    expect(res.body.profile.name).toBe('Juan Pérez');
    expect(writeDBMock.execute).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when device_id is missing', async () => {
    const res = await request(app).post('/profile').send({ name: 'Juan', phone: '+57300' });
    expect(res.status).toBe(400);
    expect(res.body.error.device_id).toBeDefined();
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app).post('/profile').send({ device_id: 'x', phone: '+57300' });
    expect(res.status).toBe(400);
    expect(res.body.error.name).toBeDefined();
  });

  it('returns 400 when phone is too short', async () => {
    const res = await request(app).post('/profile').send({ device_id: 'x', name: 'Juan', phone: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error.phone).toBeDefined();
  });

  it('accepts optional city and country on registration', async () => {
    const res = await request(app).post('/profile').send({
      ...PROFILE, city: 'Medellín', country: 'Colombia',
    });
    expect(res.status).toBe(201);
    expect(res.body.profile.city).toBe('Medellín');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /profile/me', () => {
  it('returns the profile for an authenticated device', async () => {
    seedProfile();
    const res = await request(app).get('/profile/me').set('x-api-key', DEVICE_ID);
    expect(res.status).toBe(200);
    expect(res.body.profile.device_id).toBe(DEVICE_ID);
  });

  it('returns 401 when no api key is provided', async () => {
    const res = await request(app).get('/profile/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown device_id', async () => {
    const res = await request(app).get('/profile/me').set('x-api-key', 'unknown-device');
    expect(res.status).toBe(401);
  });

  it('accepts Authorization: Bearer header as api key', async () => {
    seedProfile();
    const res = await request(app)
      .get('/profile/me')
      .set('Authorization', `Bearer ${DEVICE_ID}`);
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PUT /profile/me', () => {
  it('updates name', async () => {
    seedProfile();
    const res = await request(app)
      .put('/profile/me')
      .set('x-api-key', DEVICE_ID)
      .send({ name: 'Carlos López' });
    expect(res.status).toBe(200);
    expect(writeDBMock.execute).toHaveBeenCalled();
  });

  it('updates phone', async () => {
    seedProfile();
    const res = await request(app)
      .put('/profile/me')
      .set('x-api-key', DEVICE_ID)
      .send({ phone: '+573109876543' });
    expect(res.status).toBe(200);
  });

  it('returns 400 if phone is too short', async () => {
    seedProfile();
    const res = await request(app)
      .put('/profile/me')
      .set('x-api-key', DEVICE_ID)
      .send({ phone: '123' });
    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).put('/profile/me').send({ name: 'X' });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /profile/me/location', () => {
  it('updates GPS coordinates', async () => {
    seedProfile();
    const res = await request(app)
      .patch('/profile/me/location')
      .set('x-api-key', DEVICE_ID)
      .send({ latitude: 6.2442, longitude: -75.5812 });
    expect(res.status).toBe(200);
    expect(res.body.location.latitude).toBe(6.2442);
    expect(res.body.location.longitude).toBe(-75.5812);
    expect(writeDBMock.execute).toHaveBeenCalled();
  });

  it('returns 400 when latitude is missing', async () => {
    seedProfile();
    const res = await request(app)
      .patch('/profile/me/location')
      .set('x-api-key', DEVICE_ID)
      .send({ longitude: -75.5812 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when longitude is missing', async () => {
    seedProfile();
    const res = await request(app)
      .patch('/profile/me/location')
      .set('x-api-key', DEVICE_ID)
      .send({ latitude: 6.2442 });
    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .patch('/profile/me/location')
      .send({ latitude: 6.2442, longitude: -75.5812 });
    expect(res.status).toBe(401);
  });
});
