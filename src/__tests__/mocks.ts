// ─── In-memory Redis mock ────────────────────────────────────────────────────

const store: Record<string, { value: string; expiresAt?: number }> = {};
const sets: Record<string, Set<string>> = {};
const zsets: Record<string, Map<string, number>> = {};

function isExpired(key: string) {
  const entry = store[key];
  if (!entry) return true;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    delete store[key];
    return true;
  }
  return false;
}

export const redisMock = {
  get: jest.fn(async (key: string) => {
    if (isExpired(key)) return null;
    return store[key]?.value ?? null;
  }),
  set: jest.fn(async (key: string, value: string, opts?: { EX?: number; KEEPTTL?: boolean }) => {
    const expiresAt = opts?.EX ? Date.now() + opts.EX * 1000 : undefined;
    store[key] = { value, expiresAt };
    return 'OK';
  }),
  del: jest.fn(async (...keys: string[]) => {
    let count = 0;
    for (const key of keys) { if (store[key]) { delete store[key]; count++; } }
    return count;
  }),
  zAdd: jest.fn(async (key: string, entry: { score: number; value: string }) => {
    if (!zsets[key]) zsets[key] = new Map();
    zsets[key].set(entry.value, entry.score);
    return 1;
  }),
  zRange: jest.fn(async (key: string, start: number, stop: number, opts?: { REV?: boolean }) => {
    const zset = zsets[key];
    if (!zset) return [];
    const sorted = [...zset.entries()].sort((a, b) =>
      opts?.REV ? b[1] - a[1] : a[1] - b[1]
    );
    const slice = stop === -1 ? sorted.slice(start) : sorted.slice(start, stop + 1);
    return slice.map(([v]) => v);
  }),
  zCard: jest.fn(async (key: string) => zsets[key]?.size ?? 0),
  zRem: jest.fn(async (key: string, ...members: string[]) => {
    if (!zsets[key]) return 0;
    let count = 0;
    for (const m of members) { if (zsets[key].delete(m)) count++; }
    return count;
  }),
  sAdd: jest.fn(async (key: string, ...members: string[]) => {
    if (!sets[key]) sets[key] = new Set();
    members.forEach((m) => sets[key].add(m));
    return members.length;
  }),
  sRem: jest.fn(async (key: string, ...members: string[]) => {
    if (!sets[key]) return 0;
    let count = 0;
    members.forEach((m) => { if (sets[key].delete(m)) count++; });
    return count;
  }),
  sIsMember: jest.fn(async (key: string, member: string) => {
    return sets[key]?.has(member) ?? false;
  }),
  sCard: jest.fn(async (key: string) => sets[key]?.size ?? 0),
  on: jest.fn(),
  connect: jest.fn(),

  // Test utility: reset all state between tests
  _reset() {
    Object.keys(store).forEach((k) => delete store[k]);
    Object.keys(sets).forEach((k) => delete sets[k]);
    Object.keys(zsets).forEach((k) => delete zsets[k]);
    jest.clearAllMocks();
  },
};

// ─── In-memory BunnyDB mock ───────────────────────────────────────────────────

const profiles: Record<string, any> = {};

export const writeDBMock = {
  execute: jest.fn(async ({ sql, args }: { sql: string; args: Record<string, any> }) => {
    const s = sql.trim().toUpperCase();

    if (s.startsWith('CREATE TABLE')) {
      return { rows: [], rowsAffected: 0 };
    }

    if (s.startsWith('INSERT INTO PROFILES')) {
      const id = args.device_id as string;
      if (profiles[id]) {
        // ON CONFLICT DO UPDATE
        if (args.name)  profiles[id].name  = args.name;
        if (args.phone) profiles[id].phone = args.phone;
        if (args.city !== undefined)    profiles[id].city    = args.city;
        if (args.country !== undefined) profiles[id].country = args.country;
        profiles[id].updated_at = args.registered_at;
      } else {
        profiles[id] = { ...args, registered_at: args.registered_at };
      }
      return { rows: [], rowsAffected: 1 };
    }

    if (s.startsWith('UPDATE PROFILES SET')) {
      const id = args.device_id as string;
      if (!profiles[id]) return { rows: [], rowsAffected: 0 };
      Object.keys(args).forEach((k) => {
        if (k !== 'device_id') profiles[id][k] = args[k];
      });
      return { rows: [], rowsAffected: 1 };
    }

    return { rows: [], rowsAffected: 0 };
  }),
};

export const readDBMock = {
  execute: jest.fn(async ({ sql, args }: { sql: string; args: any[] | Record<string, any> }) => {
    const s = sql.trim().toUpperCase();

    if (s.includes('FROM PROFILES WHERE DEVICE_ID = ?')) {
      const id = Array.isArray(args) ? args[0] : args.device_id;
      const row = profiles[id as string];
      return { rows: row ? [row] : [] };
    }

    if (s.includes('FROM PROFILES') && s.includes('ASIN')) {
      // Haversine query — return all profiles that have coordinates
      const rows = Object.values(profiles).filter((p) => p.latitude != null);
      return { rows };
    }

    return { rows: [] };
  }),

  _reset() {
    Object.keys(profiles).forEach((k) => delete profiles[k]);
    jest.clearAllMocks();
  },
  _profiles: profiles,
};

// ─── OneSignal mock ───────────────────────────────────────────────────────────

export const onesignalMock = {
  sendPushToNearbyUsers: jest.fn(async () => ({ sent: 0 })),
};
