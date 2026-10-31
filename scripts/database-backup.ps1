param([string]$RestoreArchive)
$ErrorActionPreference = 'Stop'
$backupRoot = Split-Path -Parent $PSScriptRoot
$backupBin = Join-Path $backupRoot '.tools/postgresql-runtime/pgsql/bin'
$backupGo = Join-Path $backupRoot '.tools/go/bin/go.exe'
$backupExe = Join-Path $backupRoot '.tools/db-tool.exe'
$backupEnvironment = @{}
foreach ($key in @('DATABASE_URL','RESTORE_DATABASE_URL','PG_BIN','PGPASSWORD','GOCACHE','GOMODCACHE','GOPATH')) { $backupEnvironment[$key] = [Environment]::GetEnvironmentVariable($key,'Process') }
try {
    $backupPassword = $null
    foreach ($line in Get-Content -LiteralPath (Join-Path $backupRoot '.env')) { if ($line -match '^POSTGRES_PASSWORD=([a-zA-Z0-9_-]{32,})$') { $backupPassword = $Matches[1] } }
    if (-not $backupPassword) { throw 'Local database credentials are unavailable; inspect .env privately.' }
    $env:GOCACHE = Join-Path $backupRoot '.tools/go-cache'; $env:GOMODCACHE = Join-Path $backupRoot '.tools/go-mod'; $env:GOPATH = Join-Path $backupRoot '.tools/go-path'
    Push-Location (Join-Path $backupRoot 'backend')
    try { & $backupGo build -o $backupExe ./cmd/db-tool; if ($LASTEXITCODE -ne 0) { throw 'Database tool build failed.' } } finally { Pop-Location }
    $env:PG_BIN = $backupBin; $env:PGPASSWORD = $backupPassword
    $backupPort = if ($RestoreArchive) { 55432 } else { 55433 }
    $expectedBackupCluster = if ($RestoreArchive) { Join-Path $backupRoot '.tools/pgdata-qa' } else { Join-Path $backupRoot '.local-data/postgres' }
    $actualBackupCluster = & (Join-Path $backupBin 'psql.exe') -X --no-password -h 127.0.0.1 -p $backupPort -U trafficbet -d postgres -tAc 'SHOW data_directory' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($actualBackupCluster.Trim()),[IO.Path]::GetFullPath($expectedBackupCluster))) { throw 'Database cluster is unavailable or does not match this project. No backup/restore was attempted.' }
    $env:PGPASSWORD = $null
    if ($RestoreArchive) {
        $restorePath = (Resolve-Path -LiteralPath $RestoreArchive).Path
        $restoreName = 'trafficbet_restore_' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '_' + [Guid]::NewGuid().ToString('N').Substring(0,8)
        $env:RESTORE_DATABASE_URL = "postgres://trafficbet:$backupPassword@127.0.0.1:55432/$restoreName`?sslmode=disable"
        & $backupExe restore-check $restorePath
    } else {
        $backupDirectory = Join-Path $backupRoot '.local-data/backups'
        if (-not (Test-Path -LiteralPath $backupDirectory)) { [void][IO.Directory]::CreateDirectory($backupDirectory) }
        if ($IsWindows) {
            # Protect only this project's private backup directory; never modify
            # inherited ACLs on the workspace, user profile or database cluster.
            $backupUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
            # Change only the DACL, avoiding Set-Acl's attempted SACL write and
            # its unnecessary SeSecurityPrivilege requirement on some hosts.
            & icacls.exe $backupDirectory '/inheritance:r' '/grant:r' ("*$backupUserSid" + ':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' '/q' | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict the private backup directory.' }
            foreach ($backupRule in @((Get-Acl -LiteralPath $backupDirectory).Access)) {
                $ruleSid = $backupRule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
                if ($ruleSid -notin @($backupUserSid,'S-1-5-18')) {
                    & icacls.exe $backupDirectory '/remove:g' ("*$ruleSid") '/q' | Out-Null
                    if ($LASTEXITCODE -ne 0) { throw 'Cannot remove an unrelated backup-directory grant.' }
                }
            }
        }
        $archivePath = Join-Path $backupDirectory ('trafficbet-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8) + '.dump')
        $env:DATABASE_URL = "postgres://trafficbet:$backupPassword@127.0.0.1:55433/trafficbet?sslmode=disable"
        & $backupExe backup $archivePath
        if ($LASTEXITCODE -eq 0) { Write-Host "Archive: $archivePath" }
    }
    if ($LASTEXITCODE -ne 0) { throw 'Database archive operation failed. Existing application data was preserved.' }
} finally { foreach ($key in $backupEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key,$backupEnvironment[$key],'Process') } }
