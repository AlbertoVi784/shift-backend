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

// Inizializza Gemini API (GRATIS!)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Cache in memoria per evitare richieste duplicate
const documentCache = new Map();
const CACHE_TTL = 3600000; // 1 ora

// Rate limiting in memoria (potrebbe essere spostato su Firestore per persistenza)
const userRequestLog = new Map();

// Middleware per validare il token Firebase
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

// Middleware di rate limiting intelligente
async function rateLimitMiddleware(req, res, next) {
  const userId = req.user.uid;
  const now = Date.now();
  
  // Ottieni lo storico richieste dell'utente
  if (!userRequestLog.has(userId)) {
    userRequestLog.set(userId, []);
  }
  
  const userRequests = userRequestLog.get(userId);
  
  // Rimuovi richieste più vecchie di 10 minuti
  const recentRequests = userRequests.filter(timestamp => now - timestamp < 600000); // 10 minuti
  
  // Limiti:
  // - Max 3 richieste ogni 10 minuti (soft limit - l'utente non se ne accorge molto)
  // - Max 50 richieste al giorno (hard limit ma generoso)
  const requestsLast10Min = recentRequests.length;
  const requestsLast24h = userRequests.filter(t => now - t < 86400000).length;
  
  if (requestsLast10Min >= 3) {
    // Soft limit - messaggio gentile
    return res.status(429).json({ 
      ok: false, 
      error: 'Attendere qualche minuto prima di analizzare un altro documento',
      retry_after: 60 // suggerisce di riprovare tra 1 minuto
    });
  }
  
  if (requestsLast24h >= 50) {
    // Hard limit - ma molto generoso
    return res.status(429).json({ 
      ok: false, 
      error: 'Limite giornaliero raggiunto. Riprova domani.',
      retry_after: 3600
    });
  }
  
  // Aggiungi questa richiesta allo storico
  recentRequests.push(now);
  userRequestLog.set(userId, recentRequests);
  
  next();
}

// Genera hash del documento per cache
function generateDocumentHash(buffer, employeeName) {
  const hash = crypto.createHash('sha256');
  hash.update(buffer);
  hash.update(employeeName.toLowerCase());
  return hash.digest('hex');
}

