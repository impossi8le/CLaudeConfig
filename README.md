# CLaudeConfig

Готовая конфигурация для **Claude Desktop (Cowork / 3p)**: **14 MCP-серверов**, **42 скилла**, локальные прокси и конфиг **LiteLLM** для проксирования моделей через `routerai.ru`.

Перенос на другой компьютер — см. **[INSTALL-NEW-PC.md](INSTALL-NEW-PC.md)**.

---

## 📁 Структура

| Файл / папка | Что это |
|---|---|
| `claude_desktop_config.json` | Конфиг Claude Desktop с плейсхолдерами `YOUR_*` |
| `claude_desktop_config.example.json` | То же (шаблон) |
| `setup-config.ps1` | Спросит ключи и создаст реальный конфиг в `%APPDATA%\Claude\` |
| `install.bat` | Автоустановщик: проверка окружения + npm/pip пакеты |
| `memory-proxy.cjs` | Прокси для MCP Memory (срезает `$schema` draft-07) |
| `n8n-mcp-fix-proxy.mjs` | Прокси для n8n MCP (чинит draft-07 схему, n8n#36361) |
| `orchestrator-mcp/` | MCP-сервер оркестратора: 6 ролей через RouterAI |
| `skills/` | 42 скилла |
| `ClaudeConfigLiteLLM.yaml` | Конфиг LiteLLM для проксирования Claude-моделей |
| `INSTALL-NEW-PC.md` | Пошаговая инструкция переноса на другую машину |

---

## ⚙️ Требования

| Компонент | Зачем | Где взять |
|---|---|---|
| Windows 10/11 | ОС | — |
| **Node.js 18+** | MCP-серверы | https://nodejs.org |
| **Python 3.9+** | LiteLLM | https://python.org |
| **Git** | клонирование | https://git-scm.com |
| **Docker Desktop** | `mcp_docker` | https://www.docker.com/products/docker-desktop/ |
| **Rust + cargo** | `lean-ctx` | https://rustup.rs |
| **github-mcp-server.exe** | `github` | https://github.com/github/github-mcp-server/releases |

---

## 🚀 Установка

```bat
git clone https://github.com/impossi8le/CLaudeConfig.git
cd CLaudeConfig
install.bat
```

Затем сгенерировать конфиг с ключами:

```powershell
powershell -ExecutionPolicy Bypass -File setup-config.ps1
```

Перезапустите Claude Desktop — MCP-серверы подхватятся.

---

## 🧩 MCP-серверы (14)

| MCP | Что делает | Требует |
|---|---|---|
| `local-memory` | Долговременная память (knowledge graph) | `memory-proxy.cjs` |
| `mcp_docker` | Управление Docker | Docker Desktop |
| `filesystem` | Доступ к файлам | — |
| `sequential-thinking` | Цепочки рассуждений | — |
| `github` | GitHub: PR, issues, код | `GITHUB_PERSONAL_ACCESS_TOKEN` |
| `n8n-local` | Автоматизация n8n | URL + Bearer-токен + `n8n-mcp-fix-proxy.mjs` |
| `curl-client` | HTTP-запросы | — |
| `alolite-ssh` | SSH по MCP | SSH-хост / логин / пароль |
| `tavily-mcp` | Поиск через Tavily | `TAVILY_API_KEY` |
| `tavily2-mc` | Второй инстанс Tavily | `TAVILY_API_KEY` |
| `playwright` | Браузерная автоматизация | — |
| `orchestrator-mcp` | Мультиагентный конвейер (6 ролей) | `ROUTERAI_API_KEY` |
| `context7` | Актуальная документация библиотек | — |
| `lean-ctx` | Экономия контекста | Rust-бинарь `lean-ctx` |

---

## 🎯 Скиллы (42)

Папка `skills/`. Установка:

```bash
xcopy /E /I /Y skills "%USERPROFILE%\.claude\skills"
```

Ключевые: `orchestrator`, `docs-orchestration`, `graphify`, набор `tavily-*`, `brainstorming`, `systematic-debugging`, `test-driven-development`, `writing-plans`, `mcp-builder`, `skill-creator`.

---

## 🖥️ LiteLLM

Подменяет модели Claude через прокси `routerai.ru`.

```bash
pip install "litellm[proxy]"
litellm --config ClaudeConfigLiteLLM.yaml --port 4000
```

Замените `YOUR_ROUTERAI_API_KEY` на реальный ключ. Подключение в Claude Desktop:

```json
"env": {
  "ANTHROPIC_BASE_URL": "http://localhost:4000",
  "ANTHROPIC_AUTH_TOKEN": "sk-ваш-токен"
}
```

---

## ❓ FAQ

| Проблема | Решение |
|---|---|
| MCP не появился | Проверьте валидность JSON, перезапустите Claude Desktop полностью (трей → Exit) |
| `npx` долго стартует | Первый запуск качает пакет, дальше кэш |
| `github` не работает | Проверьте токен и права (`repo`, `read:org`) |
| `lean-ctx` не найден | `cargo install lean-ctx`, добавьте `.cargo\bin` в `PATH` |
| `orchestrator-mcp` падает | Не сделан `npm install` в его папке |
| Логи MCP | `%APPDATA%\Claude\logs\mcp-server-*.log` |

---

## ⚠️ Безопасность

- **В репозитории нет реальных ключей** — только плейсхолдеры `YOUR_*`.
- Реальный конфиг генерируется локально через `setup-config.ps1` и в git не попадает.
- Не коммитьте `claude_desktop_config.json` с реальными ключами.

---

Лицензия: **MIT**.
