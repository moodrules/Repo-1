# Tally — split the bill, to the fils

A single-page receipt splitter: add people, import the receipt, tap who had
what, get exact per-person totals that always reconcile to the check total.

```
index.html                 the whole app (no build step, no framework)
api/receipt-reader.js      Vercel serverless function — reads a receipt photo
vercel.json                headers + function duration
setup.sh                   optional: bundle the free on-device OCR engine
DEPLOYMENT.md              deploy steps and the acceptance test
```

## Deploy

1. Import this repo at vercel.com/new (framework preset: Other).
2. Add the environment variable `ANTHROPIC_API_KEY` (Production + Preview).
   Optional: `ANTHROPIC_MODEL`, default `claude-sonnet-5`.
3. Deploy, open the URL, upload a receipt.

Full steps and the verification checklist: `DEPLOYMENT.md`.

## How receipt reading works

The browser never calls Anthropic and holds no key. It POSTs
`{image_base64, mime_type}` to `/api/receipt-reader` on its own origin; that
function holds the key server-side, calls the Messages API, and returns
structured items. The reader reports **configured** until a real receipt
completes the round trip — a mocked response never counts as ready.

Prefer free, on-device reading? Run `./setup.sh` before deploying to bundle
Tesseract under `vendor/tesseract/`; the app then reads photos in the browser
and the serverless function is only a fallback.

## What works without any deployment

Opening `index.html` from any static host gives you people, item import
(paste a list from any AI), quantity-level splitting, country tax settings
(Egypt 14% / UAE 5% / Saudi 15% / custom), VAT inclusive or exclusive,
service charge, discount, the transparent breakdown, and native sharing.
