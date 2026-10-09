$ErrorActionPreference = 'Stop'
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
npm.cmd ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm.cmd run browser:install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm.cmd run browser:prepare
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm.cmd run test:browser-login
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm.cmd test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm.cmd run format:check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
cargo fmt --manifest-path src-tauri/Cargo.toml --check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
cargo test --locked --manifest-path src-tauri/Cargo.toml
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm.cmd run bundle -- --target x86_64-pc-windows-msvc --features custom-protocol
exit $LASTEXITCODE