// Endpoint principale per processare il documento
app.post('/', validateFirebaseToken, rateLimitMiddleware, upload.single('document'), async (req, res) => {
  try {
    const { employeeName, fileName } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ ok: false, error: 'Documento mancante' });
    }

    if (!employeeName || employeeName.trim().length === 0) {
      return res.status(400).json({ ok: false, error: 'Nome dipendente mancante' });
    }

    console.log(`Processing document for employee: ${employeeName}`);

    // Verifica cache
    const docHash = generateDocumentHash(file.buffer, employeeName);
    const cached = documentCache.get(docHash);
    
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      console.log('Cache HIT - returning cached result');
      return res.json({
        ok: true,
        parsed: cached.data,
        cached: true
      });
    }

    // Converti il file in base64
    const base64Data = file.buffer.toString('base64');
    
    // Determina il mimeType
    let mimeType = file.mimetype;
    if (!mimeType || mimeType === 'application/octet-stream') {
      if (fileName.toLowerCase().endsWith('.pdf')) {
        mimeType = 'application/pdf';
      } else if (fileName.toLowerCase().match(/\.(jpg|jpeg)$/)) {
        mimeType = 'image/jpeg';
      } else if (fileName.toLowerCase().endsWith('.png')) {
        mimeType = 'image/png';
      } else {
        return res.status(400).json({ ok: false, error: 'Formato file non supportato' });
      }
    }

    // Verifica che sia PDF o immagine
    const supportedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
    if (!supportedTypes.includes(mimeType)) {
      return res.status(400).json({ 
        ok: false, 
        error: `Formato non supportato: ${mimeType}. Usa PDF o immagini.` 
      });
    }

    // Crea il prompt per Gemini
    const prompt = createExtractionPrompt(employeeName);

    // Usa Gemini 1.5 Flash (GRATIS - 1500 req/giorno)
    // È veloce, economico e funziona bene con PDF
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.5-flash-lite',
      generationConfig: {
        temperature: 0.1,
        topP: 0.95,
        topK: 40,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json', // Forza risposta JSON
      },
    });

    // Prepara i contenuti per Gemini
    const parts = [
      {
        text: prompt
      },
      {
        inlineData: {
          mimeType: mimeType,
          data: base64Data
        }
      }
    ];

    // Chiama l'API di Gemini con retry
    console.log('Calling Gemini API...');
    let result, response, responseText;
    let retries = 0;
    const maxRetries = 2;

    while (retries <= maxRetries) {
      try {
        result = await model.generateContent(parts);
        response = await result.response;
        responseText = response.text();
        break; // Successo!
      } catch (error) {
        retries++;
        if (retries > maxRetries) {
          throw error;
        }
        console.log(`Retry ${retries}/${maxRetries}...`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Aspetta 1 secondo
      }
    }

    console.log('Gemini response:', responseText);

    // Parsing del JSON dalla risposta
    const parsedData = parseGeminiResponse(responseText);

    // Valida i dati estratti
    if (!parsedData || !parsedData.employee_name || parsedData.employee_name.trim().length === 0) {
      console.error('Employee name not found in parsed data');
      return res.status(400).json({
        ok: false,
        error: 'Dipendente non trovato nel documento. Verifica che il nome sia corretto.',
      });
    }

    // Verifica che ci siano turni estratti
    const hasTurni = parsedData.schedule.length > 0 || 
                     parsedData.daily_codes.length > 0 ||
                     parsedData.exceptions.length > 0 ||
                     parsedData.modifications.length > 0;

    if (!hasTurni) {
      console.error('No shifts found in parsed data');
      return res.status(400).json({
        ok: false,
        error: 'Nessun turno trovato per questo dipendente nel documento.',
      });
    }

    // Salva in cache
    documentCache.set(docHash, {
      data: parsedData,
      timestamp: Date.now()
    });

    // Pulisci cache vecchia (max 100 elementi)
    if (documentCache.size > 100) {
      const oldestKey = documentCache.keys().next().value;
      documentCache.delete(oldestKey);
    }

    // Ritorna il risultato
    return res.json({
      ok: true,
      parsed: parsedData,
    });
  } catch (error) {
    console.error('Errore processing document:', error);
    
    // Gestione errori specifici di Gemini
    if (error.message && error.message.includes('quota')) {
      return res.status(503).json({
        ok: false,
        error: 'Servizio temporaneamente non disponibile. Riprova tra qualche minuto.',
      });
    }
    
    return res.status(500).json({
      ok: false,
      error: `Errore elaborazione documento: ${error.message}`,
    });
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'shift-pdf-processor', 
    ai: 'gemini-1.5-flash',
    version: '2.0'
  });
});

