const profiles: Record<string, any> = {};

export const writeDBMock = {
  execute: jest.fn(async ({ sql, args }: { sql: string; args: Record<string, any> }) => {
    const s = sql.trim().toUpperCase();
    if (s.startsWith('CREATE TABLE')) return { rows: [], rowsAffected: 0 };
    if (s.startsWith('INSERT INTO PROFILES')) {
      const id = args.device_id as string;
      if (profiles[id]) {
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
    if (s.startsWith('UPDATE PROFILES')) {
      const id = args.device_id as string;
      if (!profiles[id]) return { rows: [], rowsAffected: 0 };
      Object.keys(args).forEach((k) => { if (k !== 'device_id') profiles[id][k] = args[k]; });
      return { rows: [], rowsAffected: 1 };
    }
    return { rows: [], rowsAffected: 0 };
  }),
};

export const readDBMock = {
  execute: jest.fn(async ({ sql, args }: { sql: string; args: any }) => {
    const s = sql.trim().toUpperCase();
    if (s.includes('FROM PROFILES WHERE DEVICE_ID = ?')) {
      const id = Array.isArray(args) ? args[0] : args.device_id;
      const row = profiles[id as string];
      return { rows: row ? [row] : [] };
    }
    if (s.includes('FROM PROFILES') && s.includes('ASIN')) {
      return { rows: Object.values(profiles).filter((p) => p.latitude != null) };
    }
    return { rows: [] };
  }),
  _reset() { Object.keys(profiles).forEach((k) => delete profiles[k]); },
  _profiles: profiles,
};

export const getWriteDB = jest.fn(() => writeDBMock);
export const getReadDB  = jest.fn(() => readDBMock);
export const connectDB  = jest.fn(async () => {});
