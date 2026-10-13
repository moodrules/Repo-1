/**
 * POST /api/receipt-reader
 *
 * Minimal receipt-reading endpoint. Receives a receipt image from the browser,
 * calls the Anthropic Messages API server-side, returns structured JSON.
 *
 * The API key lives ONLY here, in process.env.ANTHROPIC_API_KEY. It is never
 * sent to the browser and never appears in a response.
 *
 * Request  (application/json):  { image_base64: string, mime_type: string }
 * Response (application/json):  { ok: true, data: { image_present, items[] } }
 *                        error: { ok: false, code: string, message: string }
 *
 * Deploy: Vercel. Same origin as the app, so there is no CORS step and no
 * content-security-policy exception to make.
 *
 * This function does transport only — image in, structured JSON out. All
 * receipt maths, VAT handling and validation stay in the frontend.
 */

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const MAX_BYTES = 8 * 1024 * 1024;                       // 8 MB decoded
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ANTHROPIC_TIMEOUT_MS = 60000;

const PROMPT = `Analyze this receipt image and return JSON only:
{
  "image_present": true,
  "items": [
    {
      "description": "string",
      "quantity": 0,
      "unit_price": 0,
      "line_total": 0
    }
  ]
}

Rules:
- Read only information actually visible in the image.
- Do not invent values.
- Preserve visible item descriptions exactly as printed.
- quantity must be numeric.
- unit_price and line_total must be numeric.
- If a value cannot be read confidently, return null rather than inventing it.
- Return JSON only, with no prose and no markdown fences.`;

function fail(res, status, error, message){
  // Sanitised: no key, no image, no upstream body echoed back.
  res.status(status).json({ ok: false, error, message });
}

export default async function handler(req, res){
  if (req.method === 'GET'){
    // Health probe: says whether the endpoint is configured. Never the key itself.
    return res.status(200).json({
      ok: true,
      configured: !!process.env.ANTHROPIC_API_KEY,
      model: MODEL
    });
  }
  if (req.method !== 'POST') return fail(res, 405, 'INVALID_REQUEST', 'Use POST.');

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return fail(res, 503, 'ANTHROPIC_AUTH_FAILED', 'Receipt reader is not configured on the server.');

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
  const timer = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);
  let upstream;
  try{
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: imageB64 } },
            { type: 'text', text: PROMPT }
          ]
        }]
      })
    });
  }catch(e){
    clearTimeout(timer);
    const aborted = e && e.name === 'AbortError';
    // Log the failure class only — never the image, never the key.
    console.error('[receipt-reader] upstream request failed:', aborted ? 'timeout' : (e && e.name));
    return fail(res, 504, 'ANTHROPIC_REQUEST_FAILED',
      aborted ? 'Receipt reader timed out.' : 'Receipt reader temporarily unavailable.');
  }
  clearTimeout(timer);

  if (upstream.status === 401 || upstream.status === 403){
    console.error('[receipt-reader] upstream auth rejected');
    return fail(res, 502, 'ANTHROPIC_AUTH_FAILED', 'Receipt reader credentials were rejected.');
  }
  if (upstream.status === 429)
    return fail(res, 429, 'ANTHROPIC_RATE_LIMITED', 'Receipt reader is busy. Try again in a moment.');
  if (!upstream.ok){
    console.error('[receipt-reader] upstream HTTP', upstream.status);
    return fail(res, 502, 'ANTHROPIC_REQUEST_FAILED', 'Receipt reader temporarily unavailable.');
  }

  let payload;
  try { payload = await upstream.json(); }
  catch(_){ return fail(res, 502, 'ANTHROPIC_RESPONSE_INVALID', 'Receipt reader returned an unreadable response.'); }

  const text = (Array.isArray(payload.content) ? payload.content : [])
    .map(b => (b && b.type === 'text') ? b.text : '')
    .filter(Boolean).join('\n');
  if (!text.trim()) return fail(res, 502, 'ANTHROPIC_RESPONSE_INVALID', 'Receipt reader returned no content.');

  let data;
  try { data = JSON.parse(text.replace(/```json|```/g, '').trim()); }
  catch(_){ return fail(res, 502, 'RECEIPT_PARSE_FAILED', 'Could not read receipt data from the response.'); }

  if (!data || typeof data !== 'object' || !Array.isArray(data.items))
    return fail(res, 502, 'RECEIPT_PARSE_FAILED', 'Receipt data had an unexpected shape.');

  // Nothing is stored. The image exists only for the life of this request.
  return res.status(200).json({ ok: true, model: MODEL, data });
}
