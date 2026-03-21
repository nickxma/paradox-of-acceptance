#!/usr/bin/env bash
# sync-design-tokens.sh
#
# Copies shared design token CSS files from paradox-of-acceptance/shared/
# into each consumer repo for local development.
#
# Production sites use the jsDelivr CDN version. This script is for:
#   - Offline development without CDN latency
#   - Testing token changes before pushing to main
#   - Verifying all repos have the expected link tags
#
# Usage:
#   ./tools/sync-design-tokens.sh          # check status (dry run)
#   ./tools/sync-design-tokens.sh --apply  # copy files to all repos

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED_DIR="$SCRIPT_DIR/../shared"
PROJECTS_DIR="$HOME/projects"

REPOS=(
  "mindfulness-wiki"
  "mindfulness-pointers"
  "mindfulness-fit"
  "concept-explorer"
  "mindfulness-essays"
)

CDN_BASE="https://cdn.jsdelivr.net/gh/nickxma/paradox-of-acceptance@main/shared"
APPLY=false

if [[ "${1:-}" == "--apply" ]]; then
  APPLY=true
fi

echo "Shared design token files in paradox-of-acceptance/shared/:"
for f in "$SHARED_DIR"/*.css; do
  echo "  $(basename "$f")"
done
echo ""

if $APPLY; then
  echo "Syncing to consumer repos..."
  for repo in "${REPOS[@]}"; do
    repo_path="$PROJECTS_DIR/$repo"
    if [ -d "$repo_path" ]; then
      mkdir -p "$repo_path/shared"
      cp "$SHARED_DIR/"*.css "$repo_path/shared/"
      echo "  ✓ $repo/shared/ updated"
    else
      echo "  ⚠ Not found: $repo_path"
    fi
  done
  echo ""
  echo "Done. Local copies are now in sync."
  echo "NOTE: Production sites use CDN — commit to paradox-of-acceptance/main to update them."
else
  echo "Status check (dry run — use --apply to copy files):"
  for repo in "${REPOS[@]}"; do
    repo_path="$PROJECTS_DIR/$repo"
    if [ -d "$repo_path" ]; then
      if [ -d "$repo_path/shared" ]; then
        echo "  ✓ $repo/shared/ exists"
      else
        echo "  ✗ $repo/shared/ missing (run with --apply)"
      fi
    else
      echo "  ⚠ Repo not cloned: $repo"
    fi
  done
fi

echo ""
echo "CDN base URL (production):"
echo "  $CDN_BASE"
echo ""
echo "To update all production sites:"
echo "  1. Edit files in paradox-of-acceptance/shared/"
echo "  2. git commit && git push origin main"
echo "  3. CDN cache refreshes within ~24h"
echo "  4. Force immediate refresh: https://www.jsdelivr.com/tools/purge"
