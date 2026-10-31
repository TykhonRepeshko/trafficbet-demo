. (Join-Path $PSScriptRoot 'node-tools.ps1')
$localRoot = Join-Path $projectRoot '.local-data'
$databaseRoot = Join-Path $localRoot 'postgres'
$envFile = Join-Path $projectRoot '.env'
$postgresBin = Join-Path $projectRoot '.tools/postgresql-runtime/pgsql/bin'
$goCommand = Get-Command go.exe -ErrorAction SilentlyContinue
$goPath = if ($goCommand) { $goCommand.Source } else { Join-Path $projectRoot '.tools/go/bin/go.exe' }
if (-not (Test-Path -LiteralPath $goPath) -or -not (Test-Path -LiteralPath (Join-Path $postgresBin 'pg_ctl.exe'))) {
    throw 'Local mode requires Go and the portable PostgreSQL runtime in .tools. Install Docker Desktop and use scripts/start.ps1 for the container stack.'
}
if (-not (Test-Path -LiteralPath $envFile)) { & (Join-Path $PSScriptRoot 'setup.ps1') }
$settings = @{}
foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^[A-Z_]+=') { $parts = $line -split '=', 2; $settings[$parts[0]] = $parts[1] }
}
if (-not $settings['POSTGRES_PASSWORD']) { throw 'POSTGRES_PASSWORD is missing from .env.' }
if ($settings['POSTGRES_PASSWORD'] -notmatch '^[a-zA-Z0-9_-]{32,}$') {
    throw 'Local launcher expects the generated URL-safe database password. Configure native DATABASE_URL manually for a custom password.'
}
[void][IO.Directory]::CreateDirectory($localRoot)
[void][IO.Directory]::CreateDirectory((Join-Path $localRoot 'bin'))
$apiPath = Join-Path $localRoot 'bin/trafficbet-api.exe'
$pidFile = Join-Path $localRoot 'api-process.json'
function Test-LocalListener([int]$Port) {
    foreach ($address in @('127.0.0.1', '::1')) {
        $family = if ($address -eq '::1') { [Net.Sockets.AddressFamily]::InterNetworkV6 } else { [Net.Sockets.AddressFamily]::InterNetwork }
        $socket = New-Object Net.Sockets.TcpClient($family)
        try {
            $connection = $socket.ConnectAsync($address, $Port)
            if ($connection.Wait(300) -and $socket.Connected) { return $true }
        } catch { } finally { $socket.Dispose() }
    }
    return $false
}
$oldProcess = $null
# Only an API started by this launcher at this exact project path can be replaced.
if (Test-Path -LiteralPath $pidFile) {
    $previous = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $oldProcess = Get-Process -Id $previous.id -ErrorAction SilentlyContinue
    $recordedStartTicks = if ($previous.startedAtTicks) { [int64]$previous.startedAtTicks } else { ([DateTime]$previous.startedAt).ToUniversalTime().Ticks }
    if ($oldProcess -and ($oldProcess.Path -ne $apiPath -or $oldProcess.StartTime.ToUniversalTime().Ticks -ne $recordedStartTicks)) {
        $oldProcess = $null
    }
}
if (Test-LocalListener 4200) {
    if ($oldProcess) {
        try {
            $existingHealth = Invoke-RestMethod 'http://localhost:4200/api/health' -TimeoutSec 2
            if ($existingHealth.ok) {
                Write-Host 'The real application is already running: http://localhost:4200 . No services were restarted.'
                return
            }
        } catch { }
    }
    throw 'Port 4200 is occupied. Stop the previous browser preview with Ctrl+C before starting the real application. No existing service was stopped.'
}
if ($oldProcess) {
    Stop-Process -Id $oldProcess.Id -Force
    $oldProcess.WaitForExit()
}
if (Test-LocalListener 8080) {
    throw 'Port 8080 belongs to another process. Stop it or configure a different local API/proxy port before retrying.'
}
$startedDatabase = $false
$apiProcess = $null
try {
    if (-not (Test-Path -LiteralPath (Join-Path $databaseRoot 'PG_VERSION'))) {
        $passwordFile = Join-Path $localRoot 'postgres-password.tmp'
        [IO.File]::WriteAllText($passwordFile, $settings['POSTGRES_PASSWORD'], (New-Object Text.UTF8Encoding($false)))
        try {
            & (Join-Path $postgresBin 'initdb.exe') -D $databaseRoot -U trafficbet --auth=scram-sha-256 --encoding=UTF8 --locale=C --pwfile=$passwordFile
            if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the local PostgreSQL database.' }
        } finally { Remove-Item -LiteralPath $passwordFile -Force -ErrorAction SilentlyContinue }
    }
    & (Join-Path $postgresBin 'pg_ctl.exe') -D $databaseRoot status 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        & (Join-Path $postgresBin 'pg_ctl.exe') -D $databaseRoot -l (Join-Path $localRoot 'postgres.log') -o '-h 127.0.0.1 -p 55433' -w start
        if ($LASTEXITCODE -ne 0) { throw 'Could not start PostgreSQL on localhost:55433. See .local-data/postgres.log.' }
        $startedDatabase = $true
    }
    $previousPgPassword = $env:PGPASSWORD
    $env:PGPASSWORD = $settings['POSTGRES_PASSWORD']
    try {
        $exists = & (Join-Path $postgresBin 'psql.exe') -h 127.0.0.1 -p 55433 -U trafficbet -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='trafficbet'"
        if ($LASTEXITCODE -ne 0) { throw 'Could not authenticate to the saved PostgreSQL cluster. Preserve .env and .local-data together.' }
        $actualDatabaseRoot = & (Join-Path $postgresBin 'psql.exe') -h 127.0.0.1 -p 55433 -U trafficbet -d postgres -tAc 'SHOW data_directory'
        if ($LASTEXITCODE -ne 0 -or -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($actualDatabaseRoot.Trim()), [IO.Path]::GetFullPath($databaseRoot))) {
            throw 'Port 55433 does not belong to this project database. No application data was created or changed there.'
        }
        if ($exists -ne '1') {
            & (Join-Path $postgresBin 'createdb.exe') -h 127.0.0.1 -p 55433 -U trafficbet trafficbet
            if ($LASTEXITCODE -ne 0) { throw 'Could not create the application database.' }
        }
    } finally { $env:PGPASSWORD = $previousPgPassword }

    $previousGoCache = $env:GOCACHE
    $previousGoModCache = $env:GOMODCACHE
    $previousGoPath = $env:GOPATH
    $env:GOCACHE = Join-Path $projectRoot '.tools/go-cache'
    $env:GOMODCACHE = Join-Path $projectRoot '.tools/go-mod'
    $env:GOPATH = Join-Path $projectRoot '.tools/go-path'
    Push-Location (Join-Path $projectRoot 'backend')
    try {
        & $goPath build -trimpath -o $apiPath ./cmd/api
        if ($LASTEXITCODE -ne 0) { throw 'Go API build failed.' }
    } finally {
        Pop-Location
        $env:GOCACHE = $previousGoCache
        $env:GOMODCACHE = $previousGoModCache
        $env:GOPATH = $previousGoPath
    }
    $apiEnvironment = @{
        APP_ENV = 'development'
        HTTP_ADDR = '127.0.0.1:8080'
        FRONTEND_ORIGIN = 'http://localhost:4200'
        COOKIE_SECURE = 'false'
        DATABASE_URL = ('postgres://trafficbet:' + $settings['POSTGRES_PASSWORD'] + '@127.0.0.1:55433/trafficbet?sslmode=disable')
        WORKER_TOKEN = $settings['WORKER_TOKEN']
        SOURCE_OBSERVER_ENABLED = $(if ($settings.ContainsKey('SOURCE_OBSERVER_ENABLED')) { $settings['SOURCE_OBSERVER_ENABLED'] } else { 'true' })
        VIDEO_EVIDENCE_ENABLED = $(if ($settings.ContainsKey('VIDEO_EVIDENCE_ENABLED')) { $settings['VIDEO_EVIDENCE_ENABLED'] } else { 'false' })
        SEED_DEMO_DATA = $settings['SEED_DEMO_DATA']
        DEMO_ADMIN_PASSWORD = $settings['DEMO_ADMIN_PASSWORD']
        DEMO_PLAYER_PASSWORD = $settings['DEMO_PLAYER_PASSWORD']
        MEDIA_ALLOWED_HOSTS = $(if ($settings.ContainsKey('MEDIA_ALLOWED_HOSTS')) { $settings['MEDIA_ALLOWED_HOSTS'] } else { 'kamera.vegvesen.no,wzmedia.dot.ca.gov,cwwp2.dot.ca.gov' })
        EVIDENCE_DIRECTORY = (Join-Path $localRoot 'video-evidence')
    }
    $previousApiEnvironment = @{}
    foreach ($key in $apiEnvironment.Keys) {
        $previousApiEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $apiEnvironment[$key], 'Process')
    }
    try {
        $apiProcess = Start-Process -FilePath $apiPath -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $localRoot 'api.stdout.log') -RedirectStandardError (Join-Path $localRoot 'api.stderr.log')
    } finally {
        # Angular and dependency scripts must never inherit database or worker secrets.
        foreach ($key in $previousApiEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $previousApiEnvironment[$key], 'Process') }
    }
    @{ id = $apiProcess.Id; startedAtTicks = $apiProcess.StartTime.ToUniversalTime().Ticks } | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding utf8
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($apiProcess.HasExited) { break }
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:8080/api/health' -TimeoutSec 2
            $apiProcess.Refresh()
            if ($health.ok -and -not $apiProcess.HasExited) { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $ready) { throw 'Go API did not become healthy. Inspect .local-data/api.stderr.log privately.' }
    Write-Host 'Real Go API + PostgreSQL are ready. Accounts, sessions and balances are saved.'
    Write-Host 'Application: http://localhost:4200 . Registration: /register . Stop with Ctrl+C.'
    Write-Host 'Persistent database: .local-data/postgres . Preserve it together with .env.'
    Write-Host 'Admin email: admin@example.com . Password: DEMO_ADMIN_PASSWORD in .env.'
    Push-Location (Join-Path $projectRoot 'frontend')
    try {
        if (-not (Test-Path -LiteralPath 'node_modules/@angular/cli/bin/ng.js')) { Invoke-ProjectNpm ci --cache ../.tools/npm-cache --no-fund }
        Invoke-ProjectNpm run start
    } finally { Pop-Location }
} finally {
    if ($apiProcess -and -not $apiProcess.HasExited) { Stop-Process -Id $apiProcess.Id -Force }
    if ($startedDatabase) { & (Join-Path $postgresBin 'pg_ctl.exe') -D $databaseRoot -m fast -w stop }
}