function createExtractionPrompt(employeeName) {
  return `Sei un assistente esperto nell'estrazione di dati da documenti di pianificazione turni.

COMPITO: Analizza questo documento e estrai SOLO i dati relativi al dipendente "${employeeName}".

ISTRUZIONI CRITICHE:
1. Cerca il nome "${employeeName}" nel documento (potrebbe essere scritto in modi diversi: maiuscolo, minuscolo, cognome-nome, nome-cognome, ecc.)
2. Estrai SOLO i turni, orari e modifiche di QUESTO dipendente specifico
3. NON estrarre dati di altri dipendenti
4. Il documento può essere in qualsiasi lingua (italiano, inglese, spagnolo, ecc.)
5. I codici turno variano ma i più comuni sono:
   - M, M1, M2, M3 = turno mattina (con varianti orarie)
   - P, P1, P2 = turno pomeriggio
   - N = turno notte
   - RC = riposo compensativo
   - RI = riposo
   - G = turno giornaliero
   - F = ferie
   - A = assenza/malattia
   - Altri codici specifici dell'azienda
6. Cerca le colonne "modifica turno" o annotazioni che indicano variazioni ai turni pianificati
7. Le date possono essere in vari formati (gg/mm/aaaa, dd-mm-yyyy, ecc.)

IMPORTANTE: Se il dipendente NON è presente nel documento, imposta employee_name come stringa vuota e confidence a 0.0.

Restituisci SOLO un oggetto JSON valido con questa struttura esatta:

{
  "employee_name": "nome esatto del dipendente come appare nel documento",
  "period_type": "mensile o settimanale o altro",
  "start_date": "YYYY-MM-DD della prima data trovata o null",
  "end_date": "YYYY-MM-DD dell'ultima data trovata o null",
  "schedule_kind": "ciclico o fisso o variabile",
  "day_count": numero intero di giorni totali o null,
  "daily_codes": ["sequenza", "ordinata", "dei", "codici", "turno", "giorno", "per", "giorno"],
  "schedule": [
    {
      "date": "YYYY-MM-DD o null",
      "day_index": 0,
      "code": "M",
      "start_time": "07:30 o null",
      "end_time": "15:36 o null",
      "note": "eventuali note o null"
    }
  ],
  "exceptions": [
    {
      "date": "YYYY-MM-DD o null",
      "day_index": 5,
      "code": "F",
      "start_time": null,
      "end_time": null,
      "note": "ferie o malattia o altro"
    }
  ],
  "modifications": [
    {
      "date": "YYYY-MM-DD o null",
      "day_index": 10,
      "code": "P",
      "original_code": "M",
      "note": "cambio turno o altra motivazione"
    }
  ],
  "detected_shift_codes": ["tutti", "i", "codici", "turno", "trovati"],
  "confidence": 0.95,
  "needs_review": false,
  "warnings": ["eventuali avvisi o array vuoto"]
}

REGOLE DETTAGLIATE:
- "schedule": tutti i turni pianificati/regolari in sequenza cronologica
- "exceptions": ferie, permessi, malattie, assenze
- "modifications": cambio turno rispetto al pianificato (cerca nella colonna "modifica turno")
- "day_index": indice progressivo del giorno (0, 1, 2, ...) partendo dalla data di inizio
- "confidence": valore da 0.0 a 1.0 che indica quanto sei sicuro dell'estrazione
- "needs_review": true se ci sono ambiguità o dati poco chiari
- "warnings": segnala qualsiasi problema o ambiguità riscontrata

PARSING DELLE DATE:
- Converti sempre le date in formato YYYY-MM-DD
- Se vedi "01/02/2026" interpretalo come giorno 1, mese 2, anno 2026 → "2026-02-01"
- Gestisci anche formati come "01-FEB-2026", "1 Febbraio 2026", ecc.

PARSING DEI TURNI:
- Alcuni documenti hanno una riga di turni "base" e poi le modifiche sotto
- Le modifiche sovrascrivono il turno base per quel giorno specifico
- Cerca simboli, note, celle evidenziate che indicano modifiche

CASO DIPENDENTE NON TROVATO:
Se il dipendente "${employeeName}" NON appare nel documento:
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
  "warnings": ["Dipendente non trovato nel documento"]
}`;
}

function parseGeminiResponse(text) {
  try {
    // Gemini con responseMimeType: 'application/json' dovrebbe già tornare JSON pulito
    // Ma gestiamo comunque i casi edge
    let cleaned = text.trim();
    
    // Rimuovi eventuali backtick markdown
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    cleaned = cleaned.replace(/^```\s*/i, '').replace(/```\s*$/, '');
    cleaned = cleaned.trim();
    
    // Parsing JSON
    const parsed = JSON.parse(cleaned);
    
    // Validazione e normalizzazione
    const normalized = {
      employee_name: (parsed.employee_name || '').trim(),
      period_type: parsed.period_type || 'unknown',
      start_date: parsed.start_date || null,
      end_date: parsed.end_date || null,
      schedule_kind: parsed.schedule_kind || 'unknown',
      day_count: typeof parsed.day_count === 'number' ? parsed.day_count : null,
      daily_codes: Array.isArray(parsed.daily_codes) ? parsed.daily_codes : [],
      schedule: Array.isArray(parsed.schedule) ? parsed.schedule : [],
      exceptions: Array.isArray(parsed.exceptions) ? parsed.exceptions : [],
      modifications: Array.isArray(parsed.modifications) ? parsed.modifications : [],
      detected_shift_codes: Array.isArray(parsed.detected_shift_codes) ? parsed.detected_shift_codes : [],
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.0,
      needs_review: parsed.needs_review === true,
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
    };
    
    return normalized;
  } catch (error) {
    console.error('Errore parsing JSON da Gemini:', error);
    console.error('Testo ricevuto:', text);
    
    // Ritorna un oggetto vuoto valido
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
      warnings: ['Errore parsing della risposta AI. Riprova.'],
    };
  }
}

// Cleanup periodico della cache
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of documentCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      documentCache.delete(key);
    }
  }
  console.log(`Cache cleanup - ${documentCache.size} items remaining`);
}, 3600000); // Ogni ora

// Avvia il server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log('Using Gemini 1.5 Flash - FREE tier (1500 req/day)');
  console.log('Rate limit: 3 requests per 10 minutes per user');
  console.log('Cache enabled with 1 hour TTL');
});
