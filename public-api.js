// MT Aesthetics · API pública: reserva abierta y app de la clienta (enlace personal).
// El catálogo, el horario y las reglas de salud se leen de public/app.html para que el programa
// de María y la reserva pública usen exactamente las mismas reglas.
// Puntos de enganche para después: STRIPE_SECRET_KEY (depósito), RESEND_API_KEY (correo), TWILIO_* (SMS).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

function loadCatalog(appFile) {
  const src = fs.readFileSync(appFile, 'utf8');
  const a = src.indexOf('const OPEN='), b = src.indexOf('/* Ventas */');
  if (a < 0 || b < 0) throw new Error('No se encontró el catálogo en app.html');
  const code = src.slice(a, b) + '\n;({OPEN,CLOSE,STEP,HOURS,CATS,SERVICES,SVC,HEALTH,CONTRA,CONSENT_SVCS,REBOOK_DAYS,contraFor,needsConsent,consentText});';
  return vm.runInNewContext(code, {});
}

const AFTERCARE = {
  'Faciales': ['Evita el sol directo 48 horas y usa protector SPF 30 o más cada día.', 'No uses retinol, ácidos ni exfoliantes por 3 días.', 'Hidrata la piel mañana y noche.', 'Si notas enrojecimiento que no baja en 48 horas, escríbele a María.'],
  'Masajes': ['Toma bastante agua el resto del día.', 'Evita duchas muy calientes por unas horas.', 'Descansa y evita ejercicio intenso hoy.'],
  'Wax · Mujeres': ['Nada de sol, sauna, piscina ni ejercicio intenso por 24 horas.', 'No uses cremas perfumadas en la zona por 24 horas.', 'Exfolia suavemente a partir del tercer día para evitar vellos encarnados.', 'Usa ropa holgada hoy.'],
  'Wax · Hombres': ['Nada de sol, sauna, piscina ni ejercicio intenso por 24 horas.', 'No uses cremas perfumadas en la zona por 24 horas.', 'Exfolia suavemente a partir del tercer día para evitar vellos encarnados.'],
  'HIFU': ['Es normal sentir la zona sensible o un poco hinchada por unos días.', 'Usa protector solar diario.', 'Evita calor intenso (sauna, vapor) por 3 días.', 'Los resultados se ven poco a poco en las siguientes semanas.'],
  'Consulta': ['Trae a tu próxima cita la lista de productos que usas.']
};

const pad = n => String(n).padStart(2, '0');
const ymdNY = (d = new Date()) => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); return p; };
const minNY = (d = new Date()) => { const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(d).split(':').map(Number); return h * 60 + m; };
const dow = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
const toMin = hm => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };
const toHM = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const digits = s => String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const uid = () => crypto.randomBytes(6).toString('hex');
const token = () => crypto.randomBytes(18).toString('base64url');
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isHM = s => /^\d{2}:\d{2}$/.test(s);
const ACTIVE = new Set(['hold', 'confirmed', 'done', 'paid']);
const BOOK_DAYS_AHEAD = 60;

