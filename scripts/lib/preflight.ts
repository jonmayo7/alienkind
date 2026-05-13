#!/usr/bin/env npx tsx

/**
 * AlienKind Preflight — detect + install required tooling across OSes.
 *
 * Cross-platform requirement checks for Mac (brew), Linux (apt/dnf/pacman/zypper/apk),
 * and Windows (winget/scoop/choco). Each requirement declares a detect probe and a
 * per-OS install command. Idempotent and consent-gated — every install is shown
 * to the user before running.
 *
 * Used by:
 *   - scripts/setup.ts (step 0 — run before wizard begins)
 *   - scripts/tools/doctor.ts (standalone diagnostic + --fix)
 *
 * Public API:
 *   detectOS()                   — { platform, family, manager, managerCmd }
 *   checkAll()                   — Promise<Result[]>
 *   installRequirement(name, ui) — Promise<boolean>
 *   formatReport(results)        — pretty-printed status
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const readline = require('readline');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};

const MIN_NODE_MAJOR = 20;

export type OSInfo = {
  platform: 'darwin' | 'linux' | 'win32' | 'other';
  family: 'mac' | 'debian' | 'fedora' | 'arch' | 'suse' | 'alpine' | 'windows' | 'unknown';
  manager: 'brew' | 'apt' | 'dnf' | 'pacman' | 'zypper' | 'apk' | 'winget' | 'scoop' | 'choco' | 'none';
  managerInstalled: boolean;
};

export type CheckResult = {
  name: string;
  required: boolean;
  present: boolean;
  version: string | null;
  ok: boolean;       // present AND meets min version
  detail: string;    // human-readable status line
  installable: boolean;
  installCmd?: string;
};

export type Requirement = {
  name: string;
  label: string;
  required: boolean;
  check: () => { present: boolean; version: string | null; ok: boolean; detail: string };
  installCmd: (os: OSInfo) => string | null;
};

// ────────────────────────────────────────────────────────────────────
// OS detection
// ────────────────────────────────────────────────────────────────────

export function detectOS(): OSInfo {
  const plat = process.platform;

  if (plat === 'darwin') {
    const brewPresent = which('brew');
    return { platform: 'darwin', family: 'mac', manager: 'brew', managerInstalled: brewPresent };
  }

  if (plat === 'win32') {
    if (which('winget')) return { platform: 'win32', family: 'windows', manager: 'winget', managerInstalled: true };
    if (which('scoop')) return { platform: 'win32', family: 'windows', manager: 'scoop', managerInstalled: true };
    if (which('choco')) return { platform: 'win32', family: 'windows', manager: 'choco', managerInstalled: true };
    return { platform: 'win32', family: 'windows', manager: 'winget', managerInstalled: false };
  }

  if (plat === 'linux') {
    const family = detectLinuxFamily();
    const manager = managerForFamily(family);
    return { platform: 'linux', family, manager, managerInstalled: manager !== 'none' && which(manager) };
  }

  return { platform: 'other', family: 'unknown', manager: 'none', managerInstalled: false };
}

function detectLinuxFamily(): OSInfo['family'] {
  try {
    const release = fs.readFileSync('/etc/os-release', 'utf8');
    const id = (release.match(/^ID=([^\n]+)/m)?.[1] || '').replace(/"/g, '').toLowerCase();
    const idLike = (release.match(/^ID_LIKE=([^\n]+)/m)?.[1] || '').replace(/"/g, '').toLowerCase();
    const all = `${id} ${idLike}`;
    if (/debian|ubuntu/.test(all)) return 'debian';
    if (/fedora|rhel|centos|rocky|alma/.test(all)) return 'fedora';
    if (/arch|manjaro/.test(all)) return 'arch';
    if (/suse|opensuse/.test(all)) return 'suse';
    if (/alpine/.test(all)) return 'alpine';
  } catch {}
  // Fallback: probe the package manager binaries
  if (which('apt-get')) return 'debian';
  if (which('dnf')) return 'fedora';
  if (which('pacman')) return 'arch';
  if (which('zypper')) return 'suse';
  if (which('apk')) return 'alpine';
  return 'unknown';
}

function managerForFamily(family: OSInfo['family']): OSInfo['manager'] {
  switch (family) {
    case 'debian': return 'apt';
    case 'fedora': return 'dnf';
    case 'arch':   return 'pacman';
    case 'suse':   return 'zypper';
    case 'alpine': return 'apk';
    case 'mac':    return 'brew';
    case 'windows':return 'winget';
    default:       return 'none';
  }
}

function which(cmd: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(probe, [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

function run(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    stdout: (r.stdout || '').toString().trim(),
    stderr: (r.stderr || '').toString().trim(),
  };
}

// ────────────────────────────────────────────────────────────────────
// Per-requirement checks
// ────────────────────────────────────────────────────────────────────

function checkNode() {
  const v = process.versions.node;
  const major = parseInt(v.split('.')[0], 10);
  const ok = major >= MIN_NODE_MAJOR;
  return {
    present: true,
    version: v,
    ok,
    detail: ok ? `Node ${v}` : `Node ${v} — needs ≥${MIN_NODE_MAJOR}`,
  };
}

function checkGit() {
  if (!which('git')) return { present: false, version: null, ok: false, detail: 'git not found' };
  const r = run('git', ['--version']);
  const v = r.stdout.match(/\d+\.\d+\.\d+/)?.[0] || null;
  return { present: true, version: v, ok: true, detail: `git ${v ?? '(unknown version)'}` };
}

function checkClaude() {
  if (!which('claude')) return { present: false, version: null, ok: false, detail: 'claude not found' };
  const r = run('claude', ['--version']);
  const v = r.stdout.match(/\d+\.\d+\.\d+/)?.[0] || null;
  return { present: true, version: v, ok: true, detail: `claude ${v ?? '(present)'}` };
}

function checkGh() {
  if (!which('gh')) return { present: false, version: null, ok: false, detail: 'gh (GitHub CLI) not found (optional)' };
  const r = run('gh', ['--version']);
  const v = r.stdout.match(/\d+\.\d+\.\d+/)?.[0] || null;
  return { present: true, version: v, ok: true, detail: `gh ${v ?? '(present)'}` };
}

function checkPsql() {
  if (!which('psql')) return { present: false, version: null, ok: false, detail: 'psql not found (optional)' };
  const r = run('psql', ['--version']);
  const v = r.stdout.match(/\d+\.\d+/)?.[0] || null;
  return { present: true, version: v, ok: true, detail: `psql ${v ?? '(present)'}` };
}

// Windows-only: detect Restricted ExecutionPolicy that would break npm.ps1 loads.
// On non-Windows or when PowerShell isn't available, this is a no-op (returns ok).
function checkPowershellPolicy() {
  if (process.platform !== 'win32') {
    return { present: true, version: null, ok: true, detail: 'PowerShell ExecutionPolicy (n/a on this OS)' };
  }
  if (!which('powershell') && !which('pwsh')) {
    return { present: false, version: null, ok: true, detail: 'PowerShell not found (skipping policy check)' };
  }
  const ps = which('pwsh') ? 'pwsh' : 'powershell';
  const r = run(ps, ['-NoProfile', '-Command', 'Get-ExecutionPolicy -Scope CurrentUser']);
  const policy = (r.stdout || '').trim() || 'Unknown';
  // Restricted blocks .ps1 loads (npm.ps1, etc). AllSigned also blocks unsigned scripts.
  // RemoteSigned / Unrestricted / Bypass all permit npm.ps1 to run.
  const blocking = /^(Restricted|AllSigned)$/i.test(policy);
  return {
    present: true,
    version: policy,
    ok: !blocking,
    detail: blocking
      ? `PowerShell ExecutionPolicy is ${policy} — blocks npm.ps1 and other tooling`
      : `PowerShell ExecutionPolicy: ${policy}`,
  };
}

// ────────────────────────────────────────────────────────────────────
// Per-OS install commands
// ────────────────────────────────────────────────────────────────────

function nodeInstall(os: OSInfo): string | null {
  switch (os.manager) {
    case 'brew':   return 'brew install node@20 && brew link --overwrite node@20';
    case 'apt':    return 'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs';
    case 'dnf':    return 'sudo dnf module install -y nodejs:20/common';
    case 'pacman': return 'sudo pacman -S --noconfirm nodejs npm';
    case 'zypper': return 'sudo zypper install -y nodejs20 npm20';
    case 'apk':    return 'sudo apk add --no-cache nodejs npm';
    case 'winget': return 'winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements';
    case 'scoop':  return 'scoop install nodejs-lts';
    case 'choco':  return 'choco install nodejs-lts -y';
    default: return null;
  }
}

function gitInstall(os: OSInfo): string | null {
  switch (os.manager) {
    case 'brew':   return 'brew install git';
    case 'apt':    return 'sudo apt-get update && sudo apt-get install -y git';
    case 'dnf':    return 'sudo dnf install -y git';
    case 'pacman': return 'sudo pacman -S --noconfirm git';
    case 'zypper': return 'sudo zypper install -y git';
    case 'apk':    return 'sudo apk add --no-cache git';
    case 'winget': return 'winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements';
    case 'scoop':  return 'scoop install git';
    case 'choco':  return 'choco install git -y';
    default: return null;
  }
}

function claudeInstall(_os: OSInfo): string {
  // Works on every platform once Node is present
  return 'npm install -g @anthropic-ai/claude-code';
}

function powershellPolicyFix(_os: OSInfo): string {
  // RemoteSigned is the Microsoft-recommended default for developer workstations:
  // local scripts run unsigned, remote scripts need a signature. Persists across
  // sessions (CurrentUser scope), so the user never sees this again.
  return 'powershell -NoProfile -Command "Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force"';
}

function psqlInstall(os: OSInfo): string | null {
  switch (os.manager) {
    case 'brew':   return 'brew install libpq && brew link --force libpq';
    case 'apt':    return 'sudo apt-get update && sudo apt-get install -y postgresql-client';
    case 'dnf':    return 'sudo dnf install -y postgresql';
    case 'pacman': return 'sudo pacman -S --noconfirm postgresql-libs';
    case 'zypper': return 'sudo zypper install -y postgresql';
    case 'apk':    return 'sudo apk add --no-cache postgresql-client';
    case 'winget': return 'winget install -e --id PostgreSQL.PostgreSQL --accept-source-agreements --accept-package-agreements';
    case 'scoop':  return 'scoop install postgresql';
    case 'choco':  return 'choco install postgresql -y';
    default: return null;
  }
}

function ghInstall(os: OSInfo): string | null {
  switch (os.manager) {
    case 'brew':   return 'brew install gh';
    case 'apt':    return 'sudo apt-get update && sudo apt-get install -y gh';
    case 'dnf':    return 'sudo dnf install -y gh';
    case 'pacman': return 'sudo pacman -S --noconfirm github-cli';
    case 'zypper': return 'sudo zypper install -y gh';
    case 'apk':    return 'sudo apk add --no-cache github-cli';
    case 'winget': return 'winget install -e --id GitHub.cli --accept-source-agreements --accept-package-agreements';
    case 'scoop':  return 'scoop install gh';
    case 'choco':  return 'choco install gh -y';
    default: return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// Requirement registry
// ────────────────────────────────────────────────────────────────────

export const REQUIREMENTS: Requirement[] = [
  { name: 'node',     label: `Node.js ≥${MIN_NODE_MAJOR}`,            required: true,  check: checkNode,             installCmd: nodeInstall },
  { name: 'git',      label: 'git',                                   required: true,  check: checkGit,              installCmd: gitInstall },
  { name: 'claude',   label: 'Claude Code CLI',                       required: false, check: checkClaude,           installCmd: claudeInstall },
  { name: 'psql',     label: 'psql (Postgres client)',                required: false, check: checkPsql,             installCmd: psqlInstall },
  { name: 'gh',       label: 'gh (GitHub CLI)',                       required: false, check: checkGh,               installCmd: ghInstall },
  // Required on Windows only (no-op elsewhere). Set CurrentUser RemoteSigned so
  // npm.ps1 and other PowerShell-wrapped tooling loads without per-session bypass.
  { name: 'ps-policy', label: 'PowerShell ExecutionPolicy (Windows)', required: true,  check: checkPowershellPolicy, installCmd: powershellPolicyFix },
];

// ────────────────────────────────────────────────────────────────────
// High-level API
// ────────────────────────────────────────────────────────────────────

export function checkAll(os: OSInfo = detectOS()): CheckResult[] {
  return REQUIREMENTS.map((req) => {
    const r = req.check();
    const cmd = req.installCmd(os);
    return {
      name: req.name,
      required: req.required,
      present: r.present,
      version: r.version,
      ok: r.ok,
      detail: r.detail,
      installable: cmd !== null,
      installCmd: cmd || undefined,
    };
  });
}

export function formatReport(results: CheckResult[], os: OSInfo): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${C.bold}Preflight${C.reset} ${C.dim}(${os.platform} · ${os.family} · ${os.manager}${os.managerInstalled ? '' : ' [not installed]'})${C.reset}`);
  lines.push('');
  for (const r of results) {
    const icon = r.ok
      ? `${C.green}✓${C.reset}`
      : r.required
        ? `${C.red}✗${C.reset}`
        : `${C.yellow}○${C.reset}`;
    const label = r.required ? r.detail : `${r.detail} ${C.dim}(optional)${C.reset}`;
    lines.push(`  ${icon} ${label}`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  return new Promise((resolve) => {
    rl.question(`  ${C.cyan}❯${C.reset} ${question} ${C.dim}${suffix}${C.reset} `, (answer: string) => {
      rl.close();
      const a = (answer || '').trim().toLowerCase();
      if (!a) resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

/**
 * Install a single requirement after showing the command and asking consent.
 * Returns true if install succeeded (or was already present).
 */
