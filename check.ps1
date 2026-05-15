$script = Join-Path $PSScriptRoot "scripts\check.ps1"
& powershell -NoProfile -ExecutionPolicy Bypass -File $script @args
exit $LASTEXITCODE
