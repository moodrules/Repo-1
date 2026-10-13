#!/usr/bin/env bash
# Downloads the free Tesseract OCR engine into vendor/tesseract/ so the app
# serves it from its OWN origin. A Worker script may not be constructed from a
# different origin — that is why bundling, not a CDN, is the fix.
#
#   ./setup.sh          English only (default)
#   ./setup.sh eng ara  English + Arabic
set -euo pipefail

TESSERACT_VERSION="5.1.1"
CORE_VERSION="5.1.1"
LANGS=("${@:-eng}")
DIR="$(cd "$(dirname "$0")" && pwd)/vendor/tesseract"

mkdir -p "$DIR/core" "$DIR/lang"
echo "Fetching tesseract.js $TESSERACT_VERSION into $DIR"

curl -fsSL -o "$DIR/tesseract.min.js" \
  "https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js"
curl -fsSL -o "$DIR/worker.min.js" \
  "https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js"

for f in tesseract-core.wasm.js tesseract-core-simd.wasm.js \
         tesseract-core-lstm.wasm.js tesseract-core-simd-lstm.wasm.js; do
  curl -fsSL -o "$DIR/core/$f" \
    "https://cdn.jsdelivr.net/npm/tesseract.js-core@${CORE_VERSION}/$f" || echo "  (optional: $f not present in this version)"
done

for lang in "${LANGS[@]}"; do
  echo "Fetching language model: $lang"
  curl -fsSL -o "$DIR/lang/${lang}.traineddata.gz" \
    "https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}@1.0.0/4.0.0/${lang}.traineddata.gz"
done

echo
echo "Done. Serve the folder over http and open index.html:"
echo "  python3 -m http.server 8000"
echo "  http://localhost:8000/"
echo "Then open Add check → Run diagnostics; Engine source should read 'local (same origin)'."
