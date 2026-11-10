'use strict';

// Recordatorios por notificación (Web Push): funcionan en Android (Chrome)
// y en iPhone/iPad con iOS 16.4 o más, si la app está agregada a la pantalla de inicio.

const db = require('./db');

const GLOW_MIN = 30; // igual que en la app: se avisa 30 min antes y 30 min después
const TOLERANCE_MIN = 20; // margen por si la revisión automática llega un poco tarde

let webpush = null;

function pushClient() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return null;
  if (!webpush) {
    webpush = require('web-push');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:pastillero@example.com', pub, priv);
  }
  return webpush;
}

const publicKey = () => (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY ? process.env.VAPID_PUBLIC_KEY : null);

const pad = (n) => String(n).padStart(2, '0');
function fmt12(t) {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
}
const toMin = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

// Fecha y minuto actuales en la zona horaria de la familia
function nowIn(timeZone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date())) {
    parts[p.type] = p.value;
  }
  return { date: `${parts.year}-${parts.month}-${parts.day}`, min: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

/* ---------- Suscripciones ---------- */

async function saveSubscription(sub, memberId) {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
    return false;
  }
  await db.run(
    `INSERT INTO push_subs (endpoint, p256dh, auth, member_id, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, member_id = excluded.member_id`,
    [endpoint, p256dh, auth, Number(memberId) || null, new Date().toISOString()]
  );
  return true;
}

const removeSubscription = (endpoint) => db.run('DELETE FROM push_subs WHERE endpoint = ?', [String(endpoint || '')]);

/* ---------- Envío ---------- */

async function sendTo(subs, payload) {
  const wp = pushClient();
  if (!wp) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await wp.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
          { TTL: 60 * 60, urgency: 'high' }
        );
        sent += 1;
      } catch (err) {
        failed += 1;
        // El teléfono ya no acepta avisos (se desinstaló la app o se quitó el permiso)
        if (err && (err.statusCode === 404 || err.statusCode === 410)) await removeSubscription(s.endpoint);
        else console.error('Push falló:', err && (err.statusCode || err.message));
      }
    })
  );
  return { sent, failed };
}

async function sendToAll(payload) {
  const subs = await db.all('SELECT endpoint, p256dh, auth FROM push_subs');
  return sendTo(subs, payload);
}

async function sendTest(endpoint) {
  const subs = await db.all('SELECT endpoint, p256dh, auth FROM push_subs WHERE endpoint = ?', [String(endpoint || '')]);
  if (!subs.length) return { sent: 0, failed: 0, missing: true };
  return sendTo(subs, {
    title: 'Pastillero familiar',
    body: 'Listo: este teléfono recibirá los recordatorios de las pastillas.',
    tag: 'prueba',
  });
}

/* ---------- Revisión periódica (la llama un cron cada 5 minutos) ---------- */

async function runReminders() {
  if (!pushClient()) return { ok: false, reason: 'Faltan VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY' };
  const tz = process.env.APP_TIMEZONE || 'America/Costa_Rica';
  const { date, min } = nowIn(tz);

  const [slots, items, doses, patientRow] = await Promise.all([
    db.all('SELECT id, time, end_time FROM slots WHERE active = 1 ORDER BY time, id'),
    db.all(
      `SELECT si.slot_id, si.quantity, m.name
         FROM slot_items si JOIN medicines m ON m.id = si.medicine_id
        WHERE m.active = 1 ORDER BY si.id`
    ),
    db.all('SELECT slot_id FROM doses WHERE date = ?', [date]),
    db.get("SELECT value FROM meta WHERE key = 'patient_name'"),
  ]);
  const patient = patientRow ? patientRow.value : 'Abuelo';
  const given = new Set(doses.map((d) => d.slot_id));
  const qty = (q) => (Number(q) === 0.5 ? '½' : String(q).replace(/\.5$/, '½'));

  const due = [];
  for (const slot of slots) {
    if (given.has(slot.id)) continue;
    const list = items.filter((i) => i.slot_id === slot.id);
    if (!list.length) continue;
    const start = toMin(slot.time);
    const end = slot.end_time ? Math.max(start, toMin(slot.end_time)) : start;
    const when = fmt12(slot.time);
    const meds = list.map((i) => `${qty(i.quantity)} ${i.name}`).join(', ');
    const kinds = [
      { kind: 'antes', at: start - GLOW_MIN, title: `En 30 min: pastillas de las ${when}`, body: `${patient}: ${meds}` },
      { kind: 'hora', at: start, title: `Es la hora: pastillas de las ${when}`, body: `${patient}: ${meds}` },
      {
        kind: 'tarde',
        at: end + GLOW_MIN,
        title: `Falta registrar las de las ${when}`,
        body: `Nadie ha marcado que ${patient} se las tomó. Si ya se las dieron, regístralo en la app.`,
      },
    ];
    const k = kinds.find((x) => x.at >= 0 && min >= x.at && min < x.at + TOLERANCE_MIN);
    if (k) due.push({ slot, ...k });
  }

  let sent = 0;
  for (const d of due) {
    // Solo una instancia gana el registro, así no se manda dos veces
    const rs = await db.run('INSERT OR IGNORE INTO push_sent (date, slot_id, kind, sent_at) VALUES (?, ?, ?, ?)', [
      date,
      d.slot.id,
      d.kind,
      new Date().toISOString(),
    ]);
    if (!rs.rowsAffected) continue;
    const r = await sendToAll({ title: d.title, body: d.body, tag: `dosis-${date}-${d.slot.id}`, url: '/' });
    sent += r.sent;
  }

  // Limpieza de registros viejos
  const old = new Date(Date.parse(`${date}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  await db.run('DELETE FROM push_sent WHERE date < ?', [old]);

  return { ok: true, date, time: `${pad(Math.floor(min / 60))}:${pad(min % 60)}`, timezone: tz, reminders: due.map((d) => `${d.slot.time} ${d.kind}`), sent };
}

module.exports = { publicKey, saveSubscription, removeSubscription, sendTest, runReminders };
