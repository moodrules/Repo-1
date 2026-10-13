#!/usr/bin/env bash
# Fetch the free Tesseract OCR engine into vendor/tesseract/ so the app serves
# it from its OWN origin. A browser refuses to construct a Worker from another
# origin, which is why bundling — not a CDN — is what makes on-device reading
# work. Runs on Vercel at build time, or locally before deploying.
#
#   ./setup.sh            English only (default)
#   ./setup.sh eng ara    English + Arabic
set -euo pipefail

TESSERACT_VERSION="5.1.1"
CORE_VERSION="5.1.1"
LANGS=("${@:-eng}")
ROOT="$(cd "$(dirname "$0")" && pwd)"
DIR="$ROOT/vendor/tesseract"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$DIR/core" "$DIR/lang"
echo "==> Fetching tesseract.js $TESSERACT_VERSION into $DIR"

# The npm tarballs carry every file the engine needs, so we don't have to guess
# which core variants a version ships.
( cd "$TMP" && npm pack --silent "tesseract.js@${TESSERACT_VERSION}" >/dev/null )
( cd "$TMP" && npm pack --silent "tesseract.js-core@${CORE_VERSION}" >/dev/null )

tar -xzf "$TMP"/tesseract.js-${TESSERACT_VERSION}.tgz -C "$TMP"
cp "$TMP/package/dist/tesseract.min.js" "$DIR/"
cp "$TMP/package/dist/worker.min.js"    "$DIR/"
rm -rf "$TMP/package"

tar -xzf "$TMP"/tesseract.js-core-${CORE_VERSION}.tgz -C "$TMP"
cp "$TMP"/package/*.wasm.js "$DIR/core/" 2>/dev/null || true
cp "$TMP"/package/*.wasm    "$DIR/core/" 2>/dev/null || true
rm -rf "$TMP/package"

for lang in "${LANGS[@]}"; do
  echo "==> Fetching language model: $lang"
  curl -fsSL -o "$DIR/lang/${lang}.traineddata.gz" \
    "https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}@1.0.0/4.0.0/${lang}.traineddata.gz" \
  || curl -fsSL -o "$DIR/lang/${lang}.traineddata.gz" \
    "https://tessdata.projectnaptha.com/4.0.0/${lang}.traineddata.gz"
done

# Fail loudly rather than deploying a half-built engine that fails in the browser.
missing=0
for f in "$DIR/tesseract.min.js" "$DIR/worker.min.js"; do
  [ -s "$f" ] || { echo "MISSING: $f"; missing=1; }
done
ls "$DIR/core"/*.wasm.js >/dev/null 2>&1 || { echo "MISSING: core wasm files"; missing=1; }
for lang in "${LANGS[@]}"; do
  [ -s "$DIR/lang/${lang}.traineddata.gz" ] || { echo "MISSING: ${lang}.traineddata.gz"; missing=1; }
done
if [ "$missing" -ne 0 ]; then
  echo "==> Engine incomplete — on-device reading would fail. Aborting."
  exit 1
fi

echo "==> Done:"
du -sh "$DIR" | sed 's/^/    /'
echo "    Serve over http and open the app; diagnostics should read 'Engine source: local'."
