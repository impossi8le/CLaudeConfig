#!/usr/bin/env node
/**
 * web-search MCP-сервер
 * Локальный веб-поиск через DuckDuckGo (без API-ключа).
 *
 * Запуск:
 *   cd %USERPROFILE%\web-search
 *   npm install
 *   node build/index.js
 *
 * Путь build/index.js используется для совместимости с claude_desktop_config.json.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------
// Простой MCP-сервер на stdio (JSON-RPC 2.0 по линиям)
// ------------------------------------------------------------------
let buf = '';
const tools = [
  {
    name: 'web_search',
    description:
      'Поиск в вебе. Возвращает список результатов (заголовок, url, сниппет).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поисковый запрос' },
        max_results: { type: 'number', description: 'Макс. результатов (1-10)', default: 5 }
      },
      required: ['query']
    }
  }
];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Поиск через DuckDuckGo HTML (без ключа)
async function ddgSearch(query, maxResults = 5) {
  const url =
    'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await res.text();
    // Парсим результаты из HTML-страницы DDG
    const results = [];
    const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g;
    const snipRe = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/g;
    const links = [...html.matchAll(linkRe)];
    const snips = [...html.matchAll(snipRe)];
    for (let i = 0; i < links.length && results.length < maxResults; i++) {
      let href = links[i][1];
      // DDG оборачивает ссылки через uddg=; достаём оригинал
      const uddg = href.match(/uddg=([^&]+)/);
      const realUrl = uddg ? decodeURIComponent(uddg[1]) : href;
      const title = links[i][2].replace(/<[^>]+>/g, '').trim();
      const snippet = snips[i]
        ? snips[i][1].replace(/<[^>]+>/g, '').trim()
        : '';
      results.push({ title, url: realUrl, snippet });
    }
    return results;
  } catch (e) {
    return [{ title: 'Ошибка поиска', url: '', snippet: String(e) }];
  }
}

async function handleRequest(msg) {
  const id = msg.id;
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'web-search', version: '1.0.0' }
      }
    });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params || {};
    if (name === 'web_search') {
      const results = await ddgSearch(args.query, args.max_results || 5);
      const text = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join('\n\n');
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text }],
          isError: false
        }
      });
    } else {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: `Неизвестный инструмент: ${name}` }],
          isError: true
        }
      });
    }
  } else if (msg.method === 'notifications/initialized') {
    // no reply
  } else if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else {
    // Неизвестный метод — отвечаем ошибкой, чтобы клиент не завис
    send({
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32601, message: `Method not found: ${msg.method}` }
    });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      handleRequest(msg);
    } catch (e) {
      // ignore malformed
    }
  }
});

process.stdin.on('end', () => process.exit(0));
