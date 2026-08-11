#!/bin/bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")" && pwd)"
apk="$project_dir/app/build/outputs/apk/debug/app-debug.apk"

if [[ ! -f "$apk" ]]; then
  "$project_dir/build.sh"
fi

adb install -r "$apk"
printf 'Installed: %s\n' "$apk"
