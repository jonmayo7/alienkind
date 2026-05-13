#!/usr/bin/env bash
#
# AlienKind one-line bootstrap (macOS + Linux).
#
# Usage:
#   curl -fsSL https://alienkind.ai/install.sh | bash
#
# What it does:
#   1. Detects your OS + package manager.
#   2. Installs git + Node 20 if missing.
#   3. (Optional) installs Claude Code CLI.
#   4. Clones github.com/jonmayo7/alienkind into ~/alienkind (or $ALIENKIND_DIR).
#   5. npm install + npm run setup.
#
# Environment:
#   ALIENKIND_DIR   — where to clone (default: ~/alienkind)
#   ALIENKIND_REPO  — git URL (default: https://github.com/jonmayo7/alienkind.git)
#   SKIP_CLAUDE=1   — don't install Claude Code CLI
#   AUTO_YES=1      — don't prompt for confirmations (CI / unattended)
#
# Safe to re-run. Existing installs are detected and skipped.

set -euo pipefail

REPO_URL="${ALIENKIND_REPO:-https://github.com/jonmayo7/alienkind.git}"
TARGET_DIR="${ALIENKIND_DIR:-$HOME/alienkind}"
SKIP_CLAUDE="${SKIP_CLAUDE:-0}"
AUTO_YES="${AUTO_YES:-0}"

# ── styling ─────────────────────────────────────────────────────────
B="\033[1m"; D="\033[2m"; R="\033[0m"
C_C="\033[36m"; C_G="\033[32m"; C_Y="\033[33m"; C_R="\033[31m"; C_M="\033[35m"

banner() {
  printf "\n"
  printf "${C_C}              ___${R}\n"
  printf "${C_C}          ___/   \\___${R}\n"
  printf "${C_C}       __/   ${D}'---'${R}${C_C}   \\__${R}\n"
  printf "${C_C}      /    ${C_Y}*${R}  ${C_G}\xF0\x9F\x91\xBD${R}  ${C_Y}*${R}${C_C}     \\${R}\n"
  printf "${C_C}     /___________________\\${R}\n"
  printf "${C_Y}          /  |  |  \\${R}\n"
  printf "${C_Y}         *   *  *   *${R}\n\n"
  printf "     ${B}${C_M}A L I E N   K I N D${R}\n\n"
}

say()  { printf "${C_C}❯${R} %s\n" "$*"; }
ok()   { printf "  ${C_G}✓${R} %s\n" "$*"; }
warn() { printf "  ${C_Y}⚠${R} %s\n" "$*"; }
err()  { printf "  ${C_R}✗${R} %s\n" "$*"; }

confirm() {
  local q="$1"; local default="${2:-y}"
  if [ "$AUTO_YES" = "1" ]; then return 0; fi
  local prompt="[Y/n]"; [ "$default" = "n" ] && prompt="[y/N]"
  printf "  ${C_C}❯${R} %s %s " "$q" "$prompt"
  read -r reply
  [ -z "$reply" ] && reply="$default"
  case "$reply" in y|Y|yes|YES) return 0;; *) return 1;; esac
}

has() { command -v "$1" >/dev/null 2>&1; }

# ── OS detection ────────────────────────────────────────────────────
detect_os() {
  local uname_s; uname_s="$(uname -s)"
  case "$uname_s" in
    Darwin) FAMILY="mac"; PKG="brew";;
    Linux)
      if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        case "${ID:-} ${ID_LIKE:-}" in
          *debian*|*ubuntu*) FAMILY="debian"; PKG="apt";;
          *fedora*|*rhel*|*centos*|*rocky*|*alma*) FAMILY="fedora"; PKG="dnf";;
          *arch*|*manjaro*) FAMILY="arch"; PKG="pacman";;
          *suse*) FAMILY="suse"; PKG="zypper";;
          *alpine*) FAMILY="alpine"; PKG="apk";;
          *) FAMILY="unknown"; PKG="none";;
        esac
      else
        FAMILY="unknown"; PKG="none"
      fi
      ;;
    *) FAMILY="unknown"; PKG="none";;
  esac
}

sudo_run() {
  if [ "$(id -u)" = "0" ]; then "$@"; else sudo "$@"; fi
}

# ── package install ────────────────────────────────────────────────
install_brew_if_missing() {
  if has brew; then ok "Homebrew present"; return 0; fi
  warn "Homebrew not found — required to install packages on macOS"
  if ! confirm "Install Homebrew now?"; then err "Cannot continue without Homebrew."; exit 1; fi
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add brew to PATH for this session
  if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"
  fi
  has brew || { err "Homebrew install failed."; exit 1; }
  ok "Homebrew installed"
}

