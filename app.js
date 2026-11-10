'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const db = require('./db');
const push = require('./push');

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

const RESULTS = ['bien', 'algunas', 'no', 'vomito'];
const NO_SYMPTOMS = 'Sin síntomas';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);
const notFound = (msg = 'No encontrado') => new HttpError(404, msg);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isDate = (s) =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const nowIso = () => new Date().toISOString();

function positiveNumber(v, label, { allowZero = false, max = 10000 } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0) || n > max) {
    throw bad(`${label} no es válido`);
  }
  return n;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function familyCode() {
  if (process.env.FAMILY_CODE) return process.env.FAMILY_CODE;
  return process.env.VERCEL ? null : 'familia'; // código de prueba solo en local
}

/* ------------------------------------------------------------------ */
/* Lecturas compartidas                                                */
/* ------------------------------------------------------------------ */

async function loadSchedule() {
  const [slots, items] = await Promise.all([
    db.all('SELECT id, time, end_time FROM slots WHERE active = 1 ORDER BY time, id'),
    db.all(
      `SELECT si.id, si.slot_id, si.medicine_id, si.quantity, m.name, m.unit, m.color
         FROM slot_items si
         JOIN medicines m ON m.id = si.medicine_id
        WHERE m.active = 1
        ORDER BY si.id`
    ),
  ]);
  return slots.map((s) => ({ ...s, items: items.filter((i) => i.slot_id === s.id) }));
}

async function loadMedicines() {
  const [meds, daily] = await Promise.all([
    db.all(
      `SELECT id, name, unit, code, expires_on, stock, color, notes
         FROM medicines WHERE active = 1 ORDER BY name COLLATE NOCASE`
    ),
    db.all(
      `SELECT si.medicine_id, SUM(si.quantity) AS q
         FROM slot_items si
         JOIN slots s ON s.id = si.slot_id
        WHERE s.active = 1
        GROUP BY si.medicine_id`
    ),
  ]);
  const perDay = new Map(daily.map((d) => [d.medicine_id, d.q]));
  return meds.map((m) => {
    const d = perDay.get(m.id) || 0;
    return { ...m, daily: d, days_left: m.stock != null && d > 0 ? Math.floor(m.stock / d) : null };
  });
}

