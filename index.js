const express = require('express');
const multer = require('multer');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

initializeApp();
const db = getFirestore();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Cache documenti con TTL
const documentCache = new Map();
const CACHE_TTL = 3_600_000; // 1 ora

// Rate limiting in memoria
const userRequestLog = new Map();

// Middleware validazione Firebase
async function validateFirebaseToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, error: 'Token mancante' });
    }
    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await getAuth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Errore validazione token:', error);
    return res.status(401).json({ ok: false, error: 'Token non valido' });
  }
}

// Rate limiting (3 req/10min, 50 req/giorno per utente)
async function rateLimitMiddleware(req, res, next) {
  const userId = req.user.uid;
  const now = Date.now();

  if (!userRequestLog.has(userId)) {
    userRequestLog.set(userId, []);
  }

  const userRequests = userRequestLog.get(userId);
  const recentRequests = userRequests.filter(t => now - t < 600_000);    // 10 min
  const requestsLast24h = userRequests.filter(t => now - t < 86_400_000); // 24h

  if (recentRequests.length >= 3) {
    return res.status(429).json({
      ok: false,
      error: 'Attendere qualche minuto prima di analizzare un altro documento',
      retry_after: 60,
    });
  }

  if (requestsLast24h.length >= 50) {
    return res.status(429).json({
      ok: false,
      error: 'Limite giornaliero raggiunto. Riprova domani.',
      retry_after: 3600,
    });
  }

  recentRequests.push(now);
  userRequestLog.set(userId, recentRequests);
  next();
}

// Hash documento per cache
function generateDocumentHash(buffer, employeeName) {
  return crypto
    .createHash('sha256')
    .update(buffer)
    .update(employeeName.toLowerCase())
    .digest('hex');
}

