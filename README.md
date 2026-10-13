# Tally — split the bill, to the fils

A single-page receipt splitter: add people, import the receipt, tap who had
what, get exact per-person totals that always reconcile to the check total.

```
index.html                 the whole app (no build step, no framework)
setup.sh                   fetches the free on-device OCR engine at build time
vercel.json                build command, asset headers, function duration
api/receipt-reader.js      OPTIONAL paid fallback (needs an Anthropic key)
DEPLOYMENT.md              deploy steps and the acceptance test
```

## Deploy (free — no key, no account, no per-scan cost)

1. Import this repo at vercel.com/new (framework preset: **Other**).
2. Deploy. **Add no environment variables.**
3. Open the URL and upload a receipt.

Vercel runs `bash setup.sh eng ara` during the build, which downloads the
Tesseract engine (library, worker, WASM core, English + Arabic models) into
`vendor/tesseract/`. The app then serves the engine from its own origin and
reads receipts **in the browser** — the photo never leaves the device, and
there is nothing to pay per scan. If any engine file fails to download the
build aborts rather than shipping a reader that fails later.

Full steps and the verification checklist: `DEPLOYMENT.md`.

## How reading is chosen

The app does not trust a flag. At boot it asks its own origin for
`vendor/tesseract/worker.min.js`:

- **served, and it is JavaScript** → on-device reading turns on, and the engine
  is then proved with a real smoke test before any receipt is scanned;
- **absent, or blocked** (a bare `file://` open, an embedded frame with no
  engine) → the reading UI stays off and the app uses the photo hand-off path:
  it captures and previews the photo, you transcribe it with any AI tool, paste
  the list back, and the normal import pipeline takes over.

`OCR STATUS: READY` appears only after a real scan completes. Nothing is
reported ready on the strength of a download or a cached model.

## Optional: the paid server-side reader

`api/receipt-reader.js` reads receipts through the Anthropic Messages API. It is
a fallback only, used when a browser blocks Web Workers. It is inert unless you
set `ANTHROPIC_KEY` yourself:

```
ANTHROPIC_API_KEY=…      # server-side only — never NEXT_PUBLIC_*, VITE_*, REACT_APP_*
ANTHROPIC_MODEL=…        # optional, default claude-sonnet-5
```

The browser never holds the key and never calls Anthropic directly.

## What works with no deployment at all

Opening `index.html` from any static host gives you people, item import (paste
a list from any AI), quantity-level splitting, country tax settings (Egypt 14% /
UAE 5% / Saudi 15% / custom), VAT inclusive or exclusive, service charge,
discount, the transparent breakdown, and native sharing.
