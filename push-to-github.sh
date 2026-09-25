#!/usr/bin/env bash
# GOD'S EYE — one-shot GitHub upload.
#
#   ./push-to-github.sh <github-username> <repo-name> <github-token> [public|private]
#
# Creates the repo (if missing) via the GitHub API and pushes main.
# The token needs the 'repo' scope (classic) or contents+administration (fine-grained).
set -euo pipefail

USER_NAME="${1:?usage: push-to-github.sh <github-username> <repo-name> <github-token> [public|private]}"
REPO_NAME="${2:?missing repo name}"
TOKEN="${3:?missing GitHub token}"
VISIBILITY="${4:-public}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
API="https://api.github.com"

echo "→ checking repo ${USER_NAME}/${REPO_NAME} …"
EXISTS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${TOKEN}" "${API}/repos/${USER_NAME}/${REPO_NAME}")

if [ "$EXISTS" = "404" ]; then
  echo "→ creating ${VISIBILITY} repo …"
  curl -s -X POST -H "Authorization: Bearer ${TOKEN}" -H "Accept: application/vnd.github+json" \
    "${API}/user/repos" \
    -d "{\"name\":\"${REPO_NAME}\",\"description\":\"God's Eye — 3D globe mapping 17,000+ public CCTV / traffic cameras at their exact coordinates. Click a camera icon, watch the live feed.\",\"${VISIBILITY}\":true}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print('   created:', d.get('html_url') or d)"
fi

cd "$ROOT"
git branch -M main 2>/dev/null || true
if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "https://x-access-token:${TOKEN}@github.com/${USER_NAME}/${REPO_NAME}.git"
else
  git remote set-url origin "https://x-access-token:${TOKEN}@github.com/${USER_NAME}/${REPO_NAME}.git"
fi

echo "→ pushing main …"
git push -u origin main
echo "→ stripping token from remote URL …"
git remote set-url origin "https://github.com/${USER_NAME}/${REPO_NAME}.git"
echo ""
echo "✅ LIVE AT  https://github.com/${USER_NAME}/${REPO_NAME}"
