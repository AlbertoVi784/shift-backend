const express = require('express');
const multer = require('multer');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Inizializza Firebase Admin
initializeApp();
const db = getFirestore();

// Inizializza Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Cache documenti con TTL
const documentCache = new Map();
const CACHE_TTL = 3600000; // 1 ora

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

// Rate limiting intelligente e "invisibile"
async function rateLimitMiddleware(req, res, next) {
  const userId = req.user.uid;
  const now = Date.now();
  
  if (!userRequestLog.has(userId)) {
    userRequestLog.set(userId, []);
  }
  
  const userRequests = userRequestLog.get(userId);
  const recentRequests = userRequests.filter(t => now - t < 600000); // 10 min
  const requestsLast24h = userRequests.filter(t => now - t < 86400000).length;
  
  // Limiti soft - l'utente non si innervosisce
  if (recentRequests.length >= 3) {
    return res.status(429).json({ 
      ok: false, 
      error: 'Attendere qualche minuto prima di analizzare un altro documento',
      retry_after: 60
    });
  }
  
  if (requestsLast24h >= 50) {
    return res.status(429).json({ 
      ok: false, 
      error: 'Limite giornaliero raggiunto. Riprova domani.',
      retry_after: 3600
    });
  }
  
  recentRequests.push(now);
  userRequestLog.set(userId, recentRequests);
  next();
}

// Hash documento per cache
function generateDocumentHash(buffer, employeeName) {
  const hash = crypto.createHash('sha256');
  hash.update(buffer);
  hash.update(employeeName.toLowerCase());
  return hash.digest('hex');
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
    
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      console.log('  ✓ Cache HIT');
      return res.json({
        ok: true,
        parsed: cached.data,
        cached: true
      });
    }

    // Determina mimeType
    let mimeType = file.mimetype;
    if (!mimeType || mimeType === 'application/octet-stream') {
      const ext = fileName.toLowerCase();
      if (ext.endsWith('.pdf')) mimeType = 'application/pdf';
      else if (ext.match(/\.(jpg|jpeg)$/)) mimeType = 'image/jpeg';
      else if (ext.endsWith('.png')) mimeType = 'image/png';
      else return res.status(400).json({ ok: false, error: 'Formato non supportato' });
    }

    const supportedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    if (!supportedTypes.includes(mimeType)) {
      return res.status(400).json({ ok: false, error: `Formato non supportato: ${mimeType}` });
    }

    // Converti in base64
    const base64Data = file.buffer.toString('base64');

    // Prompt SUPER-POTENTE per analisi perfetta
    const prompt = createSuperPrompt(employeeName);

    // Gemini 2.0 Flash Experimental (il più potente gratis)
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.0-flash-exp',
      generationConfig: {
        temperature: 0.0, // Massima precisione
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    });

    const parts = [
      { text: prompt },
      { inlineData: { mimeType: mimeType, data: base64Data } }
    ];

    // Multi-retry intelligente con backoff
    console.log('  ⏳ Calling Gemini API...');
    let responseText;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const result = await model.generateContent(parts);
        const response = await result.response;
        responseText = response.text();
        console.log(`  ✓ Gemini responded (attempt ${attempts + 1})`);
        break;
      } catch (error) {
        attempts++;
        console.error(`  ✗ Attempt ${attempts} failed:`, error.message);
        
        if (attempts >= maxAttempts) {
          throw new Error(`Gemini API failed after ${maxAttempts} attempts: ${error.message}`);
        }
        
        // Backoff esponenziale: 1s, 2s, 4s
        const backoff = Math.pow(2, attempts - 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }

    // Parse response
    const parsedData = parseGeminiResponse(responseText);

    // Validazione rigorosa
    if (!parsedData.employee_name || parsedData.employee_name.trim() === '') {
      console.error('  ✗ Employee not found');
      return res.status(400).json({
        ok: false,
        error: 'Dipendente non trovato nel documento. Verifica che il nome sia corretto.',
      });
    }

    const hasTurni = parsedData.schedule.length > 0 || 
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

    console.log(`  ✓ Extracted ${parsedData.schedule.length} shifts, ${parsedData.modifications.length} modifications`);

    // SALVA I TURNI COME PREFERENZE SU FIRESTORE
    try {
      await saveShiftPreferences(userId, parsedData.detected_shift_codes);
      console.log(`  ✓ Saved shift preferences to Firestore`);
    } catch (prefError) {
      console.error('  ⚠ Failed to save preferences:', prefError.message);
      // Non blocchiamo l'operazione per errori di preferenze
    }

    // Cache il risultato
    documentCache.set(docHash, {
      data: parsedData,
      timestamp: Date.now()
    });

    // Limita dimensione cache
    if (documentCache.size > 100) {
      const oldestKey = documentCache.keys().next().value;
      documentCache.delete(oldestKey);
    }

    return res.json({
      ok: true,
      parsed: parsedData,
    });

  } catch (error) {
    console.error('  ✗ ERROR:', error.message);
    
    if (error.message && error.message.includes('quota')) {
      return res.status(503).json({
        ok: false,
        error: 'Servizio temporaneamente non disponibile. Riprova tra qualche minuto.',
      });
    }
    
    return res.status(500).json({
      ok: false,
      error: `Errore elaborazione: ${error.message}`,
    });
  }
});

