# Tesseract engine — served from this app's own origin

Empty until you run `./setup.sh` from the app root. Expected layout:

    vendor/tesseract/
      tesseract.min.js          tesseract.js 5.1.1
      worker.min.js             the Worker script — MUST be same-origin
      core/                     tesseract.js-core 5.1.1 (WASM)
      lang/eng.traineddata.gz   English model
      lang/ara.traineddata.gz   Arabic model (optional)

Why bundled rather than fetched from a CDN: a browser refuses
`new Worker('https://cdn.example/worker.js')` across origins. Serving the
worker from this origin removes that restriction entirely.

Everything here is Apache-2.0 licensed and free. No key, no account. Receipt
photos are read in the browser and are never uploaded.
