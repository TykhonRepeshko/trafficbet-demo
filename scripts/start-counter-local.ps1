param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$counterRoot = Split-Path -Parent $PSScriptRoot
$counterDocker = Get-Command docker.exe -ErrorAction SilentlyContinue
if (-not $counterDocker) {
    if ($Stop) { $global:LASTEXITCODE = 0; return }
    throw 'AI local mode requires Docker Desktop. Start Docker Desktop before starting the application.'
}
$counterCompose = @('compose','--project-name','trafficbet-local-ai','--env-file',(Join-Path $counterRoot '.env'),'-f',(Join-Path $counterRoot 'docker-compose.counter-local.yml'))
if (-not $Stop) {
    $counterDevice = 'cpu'
    foreach ($counterLine in Get-Content -LiteralPath (Join-Path $counterRoot '.env')) {
        if ($counterLine -match '^COUNTER_DEVICE=(.+)$') { $counterDevice = $Matches[1].Trim() }
    }
    if ($counterDevice -notin @('cpu','cuda')) { throw 'COUNTER_DEVICE must be cpu or cuda.' }
    if ($counterDevice -eq 'cuda') { $counterCompose += @('-f',(Join-Path $counterRoot 'docker-compose.counter-gpu.yml')) }
}
function Assert-CounterOwner([string]$Container) {
    $counterDirectory = & $counterDocker.Source inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' $Container
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($counterDirectory) -or -not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($counterDirectory.Trim()), [IO.Path]::GetFullPath($counterRoot))) { throw 'AI worker belongs to another checkout or has no ownership metadata; refusing to change it.' }
}
if ($Stop) {
    # Stop only this checkout's worker; never remove volumes or other projects.
    # Ad-hoc tests inherit project/service image labels but are not Compose
    # containers. A Compose configuration hash distinguishes managed services.
    $counterIds = @(& $counterDocker.Source ps -q --filter 'label=com.docker.compose.project=trafficbet-local-ai' --filter 'label=com.docker.compose.service=counter' --filter 'label=com.docker.compose.config-hash' 2>$null)
    if ($LASTEXITCODE -eq 0 -and $counterIds.Count) {
        foreach ($counterId in $counterIds) { Assert-CounterOwner $counterId }
        & $counterDocker.Source stop --timeout 20 @counterIds
        if ($LASTEXITCODE -ne 0) { throw 'Could not stop this project AI worker.' }
    }
    $global:LASTEXITCODE = 0
    return
}
$counterHealth = Invoke-RestMethod 'http://127.0.0.1:8080/api/health' -TimeoutSec 5
if (-not $counterHealth.ok -or -not $counterHealth.automaticSettlement) { throw 'Restart the native backend with AUTOMATIC_SETTLEMENT_ENABLED=true before starting the AI worker.' }
$counterExisting = @(& $counterDocker.Source ps -aq --filter 'label=com.docker.compose.project=trafficbet-local-ai' --filter 'label=com.docker.compose.service=counter' --filter 'label=com.docker.compose.config-hash')
if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop before starting the AI worker.' }
foreach ($counterId in $counterExisting) { Assert-CounterOwner $counterId }
$counterSavedToken = [Environment]::GetEnvironmentVariable('WORKER_TOKEN','Process')
try {
    # The native launcher removes API secrets before invoking child tools.
    # An inherited empty variable must not override Compose's private env file.
    foreach ($counterLine in Get-Content -LiteralPath (Join-Path $counterRoot '.env')) {
        if ($counterLine -match '^WORKER_TOKEN=(.+)$') { $env:WORKER_TOKEN = $Matches[1] }
    }
    & $counterDocker.Source @counterCompose config -q
    if ($LASTEXITCODE -ne 0) { throw 'Local AI configuration is invalid.' }
    & $counterDocker.Source @counterCompose up --build -d counter
    if ($LASTEXITCODE -ne 0) { throw 'AI worker startup failed. Inspect docker compose -f docker-compose.counter-local.yml logs counter privately.' }
} finally { [Environment]::SetEnvironmentVariable('WORKER_TOKEN',$counterSavedToken,'Process') }
