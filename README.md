# Claude Desktop — конфигурация и установка MCP-серверов

Готовая конфигурация для **Claude Desktop (Cowork / 3p)** с набором из **18 MCP-серверов**, а также конфиг **LiteLLM** для проксирования моделей через `routerai.ru`.

---

## 📁 Структура репозитория

| Файл | Что это |
|---|---|
| `claude_desktop_config.json` | Готовый конфиг Claude Desktop (**вставьте свои ключи!**) |
| `claude_desktop_config.example.json` | Шаблон конфига с плейсхолдерами `YOUR_*` |
| `install.bat` | Автоустановщик: проверка окружения + установка всех npm/pip пакетов |
| `setup-config.ps1` | Генератор конфига: спросит ключи и сам создаст `claude_desktop_config.json` |
| `memory-proxy.cjs` | Прокси-обёртка для MCP Memory-сервера (ставится в `~/.claude/mcp/`) |
| `ClaudeConfigLiteLLM.yaml` | Конфиг LiteLLM для проксирования Claude-моделей |
| `ClaudeConfigLiteLLM.example.yaml` | То же, но с плейсхолдерами |
| `web-search/` | Локальный MCP-сервер веб-поиска (Node.js, DuckDuckGo) |

---

## ⚙️ Требования

| Компонент | Зачем | Где взять |
|---|---|---|
| **Windows 10/11** | ОС | — |
| **Node.js 18+** (с npm) | большинство MCP-серверов | https://nodejs.org |
| **Python 3.9+** | `fetch`, LiteLLM | https://python.org (галочка **Add to PATH**) |
| **Docker Desktop** | MCP-сервер `mcp_docker` (опционально) | https://www.docker.com/products/docker-desktop/ |
| **Google Chrome** | `chrome-devtools`, `playwright` | https://www.google.com/chrome/ |
| **GitHub Desktop / GitHub MCP** | MCP-сервер `github` | https://desktop.github.com |

> ⚠️ **GitHub MCP-сервер** — если `github-mcp-server.exe` не появился после установки GitHub Desktop, скачайте его отдельно:
> `winget install GitHub.cli` или возьмите бинарник из https://github.com/github/github-mcp-server/releases и положите в `%LOCALAPPDATA%\github\github-mcp-server.exe`.

---

## 🚀 Быстрый старт

```bat
git clone https://github.com/impossi8le/CLaudeConfig.git
cd CLaudeConfig
install.bat
```

Затем сгенерировать конфиг с ключами:

```powershell
powershell -ExecutionPolicy Bypass -File setup-config.ps1
```

