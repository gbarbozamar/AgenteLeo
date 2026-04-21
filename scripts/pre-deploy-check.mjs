#!/usr/bin/env node
/**
 * OpenClaw — Pre-deploy validation script
 *
 * Validates that the project is ready to deploy to Railway.
 * Run via: node scripts/pre-deploy-check.mjs
 *
 * Exit code 0 if all checks pass (warnings allowed).
 * Exit code 1 if any check FAILs.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

// ANSI color helpers (no external deps)
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const OK = c.green('\u2713');
const WARN = c.yellow('\u26A0');
const FAIL = c.red('\u2717');

const results = [];

function record(name, status, detail = '') {
  results.push({ name, status, detail });
}

function pad(str, len) {
  if (str.length >= len) return str;
  return str + ' '.repeat(len - str.length);
}

// ---------------------------------------------------------------------------
// Check 1: package.json exists and has required deps
// ---------------------------------------------------------------------------
function checkPackageJson() {
  const pkgPath = join(ROOT, 'package.json');
  if (!existsSync(pkgPath)) {
    record('package.json', 'FAIL', 'file not found');
    return null;
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    record('package.json', 'FAIL', `invalid JSON: ${err.message}`);
    return null;
  }

  const requiredDeps = ['@modelcontextprotocol/sdk', '@whiskeysockets/baileys'];
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const missing = requiredDeps.filter((d) => !allDeps[d]);

  if (missing.length > 0) {
    record('package.json', 'FAIL', `missing deps: ${missing.join(', ')}`);
  } else {
    record('package.json', 'OK');
  }
  return pkg;
}

// ---------------------------------------------------------------------------
// Check 2: Dockerfile exists
// ---------------------------------------------------------------------------
function checkDockerfile() {
  const p = join(ROOT, 'Dockerfile');
  if (!existsSync(p)) {
    record('Dockerfile', 'FAIL', 'file not found');
    return;
  }
  record('Dockerfile', 'OK');
}

// ---------------------------------------------------------------------------
// Check 3: railway.json exists
// ---------------------------------------------------------------------------
function checkRailwayJson() {
  const p = join(ROOT, 'railway.json');
  if (!existsSync(p)) {
    record('railway.json', 'FAIL', 'file not found');
    return;
  }
  try {
    JSON.parse(readFileSync(p, 'utf8'));
    record('railway.json', 'OK');
  } catch (err) {
    record('railway.json', 'FAIL', `invalid JSON: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Check 4: .env.example exists, .env (optional for local)
// ---------------------------------------------------------------------------
function checkEnvFiles() {
  const examplePath = join(ROOT, '.env.example');
  if (!existsSync(examplePath)) {
    record('.env.example', 'FAIL', 'file not found');
  } else {
    record('.env.example', 'OK');
  }

  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) {
    record('.env', 'WARN', 'not found (fine for Railway — required locally)');
    return null;
  }
  record('.env', 'OK');
  return parseEnvFile(envPath);
}

function parseEnvFile(path) {
  const text = readFileSync(path, 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Check 5: src/ files syntax-check clean
// ---------------------------------------------------------------------------
function checkSourceSyntax() {
  const srcDir = join(ROOT, 'src');
  if (!existsSync(srcDir)) {
    record('src/ syntax', 'FAIL', 'src/ directory not found');
    return;
  }

  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (entry === 'node_modules') continue;
        walk(full);
      } else if (/\.(m?js|cjs)$/.test(entry)) {
        files.push(full);
      }
    }
  })(srcDir);

  if (files.length === 0) {
    record('src/ syntax', 'WARN', 'no .js/.mjs/.cjs files found in src/');
    return;
  }

  const failed = [];
  for (const f of files) {
    try {
      execSync(`node --check "${f}"`, { stdio: 'pipe' });
    } catch (err) {
      const rel = f.replace(ROOT, '').replace(/^[\\/]/, '');
      const msg = (err.stderr?.toString() || err.message || '').split('\n')[0];
      failed.push(`${rel}: ${msg}`);
    }
  }

  if (failed.length > 0) {
    record('src/ syntax', 'FAIL', `${failed.length} file(s) failed:\n    ${failed.join('\n    ')}`);
  } else {
    record('src/ syntax', 'OK', `${files.length} file(s) clean`);
  }
}

// ---------------------------------------------------------------------------
// Check 6: MCP_BEARER_TOKEN generated
// ---------------------------------------------------------------------------
function checkBearerToken(env) {
  if (!env) {
    record('MCP_BEARER_TOKEN', 'WARN', 'skipped (no .env)');
    return;
  }
  const token = env.MCP_BEARER_TOKEN;
  if (!token) {
    record('MCP_BEARER_TOKEN', 'WARN', 'not set in .env');
    return;
  }
  const placeholders = [
    'changeme',
    'change-me',
    'your-token-here',
    'your_token_here',
    'replace-me',
    'placeholder',
    'xxx',
    'todo',
  ];
  const lower = token.toLowerCase();
  if (placeholders.some((p) => lower.includes(p)) || token.length < 16) {
    record('MCP_BEARER_TOKEN', 'WARN', 'looks like a placeholder — generate a real token');
    return;
  }
  record('MCP_BEARER_TOKEN', 'OK');
}

// ---------------------------------------------------------------------------
// Check 7: OWNER_JID set and international format
// ---------------------------------------------------------------------------
function checkOwnerJid(env) {
  if (!env) {
    record('OWNER_JID', 'WARN', 'skipped (no .env)');
    return;
  }
  const jid = env.OWNER_JID;
  if (!jid) {
    record('OWNER_JID', 'WARN', 'not set');
    return;
  }
  // Accept either "+NNN..." plain format or the WhatsApp "NNN...@s.whatsapp.net" JID
  const plusFormat = /^\+\d{7,15}$/.test(jid);
  const jidFormat = /^\+?\d{7,15}(@s\.whatsapp\.net)?$/.test(jid);
  if (!plusFormat && !jidFormat) {
    record('OWNER_JID', 'FAIL', `"${jid}" is not in international format (+NNN...)`);
    return;
  }
  if (!jid.startsWith('+')) {
    record('OWNER_JID', 'WARN', 'prefer leading "+" for international format');
    return;
  }
  record('OWNER_JID', 'OK');
}

// ---------------------------------------------------------------------------
// Check 8: No sensitive data accidentally committed (scan committable files)
// ---------------------------------------------------------------------------
function checkNoSecretsLeaked() {
  const suspectFiles = [
    '.env.example',
    'README.md',
    'DEPLOY-RAILWAY.md',
    'package.json',
    'railway.json',
    'Dockerfile',
  ];

  // Common placeholder markers (these are fine)
  const safeMarkers = [
    'changeme',
    'change-me',
    'your-',
    'your_',
    'replace',
    'placeholder',
    'example',
    '<your',
    'xxx',
    'todo',
    '...',
  ];

  // Patterns that look like REAL secrets (not placeholders)
  const secretPatterns = [
    { name: 'OpenAI/Anthropic-style key', re: /sk-[a-zA-Z0-9]{20,}/ },
    { name: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
    { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
    { name: 'Slack bot token', re: /xox[baprs]-[0-9a-zA-Z-]{10,}/ },
    { name: 'GitHub PAT', re: /ghp_[A-Za-z0-9]{36,}/ },
    { name: 'JWT', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  ];

  const findings = [];
  for (const rel of suspectFiles) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) continue;
    const content = readFileSync(p, 'utf8');
    for (const { name, re } of secretPatterns) {
      const m = content.match(re);
      if (m) {
        const snippet = m[0].slice(0, 12) + '...';
        const lower = m[0].toLowerCase();
        if (safeMarkers.some((sm) => lower.includes(sm))) continue;
        findings.push(`${rel}: possible ${name} (${snippet})`);
      }
    }
  }

  if (findings.length > 0) {
    record('secret scan', 'FAIL', findings.join('\n    '));
  } else {
    record('secret scan', 'OK');
  }
}

// ---------------------------------------------------------------------------
// Check 9: .gitignore contains required entries
// ---------------------------------------------------------------------------
function checkGitignore() {
  const p = join(ROOT, '.gitignore');
  if (!existsSync(p)) {
    record('.gitignore', 'FAIL', 'file not found');
    return;
  }
  const content = readFileSync(p, 'utf8');
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const required = ['.env', 'auth_info/', 'data/'];
  const missing = [];
  for (const req of required) {
    const bare = req.replace(/\/$/, '');
    const hit = lines.some(
      (l) =>
        l === req ||
        l === bare ||
        l === `${bare}/` ||
        l === `/${bare}` ||
        l === `/${bare}/` ||
        l === `${bare}/**` ||
        l === `**/${bare}` ||
        l === `**/${bare}/`
    );
    if (!hit) missing.push(req);
  }

  if (missing.length > 0) {
    record('.gitignore', 'FAIL', `missing ${missing.join(', ')}`);
  } else {
    record('.gitignore', 'OK');
  }
}

// ---------------------------------------------------------------------------
// Run all checks
// ---------------------------------------------------------------------------
console.log(c.bold('\nOpenClaw pre-deploy check\n'));

checkPackageJson();
checkDockerfile();
checkRailwayJson();
const env = checkEnvFiles();
checkSourceSyntax();
checkBearerToken(env);
checkOwnerJid(env);
checkNoSecretsLeaked();
checkGitignore();

// ---------------------------------------------------------------------------
// Print summary
// ---------------------------------------------------------------------------
const maxName = Math.max(...results.map((r) => r.name.length), 20);

for (const r of results) {
  let icon;
  let label;
  if (r.status === 'OK') {
    icon = OK;
    label = c.green('[OK]');
  } else if (r.status === 'WARN') {
    icon = WARN;
    label = c.yellow('[WARN]');
  } else {
    icon = FAIL;
    label = c.red('[FAIL]');
  }
  const detail = r.detail ? ' ' + c.dim(r.detail) : '';
  console.log(`${icon} ${pad(r.name, maxName + 2)} ${label}${detail}`);
}

const failCount = results.filter((r) => r.status === 'FAIL').length;
const warnCount = results.filter((r) => r.status === 'WARN').length;
const okCount = results.filter((r) => r.status === 'OK').length;

console.log('');
console.log(
  c.bold(
    `Summary: ${c.green(okCount + ' OK')}  ${
      warnCount > 0 ? c.yellow(warnCount + ' WARN') : '0 WARN'
    }  ${failCount > 0 ? c.red(failCount + ' FAIL') : '0 FAIL'}`
  )
);

if (failCount > 0) {
  console.log(c.red('\nDeploy blocked — fix FAIL items above.\n'));
  process.exit(1);
} else if (warnCount > 0) {
  console.log(c.yellow('\nReady to deploy (with warnings).\n'));
  process.exit(0);
} else {
  console.log(c.green('\nAll checks passed. Ready to deploy.\n'));
  process.exit(0);
}
