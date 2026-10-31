#Requires -Version 7.0
param([switch]$NoBuild)
$ErrorActionPreference = 'Stop'
$smokeRoot = Split-Path -Parent $PSScriptRoot
$smokeProject = 'trafficbet-smoke'
$smokeOrigin = 'http://localhost:4201'
$smokeBase = 'http://127.0.0.1:4201'
$smokeRunID = [Guid]::NewGuid().ToString('N')
$smokeEnvironment = @('SMOKE_RUN_ID', 'SMOKE_POSTGRES_PASSWORD', 'SMOKE_RUNTIME_PASSWORD', 'SMOKE_WORKER_TOKEN', 'SMOKE_ADMIN_PASSWORD', 'SMOKE_PLAYER_PASSWORD')
$savedSmokeEnvironment = @{}
$smokeSecrets = [Collections.Generic.List[string]]::new()
$smokeAssertions = 0
$ownsSmokeResources = $false
$smokePassed = $false

function New-SmokeSecret {
    return [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)).ToLowerInvariant()
}
function Protect-SmokeMessage([string]$Message) {
    foreach ($secret in $smokeSecrets) { $Message = $Message.Replace($secret, '[redacted]') }
    return $Message
}
function Assert-Smoke([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:smokeAssertions++
}
function Invoke-SmokeCompose([string[]]$Arguments) {
    & $script:smokeDocker @script:smokeComposeArguments @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose command failed with exit code $LASTEXITCODE." }
}
function Invoke-SmokeHTTP {
    param(
        [string]$Path, [int]$Status = 200, [string]$Method = 'GET',
        [object]$Body = $null, [Microsoft.PowerShell.Commands.WebRequestSession]$Session = $null,
        [hashtable]$ExtraHeaders = @{}, [string]$Origin = $smokeOrigin
    )
    $headers = @{}
    if ($Origin) { $headers['Origin'] = $Origin }
    foreach ($key in $ExtraHeaders.Keys) { $headers[$key] = $ExtraHeaders[$key] }
    $request = @{
        Uri = $smokeBase + $Path; Method = $Method; Headers = $headers
        TimeoutSec = 15; SkipHttpErrorCheck = $true
    }
    if ($Session) {
        # Invoke-WebRequest retains custom headers on WebRequestSession. Clear
        # them while preserving its cookie jar so negative Origin/key checks
        # cannot accidentally reuse values from an earlier successful request.
        $Session.Headers.Clear()
        $request['WebSession'] = $Session
    }
    if ($null -ne $Body) {
        $request['ContentType'] = 'application/json'
        $request['Body'] = $Body | ConvertTo-Json -Depth 10 -Compress
    }
    $response = Invoke-WebRequest @request
    Assert-Smoke ($response.StatusCode -eq $Status) "$Method $Path returned HTTP $($response.StatusCode); expected $Status."
    return $response
}
function Read-SmokeJSON($Response) { return $Response.Content | ConvertFrom-Json -Depth 30 }
function Assert-SmokeDeniedSQL([string]$Statement) {
    $deniedOutput = & $script:smokeDocker @script:smokeComposeArguments exec -T postgres psql -X -v ON_ERROR_STOP=1 -U trafficbet -d trafficbet_smoke -c "BEGIN; SET LOCAL ROLE trafficbet_runtime; $Statement; ROLLBACK;" 2>&1
    $deniedCode=$LASTEXITCODE
    Assert-Smoke ($deniedCode -ne 0 -and ($deniedOutput -join ' ') -match 'permission denied|must be owner') "The runtime database role did not reject '$Statement' as expected (exit $deniedCode; $($deniedOutput -join ' '))."
}

try {
    foreach ($key in $smokeEnvironment) {
        $savedSmokeEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        $value = if ($key -eq 'SMOKE_RUN_ID') { $smokeRunID } else { New-SmokeSecret }
        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
        if ($key -ne 'SMOKE_RUN_ID') { $smokeSecrets.Add($value) }
    }
    $dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
    $script:smokeDocker = if ($dockerCommand) { $dockerCommand.Source } else { $null }
    if (-not $script:smokeDocker) {
        foreach ($candidate in @((Join-Path $env:ProgramFiles 'Docker/Docker/resources/bin/docker.exe'), (Join-Path $env:LOCALAPPDATA 'Programs/DockerDesktop/resources/bin/docker.exe'))) {
            if (Test-Path -LiteralPath $candidate) { $script:smokeDocker = $candidate; break }
        }
    }
    if (-not $script:smokeDocker) { throw 'Docker is not installed. This smoke check requires Docker Desktop with the Linux engine ready.' }
    & $script:smokeDocker info --format '{{.ServerVersion}}'
    if ($LASTEXITCODE -ne 0) { throw 'Docker engine is unavailable. Start Docker Desktop before running the smoke check.' }
    $emptyEnv = Join-Path $smokeRoot '.tools/smoke-empty.env'
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $emptyEnv))
    [IO.File]::WriteAllText($emptyEnv, '', [Text.UTF8Encoding]::new($false))
    $script:smokeComposeArguments = @('compose', '--project-name', $smokeProject, '--env-file', $emptyEnv, '-f', (Join-Path $smokeRoot 'docker-compose.smoke.yml'))
    $existingContainers = @(& $script:smokeDocker ps -aq --filter "label=com.docker.compose.project=$smokeProject")
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect existing smoke containers.' }
    $existingNetworks = @(& $script:smokeDocker network ls -q --filter "label=com.docker.compose.project=$smokeProject")
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect existing smoke networks.' }
    if ($existingContainers.Count -or $existingNetworks.Count) { throw 'The trafficbet-smoke project already has resources. They were not changed. Inspect that previous run before retrying.' }
    $socket = [Net.Sockets.TcpClient]::new()
    try {
        $connection = $socket.ConnectAsync('127.0.0.1', 4201)
        try { $occupied = $connection.Wait(500) -and $socket.Connected } catch { $occupied = $false }
        if ($occupied) { throw 'Port 4201 is already occupied. No existing application was stopped.' }
    } finally { $socket.Dispose() }
    Invoke-SmokeCompose -Arguments @('config', '-q')
    $ownsSmokeResources = $true
    Write-Host 'Starting the isolated Docker smoke stack on 127.0.0.1:4201.'
    $smokeBuildMode = if($NoBuild){'--no-build'}else{'--build'}
    if($NoBuild){Write-Host 'Using previously built images; this run does not validate the current source build.'}
    Invoke-SmokeCompose -Arguments @('up', $smokeBuildMode, '--wait', '--wait-timeout', '180')

    Write-Host 'Checking the migration/runtime privilege boundary and restricted decoder filesystem.'
    $roleProof = & $script:smokeDocker @script:smokeComposeArguments exec -T postgres psql -X -v ON_ERROR_STOP=1 -U trafficbet -d trafficbet_smoke -Atc "SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) FROM pg_roles WHERE rolname='trafficbet_runtime'"
    Assert-Smoke ($LASTEXITCODE -eq 0 -and $roleProof.Trim() -eq 't') 'The runtime database role has elevated role flags.'
    Assert-SmokeDeniedSQL 'CREATE TABLE public.forbidden_runtime_table(id integer)'
    Assert-SmokeDeniedSQL 'ALTER TABLE public.users ADD COLUMN forbidden_runtime_column integer'
    Assert-SmokeDeniedSQL 'DELETE FROM public.schema_migrations'
    Assert-SmokeDeniedSQL 'UPDATE public.credit_ledger SET delta_credits=delta_credits'
    Assert-SmokeDeniedSQL 'DELETE FROM public.audit_events'
    Assert-SmokeDeniedSQL 'UPDATE public.counting_profiles SET version=version'
    & $script:smokeDocker @script:smokeComposeArguments exec -T backend sh -c 'test "$(id -u)" = 65532 && test -w /app/evidence && test ! -w /app && test ! -w /etc && test -x /usr/bin/ffmpeg'
    Assert-Smoke ($LASTEXITCODE -eq 0) 'The API is not using the expected restricted writable evidence directory and decoder.'

    Write-Host 'Checking production proxy health, response headers and static assets.'
    $health = Invoke-SmokeHTTP '/api/health'
    Assert-Smoke ((Read-SmokeJSON $health).ok -eq $true) 'API database health did not report ready.'
    $index = Invoke-SmokeHTTP '/'
    Assert-Smoke ([string]$index.Headers['Content-Type'] -match 'text/html') 'The production index has an incorrect MIME type.'
    Assert-Smoke ([string]$index.Headers['X-Frame-Options'] -eq 'DENY') 'The production index is missing frame protection.'
    Assert-Smoke ([string]$index.Headers['X-Content-Type-Options'] -eq 'nosniff') 'The production index is missing MIME protection.'
    Assert-Smoke ([string]$index.Headers['Content-Security-Policy'] -match "frame-ancestors 'none'") 'The production index is missing its Content Security Policy.'
    Assert-Smoke ($index.Content -notmatch '\sonload\s*=') 'Generated stylesheet activation depends on an inline handler blocked by the production CSP.'
    Assert-Smoke ([string]$health.Headers['Cache-Control'] -match 'no-store') 'Private API responses must not be cached.'
    $main = [regex]::Match($index.Content, 'src="(main[^"/]*\.js)"').Groups[1].Value
    $styles = [regex]::Match($index.Content, 'href="(styles[^"/]*\.css)"').Groups[1].Value
    Assert-Smoke ($main -ne '' -and $styles -ne '') 'Production JavaScript or CSS references were not found.'
    $script = Invoke-SmokeHTTP "/$main"
    Assert-Smoke ([string]$script.Headers['Content-Type'] -match '(application|text)/javascript') 'The production JavaScript asset has an incorrect MIME type.'
    $css = Invoke-SmokeHTTP "/$styles"
    Assert-Smoke ([string]$css.Headers['Content-Type'] -match 'text/css') 'The production stylesheet has an incorrect MIME type.'
    $themeInit = Invoke-SmokeHTTP '/theme-init.js'
    Assert-Smoke ([string]$themeInit.Headers['Content-Type'] -match '(application|text)/javascript') 'The early theme script is missing or has an incorrect MIME type.'
    Assert-Smoke ($index.Content -match '<script[^>]*src="/?theme-init\.js"') 'The theme must initialize from a local external script under the existing CSP.'
    foreach ($cameraAsset in @('fiskevollbukta', 'djupdalen', 'vingnes', 'fjosangerveien', 'skaret', 'bay-bridge-incline')) {
        $image = Invoke-SmokeHTTP "/cameras/$cameraAsset.png"
        Assert-Smoke ([string]$image.Headers['Content-Type'] -match '^image/png') "Camera reference asset $cameraAsset is missing or returned the HTML fallback."
        Assert-Smoke ($image.RawContentLength -gt 1000) "Camera reference asset $cameraAsset is empty or truncated."
    }
    [void](Invoke-SmokeHTTP '/.env' 403)
    [void](Invoke-SmokeHTTP '/api/internal/streams/1/metrics' 404)
    [void](Invoke-SmokeHTTP '/media/untrusted/index.m3u8' 404)
    [void](Invoke-SmokeHTTP '/api/me' 401)

    Write-Host 'Checking registration, role boundaries, account isolation and server sessions.'
    $player = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $otherPlayer = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $administrator = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $password = New-SmokeSecret
    $smokeSecrets.Add($password)
    $email = "smoke-$smokeRunID@example.com"
    $registration = Invoke-SmokeHTTP '/api/auth/register' 201 'POST' @{ email = $email; displayName = 'Smoke account'; password = $password } $player
    $account = (Read-SmokeJSON $registration).user
    Assert-Smoke ($account.role -eq 'user' -and $account.balanceCredits -eq 10000) 'Registration did not create a normal account with its opening virtual balance.'
    Assert-Smoke ([string]$registration.Headers['Set-Cookie'] -match 'HttpOnly') 'The session cookie is not HttpOnly.'
    Assert-Smoke ([string]$registration.Headers['Set-Cookie'] -match 'SameSite=Strict') 'The session cookie is missing SameSite=Strict.'
    [void](Invoke-SmokeHTTP '/api/auth/register' 201 'POST' @{ email = "other-$smokeRunID@example.com"; displayName = 'Other account'; password = $password } $otherPlayer)
    [void](Invoke-SmokeHTTP '/api/admin/users' 403 'GET' $null $player)
    $initialLedger = @(Read-SmokeJSON (Invoke-SmokeHTTP '/api/me/ledger' 200 'GET' $null $player))
    Assert-Smoke ($initialLedger.Count -eq 1 -and $initialLedger[0].reason -eq 'opening' -and $initialLedger[0].deltaCredits -eq 10000) 'Opening ledger entry is missing or incorrect.'
    [void](Invoke-SmokeHTTP '/api/auth/login' 200 'POST' @{ email = 'admin@example.com'; password = $env:SMOKE_ADMIN_PASSWORD } $administrator)
    $usersResponse = Invoke-SmokeHTTP '/api/admin/users' 200 'GET' $null $administrator
    Assert-Smoke ($usersResponse.Content -notmatch 'password|session_hash|token_hash') 'Admin users response exposes authentication fields.'

    Write-Host 'Checking actual prediction debit, idempotent retries, cancellation and one-time refunds.'
    $streams = @(Read-SmokeJSON (Invoke-SmokeHTTP '/api/streams'))
    Assert-Smoke ($streams.Count -ge 1 -and $streams[0].streamType -eq 'hls') 'Seeded continuous camera sources are missing.'
    Assert-Smoke ($streams.Count -eq 6 -and @($streams | Where-Object sourceOwner -eq 'Norwegian Public Roads Administration (Statens vegvesen)').Count -eq 5 -and @($streams | Where-Object sourceOwner -eq 'California Department of Transportation (Caltrans)').Count -eq 1) 'Production seed did not include the six attributed cameras.'
    Assert-Smoke (@($streams | Where-Object { $_.streamUrl -notmatch '^/api/media/streams/\d+/index\.m3u8$' }).Count -eq 0) 'Public camera metadata exposes upstream media addresses.'
    $schedules = (Read-SmokeJSON (Invoke-SmokeHTTP '/api/admin/round-schedules' 200 'GET' $null $administrator)).schedules
    Assert-Smoke (@($schedules | Where-Object { -not $_.enabled -or $_.entrySeconds -ne 30 -or $_.countingSeconds -ne 30 -or $_.leadSeconds -ne 30 }).Count -eq 0) 'Seeded round schedules did not retain the short entry/counting windows and safety gap.'
    # The account workflow must not race a 30-second demo entry period on a
    # slow build host. Its own source has no scheduler and a controlled deadline.
    $source = @(Read-SmokeJSON (Invoke-SmokeHTTP '/api/admin/streams' 200 'GET' $null $administrator))[0]
    $sourcePayload = @{}
    foreach ($field in @('title','city','country','locationLabel','description','streamType','streamUrl','thumbnailUrl','sourceOwner','sourcePageUrl','termsUrl','usageNotes','latitude','longitude','isActive')) { $sourcePayload[$field] = $source.$field }
    $sourcePayload['title'] = 'Controlled Docker account-workflow fixture'
    $fixtureSource = Read-SmokeJSON (Invoke-SmokeHTTP '/api/admin/streams' 201 'POST' $sourcePayload $administrator)
    $fixtureTime = [DateTimeOffset]::UtcNow
    $fixtureMarket = Read-SmokeJSON (Invoke-SmokeHTTP '/api/admin/markets' 201 'POST' @{
        streamId = $fixtureSource.id; title = 'Controlled Docker credit-workflow round'; threshold = 3
        bettingClosesAt = $fixtureTime.AddMinutes(5).ToString('o'); windowStart = $fixtureTime.AddMinutes(7).ToString('o')
        windowEnd = $fixtureTime.AddMinutes(7).AddSeconds(30).ToString('o'); oddsOver = 1.9; oddsUnder = 1.9; status = 'open'
    } $administrator)
    $markets = @($fixtureMarket)
    $draft = Read-SmokeJSON (Invoke-SmokeHTTP '/api/admin/markets' 201 'POST' @{
        streamId = $fixtureSource.id; title = 'Private Docker smoke draft'; threshold = 30
        bettingClosesAt = $markets[0].bettingClosesAt; windowStart = $markets[0].windowStart
        windowEnd = $markets[0].windowEnd; oddsOver = 1.9; oddsUnder = 1.9; status = 'draft'
    } $administrator)
    $publicMarkets = @(Read-SmokeJSON (Invoke-SmokeHTTP "/api/streams/$($fixtureSource.id)/markets"))
    Assert-Smoke (@($publicMarkets | Where-Object id -eq $draft.id).Count -eq 0) 'Public market listings exposed an administrator draft.'
    [void](Invoke-SmokeHTTP "/api/streams/$($fixtureSource.id)/markets?status=draft" 400)
    $marketID = $markets[0].id
    $key = 'docker-smoke-' + $smokeRunID
    $betBody = @{ marketId = $marketID; side = 'over'; stakeCredits = 100 }
    [void](Invoke-SmokeHTTP '/api/bets' 403 'POST' $betBody $player @{ 'Idempotency-Key' = $key } '')
    [void](Invoke-SmokeHTTP '/api/bets' 400 'POST' $betBody $player)
    $placed = Read-SmokeJSON (Invoke-SmokeHTTP '/api/bets' 201 'POST' $betBody $player @{ 'Idempotency-Key' = $key })
    Assert-Smoke ($placed.user.balanceCredits -eq 9900 -and $placed.bet.stakeCredits -eq 100) 'Placing the prediction did not debit exactly one stake.'
    $replayed = Read-SmokeJSON (Invoke-SmokeHTTP '/api/bets' 201 'POST' $betBody $player @{ 'Idempotency-Key' = $key })
    Assert-Smoke ($placed.bet.id -eq $replayed.bet.id -and $replayed.user.balanceCredits -eq 9900) 'An idempotent prediction retry duplicated or charged the stake.'
    [void](Invoke-SmokeHTTP '/api/bets' 409 'POST' @{ marketId = $marketID; side = 'over'; stakeCredits = 101 } $player @{ 'Idempotency-Key' = $key })
    $otherBets = @(Read-SmokeJSON (Invoke-SmokeHTTP '/api/bets/my' 200 'GET' $null $otherPlayer))
    Assert-Smoke ($otherBets.Count -eq 0) 'Another account can see private prediction history.'
    $otherLedger = @(Read-SmokeJSON (Invoke-SmokeHTTP "/api/me/ledger?userId=$($account.id)" 200 'GET' $null $otherPlayer))
    Assert-Smoke ($otherLedger.Count -eq 1 -and $otherLedger[0].reason -eq 'opening') 'A supplied user ID exposed another account ledger.'
    $reason = @{ reason = 'Isolated Docker smoke test cancellation and refund' }
    $cancelled = Read-SmokeJSON (Invoke-SmokeHTTP "/api/admin/markets/$marketID/void" 200 'PATCH' $reason $administrator)
    Assert-Smoke ($cancelled.status -eq 'void') 'Cancellation did not void the prediction round.'
    [void](Invoke-SmokeHTTP "/api/admin/markets/$marketID/void" 200 'PATCH' $reason $administrator)
    [void](Invoke-SmokeHTTP "/api/admin/markets/$marketID/void" 409 'PATCH' @{ reason = 'A different cancellation explanation must not replace history' } $administrator)
    $current = Read-SmokeJSON (Invoke-SmokeHTTP '/api/me' 200 'GET' $null $player)
    Assert-Smoke ($current.balanceCredits -eq 10000) 'Cancellation did not restore the original balance exactly once.'
    $finalLedger = @(Read-SmokeJSON (Invoke-SmokeHTTP '/api/me/ledger' 200 'GET' $null $player))
    Assert-Smoke ($finalLedger.Count -eq 3) 'The ledger did not preserve exactly opening, stake and refund entries.'
    Assert-Smoke (($finalLedger | Measure-Object -Property deltaCredits -Sum).Sum -eq $current.balanceCredits) 'Ledger deltas do not reconcile with the account balance.'
    $finalBets = @(Read-SmokeJSON (Invoke-SmokeHTTP '/api/bets/my' 200 'GET' $null $player))
    Assert-Smoke ($finalBets.Count -eq 1 -and $finalBets[0].status -eq 'void') 'Cancelled prediction history was lost or not marked void.'

    Write-Host 'Checking logout revocation and login persistence through the production proxy.'
    $oldCookie = $player.Cookies.GetCookies([Uri]($smokeBase + '/api/me'))['trafficbet_session'].Value
    [void](Invoke-SmokeHTTP '/api/auth/logout' 200 'POST' @{} $player)
    [void](Invoke-SmokeHTTP '/api/me' 401 'GET' $null $null @{ Cookie = "trafficbet_session=$oldCookie" })
    [void](Invoke-SmokeHTTP '/api/auth/login' 200 'POST' @{ email = $email.ToUpperInvariant(); password = $password } $player)
    $afterLogin = Read-SmokeJSON (Invoke-SmokeHTTP '/api/me' 200 'GET' $null $player)
    Assert-Smoke ($afterLogin.id -eq $account.id -and $afterLogin.balanceCredits -eq 10000) 'Logging back in did not preserve the account and refunded balance.'
    [void](Invoke-SmokeHTTP '/api/auth/logout' 200 'POST' @{} $player)
    [void](Invoke-SmokeHTTP '/api/me' 401 'GET' $null $player)
    $smokePassed = $true
    Write-Host "Docker full-stack smoke passed: $smokeAssertions HTTP and behavior assertions. Browser rendering and external camera playback were not tested."
} catch {
    Write-Host ('Docker full-stack smoke failed: ' + (Protect-SmokeMessage $_.Exception.Message)) -ForegroundColor Red
} finally {
    if ($ownsSmokeResources) {
        try {
            # The project was empty before this run. Check the run label before
            # cleanup so unrelated resources are never deliberately removed.
            $containerIDs = @(& $script:smokeDocker ps -aq --filter "label=com.docker.compose.project=$smokeProject")
            if ($LASTEXITCODE -ne 0) { throw 'Could not verify smoke cleanup ownership.' }
            foreach ($containerID in $containerIDs) {
                $owner = & $script:smokeDocker inspect --format '{{ index .Config.Labels "trafficbet.smoke-run" }}' $containerID
                if ($LASTEXITCODE -ne 0 -or $owner -ne $smokeRunID) { throw 'Smoke cleanup refused an unexpected container owner.' }
            }
            Write-Host 'Removing only this run''s isolated smoke containers and ephemeral database.'
            $networkIDs = @(& $script:smokeDocker network ls -q --filter "label=com.docker.compose.project=$smokeProject")
            if ($LASTEXITCODE -ne 0) { throw 'Could not verify smoke network ownership.' }
            foreach ($networkID in $networkIDs) {
                $owner = & $script:smokeDocker network inspect --format '{{ index .Labels "trafficbet.smoke-run" }}' $networkID
                if ($LASTEXITCODE -ne 0 -or $owner -ne $smokeRunID) { throw 'Smoke cleanup refused an unexpected network owner.' }
            }
            Invoke-SmokeCompose -Arguments @('down', '--volumes', '--remove-orphans', '--timeout', '15')
        } catch {
            $smokePassed = $false
            Write-Host ('Smoke cleanup failed: ' + (Protect-SmokeMessage $_.Exception.Message)) -ForegroundColor Red
        }
    }
    foreach ($key in $smokeEnvironment) { [Environment]::SetEnvironmentVariable($key, $savedSmokeEnvironment[$key], 'Process') }
}
if (-not $smokePassed) { exit 1 }
exit 0
