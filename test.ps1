$script = Join-Path $PSScriptRoot "scripts\test.ps1"
& powershell -NoProfile -ExecutionPolicy Bypass -File $script @args
exit $LASTEXITCODE