pkg_install() {
  local pkg="$1"
  case "$PKG" in
    brew)   brew install "$pkg" ;;
    apt)    sudo_run apt-get update -qq && sudo_run apt-get install -y "$pkg" ;;
    dnf)    sudo_run dnf install -y "$pkg" ;;
    pacman) sudo_run pacman -S --noconfirm "$pkg" ;;
    zypper) sudo_run zypper install -y "$pkg" ;;
    apk)    sudo_run apk add --no-cache "$pkg" ;;
    *) err "Unknown package manager — install '$pkg' manually."; return 1 ;;
  esac
}

ensure_git() {
  if has git; then ok "git $(git --version | awk '{print $3}')"; return 0; fi
  warn "git not found"
  if ! confirm "Install git via $PKG?"; then err "git required."; exit 1; fi
  case "$FAMILY" in
    mac) pkg_install git ;;
    *)   pkg_install git ;;
  esac
  has git && ok "git installed" || { err "git install failed"; exit 1; }
}

ensure_node() {
  if has node; then
    local ver; ver="$(node --version 2>/dev/null | sed 's/v//')"
    local maj; maj="${ver%%.*}"
    if [ "${maj:-0}" -ge 20 ]; then ok "Node $ver"; return 0; fi
    warn "Node $ver detected — need ≥20"
  else
    warn "Node not found"
  fi
  if ! confirm "Install/upgrade Node 20 via $PKG?"; then err "Node ≥20 required."; exit 1; fi
  case "$PKG" in
    brew)   brew install node@20 && brew link --overwrite --force node@20 ;;
    apt)    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo_run -E bash - && sudo_run apt-get install -y nodejs ;;
    dnf)    sudo_run dnf module install -y nodejs:20/common ;;
    pacman) sudo_run pacman -S --noconfirm nodejs npm ;;
    zypper) sudo_run zypper install -y nodejs20 npm20 ;;
    apk)    sudo_run apk add --no-cache nodejs npm ;;
    *) err "Install Node 20+ manually from https://nodejs.org and re-run."; exit 1 ;;
  esac
  has node || { err "Node install failed"; exit 1; }
  ok "Node $(node --version) installed"
}

ensure_claude() {
  [ "$SKIP_CLAUDE" = "1" ] && { say "Skipping Claude Code (SKIP_CLAUDE=1)"; return 0; }
  if has claude; then ok "Claude Code CLI present"; return 0; fi
  warn "Claude Code CLI not found"
  if ! confirm "Install Claude Code CLI (npm i -g @anthropic-ai/claude-code)?"; then
    warn "Skipping — install later with: npm i -g @anthropic-ai/claude-code"
    return 0
  fi
  npm install -g @anthropic-ai/claude-code
  has claude && ok "Claude Code installed — run 'claude login' to authenticate" \
             || warn "Install ran but 'claude' not on PATH yet — open a new terminal"
}

# ── clone + setup ──────────────────────────────────────────────────
clone_repo() {
  if [ -d "$TARGET_DIR/.git" ]; then
    ok "Repo exists at $TARGET_DIR"
    if confirm "Pull latest changes?"; then
      (cd "$TARGET_DIR" && git pull --ff-only) || warn "git pull failed — continuing with existing checkout"
    fi
    return 0
  fi
  if [ -e "$TARGET_DIR" ]; then
    err "$TARGET_DIR exists but is not a git repo. Move it aside and re-run."
    exit 1
  fi
  say "Cloning $REPO_URL → $TARGET_DIR"
  git clone "$REPO_URL" "$TARGET_DIR"
  ok "Cloned"
}

run_setup() {
  cd "$TARGET_DIR"
  say "Running npm install"
  npm install --silent
  ok "Dependencies installed"
  say "Launching AlienKind setup wizard..."
  echo
  # Preflight already satisfied — tell wizard to skip its built-in preflight.
  SKIP_PREFLIGHT=1 npm run setup
}

# ── main ────────────────────────────────────────────────────────────
main() {
  banner
  detect_os
  printf "  ${D}Platform: %s · Package manager: %s${R}\n\n" "$FAMILY" "$PKG"

  if [ "$FAMILY" = "unknown" ]; then
    err "Could not identify your Linux distribution. Install git + Node 20 manually, then re-run."
    exit 1
  fi

  if [ "$FAMILY" = "mac" ]; then install_brew_if_missing; fi

  ensure_git
  ensure_node
  ensure_claude

  clone_repo
  run_setup
}

main "$@"
