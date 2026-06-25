import request from 'supertest';
import { buildApp } from './app';
import redisMock, { redisMock as redis } from '../__mocks__/redis';
import { readDBMock, writeDBMock } from '../__mocks__/db';
import * as onesignalMock from '../__mocks__/onesignal';



const app = buildApp();

const DEVICE_ID = 'test-device-001';
const PROFILE   = { device_id: DEVICE_ID, name: 'Juan Pérez', phone: '+573001234567' };

const VALID_LOCATION = {
  coordinates: [-75.5812, 6.2442],
  name: 'Medellín, Colombia',
  city: 'Medellín',
};

const OFFICIAL_PAYLOAD = {
  title: 'Sismo M5.2 Medellín',
  description: 'Se registró un sismo de magnitud 5.2',
  event_type: 'sismo',
  severity: 'critical',
  location: VALID_LOCATION,
  characteristics: { magnitude: 5.2, depth_km: 10 },
  issued_by: 'SGC Colombia',
};

const UNOFFICIAL_PAYLOAD = {
  title: 'Veo humo en el cerro',
  description: 'Hay humo saliendo del cerro El Volador',
  event_type: 'incendio',
  severity: 'warning',
  location: VALID_LOCATION,
};

function seedProfile() {
  readDBMock._profiles[DEVICE_ID] = PROFILE;
}

