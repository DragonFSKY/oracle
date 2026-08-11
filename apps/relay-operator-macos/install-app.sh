#!/bin/bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")" && pwd)"
source_app="$project_dir/.build/Oracle Relay.app"
destination_dir="$HOME/Applications"
destination_app="$destination_dir/Oracle Relay.app"
launch_agents_dir="$HOME/Library/LaunchAgents"
launch_agent="$launch_agents_dir/fun.dragonfsky.oracle-relay-operator.plist"
log_dir="$HOME/Library/Logs/OracleRelay"
log_path="$log_dir/operator.log"

test -d "$source_app"
/bin/mkdir -p "$destination_dir" "$launch_agents_dir" "$log_dir"

/usr/bin/pkill -x OracleRelayOperator >/dev/null 2>&1 || true
/bin/sleep 1

if [[ -e "$destination_app" ]]; then
  previous_app="${TMPDIR:-/tmp}/Oracle Relay.previous.$$"
  /bin/mv "$destination_app" "$previous_app"
fi

/usr/bin/ditto "$source_app" "$destination_app"
/bin/cp "$project_dir/LaunchAgent.plist" "$launch_agent"
/usr/bin/plutil -replace ProgramArguments -json "[\"/usr/bin/open\",\"$destination_app\"]" "$launch_agent"
/usr/bin/plutil -replace StandardOutPath -string "$log_path" "$launch_agent"
/usr/bin/plutil -replace StandardErrorPath -string "$log_path" "$launch_agent"

uid="$(id -u)"
/bin/launchctl bootout "gui/$uid/fun.dragonfsky.oracle-relay-operator" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/$uid" "$launch_agent"
/bin/launchctl kickstart -k "gui/$uid/fun.dragonfsky.oracle-relay-operator"

if [[ -n "${previous_app:-}" && -e "$previous_app" ]]; then
  /bin/rm -rf "$previous_app"
fi

printf 'Installed: %s\n' "$destination_app"
printf 'Log: %s\n' "$log_path"
