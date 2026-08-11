$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($env:ORACLE_RELAY_OPERATOR_URL)) {
  throw "ORACLE_RELAY_OPERATOR_URL must be set before installation."
}
if ([string]::IsNullOrWhiteSpace($env:ORACLE_RELAY_OPERATOR_TOKEN)) {
  throw "ORACLE_RELAY_OPERATOR_TOKEN must be set before installation."
}
[Environment]::SetEnvironmentVariable(
  "ORACLE_RELAY_OPERATOR_URL",
  $env:ORACLE_RELAY_OPERATOR_URL,
  [EnvironmentVariableTarget]::User)
[Environment]::SetEnvironmentVariable(
  "ORACLE_RELAY_OPERATOR_TOKEN",
  $env:ORACLE_RELAY_OPERATOR_TOKEN,
  [EnvironmentVariableTarget]::User)
& (Join-Path $ProjectDir "build.ps1")

$SourceDir = Join-Path $ProjectDir ".build\win-x64"
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\Oracle Relay"
$Executable = Join-Path $InstallDir "OracleRelayOperator.exe"
$TaskName = "Oracle Relay Operator"
$UserId = "$env:COMPUTERNAME\$env:USERNAME"

Get-Process OracleRelayOperator -ErrorAction SilentlyContinue | Stop-Process -Force
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $SourceDir "*") $InstallDir -Recurse -Force
Unblock-File -LiteralPath $Executable

$Shell = New-Object -ComObject WScript.Shell
$StartMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Oracle Relay.lnk"
$Startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\Oracle Relay.lnk"
$Shortcut = $Shell.CreateShortcut($StartMenu)
$Shortcut.TargetPath = $Executable
$Shortcut.WorkingDirectory = $InstallDir
$Shortcut.Save()

# A process launched directly by Windows OpenSSH is terminated with its SSH job.
# Use an interactive logon task so remote installs stay visible on the user's desktop.
if (Test-Path -LiteralPath $Startup) { Remove-Item -LiteralPath $Startup -Force }
$Action = New-ScheduledTaskAction -Execute $Executable -WorkingDirectory $InstallDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew
Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Settings $Settings `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed: $Executable"
Write-Output "Auto-start task: $TaskName ($UserId)"