// SALVA TURNI ESTRATTI COME PREFERENZE
async function saveShiftPreferences(userId, detectedShiftCodes) {
  if (!detectedShiftCodes || detectedShiftCodes.length === 0) return;

  // Colori predefiniti per nuovi turni
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

  const userPrefsRef = db.collection('user_preferences').doc(userId);
  const userDoc = await userPrefsRef.get();
  
  let currentColors = {};
  let currentInclusion = {};
  
  if (userDoc.exists) {
    const data = userDoc.data();
    currentColors = data.colori_turni || {};
    currentInclusion = data.includi_nel_riepilogo || {};
  }

  // Aggiungi solo i turni nuovi (non sovrascrivere quelli esistenti)
  let colorIndex = 0;
  const updatedColors = { ...currentColors };
  const updatedInclusion = { ...currentInclusion };

  for (const code of detectedShiftCodes) {
    if (!updatedColors[code]) {
      updatedColors[code] = colorPalette[colorIndex % colorPalette.length];
      updatedInclusion[code] = true;
      colorIndex++;
    }
  }

  // Salva su Firestore
  await userPrefsRef.set({
    colori_turni: updatedColors,
    includi_nel_riepilogo: updatedInclusion,
    last_import: new Date().toISOString(),
    imported_shift_codes: detectedShiftCodes
  }, { merge: true });
}

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'shift-pdf-processor', 
    ai: 'gemini-2.0-flash-exp',
    version: '3.0-ultimate',
    features: ['multi-retry', 'cache', 'rate-limit', 'firestore-prefs']
  });
});

// PROMPT SUPER-POTENTE
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
- Codici comuni: M, M1, M2, M3 (mattina), P, P1, P2 (pomeriggio), N (notte), RI (riposo), RC (riposo compensativo), G (giornaliero), F (ferie), A (assenza)
- Crea una sequenza ordinata giorno per giorno

STEP 4 - TROVA LE MODIFICHE:
- Cerca righe con label "modifica turno", "modifiche", "variazioni", "changes", ecc.
- Le modifiche SOVRASCRIVONO il turno base per quella data
- Cerca anche celle evidenziate, simboli *, note a piè di pagina
- Annota per ogni modifica: data, turno originale, turno nuovo, motivo

STEP 5 - IDENTIFICA ECCEZIONI:
- Ferie (F, FER, FERIE, VAC, VACATION)
- Malattia (M, MAL, SICK, ILL)
- Permessi (P, PERM, LEAVE)
- Assenze (A, ASS, ABS, ABSENT)

STEP 6 - ESTRAI DATE E PERIODO:
- Trova il mese/anno nel titolo o header
- Converti tutte le date in formato YYYY-MM-DD
- Determina data_inizio e data_fine del periodo

STEP 7 - CREA IL JSON OUTPUT

⚙️ REGOLE CRITICHE:

1. PRECISIONE ASSOLUTA:
   - NON inventare dati
   - NON confondere dipendenti
   - Se non trovi "${employeeName}" → employee_name = "", confidence = 0.0

2. GESTIONE MODIFICHE:
   - Modifica = turno che SOSTITUISCE quello pianificato
   - Va in "modifications" con original_code e nuovo code
   - La modifica ha PRIORITÀ sul turno base

