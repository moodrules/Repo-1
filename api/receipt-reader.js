/**
 * POST /api/receipt-reader
 *
 * Reads a receipt photo and returns structured JSON. Two providers, chosen by
 * which key the deployment holds:
 *
 *   GEMINI_API_KEY     → Google Gemini (free tier)   — preferred when present
 *   ANTHROPIC_API_KEY  → Anthropic Messages API      — fallback
 *
 * Keys live ONLY here, in process.env. They are never sent to the browser and
 * never appear in a response or a log line.
 *
 * Request  (application/json):  { image_base64: string, mime_type: string }
 * Response (application/json):  { ok, provider, model, data: {image_present, items[], printed{}} }
 *                        error: { ok: false, error: CODE, message }
 *
 * The error CODEs keep their ANTHROPIC_* spelling whichever provider ran: the
 * frontend maps those codes to user-facing messages, and renaming them would
 * break that contract for no gain. `provider` says who actually answered.
 *
 * This function is transport only — image in, structured JSON out. Receipt
 * maths, VAT handling, reconciliation and validation all stay in the frontend.
 */

const GEMINI_KEY    = process.env.GEMINI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_MODEL    = process.env.GEMINI_MODEL    || 'gemini-3.6-flash';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const PROVIDER = GEMINI_KEY ? 'gemini' : (ANTHROPIC_KEY ? 'anthropic' : null);
const MODEL    = PROVIDER === 'gemini' ? GEMINI_MODEL : ANTHROPIC_MODEL;

const MAX_BYTES = 8 * 1024 * 1024;                       // 8 MB decoded
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const TIMEOUT_MS = 60000;

/* The rules below are not decoration. Each one corresponds to a way a real
   receipt was misread: a POS header parsed as a 2.00 dish, a discount line
   counted as food, and — on bilingual UAE receipts — the Arabic line under each
   dish counted as a second item. The printed totals are requested so the
   frontend can check the item list against the receipt's own arithmetic rather
   than trusting it. */
const PROMPT = `Read this receipt image and return JSON only:
{
  "image_present": true,
  "items": [{ "description": "string", "quantity": 0, "unit_price": 0, "line_total": 0 }],
  "printed": { "subtotal": 0, "discount": 0, "service_charge": 0, "vat": 0, "vat_rate_percent": 0, "total": 0, "currency": "AED" }
}

Rules:
- Read only what is actually visible. Never invent or estimate a value.
- If a value cannot be read confidently, return null for it rather than guessing.
- "items" is food and drink only. Exclude subtotal, total, VAT, tax, service charge,
  discount, tip, change, cash and card lines.
- Exclude header lines printed above the items: restaurant name, date, time, tax
  number, and markers such as DUPLICATA, CHECK #, TABLE #, INVOICE #. A number
  beside one of those is not a price.
- Many receipts print each dish twice: once in English and once in Arabic on the
  line below. That is ONE item. Use the English description and the price printed
  on that line. Never emit the Arabic line as a separate item.
- A named line under a DISCOUNT heading (for example "Fazaa 10%") is a discount,
  not a dish. Put its value in printed.discount.
- quantity, unit_price and line_total are numbers. If only a line total is printed,
  put it in line_total and leave unit_price null — do not divide it yourself.
- "printed" carries the receipt's own totals exactly as printed. Use null for any
  the receipt does not show.
- Return JSON only. No prose, no markdown fences.`;

function fail(res, status, error, message){
  // Sanitised: no key, no image, no upstream body echoed back.
  res.status(status).json({ ok: false, error, message });
}

/* ------------------------------- providers ------------------------------- */

async function callGemini(imageB64, mime, signal){
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ parts: [ { inline_data: { mime_type: mime, data: imageB64 } }, { text: PROMPT } ] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 4096 }
    })
  });
  return { res: r, text: async payload => (((payload.candidates || [])[0] || {}).content || {}).parts
      ? payload.candidates[0].content.parts.map(p => p && p.text).filter(Boolean).join('\n') : '' };
}

async function callAnthropic(imageB64, mime, signal){
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: imageB64 } },
        { type: 'text', text: PROMPT }
      ]}]
    })
  });
  return { res: r, text: async payload => (Array.isArray(payload.content) ? payload.content : [])
      .map(b => (b && b.type === 'text') ? b.text : '').filter(Boolean).join('\n') };
}

/* --------------------------------- handler -------------------------------- */

