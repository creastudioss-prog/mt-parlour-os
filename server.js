// MT Aesthetics · Parlour OS — servidor (Node, sin dependencias)
// Variables: APP_PASSWORD (obligatoria), SESSION_SECRET, DATA_DIR (/data), ANTHROPIC_API_KEY (opcional),
//            MODEL_DEFAULT, MODEL_QUICK, PORT
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('mt:' + PASSWORD).digest('hex');
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL_DEFAULT = process.env.MODEL_DEFAULT || 'claude-sonnet-5-5';
const MODEL_QUICK = process.env.MODEL_QUICK || 'claude-haiku-5-5';
const PUB = path.join(__dirname, 'public');

if (!PASSWORD) console.warn('ATENCIÓN: falta APP_PASSWORD. Nadie podrá entrar hasta que la configures.');

/* ---------- base de datos en un archivo JSON (volumen /data) ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
let store = { rev: 1, data: {} };
try {
  if (fs.existsSync(DB_FILE)) store = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  else if (process.env.DEMO === '1' && fs.existsSync(path.join(__dirname, 'seed.json'))) store = { rev: 1, data: JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8')) };
} catch (e) { console.error('No se pudo leer la base de datos:', e); }
// Limpieza única de los datos de ejemplo: borra solo los registros cuyo código viene de seed.json.
// Antes guarda una copia completa en DATA_DIR. La configuración (settings) no se toca.
try {
  const meta = store.data._meta = store.data._meta || {};
  if (!meta.demoCleared && process.env.DEMO !== '1' && fs.existsSync(path.join(__dirname, 'seed.json'))) {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
    fs.writeFileSync(path.join(DATA_DIR, 'db-antes-de-limpiar-ejemplos.json'), JSON.stringify(store));
    let n = 0;
    for (const [c, recs] of Object.entries(seed)) {
      if (c === 'settings' || !store.data[c] || typeof recs !== 'object') continue;
      for (const id of Object.keys(recs)) if (store.data[c][id]) { delete store.data[c][id]; n++; }
    }
    meta.demoCleared = new Date().toISOString(); store.rev++;
    fs.writeFileSync(DB_FILE, JSON.stringify(store));
    console.log('Datos de ejemplo borrados:', n);
  }
} catch (e) { console.error('No se pudieron limpiar los ejemplos:', e); }
let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(store), err => {
      if (err) return console.error('Error guardando:', err);
      fs.rename(tmp, DB_FILE, e => e && console.error('Error guardando:', e));
    });
  }, 250);
}
save();
// al reiniciar (Railway manda SIGTERM en cada publicación) se guarda todo antes de salir
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { clearTimeout(saveT); fs.writeFileSync(DB_FILE, JSON.stringify(store)); } catch (e) { console.error(e); } process.exit(0); });
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => { const o = { ...(a || {}) }; for (const k in b) o[k] = isObj(b[k]) && isObj(o[k]) ? merge(o[k], b[k]) : b[k]; return o; };
const okName = s => typeof s === 'string' && /^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(s);

/* ---------- sesión ---------- */
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
function makeCookie(req) { const sec = (req.headers['x-forwarded-proto'] || '').includes('https') ? ' Secure;' : ''; const exp = Date.now() + 1000 * 60 * 60 * 24 * 120; const v = exp + '.' + sign(String(exp)); return `mt=${v}; Path=/; HttpOnly; SameSite=Lax;${sec} Max-Age=${60 * 60 * 24 * 120}`; }
function authed(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)mt=([^;]+)/); if (!m) return false;
  const [exp, sig] = m[1].split('.'); if (!exp || !sig || +exp < Date.now()) return false;
  const good = sign(exp); return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
const tries = new Map();

