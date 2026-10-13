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
/* Vercel kills this function at 60s (vercel.json). A budget at or above that
   wall means the platform's bare 504 reaches the browser instead of this
   function's JSON error, which is how a timeout arrives with no message at all.
   So: finish, and answer, before the wall. */
const TOTAL_BUDGET_MS = 45000;
const PER_ATTEMPT_MS = 15000;      // smaller, so the budget covers three models rather than two

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
- English is the primary language. Many receipts print each dish twice: once in
  English and once in Arabic on the line below. That is ONE item — use the
  English description, and never emit the Arabic line as a separate item.
- Where both languages are present, always take the English wording, even if the
  Arabic is clearer or longer. Do not mix the two in one description, and do not
  append the Arabic in brackets.
- If a line is printed ONLY in Arabic, give its English translation as the
  description, kept short and plain (for example "كباب لحم" becomes "Lamb kebab").
  Translate the dish name only — never translate or alter a number.
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

/* Model availability differs per account and Google's docs do not say which
   Flash models take image input, so a single hard-coded name is a guess that
   fails in production rather than in review. The configured model is tried
   first and the rest only on a model-shaped rejection; anything else (auth,
   quota, a bad request) is returned immediately, never retried. The model that
   answered is reported back in the response. */
const GEMINI_FALLBACKS = [GEMINI_MODEL, 'gemini-3.6-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash-preview', 'gemini-3.8-flash', 'gemini-2.5-flash']
  .filter((m, i, a) => m && a.indexOf(m) === i);

/* Reading a receipt is extraction, not reasoning, but Gemini 3 Flash models
   think at "medium" by default and that is what pushed two attempts past 22s
   with nothing to show. Thinking is therefore asked down to its lowest setting.
   Google documents thinking_level for the Interactions API; the field for
   generateContent is not documented on that page, so rather than bet on a
   guess, a request rejected for an unknown field is retried once without it —
   slower, but it still answers. */
const THINKING = { thinkingConfig: { thinkingLevel: 'low' } };
let thinkingSupported = true;      // per instance; a rejection switches it off

/* Narrow on purpose: it must name the thinking field. A blanket "unknown name"
   match let an unrelated 400 switch thinking off for the whole instance, which
   is how one bad request would quietly slow down every later one. */
function isUnknownFieldError(status, body){
  if (status !== 400) return false;
  const t = String(body || '');
  return /(unknown name|cannot find field)[^"]*"?(thinking[A-Za-z_]*)/i.test(t) || /thinking(config|_level|level)/i.test(t);
}

function isModelProblem(status, body){
  if (status === 404) return true;
  if (status !== 400) return false;
  return /model|not found|not supported|unsupported|does not exist/i.test(String(body || ''));
}

/* A busy model is not a broken request. Google answers 503 UNAVAILABLE when a
   particular model is saturated — common on the free tier — and the useful
   response is to ask a different model, not to give up. 500 is treated the same
   way. 429 is NOT: that is a quota signal about the account, and asking other
   models would only spend more of it. */
function isTransient(status){ return status === 503 || status === 500; }

async function callGemini(imageB64, mime, deadline){
  let last = null;
  for (const model of GEMINI_FALLBACKS){
    const left = deadline - Date.now();
    if (left < 4000) break;                       // not enough time to be worth starting
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(PER_ATTEMPT_MS, left));
    let attempt;
    try {
      attempt = await geminiAttempt(model, imageB64, mime, ctl.signal);
    } catch(e){
      clearTimeout(timer);
      if (e && e.name === 'AbortError'){
        // One slow model must not consume the whole budget silently.
        console.error('[receipt-reader] model timed out, trying the next:', model);
        last = {timedOut: true, model};
        continue;
      }
      throw e;
    }
    clearTimeout(timer);
    if (attempt.res.ok) return Object.assign(attempt, {model});
    let body = await attempt.res.clone().text().catch(() => '');

    /* The thinking field was not accepted. Drop it for this instance and try
       the same model again — the request itself was fine. */
    if (thinkingSupported && isUnknownFieldError(attempt.res.status, body)){
      console.error('[receipt-reader] thinking control not accepted, retrying without it');
      thinkingSupported = false;
      const ctl2 = new AbortController();
      const t2 = setTimeout(() => ctl2.abort(), Math.min(PER_ATTEMPT_MS, Math.max(0, deadline - Date.now())));
      try{
        const retry = await geminiAttempt(model, imageB64, mime, ctl2.signal);
        clearTimeout(t2);
        if (retry.res.ok) return Object.assign(retry, {model});
        body = await retry.res.clone().text().catch(() => '');
        attempt = retry;
      }catch(_){ clearTimeout(t2); last = {timedOut: true, model}; continue; }
    }
    const retryable = isModelProblem(attempt.res.status, body) || isTransient(attempt.res.status);
    if (!retryable) return Object.assign(attempt, {model});
    console.error('[receipt-reader] model unusable, trying the next:', model, attempt.res.status);
    last = Object.assign(attempt, {model, busy: isTransient(attempt.res.status)});
  }
  return last;
}

