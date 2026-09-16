#!/usr/bin/env bash
set -euo pipefail

feature=feat/automatic-thread-titles
case "${1:-}" in
  prepare)
    test -z "$(git status --porcelain)"
    feature_head=$(git rev-parse HEAD)
    git fetch --no-tags origin main "$feature"
    test "$feature_head" = "$(git rev-parse "origin/$feature")"
    git fetch --no-tags https://github.com/pingdotgg/t3code.git \
      main:refs/remotes/upstream/main
    upstream_head=$(git rev-parse upstream/main)
    # Never overwrite an unexpected change to the upstream mirror.
    git merge-base --is-ancestor origin/main "$upstream_head"
    git push origin "$upstream_head:refs/heads/main"
    printf 'feature_head=%s\n' "$feature_head" >> "$GITHUB_OUTPUT"
    if git merge-base --is-ancestor "$upstream_head" HEAD && \
      [[ "${FORCE_VALIDATION:-false}" != true ]]; then
      echo 'validate=false' >> "$GITHUB_OUTPUT"
      exit 0
    fi
    git merge --no-edit "$upstream_head"
    python3 - "$upstream_head" <<'PY'
import json
import pathlib
import subprocess
import sys

revision = sys.argv[1]
package = json.loads(subprocess.check_output(
    ["git", "show", f"{revision}:apps/server/package.json"], text=True
))
pathlib.Path(".github/fork-source.json").write_text(json.dumps({
    "upstreamRevision": revision,
    "version": package["version"],
}, indent=2) + "\n")
PY
    git add .github/fork-source.json
    if ! git diff --cached --quiet; then
      git commit -m 'chore(fork): record upstream source baseline'
    fi
    echo 'validate=true' >> "$GITHUB_OUTPUT"
    ;;
  publish)
    : "${EXPECTED_FEATURE_HEAD:?expected feature head is required}"
    test -z "$(git status --porcelain)"
    git fetch --no-tags origin "$feature"
    test "$(git rev-parse "origin/$feature")" = "$EXPECTED_FEATURE_HEAD"
    git merge-base --is-ancestor "$EXPECTED_FEATURE_HEAD" HEAD
    # Normal fast-forward push also rejects a race after the check above.
    git push origin "HEAD:refs/heads/$feature"
    printf 'Validated feature commit: %s\n' "$(git rev-parse HEAD)" >> "$GITHUB_STEP_SUMMARY"
    ;;
  *) echo 'Usage: fork-sync.sh prepare|publish' >&2; exit 2 ;;
esac
