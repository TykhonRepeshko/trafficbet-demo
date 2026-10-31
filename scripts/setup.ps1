param([switch]$NoDemo)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot '.env'
if (Test-Path -LiteralPath $envPath) {
    # Upgrades add only the new independent runtime secret; existing database,
    # account and worker secrets are never replaced.
    if (-not (Select-String -LiteralPath $envPath -Pattern '^POSTGRES_RUNTIME_PASSWORD=.+$' -Quiet)) {
        $runtimeSecret = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
        [IO.File]::AppendAllText($envPath, "`nPOSTGRES_RUNTIME_PASSWORD=$runtimeSecret`n", [Text.UTF8Encoding]::new($false))
        Write-Host 'Added an independent Docker runtime database secret; existing credentials were preserved.'
    }
    Write-Host '.env already exists; passwords and database settings were preserved.'
    exit 0
}

function New-LocalSecret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

$databasePassword = New-LocalSecret
$runtimePassword = New-LocalSecret
$workerToken = New-LocalSecret
$adminPassword = New-LocalSecret
$playerPassword = New-LocalSecret
$seedDemo = if ($NoDemo) { 'false' } else { 'true' }
$lines = @(
    '# Generated for localhost development. Never commit this file.',
    'APP_ENV=development',
    'FRONTEND_ORIGIN=http://localhost:4200',
    'COOKIE_SECURE=false',
    "POSTGRES_PASSWORD=$databasePassword",
    "POSTGRES_RUNTIME_PASSWORD=$runtimePassword",
    "WORKER_TOKEN=$workerToken",
    'SOURCE_OBSERVER_ENABLED=true',
    'VIDEO_EVIDENCE_ENABLED=false',
    "SEED_DEMO_DATA=$seedDemo",
    "DEMO_ADMIN_PASSWORD=$adminPassword",
    "DEMO_PLAYER_PASSWORD=$playerPassword",
    'MEDIA_ALLOWED_HOSTS=kamera.vegvesen.no,wzmedia.dot.ca.gov,cwwp2.dot.ca.gov'
)
# CreateNew prevents a concurrent setup from replacing existing credentials.
$stream = [IO.File]::Open($envPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$writer = New-Object IO.StreamWriter($stream, (New-Object Text.UTF8Encoding($false)))
try { $writer.Write(($lines -join "`n") + "`n") } finally { $writer.Dispose() }
Write-Host 'Created ignored .env with independent random passwords and worker secret.'
if (-not $NoDemo) {
    Write-Host 'Local accounts: admin@example.com and player@example.com.'
    Write-Host 'Open .env privately for DEMO_ADMIN_PASSWORD and DEMO_PLAYER_PASSWORD. They are not printed here.'
}
Write-Host 'Start Docker Desktop, then run .\scripts\start.ps1.'
