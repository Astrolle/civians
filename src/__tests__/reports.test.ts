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
  neighborhood: 'El Poblado',
  city: 'Medellín',
};

function seedProfile(id = DEVICE_ID, overrides = {}) {
  readDBMock._profiles[id] = { device_id: id, ...PROFILE, ...overrides };
}

beforeEach(() => {
  readDBMock._reset();
  redisMock._reset();
  jest.clearAllMocks();
  // Re-attach mock implementations after clearAllMocks
  onesignalMock.sendPushToNearbyUsers.mockResolvedValue({ sent: 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /reports — validation', () => {
  it('returns 400 when type is missing', async () => {
    seedProfile();
    const res = await request(app)
      .post('/reports')
      .set('x-api-key', DEVICE_ID)
      .send({ location: VALID_LOCATION, message: 'test' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when type is invalid', async () => {
    seedProfile();
    const res = await request(app)
      .post('/reports')
      .set('x-api-key', DEVICE_ID)
      .send({ type: 'tipo_invalido', location: VALID_LOCATION });
    expect(res.status).toBe(400);
  });

  it('returns 400 when location is missing', async () => {
    seedProfile();
    const res = await request(app)
      .post('/reports')
      .set('x-api-key', DEVICE_ID)
      .send({ type: 'estoy_en_peligro' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when coordinates are missing from location', async () => {
    seedProfile();
    const res = await request(app)
      .post('/reports')
      .set('x-api-key', DEVICE_ID)
      .send({ type: 'estoy_en_peligro', location: { city: 'Medellín' } });
    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/reports')
      .send({ type: 'estoy_en_peligro', location: VALID_LOCATION });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /reports — all 6 types', () => {
  const types = [
    'estoy_en_peligro',
    'busco_a_alguien',
    'necesito_ayuda',
    'ofrezco_refugio',
    'informo_algo',
    'estoy_a_salvo',
  ] as const;

  for (const type of types) {
    it(`creates report of type "${type}"`, async () => {
      seedProfile();
      const res = await request(app)
        .post('/reports')
        .set('x-api-key', DEVICE_ID)
        .send({ type, location: VALID_LOCATION, message: `Reporte de tipo ${type}` });

      expect(res.status).toBe(201);
      expect(res.body.report.type).toBe(type);
      expect(res.body.report.id).toBeDefined();
      expect(res.body.report.created_by ?? res.body.report.device_id).toBe(DEVICE_ID);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /reports — ofrezco_refugio amenities', () => {
  const AMENITIES = {
    agua_potable: true,
    comida: true,
    espacio_para_dormir: true,
    ropa_y_abrigo: false,
    electricidad: true,
    carga_de_celular: true,
    wifi_senal: true,
    bano_y_ducha: true,
    botiquin_y_medicinas: false,
    acepta_mascotas: false,
    apto_para_ninos: true,
    acceso_silla_ruedas: false,
    capacity: 8,
    notes: 'Traer cobijas',
  };

  it('accepts all 12 amenity fields', async () => {
    seedProfile();
    const res = await request(app)
      .post('/reports')
      .set('x-api-key', DEVICE_ID)
      .send({ type: 'ofrezco_refugio', location: VALID_LOCATION, amenities: AMENITIES });

    expect(res.status).toBe(201);
    expect(res.body.report.amenities.agua_potable).toBe(true);
    expect(res.body.report.amenities.capacity).toBe(8);
    expect(res.body.report.amenities.acceso_silla_ruedas).toBe(false);
  });

  it('accepts partial amenities', async () => {
    seedProfile();
    const res = await request(app)
      .post('/reports')
      .set('x-api-key', DEVICE_ID)
      .send({
        type: 'ofrezco_refugio',
        location: VALID_LOCATION,
        amenities: { agua_potable: true, capacity: 4 },
      });
    expect(res.status).toBe(201);
  });

  it('accepts ofrezco_refugio without amenities', async () => {
    seedProfile();
    const res = await request(app)
      .post('/reports')
      .set('x-api-key', DEVICE_ID)
      .send({ type: 'ofrezco_refugio', location: VALID_LOCATION });
    expect(res.status).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /reports — push behavior', () => {
  const URGENT_TYPES = ['estoy_en_peligro', 'necesito_ayuda', 'busco_a_alguien'] as const;
  const NON_URGENT  = ['ofrezco_refugio', 'informo_algo', 'estoy_a_salvo'] as const;

  for (const type of URGENT_TYPES) {
    it(`fires push for urgent type "${type}"`, async () => {
      seedProfile();
      await request(app)
        .post('/reports')
        .set('x-api-key', DEVICE_ID)
        .send({ type, location: VALID_LOCATION });
      await new Promise((r) => setImmediate(r));
      expect(onesignalMock.sendPushToNearbyUsers).toHaveBeenCalled();
    });
  }

  for (const type of NON_URGENT) {
    it(`does NOT fire push for non-urgent type "${type}"`, async () => {
      seedProfile();
      await request(app)
        .post('/reports')
        .set('x-api-key', DEVICE_ID)
        .send({ type, location: VALID_LOCATION });
      await new Promise((r) => setImmediate(r));
      expect(onesignalMock.sendPushToNearbyUsers).not.toHaveBeenCalled();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /reports — Redis storage', () => {
  it('stores report in Redis with 24h TTL', async () => {
    seedProfile();
    await request(app)
      .post('/reports')
      .set('x-api-key', DEVICE_ID)
      .send({ type: 'estoy_en_peligro', location: VALID_LOCATION });

    expect(redisMock.set).toHaveBeenCalledWith(
      expect.stringContaining('report:'),
      expect.any(String),
      { EX: 60 * 60 * 24 },
    );
  });

  it('indexes report in global and type sorted sets', async () => {
    seedProfile();
    await request(app)
      .post('/reports')
      .set('x-api-key', DEVICE_ID)
      .send({ type: 'informo_algo', location: VALID_LOCATION });

    expect(redisMock.zAdd).toHaveBeenCalledWith('reports:all', expect.any(Object));
    expect(redisMock.zAdd).toHaveBeenCalledWith('reports:type:informo_algo', expect.any(Object));
    expect(redisMock.zAdd).toHaveBeenCalledWith(`reports:device:${DEVICE_ID}`, expect.any(Object));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /reports', () => {
  it('returns all reports', async () => {
    seedProfile();
    await request(app)
      .post('/reports')
      .set('x-api-key', DEVICE_ID)
      .send({ type: 'estoy_a_salvo', location: VALID_LOCATION });

    const res = await request(app).get('/reports').set('x-api-key', DEVICE_ID);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.reports)).toBe(true);
  });

  it('filters by type', async () => {
    seedProfile();
    await request(app)
      .post('/reports')
      .set('x-api-key', DEVICE_ID)
      .send({ type: 'ofrezco_refugio', location: VALID_LOCATION });

    const res = await request(app)
      .get('/reports?type=ofrezco_refugio')
      .set('x-api-key', DEVICE_ID);
    expect(res.status).toBe(200);
  });

  it('returns 401 without auth', async () => {
    const res = await request(app).get('/reports');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /reports/me', () => {
  it('returns only reports from current device', async () => {
    seedProfile();
    await request(app)
      .post('/reports')
      .set('x-api-key', DEVICE_ID)
      .send({ type: 'estoy_a_salvo', location: VALID_LOCATION });

    const res = await request(app).get('/reports/me').set('x-api-key', DEVICE_ID);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.reports)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /reports/:id', () => {
  it('returns a single report', async () => {
    seedProfile();
    const createRes = await request(app)
      .post('/reports')
      .set('x-api-key', DEVICE_ID)
      .send({ type: 'necesito_ayuda', location: VALID_LOCATION, message: 'Necesito médico' });

    const { id } = createRes.body.report;
    const res = await request(app).get(`/reports/${id}`).set('x-api-key', DEVICE_ID);
    expect(res.status).toBe(200);
    expect(res.body.report.id).toBe(id);
  });

  it('returns 404 for unknown id', async () => {
    seedProfile();
    const res = await request(app).get('/reports/does-not-exist').set('x-api-key', DEVICE_ID);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('DELETE /reports/:id', () => {
  it('allows owner to deactivate report', async () => {
    seedProfile();
    const createRes = await request(app)
      .post('/reports')
      .set('x-api-key', DEVICE_ID)
      .send({ type: 'estoy_a_salvo', location: VALID_LOCATION });

    const { id } = createRes.body.report;
    const res = await request(app).delete(`/reports/${id}`).set('x-api-key', DEVICE_ID);
    expect(res.status).toBe(200);
  });

  it('returns 403 when non-owner tries to delete', async () => {
    seedProfile();
    const createRes = await request(app)
      .post('/reports')
      .set('x-api-key', DEVICE_ID)
      .send({ type: 'estoy_a_salvo', location: VALID_LOCATION });

    const { id } = createRes.body.report;
    readDBMock._profiles['other'] = { device_id: 'other', name: 'X', phone: '+57000' };

    const res = await request(app).delete(`/reports/${id}`).set('x-api-key', 'other');
    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown report', async () => {
    seedProfile();
    const res = await request(app).delete('/reports/ghost-id').set('x-api-key', DEVICE_ID);
    expect(res.status).toBe(404);
  });
});
