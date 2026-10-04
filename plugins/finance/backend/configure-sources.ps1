param(
  [string]$Server = "",
  [string]$SshKeyPath = ""
)

$ErrorActionPreference = "Stop"

# Your server and SSH key come from the parameters, or from deploy.local.json
# beside this script (gitignored; copy deploy.example.json to start).
$deployFile = Join-Path $PSScriptRoot "deploy.local.json"
if ((-not $Server -or -not $SshKeyPath) -and (Test-Path -LiteralPath $deployFile)) {
  $deploy = Get-Content -Raw -LiteralPath $deployFile | ConvertFrom-Json
  if (-not $Server) { $Server = [string]$deploy.server }
  if (-not $SshKeyPath) { $SshKeyPath = [string]$deploy.sshKeyPath }
}
if (-not $Server -or -not $SshKeyPath) {
  throw "Set the server and SSH key: pass -Server and -SshKeyPath, or copy deploy.example.json to deploy.local.json and fill it in."
}

if (-not (Test-Path -LiteralPath $SshKeyPath)) {
  throw "SSH key not found at the configured path."
}

Write-Host "Atmos VPS finance setup"
Write-Host "The server asks for each source's settings itself (collectors.py configure),"
Write-Host "so every source it has a connector for is offered. Every answer is masked and"
Write-Host "goes straight to your private server over SSH; nothing is written here."
Write-Host "Leave anything blank to keep that source disabled."
Write-Host ""

# sources.sh keeps them encrypted on the server (systemd-creds) and restarts
# the collector with them.
$remote = @"
set -eu
/opt/atmos-portfolio/sources.sh configure
systemctl is-active atmos-portfolio-collector.service
"@

# -t: the prompts need the server's terminal.
& ssh -t -i $SshKeyPath -o BatchMode=yes -o ConnectTimeout=10 "root@$Server" $remote
if ($LASTEXITCODE -ne 0) { throw "The configuration or collector start failed (the server needs portfolio server 0.9 or later: run upgrade.sh first)." }

Write-Host ""
Write-Host "Configuration saved on the server and collector started."
Write-Host "You can close this terminal."
