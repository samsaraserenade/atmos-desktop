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

function Read-MaskedValue([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Read-AddressList([string]$Label) {
  $value = Read-MaskedValue "$Label addresses, separated by commas (blank to disable)"
  if ([string]::IsNullOrWhiteSpace($value)) { return @() }
  return @($value -split "[,;]" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

if (-not (Test-Path -LiteralPath $SshKeyPath)) {
  throw "SSH key not found at the configured path."
}

Write-Host "Atmos VPS finance setup"
Write-Host "Every response is masked and sent directly to your private server."
Write-Host "Leave anything blank to keep that source disabled."
Write-Host ""

$binanceKey = Read-MaskedValue "Binance read-only API key (blank to disable)"
$binanceSecret = ""
if ($binanceKey) {
  $binanceSecret = Read-MaskedValue "Binance read-only API secret"
  if (-not $binanceSecret) { throw "A Binance secret is required when a key is provided." }
}

$aptos = Read-AddressList "Aptos"
$arbitrum = Read-AddressList "Arbitrum"
$bsc = Read-AddressList "BSC"
$cardano = Read-AddressList "Cardano"
$hyperliquid = Read-AddressList "Hyperliquid"
$injective = Read-AddressList "Injective"
$solana = Read-AddressList "Solana"
$jupiterLocks = Read-AddressList "Jupiter Lock escrow"
$jupiterKey = ""
if ($solana.Count -gt 0) {
  $jupiterKey = Read-MaskedValue "Jupiter API key (blank allows native SOL and stablecoins only)"
}

$moneroRaw = Read-MaskedValue "Manual XMR amount (blank to disable)"
$moneroAmount = 0.0
if ($moneroRaw) {
  if (-not [double]::TryParse(
      $moneroRaw,
      [Globalization.NumberStyles]::Float,
      [Globalization.CultureInfo]::InvariantCulture,
      [ref]$moneroAmount) -or $moneroAmount -lt 0) {
    throw "The XMR amount must be a non-negative number using a decimal point."
  }
}

$config = [ordered]@{
  poll_seconds = 60
  sources = [ordered]@{
    "binance-spot" = [ordered]@{
      enabled = [bool]($binanceKey -and $binanceSecret)
      api_key = $binanceKey
      api_secret = $binanceSecret
    }
    "aptos-wallet" = [ordered]@{ enabled = ($aptos.Count -gt 0); addresses = @($aptos) }
    "arbitrum-wallet" = [ordered]@{ enabled = ($arbitrum.Count -gt 0); addresses = @($arbitrum) }
    "bsc-wallet" = [ordered]@{ enabled = ($bsc.Count -gt 0); addresses = @($bsc) }
    "cardano-wallet" = [ordered]@{ enabled = ($cardano.Count -gt 0); addresses = @($cardano) }
    "hyperliquid-wallet" = [ordered]@{ enabled = ($hyperliquid.Count -gt 0); addresses = @($hyperliquid) }
    "inj-wallet" = [ordered]@{ enabled = ($injective.Count -gt 0); addresses = @($injective) }
    "monero-wallet" = [ordered]@{ enabled = [bool]$moneroRaw; amount = $moneroAmount }
    "solana-wallet" = [ordered]@{
      enabled = ($solana.Count -gt 0)
      addresses = @($solana)
      jupiter_api_key = $jupiterKey
      jupiter_locks = @($jupiterLocks)
    }
  }
}

$json = $config | ConvertTo-Json -Depth 8 -Compress
[void](ConvertFrom-Json $json)

$remote = @"
set -eu
temporary=/etc/.atmos-portfolio-sources.json.new
umask 077
tee "`$temporary" >/dev/null
python3 -m json.tool "`$temporary" >/dev/null
chown root:atmos-portfolio "`$temporary"
chmod 0640 "`$temporary"
mv -f "`$temporary" /etc/atmos-portfolio-sources.json
systemctl restart atmos-portfolio-collector.service
systemctl is-active atmos-portfolio-collector.service
"@

$json | & ssh -i $SshKeyPath -o BatchMode=yes -o ConnectTimeout=10 "root@$Server" $remote
if ($LASTEXITCODE -ne 0) { throw "The private transfer or collector start failed." }

$json = $null
$binanceKey = $null
$binanceSecret = $null
$jupiterKey = $null
$moneroRaw = $null

Write-Host ""
Write-Host "Configuration transferred directly and collector started."
Write-Host "You can close this terminal."
