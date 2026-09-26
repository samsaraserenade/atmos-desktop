param(
  [string]$StoragePath = (Join-Path $env:APPDATA "atmos\connections-storage"),
  [string]$Destination = "$PSScriptRoot\sources-to-upload.json"
)

$ErrorActionPreference = "Stop"

function Read-ConnectionJson([string]$Name) {
  $path = Join-Path $StoragePath "$Name.json"
  if (-not (Test-Path -LiteralPath $path)) { return [pscustomobject]@{} }
  return Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
}

function Get-Addresses($Document) {
  if ($null -eq $Document.addresses) { return @() }
  return @($Document.addresses | ForEach-Object {
    if ($_ -is [string]) { $_ }
    elseif ($_.addr) { [string]$_.addr }
    elseif ($_.address) { [string]$_.address }
  } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
}

$binance = Read-ConnectionJson "binance-spot"
$aptos = Get-Addresses (Read-ConnectionJson "aptos-wallet")
$bsc = Get-Addresses (Read-ConnectionJson "bsc-wallet")
$cardano = Get-Addresses (Read-ConnectionJson "cardano-wallet")
$injective = Get-Addresses (Read-ConnectionJson "inj-wallet")
$solanaDocument = Read-ConnectionJson "solana-wallet"
$solana = Get-Addresses $solanaDocument
$monero = Read-ConnectionJson "monero-wallet"
$manualWallet = @($monero.wallets | Where-Object { $_.manual }) | Select-Object -First 1
$manualXmr = if ($null -ne $manualWallet) { [double]$manualWallet.manualXmr } else { 0.0 }
$jupiterKey = if ($solanaDocument.PSObject.Properties.Name -contains "jup-api-key") {
  [string]$solanaDocument.'jup-api-key'
} else { "" }

$apiKey = [string]$binance.creds.key
$apiSecret = [string]$binance.creds.secret

$config = [ordered]@{
  poll_seconds = 60
  sources = [ordered]@{
    "binance-spot" = [ordered]@{
      enabled = [bool]($apiKey -and $apiSecret)
      api_key = $apiKey
      api_secret = $apiSecret
    }
    "aptos-wallet" = [ordered]@{ enabled = ($aptos.Count -gt 0); addresses = @($aptos) }
    "bsc-wallet" = [ordered]@{ enabled = ($bsc.Count -gt 0); addresses = @($bsc) }
    "cardano-wallet" = [ordered]@{ enabled = ($cardano.Count -gt 0); addresses = @($cardano) }
    "inj-wallet" = [ordered]@{ enabled = ($injective.Count -gt 0); addresses = @($injective) }
    "monero-wallet" = [ordered]@{ enabled = ($null -ne $manualWallet); amount = $manualXmr }
    "solana-wallet" = [ordered]@{
      enabled = ($solana.Count -gt 0)
      addresses = @($solana)
      jupiter_api_key = $jupiterKey
    }
  }
}

$json = $config | ConvertTo-Json -Depth 8
[void](ConvertFrom-Json $json)
[IO.File]::WriteAllText($Destination, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

$apiKey = $null
$apiSecret = $null
$jupiterKey = $null
$manualXmr = 0
$json = $null
