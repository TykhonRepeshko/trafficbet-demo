param([switch]$Local, [switch]$Docker, [switch]$Foreground, [switch]$StopLocal)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ($Local -and $Docker) { throw 'Choose one mode: -Local or -Docker.' }
if ($StopLocal) {
    & (Join-Path $PSScriptRoot 'stop-local.ps1')
    exit 0
}
function Start-LocalApplication {
    if ($Foreground) {
        & (Join-Path $PSScriptRoot 'start-local.ps1')
        return
    }
    $localRoot = Join-Path $projectRoot '.local-data'
    [void][IO.Directory]::CreateDirectory($localRoot)
    $processFile = Join-Path $localRoot 'api-process.json'
    if (Test-Path -LiteralPath $processFile) {
        $record = Get-Content -LiteralPath $processFile -Raw | ConvertFrom-Json
        $runningApi = Get-Process -Id $record.id -ErrorAction SilentlyContinue
        if ($runningApi -and $runningApi.Path -eq (Join-Path $localRoot 'bin/trafficbet-api.exe')) {
            try {
                $currentHealth = Invoke-RestMethod 'http://localhost:4200/api/health' -TimeoutSec 2
                if ($currentHealth.ok) {
                    if ($currentHealth.automaticSettlement) { & (Join-Path $PSScriptRoot 'start-counter-local.ps1') }
                    Write-Host 'Already running: http://localhost:4200'; return
                }
            } catch { }
        }
    }
    $launchID = [Guid]::NewGuid().ToString('N').Substring(0, 8)
    # Preserve the caller's PowerShell host and its existing execution policy.
    $shellPath = (Get-Process -Id $PID).Path
    $workerScript = Join-Path $PSScriptRoot 'start-local.ps1'
    $worker = Start-Process -FilePath $shellPath -ArgumentList @('-NoProfile', '-File', ('"' + $workerScript + '"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $localRoot "launcher-$launchID.stdout.log") -RedirectStandardError (Join-Path $localRoot "launcher-$launchID.stderr.log")
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $worker.Refresh()
        if ($worker.HasExited) { throw 'Local startup failed. Inspect the latest .local-data/launcher-*.stderr.log privately.' }
        try {
            $liveHealth = Invoke-RestMethod 'http://localhost:4200/api/health' -TimeoutSec 1
            if ($liveHealth.ok) {
                Write-Host 'Running in the background: http://localhost:4200 . Registration: /register'
                Write-Host 'Accounts and balances are saved in .local-data/postgres. Stop: .\scripts\stop-local.ps1'
                return
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    throw 'The local application did not become ready in time. Inspect .local-data/launcher-*.log.'
}
if ($Local) {
    Start-LocalApplication
    exit 0
}
# Preserve the storage choice once native accounts exist. Installing Docker must
# not silently switch this checkout to an empty, unrelated database.
if (-not $Docker -and (Test-Path -LiteralPath (Join-Path $projectRoot '.local-data/postgres/PG_VERSION'))) {
    Write-Host 'Using the saved local database. Use -Docker explicitly for the separate container database.'
    Start-LocalApplication
    exit 0
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.env'))) {
    & (Join-Path $PSScriptRoot 'setup.ps1')
}

$dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
$dockerPath = if ($dockerCommand) { $dockerCommand.Source } else { $null }
if (-not $dockerPath) {
    if ($Docker) { throw 'Docker mode was requested, but Docker Desktop is not installed.' }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs/DockerDesktop/resources/bin/docker.exe'),
        (Join-Path $env:ProgramFiles 'Docker/Docker/resources/bin/docker.exe')
    )
    $dockerPath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if ($Docker -and (Test-Path -LiteralPath (Join-Path $projectRoot '.local-data/api-process.json'))) {
    $savedApi = Get-Content -LiteralPath (Join-Path $projectRoot '.local-data/api-process.json') -Raw | ConvertFrom-Json
    $localApi = Get-Process -Id $savedApi.id -ErrorAction SilentlyContinue
    if ($localApi -and $localApi.Path -eq (Join-Path $projectRoot '.local-data/bin/trafficbet-api.exe')) {
        throw 'Local mode is running. Stop it with stop.cmd before selecting -Docker. Docker uses a separate database; accounts are not moved automatically.'
    }
}
if (-not $dockerPath) {
    Write-Host 'Docker is not installed; starting the real application with portable Go and PostgreSQL.'
    Start-LocalApplication
    exit 0
}
& $dockerPath info --format '{{.ServerVersion}}'
if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop and wait for the engine to be ready, then retry.' }
Push-Location $projectRoot
try {
    & (Join-Path $PSScriptRoot 'setup.ps1')
    # -q validates interpolation without exposing secrets in rendered config.
    & $dockerPath compose config -q
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose configuration is invalid.' }
    $composeOptions = @('compose')
    if (Select-String -LiteralPath (Join-Path $projectRoot '.env') -Pattern '^AUTOMATIC_SETTLEMENT_ENABLED=(true|1)$' -Quiet) { $composeOptions += @('--profile','ai') }
    & $dockerPath @composeOptions up --build --wait --wait-timeout 180
    if ($LASTEXITCODE -ne 0) { throw 'Services did not become healthy. Inspect docker compose logs; do not post .env.' }
    Write-Host 'TrafficBet: http://localhost:4200 . Stop: docker compose down (retains PostgreSQL data).'
} finally { Pop-Location }
