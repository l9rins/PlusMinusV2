param(
    [switch]$SkipBackendImport
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$backend = Join-Path $root "apps\api"
$frontend = Join-Path $root "apps\web"
$failures = New-Object System.Collections.Generic.List[string]

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "== $Message =="
}

function Add-Failure {
    param([string]$Message)
    $failures.Add($Message) | Out-Null
    Write-Host "FAIL: $Message" -ForegroundColor Red
}

function Find-Command {
    param([string[]]$Names)
    foreach ($name in $Names) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) {
            return $cmd.Source
        }
    }
    return $null
}

function Find-Python {
    $fromPath = Find-Command @("python", "py", "python3")
    if ($fromPath) {
        return $fromPath
    }

    $codexPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
    if (Test-Path -LiteralPath $codexPython) {
        return $codexPython
    }

    return $null
}

Write-Host "Plus-Minus project check"
Write-Host "Root: $root"

Write-Step "Required files"
$required = @(
    "wrangler.jsonc",
    "README.md",
    "docs\architecture.md",
    "docs\data-quality.md",
    "docs\model-card.md",
    "docs\assets\dashboard-preview.png",
    ".github\workflows\ci.yml",
    "scripts\test.ps1",
    "scripts\dev.ps1",
    "scripts\static-server.mjs",
    "apps\api\requirements.txt",
    "apps\api\requirements-dev.txt",
    "apps\api\README.md",
    "apps\api\main.py",
    "apps\api\.env",
    "apps\web\wrangler.toml",
    "apps\web\README.md",
    "apps\web\workers\worker.js",
    "apps\web\scripts\status-panel.js",
    "apps\web\scripts\motion.js",
    "apps\web\styles\motion.css",
    "apps\web\index.html"
)

foreach ($relativePath in $required) {
    $fullPath = Join-Path $root $relativePath
    if (Test-Path -LiteralPath $fullPath) {
        Write-Host "OK: $relativePath"
    } else {
        Add-Failure "Missing $relativePath"
    }
}

Write-Step "Frontend JavaScript syntax"
$node = Find-Command @("node")
if (-not $node) {
    Add-Failure "Node.js is not installed or not on PATH."
} else {
    Write-Host "Node: $(& $node --version)"
    $jsFiles = @(
        "workers\worker.js",
        "workers\proxy.js",
        "scripts\dashboard.js",
        "scripts\shared.js",
        "scripts\predictions.js",
        "scripts\data.js",
        "scripts\status-panel.js",
        "scripts\motion.js"
    )

    Push-Location $frontend
    try {
        foreach ($file in $jsFiles) {
            if (Test-Path -LiteralPath $file) {
                & $node --check $file
                if ($LASTEXITCODE -ne 0) {
                    Add-Failure "JavaScript syntax failed: apps\web\$file"
                } else {
                    Write-Host "OK: apps\web\$file"
                }
            }
        }
    } finally {
        Pop-Location
    }
}

Write-Step "Backend Python check"
$python = Find-Python
if (-not $python) {
    Add-Failure "Python is not installed or not on PATH, so backend checks could not run."
} else {
    Write-Host "Python: $(& $python --version)"
    Push-Location $backend
    try {
        $syntaxCheck = @'
from pathlib import Path
import sys

failed = False
for path in sorted(Path(".").rglob("*.py")):
    if any(part in {".venv", "venv", "__pycache__"} for part in path.parts):
        continue
    try:
        source = path.read_text(encoding="utf-8-sig")
        compile(source, str(path), "exec")
        print(f"OK: {path}")
    except SyntaxError as exc:
        failed = True
        print(f"FAIL: {path}:{exc.lineno}:{exc.offset}: {exc.msg}")

sys.exit(1 if failed else 0)
'@
        $syntaxFile = New-TemporaryFile
        Set-Content -LiteralPath $syntaxFile -Value $syntaxCheck -Encoding UTF8
        & $python $syntaxFile
        Remove-Item -LiteralPath $syntaxFile -Force -ErrorAction SilentlyContinue
        if ($LASTEXITCODE -ne 0) {
            Add-Failure "Python syntax check failed."
        } else {
            Write-Host "OK: Python files parse"
        }

        if (-not $SkipBackendImport) {
            & $python -c "import main; print('OK: backend imports')"
            if ($LASTEXITCODE -ne 0) {
                Add-Failure "Backend import check failed. Run with -SkipBackendImport to only do syntax checks."
            }
        }
    } finally {
        Pop-Location
    }
}

Write-Step "Configuration sanity"
$rootWrangler = Get-Content -LiteralPath (Join-Path $root "wrangler.jsonc") -Raw
if ($rootWrangler -match '"name"\s*:\s*"lus-inus"') {
    Add-Failure "Root wrangler.jsonc still uses the old name 'lus-inus'."
} else {
    Write-Host "OK: root Wrangler app name is not the old typo"
}

if (Test-Path -LiteralPath (Join-Path $backend ".env")) {
    $envText = Get-Content -LiteralPath (Join-Path $backend ".env") -Raw
    if ($envText -match "GROQ_API_KEY\s*=\s*\S+") {
        Write-Host "OK: backend .env contains GROQ_API_KEY"
    } else {
        Add-Failure "backend .env exists but GROQ_API_KEY is empty or missing."
    }
}

Write-Host ""
if ($failures.Count -gt 0) {
    Write-Host "Check finished with $($failures.Count) issue(s)." -ForegroundColor Red
    foreach ($failure in $failures) {
        Write-Host "- $failure" -ForegroundColor Red
    }
    exit 1
}

Write-Host "All checks passed." -ForegroundColor Green
