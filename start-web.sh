#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo 'SAS needs Node.js 22+ and npm: https://nodejs.org/en/download'
  exit 1
fi
if [ ! -d node_modules/express ] || [ ! -d node_modules/google-translate-api-x ]; then npm ci --omit=dev; fi
if [ ! -f dist/index.html ]; then npm ci --include=dev; npm run build; fi
exec node server/web.mjs "$@"
