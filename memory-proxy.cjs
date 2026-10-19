#!/usr/bin/env node
// MCP stdio proxy that strips "$schema": draft-07 from JSON-RPC messages so a
// client requiring JSON Schema 2020-12 (SEP-1613) accepts them. The MCP spec
// treats a missing "$schema" as 2020-12, so removing the key is safe.
const { spawn } = require('child_process');
const readline = require('readline');

const serverCmd = process.env.MCP_MEMORY_SERVER_CMD || 'npx';
const serverArgs = process.env.MCP_MEMORY_SERVER_ARGS
  ? process.env.MCP_MEMORY_SERVER_ARGS.split(/\s+/)
  : ['-y', '@modelcontextprotocol/server-memory'];

const child = spawn(serverCmd, serverArgs, {
  stdio: ['pipe', 'pipe', 'inherit'],
  shell: process.platform === 'win32',
});

function stripSchema(value) {
  if (Array.isArray(value)) {
    for (const item of value) stripSchema(item);
  } else if (value && typeof value === 'object') {
    delete value.$schema;
    for (const key of Object.keys(value)) stripSchema(value[key]);
  }
  return value;
}

const clientToServer = readline.createInterface({ input: process.stdin });
clientToServer.on('line', (line) => {
  child.stdin.write(line + '\n');
});

const serverToClient = readline.createInterface({ input: child.stdout });
serverToClient.on('line', (line) => {
  let out = line;
  try {
    const msg = JSON.parse(line);
    if (msg.result && (msg.result.tools || msg.result.resources || msg.result.prompts)) {
      if (msg.result.tools) {
        for (const tool of msg.result.tools) {
          if (tool.inputSchema) stripSchema(tool.inputSchema);
          if (tool.outputSchema) stripSchema(tool.outputSchema);
        }
      }
      if (msg.result.resources) {
        for (const res of msg.result.resources) {
          if (res.content) stripSchema(res.content);
        }
      }
      out = JSON.stringify(msg);
    }
  } catch (e) {
    // Not JSON (e.g. an empty keepalive line) — pass through unchanged.
  }
  process.stdout.write(out + '\n');
});

child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('mcp-memory-proxy:', err.message);
  process.exit(1);
});
process.stdin.on('end', () => {
  child.stdin.end();
});
