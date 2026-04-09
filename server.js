require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');
const wppconnect = require('@wppconnect-team/wppconnect');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'tutu2024';
const SESSION_NAME = process.env.SESSION_NAME || 'tutu-sender';
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── BASE DE DATOS ────────────────────────────────────────────────────────────
const db = new Database('./tutu_wapp.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT,
    telefono TEXT NOT NULL UNIQUE,
    status TEXT DEFAULT 'pendiente',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tandas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    template TEXT NOT NULL,
    imagen_path TEXT,
    imagen_caption INTEGER DEFAULT 0,
    delay_segundos INTEGER DEFAULT 20,
    max_por_dia INTEGER DEFAULT 350,
    status TEXT DEFAULT 'pendiente',
    total INTEGER DEFAULT 0,
    enviados INTEGER DEFAULT 0,
    fallidos INTEGER DEFAULT 0,
    fecha_programada TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  -- Migración segura: agregar columnas si no existen
  
  CREATE TABLE IF NOT EXISTS tanda_contactos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tanda_id INTEGER,
    contact_id INTEGER,
    status TEXT DEFAULT 'pendiente',
    enviado_at DATETIME,
    error_msg TEXT,
    FOREIGN KEY(tanda_id) REFERENCES tandas(id),
    FOREIGN KEY(contact_id) REFERENCES contacts(id)
  );
  CREATE TABLE IF NOT EXISTS historial (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tanda_id INTEGER,
    contact_id INTEGER,
    telefono TEXT,
    nombre TEXT,
    status TEXT,
    error_msg TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS email_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    telefono TEXT,
    tags TEXT DEFAULT '',
    status TEXT DEFAULT 'pendiente',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS email_campanas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    asunto TEXT NOT NULL,
    cuerpo_html TEXT NOT NULL,
    from_name TEXT DEFAULT 'Tutu Automotores',
    reply_to TEXT,
    delay_segundos INTEGER DEFAULT 5,
    max_por_dia INTEGER DEFAULT 300,
    status TEXT DEFAULT 'pendiente',
    total INTEGER DEFAULT 0,
    enviados INTEGER DEFAULT 0,
    fallidos INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS email_campana_contactos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campana_id INTEGER,
    contact_id INTEGER,
    status TEXT DEFAULT 'pendiente',
    enviado_at DATETIME,
    error_msg TEXT,
    FOREIGN KEY(campana_id) REFERENCES email_campanas(id),
    FOREIGN KEY(contact_id) REFERENCES email_contacts(id)
  );
  CREATE TABLE IF NOT EXISTS email_historial (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campana_id INTEGER,
    contact_id INTEGER,
    email TEXT,
    nombre TEXT,
    status TEXT,
    error_msg TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Migraciones seguras
try { db.exec("ALTER TABLE tandas ADD COLUMN imagen_path TEXT"); } catch(e) {}
try { db.exec("ALTER TABLE tandas ADD COLUMN imagen_caption INTEGER DEFAULT 0"); } catch(e) {}

// ─── UPLOAD IMAGEN ────────────────────────────────────────────────────────────
const imgStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `img_${Date.now()}${ext}`);
  }
});
const uploadImg = multer({
  storage: imgStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image\/(jpeg|jpg|png|gif|webp)/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Solo se permiten imágenes JPG, PNG, GIF o WEBP'));
  }
});

app.post('/api/upload-imagen', auth, uploadImg.single('imagen'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });
  res.json({ ok: true, path: req.file.filename, url: `/uploads/${req.file.filename}` });
});

app.delete('/api/upload-imagen/:filename', auth, (req, res) => {
  const fp = path.join(UPLOADS_DIR, path.basename(req.params.filename));
  try { if (fs.existsSync(fp)) fs.unlinkSync(fp); res.json({ ok: true }); }
  catch(e) { res.json({ ok: false, error: e.message }); }
});

// ─── WHATSAPP CLIENT ──────────────────────────────────────────────────────────
let wpClient = null;
let wpStatus = 'desconectado'; // desconectado | esperando_qr | conectado | error
let lastQR = null;

