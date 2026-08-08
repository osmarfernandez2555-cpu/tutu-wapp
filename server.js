require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');

// ── CONFIGURACION ─────────────────────────────────────────────────────────────
const TUTU_BOT_URL    = process.env.TUTU_BOT_URL    || 'https://tutu-chat-agent-production.up.railway.app';
const EVO_URL         = process.env.EVO_URL         || 'https://evolution-api-production-a132.up.railway.app';
const EVO_APIKEY      = process.env.EVO_APIKEY      || 'b0aeeb8fd07ecb732ef096d805087cab8c155b57c46ec6086b036615ab314605';
const EVO_INSTANCE    = process.env.EVO_INSTANCE    || 'tutu';
const conversaciones  = {};
const cooldowns       = {}; // evita procesar multiples imagenes seguidas
const COOLDOWN_MS     = 10000; // 10 segundos entre respuestas por numero

const app         = express();
const PORT        = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'tutu2024';
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

const db = new Database('./tutu_wapp.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, email TEXT, telefono TEXT NOT NULL UNIQUE, status TEXT DEFAULT 'pendiente', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS tandas (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, template TEXT NOT NULL, imagen_path TEXT, imagen_caption INTEGER DEFAULT 0, delay_segundos INTEGER DEFAULT 20, max_por_dia INTEGER DEFAULT 350, status TEXT DEFAULT 'pendiente', total INTEGER DEFAULT 0, enviados INTEGER DEFAULT 0, fallidos INTEGER DEFAULT 0, fecha_programada TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS tanda_contactos (id INTEGER PRIMARY KEY AUTOINCREMENT, tanda_id INTEGER, contact_id INTEGER, status TEXT DEFAULT 'pendiente', enviado_at DATETIME, error_msg TEXT);
  CREATE TABLE IF NOT EXISTS historial (id INTEGER PRIMARY KEY AUTOINCREMENT, tanda_id INTEGER, contact_id INTEGER, telefono TEXT, nombre TEXT, status TEXT, error_msg TEXT, sent_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS mensajes (id INTEGER PRIMARY KEY AUTOINCREMENT, telefono TEXT NOT NULL, nombre TEXT, direccion TEXT NOT NULL, contenido TEXT NOT NULL, tipo TEXT DEFAULT 'texto', leido INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS email_contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, email TEXT NOT NULL UNIQUE, telefono TEXT, tags TEXT DEFAULT '', status TEXT DEFAULT 'pendiente', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS email_campanas (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, asunto TEXT NOT NULL, cuerpo_html TEXT NOT NULL, from_name TEXT DEFAULT 'Tutu Automotores', reply_to TEXT, delay_segundos INTEGER DEFAULT 5, max_por_dia INTEGER DEFAULT 300, status TEXT DEFAULT 'pendiente', total INTEGER DEFAULT 0, enviados INTEGER DEFAULT 0, fallidos INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS email_campana_contactos (id INTEGER PRIMARY KEY AUTOINCREMENT, campana_id INTEGER, contact_id INTEGER, status TEXT DEFAULT 'pendiente', enviado_at DATETIME, error_msg TEXT);
  CREATE TABLE IF NOT EXISTS email_historial (id INTEGER PRIMARY KEY AUTOINCREMENT, campana_id INTEGER, contact_id INTEGER, email TEXT, nombre TEXT, status TEXT, error_msg TEXT, sent_at DATETIME DEFAULT CURRENT_TIMESTAMP);
`);
try { db.exec("ALTER TABLE tandas ADD COLUMN imagen_path TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE tandas ADD COLUMN imagen_caption INTEGER DEFAULT 0"); } catch(e) {}

function auth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ── EVOLUTION API HELPERS ─────────────────────────────────────────────────────
function evoHeaders() {
  return { 'Content-Type': 'application/json', 'apikey': EVO_APIKEY };
}

async function evoSendText(telefono, texto) {
  const r = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
    method: 'POST',
    headers: evoHeaders(),
    body: JSON.stringify({ number: '54' + telefono, text: texto })
  });
  return r.json();
}

async function evoSendImage(telefono, imageBase64, caption) {
  const r = await fetch(`${EVO_URL}/message/sendMedia/${EVO_INSTANCE}`, {
    method: 'POST',
    headers: evoHeaders(),
    body: JSON.stringify({
      number: '54' + telefono,
      mediatype: 'image',
      media: imageBase64,
      caption: caption || ''
    })
  });
  return r.json();
}

async function evoStatus() {
  try {
    const r = await fetch(`${EVO_URL}/instance/connectionState/${EVO_INSTANCE}`, { headers: evoHeaders() });
    const d = await r.json();
    return d.instance?.state || 'unknown';
  } catch(e) { return 'error'; }
}

// ── WEBHOOK — mensajes entrantes de Evolution API ─────────────────────────────
app.post('/webhook/evolution', async (req, res) => {
  res.sendStatus(200); // responder rapido
  try {
    const body = req.body;
    if (!body || body.event !== 'messages.upsert') return;
    const msg = body.data;
    if (!msg || msg.key?.fromMe) return;
    if (msg.key?.remoteJid?.endsWith('@g.us')) return; // ignorar grupos

    const jid = msg.key.remoteJid;
    const tel = jid.replace('@s.whatsapp.net','').replace('@c.us','').replace(/[^0-9]/g,'').replace(/^54/,'');
    if (!tel || tel.length < 8) return;

    const esImagen = !!msg.message?.imageMessage;
    const esAudio  = !!msg.message?.audioMessage;
    const contenido = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
    // Si es imagen sin texto igual continuar el flujo
    if (!esImagen && (!contenido || contenido.length > 2000)) return;

    const tipo = esImagen ? 'imagen' : esAudio ? 'audio' : 'texto';
    const nombre = msg.pushName || tel;
    const contacto = db.prepare("SELECT nombre FROM contacts WHERE telefono = ?").get(tel);
    const nombreFinal = contacto?.nombre || nombre;

    // Cooldown: solo aplica a imagenes para evitar procesar multiples fotos seguidas
    const ahora = Date.now();
    if (esImagen && cooldowns[tel] && ahora - cooldowns[tel] < COOLDOWN_MS) {
      db.prepare("INSERT INTO mensajes (telefono, nombre, direccion, contenido, tipo) VALUES (?,?,?,?,?)").run(tel, nombreFinal, 'entrante', contenido || '[foto]', tipo);
      return;
    }
    if (esImagen) cooldowns[tel] = ahora;

    db.prepare("INSERT INTO mensajes (telefono, nombre, direccion, contenido, tipo) VALUES (?,?,?,?,?)").run(tel, nombreFinal, 'entrante', contenido || '[foto]', tipo);
    console.log(`[MSG] <- ${nombreFinal} (${tel}): ${(contenido||'[foto]').slice(0,50)}`);

    // Si es imagen, enviar mensaje especial al bot para que continúe el flujo
    const mensajeParaBot = tipo !== 'texto' ? '[El cliente envió una foto]' : contenido;

    // Llamar al bot
    if (!conversaciones[tel]) conversaciones[tel] = [];
    conversaciones[tel].push({ role: 'user', content: mensajeParaBot });
    if (conversaciones[tel].length > 6) conversaciones[tel] = conversaciones[tel].slice(-6);

    const mensajesRecortados = conversaciones[tel].map(m => ({ role: m.role, content: m.content.slice(0,500) }));
    const resp = await fetch(`${TUTU_BOT_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: mensajesRecortados, sessionId: 'wa_' + tel }),
      timeout: 30000
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    const respuesta = data.message;
    if (!respuesta) return;

    conversaciones[tel].push({ role: 'assistant', content: respuesta });
    await evoSendText(tel, respuesta);
    db.prepare("INSERT INTO mensajes (telefono, nombre, direccion, contenido, tipo) VALUES (?,?,?,?,?)").run(tel, nombreFinal, 'saliente', respuesta, 'texto');
    console.log(`[BOT] -> ${nombreFinal}: ${respuesta.slice(0,60)}`);

  } catch(e) { console.error('[WEBHOOK] Error:', e.message); }
});

