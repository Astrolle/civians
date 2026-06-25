const store: Record<string, { value: string; expiresAt?: number }> = {};
const sets: Record<string, Set<string>> = {};
const zsets: Record<string, Map<string, number>> = {};

function isExpired(key: string) {
  const e = store[key];
  if (!e) return true;
  if (e.expiresAt && Date.now() > e.expiresAt) { delete store[key]; return true; }
  return false;
}

const redisMock = {
  get: jest.fn(async (key: string) => isExpired(key) ? null : store[key]?.value ?? null),
  set: jest.fn(async (key: string, value: string, opts?: { EX?: number; KEEPTTL?: boolean }) => {
    const expiresAt = opts?.EX ? Date.now() + opts.EX * 1000 : undefined;
    store[key] = { value, expiresAt };
    return 'OK';
  }),
  del: jest.fn(async (...keys: string[]) => {
    let n = 0; for (const k of keys) { if (store[k]) { delete store[k]; n++; } } return n;
  }),
  zAdd: jest.fn(async (key: string, entry: { score: number; value: string }) => {
    if (!zsets[key]) zsets[key] = new Map();
    zsets[key].set(entry.value, entry.score); return 1;
  }),
  zRange: jest.fn(async (key: string, start: number, stop: number, opts?: { REV?: boolean }) => {
    const z = zsets[key]; if (!z) return [];
    const sorted = [...z.entries()].sort((a, b) => opts?.REV ? b[1] - a[1] : a[1] - b[1]);
    const slice = stop === -1 ? sorted.slice(start) : sorted.slice(start, stop + 1);
    return slice.map(([v]) => v);
  }),
  zCard: jest.fn(async (key: string) => zsets[key]?.size ?? 0),
  zRem: jest.fn(async (key: string, ...members: string[]) => {
    if (!zsets[key]) return 0; let n = 0;
    for (const m of members) { if (zsets[key].delete(m)) n++; } return n;
  }),
  sAdd: jest.fn(async (key: string, ...members: string[]) => {
    if (!sets[key]) sets[key] = new Set(); members.forEach((m) => sets[key].add(m)); return members.length;
  }),
  sRem: jest.fn(async (key: string, ...members: string[]) => {
    if (!sets[key]) return 0; let n = 0;
    members.forEach((m) => { if (sets[key].delete(m)) n++; }); return n;
  }),
  sIsMember: jest.fn(async (key: string, member: string) => sets[key]?.has(member) ?? false),
  sCard: jest.fn(async (key: string) => sets[key]?.size ?? 0),
  on: jest.fn(), connect: jest.fn(),
  _reset() {
    Object.keys(store).forEach((k) => delete store[k]);
    Object.keys(sets).forEach((k) => delete sets[k]);
    Object.keys(zsets).forEach((k) => delete zsets[k]);
  },
};

export default redisMock;
export { redisMock };
