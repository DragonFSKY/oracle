#!/bin/bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$project_dir"

swift build -c release

app_dir="$project_dir/.build/Oracle Relay.app"
contents_dir="$app_dir/Contents"
executable_dir="$contents_dir/MacOS"
resources_dir="$contents_dir/Resources"
iconset_dir="$project_dir/.build/OracleRelay.iconset"

if [[ -e "$app_dir" ]]; then
  /bin/rm -rf "$app_dir"
fi
/bin/mkdir -p "$executable_dir" "$resources_dir"
/bin/cp "$project_dir/.build/release/OracleRelayOperator" "$executable_dir/OracleRelayOperator"
/bin/cp "$project_dir/Info.plist" "$contents_dir/Info.plist"

relay_url="${ORACLE_RELAY_OPERATOR_URL:-}"
operator_token="${ORACLE_RELAY_OPERATOR_TOKEN:-}"
if [[ -n "$relay_url" ]]; then
  /usr/bin/plutil -replace OracleRelayURL -string "$relay_url" "$contents_dir/Info.plist"
fi
if [[ -n "$operator_token" ]]; then
  /usr/bin/plutil -replace OracleRelayOperatorToken -string "$operator_token" "$contents_dir/Info.plist"
fi

if [[ -e "$iconset_dir" ]]; then
  /bin/rm -rf "$iconset_dir"
fi
/bin/mkdir -p "$iconset_dir"
/usr/bin/sips -z 16 16 "$project_dir/OracleRelayIcon.png" --out "$iconset_dir/icon_16x16.png" >/dev/null
/usr/bin/sips -z 32 32 "$project_dir/OracleRelayIcon.png" --out "$iconset_dir/icon_16x16@2x.png" >/dev/null
/usr/bin/sips -z 32 32 "$project_dir/OracleRelayIcon.png" --out "$iconset_dir/icon_32x32.png" >/dev/null
/usr/bin/sips -z 64 64 "$project_dir/OracleRelayIcon.png" --out "$iconset_dir/icon_32x32@2x.png" >/dev/null
/usr/bin/sips -z 128 128 "$project_dir/OracleRelayIcon.png" --out "$iconset_dir/icon_128x128.png" >/dev/null
/usr/bin/sips -z 256 256 "$project_dir/OracleRelayIcon.png" --out "$iconset_dir/icon_128x128@2x.png" >/dev/null
/usr/bin/sips -z 256 256 "$project_dir/OracleRelayIcon.png" --out "$iconset_dir/icon_256x256.png" >/dev/null
/usr/bin/sips -z 512 512 "$project_dir/OracleRelayIcon.png" --out "$iconset_dir/icon_256x256@2x.png" >/dev/null
/usr/bin/sips -z 512 512 "$project_dir/OracleRelayIcon.png" --out "$iconset_dir/icon_512x512.png" >/dev/null
/usr/bin/sips -z 1024 1024 "$project_dir/OracleRelayIcon.png" --out "$iconset_dir/icon_512x512@2x.png" >/dev/null
/usr/bin/iconutil -c icns "$iconset_dir" -o "$resources_dir/OracleRelayIcon.icns"
/usr/bin/codesign --force --deep --sign - "$app_dir"

printf '%s\n' "$app_dir"
