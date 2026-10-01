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
vp test run -t 'title|Title' \
  apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts
vp test run \
  packages/client-runtime/src/state/sharedSettings.test.ts \
  packages/client-runtime/src/state/entities.test.ts \
  apps/web/src/components/settings/settingsSearch.test.ts \
  apps/web/src/components/Sidebar.logic.test.ts
vp run build:desktop
