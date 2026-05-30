#!/bin/bash
# Auto-push helper for the cpr-dashboard repo.
# Usage:  ./push.sh "your commit message"
# If no message provided, uses a default.

set -e
cd "$(dirname "$0")"

MSG="${1:-dashboard update}"

# Stage tracked files only (don't add new randoms by accident)
git add -u
# Plus any new files I explicitly want tracked (TODO.txt, PROJECT.md, etc.)
git add PROJECT.md TODO.txt dashboard.html api/ vercel.json index.html README.md .gitignore 2>/dev/null || true

if git diff --cached --quiet; then
  echo "No changes to commit."
  exit 0
fi

git commit -m "$MSG"
git pull --rebase origin main
git push origin main
echo "✓ Pushed. Vercel will auto-deploy in ~30s."
