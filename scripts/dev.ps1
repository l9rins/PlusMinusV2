param(
    [int]$ApiPort = 8000,
    [int]$WebPort = 8080
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$api = Join-Path $root "apps\api"
$web = Join-Path $root "apps\web"

# Force UTF-8 for Python processes on Windows
$env:PYTHONUTF8 = "1"

Write-Host "Starting Plus-Minus dev stack..."
Write-Host "API: http://localhost:$ApiPort"
Write-Host "Web: http://localhost:$WebPort/pages/home.html"

# Start API
Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    "-NoExit",
    "-Command",
    "$env:PYTHONUTF8 = '1'; Set-Location -LiteralPath '$api'; & '..\..\.venv\Scripts\uvicorn.exe' main:app --reload --port $ApiPort"
)

# Start Web Server
Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    "-NoExit",
    "-Command",
    "Set-Location -LiteralPath '$root'; node .\scripts\static-server.mjs .\apps\web $WebPort"
)

# Start Local Wrangler Worker
Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    "-NoExit",
    "-Command",
    "Set-Location -LiteralPath '$web'; npx wrangler dev --port 8787"
)

Write-Host "Started background terminals. Open http://localhost:$WebPort/pages/home.html"
