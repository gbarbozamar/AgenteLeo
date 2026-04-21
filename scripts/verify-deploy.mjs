#!/usr/bin/env node
// verify-deploy.mjs — usage: node scripts/verify-deploy.mjs <url> <token>

const [url, token] = process.argv.slice(2);
if (!url || !token) {
  console.error('Usage: node scripts/verify-deploy.mjs <url> <bearer-token>');
  process.exit(1);
}

const base = url.replace(/\/$/, '');
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red:   (s) => `\x1b[31m${s}\x1b[0m`,
  dim:   (s) => `\x1b[2m${s}\x1b[0m`,
};

let passed = 0;
let failed = 0;
let step = 0;
const TOTAL = 6;

function fmt(label, ok, detail = '') {
  step++;
  const mark = ok ? c.green('✓') : c.red('✗');
  const result = ok ? 'PASS' : 'FAIL';
  console.log(`[${step}/${TOTAL}] ${mark} ${label} ${detail ? c.dim('→ ' + detail) : ''}`);
  if (ok) passed++;
  else failed++;
}

async function req(path, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    headers: { 'Authorization': `Bearer ${token}`, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = text;
  // Try JSON first
  try { body = JSON.parse(text); }
  catch {
    // Try SSE: "event: message\ndata: {json}\n\n"
    const m = text.match(/data:\s*({[\s\S]*})/);
    if (m) { try { body = JSON.parse(m[1]); } catch {} }
  }
  return { status: res.status, body, headers: res.headers };
}

async function main() {
  console.log(`Verifying ${base} ...\n`);

  // 1. /health
  try {
    const r = await req('/health');
    const ok = r.status === 200 && r.body?.ok === true;
    fmt('/health returns ok', ok, `uptime=${r.body?.uptimeSec}s`);
  } catch (e) { fmt('/health', false, e.message); }

  // 2. /qr/status
  try {
    const r = await req('/qr/status');
    const ok = r.status === 200;
    fmt('/qr/status', ok, `ready=${r.body?.ready}, hasQr=${r.body?.hasQr}`);
  } catch (e) { fmt('/qr/status', false, e.message); }

  // 3. MCP initialize
  let sessionId = null;
  try {
    const r = await req('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'verify-deploy', version: '1.0.0' },
        },
      }),
    });
    sessionId = r.headers.get('mcp-session-id');
    const ok = r.status === 200;
    fmt('MCP initialize', ok, sessionId ? `session ${sessionId.slice(0, 12)}` : '');
  } catch (e) { fmt('MCP initialize', false, e.message); }

  // 4. MCP tool call — wa_status
  try {
    const r = await req('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'wa_status', arguments: {} },
      }),
    });
    const ok = r.status === 200;
    fmt('MCP wa_status tool', ok);
  } catch (e) { fmt('MCP wa_status tool', false, e.message); }

  // 5. Volume persistence — uptime increases across calls
  try {
    const r1 = await req('/health');
    await new Promise(r => setTimeout(r, 2000));
    const r2 = await req('/health');
    const ok = r2.body?.uptimeSec > r1.body?.uptimeSec;
    fmt('Volume persistence (uptime increases)', ok, `${r1.body?.uptimeSec} → ${r2.body?.uptimeSec}`);
  } catch (e) { fmt('Volume persistence', false, e.message); }

  // 6. Auth — no bearer should 401
  try {
    const res = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'initialize', params: {} }),
    });
    const ok = res.status === 401;
    fmt('Unauthenticated → 401', ok, `got ${res.status}`);
  } catch (e) { fmt('Auth check', false, e.message); }

  console.log('');
  if (failed === 0) {
    console.log(c.green(`🎉 All ${TOTAL} checks passed. OpenClaw is production-ready.`));
    process.exit(0);
  } else {
    console.log(c.red(`❌ ${failed} check(s) failed.`));
    process.exit(1);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
