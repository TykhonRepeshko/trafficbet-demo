. (Join-Path $PSScriptRoot 'node-tools.ps1')
Push-Location (Join-Path $projectRoot 'frontend')
try {
    if (-not (Test-Path -LiteralPath 'node_modules/@angular/cli/bin/ng.js')) {
        Invoke-ProjectNpm ci --cache ../.tools/npm-cache --no-fund
    }
    Write-Host 'Browser demo only: temporary in-memory data. Go API and PostgreSQL are not connected.'
    Write-Host 'Open http://localhost:4200 . Stop with Ctrl+C.'
    Invoke-ProjectNpm run preview
} finally { Pop-Location }
