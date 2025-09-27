#!/usr/bin/env pwsh
Write-Host "Starting MCP AL Reviewer Server..." -ForegroundColor Green
Write-Host ""
Write-Host "If VS Code is asking to 'wait for connection', this should resolve it." -ForegroundColor Yellow
Write-Host "Press Ctrl+C to stop the server." -ForegroundColor Yellow
Write-Host ""

Set-Location $PSScriptRoot

try {
    node index.mjs
}
catch {
    Write-Error "Failed to start server: $_"
    Read-Host "Press Enter to exit"
}