async function getSetting(key, fallback) {
  const row = await db.get('SELECT value FROM meta WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

const mapDose = (d) => ({
  id: d.id,
  date: d.date,
  slot_id: d.slot_id,
  slot_time: d.slot_time,
  slot_end: d.slot_end,
  given_by_id: d.given_by_id,
  given_by_name: d.given_by_name,
  result: d.result,
  note: d.note,
  consumed: d.consumed,
  given_at: d.given_at,
  items: JSON.parse(d.items_json),
});

const mapSymptom = (s) => ({
  id: s.id,
  date: s.date,
  time: s.time,
  tags: s.tags ? s.tags.split('|') : [],
  severity: s.severity,
  note: s.note,
  by_name: s.by_name,
});

const mapObservation = (o) => ({
  id: o.id,
  date: o.date,
  time: o.time,
  text: o.text,
  by_name: o.by_name,
});

function stockStatements(snapshot, sign) {
  return snapshot
    .filter((i) => i.medicine_id)
    .map((i) =>
      sign < 0
        ? {
            sql: 'UPDATE medicines SET stock = MAX(stock - ?, 0) WHERE id = ? AND stock IS NOT NULL',
            args: [i.quantity, i.medicine_id],
          }
        : {
            sql: 'UPDATE medicines SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL',
            args: [i.quantity, i.medicine_id],
          }
    );
}

async function memberById(id) {
  const m = await db.get('SELECT id, name FROM members WHERE id = ?', [Number(id)]);
  if (!m) throw bad('Elige quién eres');
  return m;
}

/* ------------------------------------------------------------------ */
/* Rutas                                                               */
/* ------------------------------------------------------------------ */

const attempts = new Map(); // ip -> { count, since }

function buildRouter() {
  const r = express.Router();

  // Acceso con el código de la familia
  r.use(
    wrap(async (req, res, next) => {
      const code = familyCode();
      if (!code) throw new HttpError(500, 'El servidor no tiene configurado FAMILY_CODE.');

      const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
      const rec = attempts.get(ip);
      if (rec && Date.now() - rec.since > 60_000) attempts.delete(ip);
      const current = attempts.get(ip);
      if (current && current.count >= 10) {
        throw new HttpError(429, 'Demasiados intentos. Espera un minuto.');
      }

      if (!safeEqual(req.get('x-family-code') || '', code)) {
        const c = attempts.get(ip) || { count: 0, since: Date.now() };
        c.count += 1;
        attempts.set(ip, c);
        throw new HttpError(401, 'Código incorrecto');
      }
      attempts.delete(ip);
      await db.init();
      next();
    })
  );

  r.get('/auth', (req, res) => res.json({ ok: true }));

  /* ---------- Estado del día ---------- */
  r.get(
    '/state',
    wrap(async (req, res) => {
      const date = req.query.date;
      if (!isDate(date)) throw bad('Fecha inválida');
      const [members, slots, medicines, doses, symptoms, observations, patientName] = await Promise.all([
        db.all('SELECT id, name FROM members WHERE active = 1 ORDER BY name COLLATE NOCASE'),
        loadSchedule(),
        loadMedicines(),
        db.all('SELECT * FROM doses WHERE date = ?', [date]),
        db.all('SELECT * FROM symptoms WHERE date = ? ORDER BY time, id', [date]),
        db.all('SELECT * FROM observations WHERE date = ? ORDER BY time, id', [date]),
        getSetting('patient_name', 'Abuelo'),
      ]);
      res.json({
        date,
        patient_name: patientName,
        members,
        members_locked: !!db.familyFromEnv(),
        push_key: push.publicKey(),
        slots,
        medicines,
        doses: doses.map(mapDose),
        symptoms: symptoms.map(mapSymptom),
        observations: observations.map(mapObservation),
      });
    })
  );

  /* ---------- Historial / reporte ---------- */
  r.get(
    '/history',
    wrap(async (req, res) => {
      const { from, to } = req.query;
      if (!isDate(from) || !isDate(to) || from > to) throw bad('Rango de fechas inválido');
      if (Date.parse(to) - Date.parse(from) > 92 * 86_400_000) throw bad('El rango es demasiado grande');
      const [slots, medicines, doses, symptoms, observations, first, patientName] = await Promise.all([
        loadSchedule(),
        loadMedicines(),
        db.all('SELECT * FROM doses WHERE date >= ? AND date <= ? ORDER BY date, slot_time', [from, to]),
        db.all('SELECT * FROM symptoms WHERE date >= ? AND date <= ? ORDER BY date, time, id', [from, to]),
        db.all('SELECT * FROM observations WHERE date >= ? AND date <= ? ORDER BY date, time, id', [from, to]),
        db.get('SELECT MIN(date) AS d FROM doses'),
        getSetting('patient_name', 'Abuelo'),
      ]);
      res.json({
        from,
        to,
        patient_name: patientName,
        slots,
        medicines,
        first_dose_date: first ? first.d : null,
        doses: doses.map(mapDose),
        symptoms: symptoms.map(mapSymptom),
        observations: observations.map(mapObservation),
      });
    })
  );

  /* ---------- Ajustes ---------- */
  r.put(
    '/settings',
    wrap(async (req, res) => {
      const name = text(req.body?.patient_name, 40);
      if (!name) throw bad('Escribe un nombre');
      await db.run(
        "INSERT INTO meta (key, value) VALUES ('patient_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [name]
      );
      res.json({ ok: true });
    })
  );

  /* ---------- Familia ---------- */
  // Con FAMILY_MEMBERS la lista es fija: no se agregan ni se quitan nombres desde la app
  const lockedFamily = (req, res, next) =>
    db.familyFromEnv()
      ? next(new HttpError(403, 'La lista de la familia es fija. Pídele a quien administra la app que te agregue.'))
      : next();

  r.post(
    '/members',
    lockedFamily,
    wrap(async (req, res) => {
      const name = text(req.body?.name, 40);
      if (!name) throw bad('Escribe un nombre');
      const dup = await db.get('SELECT id FROM members WHERE active = 1 AND LOWER(name) = LOWER(?)', [name]);
      if (dup) return res.json({ id: dup.id, existing: true });
      const rs = await db.run('INSERT INTO members (name, created_at) VALUES (?, ?)', [name, nowIso()]);
      res.status(201).json({ id: Number(rs.lastInsertRowid) });
    })
  );

  r.delete(
    '/members/:id',
    lockedFamily,
    wrap(async (req, res) => {
      await db.run('UPDATE members SET active = 0 WHERE id = ?', [Number(req.params.id)]);
      res.json({ ok: true });
    })
  );

  /* ---------- Medicinas ---------- */
  function readMedicine(body) {
    const b = body || {};
    const name = text(b.name, 60);
    if (!name) throw bad('Escribe el nombre de la medicina');
    let expires = null;
    if (b.expires_on) {
      if (!isDate(b.expires_on)) throw bad('Fecha de vencimiento inválida');
      expires = b.expires_on;
    }
    let stock = null;
    if (b.stock !== null && b.stock !== undefined && b.stock !== '') {
      stock = positiveNumber(b.stock, 'La cantidad', { allowZero: true });
    }
    const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#6dbf94';
    return {
      name,
      unit: text(b.unit, 30),
      code: text(b.code, 40),
      expires,
      stock,
      color,
      notes: text(b.notes, 300),
    };
  }

  r.post(
    '/medicines',
    wrap(async (req, res) => {
      const m = readMedicine(req.body);
      const rs = await db.run(
        'INSERT INTO medicines (name, unit, code, expires_on, stock, color, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [m.name, m.unit, m.code, m.expires, m.stock, m.color, m.notes]
      );
      res.status(201).json({ id: Number(rs.lastInsertRowid) });
    })
  );

  r.put(
    '/medicines/:id',
    wrap(async (req, res) => {
      const m = readMedicine(req.body);
      const rs = await db.run(
        `UPDATE medicines
            SET name = ?, unit = ?, code = ?, expires_on = ?, stock = ?, color = ?, notes = ?
          WHERE id = ? AND active = 1`,
        [m.name, m.unit, m.code, m.expires, m.stock, m.color, m.notes, Number(req.params.id)]
      );
      if (!rs.rowsAffected) throw notFound('Medicina no encontrada');
      res.json({ ok: true });
    })
  );

  r.post(
    '/medicines/:id/restock',
    wrap(async (req, res) => {
      const amount = positiveNumber(req.body?.amount, 'La cantidad');
      const rs = await db.run(
        'UPDATE medicines SET stock = COALESCE(stock, 0) + ? WHERE id = ? AND active = 1',
        [amount, Number(req.params.id)]
      );
      if (!rs.rowsAffected) throw notFound('Medicina no encontrada');
      res.json({ ok: true });
    })
  );

  r.delete(
    '/medicines/:id',
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      await db.batch([
        { sql: 'UPDATE medicines SET active = 0 WHERE id = ?', args: [id] },
        { sql: 'DELETE FROM slot_items WHERE medicine_id = ?', args: [id] },
      ]);
      res.json({ ok: true });
    })
  );

  /* ---------- Horarios ---------- */
  function readSlot(body) {
    const b = body || {};
    if (!isTime(b.time)) throw bad('Hora inválida');
    let end = null;
    if (b.end_time) {
      if (!isTime(b.end_time)) throw bad('Hora final inválida');
      if (b.end_time <= b.time) throw bad('La hora final debe ser después de la inicial');
      end = b.end_time;
    }
    return { time: b.time, end };
  }

  r.post(
    '/slots',
    wrap(async (req, res) => {
      const s = readSlot(req.body);
      const rs = await db.run('INSERT INTO slots (time, end_time) VALUES (?, ?)', [s.time, s.end]);
      res.status(201).json({ id: Number(rs.lastInsertRowid) });
    })
  );

  r.put(
    '/slots/:id',
    wrap(async (req, res) => {
      const s = readSlot(req.body);
      const rs = await db.run('UPDATE slots SET time = ?, end_time = ? WHERE id = ? AND active = 1', [
        s.time,
        s.end,
        Number(req.params.id),
      ]);
      if (!rs.rowsAffected) throw notFound('Horario no encontrado');
      res.json({ ok: true });
    })
  );

  r.delete(
    '/slots/:id',
    wrap(async (req, res) => {
      await db.run('UPDATE slots SET active = 0 WHERE id = ?', [Number(req.params.id)]);
      res.json({ ok: true });
    })
  );

  r.post(
    '/slots/:id/items',
    wrap(async (req, res) => {
      const slotId = Number(req.params.id);
      const medId = Number(req.body?.medicine_id);
      const quantity = positiveNumber(req.body?.quantity, 'La cantidad', { max: 1000 });
      const slot = await db.get('SELECT id FROM slots WHERE id = ? AND active = 1', [slotId]);
      if (!slot) throw notFound('Horario no encontrado');
      const med = await db.get('SELECT id FROM medicines WHERE id = ? AND active = 1', [medId]);
      if (!med) throw bad('Elige una medicina');
      const dup = await db.get('SELECT id FROM slot_items WHERE slot_id = ? AND medicine_id = ?', [slotId, medId]);
      if (dup) throw bad('Esa medicina ya está en este horario. Cambia su cantidad.');
      const rs = await db.run('INSERT INTO slot_items (slot_id, medicine_id, quantity) VALUES (?, ?, ?)', [
        slotId,
        medId,
        quantity,
      ]);
      res.status(201).json({ id: Number(rs.lastInsertRowid) });
    })
  );

  r.put(
    '/items/:id',
    wrap(async (req, res) => {
      const quantity = positiveNumber(req.body?.quantity, 'La cantidad', { max: 1000 });
      const rs = await db.run('UPDATE slot_items SET quantity = ? WHERE id = ?', [quantity, Number(req.params.id)]);
      if (!rs.rowsAffected) throw notFound();
      res.json({ ok: true });
    })
  );

  r.delete(
    '/items/:id',
    wrap(async (req, res) => {
      await db.run('DELETE FROM slot_items WHERE id = ?', [Number(req.params.id)]);
      res.json({ ok: true });
    })
  );

  /* ---------- Tomas (pastillas dadas) ---------- */
  r.post(
    '/doses',
    wrap(async (req, res) => {
      const b = req.body || {};
      if (!isDate(b.date)) throw bad('Fecha inválida');
      const slotId = Number(b.slot_id);
      if (!RESULTS.includes(b.result)) throw bad('Elige cómo le fue');
      const member = await memberById(b.given_by_id);
      let givenAt = new Date(b.given_at);
      if (!b.given_at || Number.isNaN(givenAt.getTime())) givenAt = new Date();
      const note = text(b.note, 500);
      const consumed = b.result === 'no' ? 0 : 1;

      const existing = await db.get('SELECT * FROM doses WHERE date = ? AND slot_id = ?', [b.date, slotId]);
      if (existing) {
        const snapshot = JSON.parse(existing.items_json);
        const stmts = [
          {
            sql: `UPDATE doses
                     SET given_by_id = ?, given_by_name = ?, result = ?, note = ?, consumed = ?, given_at = ?
                   WHERE id = ?`,
            args: [member.id, member.name, b.result, note, consumed, givenAt.toISOString(), existing.id],
          },
        ];
        if (existing.consumed !== consumed) stmts.push(...stockStatements(snapshot, consumed ? -1 : 1));
        await db.batch(stmts);
        return res.json({ id: existing.id, updated: true });
      }

      const slot = await db.get('SELECT id, time, end_time FROM slots WHERE id = ? AND active = 1', [slotId]);
      if (!slot) throw notFound('Horario no encontrado');
      const items = await db.all(
        `SELECT si.medicine_id, si.quantity, m.name, m.unit, m.color
           FROM slot_items si
           JOIN medicines m ON m.id = si.medicine_id
          WHERE si.slot_id = ? AND m.active = 1
          ORDER BY si.id`,
        [slotId]
      );
      const stmts = [
        {
          sql: `INSERT INTO doses
                  (date, slot_id, slot_time, slot_end, given_by_id, given_by_name, result, note, items_json, consumed, given_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            b.date,
            slot.id,
            slot.time,
            slot.end_time,
            member.id,
            member.name,
            b.result,
            note,
            JSON.stringify(items),
            consumed,
            givenAt.toISOString(),
          ],
        },
        ...(consumed ? stockStatements(items, -1) : []),
      ];
      await db.batch(stmts);
      res.status(201).json({ ok: true });
    })
  );

  r.delete(
    '/doses/:id',
    wrap(async (req, res) => {
      const dose = await db.get('SELECT * FROM doses WHERE id = ?', [Number(req.params.id)]);
      if (!dose) return res.json({ ok: true });
      const stmts = [{ sql: 'DELETE FROM doses WHERE id = ?', args: [dose.id] }];
      if (dose.consumed) stmts.push(...stockStatements(JSON.parse(dose.items_json), 1));
      await db.batch(stmts);
      res.json({ ok: true });
    })
  );

  /* ---------- Síntomas ---------- */
  r.post(
    '/symptoms',
    wrap(async (req, res) => {
      const b = req.body || {};
      if (!isDate(b.date)) throw bad('Fecha inválida');
      if (!isTime(b.time)) throw bad('Hora inválida');
      const member = await memberById(b.by_id);
      const tags = (Array.isArray(b.tags) ? b.tags : [])
        .map((t) => text(t, 30).replace(/\|/g, ' '))
        .filter(Boolean)
        .slice(0, 12);
      const note = text(b.note, 500);
      if (!tags.length && !note) throw bad('Marca al menos un síntoma o escribe una nota');
      const severity = tags.includes(NO_SYMPTOMS) ? 0 : Math.min(3, Math.max(1, Number(b.severity) || 1));
      await db.run(
        'INSERT INTO symptoms (date, time, tags, severity, note, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [b.date, b.time, tags.join('|'), severity, note, member.name, nowIso()]
      );
      res.status(201).json({ ok: true });
    })
  );

  r.delete(
    '/symptoms/:id',
    wrap(async (req, res) => {
      await db.run('DELETE FROM symptoms WHERE id = ?', [Number(req.params.id)]);
      res.json({ ok: true });
    })
  );

  /* ---------- Observaciones ---------- */
  r.post(
    '/observations',
    wrap(async (req, res) => {
      const b = req.body || {};
      if (!isDate(b.date)) throw bad('Fecha inválida');
      if (!isTime(b.time)) throw bad('Hora inválida');
      const member = await memberById(b.by_id);
      const body = text(b.text, 1000);
      if (!body) throw bad('Escribe la observación');
      await db.run('INSERT INTO observations (date, time, text, by_name, created_at) VALUES (?, ?, ?, ?, ?)', [
        b.date,
        b.time,
        body,
        member.name,
        nowIso(),
      ]);
      res.status(201).json({ ok: true });
    })
  );

  r.delete(
    '/observations/:id',
    wrap(async (req, res) => {
      await db.run('DELETE FROM observations WHERE id = ?', [Number(req.params.id)]);
      res.json({ ok: true });
    })
  );

  /* ---------- Recordatorios (notificaciones) ---------- */
  r.post(
    '/push/subscribe',
    wrap(async (req, res) => {
      if (!push.publicKey()) throw new HttpError(503, 'Los recordatorios no están configurados en el servidor.');
      const ok = await push.saveSubscription(req.body?.subscription, req.body?.member_id);
      if (!ok) throw bad('No se pudo activar en este teléfono');
      res.json({ ok: true });
    })
  );

  r.post(
    '/push/unsubscribe',
    wrap(async (req, res) => {
      await push.removeSubscription(req.body?.endpoint);
      res.json({ ok: true });
    })
  );

  r.post(
    '/push/test',
    wrap(async (req, res) => {
      const r2 = await push.sendTest(req.body?.endpoint);
      if (r2.missing) throw bad('Este teléfono no tiene los recordatorios activados');
      if (!r2.sent) throw new HttpError(502, 'No se pudo enviar el aviso de prueba. Intenta de nuevo.');
      res.json({ ok: true });
    })
  );

  return r;
}

// Revisión automática de recordatorios. La llama un cron cada 5 minutos con
// "Authorization: Bearer <CRON_SECRET>" (o ?clave=<CRON_SECRET> si el servicio no permite encabezados).
const cronHandler = wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new HttpError(500, 'Falta CRON_SECRET en el servidor.');
  const auth = req.get('authorization') || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : String(req.query.clave || '');
  if (!given || !safeEqual(given, secret)) throw new HttpError(401, 'Clave incorrecta');
  await db.init();
  res.json(await push.runReminders());
});

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Datos inválidos' });
  if (err && /UNIQUE constraint/i.test(String(err.message))) {
    return res.status(409).json({ error: 'Ese horario ya estaba registrado. Actualiza la pantalla.' });
  }
  console.error(err);
  return res.status(500).json({ error: 'Ocurrió un error en el servidor. Intenta de nuevo.' });
}

function createApp({ serveStatic = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/cron/recordatorios', cronHandler);
  app.use('/api', buildRouter());
  app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));
  if (serveStatic) app.use(express.static(path.join(__dirname, 'public')));
  app.use(errorHandler);
  return app;
}

module.exports = createApp;