export async function installRequirement(
  name: string,
  os: OSInfo,
  opts: { autoYes?: boolean } = {}
): Promise<boolean> {
  const req = REQUIREMENTS.find((r) => r.name === name);
  if (!req) return false;

  const current = req.check();
  if (current.ok) return true;

  const cmd = req.installCmd(os);
  if (!cmd) {
    console.log(`  ${C.yellow}⚠${C.reset} No install command for ${req.label} on ${os.platform}/${os.manager} — install manually.`);
    return false;
  }

  // Bootstrap the package manager itself if needed (Mac → Homebrew)
  if (os.platform === 'darwin' && !os.managerInstalled) {
    console.log(`\n  ${C.bold}Homebrew is required to install ${req.label}.${C.reset}`);
    console.log(`  ${C.dim}Install command:${C.reset}`);
    console.log(`    ${C.cyan}/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"${C.reset}`);
    const ok = opts.autoYes || await promptYesNo('Install Homebrew now?', true);
    if (!ok) return false;
    const r = spawnSync('/bin/bash', ['-c', '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)'], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.log(`  ${C.red}✗${C.reset} Homebrew install failed. Install manually from https://brew.sh and re-run.`);
      return false;
    }
    os.managerInstalled = true;
  }

  console.log(`\n  ${C.bold}Install ${req.label}?${C.reset}`);
  console.log(`  ${C.dim}Will run:${C.reset}`);
  console.log(`    ${C.cyan}${cmd}${C.reset}`);
  const consent = opts.autoYes || await promptYesNo(`Run this now?`, req.required);
  if (!consent) {
    console.log(`  ${C.dim}Skipped ${req.label}.${C.reset}`);
    return false;
  }

  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  const args = process.platform === 'win32' ? ['-NoProfile', '-Command', cmd] : ['-lc', cmd];
  const r = spawnSync(shell, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.log(`  ${C.red}✗${C.reset} ${req.label} install exited with code ${r.status}. Fix and re-run.`);
    return false;
  }

  // Re-check
  const after = req.check();
  if (after.ok) {
    console.log(`  ${C.green}✓${C.reset} ${req.label} installed (${after.version ?? 'present'})`);
    return true;
  }
  console.log(`  ${C.yellow}⚠${C.reset} ${req.label} install ran but probe still fails — may need a new terminal (PATH refresh).`);
  return false;
}

