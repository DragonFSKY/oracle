#!/bin/bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"

pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run build

if command -v dotnet >/dev/null 2>&1; then
  pnpm run build:client:windows
else
  printf 'Skipping Windows client: dotnet SDK is not installed.\n' >&2
fi

if [[ -n "${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}" ]]; then
  pnpm run build:client:android
else
  printf 'Skipping Android client: ANDROID_SDK_ROOT/ANDROID_HOME is not set.\n' >&2
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  apps/relay-operator-macos/build-app.sh
fi