export default async function handler(req, res){
  if (req.method === 'GET'){
    /* Health probe: whether a provider is configured, and which of the two key
       names this running instance can actually see. Booleans only — never a key,
       never a fragment of one — so that "configured: false" can be diagnosed
       without guessing which half of the setup is missing. */
    return res.status(200).json({
      ok: true,
      configured: !!PROVIDER,
      provider: PROVIDER,
      model: PROVIDER ? MODEL : null,
      keys: { gemini: !!GEMINI_KEY, anthropic: !!ANTHROPIC_KEY }
    });
  }
  if (req.method !== 'POST') return fail(res, 405, 'INVALID_REQUEST', 'Use POST.');
  if (!PROVIDER) return fail(res, 503, 'ANTHROPIC_AUTH_FAILED', 'Receipt reader is not configured on the server.');

  let body = req.body;
  if (typeof body === 'string'){
    try { body = JSON.parse(body); } catch(_){ return fail(res, 400, 'INVALID_REQUEST', 'Malformed request body.'); }
  }
  const imageB64 = body && body.image_base64;
  const mime = (body && body.mime_type) || '';

  if (!imageB64 || typeof imageB64 !== 'string')
    return fail(res, 400, 'INVALID_REQUEST', 'No image was included in the request.');
  if (!ALLOWED_TYPES.includes(mime))
    return fail(res, 400, 'INVALID_MIME_TYPE', 'Unsupported image type. Use JPEG, PNG, WebP or GIF.');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(imageB64.slice(0, 256)))
    return fail(res, 400, 'INVALID_IMAGE', 'Image data is not valid base64.');
  const approxBytes = Math.floor(imageB64.length * 3 / 4);
  if (approxBytes > MAX_BYTES)
    return fail(res, 400, 'IMAGE_TOO_LARGE', 'Image is too large. Keep it under 8 MB.');
  if (approxBytes < 1024)
    return fail(res, 400, 'INVALID_IMAGE', 'Image data looks empty.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let call;
  try{
    call = PROVIDER === 'gemini'
      ? await callGemini(imageB64, mime, controller.signal)
      : await callAnthropic(imageB64, mime, controller.signal);
  }catch(e){
    clearTimeout(timer);
    const aborted = e && e.name === 'AbortError';
    console.error('[receipt-reader] upstream request failed:', PROVIDER, aborted ? 'timeout' : (e && e.name));
    return fail(res, 504, 'ANTHROPIC_REQUEST_FAILED',
      aborted ? 'Receipt reader timed out.' : 'Receipt reader temporarily unavailable.');
  }
  clearTimeout(timer);
  const upstream = call.res;

  if (upstream.status === 401 || upstream.status === 403){
    console.error('[receipt-reader] upstream auth rejected:', PROVIDER);
    return fail(res, 502, 'ANTHROPIC_AUTH_FAILED', 'Receipt reader credentials were rejected.');
  }
  if (upstream.status === 429)
    return fail(res, 429, 'ANTHROPIC_RATE_LIMITED', 'Receipt reader is busy or over its free quota. Try again in a moment.');
  if (upstream.status === 404){
    // Almost always a model name this account cannot use — worth saying plainly,
    // because the fix is one environment variable, not a code change.
    console.error('[receipt-reader] model not available:', PROVIDER, MODEL);
    return fail(res, 502, 'ANTHROPIC_REQUEST_FAILED',
      `The configured model (${MODEL}) is not available to this account. Set ${PROVIDER === 'gemini' ? 'GEMINI_MODEL' : 'ANTHROPIC_MODEL'} to one that is.`);
  }
  if (!upstream.ok){
    console.error('[receipt-reader] upstream HTTP', upstream.status, PROVIDER);
    return fail(res, 502, 'ANTHROPIC_REQUEST_FAILED', 'Receipt reader temporarily unavailable.');
  }

  let payload;
  try { payload = await upstream.json(); }
  catch(_){ return fail(res, 502, 'ANTHROPIC_RESPONSE_INVALID', 'Receipt reader returned an unreadable response.'); }

  let text = '';
  try { text = await call.text(payload); } catch(_){}
  if (!text || !text.trim())
    return fail(res, 502, 'ANTHROPIC_RESPONSE_INVALID', 'Receipt reader returned no content.');

  let data;
  try { data = JSON.parse(text.replace(/```json|```/g, '').trim()); }
  catch(_){ return fail(res, 502, 'RECEIPT_PARSE_FAILED', 'Could not read receipt data from the response.'); }

  if (!data || typeof data !== 'object' || !Array.isArray(data.items))
    return fail(res, 502, 'RECEIPT_PARSE_FAILED', 'Receipt data had an unexpected shape.');

  // Nothing is stored. The image exists only for the life of this request.
  return res.status(200).json({ ok: true, provider: PROVIDER, model: MODEL, data });
}
