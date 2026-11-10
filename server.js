/* ==========================================================
   NEUROVOLT — server.js
   Node.js + Express backend for the AI Energy Analysis module.

   Flow:
   Browser → POST /api/analyze → this server → Gemini → back to browser

   The Gemini API key NEVER touches the frontend. It lives only in
   process.env, loaded from .env.
   ========================================================== */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const ai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

app.use(cors());
app.use(express.json({ limit: '256kb' }));

// Serves index.html / style.css / script.js from this same folder,
// so the whole app runs from one server during the SIH demo.
app.use(express.static(__dirname));

// ----------------------------------------------------------
// VALIDATION (mirrors the rules already enforced in script.js —
// never trust data arriving over the network, even from your own frontend)
// ----------------------------------------------------------
function validateRequestBody(body) {
  const { appliances, totals, rate } = body || {};

  if (!Array.isArray(appliances) || appliances.length === 0) {
    return 'No appliance data provided.';
  }
  if (typeof rate !== 'number' || rate <= 0) {
    return 'Electricity rate must be greater than 0.';
  }
  if (!totals || typeof totals.monthly_kwh !== 'number') {
    return 'Missing consumption totals.';
  }

  for (const a of appliances) {
    if (typeof a.power_w !== 'number' || a.power_w < 0) {
      return 'Invalid power value for "' + (a.name || 'an appliance') + '".';
    }
    if (typeof a.quantity !== 'number' || a.quantity < 1) {
      return 'Invalid quantity for "' + (a.name || 'an appliance') + '".';
    }
    if (typeof a.hours_per_day !== 'number' || a.hours_per_day < 0 || a.hours_per_day > 24) {
      return 'Invalid daily hours for "' + (a.name || 'an appliance') + '".';
    }
  }
  return null;
}

// ----------------------------------------------------------
// RESPONSE SCHEMA — passed to Gemini's structured output config
// (ai.models.generateContent config.responseSchema) so the model
// is constrained to return exactly this shape.
// ----------------------------------------------------------
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    energy_status: {
      type: 'string',
      enum: ['OPTIMIZED', 'MODERATE', 'HIGH CONSUMPTION']
    },
    top_consumers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          share: { type: 'number' },
          monthly_kwh: { type: 'number' }
        },
        required: ['name', 'share', 'monthly_kwh']
      }
    },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          appliance: { type: 'string' },
          priority: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
          recommendation: { type: 'string' },
          reason: { type: 'string' },
          suggested_hours_reduction: { type: 'number' }
        },
        required: ['appliance', 'priority', 'recommendation', 'reason', 'suggested_hours_reduction']
      }
    }
  },
  required: ['summary', 'energy_status', 'top_consumers', 'recommendations']
};

// ----------------------------------------------------------
// PROMPT — instructs the AI to analyze ONLY the real data given,
// never invent appliances/prices/history, and return strict JSON
// matching RESPONSE_SCHEMA above.
// ----------------------------------------------------------
function buildPrompt(payload) {
  return [
    'You are an energy-efficiency analyst for a household electricity dashboard called NeuroVolt.',
    'Analyze ONLY the data given below. Do not invent appliances, prices, sensor readings, or historical usage.',
    'If historical consumption data would help but is not provided, explicitly say historical data is unavailable — do not estimate or fabricate it.',
    '',
    'ELECTRICITY RATE: \u20b9' + payload.rate + ' per kWh',
    'TOTAL DAILY CONSUMPTION: ' + payload.totals.daily_kwh.toFixed(2) + ' kWh',
    'TOTAL MONTHLY CONSUMPTION: ' + payload.totals.monthly_kwh.toFixed(2) + ' kWh',
    'ESTIMATED MONTHLY BILL: \u20b9' + payload.totals.estimated_monthly_bill.toFixed(2),
    '',
    'APPLIANCES (name, power in watts, quantity, hours/day, monthly kWh, % share of total):',
    JSON.stringify(payload.appliances, null, 2),
    '',
    'Rules:',
    '- "suggested_hours_reduction" must be a realistic number of hours/day LESS than that appliance\'s current hours_per_day. Do not include money or energy savings figures yourself — the backend computes those from your suggested_hours_reduction against the real appliance data.',
    '- Limit "recommendations" to at most 3 items, ordered by impact (highest first).',
    '- "appliance" in each recommendation must exactly match a name from the APPLIANCES list above (or "General" if it is not appliance-specific).'
  ].join('\n');
}

// ----------------------------------------------------------
// POST /api/analyze
// ----------------------------------------------------------
app.post('/api/analyze', async (req, res) => {
  try {
    const validationError = validateRequestBody(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    if (!GEMINI_API_KEY || !ai) {
      return res.status(503).json({
        error: 'GEMINI_API_KEY is not configured on the server. Add it to your .env file.'
      });
    }

    const prompt = buildPrompt(req.body);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    let response;
    try {
      response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA
        },
        // AbortSignal support depends on SDK version; harmless if ignored.
        httpOptions: { signal: controller.signal }
      });
    } catch (genErr) {
      clearTimeout(timeout);
      if (genErr.name === 'AbortError') {
        return res.status(504).json({ error: 'Gemini request timed out.' });
      }
      console.error('NeuroVolt: error calling Gemini:', genErr);
      return res.status(502).json({ error: 'Gemini API request failed.' });
    }
    clearTimeout(timeout);

    const rawText = (response && response.text ? response.text : '').trim();

    if (!rawText) {
      console.error('NeuroVolt: Gemini returned an empty response.');
      return res.status(502).json({ error: 'Gemini returned an empty response.' });
    }

    // responseMimeType: 'application/json' should already give clean JSON,
    // but strip stray code fences defensively in case a model/version adds them.
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('NeuroVolt: failed to parse Gemini JSON response:', rawText);
      return res.status(502).json({ error: 'Gemini returned a malformed response.' });
    }

    return res.json(parsed);
  } catch (err) {
    console.error('NeuroVolt: unexpected /api/analyze error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

app.listen(PORT, () => {
  console.log('NeuroVolt server running at http://localhost:' + PORT);
  if (!GEMINI_API_KEY) {
    console.warn('WARNING: GEMINI_API_KEY is not set — AI analysis will return 503 until you add it to .env (the frontend will automatically fall back to rule-based recommendations).');
  }
});