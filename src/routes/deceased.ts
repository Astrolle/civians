import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { parse } from 'csv-parse';
import { v4 as uuidv4 } from 'uuid';
import { getCollection } from '../services/db';
import { authMiddleware } from '../middleware/auth';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max CSV
});

// ─── Schema ───────────────────────────────────────────────────────────────────

// All fields optional — no data is mandatory for a deceased record
const DeceasedRecordSchema = z.object({
  nombre:           z.string().max(100).optional(),
  apellido:         z.string().max(100).optional(),
  documento:        z.string().max(50).optional(),   // cedula / passport / ID
  edad:             z.coerce.number().int().positive().optional(),
  sexo:             z.enum(['M', 'F', 'No especificado']).optional(),
  encontrado_en:    z.string().max(200).optional(),  // hospital, morgue, location name
  locacion:         z.string().max(300).optional(),  // address or description of where body was found
  fecha_hallazgo:   z.string().optional(),           // date found
  observaciones:    z.string().max(500).optional(),  // any additional notes
  ciudad:           z.string().max(100).optional(),     // city where found
});

type DeceasedRecord = z.infer<typeof DeceasedRecordSchema>;

// ─── CSV column aliases ───────────────────────────────────────────────────────
// Accept different column name variations in the CSV

function normalizeRow(row: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  const aliases: Record<string, string> = {
    'nombre':           'nombre',
    'first_name':       'nombre',
    'name':             'nombre',
    'apellido':         'apellido',
    'last_name':        'apellido',
    'surname':          'apellido',
    'documento':        'documento',
    'cedula':           'documento',
    'id':               'documento',
    'document':         'documento',
    'passport':         'documento',
    'edad':             'edad',
    'age':              'edad',
    'sexo':             'sexo',
    'gender':           'sexo',
    'sex':              'sexo',
    'encontrado_en':    'encontrado_en',
    'hospital':         'encontrado_en',
    'morgue':           'encontrado_en',
    'found_at':         'encontrado_en',
    'locacion':         'locacion',
    'location':         'locacion',
    'ubicacion':        'locacion',
    'address':          'locacion',
    'fecha_hallazgo':   'fecha_hallazgo',
    'fecha':            'fecha_hallazgo',
    'date':             'fecha_hallazgo',
    'date_found':       'fecha_hallazgo',
    'observaciones':    'observaciones',
    'notes':            'observaciones',
    'notas':            'observaciones',
    'observations':     'observaciones',
    'ciudad':           'ciudad',
    'city':             'ciudad',
    'ciudad_hallazgo':  'ciudad',
  };

  for (const [key, value] of Object.entries(row)) {
    const normalized_key = aliases[key.toLowerCase().trim()];
    if (normalized_key) normalized[normalized_key] = value.trim();
  }

  return normalized;
}

// ─── POST /deceased/upload — admin only CSV upload ───────────────────────────
router.post(
  '/upload',
  upload.single('file'),
  async (req: Request, res: Response) => {
    // Admin secret required — no device auth
    const adminSecret = req.headers['x-admin-secret'] as string;
    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'CSV file required. Use field name "file".' });
    }

    if (!req.file.originalname.endsWith('.csv') && req.file.mimetype !== 'text/csv') {
      return res.status(400).json({ error: 'Only CSV files are accepted.' });
    }

    const source = req.body.source || 'CSV Upload';   // label for who provided the data
    const event  = req.body.event  || null;            // e.g. "Terremoto Venezuela 2026"

    // Parse CSV from buffer
    const records: DeceasedRecord[] = [];
    const errors:  string[]         = [];

    await new Promise<void>((resolve, reject) => {
      parse(req.file!.buffer, {
        columns:          true,
        skip_empty_lines: true,
        trim:             true,
      }, (err, rows: Record<string, string>[]) => {
        if (err) return reject(err);

        rows.forEach((row, index) => {
          const normalized = normalizeRow(row);
          const parse_result = DeceasedRecordSchema.safeParse(normalized);

          if (parse_result.success) {
            // Only add if at least one field has a value
            const hasData = Object.values(parse_result.data).some(v => v !== undefined && v !== '');
            if (hasData) records.push(parse_result.data);
          } else {
            errors.push(`Row ${index + 2}: ${JSON.stringify(parse_result.error.flatten().fieldErrors)}`);
          }
        });

        resolve();
      });
    });

    if (records.length === 0) {
      return res.status(400).json({
        error: 'No valid records found in CSV.',
        parsing_errors: errors,
      });
    }

    // Insert all records
    const now = new Date();
    const docs = records.map(record => ({
      _id:         uuidv4(),
      ...record,
      source,
      event:       event || null,
      uploaded_at: now,
    }));

    await getCollection('deceased').insertMany(docs as any);

    return res.status(201).json({
      message:         `${docs.length} record(s) uploaded successfully`,
      total_uploaded:  docs.length,
      total_skipped:   errors.length,
      parsing_errors:  errors.length > 0 ? errors : undefined,
      source,
      event,
    });
  }
);