beforeEach(() => {
  readDBMock._reset();
  redisMock._reset();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /notifications/official', () => {
  it('creates an official notification and returns 201', async () => {
    seedProfile();
    const res = await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send(OFFICIAL_PAYLOAD);

    expect(res.status).toBe(201);
    expect(res.body.notification.kind).toBe('official');
    expect(res.body.notification.id).toBeDefined();
    expect(res.body.notification.created_by).toBe(DEVICE_ID);
  });

  it('stores the notification in Redis', async () => {
    seedProfile();
    await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send(OFFICIAL_PAYLOAD);

    expect(redisMock.set).toHaveBeenCalledWith(
      expect.stringContaining('notification:'),
      expect.any(String),
      { EX: 60 * 60 * 24 * 7 }, // 7 days TTL
    );
  });

  it('adds to the official sorted set', async () => {
    seedProfile();
    await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send(OFFICIAL_PAYLOAD);

    expect(redisMock.zAdd).toHaveBeenCalledWith(
      'notifications:official',
      expect.objectContaining({ value: expect.any(String) }),
    );
  });

  it('fires push notification', async () => {
    seedProfile();
    await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send(OFFICIAL_PAYLOAD);

    // Give fire-and-forget a tick to run
    await new Promise((r) => setImmediate(r));
    expect(onesignalMock.sendPushToNearbyUsers).toHaveBeenCalled();
  });

  it('returns 400 when location is missing', async () => {
    seedProfile();
    const { location, ...noLocation } = OFFICIAL_PAYLOAD;
    const res = await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send(noLocation);
    expect(res.status).toBe(400);
  });

  it('returns 400 when coordinates are missing', async () => {
    seedProfile();
    const res = await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send({
        ...OFFICIAL_PAYLOAD,
        location: { name: 'Medellín' }, // no coordinates
      });
    expect(res.status).toBe(400);
  });

  it('returns 400 with invalid severity', async () => {
    seedProfile();
    const res = await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send({ ...OFFICIAL_PAYLOAD, severity: 'extreme' });
    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).post('/notifications/official').send(OFFICIAL_PAYLOAD);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /notifications/unofficial', () => {
  it('creates an unofficial notification and returns 201', async () => {
    seedProfile();
    const res = await request(app)
      .post('/notifications/unofficial')
      .set('x-api-key', DEVICE_ID)
      .send(UNOFFICIAL_PAYLOAD);

    expect(res.status).toBe(201);
    expect(res.body.notification.kind).toBe('unofficial');
    expect(res.body.notification.created_by).toBe(DEVICE_ID);
  });

  it('stores with 3-day TTL', async () => {
    seedProfile();
    await request(app)
      .post('/notifications/unofficial')
      .set('x-api-key', DEVICE_ID)
      .send(UNOFFICIAL_PAYLOAD);

    expect(redisMock.set).toHaveBeenCalledWith(
      expect.stringContaining('notification:'),
      expect.any(String),
      { EX: 60 * 60 * 24 * 3 }, // 3 days TTL
    );
  });

  it('does not accept characteristics or issued_by fields', async () => {
    seedProfile();
    const res = await request(app)
      .post('/notifications/unofficial')
      .set('x-api-key', DEVICE_ID)
      .send({ ...UNOFFICIAL_PAYLOAD, characteristics: { magnitude: 5 }, issued_by: 'SGC' });

    // Should still succeed but extra fields are stripped by zod
    expect(res.status).toBe(201);
    expect(res.body.notification.characteristics).toBeUndefined();
    expect(res.body.notification.issued_by).toBeUndefined();
  });

  it('returns 400 when title is missing', async () => {
    seedProfile();
    const { title, ...noTitle } = UNOFFICIAL_PAYLOAD;
    const res = await request(app)
      .post('/notifications/unofficial')
      .set('x-api-key', DEVICE_ID)
      .send(noTitle);
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /notifications/official', () => {
  async function createOfficial() {
    seedProfile();
    return request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send(OFFICIAL_PAYLOAD);
  }

  it('returns list of official notifications', async () => {
    await createOfficial();
    const res = await request(app)
      .get('/notifications/official')
      .set('x-api-key', DEVICE_ID);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.notifications)).toBe(true);
    expect(res.body.notifications.length).toBeGreaterThan(0);
  });

  it('includes confirmations and confirmed_by_me fields', async () => {
    await createOfficial();
    const res = await request(app)
      .get('/notifications/official')
      .set('x-api-key', DEVICE_ID);

    const n = res.body.notifications[0];
    expect(n.confirmations).toBeDefined();
    expect(n.confirmed_by_me).toBeDefined();
  });

  it('returns empty array when no notifications exist', async () => {
    seedProfile();
    const res = await request(app)
      .get('/notifications/official')
      .set('x-api-key', DEVICE_ID);
    expect(res.status).toBe(200);
    expect(res.body.notifications).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /notifications/:id', () => {
  it('returns a single notification by id', async () => {
    seedProfile();
    const createRes = await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send(OFFICIAL_PAYLOAD);

    const { id } = createRes.body.notification;
    const res = await request(app)
      .get(`/notifications/${id}`)
      .set('x-api-key', DEVICE_ID);

    expect(res.status).toBe(200);
    expect(res.body.notification.id).toBe(id);
    expect(res.body.notification.confirmations).toBeDefined();
  });

  it('returns 404 for unknown id', async () => {
    seedProfile();
    const res = await request(app)
      .get('/notifications/non-existent-id')
      .set('x-api-key', DEVICE_ID);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PATCH /notifications/:id', () => {
  it('allows owner to update notification', async () => {
    seedProfile();
    const createRes = await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send(OFFICIAL_PAYLOAD);

    const { id } = createRes.body.notification;
    const res = await request(app)
      .patch(`/notifications/${id}`)
      .set('x-api-key', DEVICE_ID)
      .send({ description: 'Actualización: sin réplicas reportadas' });

    expect(res.status).toBe(200);
    expect(res.body.notification.description).toBe('Actualización: sin réplicas reportadas');
    expect(res.body.notification.updated_by).toBe(DEVICE_ID);
  });

  it('returns 403 when non-owner tries to edit', async () => {
    seedProfile();
    const createRes = await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send(OFFICIAL_PAYLOAD);

    const { id } = createRes.body.notification;

    // Seed a different user
    readDBMock._profiles['other-device'] = { device_id: 'other-device', name: 'Otro', phone: '+57111' };

    const res = await request(app)
      .patch(`/notifications/${id}`)
      .set('x-api-key', 'other-device')
      .send({ description: 'Intento de edición' });

    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown id', async () => {
    seedProfile();
    const res = await request(app)
      .patch('/notifications/bad-id')
      .set('x-api-key', DEVICE_ID)
      .send({ title: 'x' });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('DELETE /notifications/:id', () => {
  it('allows owner to delete notification', async () => {
    seedProfile();
    const createRes = await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send(OFFICIAL_PAYLOAD);

    const { id } = createRes.body.notification;
    const res = await request(app)
      .delete(`/notifications/${id}`)
      .set('x-api-key', DEVICE_ID);

    expect(res.status).toBe(200);
    expect(redisMock.del).toHaveBeenCalledWith(`notification:${id}`);
  });

  it('returns 403 when non-owner tries to delete', async () => {
    seedProfile();
    const createRes = await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send(OFFICIAL_PAYLOAD);

    const { id } = createRes.body.notification;
    readDBMock._profiles['intruder'] = { device_id: 'intruder', name: 'X', phone: '+57000' };

    const res = await request(app)
      .delete(`/notifications/${id}`)
      .set('x-api-key', 'intruder');

    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown id', async () => {
    seedProfile();
    const res = await request(app)
      .delete('/notifications/bad-id')
      .set('x-api-key', DEVICE_ID);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /notifications/:id/confirm', () => {
  it('confirms a notification and increments count', async () => {
    seedProfile();
    const createRes = await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send(OFFICIAL_PAYLOAD);

    const { id } = createRes.body.notification;
    const res = await request(app)
      .post(`/notifications/${id}/confirm`)
      .set('x-api-key', DEVICE_ID);

    expect(res.status).toBe(200);
    expect(res.body.confirmations).toBe(1);
  });

  it('prevents double confirmation from same device', async () => {
    seedProfile();
    const createRes = await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send(OFFICIAL_PAYLOAD);

    const { id } = createRes.body.notification;
    await request(app).post(`/notifications/${id}/confirm`).set('x-api-key', DEVICE_ID);
    const res = await request(app).post(`/notifications/${id}/confirm`).set('x-api-key', DEVICE_ID);

    expect(res.status).toBe(409);
  });

  it('updates ranking score in sorted set on confirm', async () => {
    seedProfile();
    const createRes = await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send(OFFICIAL_PAYLOAD);

    const { id } = createRes.body.notification;
    await request(app).post(`/notifications/${id}/confirm`).set('x-api-key', DEVICE_ID);

    expect(redisMock.zAdd).toHaveBeenCalledWith(
      'notifications:official',
      { score: 1, value: id },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('DELETE /notifications/:id/confirm', () => {
  it('removes a confirmation', async () => {
    seedProfile();
    const createRes = await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send(OFFICIAL_PAYLOAD);

    const { id } = createRes.body.notification;
    await request(app).post(`/notifications/${id}/confirm`).set('x-api-key', DEVICE_ID);
    const res = await request(app).delete(`/notifications/${id}/confirm`).set('x-api-key', DEVICE_ID);

    expect(res.status).toBe(200);
    expect(res.body.confirmations).toBe(0);
  });

  it('returns 409 if user never confirmed', async () => {
    seedProfile();
    const createRes = await request(app)
      .post('/notifications/official')
      .set('x-api-key', DEVICE_ID)
      .send(OFFICIAL_PAYLOAD);

    const { id } = createRes.body.notification;
    const res = await request(app)
      .delete(`/notifications/${id}/confirm`)
      .set('x-api-key', DEVICE_ID);

    expect(res.status).toBe(409);
  });
});
