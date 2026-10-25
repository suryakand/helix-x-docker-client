# Build Windows binaries (NSIS installer + portable exe).
#   powershell -ExecutionPolicy Bypass -File scripts\build.ps1 [-Target win|dir] [-SkipTests] [-Arch x64|arm64]
param(
  [ValidateSet('win', 'dir')] [string]$Target = 'win',
  [switch]$SkipTests,
  [ValidateSet('', 'x64', 'arm64')] [string]$Arch = ''
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Run($cmd) {
  Write-Host "==> $cmd"
  cmd /c $cmd
  if ($LASTEXITCODE -ne 0) { throw "Command failed: $cmd" }
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm is required (run: corepack enable)' }
Run 'node scripts/clean.mjs'
Run 'pnpm install --frozen-lockfile'
Run 'pnpm icons'
if ($SkipTests) { Run 'pnpm turbo run typecheck lint build' } else { Run 'pnpm turbo run typecheck lint test build' }

Set-Location apps\desktop
$archArg = if ($Arch) { "--$Arch" } else { '' }
if ($Target -eq 'dir') { Run "pnpm exec electron-builder --dir $archArg --publish never" }
else { Run "pnpm exec electron-builder --win $archArg --publish never" }

$version = (Get-Content package.json | ConvertFrom-Json).version
Write-Host "==> Artifacts in apps\desktop\release\$version"
Get-ChildItem "release\$version" -File | Where-Object { $_.Name -notmatch '\.(blockmap|yml)$' } | ForEach-Object { Write-Host "   $($_.Name)" }