// ─── GET /deceased — public search, no auth required ─────────────────────────
router.get('/', async (req: Request, res: Response) => {
  const q           = req.query.q           as string | undefined; // free text search
  const nombre      = req.query.nombre      as string | undefined;
  const apellido    = req.query.apellido    as string | undefined;
  const documento   = req.query.documento   as string | undefined;
  const encontrado  = req.query.encontrado_en as string | undefined;
  const event       = req.query.event       as string | undefined;
  const ciudad      = req.query.ciudad      as string | undefined;
  const limit       = parseInt(req.query.limit  as string) || 20;
  const offset      = parseInt(req.query.offset as string) || 0;

  const filter: any = {};

  // Full text search across name, surname and document
  if (q) {
    filter.$text = { $search: q };
  } else {
    // Field-specific search — case insensitive partial match
    if (nombre)     filter.nombre     = { $regex: nombre,    $options: 'i' };
    if (apellido)   filter.apellido   = { $regex: apellido,  $options: 'i' };
    if (documento)  filter.documento  = { $regex: documento, $options: 'i' };
    if (encontrado) filter.encontrado_en = { $regex: encontrado, $options: 'i' };
  }

  if (event)   filter.event  = { $regex: event,  $options: 'i' };
  if (ciudad)  filter.ciudad = { $regex: ciudad, $options: 'i' };

  const col   = getCollection('deceased');
  const total = await col.countDocuments(filter);
  const docs  = await col
    .find(filter)
    .sort({ apellido: 1, nombre: 1 })
    .skip(offset)
    .limit(limit)
    .toArray();

  const records = docs.map(doc => ({
    id:             doc._id,
    nombre:         doc.nombre         || null,
    apellido:       doc.apellido       || null,
    documento:      doc.documento      || null,
    edad:           doc.edad           || null,
    sexo:           doc.sexo           || null,
    encontrado_en:  doc.encontrado_en  || null,
    locacion:       doc.locacion       || null,
    fecha_hallazgo: doc.fecha_hallazgo || null,
    observaciones:  doc.observaciones  || null,
    ciudad:         doc.ciudad         || null,
    source:         doc.source         || null,
    event:          doc.event          || null,
    uploaded_at:    doc.uploaded_at,
  }));

  return res.json({ records, total, limit, offset });
});

// ─── GET /deceased/events — list of events/disasters ─────────────────────────
router.get('/events', async (_req: Request, res: Response) => {
  const events = await getCollection('deceased').distinct('event');
  return res.json({ events: events.filter(Boolean) });
});

// ─── DELETE /deceased/event — admin only, delete all records for an event ─────
router.delete('/event', async (req: Request, res: Response) => {
  const adminSecret = req.headers['x-admin-secret'] as string;
  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { event } = req.body;
  if (!event) return res.status(400).json({ error: 'event is required.' });

  const result = await getCollection('deceased').deleteMany({ event });
  return res.json({ message: `Deleted ${result.deletedCount} records for event: ${event}` });
});

export default router;
