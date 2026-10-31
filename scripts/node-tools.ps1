$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
function Get-ProjectNode {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $bundled = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
    if (Test-Path -LiteralPath $bundled) { return $bundled }
    throw 'Install Node.js 24 LTS from https://nodejs.org/ and retry. Docker mode does not require host Node.js.'
}

function Invoke-ProjectNpm {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$NpmArguments)
    $nodePath = Get-ProjectNode
    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    $originalProjectPath = $env:PATH
    # Frontend tooling must not inherit backend/database secrets, including
    # credentials supplied by a parent maintenance or integration-test shell.
    $frontendSecretEnvironment = @{}
    foreach ($key in @('DATABASE_URL', 'TEST_DATABASE_URL', 'PGPASSWORD', 'POSTGRES_PASSWORD', 'POSTGRES_RUNTIME_PASSWORD', 'WORKER_TOKEN', 'DEMO_ADMIN_PASSWORD', 'DEMO_PLAYER_PASSWORD', 'MFA_ENCRYPTION_KEY', 'RESTORE_DATABASE_URL')) {
        $frontendSecretEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $null, 'Process')
    }
    # npm scripts resolve node again in child processes, including Angular's ng.cmd.
    # Keep the bundled runtime available to them without changing the user's PATH.
    $env:PATH = (Split-Path -Parent $nodePath) + [IO.Path]::PathSeparator + $originalProjectPath
    try {
        if ($npmCommand) {
            & $npmCommand.Source @NpmArguments
        } else {
            $npmScript = Join-Path $projectRoot '.tools/npm/package/bin/npm-cli.js'
            if (-not (Test-Path -LiteralPath $npmScript)) {
                throw 'npm is missing. Install the official Node.js 24 LTS distribution (includes npm), then retry.'
            }
            # Angular also checks for an npm executable on PATH. The registry
            # archive's npm.cmd assumes a system installation layout, so supply
            # a small project-local launcher for this portable layout.
            $npmShimDirectory = Join-Path $projectRoot '.tools/bin'
            [void][IO.Directory]::CreateDirectory($npmShimDirectory)
            [IO.File]::WriteAllLines(
                (Join-Path $npmShimDirectory 'npm.cmd'),
                @('@echo off', 'node "%~dp0..\npm\package\bin\npm-cli.js" %*'),
                (New-Object Text.UTF8Encoding($false))
            )
            $env:PATH = $npmShimDirectory + [IO.Path]::PathSeparator + $env:PATH
            & $nodePath $npmScript @NpmArguments
        }
        if ($LASTEXITCODE -ne 0) { throw "npm command failed with exit code $LASTEXITCODE" }
    } finally {
        foreach ($key in $frontendSecretEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $frontendSecretEnvironment[$key], 'Process') }
        $env:PATH = $originalProjectPath
    }
}
