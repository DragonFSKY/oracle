#!/bin/bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$project_dir"

./gradlew --no-daemon assembleDebug
printf '%s\n' "$project_dir/app/build/outputs/apk/debug/app-debug.apk"
