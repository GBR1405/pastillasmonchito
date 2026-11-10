'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');

let client = null;
let readyPromise = null;

function getClient() {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL;
  if (url) {
    client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  } else {
    if (process.env.VERCEL) throw new Error('Falta la variable TURSO_DATABASE_URL');
    // Modo local: una base SQLite en ./data (solo para probar en tu computadora)
    const dir = path.join(__dirname, 'data');
    fs.mkdirSync(dir, { recursive: true });
    client = createClient({ url: 'file:' + path.join(dir, 'pastillero.db') });
  }
  return client;
}

function toObjects(rs) {
  return rs.rows.map((row) => {
    const o = {};
    rs.columns.forEach((c, i) => { o[c] = row[i]; });
    return o;
  });
}

async function all(sql, args = []) {
  return toObjects(await getClient().execute({ sql, args }));
}

async function get(sql, args = []) {
  const rows = await all(sql, args);
  return rows[0] || null;
}

async function run(sql, args = []) {
  return getClient().execute({ sql, args });
}

async function batch(statements) {
  return getClient().batch(statements, 'write');
}

/* ------------------------------------------------------------------ */
/* Esquema                                                             */
/* ------------------------------------------------------------------ */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS members (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS medicines (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     unit TEXT NOT NULL DEFAULT '',
     code TEXT NOT NULL DEFAULT '',
     expires_on TEXT,
     stock REAL,
     color TEXT NOT NULL DEFAULT '#6dbf94',
     notes TEXT NOT NULL DEFAULT '',
     active INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS slots (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     time TEXT NOT NULL,
     end_time TEXT,
     active INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS slot_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     slot_id INTEGER NOT NULL,
     medicine_id INTEGER NOT NULL,
     quantity REAL NOT NULL DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS doses (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     date TEXT NOT NULL,
     slot_id INTEGER NOT NULL,
     slot_time TEXT NOT NULL,
     slot_end TEXT,
     given_by_id INTEGER,
     given_by_name TEXT NOT NULL,
     result TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '',
     items_json TEXT NOT NULL,
     consumed INTEGER NOT NULL DEFAULT 1,
     given_at TEXT NOT NULL,
     UNIQUE (date, slot_id)
   )`,
  `CREATE TABLE IF NOT EXISTS symptoms (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     date TEXT NOT NULL,
     time TEXT NOT NULL,
     tags TEXT NOT NULL DEFAULT '',
     severity INTEGER NOT NULL DEFAULT 1,
     note TEXT NOT NULL DEFAULT '',
     by_name TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS observations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     date TEXT NOT NULL,
     time TEXT NOT NULL,
     text TEXT NOT NULL,
     by_name TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  // Teléfonos que activaron los recordatorios (notificaciones push)
  `CREATE TABLE IF NOT EXISTS push_subs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     endpoint TEXT NOT NULL UNIQUE,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     member_id INTEGER,
     created_at TEXT NOT NULL
   )`,
  // Recordatorios ya enviados (para no mandar el mismo dos veces)
  `CREATE TABLE IF NOT EXISTS push_sent (
     date TEXT NOT NULL,
     slot_id INTEGER NOT NULL,
     kind TEXT NOT NULL,
     sent_at TEXT NOT NULL,
     PRIMARY KEY (date, slot_id, kind)
   )`,
  // Foto de la caja de cada medicina (opcional). Se guarda aparte para no cargarla en cada consulta.
  `CREATE TABLE IF NOT EXISTS medicine_photos (
     medicine_id INTEGER PRIMARY KEY,
     data TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_symptoms_date ON symptoms(date)',
  'CREATE INDEX IF NOT EXISTS idx_observations_date ON observations(date)',
];

/* ------------------------------------------------------------------ */
/* Familia fija desde FAMILY_MEMBERS                                    */
/* ------------------------------------------------------------------ */

// "Gabriel, María José, Tía Ana" -> ['Gabriel', 'María José', 'Tía Ana']
function parseNames(raw) {
  if (!raw || !raw.trim()) return null;
  const seen = new Set();
  const names = [];
  for (const part of raw.split(/[,\n;]/)) {
    const name = part.trim().replace(/\s+/g, ' ').slice(0, 40);
    const key = nameKey(name);
    if (name && !seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names.length ? names : null;
}

const familyFromEnv = () => parseNames(process.env.FAMILY_MEMBERS);

// Quienes pueden entrar a Medicinas → Horario y Familia
const DEFAULT_ADMINS = 'Gabriel, Bosco, Marianne';
function adminKeys() {
  const names = parseNames(process.env.ADMIN_MEMBERS || DEFAULT_ADMINS) || [];
  return new Set(names.map(nameKey));
}
const isAdminName = (name) => adminKeys().has(nameKey(String(name || '')));

const nameKey = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Deja en la base exactamente la familia de FAMILY_MEMBERS.
// Quien sale de la lista solo se oculta: sus registros anteriores se conservan.
async function syncMembers(names) {
  const existing = await all('SELECT id, name, active FROM members ORDER BY active DESC, id');
  const used = new Set();
  const now = new Date().toISOString();
  const stmts = [];
  for (const name of names) {
    const m = existing.find((x) => !used.has(x.id) && nameKey(x.name) === nameKey(name));
    if (m) {
      used.add(m.id);
      stmts.push({ sql: 'UPDATE members SET name = ?, active = 1 WHERE id = ?', args: [name, m.id] });
    } else {
      stmts.push({
        sql: 'INSERT INTO members (name, created_at) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM members WHERE name = ?)',
        args: [name, now, name],
      });
    }
  }
  const ph = names.map(() => '?').join(', ');
  stmts.push({
    sql: `UPDATE members SET active = 0
           WHERE active = 1
             AND (name NOT IN (${ph})
                  OR id NOT IN (SELECT MIN(id) FROM members WHERE active = 1 AND name IN (${ph}) GROUP BY name))`,
    args: [...names, ...names],
  });
  await batch(stmts);
}

/* ------------------------------------------------------------------ */
/* Horario inicial (tomado de la hoja "Horarios de medicamentos")       */
/* ------------------------------------------------------------------ */

// [nombre, presentación, color]
const SEED_MEDICINES = [
  ['Omeprazol', 'pastilla', '#e8a33d'],
  ['Levodopa', 'pastilla grande', '#e05d5d'],
  ['Biperideno', 'pastilla pequeña', '#4f8fd6'],
  ['Nakom', '', '#8b6fd0'],
  ['Citicolina', 'tubo', '#2fa6a0'],
  ['Tamsulon', 'pastilla', '#d97ab0'],
  ['Irbersartan', 'pastilla', '#7a9a3a'],
  ['Clonazepam', 'gotas', '#8a6b4f'],
];

// [hora, hora final]
const SEED_SLOTS = [
  ['05:30', '06:00'],
  ['09:00', null],
  ['14:00', null],
  ['17:30', null],
];

// [número de horario, número de medicina, cantidad] (1-based, según las listas de arriba)
const SEED_ITEMS = [
  [1, 1, 1], [1, 2, 2], [1, 3, 1], [1, 4, 1],
  [2, 2, 1], [2, 3, 1],
  [3, 2, 2], [3, 3, 1], [3, 4, 1], [3, 5, 1],
  [4, 2, 1], [4, 6, 1], [4, 7, 1], [4, 8, 10],
];

async function seed() {
  const statements = [
    // Si otra instancia ya sembró, esta inserción falla y se cancela todo el lote.
    { sql: "INSERT INTO meta (key, value) VALUES ('seeded', '1')", args: [] },
    { sql: "INSERT OR IGNORE INTO meta (key, value) VALUES ('patient_name', 'Abuelo')", args: [] },
  ];
  SEED_MEDICINES.forEach(([name, unit, color], i) => {
    statements.push({
      sql: 'INSERT INTO medicines (id, name, unit, color) VALUES (?, ?, ?, ?)',
      args: [i + 1, name, unit, color],
    });
  });
  SEED_SLOTS.forEach(([time, end], i) => {
    statements.push({
      sql: 'INSERT INTO slots (id, time, end_time) VALUES (?, ?, ?)',
      args: [i + 1, time, end],
    });
  });
  SEED_ITEMS.forEach(([slotNo, medNo, qty]) => {
    statements.push({
      sql: 'INSERT INTO slot_items (slot_id, medicine_id, quantity) VALUES (?, ?, ?)',
      args: [slotNo, medNo, qty],
    });
  });
  await batch(statements);
}

async function doInit() {
  await batch(SCHEMA.map((sql) => ({ sql, args: [] })));
  const seeded = await get("SELECT value FROM meta WHERE key = 'seeded'");
  if (!seeded) {
    try {
      await seed();
    } catch (err) {
      const again = await get("SELECT value FROM meta WHERE key = 'seeded'");
      if (!again) throw err; // falló de verdad (no fue una carrera con otra instancia)
    }
  }
  const family = familyFromEnv();
  if (family) await syncMembers(family);
}

function init() {
  if (!readyPromise) {
    readyPromise = doInit().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

module.exports = { init, all, get, run, batch, familyFromEnv, isAdminName };
