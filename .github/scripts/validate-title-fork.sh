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
  packages/contracts/src/orchestration.test.ts \
  packages/contracts/src/settings.test.ts \
  packages/shared/src/serverSettings.test.ts \
  packages/client-runtime/src/operations/commands.test.ts \
  packages/client-runtime/src/state/sharedSettings.test.ts \
  apps/server/src/provider/Layers/ProviderService.test.ts \
  apps/server/src/provider/RuntimeInstructions.test.ts \
  apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts \
  apps/web/src/components/threadActionMenu.logic.test.ts \
  apps/web/src/components/settings/settingsSearch.test.ts \
  apps/mobile/src/features/settings/SettingsRouteScreen.logic.test.ts
vp run build:desktop
