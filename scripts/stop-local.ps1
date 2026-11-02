$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$localRoot = Join-Path $projectRoot '.local-data'
& (Join-Path $PSScriptRoot 'start-counter-local.ps1') -Stop
# Stop only the Angular server whose command belongs to this exact checkout.
# Its launcher then closes the API and PostgreSQL in its finally block.
$listeners = Get-NetTCPConnection -State Listen -LocalPort 4200 -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
    $processInfo = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $listener.OwningProcess)
    if ($processInfo -and $processInfo.CommandLine -and $processInfo.CommandLine.Contains($projectRoot) -and $processInfo.CommandLine -match '@angular[\\/]cli[\\/]bin[\\/]ng\.js') {
        Stop-Process -Id $listener.OwningProcess -Force
    } elseif ($processInfo) {
        throw 'Port 4200 belongs to a different application. No unrelated process was stopped.'
    }
}
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $pidFile = Join-Path $localRoot 'api-process.json'
    if (-not (Test-Path -LiteralPath $pidFile)) { break }
    $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $apiProcess = Get-Process -Id $record.id -ErrorAction SilentlyContinue
    if (-not $apiProcess) { break }
    Start-Sleep -Milliseconds 250
}
if ($apiProcess) {
    $ticks = if ($record.startedAtTicks) { [int64]$record.startedAtTicks } else { ([DateTime]$record.startedAt).ToUniversalTime().Ticks }
    if ($apiProcess.Path -eq (Join-Path $localRoot 'bin/trafficbet-api.exe') -and $apiProcess.StartTime.ToUniversalTime().Ticks -eq $ticks) { Stop-Process -Id $apiProcess.Id -Force }
}
$pgCtl = Join-Path $projectRoot '.tools/postgresql-runtime/pgsql/bin/pg_ctl.exe'
$databaseRoot = Join-Path $localRoot 'postgres'
if (Test-Path -LiteralPath (Join-Path $databaseRoot 'PG_VERSION')) {
    & $pgCtl -D $databaseRoot status 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { & $pgCtl -D $databaseRoot -m fast -w stop }
}
Write-Host 'Local services stopped. Saved accounts, balances and camera settings were preserved.'
# The launcher's finally block may already have stopped PostgreSQL. Its
# pg_ctl status=3 means "not running", not a failure of this completed stop.
$global:LASTEXITCODE = 0
