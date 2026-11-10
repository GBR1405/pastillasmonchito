(() => {
  'use strict';

  /* ================================================================== */
  /* Utilidades                                                          */
  /* ================================================================== */

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = () => ymd(new Date());
  const parseYmd = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const addDays = (s, n) => {
    const d = parseYmd(s);
    d.setDate(d.getDate() + n);
    return ymd(d);
  };
  const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const toMin = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function fmt12(t) {
    if (!t) return '';
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
  }
  const fmtRange = (a, b) => (b ? `${fmt12(a)} – ${fmt12(b)}` : fmt12(a));
  const fmtClock = (iso) => fmt12(hhmm(new Date(iso)));
  const fmtDay = (s) => cap(parseYmd(s).toLocaleDateString('es-CR', { weekday: 'long', day: 'numeric', month: 'long' }));
  const fmtDayShort = (s) => cap(parseYmd(s).toLocaleDateString('es-CR', { weekday: 'short', day: 'numeric', month: 'short' }));
  const fmtDate = (s) => parseYmd(s).toLocaleDateString('es-CR', { day: 'numeric', month: 'short', year: 'numeric' });

  function fmtQty(q) {
    const n = Number(q);
    const whole = Math.floor(n + 1e-9);
    const frac = n - whole;
    if (Math.abs(frac) < 1e-9) return String(whole);
    if (Math.abs(frac - 0.5) < 1e-9) return whole ? `${whole}½` : '½';
    return String(Math.round(n * 100) / 100);
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* sin almacenamiento */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* sin almacenamiento */ } },
  };

  /* ================================================================== */
  /* Constantes                                                          */
  /* ================================================================== */

  const RES = {
    bien: { emoji: '😊', text: 'Se las tomó bien', cls: 'ok' },
    algunas: { emoji: '🤏', text: 'Solo tomó algunas', cls: 'warn' },
    no: { emoji: '🙅', text: 'No quiso tomarlas', cls: 'bad' },
    vomito: { emoji: '🤢', text: 'Las vomitó', cls: 'bad' },
  };
  const SYMPTOMS = [
    'Mareo', 'Cansancio o sueño', 'Náuseas', 'Vómito', 'Dolor de cabeza', 'Dolor de estómago',
    'Temblor', 'Confusión', 'Poco apetito', 'Diarrea', 'Estreñimiento', 'Fiebre', 'Caída o golpe', 'Otro',
  ];
  const NO_SYMPTOMS = 'Sin síntomas';
  const SEVERITY = { 0: 'Sin síntomas', 1: 'Leve', 2: 'Moderado', 3: 'Fuerte' };
  const OBS_QUICK = ['Comió bien', 'Comió poco', 'Durmió mal', 'Durmió mucho', 'Tomó poca agua', 'Salió a caminar', 'Estuvo de buen ánimo', 'Estuvo decaído'];
  const COLORS = ['#e05d5d', '#e8a33d', '#7a9a3a', '#2fa6a0', '#4f8fd6', '#8b6fd0', '#d97ab0', '#8a6b4f', '#5b6c63'];

  /* ================================================================== */
  /* Estado                                                              */
  /* ================================================================== */

  const S = {
    code: store.get('pf_code') || '',
    me: Number(store.get('pf_me')) || null,
    date: todayStr(),
    tab: 'hoy',
    section: 'pastillas',
    medSection: 'inventario',
    data: null,
    hist: null,
    histDays: 7,
    obsDraft: '',
    offline: false,
    loginError: '',
    pickShown: false,
    installEvt: null,
    pushSub: null,
  };

  /* ================================================================== */
  /* Red                                                                 */
  /* ================================================================== */

  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch('/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-family-code': S.code, 'x-member-id': S.me ? String(S.me) : '' },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch (_) {
      S.offline = true;
      throw new Error('Sin conexión. Revisa el internet e intenta de nuevo.');
    }
    S.offline = false;
    let data = null;
    try { data = await res.json(); } catch (_) { /* respuesta sin cuerpo */ }
    if (res.status === 401 && S.code) {
      logout('El código ya no es válido. Escríbelo de nuevo.');
      throw new Error((data && data.error) || 'Código incorrecto');
    }
    if (!res.ok) throw new Error((data && data.error) || 'Algo salió mal. Intenta de nuevo.');
    return data;
  }

  // Gabriel, Bosco y Marianne pueden entrar a Horario y Familia (lo decide el servidor)
  const isAdmin = () => !!(S.data && S.me && S.data.members.some((m) => m.id === S.me && m.admin));

  async function loadDay() {
    S.data = await api('/state?date=' + S.date);
    if (S.me && !S.data.members.some((m) => m.id === S.me)) {
      S.me = null;
      store.del('pf_me');
    }
    render();
    maybeAskWho();
  }

  async function loadHistory() {
    const to = todayStr();
    const from = addDays(to, -(S.histDays - 1));
    S.hist = null;
    render();
    S.hist = await api(`/history?from=${from}&to=${to}`);
    render();
  }

  function logout(message = '') {
    S.code = '';
    S.data = null;
    S.hist = null;
    S.loginError = message;
    store.del('pf_code');
    closeSheet();
    render();
  }

  /* ================================================================== */
  /* Recordatorios (notificaciones push)                                 */
  /* ================================================================== */

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  // on | off | denied | ios-install | unsupported | server-off
  function pushState() {
    if (!S.data || !S.data.push_key) return 'server-off';
    if (isIOS && !isStandalone()) return 'ios-install';
    if (!pushSupported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    return S.pushSub ? 'on' : 'off';
  }

  function b64ToBytes(b64) {
    const s = (b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(s);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function enablePush() {
    // Pedir permiso primero, directo desde el toque del botón (iPhone lo exige)
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      render();
      throw new Error(perm === 'denied' ? 'Las notificaciones quedaron bloqueadas. Actívalas en los ajustes del teléfono.' : 'No se activaron los recordatorios');
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(S.data.push_key) });
    await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), member_id: S.me } });
    S.pushSub = sub;
    store.del('pf_push_later');
    render();
    toast('Recordatorios activados ✓');
  }

  async function disablePush() {
    const sub = S.pushSub;
    if (!sub) return;
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    S.pushSub = null;
    render();
    toast('Recordatorios desactivados en este teléfono');
  }

  // Al abrir la app: ver si este teléfono ya tiene recordatorios y avisarle al servidor
  async function initPush() {
    if (!pushSupported() || !S.code) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      S.pushSub = sub;
      if (sub && S.data && S.data.push_key) {
        await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), member_id: S.me } });
      }
      if (!sheetOpen() && !typing()) render();
    } catch (_) { /* sin recordatorios en este navegador */ }
  }

  function pushCard() {
    const st = pushState();
    let body;
    if (st === 'on') {
      body = `<p class="push-on">✓ Activados en este teléfono</p>
        <p class="small muted">Avisa 30 minutos antes, a la hora, y si 30 minutos después nadie las ha registrado.</p>
        <div class="row">
          <button class="btn btn-small btn-soft" data-action="push-test">Mandar aviso de prueba</button>
          <button class="btn btn-small btn-ghost" data-action="push-off">Desactivar</button>
        </div>`;
    } else if (st === 'off') {
      body = `<p class="small muted">Avisa 30 minutos antes, a la hora, y si 30 minutos después nadie las ha registrado.</p>
        <button class="btn btn-primary btn-xl" data-action="push-on">🔔 Activar recordatorios</button>`;
    } else if (st === 'ios-install') {
      body = `<p class="small">En iPhone los avisos solo funcionan con la app instalada:</p>
        <ol class="steps small">
          <li>Abre esta página en <b>Safari</b>.</li>
          <li>Toca el botón <b>Compartir</b> y luego <b>“Agregar a inicio”</b>.</li>
          <li>Abre la app desde ese ícono nuevo y vuelve aquí para activarlos.</li>
        </ol>
        <p class="small muted">Necesita iOS 16.4 o más reciente.</p>`;
    } else if (st === 'denied') {
      body = `<p class="small">Las notificaciones están bloqueadas para esta app. Actívalas en los ajustes del teléfono y vuelve a abrir la app.</p>`;
    } else if (st === 'unsupported') {
      body = `<p class="small">Este navegador no permite avisos. En Android usa Chrome; en iPhone, Safari con la app agregada a inicio.</p>`;
    } else {
      body = `<p class="small muted">Los recordatorios todavía no están configurados en el servidor.</p>`;
    }
    return `<section class="card stack" id="push-card">
      <h2 class="section-title" style="margin:0">Recordatorios en este teléfono</h2>
      ${body}
    </section>`;
  }

  // Invitación en "Hoy" para activar los avisos (se puede posponer)
  function pushBanner() {
    if (S.date !== todayStr() || store.get('pf_push_later')) return '';
    const st = pushState();
    if (st !== 'off' && st !== 'ios-install') return '';
    return `<div class="push-banner">
      <span class="push-banner-ico" aria-hidden="true">🔔</span>
      <div class="push-banner-text"><b>¿Quieres que este teléfono te avise?</b><span>30 minutos antes de cada dosis.</span></div>
      <div class="push-banner-actions">
        <button class="btn btn-small btn-primary" data-action="${st === 'off' ? 'push-on' : 'go-push'}">${st === 'off' ? 'Activar' : 'Cómo activar'}</button>
        <button class="btn btn-small btn-ghost" data-action="push-later">Ahora no</button>
      </div>
    </div>`;
  }

  // Recordatorio semanal para revisar el inventario (se quita para todos cuando alguien lo revisa)
  const INV_DAYS = 7;
  function invDaysSince() {
    const at = S.data && S.data.inventory_checked_at;
    return at ? Math.floor((Date.now() - Date.parse(at)) / 86400000) : null;
  }
  const inventoryDue = () => {
    if (!S.data || !S.data.medicines.length) return false;
    const d = invDaysSince();
    return d === null || d >= INV_DAYS;
  };

  function inventoryBanner() {
    if (S.date !== todayStr() || !inventoryDue()) return '';
    const d = invDaysSince();
    return `<div class="push-banner inv-banner">
      <span class="push-banner-ico" aria-hidden="true">📦</span>
      <div class="push-banner-text"><b>Toca revisar el inventario</b><span>${
        d === null ? 'Todavía nadie lo ha revisado.' : `La última revisión fue hace ${plural(d, 'día', 'días')}.`
      } Cuenta las pastillas y corrige lo que no cuadre.</span></div>
      <div class="push-banner-actions">
        <button class="btn btn-small btn-primary" data-action="go-inventory">Revisar inventario</button>
        <button class="btn btn-small btn-ghost" data-action="inv-checked">Ya está al día</button>
      </div>
    </div>`;
  }

  // Medicinas de la lista que según el inventario no alcanzan
  function shortNames(items) {
    return items
      .filter((i) => {
        const m = S.data.medicines.find((x) => x.id === i.medicine_id);
        return m && m.stock != null && m.stock < i.quantity;
      })
      .map((i) => i.name);
  }

  /* ================================================================== */
  /* Vistas                                                              */
  /* ================================================================== */

  function render() {
    const y = window.scrollY;
    const app = $('#app');
    if (!S.code) {
      app.innerHTML = loginView();
    } else {
      app.innerHTML = headerView() + `<main class="main">${bodyView()}</main>` + tabbarView();
      fillPhotos();
    }
    window.scrollTo(0, y);
  }

  const loadingView = (msg = 'Cargando…') => `<div class="loading">${esc(msg)}</div>`;

  function loginView() {
    return `
      <main class="login">
        <div class="login-card">
          <div class="login-ico" aria-hidden="true">💊</div>
          <h1>Pastillero familiar</h1>
          <p class="muted">Escribe el código de la familia para entrar.</p>
          <form id="login-form" autocomplete="off">
            <label class="field">
              <span>Código de la familia</span>
              <input id="code-input" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" required>
            </label>
            <button class="btn btn-primary btn-xl" type="submit">Entrar</button>
            <p class="form-error" id="login-error" role="alert">${esc(S.loginError)}</p>
          </form>
        </div>
      </main>`;
  }

  function headerView() {
    const name = (S.data && S.data.patient_name) || 'Abuelo';
    const me = S.data && S.data.members.find((m) => m.id === S.me);
    return `
      <header class="topbar no-print">
        <div class="brand">
          <span class="brand-ico" aria-hidden="true">💊</span>
          <div>
            <div class="brand-title">${esc(name)}</div>
            <div class="brand-sub">${S.offline ? 'Sin conexión' : 'Registro de medicinas'}</div>
          </div>
        </div>
        <button class="me-chip" data-action="who" aria-label="Quién está usando la app">
          👤 ${me ? esc(me.name) : '¿Quién eres?'}
        </button>
      </header>`;
  }

  function tabbarView() {
    const tabs = [
      ['hoy', '💊', 'Hoy'],
      ['historial', '📋', 'Historial'],
      ['medicinas', '🧴', 'Medicinas'],
    ];
    return `<nav class="tabbar no-print" aria-label="Secciones">${tabs
      .map(
        ([id, ico, label]) =>
          `<button class="tab" data-action="tab" data-tab="${id}" ${S.tab === id ? 'aria-current="page"' : ''}>
            <span class="tab-ico" aria-hidden="true">${ico}</span>${label}
          </button>`
      )
      .join('')}</nav>`;
  }

  function bodyView() {
    if (S.tab === 'historial') return historyView();
    if (S.tab === 'medicinas') return medicinesView();
    return todayView();
  }

  /* ---------------------------- Hoy ---------------------------------- */

  const realSymptoms = (list) => list.filter((s) => !s.tags.includes(NO_SYMPTOMS));

  function todayView() {
    const d = S.data;
    if (!d || d.date !== S.date) return loadingView();
    const today = todayStr();
    const isToday = S.date === today;
    const nDone = d.slots.filter((s) => d.doses.some((x) => x.slot_id === s.id)).length;
    const real = realSymptoms(d.symptoms);
    const symBadge = real.length ? String(real.length) : d.symptoms.length ? '✓' : '';

    const sections = [
      { id: 'pastillas', n: 1, label: 'Pastillas', badge: d.slots.length ? `${nDone}/${d.slots.length}` : '' },
      { id: 'sintomas', n: 2, label: 'Síntomas', badge: symBadge },
      { id: 'observaciones', n: 3, label: 'Observaciones', badge: d.observations.length ? String(d.observations.length) : '' },
    ];

    return `
      <div class="daybar">
        <button class="icon-btn" data-action="prev-day" aria-label="Día anterior">‹</button>
        <div>
          <h1>${esc(fmtDay(S.date))}</h1>
          <span class="day-sub">${isToday ? 'Hoy' : S.date < today ? 'Día pasado' : ''}</span>
        </div>
        <button class="icon-btn" data-action="next-day" aria-label="Día siguiente" ${S.date >= today ? 'disabled' : ''}>›</button>
      </div>
      ${!isToday ? `<div class="row" style="justify-content:center;margin-bottom:12px"><button class="btn btn-small btn-soft" data-action="today">Volver a hoy</button></div>` : ''}
      ${d.members.length === 0 ? onboardingCard() : ''}
      <div class="seg" role="group" aria-label="Partes del día">
        ${sections
          .map(
            (s) => `<button data-action="section" data-section="${s.id}" aria-pressed="${S.section === s.id}">
              <span class="seg-num">${s.n}</span>${s.label}
              ${s.badge ? `<span class="seg-badge">${esc(s.badge)}</span>` : ''}
            </button>`
          )
          .join('')}
      </div>
      ${S.section === 'sintomas' ? symptomsSection() : S.section === 'observaciones' ? observationsSection() : pillsSection(nDone)}`;
  }

  function onboardingCard() {
    return `<div class="card stack" style="margin-bottom:12px">
      <p class="lead"><b>Primero, los nombres de la familia.</b><br>Así se sabrá quién da cada medicina.</p>
      <button class="btn btn-primary btn-xl" data-action="go-family">Agregar nombres</button>
    </div>`;
  }

  function alertsView() {
    const today = todayStr();
    const out = [];
    for (const m of S.data.medicines) {
      if (m.daily > 0 && m.stock != null) {
        if (m.stock <= 0) out.push(['bad', `${m.name}: se acabó. Hay que comprar.`]);
        else if (m.days_left <= 5) {
          out.push([m.days_left <= 2 ? 'bad' : 'warn', `${m.name}: ${m.days_left < 1 ? 'queda menos de 1 día' : 'alcanza para ' + plural(m.days_left, 'día', 'días')}.`]);
        }
      }
      if (m.expires_on) {
        const left = daysBetween(today, m.expires_on);
        if (left < 0) out.push(['bad', `${m.name}: venció el ${fmtDate(m.expires_on)}.`]);
        else if (left <= 30) out.push(['warn', `${m.name}: vence en ${plural(left, 'día', 'días')}.`]);
      }
    }
    return out.map(([cls, msg]) => `<div class="alert alert-${cls}"><span aria-hidden="true">⚠️</span><span>${esc(msg)}</span></div>`).join('');
  }

  // Minutos antes y después de la hora en que el horario se ilumina
  const GLOW_MIN = 30;
  const nowMin = () => {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  };
  function slotWindow(slot) {
    const start = toMin(slot.time);
    const end = slot.end_time ? Math.max(start, toMin(slot.end_time)) : start;
    return { start, end, from: start - GLOW_MIN, to: end + GLOW_MIN };
  }
  function fmtDur(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (!h) return `${Math.max(m, 1)} min`;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const faltan = (min) => `${(Math.floor(min / 60) || min) === 1 ? 'Falta' : 'Faltan'} ${fmtDur(min)}`;

  // Estado de cada horario del día. Solo uno queda como "le toca":
  // el que está dentro de su ventana (±30 min) o, si no hay, el siguiente pendiente.
  function slotStates(d) {
    const today = todayStr();
    const nowM = nowMin();
    const list = d.slots.map((slot) => {
      const dose = d.doses.find((x) => x.slot_id === slot.id);
      let status;
      if (dose) status = 'done';
      else if (S.date > today) status = 'future';
      else if (S.date < today) status = 'missed';
      else {
        const w = slotWindow(slot);
        status = nowM < w.from ? 'upcoming' : nowM <= w.to ? 'now' : 'late';
      }
      return { slot, dose, status };
    });
    if (S.date === today && !list.some((x) => x.status === 'now')) {
      const next = list.find((x) => x.status === 'upcoming');
      if (next) next.status = 'next';
    }
    return list;
  }

  const STATUS_LABEL = {
    done: ['done', 'Listo ✓'],
    now: ['now', 'Le toca ahora'],
    late: ['late', 'Atrasada'],
    next: ['next', 'Próxima'],
    upcoming: ['', 'Más tarde'],
    missed: ['late', 'Sin registrar'],
    future: ['', ''],
  };

  // Fase de la animación según el reloj, para que el brillo no "salte" al refrescar la pantalla
  const glowPhase = () => `animation-delay:-${(Date.now() % 2800) / 1000}s`;

  function itemsList(items) {
    return `<ul class="items">${items
      .map(
        (i) => `<li>
          <span class="dot" style="background:${esc(i.color || '#6dbf94')}"></span>
          <span class="qty">${fmtQty(i.quantity)}</span>
          <span class="mname">${esc(i.name)}${i.unit ? `<small>${esc(i.unit)}</small>` : ''}</span>
        </li>`
      )
      .join('')}</ul>`;
  }

  function pillsSection(nDone) {
    const d = S.data;
    if (!d.slots.length) {
      return `<div class="card empty">Todavía no hay horarios. ${
        isAdmin() ? 'Créalos en <b>Medicinas → Horario</b>.' : 'Pídele a Gabriel, Bosco o Marianne que los creen.'
      }</div>`;
    }
    const pct = Math.round((nDone / d.slots.length) * 100);
    const isToday = S.date === todayStr();
    const nowM = nowMin();
    const states = slotStates(d);

    const card = ({ slot, dose, status }) => {
        const [pcls, plabel] = STATUS_LABEL[status];
        const items = dose ? dose.items : slot.items;
        const cls = status;
        const phase = status === 'now' ? `style="${glowPhase()}"` : '';
        let footer;
        if (dose) {
          const r = RES[dose.result];
          footer = `<div class="given">
            <span class="res res-${r.cls}">${r.emoji} ${r.text}</span>
            <p>Se las dio <b>${esc(dose.given_by_name)}</b> a las ${esc(fmtClock(dose.given_at))}</p>
            ${dose.note ? `<p class="given-note">${esc(dose.note)}</p>` : ''}
            <div class="row">
              <button class="btn btn-small btn-soft" data-action="edit-dose" data-slot="${slot.id}">Editar</button>
              <button class="btn btn-small btn-ghost" data-action="undo-dose" data-id="${dose.id}">Deshacer</button>
            </div>
          </div>`;
        } else if (!items.length) {
          footer = `<p class="muted">Este horario no tiene medicinas.</p>`;
        } else {
          footer = `<button class="btn btn-primary btn-xl" data-action="give" data-slot="${slot.id}">${
            S.date < todayStr() ? 'Registrar que sí se las dieron' : 'Ya se las di'
          }</button>`;
        }
        return `<li class="tl-item tl-${cls}">
          <span class="tl-dot" aria-hidden="true" ${phase}></span>
          <article class="slot slot-${cls}" id="slot-${slot.id}" ${phase}>
            <div class="slot-head">
              <div class="slot-time">${esc(fmt12(slot.time))}${slot.end_time ? ` <small>a ${esc(fmt12(slot.end_time))}</small>` : ''}</div>
              ${plabel ? `<span class="pill ${pcls ? 'pill-' + pcls : ''}">${plabel}</span>` : ''}
            </div>
            ${itemsList(items)}
            ${footer}
          </article>
        </li>`;
    };

    // La línea de "ahora" va antes del primer horario que todavía no empieza
    const nowLine = `<li class="nowline" aria-label="Hora actual: ${esc(fmt12(hhmm(new Date())))}">
        <span class="nowline-dot" aria-hidden="true"></span>
        <span class="nowline-label"><small>Ahora</small> ${esc(fmt12(hhmm(new Date())))}</span>
        <span class="nowline-bar" aria-hidden="true"></span>
      </li>`;
    let timeline = '';
    let lineDone = !isToday;
    for (const st of states) {
      if (!lineDone && toMin(st.slot.time) > nowM) {
        timeline += nowLine;
        lineDone = true;
      }
      timeline += card(st);
    }
    if (!lineDone) timeline += nowLine;

    return `<div class="stack">
      ${dayStatus(states, nDone, pct, isToday, nowM)}
      ${inventoryBanner()}
      ${pushBanner()}
      ${alertsView()}
      <ol class="timeline" aria-label="Horarios del día">${timeline}</ol>
    </div>`;
  }

  // Resumen de arriba: qué le toca y cuánto falta
  function dayStatus(states, nDone, pct, isToday, nowM) {
    const total = states.length;
    let head = '';
    if (isToday) {
      const due = states.find((x) => x.status === 'now') || states.find((x) => x.status === 'next');
      const nLate = states.filter((x) => x.status === 'late').length;
      if (due) {
        const w = slotWindow(due.slot);
        const when = fmt12(due.slot.time);
        let title;
        let sub;
        if (due.status === 'next') {
          title = 'Le toca la de las';
          sub = faltan(w.start - nowM);
        } else if (nowM < w.start) {
          title = 'Ya casi le toca la de las';
          sub = faltan(w.start - nowM);
        } else if (nowM <= w.end) {
          title = 'Le toca ahora la de las';
          sub = 'Es la hora';
        } else {
          title = 'Le toca la de las';
          sub = `Hace ${fmtDur(nowM - w.end)} que era la hora`;
        }
        head = `<button type="button" class="due due-${due.status}" data-action="goto-slot" data-slot="${due.slot.id}">
          <span class="due-ico" aria-hidden="true">${due.status === 'now' ? '🔔' : '⏰'}</span>
          <span class="due-text"><b>${esc(title)} <span class="nowrap">${esc(when)}</span></b><span>${esc(sub)}</span></span>
        </button>`;
      } else if (nDone === total) {
        head = `<div class="due due-done"><span class="due-ico" aria-hidden="true">🎉</span>
          <span class="due-text"><b>Listo por hoy</b><span>Ya tomó todas sus pastillas</span></span></div>`;
      }
      if (nLate) {
        head += `<p class="late-note">⚠️ ${plural(nLate, 'horario atrasado', 'horarios atrasados')} sin registrar</p>`;
      }
    }
    return `<section class="card daystatus" aria-label="Resumen del día">
      ${head}
      <div class="row-between"><b>${plural(nDone, 'horario listo', 'horarios listos')} de ${total}</b><span class="muted">${pct}%</span></div>
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
    </section>`;
  }

  function symptomEntry(s, canDelete = true) {
    const isGood = s.tags.includes(NO_SYMPTOMS);
    return `<article class="entry">
      <div class="entry-top">
        <span class="entry-time">${esc(fmt12(s.time))}</span>
        <span class="sev sev-${s.severity}">${SEVERITY[s.severity] || ''}</span>
      </div>
      <div class="chips-row">${s.tags.map((t) => `<span class="tagchip ${isGood ? 'tagchip-good' : ''}">${esc(t)}</span>`).join('')}</div>
      ${s.note ? `<p>${esc(s.note)}</p>` : ''}
      <div class="entry-foot"><span>Anotó ${esc(s.by_name)}</span>
        ${canDelete ? `<button class="link-btn" data-action="del-symptom" data-id="${s.id}">Borrar</button>` : ''}
      </div>
    </article>`;
  }

  function symptomsSection() {
    const d = S.data;
    return `<div class="stack">
      <p class="muted">¿Se sintió mal o reaccionó raro? Anótalo aquí para contárselo al doctor.</p>
      <button class="btn btn-primary btn-xl" data-action="add-symptom">+ Anotar un síntoma</button>
      ${d.symptoms.length === 0 ? `<button class="btn btn-soft btn-xl" data-action="all-good">✓ Hoy no tuvo síntomas</button>` : ''}
      ${d.symptoms.length ? d.symptoms.map((s) => symptomEntry(s)).join('') : `<div class="card empty">Nada anotado todavía en este día.</div>`}
    </div>`;
  }

  function observationsSection() {
    const d = S.data;
    return `<div class="stack">
      <div class="card">
        <label class="field" style="margin-bottom:10px">
          <span>Escribe una observación</span>
          <textarea id="obs-text" rows="4" maxlength="1000" placeholder="Ej: Comió poco en el almuerzo y durmió toda la tarde.">${esc(S.obsDraft)}</textarea>
        </label>
        <div class="quick" aria-label="Frases rápidas">
          ${OBS_QUICK.map((t) => `<button type="button" data-action="obs-chip" data-text="${esc(t)}">${esc(t)}</button>`).join('')}
        </div>
        <button class="btn btn-primary btn-xl" data-action="save-obs">Guardar observación</button>
      </div>
      ${
        d.observations.length
          ? d.observations
              .map(
                (o) => `<article class="entry">
                  <div class="entry-top"><span class="entry-time">${esc(fmt12(o.time))}</span></div>
                  <p>${esc(o.text)}</p>
                  <div class="entry-foot"><span>Anotó ${esc(o.by_name)}</span>
                    <button class="link-btn" data-action="del-obs" data-id="${o.id}">Borrar</button></div>
                </article>`
              )
              .join('')
          : `<div class="card empty">Sin observaciones en este día.</div>`
      }
    </div>`;
  }

  /* -------------------------- Historial ------------------------------ */

  function historyView() {
    const h = S.hist;
    const rangeBtns = [7, 14, 30]
      .map((n) => `<button data-action="range" data-n="${n}" aria-pressed="${S.histDays === n}">${n} días</button>`)
      .join('');
    const controls = `<div class="stack no-print">
      <h1 class="section-title" style="margin-top:0">Historial y reporte</h1>
      <div class="range" role="group" aria-label="Cuántos días ver">${rangeBtns}</div>
    </div>`;
    if (!h) return controls + loadingView();

    const today = todayStr();
    const nowM = new Date().getHours() * 60 + new Date().getMinutes();
    const dates = [];
    for (let d = today; d >= h.from; d = addDays(d, -1)) dates.push(d);

    // Resumen
    const start = h.first_dose_date && h.first_dose_date > h.from ? h.first_dose_date : h.from;
    let expected = 0;
    if (h.first_dose_date) {
      for (const d of dates) {
        if (d < start) continue;
        expected += d < today ? h.slots.length : h.slots.filter((s) => toMin(s.time) <= nowM).length;
      }
    }
    const doses = h.doses.filter((x) => x.date >= start);
    const count = (r) => doses.filter((x) => x.result === r).length;
    const real = realSymptoms(h.symptoms);
    const tagCount = {};
    real.forEach((s) => s.tags.forEach((t) => { tagCount[t] = (tagCount[t] || 0) + 1; }));
    const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const strong = real.filter((s) => s.severity === 3).length;

    const summary = `<section class="card stack" aria-label="Resumen">
      <h2 class="section-title" style="margin:0">Resumen de los últimos ${S.histDays} días</h2>
      ${
        expected
          ? `<div class="stats">
              <div class="stat stat-wide"><b>${doses.length} de ${expected}</b><span>horarios con registro (${Math.round((doses.length / expected) * 100)}%)</span></div>
              <div class="stat"><b>${count('bien')}</b><span>se las tomó bien</span></div>
              <div class="stat"><b>${count('algunas')}</b><span>solo algunas</span></div>
              <div class="stat"><b>${count('no')}</b><span>no quiso</span></div>
              <div class="stat"><b>${count('vomito')}</b><span>las vomitó</span></div>
            </div>
            <p class="muted small">${expected - doses.length > 0 ? `${plural(expected - doses.length, 'horario', 'horarios')} sin registrar.` : 'Todos los horarios tienen registro.'}</p>`
          : `<p class="muted">Todavía no hay pastillas registradas en estos días.</p>`
      }
      <div>
        <b>Síntomas:</b>
        ${
          real.length
            ? `${plural(real.length, 'anotación', 'anotaciones')}${strong ? `, ${plural(strong, 'fuerte', 'fuertes')}` : ''}.
               <div class="chips-row" style="margin-top:6px">${topTags.map(([t, n]) => `<span class="tagchip">${esc(t)} · ${n}</span>`).join('')}</div>`
            : 'ninguno anotado.'
        }
      </div>
      <div><b>Observaciones:</b> ${h.observations.length ? plural(h.observations.length, 'anotada', 'anotadas') : 'ninguna'}.</div>
      <button class="btn btn-soft btn-xl no-print" data-action="print">🖨️ Imprimir o guardar PDF para el doctor</button>
    </section>`;

    // Días
    const days = dates
      .map((date, idx) => {
        const dd = h.doses.filter((x) => x.date === date);
        const ss = h.symptoms.filter((x) => x.date === date);
        const oo = h.observations.filter((x) => x.date === date);
        const realSs = realSymptoms(ss);
        const badges = [
          h.slots.length ? `<span class="badge ${dd.length >= h.slots.length ? 'badge-ok' : dd.length ? 'badge-warn' : 'badge-bad'}">💊 ${dd.length}/${h.slots.length}</span>` : '',
          realSs.length ? `<span class="badge badge-warn">⚠ ${realSs.length}</span>` : ss.length ? `<span class="badge badge-ok">✓ sin síntomas</span>` : '',
          oo.length ? `<span class="badge badge-ok">📝 ${oo.length}</span>` : '',
        ].join('');
        const body = `
          <h4>Pastillas</h4>
          ${
            dd.length
              ? dd
                  .map((x) => {
                    const r = RES[x.result];
                    return `<div class="hist-line">
                      <span class="lead-line">${esc(fmt12(x.slot_time))} · ${r.emoji} ${r.text}</span>
                      <span>${x.items.map((i) => `${fmtQty(i.quantity)} ${esc(i.name)}`).join(', ')}</span>
                      <span class="muted small">Las dio ${esc(x.given_by_name)} a las ${esc(fmtClock(x.given_at))}${x.note ? ` · “${esc(x.note)}”` : ''}</span>
                    </div>`;
                  })
                  .join('')
              : `<span class="muted">Sin pastillas registradas.</span>`
          }
          <h4>Síntomas</h4>
          ${
            ss.length
              ? ss.map((s) => `<div class="hist-line">
                  <span class="lead-line">${esc(fmt12(s.time))} · ${esc(s.tags.join(', '))} (${SEVERITY[s.severity]})</span>
                  ${s.note ? `<span>${esc(s.note)}</span>` : ''}
                  <span class="muted small">Anotó ${esc(s.by_name)}</span></div>`).join('')
              : `<span class="muted">Sin síntomas anotados.</span>`
          }
          <h4>Observaciones</h4>
          ${
            oo.length
              ? oo.map((o) => `<div class="hist-line"><span>${esc(o.text)}</span>
                  <span class="muted small">${esc(fmt12(o.time))} · ${esc(o.by_name)}</span></div>`).join('')
              : `<span class="muted">Sin observaciones.</span>`
          }`;
        return `<details class="day-details" ${idx === 0 ? 'open' : ''}>
          <summary><span>${esc(fmtDayShort(date))}</span><span class="day-badges">${badges || '<span class="muted small">Sin registros</span>'}</span></summary>
          <div class="day-body">${body}</div>
        </details>`;
      })
      .join('');

    // Cabecera y esquema solo para impresión
    const printHead = `<div class="print-only print-head">
      <h1>Reporte de medicinas — ${esc(h.patient_name)}</h1>
      <p>Del ${esc(fmtDate(h.from))} al ${esc(fmtDate(h.to))} · Generado el ${esc(fmtDate(today))}</p>
    </div>
    <div class="print-only">
      <h2>Esquema actual</h2>
      <table class="print-table"><thead><tr><th>Hora</th><th>Medicinas</th></tr></thead><tbody>
        ${h.slots.map((s) => `<tr><td>${esc(fmtRange(s.time, s.end_time))}</td><td>${s.items.map((i) => `${fmtQty(i.quantity)} ${esc(i.name)}${i.unit ? ` (${esc(i.unit)})` : ''}`).join('; ')}</td></tr>`).join('')}
      </tbody></table>
      <h2>Medicinas</h2>
      <table class="print-table"><thead><tr><th>Medicina</th><th>Presentación</th><th>Código</th><th>Vence</th></tr></thead><tbody>
        ${h.medicines.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.unit)}</td><td>${esc(m.code)}</td><td>${m.expires_on ? esc(fmtDate(m.expires_on)) : ''}</td></tr>`).join('')}
      </tbody></table>
      <h2>Registro día por día</h2>
    </div>`;

    return `${printHead}${controls}<div class="stack" style="margin-top:12px">${summary}${days}</div>`;
  }

  /* -------------------------- Medicinas ------------------------------ */

  function medicinesView() {
    const d = S.data;
    if (!d) return loadingView();
    const admin = isAdmin();
    const secs = admin
      ? [['inventario', 'Inventario'], ['horario', 'Horario'], ['familia', 'Familia']]
      : [['inventario', 'Inventario'], ['telefono', 'Este teléfono']];
    // Si alguien sin permiso quedó en Horario o Familia, vuelve a Inventario
    if (!secs.some(([id]) => id === S.medSection)) S.medSection = admin && S.medSection === 'telefono' ? 'familia' : 'inventario';
    const sub = secs
      .map(([id, label]) => `<button data-action="medsec" data-sec="${id}" aria-pressed="${S.medSection === id}">${label}</button>`)
      .join('');
    const body =
      S.medSection === 'horario' ? scheduleAdmin()
        : S.medSection === 'familia' ? familyAdmin()
          : S.medSection === 'telefono' ? phoneView()
            : inventoryAdmin();
    return `<div class="subtabs" role="group" aria-label="Secciones de medicinas" style="grid-template-columns:repeat(${secs.length},1fr)">${sub}</div>${body}`;
  }

  // Lo que cualquiera de la familia puede ver aunque no tenga acceso a Familia
  function phoneView() {
    const me = S.data.members.find((m) => m.id === S.me);
    return `<div class="stack">
      <section class="card stack">
        <p>Estás usando la app como <b>${me ? esc(me.name) : 'nadie todavía'}</b>.</p>
        <p class="small muted">Horario y Familia solo los pueden cambiar Gabriel, Bosco o Marianne.</p>
        <button class="btn btn-soft" data-action="who">Cambiar quién soy</button>
      </section>
      ${pushCard()}
      ${installCard()}
      <button class="btn btn-ghost btn-xl" data-action="logout">Salir / cambiar código</button>
    </div>`;
  }

  function installCard() {
    return `<section class="card stack">
        <h2 class="section-title" style="margin:0">Usar como app</h2>
        ${S.installEvt ? `<button class="btn btn-primary btn-xl" data-action="install">📲 Instalar en este teléfono</button>` : ''}
        <p class="small muted"><b>Android (Chrome):</b> menú ⋮ → “Instalar aplicación” o “Agregar a la pantalla principal”.<br>
        <b>iPhone (Safari):</b> botón Compartir → “Agregar a inicio”.</p>
      </section>`;
  }

  /* ---- Fotos de las cajas (se guardan en memoria para no pedirlas cada vez) ---- */
  const photoCache = new Map(); // `${id}:${photo_at}` -> data URL
  const photoKey = (m) => `${m.id}:${m.photo_at}`;

  async function getPhoto(m) {
    const k = photoKey(m);
    if (!photoCache.has(k)) {
      const p = await api(`/medicines/${m.id}/photo`);
      photoCache.set(k, p.data);
    }
    return photoCache.get(k);
  }

  // Después de pintar, llena las miniaturas que todavía no estaban cargadas
  function fillPhotos() {
    if (!S.data) return;
    document.querySelectorAll('img[data-photo]:not([src])').forEach((img) => {
      const m = S.data.medicines.find((x) => x.id === Number(img.dataset.photo));
      if (!m || !m.photo_at) return;
      getPhoto(m).then((src) => { img.src = src; }).catch(() => {});
    });
  }

  // Achica la foto del teléfono (que suele pesar varios MB) antes de subirla
  function shrinkImage(file, max = 1280, quality = 0.75) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('No se pudo leer la foto. Prueba con otra.'));
      };
      img.src = url;
    });
  }

  async function openPhoto(m) {
    openSheet(m.name, `<div class="photo-full">${loadingView()}</div>`, { plain: true });
    try {
      const src = await getPhoto(m);
      const box = $('.photo-full');
      if (box) box.innerHTML = `<img src="${esc(src)}" alt="Foto de la caja de ${esc(m.name)}">`;
    } catch (err) {
      const box = $('.photo-full');
      if (box) box.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    }
  }

  function inventoryAdmin() {
    const d = S.data;
    const today = todayStr();
    const cards = d.medicines
      .map((m) => {
        let expiry = '';
        if (m.expires_on) {
          const left = daysBetween(today, m.expires_on);
          const cls = left < 0 ? 'bad' : left <= 30 ? 'warn' : 'ok';
          const txt = left < 0 ? 'vencida' : left === 0 ? 'vence hoy' : `en ${plural(left, 'día', 'días')}`;
          expiry = `<p>Vence: ${esc(fmtDate(m.expires_on))} <span class="badge badge-${cls}">${txt}</span></p>`;
        } else {
          expiry = `<p class="muted">Vencimiento sin anotar</p>`;
        }
        let stock;
        if (m.stock == null) stock = `<p class="muted">Cantidad sin anotar</p>`;
        else {
          const cls = m.daily > 0 ? (m.days_left <= 2 ? 'bad' : m.days_left <= 5 ? 'warn' : 'ok') : 'ok';
          stock = `<p>Quedan <b>${fmtQty(m.stock)}</b>${m.daily > 0 ? ` · alcanzan para <span class="badge badge-${cls}">${m.days_left < 1 ? 'menos de 1 día' : plural(m.days_left, 'día', 'días')}</span>` : ''}</p>`;
        }
        return `<article class="card med">
          ${
            m.photo_at
              ? `<button type="button" class="med-photo" data-action="view-photo" data-id="${m.id}" aria-label="Ver la foto de la caja de ${esc(m.name)}" style="border-color:${esc(m.color)}">
                  <img data-photo="${m.id}" alt="" ${photoCache.has(photoKey(m)) ? `src="${esc(photoCache.get(photoKey(m)))}"` : ''}></button>`
              : `<span class="dot dot-big" style="background:${esc(m.color)}"></span>`
          }
          <div class="med-main">
            <h3>${esc(m.name)}</h3>
            <p class="muted">${m.unit ? esc(m.unit) : 'sin presentación'}${m.daily > 0 ? ` · ${fmtQty(m.daily)} al día` : ' · sin horario'}</p>
            ${stock}
            ${expiry}
            ${m.code ? `<p class="muted small">Código: ${esc(m.code)}</p>` : ''}
            ${m.notes ? `<p class="small">${esc(m.notes)}</p>` : ''}
          </div>
          <div class="med-actions">
            <button class="btn btn-small btn-soft" data-action="restock" data-id="${m.id}">+ Agregar cantidad</button>
            <button class="btn btn-small btn-ghost" data-action="edit-med" data-id="${m.id}">Editar</button>
          </div>
        </article>`;
      })
      .join('');
    const since = invDaysSince();
    const due = inventoryDue();
    return `<div class="stack">
      <section class="card stack inv-check ${due ? 'inv-check-due' : ''}">
        <p><b>Revisión del inventario:</b> ${
          since === null ? 'nunca se ha hecho.' : since === 0 ? 'se hizo hoy ✓' : `hace ${plural(since, 'día', 'días')}.`
        }</p>
        <p class="small muted">Cada semana cuenten lo que queda y corrijan con “Editar”. Las tomas lo van restando solas.</p>
        <button class="btn ${due ? 'btn-primary' : 'btn-soft'}" data-action="inv-checked">✓ Ya revisé el inventario</button>
      </section>
      <button class="btn btn-primary btn-xl" data-action="add-med">+ Nueva medicina</button>
      ${alertsView()}
      ${cards || `<div class="card empty">No hay medicinas todavía.</div>`}
    </div>`;
  }

  function scheduleAdmin() {
    const d = S.data;
    const cards = d.slots
      .map(
        (s) => `<article class="card slot-edit">
          <div class="row-between">
            <h3>${esc(fmtRange(s.time, s.end_time))}</h3>
            <div class="row">
              <button class="btn btn-small btn-soft" data-action="edit-slot" data-id="${s.id}">Cambiar hora</button>
              <button class="btn btn-small btn-danger" data-action="del-slot" data-id="${s.id}">Quitar</button>
            </div>
          </div>
          <ul>${
            s.items.length
              ? s.items
                  .map(
                    (i) => `<li>
                      <span class="dot" style="background:${esc(i.color)}"></span>
                      <span class="qty">${fmtQty(i.quantity)}</span>
                      <span class="grow">${esc(i.name)}${i.unit ? `<small>${esc(i.unit)}</small>` : ''}</span>
                      <button class="icon-btn" data-action="edit-item" data-id="${i.id}" aria-label="Cambiar la cantidad de ${esc(i.name)}" title="Cambiar cantidad">✎</button>
                      <button class="icon-btn" data-action="del-item" data-id="${i.id}" aria-label="Quitar ${esc(i.name)} de este horario" title="Quitar">✕</button>
                    </li>`
                  )
                  .join('')
              : `<li class="muted">Sin medicinas en este horario.</li>`
          }</ul>
          <button class="btn btn-soft btn-xl" data-action="add-item" data-slot="${s.id}">+ Agregar medicina a este horario</button>
        </article>`
      )
      .join('');
    return `<div class="stack">
      <p class="muted">Si el doctor cambia una dosis, cámbiala aquí. Lo que ya se registró antes no se modifica.</p>
      ${cards || `<div class="card empty">No hay horarios todavía.</div>`}
      <button class="btn btn-primary btn-xl" data-action="add-slot">+ Nuevo horario</button>
    </div>`;
  }

  function familyAdmin() {
    const d = S.data;
    const locked = d.members_locked;
    const members = d.members
      .map(
        (m) => `<div class="member-row"><b>${esc(m.name)}${m.id === S.me ? ' <span class="badge badge-ok">tú</span>' : ''}</b>
          ${locked ? '' : `<button class="link-btn" data-action="del-member" data-id="${m.id}">Quitar</button>`}</div>`
      )
      .join('');
    return `<div class="stack">
      <section class="card">
        <h2 class="section-title" style="margin:0 0 6px">Quiénes ayudan</h2>
        ${members || `<p class="muted">Todavía no hay nombres.</p>`}
        ${
          locked
            ? `<p class="small muted" style="margin-top:10px">Esta lista es fija. Para cambiarla, quien administra la app edita FAMILY_MEMBERS en Vercel.</p>`
            : `<form id="member-form" class="add-row">
          <input type="text" id="member-name" maxlength="40" placeholder="Escribe un nombre" aria-label="Nombre de la persona" required>
          <button class="btn btn-primary" type="submit">Agregar</button>
        </form>`
        }
      </section>
      ${pushCard()}
      <section class="card">
        <h2 class="section-title" style="margin:0 0 6px">Nombre de quien recibe las medicinas</h2>
        <form id="patient-form" class="add-row">
          <input type="text" id="patient-name" maxlength="40" value="${esc(d.patient_name)}" aria-label="Nombre del paciente" required>
          <button class="btn btn-soft" type="submit">Guardar</button>
        </form>
      </section>
      ${installCard()}
      <button class="btn btn-ghost btn-xl" data-action="logout">Salir / cambiar código</button>
    </div>`;
  }

  /* ================================================================== */
  /* Ventanas inferiores (formularios)                                   */
  /* ================================================================== */

  function closeSheet() {
    $('#sheet-root').innerHTML = '';
    document.body.classList.remove('sheet-open');
  }
  const sheetOpen = () => !!$('#sheet-root').firstChild;

  function openSheet(title, bodyHtml, { onSubmit, submitLabel = 'Guardar', plain = false } = {}) {
    const root = $('#sheet-root');
    const foot = plain
      ? ''
      : `<div class="sheet-foot">
          <button type="button" class="btn btn-ghost" data-action="close-sheet">Cancelar</button>
          <button type="submit" class="btn btn-primary">${esc(submitLabel)}</button>
        </div>
        <p class="form-error" id="sheet-error" role="alert"></p>`;
    const tag = plain ? 'div' : 'form';
    root.innerHTML = `<div class="sheet-backdrop" data-action="close-sheet"></div>
      <${tag} class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}" ${plain ? '' : 'novalidate'}>
        <div class="sheet-head"><h2>${esc(title)}</h2>
          <button type="button" class="icon-btn" data-action="close-sheet" aria-label="Cerrar">✕</button></div>
        <div class="sheet-body">${bodyHtml}</div>
        ${foot}
      </${tag}>`;
    document.body.classList.add('sheet-open');
    $('#toast').classList.remove('show'); // que un aviso anterior no tape el formulario
    if (!plain) {
      const form = $('form.sheet', root);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!form.checkValidity()) {
          form.reportValidity();
          return;
        }
        const btn = $('[type=submit]', form);
        btn.disabled = true;
        try {
          await onSubmit(form);
          closeSheet();
        } catch (err) {
          $('#sheet-error').textContent = err.message;
          btn.disabled = false;
        }
      });
    }
  }

  const memberOptions = (selected) =>
    `<option value="">Elige un nombre…</option>` +
    S.data.members.map((m) => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${esc(m.name)}</option>`).join('');

  /* ---- Quién eres ---- */
  function openPickMe() {
    const members = S.data ? S.data.members : [];
    const list = members.length
      ? `<div class="pick-list">${members
          .map((m) => `<button class="btn btn-soft btn-xl" data-action="pick-me" data-id="${m.id}">${esc(m.name)}</button>`)
          .join('')}</div>`
      : `<p class="muted" style="margin-bottom:12px">Todavía no hay nombres.</p>`;
    if (S.data && S.data.members_locked) {
      openSheet(
        '¿Quién eres?',
        `${list}<p class="small muted" style="margin-bottom:14px">¿No estás en la lista? Pídele a quien administra la app que te agregue.</p>`,
        { plain: true }
      );
      return;
    }
    openSheet(
      '¿Quién eres?',
      `${list}
       <form id="pick-add-form" class="field">
         <span>¿No estás en la lista? Escribe tu nombre</span>
         <div class="add-row" style="margin-top:0">
           <input type="text" id="pick-add-name" maxlength="40" placeholder="Tu nombre" required>
           <button class="btn btn-primary" type="submit">Agregar</button>
         </div>
         <p class="form-error" id="pick-error" role="alert" style="padding:0"></p>
       </form>`,
      { plain: true }
    );
  }

  function maybeAskWho() {
    if (S.tab !== 'hoy' || S.me || S.pickShown || !S.data || !S.data.members.length || sheetOpen()) return;
    S.pickShown = true;
    openPickMe();
  }

  function needMe() {
    if (S.me) return true;
    if (!S.data.members.length) {
      toast('Primero agrega tu nombre');
      openPickMe();
      return false;
    }
    toast('Elige quién eres y vuelve a intentarlo');
    openPickMe();
    return false;
  }

  /* ---- Dar pastillas ---- */
  function giveSheet(slot, dose) {
    if (!S.data.members.length) {
      needMe();
      return;
    }
    const items = dose ? dose.items : slot.items;
    const isToday = S.date === todayStr();
    const defTime = dose ? hhmm(new Date(dose.given_at)) : isToday ? hhmm(new Date()) : slot.time;
    const selectedResult = dose ? dose.result : 'bien';
    const short = dose ? [] : shortNames(items);
    openSheet(
      `${fmt12(slot.time)} · ${dose ? 'Editar registro' : '¿Se las diste?'}`,
      `<p class="sheet-lead">${items.map((i) => `${fmtQty(i.quantity)} ${esc(i.name)}`).join(' · ')}</p>
       ${short.length ? `<div class="alert alert-warn"><span aria-hidden="true">⚠️</span><span>Según el inventario no hay suficiente <b>${esc(short.join(', '))}</b>. Igual puedes registrar la toma; después actualiza el inventario.</span></div>` : ''}
       <label class="field"><span>¿Quién se las dio?</span>
         <select name="by" required>${memberOptions(dose ? dose.given_by_id : S.me)}</select></label>
       <fieldset class="field"><legend>¿Cómo le fue?</legend>
         <div class="choices">${Object.entries(RES)
           .map(
             ([key, r]) => `<label class="choice"><input type="radio" name="result" value="${key}" ${key === selectedResult ? 'checked' : ''}>
               <span><b aria-hidden="true">${r.emoji}</b>${r.text}</span></label>`
           )
           .join('')}</div></fieldset>
       <label class="field"><span>Hora en que las tomó</span><input type="time" name="time" value="${defTime}" required></label>
       <label class="field"><span>Nota (opcional)</span>
         <textarea name="note" rows="3" maxlength="500" placeholder="Ej: Las tomó con jugo, un poco mareado.">${esc(dose ? dose.note : '')}</textarea></label>`,
      {
        submitLabel: 'Guardar',
        onSubmit: async (f) => {
          const time = f.elements.time.value;
          const r = await api('/doses', {
            method: 'POST',
            body: {
              date: S.date,
              slot_id: slot.id,
              given_by_id: Number(f.elements.by.value),
              result: f.elements.result.value,
              note: f.elements.note.value,
              given_at: new Date(`${S.date}T${time}:00`).toISOString(),
            },
          });
          if (!dose) {
            S.me = Number(f.elements.by.value);
            store.set('pf_me', String(S.me));
          }
          await loadDay();
          const missing = (r && r.short) || [];
          if (missing.length) {
            toast(`Guardado ✓ Pero en el inventario no había ${missing.join(', ')}. Actualiza el inventario.`, 6000);
          } else toast('Guardado ✓');
        },
      }
    );
  }

  /* ---- Síntomas ---- */
  function symptomSheet() {
    if (!needMe()) return;
    openSheet(
      'Anotar un síntoma',
      `<fieldset class="field"><legend>¿Qué notaron? (puedes marcar varios)</legend>
         <div class="chips">${SYMPTOMS.map((t) => `<label class="chip"><input type="checkbox" name="tag" value="${esc(t)}"><span>${esc(t)}</span></label>`).join('')}</div></fieldset>
       <fieldset class="field"><legend>¿Qué tan fuerte?</legend>
         <div class="choices-row">
           ${[1, 2, 3].map((n) => `<label class="choice"><input type="radio" name="sev" value="${n}" ${n === 1 ? 'checked' : ''}><span>${SEVERITY[n]}</span></label>`).join('')}
         </div></fieldset>
       <label class="field"><span>Hora</span><input type="time" name="time" value="${hhmm(new Date())}" required></label>
       <label class="field"><span>Detalles (opcional)</span>
         <textarea name="note" rows="3" maxlength="500" placeholder="Ej: Se mareó a la media hora de tomar las pastillas."></textarea></label>`,
      {
        submitLabel: 'Guardar',
        onSubmit: async (f) => {
          const tags = [...f.querySelectorAll('input[name=tag]:checked')].map((i) => i.value);
          const note = f.elements.note.value.trim();
          if (!tags.length && !note) throw new Error('Marca al menos un síntoma o escribe un detalle.');
          await api('/symptoms', {
            method: 'POST',
            body: { date: S.date, time: f.elements.time.value, tags, severity: Number(f.elements.sev.value), note, by_id: S.me },
          });
          await loadDay();
          toast('Síntoma anotado ✓');
        },
      }
    );
  }

  /* ---- Medicinas ---- */
  function medSheet(med) {
    const m = med || { name: '', unit: '', code: '', expires_on: '', stock: '', color: COLORS[4], notes: '' };
    openSheet(
      med ? 'Editar medicina' : 'Nueva medicina',
      `<label class="field"><span>Nombre</span><input type="text" name="name" maxlength="60" value="${esc(m.name)}" required></label>
       <label class="field"><span>Presentación</span>
         <input type="text" name="unit" maxlength="30" value="${esc(m.unit)}" placeholder="pastilla, gotas, tubo, jarabe…">
         <span class="field-hint">Cómo se cuenta: “2 pastillas”, “10 gotas”…</span></label>
       <label class="field"><span>Cuántas hay (opcional)</span>
         <input type="number" name="stock" inputmode="decimal" min="0" step="0.5" value="${m.stock ?? ''}" placeholder="Ej: 30">
         <span class="field-hint">Se resta solo cada vez que se registra una toma.</span></label>
       <label class="field"><span>Fecha de vencimiento (opcional)</span><input type="date" name="expires" value="${esc(m.expires_on || '')}"></label>
       <label class="field"><span>Código o lote (opcional)</span><input type="text" name="code" maxlength="40" value="${esc(m.code)}"></label>
       <fieldset class="field"><legend>Color para reconocerla</legend>
         <div class="swatches">${COLORS.map((c) => `<label class="swatch"><input type="radio" name="color" value="${c}" ${c.toLowerCase() === String(m.color).toLowerCase() ? 'checked' : ''} aria-label="Color ${c}"><span style="background:${c}"></span></label>`).join('')}</div></fieldset>
       <label class="field"><span>Notas (opcional)</span>
         <textarea name="notes" rows="2" maxlength="300" placeholder="Ej: tomar con comida.">${esc(m.notes)}</textarea></label>
       <div class="field"><span>Foto de la caja (opcional)</span>
         <div class="photo-pick">
           <div class="photo-preview" id="photo-preview"></div>
           <div class="photo-btns">
             <label class="btn btn-soft btn-small photo-file">📷 <span id="photo-btn-label">Tomar o elegir foto</span>
               <input type="file" id="photo-input" accept="image/*"></label>
             <button type="button" class="btn btn-ghost btn-small" id="photo-remove" hidden>Quitar foto</button>
           </div>
         </div>
         <span class="field-hint">Sirve para reconocer la caja o enseñársela al doctor o en la farmacia.</span></div>
       ${med ? `<button type="button" class="btn btn-danger btn-xl" data-action="del-med" data-id="${med.id}" style="margin-bottom:14px">Quitar esta medicina</button>` : ''}`,
      {
        onSubmit: async (f) => {
          const body = {
            name: f.elements.name.value,
            unit: f.elements.unit.value,
            stock: f.elements.stock.value === '' ? null : Number(f.elements.stock.value),
            expires_on: f.elements.expires.value,
            code: f.elements.code.value,
            color: (f.querySelector('input[name=color]:checked') || {}).value || COLORS[4],
            notes: f.elements.notes.value,
          };
          const r = await api(med ? `/medicines/${med.id}` : '/medicines', { method: med ? 'PUT' : 'POST', body });
          const id = med ? med.id : r.id;
          let photoErr = '';
          try {
            if (photo.data) await api(`/medicines/${id}/photo`, { method: 'PUT', body: { data: photo.data } });
            else if (photo.removed) await api(`/medicines/${id}/photo`, { method: 'DELETE' });
          } catch (err) {
            photoErr = err.message;
          }
          await loadDay();
          toast(photoErr ? `Guardado, pero la foto no se subió: ${photoErr}` : 'Guardado ✓');
        },
      }
    );

    // Foto: se elige aquí y se sube al guardar
    const photo = { data: null, removed: false };
    const preview = $('#photo-preview');
    const removeBtn = $('#photo-remove');
    const label = $('#photo-btn-label');
    const show = (src) => {
      preview.innerHTML = src ? `<img src="${esc(src)}" alt="Foto de la caja">` : '<span aria-hidden="true">📦</span>';
      removeBtn.hidden = !src;
      label.textContent = src ? 'Cambiar foto' : 'Tomar o elegir foto';
    };
    show(null);
    if (med && med.photo_at) {
      preview.innerHTML = '<span class="small muted">Cargando…</span>';
      getPhoto(med).then((src) => { if (!photo.data && !photo.removed) show(src); }).catch(() => show(null));
    }
    $('#photo-input').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      preview.innerHTML = '<span class="small muted">Preparando…</span>';
      try {
        photo.data = await shrinkImage(file);
        photo.removed = false;
        show(photo.data);
      } catch (err) {
        show(null);
        $('#sheet-error').textContent = err.message;
      }
    });
    removeBtn.addEventListener('click', () => {
      photo.data = null;
      photo.removed = !!(med && med.photo_at);
      show(null);
    });
  }

  function restockSheet(med) {
    openSheet(
      `Agregar ${med.name}`,
      `<p class="sheet-lead">Ahora ${med.stock == null ? 'no hay cantidad anotada' : 'quedan ' + fmtQty(med.stock)}${med.unit ? ' (' + esc(med.unit) + ')' : ''}.</p>
       <label class="field"><span>¿Cuántas se agregan?</span>
         <input type="number" name="amount" inputmode="decimal" min="0.5" step="0.5" required placeholder="Ej: 30"></label>`,
      {
        submitLabel: 'Agregar',
        onSubmit: async (f) => {
          await api(`/medicines/${med.id}/restock`, { method: 'POST', body: { amount: Number(f.elements.amount.value) } });
          await loadDay();
          toast('Cantidad actualizada ✓');
        },
      }
    );
  }

  /* ---- Horarios ---- */
  function slotSheet(slot) {
    openSheet(
      slot ? 'Cambiar hora' : 'Nuevo horario',
      `<label class="field"><span>Hora</span><input type="time" name="time" value="${slot ? slot.time : ''}" required></label>
       <label class="field"><span>Hasta (opcional)</span><input type="time" name="end" value="${slot && slot.end_time ? slot.end_time : ''}">
         <span class="field-hint">Úsalo si hay un rango, por ejemplo 5:30 a 6:00.</span></label>`,
      {
        onSubmit: async (f) => {
          await api(slot ? `/slots/${slot.id}` : '/slots', {
            method: slot ? 'PUT' : 'POST',
            body: { time: f.elements.time.value, end_time: f.elements.end.value },
          });
          await loadDay();
          toast('Horario guardado ✓');
        },
      }
    );
  }

  function itemSheet(slotId, item) {
    const meds = S.data.medicines;
    if (!item && !meds.length) {
      toast('Primero crea una medicina en Inventario');
      return;
    }
    const med = item ? meds.find((m) => m.id === item.medicine_id) || { name: item.name, unit: item.unit } : null;
    openSheet(
      item ? `Cantidad de ${item.name}` : 'Agregar medicina al horario',
      `${
        item
          ? `<p class="sheet-lead">${esc(med.name)}${med.unit ? ' · ' + esc(med.unit) : ''}</p>`
          : `<label class="field"><span>Medicina</span><select name="med" required>
              <option value="">Elige una…</option>
              ${meds.map((m) => `<option value="${m.id}">${esc(m.name)}${m.unit ? ' (' + esc(m.unit) + ')' : ''}</option>`).join('')}
            </select></label>`
      }
       <label class="field"><span>¿Cuántas cada vez?</span>
         <input type="number" name="qty" inputmode="decimal" min="0.5" step="0.5" value="${item ? item.quantity : 1}" required>
         <span class="field-hint">Puedes usar medias: 0.5 = ½ pastilla.</span></label>`,
      {
        onSubmit: async (f) => {
          const quantity = Number(f.elements.qty.value);
          if (item) await api(`/items/${item.id}`, { method: 'PUT', body: { quantity } });
          else await api(`/slots/${slotId}/items`, { method: 'POST', body: { medicine_id: Number(f.elements.med.value), quantity } });
          await loadDay();
          toast('Horario actualizado ✓');
        },
      }
    );
  }

  /* ================================================================== */
  /* Avisos                                                              */
  /* ================================================================== */

  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  /* ================================================================== */
  /* Acciones                                                            */
  /* ================================================================== */

  const findItem = (id) => {
    for (const s of S.data.slots) {
      const it = s.items.find((i) => i.id === id);
      if (it) return { slot: s, item: it };
    }
    return null;
  };

  async function handle(action, el) {
    const id = Number(el.dataset.id);
    switch (action) {
      case 'close-sheet': closeSheet(); break;
      case 'tab':
        S.tab = el.dataset.tab;
        render();
        window.scrollTo(0, 0);
        if (S.tab === 'historial') await loadHistory();
        else await loadDay();
        break;
      case 'section': S.section = el.dataset.section; render(); break;
      case 'medsec': S.medSection = el.dataset.sec; render(); break;
      case 'go-family':
        if (isAdmin()) { S.tab = 'medicinas'; S.medSection = 'familia'; render(); window.scrollTo(0, 0); }
        else openPickMe();
        break;
      case 'go-inventory': S.tab = 'medicinas'; S.medSection = 'inventario'; render(); window.scrollTo(0, 0); break;
      case 'inv-checked':
        await api('/inventory/checked', { method: 'POST' });
        await loadDay();
        toast('Inventario revisado ✓ Te avisamos de nuevo en una semana.');
        break;
      case 'view-photo': { const m = S.data.medicines.find((x) => x.id === id); if (m) await openPhoto(m); break; }
      case 'prev-day': S.date = addDays(S.date, -1); render(); await loadDay(); break;
      case 'next-day':
        if (S.date < todayStr()) { S.date = addDays(S.date, 1); render(); await loadDay(); }
        break;
      case 'today': S.date = todayStr(); render(); await loadDay(); break;
      case 'who': openPickMe(); break;
      case 'pick-me':
        S.me = id;
        store.set('pf_me', String(id));
        closeSheet();
        render();
        toast('Hola 👋');
        break;
      case 'push-on': await enablePush(); break;
      case 'push-off': await disablePush(); break;
      case 'push-test':
        if (S.pushSub) {
          await api('/push/test', { method: 'POST', body: { endpoint: S.pushSub.endpoint } });
          toast('Aviso de prueba enviado');
        }
        break;
      case 'push-later': store.set('pf_push_later', '1'); render(); break;
      case 'go-push': {
        S.tab = 'medicinas';
        S.medSection = isAdmin() ? 'familia' : 'telefono';
        render();
        const c = $('#push-card');
        if (c) c.scrollIntoView({ block: 'center' });
        break;
      }
      case 'goto-slot': {
        const card = document.getElementById('slot-' + el.dataset.slot);
        if (card) card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
        break;
      }
      case 'give': giveSheet(S.data.slots.find((s) => s.id === Number(el.dataset.slot))); break;
      case 'edit-dose': {
        const slot = S.data.slots.find((s) => s.id === Number(el.dataset.slot));
        const dose = S.data.doses.find((x) => x.slot_id === Number(el.dataset.slot));
        if (slot && dose) giveSheet(slot, dose);
        break;
      }
      case 'undo-dose':
        if (confirm('¿Deshacer este registro? Se devolverán las pastillas al inventario.')) {
          await api(`/doses/${id}`, { method: 'DELETE' });
          await loadDay();
          toast('Registro deshecho');
        }
        break;
      case 'add-symptom': symptomSheet(); break;
      case 'all-good':
        if (needMe()) {
          await api('/symptoms', {
            method: 'POST',
            body: { date: S.date, time: hhmm(new Date()), tags: [NO_SYMPTOMS], severity: 0, note: '', by_id: S.me },
          });
          await loadDay();
          toast('Anotado ✓');
        }
        break;
      case 'del-symptom':
        if (confirm('¿Borrar este síntoma?')) { await api(`/symptoms/${id}`, { method: 'DELETE' }); await loadDay(); }
        break;
      case 'obs-chip': {
        const ta = $('#obs-text');
        if (ta) {
          ta.value = ta.value.trim() ? `${ta.value.trim()}. ${el.dataset.text}` : el.dataset.text;
          S.obsDraft = ta.value;
          ta.focus();
        }
        break;
      }
      case 'save-obs': {
        const text = ($('#obs-text').value || '').trim();
        if (!text) { toast('Escribe algo primero'); break; }
        if (!needMe()) break;
        await api('/observations', { method: 'POST', body: { date: S.date, time: hhmm(new Date()), text, by_id: S.me } });
        S.obsDraft = '';
        await loadDay();
        toast('Observación guardada ✓');
        break;
      }
      case 'del-obs':
        if (confirm('¿Borrar esta observación?')) { await api(`/observations/${id}`, { method: 'DELETE' }); await loadDay(); }
        break;
      case 'range': S.histDays = Number(el.dataset.n); await loadHistory(); break;
      case 'print':
        document.querySelectorAll('.day-details').forEach((d) => { d.open = true; });
        setTimeout(() => window.print(), 80);
        break;
      case 'add-med': medSheet(null); break;
      case 'edit-med': medSheet(S.data.medicines.find((m) => m.id === id)); break;
      case 'restock': restockSheet(S.data.medicines.find((m) => m.id === id)); break;
      case 'del-med':
        if (confirm('¿Quitar esta medicina? También saldrá de los horarios (el historial se conserva).')) {
          await api(`/medicines/${id}`, { method: 'DELETE' });
          closeSheet();
          await loadDay();
          toast('Medicina quitada');
        }
        break;
      case 'add-slot': slotSheet(null); break;
      case 'edit-slot': slotSheet(S.data.slots.find((s) => s.id === id)); break;
      case 'del-slot':
        if (confirm('¿Quitar este horario? El historial se conserva.')) { await api(`/slots/${id}`, { method: 'DELETE' }); await loadDay(); }
        break;
      case 'add-item': itemSheet(Number(el.dataset.slot), null); break;
      case 'edit-item': { const f = findItem(id); if (f) itemSheet(f.slot.id, f.item); break; }
      case 'del-item':
        if (confirm('¿Quitar esta medicina del horario?')) { await api(`/items/${id}`, { method: 'DELETE' }); await loadDay(); }
        break;
      case 'del-member':
        if (confirm('¿Quitar a esta persona de la lista? Sus registros anteriores se conservan.')) {
          await api(`/members/${id}`, { method: 'DELETE' });
          await loadDay();
        }
        break;
      case 'install':
        if (S.installEvt) { S.installEvt.prompt(); S.installEvt = null; render(); }
        break;
      case 'logout':
        if (confirm('¿Salir de la app en este teléfono?')) { store.del('pf_me'); S.me = null; logout(); }
        break;
      default: break;
    }
  }

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    try {
      await handle(el.dataset.action, el);
    } catch (err) {
      toast(err.message);
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'obs-text') S.obsDraft = e.target.value;
  });

  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!form.id) return;
    e.preventDefault();
    try {
      if (form.id === 'login-form') {
        const code = $('#code-input').value.trim();
        if (!code) return;
        S.code = code;
        S.loginError = '';
        const btn = $('button[type=submit]', form);
        btn.disabled = true;
        try {
          await api('/auth');
        } catch (err) {
          S.code = '';
          S.loginError = err.message;
          render();
          return;
        }
        store.set('pf_code', code);
        S.pickShown = false;
        render();
        await loadDay();
        initPush();
      } else if (form.id === 'member-form') {
        const input = $('#member-name');
        await api('/members', { method: 'POST', body: { name: input.value } });
        input.value = '';
        await loadDay();
        toast('Nombre agregado ✓');
      } else if (form.id === 'patient-form') {
        await api('/settings', { method: 'PUT', body: { patient_name: $('#patient-name').value } });
        await loadDay();
        toast('Guardado ✓');
      } else if (form.id === 'pick-add-form') {
        try {
          const r = await api('/members', { method: 'POST', body: { name: $('#pick-add-name').value } });
          S.me = r.id;
          store.set('pf_me', String(r.id));
          closeSheet();
          await loadDay();
          toast('Hola 👋');
        } catch (err) {
          $('#pick-error').textContent = err.message;
        }
      }
    } catch (err) {
      toast(err.message);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheetOpen()) closeSheet();
  });

  /* ================================================================== */
  /* Actualización automática y arranque                                 */
  /* ================================================================== */

  const typing = () => {
    const a = document.activeElement;
    return a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT');
  };

  async function refresh() {
    if (!S.code || document.hidden || sheetOpen() || typing()) return;
    try {
      if (S.tab === 'historial') {
        const to = todayStr();
        S.hist = await api(`/history?from=${addDays(to, -(S.histDays - 1))}&to=${to}`);
        render();
      } else {
        S.data = await api('/state?date=' + S.date);
        render();
      }
    } catch (_) { /* se reintenta en el siguiente ciclo */ }
  }

  setInterval(refresh, 20000);

  // Reloj: mueve la línea de "ahora" y el brillo aunque no haya internet,
  // y pasa solo al día nuevo a la medianoche si estaban viendo "hoy".
  let lastToday = todayStr();
  setInterval(() => {
    if (!S.code || document.hidden || sheetOpen() || typing()) return;
    const t = todayStr();
    if (t !== lastToday) {
      const wasToday = S.date === lastToday;
      lastToday = t;
      if (wasToday) {
        S.date = t;
        loadDay().catch(() => {});
        return;
      }
    }
    if (S.tab === 'hoy' && S.section === 'pastillas' && S.date === t && S.data && S.data.date === t) render();
  }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('online', () => { S.offline = false; refresh(); });
  window.addEventListener('beforeprint', () => document.querySelectorAll('.day-details').forEach((d) => { d.open = true; }));

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    S.installEvt = e;
    if (S.code && S.tab === 'medicinas' && (S.medSection === 'familia' || S.medSection === 'telefono')) render();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  render();
  if (S.code) loadDay().then(initPush).catch((err) => { if (S.code) toast(err.message); render(); });
})();
