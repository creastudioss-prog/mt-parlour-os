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
  else if (fs.existsSync(path.join(__dirname, 'seed.json'))) store = { rev: 1, data: JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8')) };
} catch (e) { console.error('No se pudo leer la base de datos:', e); }
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
const MIME = { '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.ico': 'image/x-icon' };
function serveFile(res, file, cache = 'public, max-age=86400') {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'No encontrado', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': cache });
    res.end(buf);
  });
}
const loginPage = (err = '') => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>MT Parlour · Entrar</title><meta name="theme-color" content="#1F2D24"><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="MT Parlour">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..600;1,9..144,300..600&family=Hanken+Grotesk:wght@400;500;600&display=swap">
<style>:root{color-scheme:light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4EFE6;color:#1A1A1A;font:15px 'Hanken Grotesk',system-ui,sans-serif;padding:16px;box-sizing:border-box}
form{width:min(340px,100%);display:grid;gap:14px;text-align:center}.mk{font-family:Fraunces,serif;font-size:40px;line-height:.9}.mk b{font-weight:480;display:block}.mk span{font-weight:380;letter-spacing:.06em;font-size:.5em}
em{font-family:Fraunces,serif;color:#8F6446}input{font:inherit;font-size:18px;padding:13px 14px;border:1px solid rgba(26,26,26,.3);border-radius:6px;background:#FBF8F3;text-align:center}
button{font:inherit;font-weight:600;padding:14px;border:0;border-radius:999px;background:#8F6446;color:#fff;cursor:pointer}.e{color:#9B3B2E;font-size:13px}</style></head>
<body><form method="post" action="/login"><div class="mk"><b>MT</b><span>AESTHETICS</span></div><em>Parlour OS</em>
<input type="password" name="password" placeholder="Contraseña" autocomplete="current-password" autofocus required aria-label="Contraseña">
${err ? `<div class="e">${err}</div>` : ''}<button type="submit">Entrar</button></form></body></html>`;

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
const appHtml = () => fs.readFileSync(path.join(PUB, 'app.html'));
let APP = appHtml();

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/health') return send(res, 200, { ok: true });
    if (p === '/manifest.webmanifest' || p.startsWith('/icons/')) return serveFile(res, path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, '')));
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

    if (p === '/' || p === '/reservar' || p === '/index.html') return send(res, 200, APP, 'text/html; charset=utf-8');

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
      if (op === 'update') store.data[c][id] = merge(store.data[c][id], data);
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