async function initWPP() {
  try {
    wpStatus = 'iniciando';
    wpClient = await wppconnect.create({
      session: SESSION_NAME,
      folderNameToken: './tokens',
      headless: true,
      devtools: false,
      useChrome: false,
      debug: false,
      logQR: false,
      puppeteerOptions: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ]
      },
      catchQR: (base64Qr) => {
        lastQR = base64Qr;
        wpStatus = 'esperando_qr';
        console.log('[WPP] QR generado — escaneá desde el panel');
      },
      statusFind: (statusSession) => {
        console.log('[WPP] Status:', statusSession);
        if (statusSession === 'isLogged' || statusSession === 'inChat') {
          wpStatus = 'conectado';
          lastQR = null;
        } else if (statusSession === 'notLogged') {
          wpStatus = 'esperando_qr';
        }
      }
    });
    wpStatus = 'conectado';
    lastQR = null;
    console.log('[WPP] ✅ WhatsApp conectado');
    wpClient.onStateChange((state) => {
      console.log('[WPP] Estado cambió:', state);
      if (state === 'CONFLICT' || state === 'UNPAIRED') {
        wpStatus = 'desconectado';
        wpClient = null;
      }
    });
  } catch (err) {
    console.error('[WPP] Error al iniciar:', err.message);
    wpStatus = 'error';
    wpClient = null;
  }
}

// ─── MIDDLEWARE AUTH ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ─── RUTAS: WHATSAPP STATUS ───────────────────────────────────────────────────
app.get('/api/wp/status', auth, (req, res) => {
  res.json({ status: wpStatus, qr: lastQR });
});

app.post('/api/wp/connect', auth, async (req, res) => {
  if (wpStatus === 'conectado') return res.json({ ok: true, msg: 'Ya conectado' });
  if (wpStatus === 'iniciando') return res.json({ ok: false, msg: 'Ya iniciando...' });
  res.json({ ok: true, msg: 'Iniciando conexión, revisá el QR en unos segundos' });
  initWPP();
});