// ── WP STATUS (usando Evolution API) ─────────────────────────────────────────
app.get('/api/wp/status', auth, async (req, res) => {
  const state = await evoStatus();
  res.json({ status: state === 'open' ? 'conectado' : state, qr: null });
});

app.post('/api/wp/connect', auth, async (req, res) => {
  try {
    const r = await fetch(`${EVO_URL}/instance/connect/${EVO_INSTANCE}`, { headers: evoHeaders() });
    const d = await r.json();
    res.json({ ok: true, msg: 'Conectar desde el panel de Evolution API', data: d });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/wp/disconnect', auth, async (req, res) => {
  try {
    await fetch(`${EVO_URL}/instance/logout/${EVO_INSTANCE}`, { method: 'DELETE', headers: evoHeaders() });
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ── BOT ───────────────────────────────────────────────────────────────────────
app.delete('/api/bot/conversacion/:telefono', auth, (req, res) => { const tel = req.params.telefono.replace(/[^0-9]/g,''); delete conversaciones[tel]; res.json({ ok: true }); });
app.get('/api/bot/conversaciones', auth, (req, res) => { res.json({ total: Object.keys(conversaciones).length, conversaciones: Object.keys(conversaciones).map(tel => ({ telefono: tel, mensajes: conversaciones[tel].length })) }); });

// ── IMAGEN ────────────────────────────────────────────────────────────────────
const imgStorage = multer.diskStorage({ destination: (req, file, cb) => cb(null, UPLOADS_DIR), filename: (req, file, cb) => cb(null, `img_${Date.now()}${path.extname(file.originalname)}`) });
const uploadImg = multer({ storage: imgStorage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (req, file, cb) => { if (/image\/(jpeg|jpg|png|gif|webp)/.test(file.mimetype)) cb(null, true); else cb(new Error('Solo imagenes')); } });
app.post('/api/upload-imagen', auth, uploadImg.single('imagen'), (req, res) => { if (!req.file) return res.status(400).json({ error: 'No archivo' }); res.json({ ok: true, path: req.file.filename, url: `/uploads/${req.file.filename}` }); });
app.delete('/api/upload-imagen/:filename', auth, (req, res) => { try { const fp = path.join(UPLOADS_DIR, path.basename(req.params.filename)); if (fs.existsSync(fp)) fs.unlinkSync(fp); res.json({ ok: true }); } catch(e) { res.json({ ok: false }); } });

// ── CONTACTOS ─────────────────────────────────────────────────────────────────
app.get('/api/contacts', auth, (req, res) => { const { search, status, page = 1, limit = 100 } = req.query; let q = 'SELECT * FROM contacts WHERE 1=1'; const params = []; if (search) { q += ' AND (nombre LIKE ? OR email LIKE ? OR telefono LIKE ?)'; const s = `%${search}%`; params.push(s, s, s); } if (status) { q += ' AND status = ?'; params.push(status); } const total = db.prepare(q.replace('SELECT *', 'SELECT COUNT(*) as c')).get(...params).c; q += ' ORDER BY id DESC LIMIT ? OFFSET ?'; params.push(Number(limit), (Number(page)-1)*Number(limit)); res.json({ total, page: Number(page), data: db.prepare(q).all(...params) }); });
app.post('/api/contacts', auth, (req, res) => { const { nombre, email, telefono } = req.body; if (!nombre || !telefono) return res.status(400).json({ error: 'Faltan datos' }); const tel = telefono.replace(/\D/g,''); if (tel.length < 10) return res.status(400).json({ error: 'Telefono invalido' }); try { const r = db.prepare('INSERT OR IGNORE INTO contacts (nombre, email, telefono) VALUES (?,?,?)').run(nombre, email||'', tel); res.json({ ok: true, id: r.lastInsertRowid }); } catch(e) { res.status(400).json({ error: e.message }); } });
app.put('/api/contacts/:id', auth, (req, res) => { const { nombre, email, telefono } = req.body; const tel = (telefono||'').replace(/\D/g,''); try { db.prepare('UPDATE contacts SET nombre=?, email=?, telefono=? WHERE id=?').run(nombre, email||'', tel, req.params.id); res.json({ ok: true }); } catch(e) { res.status(400).json({ error: e.message }); } });
app.delete('/api/contacts/:id', auth, (req, res) => { db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id); res.json({ ok: true }); });
app.delete('/api/contacts', auth, (req, res) => { db.prepare('DELETE FROM contacts').run(); res.json({ ok: true }); });
const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/contacts/import', auth, upload.single('file'), (req, res) => { try { const records = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true }); let inserted = 0, skipped = 0; const stmt = db.prepare('INSERT OR IGNORE INTO contacts (nombre, email, telefono) VALUES (?,?,?)'); db.transaction(() => { for (const row of records) { const nombre = row.nombre||row.Nombre||''; const email = row.email||row.Email||''; const tel = (row.telefono||row.Telefono||row.phone||'').toString().replace(/\D/g,''); if (!nombre || tel.length < 10) { skipped++; continue; } const r = stmt.run(nombre, email, tel); r.changes ? inserted++ : skipped++; } })(); res.json({ ok: true, inserted, skipped }); } catch(e) { res.status(400).json({ error: e.message }); } });

// ── TANDAS ────────────────────────────────────────────────────────────────────
app.get('/api/tandas', auth, (req, res) => { res.json(db.prepare('SELECT * FROM tandas ORDER BY id DESC').all()); });
app.post('/api/tandas', auth, (req, res) => { const { nombre, template, delay_segundos = 20, max_por_dia = 350, imagen_path = null, imagen_caption = 0 } = req.body; if (!nombre || (!template && !imagen_path)) return res.status(400).json({ error: 'Faltan datos' }); const pendientes = db.prepare("SELECT * FROM contacts WHERE status = 'pendiente'").all(); if (!pendientes.length) return res.status(400).json({ error: 'No hay contactos' }); const chunk = pendientes.slice(0, max_por_dia); const r = db.prepare('INSERT INTO tandas (nombre, template, imagen_path, imagen_caption, delay_segundos, max_por_dia, total) VALUES (?,?,?,?,?,?,?)').run(nombre, template||'', imagen_path, imagen_caption?1:0, delay_segundos, max_por_dia, chunk.length); const tandaId = r.lastInsertRowid; const stmtTC = db.prepare('INSERT INTO tanda_contactos (tanda_id, contact_id) VALUES (?,?)'); db.transaction(() => { chunk.forEach(c => stmtTC.run(tandaId, c.id)); })(); res.json({ ok: true, id: tandaId, total: chunk.length }); });
app.delete('/api/tandas/:id', auth, (req, res) => { db.prepare('DELETE FROM tanda_contactos WHERE tanda_id = ?').run(req.params.id); db.prepare('DELETE FROM tandas WHERE id = ?').run(req.params.id); res.json({ ok: true }); });
app.get('/api/tandas/:id/contactos', auth, (req, res) => { res.json(db.prepare('SELECT tc.id, tc.status, tc.enviado_at, tc.error_msg, c.nombre, c.telefono FROM tanda_contactos tc JOIN contacts c ON tc.contact_id = c.id WHERE tc.tanda_id = ? ORDER BY tc.id').all(req.params.id)); });

let activeSend = null;
app.post('/api/tandas/:id/send', auth, async (req, res) => {
  const evoState = await evoStatus();
  if (evoState !== 'open') return res.status(400).json({ error: 'WhatsApp no conectado' });
  if (activeSend) return res.status(400).json({ error: 'Ya hay envio en curso' });
  const tanda = db.prepare("SELECT * FROM tandas WHERE id = ?").get(req.params.id);
  if (!tanda) return res.status(404).json({ error: 'No encontrada' });
  const pendientes = db.prepare("SELECT tc.id as tc_id, c.nombre, c.telefono, c.email, c.id as contact_id FROM tanda_contactos tc JOIN contacts c ON tc.contact_id = c.id WHERE tc.tanda_id = ? AND tc.status = 'pendiente'").all(tanda.id);
  if (!pendientes.length) return res.status(400).json({ error: 'No hay pendientes' });
  db.prepare("UPDATE tandas SET status = 'en-curso' WHERE id = ?").run(tanda.id);
  res.json({ ok: true, total: pendientes.length });
  activeSend = { tandaId: tanda.id, total: pendientes.length, current: 0, stop: false };
  for (const c of pendientes) {
    if (activeSend.stop) break;
    const msg = tanda.template ? tanda.template.replace(/{nombre}/g, c.nombre).replace(/{telefono}/g, c.telefono).replace(/{email}/g, c.email||'') : '';
    try {
      if (tanda.imagen_path) {
        const imgFile = path.join(UPLOADS_DIR, tanda.imagen_path);
        if (!fs.existsSync(imgFile)) throw new Error('Imagen no encontrada');
        const imgBase64 = fs.readFileSync(imgFile).toString('base64');
        const ext = path.extname(tanda.imagen_path).replace('.','');
        const mediaBase64 = `data:image/${ext};base64,${imgBase64}`;
        await evoSendImage(c.telefono, mediaBase64, tanda.imagen_caption ? msg : '');
        if (!tanda.imagen_caption && msg) { await new Promise(r => setTimeout(r, 1500)); await evoSendText(c.telefono, msg); }
      } else {
        await evoSendText(c.telefono, msg);
      }
      db.prepare("UPDATE tanda_contactos SET status='enviado', enviado_at=datetime('now') WHERE id=?").run(c.tc_id);
      db.prepare("UPDATE contacts SET status='enviado' WHERE id=?").run(c.contact_id);
      db.prepare("UPDATE tandas SET enviados=enviados+1 WHERE id=?").run(tanda.id);
      db.prepare("INSERT INTO historial (tanda_id, contact_id, telefono, nombre, status) VALUES (?,?,?,?,?)").run(tanda.id, c.contact_id, c.telefono, c.nombre, 'enviado');
      db.prepare("INSERT INTO mensajes (telefono, nombre, direccion, contenido, tipo) VALUES (?,?,?,?,?)").run(c.telefono, c.nombre, 'saliente', msg||'[imagen]', tanda.imagen_path?'imagen':'texto');
      activeSend.current++;
    } catch(err) {
      db.prepare("UPDATE tanda_contactos SET status='fallido', error_msg=? WHERE id=?").run(err.message, c.tc_id);
      db.prepare("UPDATE tandas SET fallidos=fallidos+1 WHERE id=?").run(tanda.id);
      db.prepare("INSERT INTO historial (tanda_id, contact_id, telefono, nombre, status, error_msg) VALUES (?,?,?,?,?,?)").run(tanda.id, c.contact_id, c.telefono, c.nombre, 'fallido', err.message);
    }
    if (!activeSend.stop) await new Promise(r => setTimeout(r, tanda.delay_segundos * 1000));
  }
  db.prepare("UPDATE tandas SET status = CASE WHEN fallidos = 0 THEN 'completo' ELSE 'completo-con-errores' END WHERE id = ?").run(tanda.id);
  activeSend = null;
});
app.post('/api/tandas/stop', auth, (req, res) => { if (activeSend) { activeSend.stop = true; res.json({ ok: true }); } else res.json({ ok: false }); });
app.get('/api/send-status', auth, (req, res) => res.json(activeSend || { active: false }));
app.get('/api/historial', auth, (req, res) => { res.json(db.prepare('SELECT * FROM historial ORDER BY id DESC LIMIT 500').all()); });
app.delete('/api/historial', auth, (req, res) => { db.prepare('DELETE FROM historial').run(); res.json({ ok: true }); });

// ── EMAIL ─────────────────────────────────────────────────────────────────────
let emailTransporter = null;
let emailConfig = { user: '', pass: '', from_name: 'Tutu Automotores', reply_to: '' };
function buildTransporter(cfg) { return nodemailer.createTransport({ service: 'gmail', auth: { user: cfg.user, pass: cfg.pass } }); }
app.get('/api/email/config', auth, (req, res) => { res.json({ user: emailConfig.user, from_name: emailConfig.from_name, reply_to: emailConfig.reply_to, connected: !!emailTransporter }); });
app.post('/api/email/config', auth, async (req, res) => { const { user, pass, from_name, reply_to } = req.body; if (!user || !pass) return res.status(400).json({ error: 'Faltan datos' }); try { const t = buildTransporter({ user, pass }); await t.verify(); emailConfig = { user, pass, from_name: from_name||'Tutu Automotores', reply_to: reply_to||user }; emailTransporter = t; res.json({ ok: true }); } catch(e) { res.status(400).json({ error: e.message }); } });
app.post('/api/email/test', auth, async (req, res) => { if (!emailTransporter) return res.status(400).json({ error: 'No configurado' }); try { await emailTransporter.sendMail({ from: `"${emailConfig.from_name}" <${emailConfig.user}>`, to: req.body.to, subject: 'Test Tutu', html: '<h2>Funciona!</h2>' }); res.json({ ok: true }); } catch(e) { res.status(400).json({ error: e.message }); } });
app.get('/api/email/contacts', auth, (req, res) => { const { search, status, limit = 100 } = req.query; let q = 'SELECT * FROM email_contacts WHERE 1=1'; const params = []; if (search) { q += ' AND (nombre LIKE ? OR email LIKE ?)'; const s = `%${search}%`; params.push(s, s); } if (status) { q += ' AND status = ?'; params.push(status); } const total = db.prepare(q.replace('SELECT *','SELECT COUNT(*) as c')).get(...params).c; q += ' ORDER BY id DESC LIMIT ?'; params.push(Number(limit)); res.json({ total, data: db.prepare(q).all(...params) }); });
app.post('/api/email/contacts', auth, (req, res) => { const { nombre, email, telefono, tags } = req.body; if (!nombre || !email) return res.status(400).json({ error: 'Faltan datos' }); try { const r = db.prepare('INSERT OR IGNORE INTO email_contacts (nombre, email, telefono, tags) VALUES (?,?,?,?)').run(nombre, email.toLowerCase().trim(), telefono||'', tags||''); res.json({ ok: true, id: r.lastInsertRowid }); } catch(e) { res.status(400).json({ error: e.message }); } });
app.delete('/api/email/contacts/:id', auth, (req, res) => { db.prepare('DELETE FROM email_contacts WHERE id = ?').run(req.params.id); res.json({ ok: true }); });
app.delete('/api/email/contacts', auth, (req, res) => { db.prepare('DELETE FROM email_contacts').run(); res.json({ ok: true }); });
const uploadMem = multer({ storage: multer.memoryStorage() });
app.post('/api/email/contacts/import', auth, uploadMem.single('file'), (req, res) => { try { const records = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true }); let inserted = 0, skipped = 0; const stmt = db.prepare('INSERT OR IGNORE INTO email_contacts (nombre, email, telefono, tags) VALUES (?,?,?,?)'); db.transaction(() => { for (const row of records) { const nombre = row.nombre||row.Nombre||''; const email = (row.email||row.Email||'').toLowerCase().trim(); const telefono = (row.telefono||row.Telefono||'').toString().replace(/\D/g,''); const tags = row.tags||''; if (!nombre || !email || !email.includes('@')) { skipped++; continue; } const r = stmt.run(nombre, email, telefono, tags); r.changes ? inserted++ : skipped++; } })(); res.json({ ok: true, inserted, skipped }); } catch(e) { res.status(400).json({ error: e.message }); } });
app.post('/api/email/contacts/sync-from-wa', auth, (req, res) => { const waContacts = db.prepare("SELECT * FROM contacts WHERE email IS NOT NULL AND email != ''").all(); let imported = 0, skipped = 0; const stmt = db.prepare('INSERT OR IGNORE INTO email_contacts (nombre, email, telefono) VALUES (?,?,?)'); db.transaction(() => { for (const c of waContacts) { const r = stmt.run(c.nombre, c.email.toLowerCase().trim(), c.telefono||''); r.changes ? imported++ : skipped++; } })(); res.json({ ok: true, imported, skipped }); });
app.get('/api/email/campanas', auth, (req, res) => res.json(db.prepare('SELECT * FROM email_campanas ORDER BY id DESC').all()));
app.post('/api/email/campanas', auth, (req, res) => { const { nombre, asunto, cuerpo_html, from_name, reply_to, delay_segundos = 5, max_por_dia = 300 } = req.body; if (!nombre || !asunto || !cuerpo_html) return res.status(400).json({ error: 'Faltan datos' }); const pendientes = db.prepare("SELECT * FROM email_contacts WHERE status = 'pendiente'").all(); if (!pendientes.length) return res.status(400).json({ error: 'No hay contactos' }); const chunk = pendientes.slice(0, max_por_dia); const r = db.prepare('INSERT INTO email_campanas (nombre, asunto, cuerpo_html, from_name, reply_to, delay_segundos, max_por_dia, total) VALUES (?,?,?,?,?,?,?,?)').run(nombre, asunto, cuerpo_html, from_name||emailConfig.from_name, reply_to||emailConfig.reply_to||emailConfig.user, delay_segundos, max_por_dia, chunk.length); const campanaId = r.lastInsertRowid; const stmtCC = db.prepare('INSERT INTO email_campana_contactos (campana_id, contact_id) VALUES (?,?)'); db.transaction(() => { chunk.forEach(c => stmtCC.run(campanaId, c.id)); })(); res.json({ ok: true, id: campanaId, total: chunk.length }); });
app.delete('/api/email/campanas/:id', auth, (req, res) => { db.prepare('DELETE FROM email_campana_contactos WHERE campana_id = ?').run(req.params.id); db.prepare('DELETE FROM email_campanas WHERE id = ?').run(req.params.id); res.json({ ok: true }); });
app.get('/api/email/campanas/:id/contactos', auth, (req, res) => { res.json(db.prepare('SELECT cc.id, cc.status, cc.enviado_at, cc.error_msg, c.nombre, c.email FROM email_campana_contactos cc JOIN email_contacts c ON cc.contact_id = c.id WHERE cc.campana_id = ? ORDER BY cc.id').all(req.params.id)); });
let activeEmailSend = null;
app.post('/api/email/campanas/:id/send', auth, async (req, res) => { if (!emailTransporter) return res.status(400).json({ error: 'No configurado' }); if (activeEmailSend) return res.status(400).json({ error: 'Ya hay envio' }); const campana = db.prepare('SELECT * FROM email_campanas WHERE id = ?').get(req.params.id); if (!campana) return res.status(404).json({ error: 'No encontrada' }); const pendientes = db.prepare("SELECT cc.id as cc_id, c.nombre, c.email, c.id as contact_id FROM email_campana_contactos cc JOIN email_contacts c ON cc.contact_id = c.id WHERE cc.campana_id = ? AND cc.status = 'pendiente'").all(campana.id); if (!pendientes.length) return res.status(400).json({ error: 'No hay pendientes' }); db.prepare("UPDATE email_campanas SET status = 'en-curso' WHERE id = ?").run(campana.id); res.json({ ok: true, total: pendientes.length }); activeEmailSend = { campanaId: campana.id, total: pendientes.length, current: 0, stop: false }; for (const c of pendientes) { if (activeEmailSend.stop) break; try { await emailTransporter.sendMail({ from: `"${campana.from_name}" <${emailConfig.user}>`, replyTo: campana.reply_to||emailConfig.user, to: `"${c.nombre}" <${c.email}>`, subject: campana.asunto.replace(/{nombre}/g, c.nombre), html: campana.cuerpo_html.replace(/{nombre}/g, c.nombre).replace(/{email}/g, c.email) }); db.prepare("UPDATE email_campana_contactos SET status='enviado', enviado_at=datetime('now') WHERE id=?").run(c.cc_id); db.prepare("UPDATE email_contacts SET status='enviado' WHERE id=?").run(c.contact_id); db.prepare("UPDATE email_campanas SET enviados=enviados+1 WHERE id=?").run(campana.id); db.prepare("INSERT INTO email_historial (campana_id, contact_id, email, nombre, status) VALUES (?,?,?,?,?)").run(campana.id, c.contact_id, c.email, c.nombre, 'enviado'); activeEmailSend.current++; } catch(err) { db.prepare("UPDATE email_campana_contactos SET status='fallido', error_msg=? WHERE id=?").run(err.message, c.cc_id); db.prepare("UPDATE email_campanas SET fallidos=fallidos+1 WHERE id=?").run(campana.id); db.prepare("INSERT INTO email_historial (campana_id, contact_id, email, nombre, status, error_msg) VALUES (?,?,?,?,?,?)").run(campana.id, c.contact_id, c.email, c.nombre, 'fallido', err.message); } if (!activeEmailSend.stop) await new Promise(r => setTimeout(r, campana.delay_segundos * 1000)); } db.prepare("UPDATE email_campanas SET status = CASE WHEN fallidos = 0 THEN 'completo' ELSE 'completo-con-errores' END WHERE id = ?").run(campana.id); activeEmailSend = null; });
app.post('/api/email/campanas/stop', auth, (req, res) => { if (activeEmailSend) { activeEmailSend.stop = true; res.json({ ok: true }); } else res.json({ ok: false }); });
app.get('/api/email/send-status', auth, (req, res) => res.json(activeEmailSend || { active: false }));
app.get('/api/email/historial', auth, (req, res) => res.json(db.prepare('SELECT * FROM email_historial ORDER BY id DESC LIMIT 500').all()));
app.delete('/api/email/historial', auth, (req, res) => { db.prepare('DELETE FROM email_historial').run(); res.json({ ok: true }); });

// ── BANDEJA ───────────────────────────────────────────────────────────────────
app.get('/api/bandeja', auth, (req, res) => { res.json(db.prepare("SELECT m.telefono, m.nombre, MAX(m.created_at) as ultimo_at, (SELECT contenido FROM mensajes WHERE telefono = m.telefono ORDER BY id DESC LIMIT 1) as ultimo_msg, (SELECT direccion FROM mensajes WHERE telefono = m.telefono ORDER BY id DESC LIMIT 1) as ultima_dir, SUM(CASE WHEN m.leido = 0 AND m.direccion = 'entrante' THEN 1 ELSE 0 END) as no_leidos FROM mensajes m GROUP BY m.telefono ORDER BY ultimo_at DESC LIMIT 200").all()); });
app.get('/api/bandeja/:telefono', auth, (req, res) => { const tel = req.params.telefono.replace(/\D/g,''); db.prepare("UPDATE mensajes SET leido = 1 WHERE telefono = ? AND direccion = 'entrante'").run(tel); res.json({ msgs: db.prepare("SELECT * FROM mensajes WHERE telefono = ? ORDER BY id ASC LIMIT 200").all(tel), contacto: db.prepare("SELECT * FROM contacts WHERE telefono = ?").get(tel) }); });
app.post('/api/bandeja/:telefono/send', auth, async (req, res) => {
  const tel = req.params.telefono.replace(/\D/g,'');
  const { mensaje } = req.body;
  if (!mensaje) return res.status(400).json({ error: 'Mensaje vacio' });
  try {
    await evoSendText(tel, mensaje);
    const contacto = db.prepare("SELECT nombre FROM contacts WHERE telefono = ?").get(tel);
    db.prepare("INSERT INTO mensajes (telefono, nombre, direccion, contenido, tipo) VALUES (?,?,?,?,?)").run(tel, contacto?.nombre||tel, 'saliente', mensaje, 'texto');
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/bandeja/noleidos/count', auth, (req, res) => { res.json({ count: db.prepare("SELECT COUNT(*) as c FROM mensajes WHERE leido = 0 AND direccion = 'entrante'").get().c }); });

// ── STATS ─────────────────────────────────────────────────────────────────────
app.get('/api/stats', auth, async (req, res) => {
  const state = await evoStatus();
  res.json({ total_contacts: db.prepare('SELECT COUNT(*) as c FROM contacts').get().c, pendientes: db.prepare("SELECT COUNT(*) as c FROM contacts WHERE status='pendiente'").get().c, enviados: db.prepare("SELECT COUNT(*) as c FROM contacts WHERE status='enviado'").get().c, total_tandas: db.prepare('SELECT COUNT(*) as c FROM tandas').get().c, hoy: db.prepare("SELECT COUNT(*) as c FROM historial WHERE date(sent_at)=date('now')").get().c, wp_status: state === 'open' ? 'conectado' : state, no_leidos: db.prepare("SELECT COUNT(*) as c FROM mensajes WHERE leido=0 AND direccion='entrante'").get().c, email_contacts: db.prepare('SELECT COUNT(*) as c FROM email_contacts').get().c, email_pendientes: db.prepare("SELECT COUNT(*) as c FROM email_contacts WHERE status='pendiente'").get().c, email_enviados: db.prepare("SELECT COUNT(*) as c FROM email_contacts WHERE status='enviado'").get().c, email_hoy: db.prepare("SELECT COUNT(*) as c FROM email_historial WHERE date(sent_at)=date('now')").get().c, email_config: !!emailTransporter, bot_activo: true, bot_url: TUTU_BOT_URL, bot_conversaciones: Object.keys(conversaciones).length });
});

app.get('/health', (_, res) => res.json({ status: 'ok', evo: EVO_URL, instance: EVO_INSTANCE }));

app.listen(PORT, () => {
  console.log(`[SERVER] Puerto ${PORT}`);
  console.log(`[EVO] Evolution API: ${EVO_URL} / instancia: ${EVO_INSTANCE}`);
  console.log(`[BOT] Tutusita: ${TUTU_BOT_URL}`);
  console.log('[WEBHOOK] Esperando mensajes en /webhook/evolution');
});
