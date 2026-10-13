# Deploying Tally — the free path

Static page plus a build step that downloads the free OCR engine. No key, no
account, no database, no framework. Receipt photos are read in the browser and
never uploaded.

```
index.html                 the whole app
setup.sh                   downloads the engine at build time
vercel.json                buildCommand + asset headers
vendor/tesseract/          filled by the build (git-ignored)
api/receipt-reader.js      optional paid fallback — inert without a key
```

## 1. Import the repository

vercel.com/new → import this repo → framework preset **Other** → Deploy.

Leave the build and output settings alone. `vercel.json` already sets:

```json
"buildCommand": "bash setup.sh eng ara",
"outputDirectory": "."
```

Or from the CLI:

```bash
npm i -g vercel
vercel          # accept the defaults
vercel --prod
```

## 2. Add no environment variables

The free path needs none. Adding `ANTHROPIC_API_KEY` only arms the optional
server-side fallback (step 9); it is not required and costs money per scan.

## 3. Watch the build log

It should show:

```
==> Fetching tesseract.js 5.1.1 into …/vendor/tesseract
==> Fetching language model: eng
==> Fetching language model: ara
==> Done:
    6.2M    …/vendor/tesseract
```

If a file fails to download the script prints `MISSING: …` and exits 1, so the
deploy fails instead of publishing a reader that breaks in the browser. Re-run
the deploy; the download sources are npm and jsDelivr (with a
tessdata.projectnaptha.com fallback for the models).

## 4. Confirm the engine is being served

Open these two URLs on the deployed domain:

- `/vendor/tesseract/worker.min.js` → JavaScript, `Content-Type:
  text/javascript`
- `/vendor/tesseract/lang/eng.traineddata.gz` → a binary download

If the first returns your HTML page instead of script, the app will correctly
decide the engine is absent and keep the reading UI off — that is the check
working, not a bug.

## 5. Open the app and check the mode

Go to **Add check → Add the check**. With the engine present you get **Scan
your check** and **Upload a receipt photo** as reading options, and the status
line moves `initialising → ready`.

## 6. Scan a real receipt

**Run diagnostics** should read:

```
ENGINE_PRESENT            same-origin engine found — on-device reading enabled
READER_CAPABILITIES_OK    assets + worker usable from local
Engine source             local (same origin)
IMAGE_RECEIVED            42KB image/jpeg
OCR_PROGRESS              recognizing text 0.62
RECEIPT_JSON_RECEIVED     6 items
OCR STATUS: READY
```

`Engine source: local (same origin)` is the line that matters. If it says
cross-origin CDN, `vendor/tesseract/` did not ship.

The first scan also loads the WASM core and the language model (a few MB); it
is cached from then on. Nothing is sent anywhere — check DevTools → Network:
no request leaves the origin during a scan.

## 7. Verify the extracted items

Each visible line should appear on the review screen with its quantity and unit
price. Anything the engine could not read confidently arrives empty and
editable — it is not guessed at. Printed totals are reconciled against the
computed ones and any mismatch is flagged, never silently overwritten.

## 8. Verify calculations

Set the country (Egypt 14% / UAE 5% / Saudi 15% / custom), choose VAT included
or excluded, switch on service charge or discount if the bill has them, assign
items, and check the per-person totals sum exactly to the check total. Order is
items subtotal → discount → service charge → VAT → final total. All of this runs
in the browser and is unchanged by the deployment.

## 9. Optional: the paid fallback

Only if you want a server-side reader for browsers that block Web Workers:

```bash
vercel env add ANTHROPIC_API_KEY production
vercel env add ANTHROPIC_API_KEY preview
```

**The name matters.** Never `NEXT_PUBLIC_*`, `VITE_*` or `REACT_APP_*` — those
prefixes are deliberately exposed to the browser. Plain `ANTHROPIC_API_KEY`
stays server-side. `ANTHROPIC_MODEL` is optional (default `claude-sonnet-5`).

With the engine present this endpoint is not used. Leaving the key unset is the
free configuration and the app behaves correctly without it.

### Endpoint reference

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

`GET /api/receipt-reader` → `{ ok, configured, model }` — a configuration probe
only; it never marks the reader ready.

## 10. Verify nothing leaks

- View source on the deployed page: search `ANTHROPIC`, `sk-ant`, `x-api-key` —
  zero hits.
- During an on-device scan, DevTools → Network shows requests to
  `/vendor/tesseract/…` on your own domain and nothing else.
- Vercel → Logs: failure classes only. No image data, no key.

## Local development

```bash
bash setup.sh eng ara      # once — downloads the engine
python3 -m http.server 8000
# open http://localhost:8000
```

Serve it over http. Opened as a bare `file://` the browser blocks the OCR
worker, the app detects that, and the photo hand-off path is used instead.

`vercel dev` also works and additionally serves `/api/receipt-reader`.
