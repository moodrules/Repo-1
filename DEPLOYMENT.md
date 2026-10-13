# Deploying Split to Vercel

Static frontend plus one serverless function. No database, no framework, no
build step.

```
split-app/
  index.html                 the whole app
  api/receipt-reader.js      the only backend code
  vercel.json                headers
  vendor/tesseract/          optional: free on-device reader (see step 12)
```

## 1. Create the Vercel project

```bash
npm i -g vercel
cd split-app
vercel            # accept the defaults; framework preset "Other"
```

Or push the folder to GitHub and import it at vercel.com/new.

## 2. Connect the repository

If you imported from Git, Vercel redeploys on every push. Nothing else to
configure: `api/receipt-reader.js` is detected automatically as a function.

## 3. Add ANTHROPIC_API_KEY

```bash
vercel env add ANTHROPIC_API_KEY production
vercel env add ANTHROPIC_API_KEY preview
```

Or Project → Settings → Environment Variables.

**The name matters.** Do not call it `NEXT_PUBLIC_*`, `VITE_*` or
`REACT_APP_*` — those prefixes are deliberately exposed to the browser. A plain
`ANTHROPIC_API_KEY` stays server-side.

## 4. Optionally add ANTHROPIC_MODEL

Defaults to `claude-sonnet-5`. Set it only to pin a different current model.

## 5. Deploy

```bash
vercel --prod
```

## 6. Open the deployed URL

The app loads. Go to **Add check** → **Add the check**.

## 7. Upload an actual receipt

Use **Upload a receipt photo** with a real bill. Before the first successful
scan the reader reports **configured**, not ready — the round trip has not been
proven yet. That is intentional.

## 8. Verify the event sequence

Tap **Run diagnostics**. The log should read:

```
IMAGE_RECEIVED            42KB image/jpeg
READER_REQUEST_STARTED    /api/receipt-reader
IMAGE_SENT_TO_BACKEND     31KB base64, image/jpeg
ANTHROPIC_REQUEST_STARTED via /api/receipt-reader
ANTHROPIC_RESPONSE_RECEIVED HTTP 200 in 4120ms
RECEIPT_JSON_RECEIVED     6 items
READER_INIT_SUCCESS       OCR_READY — proven on a real receipt
```

`OCR STATUS: READY` only appears after that last line.

## 9. Verify receipt items

Each visible line should appear on the review screen with its quantity and unit
price. Anything the model could not read confidently arrives as null and shows
as an empty, editable field — it is not guessed at.

## 10. Verify calculations

Set the country (Egypt 14% / UAE 5% / Saudi 15% / custom), choose VAT included
or excluded, switch on service charge or discount if the bill has them, assign
items, and check that the per-person totals sum exactly to the check total. All
of this runs in the browser and is unchanged by the deployment.

## 11. Verify no key is exposed

- View source on the deployed page: search for `ANTHROPIC`, `sk-ant`,
  `x-api-key` — zero hits.
- DevTools → Network → the `receipt-reader` request: the **request** carries
  only `image_base64` and `mime_type`; the **response** carries only
  `{ ok, model, data }`. No key in either direction.
- Vercel → Logs: failure classes only. No image data, no key.

## 12. Optional: free on-device reading instead

The app prefers on-device Tesseract when it can run, and only falls back to the
server reader when it cannot. To enable it, bundle the engine before deploying:

```bash
./setup.sh          # English
./setup.sh eng ara  # English + Arabic
```

That adds ~6 MB under `vendor/tesseract/`, costs nothing per scan, and keeps
receipt photos on the device. With it present, `/api/receipt-reader` is used
only when a browser blocks workers.

## Endpoint reference

`POST /api/receipt-reader`

```json
{ "image_base64": "<base64, no data: prefix>", "mime_type": "image/jpeg" }
```

`200`:

```json
{ "ok": true, "model": "claude-sonnet-5",
  "data": { "image_present": true,
            "items": [{ "description": "Peroni Bottle", "quantity": 1,
                        "unit_price": 13.70, "line_total": 13.70 }] } }
```

Errors: `{ "ok": false, "error": "CODE", "message": "…" }` where CODE is one of
`INVALID_REQUEST`, `INVALID_MIME_TYPE`, `IMAGE_TOO_LARGE`, `INVALID_IMAGE`,
`ANTHROPIC_AUTH_FAILED`, `ANTHROPIC_RATE_LIMITED`, `ANTHROPIC_REQUEST_FAILED`,
`ANTHROPIC_RESPONSE_INVALID`, `RECEIPT_PARSE_FAILED`.

`GET /api/receipt-reader` → `{ ok, configured, model }` — configuration probe
only; it never marks the reader ready.

## Local development

```bash
vercel dev        # serves index.html and /api/receipt-reader together
```

Needs `ANTHROPIC_API_KEY` in `.env.local` (git-ignored). Without a key the
endpoint returns `ANTHROPIC_AUTH_FAILED` and the app says the server reader is
not configured — no crash, and manual entry still works.
