param(
    [int]$ApiPort = 8000,
    [int]$WebPort = 8080
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$api = Join-Path $root "apps\api"
$web = Join-Path $root "apps\web"

Write-Host "Starting Plus-Minus dev stack..."
Write-Host "API: http://localhost:$ApiPort"
Write-Host "Web: http://localhost:$WebPort/pages/home.html"

Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    "-NoExit",
    "-Command",
    "Set-Location -LiteralPath '$api'; & '..\..\.venv\Scripts\uvicorn.exe' main:app --reload --port $ApiPort"
)

Start-Process powershell -WindowStyle Hidden -ArgumentList @(
    "-NoExit",
    "-Command",
    "Set-Location -LiteralPath '$root'; node .\scripts\static-server.mjs .\apps\web $WebPort"
)

Write-Host "Started background terminals. Open http://localhost:$WebPort/pages/home.html"
