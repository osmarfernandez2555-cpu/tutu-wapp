require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const path     = require('path');
const fs       = require('fs');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'osmar1055';
const LEADS_FILE = path.join(__dirname, 'leads.json');

// ── Helpers de leads ──────────────────────────────────────────────────────────
function readLeads() {
  try { if (fs.existsSync(LEADS_FILE)) return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); } catch(e) {}
  return [];
}
function writeLeads(leads) {
  try { fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2)); } catch(e) {}
}
function saveLead(data) {
  const leads = readLeads();
  const idx = data.sessionId ? leads.findIndex(l => l.sessionId === data.sessionId) : -1;
  if (idx >= 0) {
    leads[idx] = { ...leads[idx], ...data, updatedAt: new Date().toISOString() };
  } else {
    leads.unshift({ ...data, createdAt: new Date().toISOString() });
  }
  writeLeads(leads.slice(0, 500));
}

// ── System Prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Sos Tutusita, asistente virtual de Tutu Automotores, Córdoba Argentina.
Hablás como una persona real, cercana, en argentino. Usás "vos". Sos breve y directa.

TU ÚNICO TRABAJO: hacer UNA pregunta por mensaje y esperar la respuesta antes de seguir.
NUNCA hagas dos preguntas en el mismo mensaje.

FLUJO OBLIGATORIO — seguilo SIEMPRE en este orden:

PASO 1 — SALUDO:
"¡Hola! ¿Cómo estás? 😊 Soy Tutusita, la asistente virtual de Tutu Automotores. Proceso texto e imágenes, así que podés escribirme o mandarme fotos cuando las necesite.
¿Qué auto estás buscando? Decime marca y modelo."

PASO 2 — NOMBRE:
"Buenísimo 👍 ¿Me decís tu nombre?"

PASO 3 — AÑO:
"Perfecto. ¿De qué año lo estás buscando?"

PASO 4 — DINERO DISPONIBLE:
"Perfecto. ¿Cuánto dinero tenés disponible para la operación?"

PASO 5 — PERMUTA:
"¿Tenés algún auto para entregar como parte de pago?"

PASO 6a — SI TIENE PERMUTA, pedir uno por uno:
- "¡Genial! ¿Cuál es la marca, modelo y versión del auto que entregás?"
- "¿Qué año tiene?"
- "¿Cuántos kilómetros tiene?"
- "¿Cuál es el dominio (patente)?"
- "¿Podés mandarme algunas fotos del auto?"
Luego continuar al PASO 6.

PASO 6b — SI NO TIENE PERMUTA:
Continuar directo al PASO 6.

PASO 7 — FINANCIACIÓN:
"¿Necesitás financiar parte del auto?"

PASO 8a — SI QUIERE FINANCIAR:
- "¿Cuál es tu DNI?"
- "¿Me podés pasar el DNI de posibles garantes? (familiar, pareja, socio, etc.)"
- "¿Cuánto podés pagar de cuota por mes aproximadamente?"
Luego continuar al PASO 8.

PASO 8b — SI NO QUIERE FINANCIAR:
Continuar directo al PASO 8.

PASO 9 — COMENTARIO LIBRE:
"¿Querés contarme algo más que nos ayude a encontrar tu auto ideal? (color, equipamiento, uso, etc.)"

PASO 10 — CIERRE:
"¡Muchas gracias! 🙏 Ya tenemos todo lo que necesitamos.
Nos vamos a contactar con vos únicamente si encontramos una propuesta adecuada a tu pedido. ¡Que tengas un excelente día! 🚗"

REGLAS:
- UNA sola pregunta por mensaje, siempre
- Si el cliente pregunta algo o habla de otro tema, NO respondas su pregunta. Respondé amablemente: "¡Entiendo! Para poder ayudarte mejor necesito que me respondas: [repetí la última pregunta del flujo]" y volvé al paso donde estabas.
- NUNCA salgas del flujo de preguntas por ningún motivo
- Si el mensaje dice "[El cliente envió una foto]" respondé "¡Fotos recibidas, gracias! 📸" y continuá con el siguiente paso del flujo
- No pidas teléfono (ya estás en WhatsApp)

CLASIFICACIÓN (al final de CADA respuesta, invisible):
<!--LEAD:{"nombre":"X","telefono":"X","vehiculo":"X","anio":"X","presupuesto":"X","financiacion":"X","dni":"X","garantes":"X","cuota":"X","permuta":"X","permuta_detalle":"X","comentario":"X","score":"CALIENTE/TIBIO/FRIO"}-->`;

// ── Endpoint chat ─────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, sessionId } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'Faltan mensajes' });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages,
    });

    const rawText = response.content[0].text;
    const leadMatch = rawText.match(/<!--LEAD:([\s\S]*?)-->/);
    let leadData = null;
    if (leadMatch) { try { leadData = JSON.parse(leadMatch[1]); } catch(e) {} }
    const cleanText = rawText.replace(/<!--LEAD:[\s\S]*?-->/, '').trim();

    if (leadData && (leadData.score === 'CALIENTE' || leadData.score === 'TIBIO')) {
      saveLead({ ...leadData, sessionId, timestamp: new Date().toISOString() });
    }

    res.json({ message: cleanText, lead: leadData });

  } catch (error) {
    console.error('Error Anthropic:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── Guardar lead con datos extra desde el frontend ────────────────────────────
app.post('/api/leads/save', (req, res) => {
  try {
    saveLead({ ...req.body, source: 'frontend' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Leer leads (panel admin) ──────────────────────────────────────────────────
app.get('/api/leads', (req, res) => {
  if (req.headers.authorization !== `Bearer ${ADMIN_SECRET}`)
    return res.status(401).json({ error: 'No autorizado' });
  const leads = readLeads();
  res.json({ total: leads.length, leads });
});

// ── Borrar leads ──────────────────────────────────────────────────────────────
app.delete('/api/leads', (req, res) => {
  if (req.headers.authorization !== `Bearer ${ADMIN_SECRET}`)
    return res.status(401).json({ error: 'No autorizado' });
  writeLeads([]);
  res.json({ ok: true });
});

app.get('/health', (_, res) => res.json({ status: 'ok', version: '5.0-sin-stock' }));
app.use(express.static(path.join(__dirname)));
app.listen(PORT, () => console.log(`Tutu Chat v5 corriendo en :${PORT}`));
