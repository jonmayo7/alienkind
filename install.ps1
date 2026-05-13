# AlienKind one-line bootstrap (Windows).
#
# Usage:
#   irm https://alienkind.ai/install.ps1 | iex
#
# What it does:
#   1. Verifies winget is available (Windows 10 1809+/Windows 11 ships it).
#      Falls back to Scoop / Chocolatey if user has them.
#   2. Installs git + Node 20 if missing.
#   3. (Optional) installs Claude Code CLI.
#   4. Clones github.com/jonmayo7/alienkind into $env:USERPROFILE\alienkind
#      (or $env:ALIENKIND_DIR).
#   5. npm install + npm run setup.
#
# Environment variables:
#   ALIENKIND_DIR   — where to clone (default: $HOME\alienkind)
#   ALIENKIND_REPO  — git URL (default: https://github.com/jonmayo7/alienkind.git)
#   SKIP_CLAUDE=1   — don't install Claude Code CLI
#   AUTO_YES=1      — don't prompt for confirmations
#
# Safe to re-run. Existing installs are detected and skipped.

$ErrorActionPreference = "Stop"

# Default Windows ExecutionPolicy is Restricted, which blocks loading of
# child .ps1 files (e.g. npm.ps1 when we install Claude Code globally).
# Process-scope bypass affects only this session — does not change the
# machine policy or persist after the terminal closes.
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force } catch {}

$RepoUrl  = if ($env:ALIENKIND_REPO) { $env:ALIENKIND_REPO } else { "https://github.com/jonmayo7/alienkind.git" }
$TargetDir = if ($env:ALIENKIND_DIR) { $env:ALIENKIND_DIR } else { Join-Path $env:USERPROFILE "alienkind" }
$SkipClaude = $env:SKIP_CLAUDE -eq "1"
$AutoYes    = $env:AUTO_YES    -eq "1"

# ── styling ───────────────────────────────────────────────────────
function Write-Banner {
@"

              ___
          ___/   \___
       __/   '---'   \__
      /    *  👽  *     \
     /___________________\
          /  |  |  \
         *   *  *   *

     A L I E N   K I N D

"@ | Write-Host -ForegroundColor Cyan
}

function Say  ($m) { Write-Host "❯ $m" -ForegroundColor Cyan }
function OK   ($m) { Write-Host "  ✓ $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  ⚠ $m" -ForegroundColor Yellow }
function Err  ($m) { Write-Host "  ✗ $m" -ForegroundColor Red }

function Confirm-Or-Abort {
  param([string]$Question, [string]$Default = "y")
  if ($AutoYes) { return $true }
  $prompt = if ($Default -eq "y") { "[Y/n]" } else { "[y/N]" }
  $answer = Read-Host "❯ $Question $prompt"
  if ([string]::IsNullOrWhiteSpace($answer)) { $answer = $Default }
  return ($answer -match '^[Yy]')
}

function Has-Command ($Cmd) {
  $null -ne (Get-Command $Cmd -ErrorAction SilentlyContinue)
}

function Refresh-Path {
  # Re-read PATH from machine + user env so freshly-installed binaries are visible.
  $machine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
  $user    = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

# ── package manager selection ─────────────────────────────────────
$PkgManager = $null
if     (Has-Command winget) { $PkgManager = "winget" }
elseif (Has-Command scoop)  { $PkgManager = "scoop" }
elseif (Has-Command choco)  { $PkgManager = "choco" }

function Install-Package {
  param([string]$WingetId, [string]$ScoopName, [string]$ChocoName)
  switch ($PkgManager) {
    "winget" { winget install -e --id $WingetId --accept-source-agreements --accept-package-agreements }
    "scoop"  { scoop install $ScoopName }
    "choco"  { choco install $ChocoName -y }
    default  { throw "No supported package manager (winget/scoop/choco) found." }
  }
  Refresh-Path
}

function Ensure-Git {
  if (Has-Command git) { OK "git $((git --version) -replace 'git version ','')"; return }
  Warn "git not found"
  if (-not (Confirm-Or-Abort "Install git via $PkgManager?")) { Err "git required."; exit 1 }
  Install-Package -WingetId "Git.Git" -ScoopName "git" -ChocoName "git"
  if (-not (Has-Command git)) { Err "git install failed — open a new PowerShell and re-run."; exit 1 }
  OK "git installed"
}

function Ensure-Node {
  if (Has-Command node) {
    $v = (node --version) -replace '^v',''
    $major = [int]($v.Split('.')[0])
    if ($major -ge 20) { OK "Node $v"; return }
    Warn "Node $v detected — need >=20"
  } else {
    Warn "Node not found"
  }
  if (-not (Confirm-Or-Abort "Install/upgrade Node 20 via $PkgManager?")) { Err "Node >=20 required."; exit 1 }
  Install-Package -WingetId "OpenJS.NodeJS.LTS" -ScoopName "nodejs-lts" -ChocoName "nodejs-lts"
  if (-not (Has-Command node)) { Err "Node install completed but 'node' not on PATH — open a new PowerShell and re-run."; exit 1 }
  OK "Node $(node --version) installed"
}

function Ensure-Claude {
  if ($SkipClaude) { Say "Skipping Claude Code (SKIP_CLAUDE=1)"; return }
  if (Has-Command claude) { OK "Claude Code CLI present"; return }
  Warn "Claude Code CLI not found"
  if (-not (Confirm-Or-Abort "Install Claude Code CLI (npm i -g @anthropic-ai/claude-code)?")) {
    Warn "Skipping — install later with: npm i -g @anthropic-ai/claude-code"
    return
  }
  npm install -g "@anthropic-ai/claude-code"
  Refresh-Path
  if (Has-Command claude) {
    OK "Claude Code installed — run 'claude login' to authenticate"
  } else {
    Warn "Install ran but 'claude' not on PATH yet — open a new PowerShell"
  }
}

function Clone-Repo {
  if (Test-Path (Join-Path $TargetDir ".git")) {
    OK "Repo exists at $TargetDir"
    if (Confirm-Or-Abort "Pull latest changes?") {
      Push-Location $TargetDir
      try { git pull --ff-only } catch { Warn "git pull failed — continuing with existing checkout" }
      Pop-Location
    }
    return
  }
  if (Test-Path $TargetDir) {
    Err "$TargetDir exists but is not a git repo. Move it aside and re-run."
    exit 1
  }
  Say "Cloning $RepoUrl -> $TargetDir"
  git clone $RepoUrl $TargetDir
  OK "Cloned"
}

function Run-Setup {
  Push-Location $TargetDir
  try {
    Say "Running npm install"
    npm install --silent
    OK "Dependencies installed"
    Say "Launching AlienKind setup wizard..."
    Write-Host ""
    $env:SKIP_PREFLIGHT = "1"   # preflight already satisfied
    npm run setup
  } finally {
    Pop-Location
  }
}

# ── main ──────────────────────────────────────────────────────────
Write-Banner

if (-not $PkgManager) {
  Err "No supported package manager found (winget/scoop/choco)."
  Write-Host "  winget ships with Windows 10 1809+ / Windows 11."
  Write-Host "  Update via Microsoft Store -> 'App Installer', or install Scoop:"
  Write-Host "    Set-ExecutionPolicy -Scope CurrentUser RemoteSigned; irm get.scoop.sh | iex"
  exit 1
}
Write-Host "  Package manager: $PkgManager`n" -ForegroundColor DarkGray

Ensure-Git
Ensure-Node
Ensure-Claude
Clone-Repo
Run-Setup
