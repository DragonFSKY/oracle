$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$OutputDir = Join-Path $ProjectDir ".build\win-x64"

dotnet publish (Join-Path $ProjectDir "OracleRelayOperator.Windows.csproj") `
  --configuration Release `
  --runtime win-x64 `
  --self-contained true `
  -p:PublishSingleFile=true `
  --output $OutputDir

Write-Output (Join-Path $OutputDir "OracleRelayOperator.exe")
