$script = Join-Path $PSScriptRoot "scripts\dev.ps1"
& powershell -NoProfile -ExecutionPolicy Bypass -File $script @args
exit $LASTEXITCODE