function geminiAttempt(model, imageB64, mime, signal){
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  return fetchGemini(url, imageB64, mime, signal);
}

async function fetchGemini(url, imageB64, mime, signal){
  const r = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ parts: [ { inline_data: { mime_type: mime, data: imageB64 } }, { text: PROMPT } ] }],
      generationConfig: Object.assign(
        { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 4096 },
        thinkingSupported ? THINKING : {})
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

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let call;
  try{
    if (PROVIDER === 'gemini'){
      call = await callGemini(imageB64, mime, deadline);
    } else {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TOTAL_BUDGET_MS);
      try { call = await callAnthropic(imageB64, mime, ctl.signal); }
      finally { clearTimeout(timer); }
    }
  }catch(e){
    const aborted = e && e.name === 'AbortError';
    console.error('[receipt-reader] upstream request failed:', PROVIDER, aborted ? 'timeout' : (e && e.name));
    return fail(res, 504, 'ANTHROPIC_REQUEST_FAILED',
      aborted ? 'The reader provider did not answer in time. Try again, or use a smaller photo.'
              : 'Receipt reader temporarily unavailable.');
  }
  if (call && call.busy && call.res && isTransient(call.res.status))
    return fail(res, 503, 'ANTHROPIC_RATE_LIMITED',
      'Every available model is busy right now. This is a free-tier capacity limit on the provider\'s side, not a problem with your photo — try again in a minute.');
  if (!call || call.timedOut || !call.res)
    return fail(res, 504, 'ANTHROPIC_REQUEST_FAILED',
      `The reader provider did not answer within ${Math.round(TOTAL_BUDGET_MS/1000)}s${call && call.model ? ' (last tried ' + call.model + ')' : ''}. Try again, or use a smaller photo.`);
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
    let detail = '';
    try { detail = String((JSON.parse(await upstream.text()).error || {}).message || '').slice(0, 200); } catch(_){}
    console.error('[receipt-reader] model not available:', PROVIDER, MODEL, detail);
    return fail(res, 502, 'ANTHROPIC_REQUEST_FAILED',
      `The configured model (${MODEL}) is not available to this account. Set ${PROVIDER === 'gemini' ? 'GEMINI_MODEL' : 'ANTHROPIC_MODEL'} to one that is.${detail ? ' Provider said: ' + detail : ''}`);
  }
  if (!upstream.ok){
    /* Pass the provider's own complaint through. "Temporarily unavailable" is
       a lie when the provider said "this field is invalid" — and an error that
       cannot be read from the client cannot be fixed from the client. Only the
       provider's status, code and message are forwarded, trimmed; the request
       body, the image and the key are never echoed. */
    let detail = '';
    try{
      const body = await upstream.text();
      const parsed = JSON.parse(body);
      const err = parsed && parsed.error;
      detail = err ? [err.status, err.message].filter(Boolean).join(': ') : String(body);
    }catch(_){ detail = ''; }
    detail = detail.replace(/\s+/g, ' ').trim().slice(0, 300);
    console.error('[receipt-reader] upstream HTTP', upstream.status, PROVIDER, detail);
    return fail(res, 502, 'ANTHROPIC_REQUEST_FAILED',
      `Reader provider returned HTTP ${upstream.status}${detail ? ' — ' + detail : '.'}`);
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
  return res.status(200).json({ ok: true, provider: PROVIDER, model: call.model || MODEL, data });
}
