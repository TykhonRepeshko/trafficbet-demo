#Requires -Version 7.0
param([string]$ArchivePath,[string]$EvidenceDirectory)
$ErrorActionPreference = 'Stop'
$transferRoot = Split-Path -Parent $PSScriptRoot
$transferRun = [Guid]::NewGuid().ToString('N')
$transferProject = 'trafficbet-transfer-' + $transferRun.Substring(0,8)
$transferDatabase = 'trafficbet_migration_' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '_' + $transferRun.Substring(0,8)
$transferKeys = @('TRANSFER_RUN_ID','TRANSFER_DATABASE','TRANSFER_POSTGRES_PASSWORD','TRANSFER_RUNTIME_PASSWORD','TRANSFER_WORKER_TOKEN','DATABASE_URL','RESTORE_DATABASE_URL','PG_BIN','PGPASSWORD','PGCONNECT_TIMEOUT','GOCACHE','GOMODCACHE','GOPATH')
$transferSaved = @{}
$transferSecrets = [Collections.Generic.List[string]]::new()
$transferOwned = $false
$transferPassed = $false
$transferAssertions = 0
$transferEvidenceFiles = @()
$transferEvidenceBytes = 0L
$transferEvidenceBundle = $null
function Assert-Transfer([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:transferAssertions++ }
function Protect-Transfer([string]$Message) { foreach($secret in $transferSecrets) {$Message=$Message.Replace($secret,'[redacted]')}; return $Message }
function Invoke-TransferCompose([string[]]$Arguments) {
    & $script:transferDocker @script:transferCompose @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Isolated transfer Compose command failed ($LASTEXITCODE)." }
}
function Test-TransferPort([int]$Port) {
    $socket=[Net.Sockets.TcpClient]::new()
    try { try { $connection=$socket.ConnectAsync('127.0.0.1',$Port); $occupied=$connection.Wait(500) -and $socket.Connected } catch {$occupied=$false}; Assert-Transfer (-not $occupied) "Loopback port $Port is occupied; no existing service was changed." } finally {$socket.Dispose()}
}
function Read-TransferProof {
    $proofSQL="SET TIME ZONE 'UTC'; SELECT jsonb_object_agg(name,proof)::text FROM (SELECT 'users' name,jsonb_build_object('rows',count(*),'digest',md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),''))) proof FROM users t UNION ALL SELECT 'bets',jsonb_build_object('rows',count(*),'digest',md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),''))) FROM bets t UNION ALL SELECT 'credit_ledger',jsonb_build_object('rows',count(*),'digest',md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),''))) FROM credit_ledger t) proofs"
    $result=& $script:transferDocker @script:transferCompose exec -T postgres psql -X -v ON_ERROR_STOP=1 -q -At -U trafficbet -d $transferDatabase -c $proofSQL
    if ($LASTEXITCODE -ne 0) { throw 'Cannot collect private transfer integrity checks.' }
    return $result | ConvertFrom-Json
}
function Assert-TransferProof($Proof,$Manifest) {
    foreach($name in @('users','bets','credit_ledger')) {
        Assert-Transfer ($Proof.$name.rows -eq $Manifest.tables.$name.rows -and $Proof.$name.digest -eq $Manifest.tables.$name.digest) "Preserved $name fingerprints do not match the consistent native snapshot."
    }
}
function Save-TransferEvidenceBundle {
    # Query only the freshly restored snapshot. Final rows/files are immutable;
    # an in-progress capture cannot be made consistent by copying a directory.
    if(-not $manifest.tables.PSObject.Properties['video_evidence']){return}
    $retainedFilter=if($manifest.tables.PSObject.Properties['video_evidence_retirements']){' AND NOT EXISTS(SELECT 1 FROM video_evidence_retirements r WHERE r.evidence_id=e.id)'}else{''}
    $active=& $script:transferDocker @script:transferCompose exec -T postgres psql -X -v ON_ERROR_STOP=1 -q -At -U trafficbet -d $transferDatabase -c ("SELECT count(*) FROM video_evidence e WHERE status IN ('queued','capturing','processing')"+$retainedFilter)
    Assert-Transfer ($LASTEXITCODE -eq 0 -and $active.Trim() -eq '0') 'Snapshot contains an unfinished capture; wait for finalization and create a new snapshot.'
    $rows=& $script:transferDocker @script:transferCompose exec -T postgres psql -X -v ON_ERROR_STOP=1 -q -At -U trafficbet -d $transferDatabase -c ("SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'status',status,'clipSha256',clip_sha256,'byteCount',byte_count,'segments',quality->'segments') ORDER BY id),'[]'::jsonb)::text FROM video_evidence e WHERE true"+$retainedFilter)
    Assert-Transfer ($LASTEXITCODE -eq 0) 'Cannot read restored retained-evidence manifest.'
    $evidenceRows=@($rows | ConvertFrom-Json)
    if(-not $evidenceRows.Count){return}
    $sourceRoot=if($EvidenceDirectory){(Resolve-Path -LiteralPath $EvidenceDirectory).Path}else{Join-Path $transferRoot '.local-data/video-evidence'}
    $sourceRoot=[IO.Path]::GetFullPath($sourceRoot)
    $script:transferEvidenceBundle=$ArchivePath+'.'+$transferRun.Substring(0,8)+'.evidence'
    Assert-Transfer (-not (Test-Path -LiteralPath $script:transferEvidenceBundle)) 'Evidence bundle target already exists; nothing was overwritten.'
    [void][IO.Directory]::CreateDirectory($script:transferEvidenceBundle)
    foreach($row in $evidenceRows){
        $id=[string]$row.id
        Assert-Transfer ($id -match '^[1-9][0-9]{0,17}$') 'Evidence identifier is invalid.'
        $files=@()
        foreach($segment in @($row.segments)){
            if($null -eq $segment){continue}
            Assert-Transfer ($segment.file -match '^[0-9]{6}\.ts$' -and $segment.sha256 -match '^[a-f0-9]{64}$') 'Retained segment manifest is invalid.'
            $files+=@{name=[string]$segment.file;sha256=[string]$segment.sha256;maximum=20MB}
        }
        if($row.status -eq 'ready'){
            Assert-Transfer ($row.clipSha256 -match '^[a-f0-9]{64}$' -and $row.byteCount -gt 0) 'Ready clip has no integrity proof.'
            $files+=@{name='clip.mp4';sha256=[string]$row.clipSha256;maximum=512MB}
        }
        $seen=@{}
        $rowBytes=0L
        foreach($file in $files){
            Assert-Transfer (-not $seen.ContainsKey($file.name)) 'A retained filename is duplicated.'; $seen[$file.name]=$true
            $folder=Join-Path $sourceRoot $id; $source=Join-Path $folder $file.name
            Assert-Transfer (Test-Path -LiteralPath $source -PathType Leaf) 'A retained file required by the snapshot is missing.'
            foreach($path in @($sourceRoot,$folder,$source)){Assert-Transfer (((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Evidence symlinks/reparse points are refused.'}
            $info=Get-Item -LiteralPath $source
            Assert-Transfer ($info.Length -gt 0 -and $info.Length -le $file.maximum -and (-not $file.ContainsKey('bytes') -or $info.Length -eq $file.bytes)) 'Retained file size does not match its bounded manifest.'
            Assert-Transfer ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -eq $file.sha256) 'Retained source file bytes do not match the database snapshot.'
            $destinationFolder=Join-Path $script:transferEvidenceBundle $id; [void][IO.Directory]::CreateDirectory($destinationFolder)
            $destination=Join-Path $destinationFolder $file.name; [IO.File]::Copy($source,$destination,$false)
            Assert-Transfer ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -eq $file.sha256) 'Copied evidence bundle bytes differ.'
            $script:transferEvidenceFiles+=@{id=$id;name=$file.name;sha256=$file.sha256;bytes=$info.Length}
            $script:transferEvidenceBytes+=$info.Length
            $rowBytes+=$info.Length
            Assert-Transfer ($script:transferEvidenceBytes -le 6GB -and $script:transferEvidenceFiles.Count -le 5000) 'Evidence transfer storage budget exceeded.'
        }
        if($row.status -eq 'ready'){Assert-Transfer ($rowBytes -eq [long]$row.byteCount) 'Ready evidence total retained bytes differ from its database snapshot.'}
    }
    @{version=1;archiveSha256=$manifest.sha256;files=$script:transferEvidenceFiles} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $script:transferEvidenceBundle 'bundle.json') -Encoding utf8
}
function Install-TransferEvidenceBundle {
    if(-not $script:transferEvidenceFiles.Count){return}
    # Only validated decimal IDs/fixed filenames enter this command. The source
    # bundle is mounted read-only; the helper inherits the API's unprivileged UID.
    $copyCommands=[Collections.Generic.List[string]]::new();$copyCommands.Add('set -eu; umask 077')
    foreach($id in @($script:transferEvidenceFiles.id | Select-Object -Unique)){$copyCommands.Add("mkdir -p -m 700 /app/evidence/$id")}
    foreach($file in $script:transferEvidenceFiles){$relative=$file.id+'/'+$file.name;$copyCommands.Add("test ! -e /app/evidence/$relative; cp /source/$relative /app/evidence/$relative; chmod 600 /app/evidence/$relative")}
    Invoke-TransferCompose -Arguments @('run','--rm','--no-deps','-T','--entrypoint','sh','--volume',($script:transferEvidenceBundle+':/source:ro'),'backend','-c',($copyCommands -join '; '))
    Assert-TransferEvidenceFiles
}
function Assert-TransferEvidenceFiles {
    if(-not $script:transferEvidenceFiles.Count){return}
    $checks=@($script:transferEvidenceFiles | ForEach-Object {'sha256sum /app/evidence/'+$_.id+'/'+$_.name})
    $hashes=& $script:transferDocker @script:transferCompose run --rm --no-deps -T --entrypoint sh backend -c ($checks -join '; ')
    Assert-Transfer ($LASTEXITCODE -eq 0) 'Docker retained evidence files are unreadable.'
    $actual=@{};foreach($line in $hashes){if($line -match '^([a-f0-9]{64})\s+/app/evidence/([0-9]+/[0-9a-z.]+)$'){$actual[$Matches[2]]=$Matches[1]}}
    foreach($file in $script:transferEvidenceFiles){Assert-Transfer ($actual[$file.id+'/'+$file.name] -eq $file.sha256) 'Docker evidence bytes differ from the private snapshot bundle.'}
}
try {
    foreach($key in $transferKeys) {$transferSaved[$key]=[Environment]::GetEnvironmentVariable($key,'Process')}
    $env:TRANSFER_RUN_ID=$transferRun; $env:TRANSFER_DATABASE=$transferDatabase
    foreach($key in @('TRANSFER_POSTGRES_PASSWORD','TRANSFER_RUNTIME_PASSWORD','TRANSFER_WORKER_TOKEN')) {
        $secret=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
        $transferSecrets.Add($secret); [Environment]::SetEnvironmentVariable($key,$secret,'Process')
    }
    $dockerCommand=Get-Command docker.exe -ErrorAction SilentlyContinue
    $script:transferDocker=if($dockerCommand){$dockerCommand.Source}else{Join-Path $env:LOCALAPPDATA 'Programs/DockerDesktop/resources/bin/docker.exe'}
    Assert-Transfer (Test-Path -LiteralPath $script:transferDocker) 'Docker Desktop is not installed.'
    & $script:transferDocker info --format '{{.ServerVersion}}'
    Assert-Transfer ($LASTEXITCODE -eq 0) 'Docker engine is unavailable; the native application was not changed.'
    Test-TransferPort 55434; Test-TransferPort 4202
    $emptyEnv=Join-Path $transferRoot '.tools/transfer-empty.env'
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $emptyEnv)); [IO.File]::WriteAllText($emptyEnv,'',[Text.UTF8Encoding]::new($false))
    $script:transferCompose=@('compose','--project-name',$transferProject,'--env-file',$emptyEnv,'-f',(Join-Path $transferRoot 'docker-compose.transfer.yml'))
    foreach($kind in @('container','network','volume')) {
        $existing=if($kind -eq 'container'){@(& $script:transferDocker ps -aq --filter "label=com.docker.compose.project=$transferProject")}else{@(& $script:transferDocker $kind ls -q --filter "label=com.docker.compose.project=$transferProject")}
        Assert-Transfer ($LASTEXITCODE -eq 0 -and $existing.Count -eq 0) 'The new transfer project unexpectedly has existing resources; nothing was removed.'
    }
    if (-not $ArchivePath) {
        $backupDirectory=Join-Path $transferRoot '.local-data/backups'
        $before=@(Get-ChildItem -LiteralPath $backupDirectory -Filter '*.dump' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
        & (Join-Path $PSScriptRoot 'database-backup.ps1')
        Assert-Transfer ($LASTEXITCODE -eq 0) 'Consistent native backup failed.'
        $newArchives=@(Get-ChildItem -LiteralPath $backupDirectory -Filter '*.dump' | Where-Object FullName -NotIn $before)
        Assert-Transfer ($newArchives.Count -eq 1) 'A unique new archive could not be selected; provide -ArchivePath explicitly.'
        $ArchivePath=$newArchives[0].FullName
    }
    $ArchivePath=(Resolve-Path -LiteralPath $ArchivePath).Path
    $manifest=Get-Content -LiteralPath ($ArchivePath+'.json') -Raw | ConvertFrom-Json
    Assert-Transfer ($manifest.version -eq 2 -and $manifest.ledgerMismatches -eq 0 -and (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $manifest.sha256) 'The selected private archive manifest/checksum is invalid.'
    $env:GOCACHE=Join-Path $transferRoot '.tools/go-cache'; $env:GOMODCACHE=Join-Path $transferRoot '.tools/go-mod'; $env:GOPATH=Join-Path $transferRoot '.tools/go-path'
    $dbTool=Join-Path $transferRoot '.tools/db-tool.exe'
    Push-Location (Join-Path $transferRoot 'backend')
    try { & (Join-Path $transferRoot '.tools/go/bin/go.exe') build -o $dbTool ./cmd/db-tool; Assert-Transfer ($LASTEXITCODE -eq 0) 'Database tool build failed.' } finally {Pop-Location}
    Invoke-TransferCompose -Arguments @('config','-q')
    $transferOwned=$true
    Write-Host 'Starting a new Docker PostgreSQL volume on loopback port 55434; native port 55433 remains unchanged.'
    Invoke-TransferCompose -Arguments @('up','--build','--wait','--wait-timeout','120','postgres')
    $env:PG_BIN=Join-Path $transferRoot '.tools/postgresql-runtime/pgsql/bin'
    # The initial entrypoint briefly serves a Unix socket only. Verify the
    # published TCP path/authentication before calling the restoration tool.
    $env:PGPASSWORD=$env:TRANSFER_POSTGRES_PASSWORD
    $env:PGCONNECT_TIMEOUT='2'
    $transferTCPReady=$false
    for($attempt=0;$attempt -lt 20;$attempt++){
        $tcpProof=& (Join-Path $env:PG_BIN 'psql.exe') -X --no-password -h 127.0.0.1 -p 55434 -U trafficbet -d postgres -Atc 'SELECT 1' 2>$null
        if($LASTEXITCODE -eq 0 -and $tcpProof.Trim() -eq '1'){$transferTCPReady=$true;break};Start-Sleep -Milliseconds 500
    }
    Assert-Transfer $transferTCPReady 'The isolated Docker database published TCP/authentication path did not become ready.'
    $env:PGPASSWORD=$transferSaved['PGPASSWORD']
    $env:RESTORE_DATABASE_URL="postgres://trafficbet:$($env:TRANSFER_POSTGRES_PASSWORD)@127.0.0.1:55434/$transferDatabase`?sslmode=disable"
    & $dbTool restore-check $ArchivePath
    Assert-Transfer ($LASTEXITCODE -eq 0) 'Fresh Docker database restoration failed integrity verification.'
    Assert-TransferProof (Read-TransferProof) $manifest
    Save-TransferEvidenceBundle
    # Prepare images/volume before starting HTTP, so a restored ready record
    # never temporarily points at an empty evidence volume.
    if($script:transferEvidenceFiles.Count){Invoke-TransferCompose -Arguments @('build','backend');Install-TransferEvidenceBundle}
    Write-Host 'Starting production application images against only the restored copy.'
    Invoke-TransferCompose -Arguments @('up','--build','--wait','--wait-timeout','180')
    $health=Invoke-RestMethod 'http://127.0.0.1:4202/api/health' -TimeoutSec 15
    Assert-Transfer ($health.ok -eq $true) 'The copied Docker application did not become healthy.'
    Assert-TransferProof (Read-TransferProof) $manifest
    Assert-TransferEvidenceFiles
    Write-Host 'Recreating PostgreSQL against the same new Docker volume to verify persistence.'
    Invoke-TransferCompose -Arguments @('up','--force-recreate','--no-deps','--wait','--wait-timeout','120','postgres')
    $ready=$false
    for($attempt=0;$attempt -lt 30;$attempt++){try{$health=Invoke-RestMethod 'http://127.0.0.1:4202/api/health' -TimeoutSec 2;if($health.ok){$ready=$true;break}}catch{};Start-Sleep -Milliseconds 500}
    Assert-Transfer $ready 'The copied application did not reconnect after PostgreSQL recreation.'
    Assert-TransferProof (Read-TransferProof) $manifest
    Assert-TransferEvidenceFiles
    $nativeHealth=Invoke-RestMethod 'http://localhost:4200/api/health' -TimeoutSec 10
    Assert-Transfer ($nativeHealth.ok -eq $true) 'Native application health is unavailable after the isolated rehearsal.'
    $transferPassed=$true
    $report=[ordered]@{recordedAt=[DateTime]::UtcNow.ToString('o');snapshotCreatedAt=$manifest.createdAt;project=$transferProject;restoredTables=@($manifest.tables.PSObject.Properties).Count;ledgerMismatches=0;assertions=$transferAssertions;archiveSha256=$manifest.sha256;evidenceFiles=$script:transferEvidenceFiles.Count;evidenceClips=@($script:transferEvidenceFiles | Where-Object name -eq 'clip.mp4').Count;evidenceBytes=$script:transferEvidenceBytes;nativeApplicationPreserved=$true;copiedDatabaseRecreated=$true;runtimeRole='trafficbet_runtime';publicSwitchPerformed=$false}
} catch {$transferPassed=$false;Write-Host ('Docker transfer rehearsal failed: '+(Protect-Transfer $_.Exception.Message)) -ForegroundColor Red}
finally {
    if($transferOwned){try{
        foreach($kind in @('container','network','volume')) {
            $ids=if($kind -eq 'container'){@(& $script:transferDocker ps -aq --filter "label=com.docker.compose.project=$transferProject")}else{@(& $script:transferDocker $kind ls -q --filter "label=com.docker.compose.project=$transferProject")}
            if($LASTEXITCODE -ne 0){throw 'Cannot verify run resource ownership.'}
            foreach($id in $ids){$format=if($kind -eq 'container'){'{{ index .Config.Labels "trafficbet.transfer-run" }}'}else{'{{ index .Labels "trafficbet.transfer-run" }}'};$owner=& $script:transferDocker $kind inspect --format $format $id;if($LASTEXITCODE -ne 0 -or $owner -ne $transferRun){throw 'Cleanup refused an unexpected resource owner.'}}
        }
        Write-Host 'Removing only this rehearsal project and its labelled disposable volumes; the native archive is retained privately.'
        Invoke-TransferCompose -Arguments @('down','--volumes','--remove-orphans','--timeout','15')
    }catch{$transferPassed=$false;Write-Host ('Transfer cleanup failed: '+(Protect-Transfer $_.Exception.Message)) -ForegroundColor Red}}
    foreach($key in $transferSaved.Keys){[Environment]::SetEnvironmentVariable($key,$transferSaved[$key],'Process')}
}
if(-not $transferPassed){exit 1}
$report['cleanupVerified']=$true
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $transferRoot '.tools/docker-transfer-latest.json') -Encoding utf8
Write-Host "Docker transfer rehearsal passed: $transferAssertions assertions. Restored table fingerprints, accounts, bets and ledger match; native storage remains selected."
exit 0
