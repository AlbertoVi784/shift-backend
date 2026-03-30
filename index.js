const express = require('express');
const multer = require('multer');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Inizializza Firebase Admin
initializeApp();

// Inizializza Gemini API (GRATIS!)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

// Endpoint principale per processare il documento
app.post('/', validateFirebaseToken, upload.single('document'), async (req, res) => {
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

    // Converti il file in base64
    const base64Data = file.buffer.toString('base64');
    
    // Determina il mimeType
    let mimeType = file.mimetype;
    if (!mimeType || mimeType === 'application/octet-stream') {
      // Prova a indovinare dal nome file
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

    // Usa Gemini 1.5 Pro (supporta PDF e immagini)
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.5-flash',
      generationConfig: {
        temperature: 0.1,
        topP: 1,
        topK: 32,
        maxOutputTokens: 4096,
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

    // Chiama l'API di Gemini
    console.log('Calling Gemini API...');
    const result = await model.generateContent(parts);
    const response = await result.response;
    const responseText = response.text();

    console.log('Gemini response:', responseText);

    // Parsing del JSON dalla risposta
    const parsedData = parseGeminiResponse(responseText);

    // Valida i dati estratti
    if (!parsedData || !parsedData.employee_name) {
      return res.status(400).json({
        ok: false,
        error: 'Impossibile estrarre i dati del dipendente dal documento',
      });
    }

    // Ritorna il risultato
    return res.json({
      ok: true,
      parsed: parsedData,
    });
  } catch (error) {
    console.error('Errore processing document:', error);
    return res.status(500).json({
      ok: false,
      error: `Errore elaborazione documento: ${error.message}`,
    });
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'shift-pdf-processor', ai: 'gemini' });
});

function createExtractionPrompt(employeeName) {
  return `Analizza questo documento dei turni di lavoro e estrai SOLO i dati relativi al dipendente "${employeeName}".

ISTRUZIONI CRITICHE:
1. Cerca il nome "${employeeName}" nel documento (potrebbe essere scritto in vari modi, es. cognome nome, tutto maiuscolo, ecc.)
2. Estrai SOLO i turni, gli orari e le modifiche relative a questo dipendente
3. NON estrarre dati di altri dipendenti
4. I codici turno comuni sono: M (mattina), P (pomeriggio), N (notte), RC (riposo compensativo), RI (riposo), A (assenza), F (ferie)
5. Cerca anche modifiche/variazioni ai turni (spesso indicate con annotazioni o simboli)
6. Le date possono essere nel formato gg/mm/aaaa o simili

Restituisci SOLO un oggetto JSON valido (senza markdown, senza backtick) con questa struttura:

{
  "employee_name": "nome del dipendente trovato",
  "period_type": "tipo di periodo (es. mensile, settimanale)",
  "start_date": "data inizio nel formato YYYY-MM-DD o null",
  "end_date": "data fine nel formato YYYY-MM-DD o null",
  "schedule_kind": "tipo di pianificazione (es. ciclico, fisso, variabile)",
  "day_count": numero di giorni totali o null,
  "daily_codes": ["array", "dei", "codici", "turno", "in", "ordine", "cronologico"],
  "schedule": [
    {
      "date": "YYYY-MM-DD o null",
      "day_index": 0,
      "code": "M",
      "start_time": "08:00 o null",
      "end_time": "16:00 o null",
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
      "note": "ferie"
    }
  ],
  "modifications": [
    {
      "date": "YYYY-MM-DD o null",
      "day_index": 10,
      "code": "P",
      "original_code": "M",
      "note": "cambio turno"
    }
  ],
  "detected_shift_codes": ["M", "P", "N", "RC", "RI"],
  "confidence": 0.95,
  "needs_review": false,
  "warnings": ["eventuali avvisi o array vuoto"]
}

REGOLE:
- "schedule" contiene i turni regolari/pianificati
- "exceptions" contiene eccezioni come ferie, malattia, permessi
- "modifications" contiene modifiche ai turni originali
- "day_index" è l'indice del giorno (0 = primo giorno del periodo)
- Usa "confidence" per indicare quanto sei sicuro (0.0 a 1.0)
- Metti "needs_review: true" se ci sono ambiguità
- Se non trovi il dipendente, ritorna employee_name vuoto e confidence 0.0

IMPORTANTE: Restituisci SOLO il JSON, nient'altro. Nessun testo prima o dopo.`;
}

function parseGeminiResponse(text) {
  try {
    // Rimuovi eventuali backtick markdown
    let cleaned = text.trim();
    
    // Rimuovi ```json e ``` se presenti
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    cleaned = cleaned.replace(/^```\s*/i, '').replace(/```\s*$/, '');
    cleaned = cleaned.trim();
    
    // Parsing JSON
    const parsed = JSON.parse(cleaned);
    
    // Validazione base
    if (!parsed.employee_name) {
      parsed.employee_name = '';
      parsed.confidence = 0.0;
      parsed.needs_review = true;
    }
    
    // Assicurati che gli array esistano
    parsed.daily_codes = parsed.daily_codes || [];
    parsed.schedule = parsed.schedule || [];
    parsed.exceptions = parsed.exceptions || [];
    parsed.modifications = parsed.modifications || [];
    parsed.detected_shift_codes = parsed.detected_shift_codes || [];
    parsed.warnings = parsed.warnings || [];
    
    return parsed;
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
      warnings: ['Errore parsing della risposta AI'],
    };
  }
}

// Avvia il server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log('Using Gemini AI (Google) - FREE tier');
});
