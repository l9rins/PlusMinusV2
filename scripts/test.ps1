param(
    [switch]$SkipApi
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node = Get-Command node -ErrorAction SilentlyContinue

if (-not $node) {
    throw "Node.js is required for web tests."
}

Push-Location $root
try {
    Write-Host "== Web tests =="
    Get-ChildItem -LiteralPath (Join-Path $root "tests\web") -Filter "*.test.mjs" | ForEach-Object {
        & node $_.FullName
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    }

    if (-not $SkipApi) {
        Write-Host ""
        Write-Host "== API tests =="
        $python = Get-Command python -ErrorAction SilentlyContinue
        if (-not $python) {
            $codexPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
            if (Test-Path -LiteralPath $codexPython) {
                $python = @{ Source = $codexPython }
            }
        }
        if (-not $python) {
            throw "Python is required for API tests."
        }
        $env:PYTHONPATH = (Join-Path $root "apps\api")
        $cacheDir = Join-Path $root "tests\pytest-cache"
        New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
        & $python.Source -m pytest -o "cache_dir=$cacheDir" tests\api
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    }
} finally {
    Pop-Location
}
