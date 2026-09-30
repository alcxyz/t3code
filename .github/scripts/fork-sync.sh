#!/usr/bin/env bash
set -euo pipefail

feature=${FEATURE_BRANCH:-feat/automatic-thread-titles}
upstream_url=${FORK_UPSTREAM_URL:-https://github.com/pingdotgg/t3code.git}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
git check-ref-format --branch "$feature" >/dev/null
case "$feature" in
  fork/stable|fork/nightly) echo 'A published channel cannot be the control branch' >&2; exit 2 ;;
esac

channel_ref() {
  case "$1" in
    stable|nightly) printf 'fork/%s' "$1" ;;
    *) echo 'Expected stable or nightly channel' >&2; exit 2 ;;
  esac
}

remote_head() {
  git ls-remote --heads origin "refs/heads/$1" | awk '{print $1}'
}

case "${1:-}" in
  prepare)
    channel=${2:?channel required}
    branch=$(channel_ref "$channel")
    test -z "$(git status --porcelain)"
    feature_head=$(git rev-parse HEAD)
    git fetch --no-tags --no-recurse-submodules origin \
      "+refs/heads/$feature:refs/remotes/origin/$feature"
    test "$feature_head" = "$(git rev-parse "origin/$feature")"

    read -r release_tag version < <(python3 "$script_dir/fork-release.py" "$channel")
    git fetch --no-tags --no-recurse-submodules "$upstream_url" "refs/tags/$release_tag"
    upstream_head=$(git rev-parse 'FETCH_HEAD^{commit}')
    baseline=$(python3 - <<'PY'
import json
source = json.load(open('.github/fork-source.json'))
if set(source) != {'upstreamRevision', 'version'}:
    raise SystemExit('Control branch requires legacy baseline metadata')
print(source['upstreamRevision'])
PY
)
    git cat-file -e "$baseline^{commit}"
    git merge-base --is-ancestor "$baseline" "$feature_head"

    previous=$(remote_head "$branch")
    if [[ -n "$previous" ]]; then
      git fetch --no-tags --no-recurse-submodules origin \
        "+refs/heads/$branch:refs/remotes/origin/$branch"
      test "$previous" = "$(git rev-parse "origin/$branch")"
      if python3 - "$branch" "$channel" "$release_tag" "$version" "$upstream_head" "$feature_head" <<'PY'
import json
import subprocess
import sys
branch, channel, tag, version, upstream, feature = sys.argv[1:]
try:
    actual = json.loads(subprocess.check_output(
        ['git', 'show', f'origin/{branch}:.github/fork-source.json'], text=True
    ))
except (subprocess.CalledProcessError, json.JSONDecodeError):
    sys.exit(1)
expected = dict(channel=channel, releaseTag=tag, version=version,
                upstreamRevision=upstream, featureRevision=feature)
sys.exit(0 if actual == expected else 1)
PY
      then
        if [[ "${FORCE_VALIDATION:-false}" == true ]]; then
          git reset --hard "$previous"
          printf 'validate=true\nfeature_head=%s\nprevious_head=%s\ncandidate_head=%s\nrelease_tag=%s\nupstream_head=%s\n' \
            "$feature_head" "$previous" "$previous" "$release_tag" "$upstream_head" >> "$GITHUB_OUTPUT"
        else
          printf 'validate=false\n' >> "$GITHUB_OUTPUT"
          printf 'Channel %s already has release %s and feature %s.\n' \
            "$channel" "$release_tag" "$feature_head" >> "$GITHUB_STEP_SUMMARY"
        fi
        exit 0
      fi
    fi

    # Apply only the control branch tree delta, never its old upstream merges.
    patch=$(mktemp)
    trap 'rm -f "$patch"' EXIT
    git diff --binary "$baseline" "$feature_head" -- . \
      ':(exclude).github/fork-source.json' > "$patch"
    git read-tree "$upstream_head"
    if ! git apply --cached --3way "$patch"; then
      echo 'Feature overlay conflicts with the release; channel unchanged.' >&2
      exit 1
    fi
    if [[ -n "$(git ls-files -u)" ]]; then
      echo 'Feature overlay has unresolved paths; channel unchanged.' >&2
      exit 1
    fi
    metadata_blob=$(python3 - "$channel" "$release_tag" "$version" "$upstream_head" "$feature_head" <<'PY' | git hash-object -w --stdin
import json
import sys
channel, tag, version, upstream, feature = sys.argv[1:]
print(json.dumps(dict(channel=channel, releaseTag=tag, version=version,
                      upstreamRevision=upstream, featureRevision=feature), indent=2))
PY
)
    git update-index --add --cacheinfo "100644,$metadata_blob,.github/fork-source.json"
    tree=$(git write-tree)
    if [[ -n "$previous" ]]; then
      candidate=$(printf 'chore(fork): update %s from %s\n\nApply automatic titles to the published %s release.\n' \
        "$channel" "$release_tag" "$channel" | git commit-tree "$tree" -p "$previous" -p "$upstream_head")
    else
      candidate=$(printf 'chore(fork): start %s from %s\n\nApply automatic titles to the published %s release.\n' \
        "$channel" "$release_tag" "$channel" | git commit-tree "$tree" -p "$upstream_head")
    fi
    git reset --hard "$candidate"
    printf 'validate=true\nfeature_head=%s\nprevious_head=%s\ncandidate_head=%s\nrelease_tag=%s\nupstream_head=%s\n' \
      "$feature_head" "$previous" "$candidate" "$release_tag" "$upstream_head" >> "$GITHUB_OUTPUT"
    ;;
  publish)
    channel=${2:?channel required}
    branch=$(channel_ref "$channel")
    : "${EXPECTED_FEATURE_HEAD:?expected feature head is required}"
    : "${EXPECTED_CANDIDATE_HEAD:?expected candidate head is required}"
    test -z "$(git status --porcelain)"
    test "$(git rev-parse HEAD)" = "$EXPECTED_CANDIDATE_HEAD"
    git fetch --no-tags --no-recurse-submodules origin \
      "+refs/heads/$feature:refs/remotes/origin/$feature"
    test "$(git rev-parse "origin/$feature")" = "$EXPECTED_FEATURE_HEAD"
    actual=$(remote_head "$branch")
    test "$actual" = "${EXPECTED_PREVIOUS_HEAD:-}"
    if [[ -n "$actual" ]]; then
      git merge-base --is-ancestor "$actual" HEAD
    fi
    # The lease is an atomic expected-head check. The ancestor test ensures FF.
    git push --force-with-lease="refs/heads/$branch:${EXPECTED_PREVIOUS_HEAD:-}" \
      origin "HEAD:refs/heads/$branch"
    printf 'Validated %s channel commit: %s\n' "$channel" "$(git rev-parse HEAD)" \
      >> "$GITHUB_STEP_SUMMARY"
    ;;
  *) echo 'Usage: fork-sync.sh prepare|publish stable|nightly' >&2; exit 2 ;;
esac
