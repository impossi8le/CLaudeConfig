#!/usr/bin/env node
/**
 * n8n MCP draft-07 schema fix proxy (n8n-io/n8n#36361).
 *
 * WHY IT EXISTS
 * The n8n instance MCP endpoint (/mcp-server/http) stamps
 *   "$schema": "http://json-schema.org/draft-07/schema#"
 * on the inputSchema and the outputSchema of every tool. Current Claude Code
 * bundles a validator that compiles JSON Schema 2020-12 only and rejects the
 * declared draft-07 dialect, so every n8n MCP tool fails to load.
 *
 * WHAT IT DOES
 * Spawns `npx mcp-remote` with the same args it received, forwards stdin/stdout
 * verbatim, and on a tools/list response deletes every `$schema` key from each
 * tool's inputSchema and outputSchema.
 *
 * It deletes ONLY `$schema`, never `outputSchema` — the output schema keeps
 * working as a validator, which matches what n8n 2.35.0 does (delete jsonSchema.$schema).
 *
 * DIALECT RISK
 * Deleting `$schema` reinterprets the document as 2020-12. A few keywords differ
 * across dialects; the proxy scans each schema and logs DIALECT-RISK for those.
 *
 * CLIENT CONFIG CHANGE
 * Replace:
 *   { "command": "npx", "args": ["-y", "mcp-remote", "<url>", "--allow-http", "--header", "Authorization: Bearer <token>"] }
 * with:
 *   { "command": "node", "args": ["<path-to>/n8n-mcp-fix-proxy.mjs", "<url>", "--allow-http", "--header", "Authorization: Bearer <token>"] }
 * Keep every remaining argument and env block untouched.
 *
 * DELETE THIS FILE WHEN
 * 1) the server reaches n8n 2.35.0 or later, OR
 * 2) the client moves @modelcontextprotocol/server to 2.0.0 stable or later
 *    (which accepts draft-07 natively).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import process from 'node:process';

const SELF_TEST = process.argv[2] === '--self-test';
const childArgs = SELF_TEST ? process.argv.slice(3) : process.argv.slice(2);

const NPX = process.env.NPX || 'npx.cmd';

// Resolve mcp-remote per machine: env override first, then the global npm root.
function resolveMcpRemote() {
  if (process.env.MCP_REMOTE_JS) return process.env.MCP_REMOTE_JS;
  const candidates = [];
  if (process.env.APPDATA) candidates.push(`${process.env.APPDATA}\\npm\\node_modules\\mcp-remote\\dist\\proxy.js`);
  if (process.env.npm_config_prefix) candidates.push(`${process.env.npm_config_prefix}\\node_modules\\mcp-remote\\dist\\proxy.js`);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0] || 'mcp-remote/dist/proxy.js';
}

const MCP_REMOTE = resolveMcpRemote();
// Спавним mcp-remote напрямую через node, чтобы аргументы (в т.ч. --header с пробелами) не разбивались shell'ом.
const child = spawn(process.execPath, [MCP_REMOTE, ...childArgs], {
  stdio: SELF_TEST ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'inherit'],
  env: process.env,
  windowsHide: false,
});

function dialectRisk(schema, path = '') {
  const risks = [];
  if (!schema || typeof schema !== 'object') return risks;
  for (const [key, value] of Object.entries(schema)) {
    const p = path ? `${path}.${key}` : key;
    if (key === 'items' && Array.isArray(value)) {
      risks.push({ path: p, reason: 'tuple-form items (needs prefixItems in 2020-12)' });
    } else if (key === 'additionalItems') {
      risks.push({ path: p, reason: 'additionalItems is 2020-12-incompatible' });
    } else if (key === 'dependencies') {
      risks.push({ path: p, reason: 'dependencies is 2020-12-incompatible' });
    } else if ((key === 'exclusiveMinimum' || key === 'exclusiveMaximum') && typeof value === 'boolean') {
      risks.push({ path: p, reason: 'boolean exclusiveMinimum/Maximum is draft-07-only' });
    } else if (key === '$ref' && Object.keys(schema).some((k) => k !== '$ref' && !['description', 'title', '$comment', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly'].includes(k))) {
      risks.push({ path: p, reason: '$ref has constraining siblings (ignored in draft-07, applied in 2020-12)' });
    }
    if (typeof value === 'object') risks.push(...dialectRisk(value, p));
  }
  return risks;
}

function stripSchema(tool) {
  let deleted = 0;
  for (const key of ['inputSchema', 'outputSchema']) {
    const schema = tool[key];
    if (schema && typeof schema === 'object') {
      for (const risk of dialectRisk(schema)) {
        process.stderr.write(`DIALECT-RISK: ${risk.path} ${risk.reason}\n`);
      }
      if (Object.prototype.hasOwnProperty.call(schema, '$schema')) {
        delete schema.$schema;
        deleted++;
      }
    }
  }
  return deleted;
}

const rl = createInterface({ input: child.stdout });

rl.on('line', (line) => {
  if (SELF_TEST) return;
  if (line.includes('$schema')) {
    try {
      const msg = JSON.parse(line);
      if (msg.result && Array.isArray(msg.result.tools)) {
        let deleted = 0;
        let remaining = 0;
        for (const tool of msg.result.tools) {
          deleted += stripSchema(tool);
          const json = JSON.stringify(tool);
          if (json.includes('"$schema"')) remaining++;
        }
        process.stderr.write(`[n8n-proxy] stripped $schema from ${deleted} schemas across ${msg.result.tools.length} tools\n`);
        if (remaining > 0) process.stderr.write(`[n8n-proxy] WARNING: ${remaining} tools still contain $schema\n`);
        process.stdout.write(JSON.stringify(msg) + '\n');
        return;
      }
    } catch {
      // not JSON-RPC or not parseable — pass through untouched
    }
  }
  process.stdout.write(line + '\n');
});

process.stdin.pipe(child.stdin);
process.stdin.on('end', () => child.stdin.end());

function forward(sig) {
  try { child.kill(sig); } catch {}
}
process.on('SIGTERM', () => forward('SIGTERM'));
process.on('SIGINT', () => forward('SIGINT'));

child.on('exit', (code) => {
  if (!SELF_TEST) process.exit(code ?? 0);
});

// ---- Self-test mode ----
if (SELF_TEST) {
  const state = { tools: 0, deleted: 0, remaining: 0, inputKept: 0, outputKept: 0, risk: 0 };
  let initialized = false;
  const send = (obj) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(obj) + '\n'); };
  const selfRl = createInterface({ input: child.stdout });
  selfRl.on('line', (line) => {
    if (!line.includes('{')) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!initialized && msg.result && msg.result.serverInfo) {
      initialized = true;
      setTimeout(() => {
        send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      }, 500);
    }
    if (msg.result && Array.isArray(msg.result.tools)) {
      state.tools = msg.result.tools.length;
      for (const tool of msg.result.tools) {
        state.deleted += stripSchema(tool);
        if (JSON.stringify(tool).includes('"$schema"')) state.remaining++;
        if (tool.inputSchema) state.inputKept++;
        if (tool.outputSchema) state.outputKept++;
      }
      report();
    }
  });
  let riskCount = 0;
  child.stderr.on('data', (d) => {
    const s = d.toString();
    if (s.includes('DIALECT-RISK')) riskCount++;
    if (!s.includes('DIALECT-RISK')) process.stderr.write('[st] ' + s);
  });
  child.on('error', (e) => { process.stderr.write(`SELF-TEST CHILD ERROR: ${e.message}\n`); process.exit(1); });

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'n8n-proxy-selftest', version: '1.0' } } });

  function report() {
    const pass = state.tools > 0 && state.deleted > 0 && state.remaining === 0 && state.outputKept > 0 && riskCount === 0;
    process.stderr.write(`SELF-TEST: tools=${state.tools} deleted=${state.deleted} remaining=${state.remaining} inputSchemas=${state.inputKept} outputSchemas=${state.outputKept} dialectRisks=${riskCount}\n`);
    process.stderr.write(pass ? 'SELF-TEST PASS\n' : 'SELF-TEST FAIL\n');
    try { child.kill(); } catch {}
    process.exit(pass ? 0 : 1);
  }

  setTimeout(() => {
    if (state.tools === 0) {
      process.stderr.write('SELF-TEST TIMEOUT (no tools/list received)\n');
      try { child.kill(); } catch {}
      process.exit(1);
    }
  }, 15000);
}
