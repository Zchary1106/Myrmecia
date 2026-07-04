#!/usr/bin/env pwsh
#
# Myrmecia one-click launcher (Windows / PowerShell)
#
# Usage:
#   ./start.ps1                 # install (first run) + start API + Dashboard
#   ./start.ps1 -CleanDb        # reset the local SQLite database first
#   ./start.ps1 -ServerOnly     # start only the API server (port 3000)
#   ./start.ps1 -DashboardOnly  # start only the dashboard (port 5173)
#   ./start.ps1 -InstallPython  # also install the Python runtime deps
#   ./start.ps1 -NoOpen         # don't open the browser automatically
#
# Only Node.js >= 20 is required up front (https://nodejs.org).
# pnpm is auto-provisioned via corepack.

[CmdletBinding()]
param(
  [switch]$CleanDb,
  [string]$Db,
  [switch]$Install,
  [switch]$InstallPython,
  [switch]$ServerOnly,
  [switch]$DashboardOnly,
  [switch]$NoOpen,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Fail($msg) { Write-Host "X $msg" -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host $msg -ForegroundColor Cyan }

if ($Help) {
  @"
Myrmecia one-click launcher (PowerShell)

Usage:
  ./start.ps1 [options]

Options:
  -CleanDb          Remove the local SQLite database before startup.
  -Db <path>        Use a custom SQLite DB_PATH for this run.
  -Install          Force 'pnpm install' before startup.
  -InstallPython    Install the Myrmecia Python runtime dependencies.
  -ServerOnly       Start only the Express API server.
  -DashboardOnly    Start only the Vite dashboard.
  -NoOpen           Do not open the browser automatically.
  -Help             Show this help.
"@ | Write-Host
  exit 0
}

Write-Host "Myrmecia" -ForegroundColor Green
Write-Host ""

# --- Node (>= 20) ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "Node.js not found. Install Node >= 20 from https://nodejs.org and re-run."
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { Fail "Node >= 20 is required. Current: $(node -v)" }

# --- pnpm (auto-provision via corepack) ---
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Info "Provisioning pnpm via corepack..."
  try {
    corepack enable pnpm 2>$null
    corepack prepare pnpm@latest --activate 2>$null
  } catch { }
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Fail "pnpm not available. Run: npm install -g pnpm  (then re-run ./start.ps1)"
  }
}

# --- python (unless dashboard-only) ---
$python = $null
if (-not $DashboardOnly) {
  foreach ($p in @('python', 'python3')) {
    if (Get-Command $p -ErrorAction SilentlyContinue) { $python = $p; break }
  }
}

# --- load .env into the process environment ---
if (Test-Path ".env") {
  Info "Loading .env"
  Get-Content ".env" | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
      $idx = $line.IndexOf('=')
      $k = $line.Substring(0, $idx).Trim()
      $v = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
      if ($k) { [Environment]::SetEnvironmentVariable($k, $v, 'Process') }
    }
  }
}

# --- clean / custom DB ---
if ($CleanDb) {
  Info "Cleaning local database..."
  @(
    "packages/server/data/agent-factory.db",
    "packages/server/data/agent-factory.db-wal",
    "packages/server/data/agent-factory.db-shm"
  ) | ForEach-Object { Remove-Item -Force -ErrorAction SilentlyContinue $_ }
}
if ($Db) {
  $env:DB_PATH = $Db
  $dir = Split-Path -Parent $Db
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

# --- install JS dependencies ---
if ($Install -or -not (Test-Path "node_modules")) {
  Info "Installing JavaScript dependencies..."
  pnpm install
}

# --- build shared types (server imports the built dist) ---
if (-not (Test-Path "packages/shared/dist/index.js")) {
  Info "Building shared types..."
  pnpm --filter "@myrmecia/shared" build
}

# --- Python runtime dependencies ---
if (-not $DashboardOnly -and $InstallPython) {
  if ($python) {
    Info "Installing Python runtime dependencies..."
    & $python -m pip install -r packages/python-runtime/requirements.txt
  }
  else {
    Write-Host "Warning: Python not found; skipping runtime deps. Install Python 3 to run live agents." -ForegroundColor Yellow
  }
}

$port = if ($env:PORT) { $env:PORT } else { "3000" }
Write-Host ""
Write-Host "Starting Myrmecia..."
Write-Host "  API server:  http://localhost:$port"
if (-not $ServerOnly) { Write-Host "  Dashboard:   http://localhost:5173" }
if ($env:DB_PATH) { Write-Host "  DB_PATH:     $($env:DB_PATH)" }
Write-Host ""

# open the dashboard once it has had a moment to boot
if (-not $NoOpen -and -not $ServerOnly) {
  Start-Job -ScriptBlock { Start-Sleep -Seconds 3; Start-Process "http://localhost:5173" } | Out-Null
}

if ($ServerOnly) { pnpm dev:server }
elseif ($DashboardOnly) { pnpm dev:dashboard }
else { pnpm dev }
