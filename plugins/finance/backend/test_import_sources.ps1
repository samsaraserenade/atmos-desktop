$ErrorActionPreference = "Stop"
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("atmos-import-test-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  $fixtures = @{
    "binance-spot.json" = '{"creds":{"key":"test-key","secret":"test-secret"}}'
    "aptos-wallet.json" = '{"addresses":[{"addr":"aptos-one","label":""}]}'
    "bsc-wallet.json" = '{"addresses":[{"addr":"bsc-one","label":""}]}'
    "cardano-wallet.json" = '{"addresses":[{"addr":"ada-one","label":""}]}'
    "inj-wallet.json" = '{"addresses":[{"addr":"inj-one","label":""}]}'
    "monero-wallet.json" = '{"wallets":[{"manual":true,"manualXmr":1.25}]}'
    "solana-wallet.json" = '{"addresses":[{"addr":"sol-one"},{"addr":"sol-two"}]}'
  }
  foreach ($item in $fixtures.GetEnumerator()) {
    [IO.File]::WriteAllText((Join-Path $temporary $item.Key), $item.Value)
  }
  $output = Join-Path $temporary "output.json"
  & "$PSScriptRoot\import-existing-sources.ps1" -StoragePath $temporary -Destination $output
  $result = Get-Content -Raw -LiteralPath $output | ConvertFrom-Json
  foreach ($name in @('aptos-wallet','bsc-wallet','cardano-wallet','inj-wallet','solana-wallet')) {
    if ($result.sources.$name.addresses -isnot [array]) { throw "$name was not serialized as an array" }
  }
  if ($result.sources.'solana-wallet'.addresses.Count -ne 2) { throw "Solana address count changed" }
  Write-Output "Import shape test passed"
}
finally {
  $resolved = [IO.Path]::GetFullPath($temporary)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a test directory outside the system temp folder"
  }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