app.post('/api/wp/disconnect', auth, async (req, res) => {
  try {
    if (wpClient) { await wpClient.close(); wpClient = null; }
    wpStatus = 'desconectado'; lastQR = null;
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ─── RUTAS: CONTACTOS ─────────────────────────────────────────────────────────
app.get('/api/contacts', auth, (req, res) => {
  const { search, status, page = 1, limit = 100 } = req.query;
  let q = 'SELECT * FROM contacts WHERE 1=1';
  const params = [];
  if (search) { q += ' AND (nombre LIKE ? OR email LIKE ? OR telefono LIKE ?)'; const s = `%${search}%`; params.push(s, s, s); }
  if (status) { q += ' AND status = ?'; params.push(status); }
  const total = db.prepare(q.replace('SELECT *', 'SELECT COUNT(*) as c')).get(...params).c;
  q += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), (Number(page) - 1) * Number(limit));
  const rows = db.prepare(q).all(...params);
  res.json({ total, page: Number(page), data: rows });
});

app.post('/api/contacts', auth, (req, res) => {
  const { nombre, email, telefono } = req.body;
  if (!nombre || !telefono) return res.status(400).json({ error: 'nombre y telefono requeridos' });
  const tel = telefono.replace(/\D/g, '');
  if (tel.length < 10) return res.status(400).json({ error: 'Teléfono inválido' });
  try {
    const r = db.prepare('INSERT OR IGNORE INTO contacts (nombre, email, telefono) VALUES (?,?,?)').run(nombre, email || '', tel);
    res.json({ ok: true, id: r.lastInsertRowid, inserted: r.changes });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/contacts/:id', auth, (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/contacts', auth, (req, res) => {
  db.prepare('DELETE FROM contacts').run();
  res.json({ ok: true });
});

// Importar CSV
const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/contacts/import', auth, upload.single('file'), (req, res) => {
  try {
    const content = req.file.buffer.toString('utf8');
    const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    let inserted = 0, skipped = 0;
    const stmt = db.prepare('INSERT OR IGNORE INTO contacts (nombre, email, telefono) VALUES (?,?,?)');
    const insertMany = db.transaction((rows) => {
      for (const row of rows) {
        const nombre = row.nombre || row.Nombre || row.NOMBRE || '';
        const email = row.email || row.Email || row.EMAIL || '';
        const tel = (row.telefono || row.Telefono || row.TELEFONO || row.phone || '').toString().replace(/\D/g, '');
        if (!nombre || tel.length < 10) { skipped++; continue; }
        const r = stmt.run(nombre, email, tel);
        if (r.changes) inserted++;
        else skipped++;
      }
    });
    insertMany(records);
    res.json({ ok: true, inserted, skipped, total: records.length });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── RUTAS: TANDAS ────────────────────────────────────────────────────────────
app.get('/api/tandas', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM tandas ORDER BY id DESC').all();
  res.json(rows);
});

app.post('/api/tandas', auth, (req, res) => {
  const { nombre, template, delay_segundos = 20, max_por_dia = 350, fecha_programada, imagen_path = null, imagen_caption = 0 } = req.body;
  if (!nombre) return res.status(400).json({ error: 'nombre requerido' });
  if (!template && !imagen_path) return res.status(400).json({ error: 'Necesitás al menos un mensaje o una imagen' });
  const pendientes = db.prepare("SELECT * FROM contacts WHERE status = 'pendiente'").all();
  if (!pendientes.length) return res.status(400).json({ error: 'No hay contactos pendientes' });
  const r = db.prepare('INSERT INTO tandas (nombre, template, imagen_path, imagen_caption, delay_segundos, max_por_dia, total, fecha_programada) VALUES (?,?,?,?,?,?,?,?)')
    .run(nombre, template || '', imagen_path, imagen_caption ? 1 : 0, delay_segundos, max_por_dia, Math.min(pendientes.length, max_por_dia), fecha_programada || null);
  const tandaId = r.lastInsertRowid;
  const chunk = pendientes.slice(0, max_por_dia);
  const stmtTC = db.prepare('INSERT INTO tanda_contactos (tanda_id, contact_id) VALUES (?,?)');
  db.transaction(() => { chunk.forEach(c => stmtTC.run(tandaId, c.id)); })();
  res.json({ ok: true, id: tandaId, total: chunk.length });
});

app.delete('/api/tandas/:id', auth, (req, res) => {
  db.prepare('DELETE FROM tanda_contactos WHERE tanda_id = ?').run(req.params.id);
  db.prepare('DELETE FROM tandas WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/tandas/:id/contactos', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT tc.id, tc.status, tc.enviado_at, tc.error_msg, c.nombre, c.telefono, c.email
    FROM tanda_contactos tc JOIN contacts c ON tc.contact_id = c.id
    WHERE tc.tanda_id = ? ORDER BY tc.id
  `).all(req.params.id);
  res.json(rows);
});

// ─── ENVÍO REAL ───────────────────────────────────────────────────────────────
let activeSend = null; // guarda el estado del envío en curso

app.post('/api/tandas/:id/send', auth, async (req, res) => {
  if (wpStatus !== 'conectado' || !wpClient) return res.status(400).json({ error: 'WhatsApp no conectado' });
  if (activeSend) return res.status(400).json({ error: 'Ya hay un envío en curso' });

  const tanda = db.prepare("SELECT * FROM tandas WHERE id = ?").get(req.params.id);
  if (!tanda) return res.status(404).json({ error: 'Tanda no encontrada' });

  const pendientes = db.prepare(`
    SELECT tc.id as tc_id, c.nombre, c.telefono, c.email, c.id as contact_id
    FROM tanda_contactos tc JOIN contacts c ON tc.contact_id = c.id
    WHERE tc.tanda_id = ? AND tc.status = 'pendiente'
  `).all(tanda.id);

  if (!pendientes.length) return res.status(400).json({ error: 'No hay pendientes en esta tanda' });

  db.prepare("UPDATE tandas SET status = 'en-curso' WHERE id = ?").run(tanda.id);
  res.json({ ok: true, total: pendientes.length, msg: 'Envío iniciado en background' });

  activeSend = { tandaId: tanda.id, total: pendientes.length, current: 0, stop: false };

  for (const c of pendientes) {
    if (activeSend.stop) break;
    const msg = tanda.template
      ? tanda.template
          .replace(/{nombre}/g, c.nombre)
          .replace(/{telefono}/g, c.telefono)
          .replace(/{email}/g, c.email || '')
      : '';
    try {
      const destino = `${c.telefono}@c.us`;
      if (tanda.imagen_path) {
        const imgFile = path.join(UPLOADS_DIR, tanda.imagen_path);
        if (!fs.existsSync(imgFile)) throw new Error('Imagen no encontrada en servidor');
        // Si imagen_caption=1 el texto va como caption de la imagen, sino se envían por separado
        if (tanda.imagen_caption && msg) {
          await wpClient.sendImage(destino, imgFile, 'imagen', msg);
        } else {
          await wpClient.sendImage(destino, imgFile, 'imagen', '');
          if (msg) {
            await new Promise(r => setTimeout(r, 1500));
            await wpClient.sendText(destino, msg);
          }
        }
      } else {
        await wpClient.sendText(destino, msg);
      }
      db.prepare("UPDATE tanda_contactos SET status='enviado', enviado_at=datetime('now') WHERE id=?").run(c.tc_id);
      db.prepare("UPDATE contacts SET status='enviado' WHERE id=?").run(c.contact_id);
      db.prepare("UPDATE tandas SET enviados=enviados+1 WHERE id=?").run(tanda.id);
      db.prepare("INSERT INTO historial (tanda_id, contact_id, telefono, nombre, status) VALUES (?,?,?,?,?)").run(tanda.id, c.contact_id, c.telefono, c.nombre, 'enviado');
      activeSend.current++;
    } catch (err) {
      const errMsg = err.message || 'Error desconocido';
      db.prepare("UPDATE tanda_contactos SET status='fallido', error_msg=? WHERE id=?").run(errMsg, c.tc_id);
      db.prepare("UPDATE tandas SET fallidos=fallidos+1 WHERE id=?").run(tanda.id);
      db.prepare("INSERT INTO historial (tanda_id, contact_id, telefono, nombre, status, error_msg) VALUES (?,?,?,?,?,?)").run(tanda.id, c.contact_id, c.telefono, c.nombre, 'fallido', errMsg);
    }
    if (activeSend.stop) break;
    await new Promise(r => setTimeout(r, tanda.delay_segundos * 1000));
  }
  db.prepare("UPDATE tandas SET status = CASE WHEN fallidos = 0 THEN 'completo' ELSE 'completo-con-errores' END WHERE id = ?").run(tanda.id);
  activeSend = null;
  console.log(`[SEND] Tanda ${tanda.id} finalizada`);
});

app.post('/api/tandas/stop', auth, (req, res) => {
  if (activeSend) { activeSend.stop = true; res.json({ ok: true, msg: 'Deteniendo...' }); }
  else res.json({ ok: false, msg: 'No hay envío activo' });
});

app.get('/api/send-status', auth, (req, res) => {
  res.json(activeSend || { active: false });
});

// ─── HISTORIAL ────────────────────────────────────────────────────────────────
app.get('/api/historial', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM historial ORDER BY id DESC LIMIT 500').all();
  res.json(rows);
});

app.delete('/api/historial', auth, (req, res) => {
  db.prepare('DELETE FROM historial').run();
  res.json({ ok: true });
});

// ─── EMAIL: CONFIG GMAIL ──────────────────────────────────────────────────────
let emailTransporter = null;
let emailConfig = { user: '', pass: '', from_name: 'Tutu Automotores', reply_to: '' };

function buildTransporter(cfg) {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: cfg.user, pass: cfg.pass }
  });
}

app.get('/api/email/config', auth, (req, res) => {
  res.json({ user: emailConfig.user, from_name: emailConfig.from_name, reply_to: emailConfig.reply_to, connected: !!emailTransporter });
});

app.post('/api/email/config', auth, async (req, res) => {
  const { user, pass, from_name, reply_to } = req.body;
  if (!user || !pass) return res.status(400).json({ error: 'Email y contraseña de app requeridos' });
  try {
    const t = buildTransporter({ user, pass });
    await t.verify();
    emailConfig = { user, pass, from_name: from_name || 'Tutu Automotores', reply_to: reply_to || user };
    emailTransporter = t;
    res.json({ ok: true, msg: 'Conexión exitosa con Gmail ✅' });
  } catch(e) { res.status(400).json({ error: 'No se pudo conectar: ' + e.message }); }
});

app.post('/api/email/test', auth, async (req, res) => {
  if (!emailTransporter) return res.status(400).json({ error: 'Gmail no configurado' });
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Email destino requerido' });
  try {
    await emailTransporter.sendMail({
      from: `"${emailConfig.from_name}" <${emailConfig.user}>`,
      replyTo: emailConfig.reply_to || emailConfig.user,
      to,
      subject: '✅ Test de conexión — Tutu Automotores',
      html: '<h2>¡Funciona!</h2><p>Tu sistema de emails masivos está correctamente configurado.</p><p><i>Tutu Automotores</i></p>'
    });
    res.json({ ok: true, msg: `Email de prueba enviado a ${to}` });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ─── EMAIL: CONTACTOS ─────────────────────────────────────────────────────────
app.get('/api/email/contacts', auth, (req, res) => {
  const { search, status, page = 1, limit = 100 } = req.query;
  let q = 'SELECT * FROM email_contacts WHERE 1=1';
  const params = [];
  if (search) { q += ' AND (nombre LIKE ? OR email LIKE ?)'; const s = `%${search}%`; params.push(s, s); }
  if (status) { q += ' AND status = ?'; params.push(status); }
  const total = db.prepare(q.replace('SELECT *', 'SELECT COUNT(*) as c')).get(...params).c;
  q += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), (Number(page) - 1) * Number(limit));
  res.json({ total, data: db.prepare(q).all(...params) });
});

app.post('/api/email/contacts', auth, (req, res) => {
  const { nombre, email, telefono, tags } = req.body;
  if (!nombre || !email) return res.status(400).json({ error: 'nombre y email requeridos' });
  try {
    const r = db.prepare('INSERT OR IGNORE INTO email_contacts (nombre, email, telefono, tags) VALUES (?,?,?,?)').run(nombre, email.toLowerCase().trim(), telefono || '', tags || '');
    res.json({ ok: true, id: r.lastInsertRowid, inserted: r.changes });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/email/contacts/:id', auth, (req, res) => {
  db.prepare('DELETE FROM email_contacts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/email/contacts', auth, (req, res) => {
  db.prepare('DELETE FROM email_contacts').run();
  res.json({ ok: true });
});

// Importar CSV email
const uploadMem = multer({ storage: multer.memoryStorage() });
app.post('/api/email/contacts/import', auth, uploadMem.single('file'), (req, res) => {
  try {
    const records = parse(req.file.buffer.toString('utf8'), { columns: true, skip_empty_lines: true, trim: true });
    let inserted = 0, skipped = 0;
    const stmt = db.prepare('INSERT OR IGNORE INTO email_contacts (nombre, email, telefono, tags) VALUES (?,?,?,?)');
    db.transaction(() => {
      for (const row of records) {
        const nombre = row.nombre || row.Nombre || row.NOMBRE || '';
        const email = (row.email || row.Email || row.EMAIL || '').toLowerCase().trim();
        const telefono = (row.telefono || row.Telefono || '').toString().replace(/\D/g, '');
        const tags = row.tags || row.Tags || '';
        if (!nombre || !email || !email.includes('@')) { skipped++; continue; }
        const r = stmt.run(nombre, email, telefono, tags);
        r.changes ? inserted++ : skipped++;
      }
    })();
    res.json({ ok: true, inserted, skipped, total: records.length });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Sync desde base WA → base email (contactos con email)
app.post('/api/email/contacts/sync-from-wa', auth, (req, res) => {
  const waContacts = db.prepare("SELECT * FROM contacts WHERE email IS NOT NULL AND email != ''").all();
  let imported = 0, skipped = 0;
  const stmt = db.prepare('INSERT OR IGNORE INTO email_contacts (nombre, email, telefono) VALUES (?,?,?)');
  db.transaction(() => {
    for (const c of waContacts) {
      const r = stmt.run(c.nombre, c.email.toLowerCase().trim(), c.telefono || '');
      r.changes ? imported++ : skipped++;
    }
  })();
  res.json({ ok: true, imported, skipped });
});

// ─── EMAIL: CAMPAÑAS ──────────────────────────────────────────────────────────
app.get('/api/email/campanas', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM email_campanas ORDER BY id DESC').all());
});

app.post('/api/email/campanas', auth, (req, res) => {
  const { nombre, asunto, cuerpo_html, from_name, reply_to, delay_segundos = 5, max_por_dia = 300 } = req.body;
  if (!nombre || !asunto || !cuerpo_html) return res.status(400).json({ error: 'nombre, asunto y cuerpo requeridos' });
  const pendientes = db.prepare("SELECT * FROM email_contacts WHERE status = 'pendiente'").all();
  if (!pendientes.length) return res.status(400).json({ error: 'No hay contactos de email pendientes' });
  const chunk = pendientes.slice(0, max_por_dia);
  const r = db.prepare('INSERT INTO email_campanas (nombre, asunto, cuerpo_html, from_name, reply_to, delay_segundos, max_por_dia, total) VALUES (?,?,?,?,?,?,?,?)')
    .run(nombre, asunto, cuerpo_html, from_name || emailConfig.from_name, reply_to || emailConfig.reply_to || emailConfig.user, delay_segundos, max_por_dia, chunk.length);
  const campanaId = r.lastInsertRowid;
  const stmtCC = db.prepare('INSERT INTO email_campana_contactos (campana_id, contact_id) VALUES (?,?)');
  db.transaction(() => { chunk.forEach(c => stmtCC.run(campanaId, c.id)); })();
  res.json({ ok: true, id: campanaId, total: chunk.length });
});

app.delete('/api/email/campanas/:id', auth, (req, res) => {
  db.prepare('DELETE FROM email_campana_contactos WHERE campana_id = ?').run(req.params.id);
  db.prepare('DELETE FROM email_campanas WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/email/campanas/:id/contactos', auth, (req, res) => {
  res.json(db.prepare(`
    SELECT cc.id, cc.status, cc.enviado_at, cc.error_msg, c.nombre, c.email
    FROM email_campana_contactos cc JOIN email_contacts c ON cc.contact_id = c.id
    WHERE cc.campana_id = ? ORDER BY cc.id
  `).all(req.params.id));
});

// ─── EMAIL: ENVÍO ─────────────────────────────────────────────────────────────
let activeEmailSend = null;

app.post('/api/email/campanas/:id/send', auth, async (req, res) => {
  if (!emailTransporter) return res.status(400).json({ error: 'Gmail no configurado. Configuralo en la sección Email → Configuración.' });
  if (activeEmailSend) return res.status(400).json({ error: 'Ya hay un envío de email en curso' });
  const campana = db.prepare('SELECT * FROM email_campanas WHERE id = ?').get(req.params.id);
  if (!campana) return res.status(404).json({ error: 'Campaña no encontrada' });
  const pendientes = db.prepare(`
    SELECT cc.id as cc_id, c.nombre, c.email, c.id as contact_id
    FROM email_campana_contactos cc JOIN email_contacts c ON cc.contact_id = c.id
    WHERE cc.campana_id = ? AND cc.status = 'pendiente'
  `).all(campana.id);
  if (!pendientes.length) return res.status(400).json({ error: 'No hay pendientes en esta campaña' });
  db.prepare("UPDATE email_campanas SET status = 'en-curso' WHERE id = ?").run(campana.id);
  res.json({ ok: true, total: pendientes.length, msg: 'Envío de emails iniciado en background' });

  activeEmailSend = { campanaId: campana.id, total: pendientes.length, current: 0, stop: false };

  const buildHtml = (html, c) => html
    .replace(/{nombre}/g, c.nombre)
    .replace(/{email}/g, c.email);

  for (const c of pendientes) {
    if (activeEmailSend.stop) break;
    try {
      await emailTransporter.sendMail({
        from: `"${campana.from_name}" <${emailConfig.user}>`,
        replyTo: campana.reply_to || emailConfig.user,
        to: `"${c.nombre}" <${c.email}>`,
        subject: campana.asunto.replace(/{nombre}/g, c.nombre),
        html: buildHtml(campana.cuerpo_html, c)
      });
      db.prepare("UPDATE email_campana_contactos SET status='enviado', enviado_at=datetime('now') WHERE id=?").run(c.cc_id);
      db.prepare("UPDATE email_contacts SET status='enviado' WHERE id=?").run(c.contact_id);
      db.prepare("UPDATE email_campanas SET enviados=enviados+1 WHERE id=?").run(campana.id);
      db.prepare("INSERT INTO email_historial (campana_id, contact_id, email, nombre, status) VALUES (?,?,?,?,?)").run(campana.id, c.contact_id, c.email, c.nombre, 'enviado');
      activeEmailSend.current++;
    } catch(err) {
      const msg = err.message || 'Error';
      db.prepare("UPDATE email_campana_contactos SET status='fallido', error_msg=? WHERE id=?").run(msg, c.cc_id);
      db.prepare("UPDATE email_campanas SET fallidos=fallidos+1 WHERE id=?").run(campana.id);
      db.prepare("INSERT INTO email_historial (campana_id, contact_id, email, nombre, status, error_msg) VALUES (?,?,?,?,?,?)").run(campana.id, c.contact_id, c.email, c.nombre, 'fallido', msg);
    }
    if (activeEmailSend.stop) break;
    await new Promise(r => setTimeout(r, campana.delay_segundos * 1000));
  }
  db.prepare("UPDATE email_campanas SET status = CASE WHEN fallidos = 0 THEN 'completo' ELSE 'completo-con-errores' END WHERE id = ?").run(campana.id);
  activeEmailSend = null;
  console.log(`[EMAIL] Campaña ${campana.id} finalizada`);
});

app.post('/api/email/campanas/stop', auth, (req, res) => {
  if (activeEmailSend) { activeEmailSend.stop = true; res.json({ ok: true, msg: 'Deteniendo envío de emails...' }); }
  else res.json({ ok: false, msg: 'No hay envío activo' });
});

app.get('/api/email/send-status', auth, (req, res) => {
  res.json(activeEmailSend || { active: false });
});

// ─── EMAIL: HISTORIAL ─────────────────────────────────────────────────────────
app.get('/api/email/historial', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM email_historial ORDER BY id DESC LIMIT 500').all());
});

app.delete('/api/email/historial', auth, (req, res) => {
  db.prepare('DELETE FROM email_historial').run();
  res.json({ ok: true });
});

// ─── STATS (actualizado) ──────────────────────────────────────────────────────
app.get('/api/stats', auth, (req, res) => {
  res.json({
    total_contacts: db.prepare('SELECT COUNT(*) as c FROM contacts').get().c,
    pendientes: db.prepare("SELECT COUNT(*) as c FROM contacts WHERE status='pendiente'").get().c,
    enviados: db.prepare("SELECT COUNT(*) as c FROM contacts WHERE status='enviado'").get().c,
    total_tandas: db.prepare('SELECT COUNT(*) as c FROM tandas').get().c,
    hoy: db.prepare("SELECT COUNT(*) as c FROM historial WHERE date(sent_at)=date('now')").get().c,
    wp_status: wpStatus,
    email_contacts: db.prepare('SELECT COUNT(*) as c FROM email_contacts').get().c,
    email_pendientes: db.prepare("SELECT COUNT(*) as c FROM email_contacts WHERE status='pendiente'").get().c,
    email_enviados: db.prepare("SELECT COUNT(*) as c FROM email_contacts WHERE status='enviado'").get().c,
    email_hoy: db.prepare("SELECT COUNT(*) as c FROM email_historial WHERE date(sent_at)=date('now')").get().c,
    email_config: !!emailTransporter
  });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[SERVER] Tutu WApp Sender corriendo en puerto ${PORT}`);
  console.log(`[SERVER] Panel: http://localhost:${PORT}`);
  console.log(`[SERVER] Token admin: ${ADMIN_TOKEN}`);
  // Auto-intentar reconectar si hay sesión guardada
  if (fs.existsSync(`./tokens/${SESSION_NAME}`)) {
    console.log('[WPP] Sesión guardada encontrada, reconectando...');
    setTimeout(initWPP, 2000);
  }
});