module.exports = function publicApi({ store, save, send, readBody, PUB }) {
  const cat = loadCatalog(path.join(PUB, 'app.html'));
  const col = c => (store.data[c] = store.data[c] || {});
  const settings = () => ({ deposit: 25, refundHours: 24, ...(col('settings').main || {}) });
  const commit = () => { store.rev++; save(); };

  // ---- integraciones (apagadas hasta que se configuren) ----
  const integrations = {
    payments: !!process.env.STRIPE_SECRET_KEY,
    email: !!process.env.RESEND_API_KEY,
    sms: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM)
  };
  // ---- depósito con Stripe Checkout (sin librerías: API REST) ----
  const STRIPE = process.env.STRIPE_SECRET_KEY;
  const HOLD_MIN = 32;   // el turno queda apartado mientras paga; la página de pago vence a los 31 min
  function form(obj, pre = '', out = []) {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null) continue;
      const key = pre ? `${pre}[${k}]` : k;
      if (typeof v === 'object') form(v, key, out); else out.push([key, String(v)]);
    }
    return out;
  }
  async function stripe(p, params, method = 'POST') {
    const r = await fetch((process.env.STRIPE_API_BASE || 'https://api.stripe.com/v1') + p, {
      method, headers: { authorization: 'Bearer ' + STRIPE, 'content-type': 'application/x-www-form-urlencoded', 'stripe-version': '2024-06-20' },
      body: params ? new URLSearchParams(form(params)).toString() : undefined
    });
    const j = await r.json();
    if (!r.ok) { const e = new Error(j.error?.message || 'stripe'); e.stripe = j.error; throw e; }
    return j;
  }
  const baseUrl = req => process.env.PUBLIC_URL || `${(req.headers['x-forwarded-proto'] || 'https').split(',')[0]}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const POLICY = S => `Tu depósito de $${S.deposit} aparta tu hora y se descuenta del total de tu servicio. Puedes cambiar o cancelar gratis hasta ${S.refundHours} horas antes desde tu app y te devolvemos el depósito. Si cancelas con menos de ${S.refundHours} horas o no llegas, el depósito no se devuelve.`;
  async function startDeposit(booking, req) {
    if (!STRIPE) return null;
    const S = settings(), base = baseUrl(req);
    const bk = col('bookings')[booking.id];
    bk.releaseKey = token();
    const ses = await stripe('/checkout/sessions', {
      mode: 'payment', locale: 'es', client_reference_id: booking.id,
      customer_email: booking.client.email || undefined,
      line_items: { 0: { quantity: 1, price_data: { currency: 'usd', unit_amount: Math.round(S.deposit * 100),
        product_data: { name: `Depósito · ${booking.serviceName}`, description: `Se descuenta del total de tu servicio. Cita: ${booking.date} a las ${booking.start}.` } } } },
      payment_intent_data: { description: `MT Aesthetics · depósito ${booking.serviceName} ${booking.date} ${booking.start}`, metadata: { bookingId: booking.id } },
      metadata: { bookingId: booking.id },
      custom_text: { submit: { message: POLICY(S) } },
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      success_url: `${base}/reservar?pago=ok&b=${booking.id}&s={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/reservar?pago=cancelado&b=${booking.id}&k=${bk.releaseKey}`
    });
    bk.stripeSession = ses.id; commit();
    return ses.url;
  }
  function markPaid(bid, pi, via) {
    const bk = col('bookings')[bid]; if (!bk || bk.depositPaid) return bk;
    bk.depositPaid = true; bk.depositMethod = 'tarjeta (Stripe)'; bk.depositPaidAt = new Date().toISOString(); bk.stripePaymentIntent = pi;
    if (['hold', 'expired'].includes(bk.status)) bk.status = 'confirmed';
    bk.holdUntil = null;
    bk.log = [...(bk.log || []), { at: new Date().toISOString(), by: 'web', text: `Depósito de $${bk.deposit} pagado en línea (${via})` }];
    commit(); notify('confirmed', col('clients')[bk.clientId], bk);
    return bk;
  }
  async function refundDeposit(bid) {
    const bk = col('bookings')[bid];
    if (!STRIPE || !bk || !bk.stripePaymentIntent || bk.stripeRefundId) return;
    try {
      const r = await stripe('/refunds', { payment_intent: bk.stripePaymentIntent, metadata: { bookingId: bid } });
      bk.stripeRefundId = r.id; bk.depositRefunded = true; bk.depositRefundedAt = new Date().toISOString(); bk.refundPending = false;
    } catch (e) { bk.refundPending = true; console.error('No se pudo devolver el depósito', bid, e.message); }
    commit();
  }
  async function notify(kind, client, booking) { /* Correo (Resend) y SMS (Twilio). Pendiente de conectar; hoy solo queda registrado. */
    console.log('[aviso]', kind, client?.name, booking?.date, booking?.start, integrations);
  }

  // ---- disponibilidad (mismas reglas que la agenda de María) ----
  function eff(b) { return b.status === 'hold' && b.holdUntil && Date.parse(b.holdUntil) < Date.now() ? 'expired' : b.status; }
  function busyOn(date, ignoreId) {
    const out = [];
    for (const [id, b] of Object.entries(col('bookings'))) if (id !== ignoreId && b.date === date && ACTIVE.has(eff(b))) out.push([toMin(b.start), toMin(b.start) + (b.dur || 60)]);
    for (const k of Object.values(col('blocks'))) if (k.date === date) out.push([toMin(k.start), toMin(k.end)]);
    return out;
  }
  function slots(date, dur, ignoreId) {
    const H = cat.HOURS[dow(date)]; if (!H) return [];
    const t0 = ymdNY(); if (date < t0 || date > addDays(t0, BOOK_DAYS_AHEAD)) return [];
    const busy = busyOn(date, ignoreId), now = minNY(), res = [];
    for (let t = H[0]; t + dur <= H[1]; t += cat.STEP) {
      if (date === t0 && t < now + 120) continue;          // mínimo 2 horas de anticipación
      if (busy.some(([a, z]) => t < z && t + dur > a)) continue;
      res.push(toHM(t));
    }
    return res;
  }
  const label = s => !s ? '' : s.cat === 'HIFU' ? 'HIFU · ' + s.name : s.cat.startsWith('Wax') ? 'Depilación ' + (s.cat.includes('Hombres') ? 'hombre' : 'mujer') + ' · ' + s.name : s.name;
  const svcPublic = s => ({ id: s.id, cat: s.cat, name: s.name, dur: s.dur, priceFrom: s.price, consent: cat.needsConsent(s.id) });

  // ---- límites por IP ----
  const hits = new Map();
  function limited(req, key, max, windowMin) {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    const k = key + ':' + ip, now = Date.now(), h = hits.get(k) || { n: 0, at: now };
    if (now - h.at > windowMin * 60e3) { h.n = 0; h.at = now; }
    h.n++; hits.set(k, h); return h.n > max;
  }

  function clientByToken(t) {
    if (!t || t.length < 20) return null;
    for (const [id, c] of Object.entries(col('clients'))) if (c.portalToken && c.portalToken.length === t.length && crypto.timingSafeEqual(Buffer.from(c.portalToken), Buffer.from(t))) return { id, c };
    return null;
  }
  function ensureToken(id) { const c = col('clients')[id]; if (!c.portalToken) { c.portalToken = token(); } return c.portalToken; }
  function findClient(phone, email) {
    const p = digits(phone), e = String(email || '').toLowerCase();
    for (const [id, c] of Object.entries(col('clients'))) if ((p && digits(c.phone) === p) || (e && c.email && c.email.toLowerCase() === e)) return id;
    return null;
  }
  function addReminders(bid, b) {
    const first = (b.client.name || '').split(' ')[0];
    const fu = col('followups');
    if (b.date > ymdNY()) fu['f-' + uid()] = { type: 'reminder24', due: addDays(b.date, -1), clientId: b.clientId, clientName: b.client.name, bookingId: bid, status: 'pending', channel: 'email', createdAt: new Date().toISOString(), message: `Hola ${first}, te esperamos mañana a las ${b.start} para tu ${b.serviceName}. Si necesitas cambiar la hora, avísanos con 24 horas. — MT Aesthetics` };
    fu['f-' + uid()] = { type: 'reminder2', due: b.date, clientId: b.clientId, clientName: b.client.name, bookingId: bid, status: 'pending', channel: 'email', createdAt: new Date().toISOString(), message: `${first}, en 2 horas es tu ${b.serviceName}. Ven con la piel limpia, sin maquillaje en la zona. ¡Nos vemos!` };
  }
  function skipReminders(bid) { for (const f of Object.values(col('followups'))) if (f.bookingId === bid && f.status === 'pending') f.status = 'skipped'; }
  const hoursUntil = b => { const [y, m, d] = b.date.split('-').map(Number); const startNY = Date.UTC(y, m - 1, d) / 6e4 + toMin(b.start); const nowNY = Date.UTC(...ymdNY().split('-').map((v, i) => i === 1 ? v - 1 : +v)) / 6e4 + minNY(); return (startNY - nowNY) / 60; };
  function sigSvg(name) {
    const n = String(name).replace(/[<&>"]/g, '');
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120"><rect width="480" height="120" fill="#fff"/><text x="24" y="78" font-family="Brush Script MT, Segoe Script, cursive" font-size="44" fill="#1F2D24">${n}</text></svg>`);
  }

  function profile(id, c) {
    const t0 = ymdNY(), S = settings();
    const all = Object.entries(col('bookings')).filter(([, b]) => b.clientId === id).map(([bid, b]) => ({ bid, ...b })).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    const consents = Object.values(col('consents')).filter(x => x.clientId === id);
    const upcoming = all.filter(b => b.date >= t0 && ['confirmed', 'hold'].includes(eff(b))).map(b => ({
      id: b.bid, serviceName: label(cat.SVC[b.serviceId]) || b.serviceName, serviceId: b.serviceId, category: b.category, date: b.date, start: b.start, dur: b.dur, status: eff(b),
      canChange: hoursUntil(b) >= (S.refundHours || 24),
      needsConsent: cat.needsConsent(b.serviceId), consentSigned: !!b.consentId || consents.some(x => x.bookingId === b.bid)
    }));
    const visits = all.filter(b => ['done', 'paid'].includes(b.status));
    const history = visits.slice().reverse().map(b => ({ serviceName: label(cat.SVC[b.serviceId]) || b.serviceName, category: b.category, date: b.date }));
    const last = visits[visits.length - 1];
    let rebook = null;
    if (last && !upcoming.length) { const days = cat.REBOOK_DAYS[last.category] || 30; rebook = { serviceId: last.serviceId, serviceName: label(cat.SVC[last.serviceId]) || last.serviceName, due: addDays(last.date, days) }; }
    const photos = Object.values(col('photos')).filter(p => p.clientId === id && p.shared).map(p => ({ src: p.data, kind: p.kind, date: (p.at || p.createdAt || '').slice(0, 10) }));
    const pkgs = Object.values(col('cpackages')).filter(p => p.clientId === id && p.used < p.sessions).map(p => ({ name: p.name, used: p.used, sessions: p.sessions }));
    const mb = Object.values(col('memberships')).find(m => m.clientId === id && m.status === 'activa');
    const careCat = (upcoming[0] && null) || (last && last.category);
    return {
      client: { name: c.name, first: (c.name || '').split(' ')[0], email: c.email || '', phone: c.phone || '', since: (c.createdAt || '').slice(0, 10) },
      upcoming, history, rebook, photos, packages: pkgs,
      membership: mb ? { name: 'Membresía Parlour', perks: '1 Facial Regular al mes + 10% en productos', usedThisMonth: mb.lastUsedMonth === t0.slice(0, 7) } : null,
      note: c.sharedNote || '',
      aftercare: careCat && AFTERCARE[careCat] ? { service: label(cat.SVC[last.serviceId]) || last.serviceName, date: last.date, items: AFTERCARE[careCat] } : null,
      policy: { refundHours: S.refundHours || 24 },
      whatsapp: '13474795229'
    };
  }

  // ---- rutas ----
  const handler = async function handle(req, res, url) {
    const p = url.pathname;

    if (p === '/reservar' || p === '/reservar/') return send(res, 200, fs.readFileSync(path.join(PUB, 'reservar.html')), 'text/html; charset=utf-8');
    if (p.startsWith('/pub/')) {
      const f = path.join(PUB, 'pub', path.basename(p));
      if (!fs.existsSync(f)) return send(res, 404, 'No encontrado', 'text/plain; charset=utf-8');
      const type = f.endsWith('.svg') ? 'image/svg+xml' : f.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=604800' }); return res.end(fs.readFileSync(f));
    }
    let m = p.match(/^\/c\/([A-Za-z0-9_-]{20,})\/?$/);
    if (m) return send(res, 200, fs.readFileSync(path.join(PUB, 'cliente.html')), 'text/html; charset=utf-8', { 'x-robots-tag': 'noindex' });
    m = p.match(/^\/c\/([A-Za-z0-9_-]{20,})\/manifest\.webmanifest$/);
    if (m) return send(res, 200, { name: 'MT Aesthetics', short_name: 'MT Parlour', start_url: `/c/${m[1]}`, scope: `/c/${m[1]}`, display: 'standalone', background_color: '#F4EFE6', theme_color: '#1F2D24', icons: [{ src: '/pub/app-icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/pub/app-icon-512.png', sizes: '512x512', type: 'image/png' }] }, 'application/manifest+json');

    if (p === '/api/public/catalog') {
      return send(res, 200, { cats: cat.CATS, services: cat.SERVICES.filter(s => s.id !== 'consulta').map(svcPublic).concat([svcPublic(cat.SVC['consulta'])]), health: cat.HEALTH, hours: cat.HOURS, policy: { deposit: settings().deposit, refundHours: settings().refundHours, daysAhead: BOOK_DAYS_AHEAD }, payments: integrations.payments, open: settings().onlineBooking !== false, today: ymdNY() });
    }
    if (p === '/api/public/slots') {
      const s = cat.SVC[url.searchParams.get('service')], date = url.searchParams.get('date') || '';
      if (!s || !isDate(date)) return send(res, 400, { error: 'bad_request' });
      return send(res, 200, { date, slots: slots(date, s.dur) });
    }
    if (p === '/api/public/pago' && req.method === 'GET') {   // vuelta desde Stripe
      if (limited(req, 'pago', 30, 10)) return send(res, 429, { error: 'Demasiadas solicitudes.' });
      const bid = url.searchParams.get('b') || '', sid = url.searchParams.get('s') || '';
      const bk = col('bookings')[bid];
      if (!bk || !STRIPE || !/^cs_/.test(sid) || bk.stripeSession !== sid) return send(res, 404, { error: 'No encontramos ese pago.' });
      if (!bk.depositPaid) {
        let ses; try { ses = await stripe('/checkout/sessions/' + sid, null, 'GET'); } catch (e) { return send(res, 502, { error: 'No pudimos confirmar el pago. Escríbenos por WhatsApp.' }); }
        if (ses.payment_status !== 'paid' || ses.metadata?.bookingId !== bid) return send(res, 409, { error: 'El pago no se completó.' });
        markPaid(bid, ses.payment_intent, 'vuelta del pago');
      }
      const tk = ensureToken(bk.clientId); commit();
      return send(res, 200, { ok: true, bookingId: bid, status: bk.status, portal: `/c/${tk}`, needsConsent: cat.needsConsent(bk.serviceId), warn: [],
        booking: { serviceName: bk.serviceName, dur: bk.dur, date: bk.date, start: bk.start, deposit: bk.deposit } });
    }
    if (p === '/api/public/liberar' && req.method === 'POST') {   // volvió sin pagar: suelta el turno
      let b; try { b = JSON.parse(await readBody(req, 2000)); } catch { return send(res, 400, { error: 'bad_request' }); }
      const bk = col('bookings')[b.b];
      if (bk && bk.status === 'hold' && !bk.depositPaid && bk.releaseKey && typeof b.k === 'string' && b.k.length === bk.releaseKey.length && crypto.timingSafeEqual(Buffer.from(b.k), Buffer.from(bk.releaseKey))) {
        bk.status = 'expired'; bk.holdUntil = new Date().toISOString(); skipReminders(b.b); commit();
      }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/stripe/webhook' && req.method === 'POST') {
      const raw = await readBody(req, 200000), secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) return send(res, 400, { error: 'sin secreto' });
      const sig = Object.fromEntries(String(req.headers['stripe-signature'] || '').split(',').map(x => x.split('=')));
      const exp = crypto.createHmac('sha256', secret).update(`${sig.t}.${raw}`).digest('hex');
      if (!sig.v1 || sig.v1.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig.v1), Buffer.from(exp)) || Math.abs(Date.now() / 1000 - +sig.t) > 600) return send(res, 400, { error: 'firma' });
      const ev = JSON.parse(raw), o = ev.data?.object || {};
      if (ev.type === 'checkout.session.completed' && o.payment_status === 'paid' && o.metadata?.bookingId && col('bookings')[o.metadata.bookingId]?.stripeSession === o.id) markPaid(o.metadata.bookingId, o.payment_intent, 'aviso de Stripe');
      return send(res, 200, { received: true });
    }
    if (p === '/api/public/days') {   // qué días tienen horario libre (para pintar el calendario)
      const s = cat.SVC[url.searchParams.get('service')]; if (!s) return send(res, 400, { error: 'bad_request' });
      const t0 = ymdNY(), out = {};
      for (let i = 0; i <= BOOK_DAYS_AHEAD; i++) { const d = addDays(t0, i); out[d] = slots(d, s.dur).length; }
      return send(res, 200, { days: out });
    }
    if (p === '/api/public/book' && req.method === 'POST') {
      if (limited(req, 'book', 8, 60)) return send(res, 429, { error: 'Demasiados intentos. Intenta más tarde o escríbenos por WhatsApp.' });
      let b; try { b = JSON.parse(await readBody(req, 20000)); } catch { return send(res, 400, { error: 'bad_request' }); }
      if (b.website) return send(res, 200, { ok: true });   // trampa para bots
      if (settings().onlineBooking === false) return send(res, 403, { error: 'Las reservas en línea están en pausa. Escríbele a María por WhatsApp para agendar.' });
      const s = cat.SVC[b.serviceId]; const name = str(b.name, 80), phone = str(b.phone, 30), email = str(b.email, 120);
      if (!s || !isDate(b.date) || !isHM(b.start)) return send(res, 400, { error: 'Falta escoger el servicio, el día o la hora.' });
      if (name.length < 2 || digits(phone).length < 10) return send(res, 400, { error: 'Escribe tu nombre y un teléfono de 10 dígitos.' });
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'Revisa tu correo.' });
      if (!b.agree) return send(res, 400, { error: 'Acepta la política de citas para continuar.' });
      const flags = (Array.isArray(b.flags) ? b.flags : []).filter(f => cat.HEALTH.includes(f));
      const cf = cat.contraFor(s.id, flags);
      if (cf.block.length) return send(res, 409, { error: `Por tu salud, este servicio no se puede reservar en línea: ${cf.block[0].why}. Escríbele a María por WhatsApp y te recomienda una alternativa.`, contra: true });
      if (!slots(b.date, s.dur).includes(b.start)) return send(res, 409, { error: 'Ese horario se acaba de ocupar. Escoge otro, por favor.' });
      let cid = findClient(phone, email);
      if (cid) { const c = col('clients')[cid]; if (email && !c.email) c.email = email; if (flags.length) c.flags = [...new Set([...(c.flags || []), ...flags])]; }
      else { cid = 'c-' + uid(); col('clients')[cid] = { name, phone, email, ig: '', birthday: '', skinType: '', flags, notes: '', tags: [], source: 'web', referredBy: '', credit: 0, marketingOk: false, createdAt: new Date().toISOString() }; }
      const tk = ensureToken(cid), S = settings(), bid = 'b-' + uid();
      const booking = { serviceId: s.id, serviceName: s.name, category: s.cat, dur: s.dur, priceFrom: s.price, date: b.date, start: b.start, clientId: cid, client: { name: col('clients')[cid].name, phone, email }, flags, note: str(b.note, 500), status: integrations.payments ? 'hold' : 'confirmed', holdUntil: integrations.payments ? new Date(Date.now() + HOLD_MIN * 60e3).toISOString() : null, deposit: S.deposit, depositPaid: false, source: 'web', staffId: 'mt', createdAt: new Date().toISOString() };
      col('bookings')[bid] = booking; addReminders(bid, booking); commit();
      let pay = null;
      try { pay = await startDeposit({ id: bid, ...booking }, req); }
      catch (e) { console.error('Stripe', e.message); booking.status = 'expired'; skipReminders(bid); commit(); return send(res, 502, { error: 'No pudimos abrir el pago en este momento. Intenta de nuevo en un minuto o escríbenos por WhatsApp.' }); }
      if (!pay) notify('booked', col('clients')[cid], booking);
      return send(res, 200, { ok: true, bookingId: bid, status: booking.status, portal: `/c/${tk}`, payUrl: pay, needsConsent: cat.needsConsent(s.id), warn: cf.warn.map(w => w.why) });
    }

    m = p.match(/^\/api\/c\/([A-Za-z0-9_-]{20,})(\/[a-z]+)?$/);
    if (m) {
      if (limited(req, 'portal', 120, 10)) return send(res, 429, { error: 'Demasiadas solicitudes.' });
      const who = clientByToken(m[1]); if (!who) return send(res, 404, { error: 'Este enlace no es válido. Pídele uno nuevo a María por WhatsApp.' });
      const { id, c } = who, action = m[2] || '';
      if (!action && req.method === 'GET') return send(res, 200, profile(id, c));
      if (req.method !== 'POST') return send(res, 405, { error: 'method' });
      let body; try { body = JSON.parse(await readBody(req, 20000)); } catch { return send(res, 400, { error: 'bad_request' }); }
      const bk = body.bookingId && col('bookings')[body.bookingId];
      const mine = bk && bk.clientId === id;
      if (action === '/cancel') {
        if (!mine || !['confirmed', 'hold'].includes(eff(bk))) return send(res, 400, { error: 'No se encontró esa cita.' });
        if (hoursUntil(bk) < (settings().refundHours || 24)) return send(res, 409, { error: `Faltan menos de ${settings().refundHours || 24} horas. Para cancelar, escríbele a María por WhatsApp.` });
        bk.status = 'cancelled'; bk.cancelledAt = new Date().toISOString(); bk.cancelledBy = 'clienta'; skipReminders(body.bookingId); commit(); notify('cancelled', c, bk);
        if (bk.depositPaid && !bk.depositRefunded) await refundDeposit(body.bookingId);
        return send(res, 200, { ...profile(id, c), refunded: !!bk.depositRefunded, refundPending: !!bk.refundPending });
      }
      if (action === '/reschedule') {
        if (!mine || !['confirmed', 'hold'].includes(eff(bk))) return send(res, 400, { error: 'No se encontró esa cita.' });
        if (hoursUntil(bk) < (settings().refundHours || 24)) return send(res, 409, { error: `Faltan menos de ${settings().refundHours || 24} horas. Para cambiarla, escríbele a María por WhatsApp.` });
        if (!isDate(body.date) || !isHM(body.start) || !slots(body.date, bk.dur, body.bookingId).includes(body.start)) return send(res, 409, { error: 'Ese horario no está libre.' });
        bk.rescheduledFrom = `${bk.date} ${bk.start}`; bk.date = body.date; bk.start = body.start; skipReminders(body.bookingId); addReminders(body.bookingId, bk); commit(); notify('rescheduled', c, bk);
        return send(res, 200, profile(id, c));
      }
      if (action === '/slots') {
        const s = cat.SVC[body.serviceId] || (mine && cat.SVC[bk.serviceId]);
        if (!s || !isDate(body.date)) return send(res, 400, { error: 'bad_request' });
        return send(res, 200, { slots: slots(body.date, s.dur, mine ? body.bookingId : undefined) });
      }
      if (action === '/consent') {
        if (!mine || !cat.needsConsent(bk.serviceId)) return send(res, 400, { error: 'No se encontró esa cita.' });
        const sig = str(body.signature, 80);
        if (sig.length < 3 || !body.agree) return send(res, 400, { error: 'Escribe tu nombre completo y marca la casilla.' });
        const xid = 'x-' + uid(), s = cat.SVC[bk.serviceId];
        col('consents')[xid] = { clientId: id, clientName: c.name, bookingId: body.bookingId, serviceId: s.id, serviceName: s.name, text: cat.consentText(s, c.name), signature: sigSvg(sig), typedName: sig, signedAt: new Date().toISOString(), via: 'app de la clienta', medicalAuth: !!body.medicalAuth };
        bk.consentId = xid; commit();
        return send(res, 200, profile(id, c));
      }
      if (action === '/consenttext') {
        if (!mine) return send(res, 400, { error: 'bad_request' });
        return send(res, 200, { text: cat.consentText(cat.SVC[bk.serviceId], c.name) });
      }
      if (action === '/book') {   // reservar de nuevo desde la app
        const s = cat.SVC[body.serviceId];
        if (!s || !isDate(body.date) || !isHM(body.start)) return send(res, 400, { error: 'Falta el día o la hora.' });
        const cf = cat.contraFor(s.id, c.flags || []);
        if (cf.block.length) return send(res, 409, { error: `Este servicio no se puede reservar en línea: ${cf.block[0].why}. Escríbele a María.` });
        if (!slots(body.date, s.dur).includes(body.start)) return send(res, 409, { error: 'Ese horario se acaba de ocupar.' });
        const bid = 'b-' + uid(), S = settings();
        const booking = { serviceId: s.id, serviceName: s.name, category: s.cat, dur: s.dur, priceFrom: s.price, date: body.date, start: body.start, clientId: id, client: { name: c.name, phone: c.phone, email: c.email }, flags: c.flags || [], note: '', status: integrations.payments ? 'hold' : 'confirmed', holdUntil: integrations.payments ? new Date(Date.now() + HOLD_MIN * 60e3).toISOString() : null, deposit: S.deposit, depositPaid: false, source: 'app', staffId: 'mt', createdAt: new Date().toISOString() };
        col('bookings')[bid] = booking; addReminders(bid, booking); commit();
        let pay = null;
        try { pay = await startDeposit({ id: bid, ...booking }, req); }
        catch (e) { console.error('Stripe', e.message); booking.status = 'expired'; skipReminders(bid); commit(); return send(res, 502, { error: 'No pudimos abrir el pago. Intenta de nuevo en un minuto.' }); }
        if (!pay) notify('booked', c, booking);
        return send(res, 200, { ...profile(id, c), payUrl: pay });
      }
      return send(res, 404, { error: 'not_found' });
    }
    return null;   // no es una ruta pública
  };
  handler.refundDeposit = refundDeposit;
  return handler;
};