// ENDPOINT PRINCIPALE
app.post('/', validateFirebaseToken, rateLimitMiddleware, upload.single('document'), async (req, res) => {
  try {
    const { employeeName, fileName } = req.body;
    const file = req.file;
    const userId = req.user.uid;

    if (!file) {
      return res.status(400).json({ ok: false, error: 'Documento mancante' });
    }

    if (!employeeName || employeeName.trim().length === 0) {
      return res.status(400).json({ ok: false, error: 'Nome dipendente mancante' });
    }

    console.log(`[${userId}] Processing: ${employeeName} (${fileName})`);

    // Cache check
    const docHash = generateDocumentHash(file.buffer, employeeName);
    const cached = documentCache.get(docHash);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log('  ✓ Cache HIT');
      return res.json({ ok: true, parsed: cached.data, cached: true });
    }

    // Determina mimeType
    let mimeType = file.mimetype;
    if (!mimeType || mimeType === 'application/octet-stream') {
      const ext = (fileName || '').toLowerCase();
      if (ext.endsWith('.pdf')) mimeType = 'application/pdf';
      else if (ext.match(/\.(jpg|jpeg)$/)) mimeType = 'image/jpeg';
      else if (ext.endsWith('.png')) mimeType = 'image/png';
      else return res.status(400).json({ ok: false, error: 'Formato non supportato' });
    }

    const supportedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    if (!supportedTypes.includes(mimeType)) {
      return res.status(400).json({ ok: false, error: `Formato non supportato: ${mimeType}` });
    }

    const base64Data = file.buffer.toString('base64');
    const prompt = createSuperPrompt(employeeName);

    // FIX: modello corretto (era 'gemini-3-flash-preview' che non esiste)
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      generationConfig: {
        temperature: 0.0,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    });

    const parts = [
      { text: prompt },
      { inlineData: { mimeType, data: base64Data } },
    ];

    // Multi-retry con backoff esponenziale
    console.log('  ⏳ Calling Gemini API...');
    let responseText;
    const maxAttempts = 3;

    for (let attempts = 1; attempts <= maxAttempts; attempts++) {
      try {
        const result = await model.generateContent(parts);
        responseText = result.response.text();
        console.log(`  ✓ Gemini responded (attempt ${attempts})`);
        break;
      } catch (error) {
        console.error(`  ✗ Attempt ${attempts} failed:`, error.message);
        if (attempts >= maxAttempts) {
          throw new Error(`Gemini API failed after ${maxAttempts} attempts: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempts - 1) * 1000));
      }
    }

    const parsedData = parseGeminiResponse(responseText);

    if (!parsedData.employee_name || parsedData.employee_name.trim() === '') {
      console.error('  ✗ Employee not found');
      return res.status(400).json({
        ok: false,
        error: 'Dipendente non trovato nel documento. Verifica che il nome sia corretto.',
      });
    }

    const hasTurni =
      parsedData.schedule.length > 0 ||
      parsedData.daily_codes.length > 0 ||
      parsedData.exceptions.length > 0 ||
      parsedData.modifications.length > 0;

    if (!hasTurni) {
      console.error('  ✗ No shifts found');
      return res.status(400).json({
        ok: false,
        error: 'Nessun turno trovato per questo dipendente.',
      });
    }

    // FIX: ritorna 200 con needs_review invece di 400 per bassa confidence
    if (parsedData.confidence < 0.5) {
      console.warn(`  ⚠ Low confidence: ${parsedData.confidence}`);
      return res.json({
        ok: true,
        parsed: parsedData,
        needs_review: true,
        warning: 'Confidence bassa: verifica manualmente i turni estratti.',
      });
    }

    console.log(`  ✓ Extracted ${parsedData.schedule.length} shifts, ${parsedData.modifications.length} modifications`);

    try {
      await saveShiftPreferences(userId, parsedData.detected_shift_codes);
      console.log('  ✓ Saved shift preferences to Firestore');
    } catch (prefError) {
      console.error('  ⚠ Failed to save preferences:', prefError.message);
    }

    documentCache.set(docHash, { data: parsedData, timestamp: Date.now() });
    if (documentCache.size > 100) {
      documentCache.delete(documentCache.keys().next().value);
    }

    return res.json({ ok: true, parsed: parsedData, schema_version: '3.0' });

  } catch (error) {
    console.error('  ✗ ERROR:', error.message);
    if (error.message && error.message.includes('quota')) {
      return res.status(503).json({
        ok: false,
        error: 'Servizio temporaneamente non disponibile. Riprova tra qualche minuto.',
      });
    }
    return res.status(500).json({ ok: false, error: `Errore elaborazione: ${error.message}` });
  }
});

// Salva turni estratti come preferenze su Firestore
async function saveShiftPreferences(userId, detectedShiftCodes) {
  if (!detectedShiftCodes || detectedShiftCodes.length === 0) return;

  const colorPalette = [
    0xFF90CAF9, // Blu chiaro
    0xFFF06292, // Rosa
    0xFF4DB6AC, // Verde acqua
    0xFFFFB74D, // Arancione
    0xFFA1887F, // Marrone
    0xFFCE93D8, // Viola chiaro
    0xFF81C784, // Verde
    0xFFFFD54F, // Giallo
    0xFFFF8A65, // Rosso arancio
    0xFF64B5F6, // Blu
  ];

  // FIX: variabile userDocRef coerente (era userPrefsRef + userDocRef non dichiarata)
  const userDocRef = db.collection('users').doc(userId);
  const userDoc = await userDocRef.get();

  let currentTurniConfig = {};
  if (userDoc.exists) {
    currentTurniConfig = userDoc.data().turniConfig || {};
  }

  let colorIndex = 0;
  const updatedConfig = { ...currentTurniConfig };

  for (const code of detectedShiftCodes) {
    if (!updatedConfig[code]) {
      updatedConfig[code] = {
        colorInt: colorPalette[colorIndex % colorPalette.length],
        orarioInizio: '',
        orarioFine: '',
        includi: true,
      };
      colorIndex++;
    }
  }

  await userDocRef.set(
    { turniConfig: updatedConfig, lastImport: new Date().toISOString() },
    { merge: true }
  );
}

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'shift-pdf-processor',
    ai: 'gemini-2.0-flash-exp',
    version: '3.1-patched',
    features: ['multi-retry', 'cache', 'rate-limit', 'firestore-prefs', 'schema-versioning'],
  });
});

// Prompt estrazione turni
function createSuperPrompt(employeeName) {
  return `Sei un esperto AI specializzato nell'estrazione PERFETTA di dati da documenti di turni lavorativi.

🎯 OBIETTIVO: Estrarre CON PRECISIONE ASSOLUTA tutti i dati del dipendente "${employeeName}".

📋 ANALISI STEP-BY-STEP:

STEP 1 - LOCALIZZA IL DIPENDENTE:
- Cerca "${employeeName}" in TUTTO il documento
- Varianti possibili: MAIUSCOLO, minuscolo, Cognome Nome, Nome Cognome, solo Cognome
- Il nome appare tipicamente nella prima colonna di ogni riga
- Trova la riga che contiene ESATTAMENTE questo dipendente

STEP 2 - IDENTIFICA LA STRUTTURA DEL DOCUMENTO:
- Tipo A (Tabella Excel/Grid): Date in colonne (01, 02, 03...), turni sotto ogni data
- Tipo B (Lista): Ogni riga è un giorno con data + turno
- Tipo C (Calendario): Layout grafico mensile
- Identifica quale tipo è questo documento

STEP 3 - ESTRAI I TURNI BASE:
- Leggi la riga del dipendente da sinistra a destra
- Ogni cella/campo contiene un codice turno per quel giorno
- Codici comuni (multilingua):
  IT: M, M1, M2, M3 (mattina), P, P1, P2 (pomeriggio), N (notte), RI (riposo), RC (riposo compensativo), G (giornaliero), F (ferie), A (assenza)
  EN: M (morning), A/PM (afternoon), N (night), RD (rest day), AL (annual leave), S (sick)
  DE: F (Frühschicht), S (Spätschicht), N (Nachtschicht), FR (Frei), U (Urlaub), K (Krank)
  ES: M (mañana), T (tarde), N (noche), L (libre), V (vacaciones), B (baja)
- Crea una sequenza ordinata giorno per giorno

STEP 4 - TROVA LE MODIFICHE:
- Cerca righe con label "modifica turno", "modifiche", "variazioni", "changes", ecc.
- Le modifiche SOVRASCRIVONO il turno base per quella data
- Annota per ogni modifica: data, turno originale, turno nuovo, motivo

STEP 5 - IDENTIFICA ECCEZIONI:
- Ferie, malattia, permessi, assenze — in qualsiasi lingua

STEP 6 - ESTRAI DATE E PERIODO:
- Trova il mese/anno nel titolo o header
- Converti tutte le date in formato YYYY-MM-DD

STEP 7 - CREA IL JSON OUTPUT

⚙️ REGOLE CRITICHE:
1. NON inventare dati. NON confondere dipendenti.
2. Se non trovi "${employeeName}" → employee_name = "", confidence = 0.0
3. La modifica ha PRIORITÀ sul turno base
4. CONFIDENCE: 1.0=sicuro, 0.8-0.9=quasi, 0.5-0.7=incerto, 0.0=non trovato

🎯 OUTPUT JSON:

{
  "employee_name": "NOME ESATTO DAL DOCUMENTO",
  "period_type": "mensile",
  "start_date": "2026-02-01",
  "end_date": "2026-02-28",
  "schedule_kind": "ciclico",
  "day_count": 28,
  "daily_codes": ["M", "P", "N", "RI"],
  "schedule": [
    { "date": "2026-02-01", "day_index": 0, "code": "M", "start_time": null, "end_time": null, "note": null }
  ],
  "exceptions": [
    { "date": "2026-02-10", "day_index": 9, "code": "F", "start_time": null, "end_time": null, "note": "ferie" }
  ],
  "modifications": [
    { "date": "2026-02-05", "day_index": 4, "code": "P", "original_code": "M", "note": "cambio turno" }
  ],
  "detected_shift_codes": ["M", "M1", "P", "N", "RI", "RC", "G"],
  "confidence": 0.95,
  "needs_review": false,
  "warnings": []
}

✅ INIZIA L'ANALISI ADESSO. Sii METICOLOSO e PRECISO.`;
}

// Parser risposta Gemini con validazione entries
function parseGeminiResponse(text) {
  try {
    let cleaned = text.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();

    const parsed = JSON.parse(cleaned);

    // FIX: validazione rigorosa delle entries nested per evitare crash in app
    const validateEntry = e => e && e.date && e.code;
    const mapEntry = e => ({
      date: String(e.date),
      day_index: Number(e.day_index ?? 0),
      code: String(e.code).trim(),
      start_time: e.start_time || null,
      end_time: e.end_time || null,
      note: e.note || null,
    });
    const mapModification = e => ({
      date: String(e.date),
      day_index: Number(e.day_index ?? 0),
      code: String(e.code).trim(),
      original_code: e.original_code ? String(e.original_code).trim() : null,
      note: e.note || null,
    });

    return {
      employee_name: (parsed.employee_name || '').trim(),
      period_type: parsed.period_type || 'unknown',
      start_date: parsed.start_date || null,
      end_date: parsed.end_date || null,
      schedule_kind: parsed.schedule_kind || 'unknown',
      day_count: typeof parsed.day_count === 'number' ? parsed.day_count : null,
      daily_codes: Array.isArray(parsed.daily_codes)
        ? parsed.daily_codes.filter(c => c && String(c).trim())
        : [],
      schedule: Array.isArray(parsed.schedule)
        ? parsed.schedule.filter(validateEntry).map(mapEntry)
        : [],
      exceptions: Array.isArray(parsed.exceptions)
        ? parsed.exceptions.filter(validateEntry).map(mapEntry)
        : [],
      modifications: Array.isArray(parsed.modifications)
        ? parsed.modifications.filter(validateEntry).map(mapModification)
        : [],
      detected_shift_codes: Array.isArray(parsed.detected_shift_codes)
        ? [...new Set(parsed.detected_shift_codes)].filter(c => c && String(c).trim())
        : [],
      confidence: typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.0,
      needs_review: parsed.needs_review === true,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    };
  } catch (error) {
    console.error('Parse error:', error.message);
    return {
      employee_name: '',
      period_type: 'unknown',
      start_date: null,
      end_date: null,
      schedule_kind: 'unknown',
      day_count: null,
      daily_codes: [],
      schedule: [],
      exceptions: [],
      modifications: [],
      detected_shift_codes: [],
      confidence: 0.0,
      needs_review: true,
      warnings: ['Errore parsing risposta AI. Riprova.'],
    };
  }
}

// Cleanup periodico cache documenti e rate limit log
setInterval(() => {
  const now = Date.now();

  // Pulisci cache documenti scaduti
  let cleanedCache = 0;
  for (const [key, value] of documentCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      documentCache.delete(key);
      cleanedCache++;
    }
  }

  // FIX: pulisci userRequestLog — rimuovi utenti con tutti i timestamp > 24h
  let cleanedUsers = 0;
  for (const [uid, timestamps] of userRequestLog.entries()) {
    const recent = timestamps.filter(t => now - t < 86_400_000);
    if (recent.length === 0) {
      userRequestLog.delete(uid);
      cleanedUsers++;
    } else {
      userRequestLog.set(uid, recent);
    }
  }

  if (cleanedCache > 0 || cleanedUsers > 0) {
    console.log(
      `🧹 Cleanup: cache -${cleanedCache} (${documentCache.size} left), rate-limit -${cleanedUsers} users`
    );
  }
}, 3_600_000); // ogni ora

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🤖 AI: gemini-2.0-flash-exp`);
  console.log(`⏱️  Rate limit: 3 req/10min, 50 req/day per user`);
  console.log(`💾 Cache: ${CACHE_TTL / 60_000} minutes TTL`);
  console.log(`✅ Ready to process shifts!`);
});
