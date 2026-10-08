$ErrorActionPreference = 'Stop'
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
npm.cmd run desktop
exit $LASTEXITCODE