3. PARSING DATE INTELLIGENTE:
   - "01/02/2026" → "2026-02-01" (giorno 1, mese 2)
   - "FEB 15 2026" → "2026-02-15"
   - "Lunedì 3" → calcola la data dal mese/anno del documento

4. MULTI-LINGUA:
   - Riconosci turni in IT, EN, ES, FR, DE, ecc.
   - Mattina = Morning = Mañana = Matin = Morgen
   - Adatta i codici alla lingua del documento

5. CONFIDENCE SCORE:
   - 1.0 = Sicuro al 100%, tutti i dati chiari
   - 0.8-0.9 = Quasi sicuro, piccole ambiguità
   - 0.5-0.7 = Incerto, dati parziali
   - 0.0 = Dipendente non trovato

🎯 OUTPUT JSON (PRECISO):

{
  "employee_name": "NOME ESATTO DAL DOCUMENTO",
  "period_type": "mensile",
  "start_date": "2026-02-01",
  "end_date": "2026-02-28",
  "schedule_kind": "ciclico",
  "day_count": 28,
  "daily_codes": ["M", "P", "N", "RI", ...],
  "schedule": [
    {
      "date": "2026-02-01",
      "day_index": 0,
      "code": "M",
      "start_time": null,
      "end_time": null,
      "note": null
    }
  ],
  "exceptions": [
    {
      "date": "2026-02-10",
      "day_index": 9,
      "code": "F",
      "start_time": null,
      "end_time": null,
      "note": "ferie"
    }
  ],
  "modifications": [
    {
      "date": "2026-02-05",
      "day_index": 4,
      "code": "P",
      "original_code": "M",
      "note": "cambio turno"
    }
  ],
  "detected_shift_codes": ["M", "M1", "P", "N", "RI", "RC", "G"],
  "confidence": 0.95,
  "needs_review": false,
  "warnings": []
}

📌 CASO DIPENDENTE NON TROVATO:
{
  "employee_name": "",
  "period_type": "unknown",
  "start_date": null,
  "end_date": null,
  "schedule_kind": "unknown",
  "day_count": null,
  "daily_codes": [],
  "schedule": [],
  "exceptions": [],
  "modifications": [],
  "detected_shift_codes": [],
  "confidence": 0.0,
  "needs_review": true,
  "warnings": ["Dipendente '${employeeName}' non trovato nel documento"]
}

✅ INIZIA L'ANALISI ADESSO. Sii METICOLOSO e PRECISO.`;
}

// Parser intelligente
function parseGeminiResponse(text) {
  try {
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    cleaned = cleaned.replace(/^```\s*/i, '').replace(/```\s*$/, '');
    cleaned = cleaned.trim();
    
    const parsed = JSON.parse(cleaned);
    
    // Normalizzazione e validazione rigorosa
    return {
      employee_name: (parsed.employee_name || '').trim(),
      period_type: parsed.period_type || 'unknown',
      start_date: parsed.start_date || null,
      end_date: parsed.end_date || null,
      schedule_kind: parsed.schedule_kind || 'unknown',
      day_count: typeof parsed.day_count === 'number' ? parsed.day_count : null,
      daily_codes: Array.isArray(parsed.daily_codes) ? parsed.daily_codes.filter(c => c && c.trim()) : [],
      schedule: Array.isArray(parsed.schedule) ? parsed.schedule : [],
      exceptions: Array.isArray(parsed.exceptions) ? parsed.exceptions : [],
      modifications: Array.isArray(parsed.modifications) ? parsed.modifications : [],
      detected_shift_codes: Array.isArray(parsed.detected_shift_codes) ? 
        [...new Set(parsed.detected_shift_codes)].filter(c => c && c.trim()) : [],
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.0,
      needs_review: parsed.needs_review === true,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
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

// Cleanup periodico
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, value] of documentCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      documentCache.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`🧹 Cache cleanup: removed ${cleaned} items, ${documentCache.size} remaining`);
  }
}, 3600000); // Ogni ora

// Server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🤖 AI: Gemini 2.0 Flash Experimental (FREE)`);
  console.log(`⏱️  Rate limit: 3 req/10min, 50 req/day per user`);
  console.log(`💾 Cache: ${CACHE_TTL / 60000} minutes TTL`);
  console.log(`🔥 Firestore: Auto-save shift preferences`);
  console.log(`✅ Ready to process shifts!`);
});
