#!/usr/bin/env node
/**
 * memory-proxy.cjs
 * Прокси-обёртка для @modelcontextprotocol/server-memory.
 * Запускает сервер через npx и прокидывает stdio.
 *
 * Установка: скопировать в %USERPROFILE%\.claude\mcp\memory-proxy.cjs
 */
const { spawn } = require('child_process');

const cmd = process.env.MCP_MEMORY_SERVER_CMD || 'npx';
const args = (process.env.MCP_MEMORY_SERVER_ARGS || '-y @modelcontextprotocol/server-memory').split(' ');

const child = spawn(cmd, args, {
  stdio: ['pipe', 'pipe', 'inherit'],
  shell: process.platform === 'win32'
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);

child.on('exit', (code) => {
  process.exit(code || 0);
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
