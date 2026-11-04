#!/bin/bash
# SessionStart hook for Claude Code cloud sessions (#65): dependencies for npm test / build / E2E, and the
# preinstalled Chromium for Playwright (no "playwright install" needed).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# npm install (not ci) keeps an existing node_modules, which the cached container state reuses
npm install --no-audit --no-fund --loglevel=error

if [ -x /opt/pw-browsers/chromium ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export PW_CHROMIUM=/opt/pw-browsers/chromium' >> "$CLAUDE_ENV_FILE"
fi