/**
 * Run preflight for all requirements. Returns true if every REQUIRED item ends OK.
 * Optional items are offered but not gating.
 *
 * Modes:
 *   - report: only print, never install
 *   - fix:    install missing items after consent
 *   - auto:   install missing required items WITHOUT prompting (use only in bootstrap)
 */
export async function runPreflight(
  mode: 'report' | 'fix' | 'auto' = 'fix',
  opts: { skipOptional?: boolean } = {}
): Promise<{ ok: boolean; results: CheckResult[] }> {
  const os = detectOS();
  let results = checkAll(os);
  console.log(formatReport(results, os));

  if (mode === 'report') {
    const ok = results.every((r) => r.ok || !r.required);
    return { ok, results };
  }

  for (const r of results) {
    if (r.ok) continue;
    if (!r.required && opts.skipOptional) continue;
    if (!r.installable) {
      console.log(`  ${C.yellow}⚠${C.reset} ${r.name}: no installer for this OS — install manually.`);
      continue;
    }
    await installRequirement(r.name, os, { autoYes: mode === 'auto' });
  }

  // Re-evaluate after install attempts
  results = checkAll(os);
  console.log(formatReport(results, os));
  const ok = results.every((r) => r.ok || !r.required);
  return { ok, results };
}

// ────────────────────────────────────────────────────────────────────
// CLI entry (so this file can be invoked directly: npx tsx scripts/lib/preflight.ts)
// ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const arg = process.argv[2] || 'report';
  const mode: 'report' | 'fix' | 'auto' =
    arg === '--fix' || arg === 'fix' ? 'fix'
    : arg === '--auto' || arg === 'auto' ? 'auto'
    : 'report';
  runPreflight(mode).then(({ ok }) => process.exit(ok ? 0 : 1));
}
