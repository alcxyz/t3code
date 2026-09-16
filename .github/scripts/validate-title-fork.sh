#!/usr/bin/env bash
set -euo pipefail

for workspace in packages/contracts packages/shared packages/client-runtime apps/server apps/web apps/mobile; do
  (cd "$workspace" && vp run typecheck)
done

mapfile -t title_tests < <(
  git ls-files apps/server apps/web apps/mobile packages/contracts packages/client-runtime |
    rg -i '(title.*\.test\.(ts|tsx)$|threadListV2\.test\.ts$|thread-title-rename\.test\.ts$)'
)
if ((${#title_tests[@]} == 0)); then
  echo 'No title tests found; refusing to publish an unverified fork.' >&2
  exit 1
fi
vp test run "${title_tests[@]}"
vp run build:desktop
