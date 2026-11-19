#!/bin/sh
# Run browser scripts from scripts/ against the preview (run scripts/dev/preview.sh first).
# Usage: scripts/dev/test-browser.sh [script names without .mjs]   (no names = all of them)
# Installs Playwright into .cache/browser on first use and uses the local Google Chrome.
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel); cd "$ROOT" || exit 1
if [ ! -f .cache/browser/node_modules/playwright/index.mjs ]; then
  mkdir -p .cache/browser && npm install --prefix .cache/browser --no-save --no-package-lock playwright@1.65.1 >/dev/null || exit 1
fi
: "${CHROME_PATH:=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"; export CHROME_PATH
[ -x "$CHROME_PATH" ] || { echo "Google Chrome not found; set CHROME_PATH"; exit 1; }
names="$*"; [ -n "$names" ] || names=$(ls scripts/browser-*.mjs | xargs -n1 basename | sed 's/\.mjs$//')
status=0
for n in $names; do
  tmp="scripts/_t_$n.mjs"
  # Some scripts hard-code a Windows Chrome path or also probe a source-root portfolios/ folder; adapt both.
  sed -E "s#executablePath: ?'C:/Program Files/Google/Chrome/Application/chrome.exe'#executablePath:process.env.CHROME_PATH#; s#for\(const prefix of \['', '/build'\]\)#for(const prefix of ['/build'])#" "scripts/$n.mjs" > "$tmp"
  out=$(node "$tmp" 2>&1); code=$?; rm -f "$tmp"
  echo "== $n exit=$code"
  [ $code -eq 0 ] || { echo "$out" | grep -v '^    at ' | tail -15; status=1; }
done
exit $status