Скрипт по очереди спросит **ключи и токены** и создаст готовый `claude_desktop_config.json` в папке `%APPDATA%\Claude\`.

Перезапустите Claude Desktop — все MCP-серверы подхватятся.

---

## 🧩 Список MCP-серверов

| MCP | Что делает | Требует |
|---|---|---|
| `local-memory` | Долговременная память (knowledge graph) | `memory-proxy.cjs` |
| `mcp_docker` | Управление Docker через MCP | Docker Desktop |
| `filesystem` | Доступ к файлам | — |
| `sequential-thinking` | Цепочки рассуждений | — |
| `anthropic-global-skills` | Папка `~/.claude/skills` | — |
| `github` | Работа с GitHub (PR, issues, код) | `GITHUB_PERSONAL_ACCESS_TOKEN` |
| `fetch` | Получение веб-страниц | Python `mcp-server-fetch` |
| `chrome-devtools` | Управление Chrome (DevTools) | Chrome с портом `9223` |
| `web-search` | Локальный веб-поиск | локальный Node-сервер |
| `curl-client` | HTTP-запросы | — |
| `alolite-ssh` | SSH по MCP | SSH-хост/логин/пароль |
| `tavily-mcp` | Поиск через Tavily | `TAVILY_API_KEY` |
| `tavily2-mc` | Дубликат Tavily | `TAVILY_API_KEY` |
| `ssh-remote-server` | Ещё один SSH-клиент | SSH-хост/логин/пароль |
| `google-sheets` | Работа с Google Таблицами | Service Account JSON |
| `puppeteer` | Браузерная автоматизация | — |
| `gmail-global` | Gmail по MCP | OAuth-настройка |
| `playwright` | Браузерная автоматизация (Playwright) | — |

---

## 🔧 Установка вручную (если не хотите `install.bat`)

### 1. npm-пакеты (все MCP-серверы)

```bat
npm install -g @modelcontextprotocol/server-memory
npm install -g @modelcontextprotocol/server-filesystem
npm install -g @modelcontextprotocol/server-sequential-thinking
npm install -g @modelcontextprotocol/server-puppeteer
npm install -g chrome-devtools-mcp@latest
npm install -g @calibress/curl-mcp
npm install -g @alolite/ssh-mcp
npm install -g tavily-mcp@latest
npm install -g ssh-mcp
npm install -g mcp-gsheets@latest
npm install -g @gongrzhe/server-gmail-autoauth-mcp
npm install -g @playwright/mcp@latest
```

### 2. Python-пакеты

```bat
pip install mcp-server-fetch
pip install "litellm[proxy]"
```

> На Linux/системном Python может понадобиться флаг `--break-system-packages`.

### 3. Папки и файлы

```bat
mkdir "%USERPROFILE%\.claude\mcp"
mkdir "%USERPROFILE%\.claude\skills"
copy /Y memory-proxy.cjs "%USERPROFILE%\.claude\mcp\memory-proxy.cjs"
```

### 4. Локальный web-search

```bat
mkdir "%USERPROFILE%\web-search"
copy /Y web-search\index.js "%USERPROFILE%\web-search\index.js"
copy /Y web-search\package.json "%USERPROFILE%\web-search\package.json"
cd "%USERPROFILE%\web-search"
npm install
```

---

## 🔑 Где взять ключи

| Ключ | Где взять |
|---|---|
| **GitHub PAT** | GitHub → Settings → Developer settings → Personal access tokens (права: `repo`, `read:org`) |
| **Tavily API Key** | https://app.tavily.com → API Keys |
| **Google Service Account** | Google Cloud Console → IAM → Service Accounts → Create Key (JSON) |

---

## 🖥️ LiteLLM (проксирование Claude-моделей)

Файл `ClaudeConfigLiteLLM.yaml` позволяет подменять модели Claude через прокси `routerai.ru`.

### Установка

```bat
pip install "litellm[proxy]"
```

### Запуск

```bat
litellm --config ClaudeConfigLiteLLM.yaml --port 4000
```

### Подключение в Claude Desktop

Добавьте в `claude_desktop_config.json` блок окружения:

```json
"env": {
  "ANTHROPIC_BASE_URL": "http://localhost:4000",
  "ANTHROPIC_AUTH_TOKEN": "sk-ваш-токен"
}
```

---

## 🧪 Chrome для chrome-devtools (порт 9223)

`chrome-devtools` подключается к Chrome с удалённой отладкой. Запустите Chrome с флагом:

```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9223
```

Или создайте ярлык Chrome с аргументом `--remote-debugging-port=9223`.

---

## ❓ FAQ / Решение проблем

| Проблема | Решение |
|---|---|
| MCP не появился в списке | Проверьте `claude_desktop_config.json` на валидность JSON, перезапустите Claude Desktop |
| `npx` долго запускает сервер | Первый запуск качает пакет; дальше кэш ускорит |
| `github` не работает | Проверьте токен и права (`repo`, `read:org`) |
| `chrome-devtools` не подключается | Запущен ли Chrome с `--remote-debugging-port=9223`? |
| `google-sheets` ошибка авторизации | Убедитесь, что JSON-ключ лежит по указанному пути и Service Account включён |
| `fetch` не запускается | `pip install mcp-server-fetch` и проверьте `python -m mcp_server_fetch` |
| Изменения конфига не применились | Полностью закройте Claude Desktop (трей → Exit) и запустите заново |

---

## ⚠️ Безопасность

- **Никогда не коммитьте реальные токены!** В этом репозитории токены заменены на плейсхолдеры.
- Файл `claude_desktop_config.json` с реальными ключами добавьте в `.gitignore`, если храните его рядом.
- Пример `.gitignore`:

```gitignore
claude_desktop_config.json
*.json.key
google-sheets-key.json
.env
```

---

Лицензия: **MIT**. Сделано для личного использования — используйте на свой страх и риск.