/* ---------- utilidades ---------- */
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.ico': 'image/x-icon' };
function serveFile(res, file, cache = 'public, max-age=86400') {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'No encontrado', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': cache });
    res.end(buf);
  });
}
const loginPage = (err = '') => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>mt aesthetics · Entrar</title><meta name="theme-color" content="#1F2D24"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="MT Parlour">
<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=synonym@400,500&display=swap">
<style>:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;grid-template-columns:1fr;background:#F4EFE6;color:#1F2D24;font:15px 'Synonym',system-ui,sans-serif}
@media(min-width:861px){body{grid-template-columns:1fr 1fr}.side{display:flex!important}}
.side{display:none;background:#1F2D24;align-items:center;justify-content:center}.side img{width:46%;max-width:300px;opacity:.9}
main{display:grid;place-items:center;padding:24px}form{width:min(340px,100%);display:grid;gap:14px;text-align:center}
.logo{height:26px;margin:0 auto 6px}p{margin:0 0 10px;color:#5A6359;font-size:14px}
input{font:inherit;font-size:17px;padding:13px 14px;border:1px solid rgba(31,45,36,.25);border-radius:3px;background:#FAF7F1;text-align:center;color:#1F2D24}
input:focus{outline:none;border-color:#1F2D24}
button{font:inherit;font-size:15px;letter-spacing:.02em;padding:15px;border:0;border-radius:3px;background:#1F2D24;color:#F4EFE6;cursor:pointer}.e{color:#9B3B2E;font-size:13px}body::after{content:"";position:fixed;left:0;right:0;top:-25vh;height:150vh;z-index:9999;pointer-events:none;background:url(/pub/grano.png) repeat;background-size:180px;opacity:.06}</style></head>
<body><div class="side"><img src="/pub/silueta-crema.svg" alt=""></div><main><form method="post" action="/login"><img class="logo" src="/pub/nombre-verde.svg" alt="mt aesthetics"><p>Escribe tu contraseña para entrar</p>
<input type="password" name="password" placeholder="Contraseña" autocomplete="current-password" autofocus required aria-label="Contraseña">
${err ? `<div class="e">${err}</div>` : ''}<button type="submit">Entrar</button></form></main></body></html>`;

/* ---------- AI (opcional) ---------- */
async function askClaude(input, tier) {
  let msgs = typeof input === 'string' ? [{ role: 'user', content: input }] : (Array.isArray(input) ? input : []);
  const merged = [];
  for (const m of msgs) {
    if (!m || !['user', 'assistant'].includes(m.role) || !m.content) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content; else merged.push({ role: m.role, content: String(m.content) });
  }
  if (!merged.length || merged[0].role !== 'user') throw new Error('bad_input');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: tier === 'quick' ? MODEL_QUICK : MODEL_DEFAULT, max_tokens: 1500, messages: merged })
  });
  if (r.status === 429) { const e = new Error('rate'); e.status = 429; throw e; }
  if (!r.ok) { const t = await r.text(); console.error('Anthropic', r.status, t.slice(0, 300)); throw new Error('upstream'); }
  const j = await r.json();
  return { text: (j.content || []).filter(c => c.type === 'text').map(c => c.text).join(''), truncated: j.stop_reason === 'max_tokens' };
}

/* ---------- servidor ---------- */
const publicApi = require('./public-api')({ store, save, send, readBody, PUB });
const appHtml = () => fs.readFileSync(path.join(PUB, 'app.html'));
let APP = appHtml();

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/health') return send(res, 200, { ok: true });
    if (p === '/manifest.webmanifest' || p.startsWith('/icons/')) return serveFile(res, path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, '')));
    { const r = await publicApi(req, res, url); if (r !== null) return; }
    if (p === '/login' && req.method === 'GET') return send(res, 200, loginPage(), 'text/html; charset=utf-8');
    if (p === '/login' && req.method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress;
      const t = tries.get(ip) || { n: 0, at: Date.now() }; if (Date.now() - t.at > 15 * 60e3) { t.n = 0; t.at = Date.now(); }
      if (t.n >= 10) return send(res, 429, loginPage('Demasiados intentos. Espera 15 minutos.'), 'text/html; charset=utf-8');
      const body = new URLSearchParams(await readBody(req, 10000));
      const pw = body.get('password') || '';
      const ok = PASSWORD && pw.length === PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(PASSWORD));
      if (!ok) { t.n++; tries.set(ip, t); return send(res, 401, loginPage('Contraseña incorrecta.'), 'text/html; charset=utf-8'); }
      tries.delete(ip);
      res.writeHead(303, { location: '/', 'set-cookie': makeCookie(req) }); return res.end();
    }
    if (p === '/logout') { res.writeHead(303, { location: '/login', 'set-cookie': 'mt=; Path=/; Max-Age=0' }); return res.end(); }

    if (!authed(req)) {
      if (p.startsWith('/api/')) return send(res, 401, { error: 'login' });
      res.writeHead(303, { location: '/login' }); return res.end();
    }

    if (p === '/' || p === '/index.html') return send(res, 200, APP, 'text/html; charset=utf-8');

    if (p === '/api/db' && req.method === 'GET') {
      const since = +url.searchParams.get('rev');
      return send(res, 200, since === store.rev ? { rev: store.rev } : { rev: store.rev, data: store.data });
    }
    if (p === '/api/db' && req.method === 'POST') {
      const { op, c, id, data } = JSON.parse(await readBody(req));
      if (!okName(c) || !okName(id) || !['set', 'update', 'delete'].includes(op)) return send(res, 400, { error: 'bad_request' });
      if (op !== 'delete' && !isObj(data)) return send(res, 400, { error: 'bad_request' });
      store.data[c] = store.data[c] || {};
      if (op === 'set') store.data[c][id] = data;
      const before = c === 'bookings' && store.data[c][id] ? { ...store.data[c][id] } : null;
      if (op === 'update') store.data[c][id] = merge(store.data[c][id], data);
      if (before && store.data[c][id] && store.data[c][id].depositRefunded && !before.depositRefunded && store.data[c][id].stripePaymentIntent && !store.data[c][id].stripeRefundId)
        publicApi.refundDeposit(id).catch(e => console.error('Reembolso', e.message));
      if (op === 'delete') delete store.data[c][id];
      store.rev++; save();
      return send(res, 200, { rev: store.rev });
    }
    if (p === '/api/ai/status') return send(res, 200, { on: !!AI_KEY });
    if (p === '/api/ai' && req.method === 'POST') {
      if (!AI_KEY) return send(res, 503, { error: 'ai_off' });
      const { input, tier } = JSON.parse(await readBody(req, 600000));
      try { return send(res, 200, await askClaude(input, tier)); }
      catch (e) { return send(res, e.status === 429 ? 429 : 502, { error: 'ai_error' }); }
    }
    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.message === 'too_large' ? 413 : 500, { error: 'server' });
  }
}).listen(PORT, () => console.log('Parlour OS escuchando en', PORT, '· datos en', DB_FILE, '· AI', AI_KEY ? 'activa' : 'apagada'));
