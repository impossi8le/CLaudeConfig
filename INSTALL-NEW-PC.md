# Установка на новый компьютер

Пошаговая инструкция для переноса этой сборки (MCP-серверы + скиллы) на другую машину с Windows.

> **Главное:** конфиг в репозитории содержит только плейсхолдеры `YOUR_*`. Реальные ключи никуда не коммитятся и вводятся на новом компьютере скриптом `setup-config.ps1`.

---

## 1. Предварительные требования

| Компонент | Версия | Ссылка | Проверка |
|---|---|---|---|
| Windows | 10/11 | — | — |
| Node.js | 18+ | https://nodejs.org | `node --version` |
| Python | 3.9+ (в PATH) | https://python.org | `python --version` |
| Git | любая | https://git-scm.com | `git --version` |
| Docker Desktop | — | https://www.docker.com/products/docker-desktop/ | нужен для `mcp_docker` |
| Claude Desktop | Cowork / 3p | — | — |
| Rust + cargo | — | https://rustup.rs | нужен только для `lean-ctx` |

Node.js и Python обязательны — без них `install.bat` остановится.

---

## 2. Клонирование и установка пакетов

```bat
git clone https://github.com/impossi8le/CLaudeConfig.git
cd CLaudeConfig
install.bat
```

`install.bat` проверит окружение, поставит npm- и pip-пакеты, создаст нужные папки и скопирует прокси.

---

## 3. Генерация конфига с ключами

```powershell
powershell -ExecutionPolicy Bypass -File setup-config.ps1
```

Скрипт по очереди спросит ключи (Enter — пропустить, если сервис не нужен):

| Что спросит | Где взять | Какой MCP использует |
|---|---|---|
| GitHub PAT | GitHub → Settings → Developer settings → PAT (права `repo`, `read:org`) | `github` |
| Tavily API Key | https://app.tavily.com → API Keys | `tavily-mcp`, `tavily2-mc` |
| n8n URL | адрес вашего n8n-инстанса | `n8n-local` |
| n8n Bearer токен | n8n → Settings → MCP Server | `n8n-local` |
| SSH хост / пользователь / пароль | ваш сервер | `alolite-ssh` |
| routerai.ru API ключ | https://routerai.ru | `orchestrator-mcp` |

Готовый `claude_desktop_config.json` создаётся в `%APPDATA%\Claude\`.

Если ставите на **другой** компьютер с нуля, а не через скрипт — скопируйте `claude_desktop_config.json` из репозитория в `%APPDATA%\Claude\` и вручную замените все `YOUR_*` на реальные значения.

---

## 4. Что нужно доустановить руками

Три компонента **не** ставятся автоматически — они машинно-зависимые:

### 4.1. `github-mcp-server.exe`

Не входит в репозиторий (25 МБ бинарник). Скачать с GitHub Releases:

https://github.com/github/github-mcp-server/releases

Положить в `%LOCALAPPDATA%\github\github-mcp-server.exe` — имя папки `github` важно, именно этот путь прописан в конфиге.

### 4.2. `lean-ctx`

Ставится только через Rust toolchain:

```bash
cargo install lean-ctx
```

Окажется в `%USERPROFILE%\.cargo\bin\lean-ctx.exe`. Убедитесь, что `.cargo\bin` есть в `PATH`, иначе конфиг его не найдёт.

### 4.3. `orchestrator-mcp`

Папка есть в репозитории, но без `node_modules` (они слишком большие для git). Доустановить зависимости:

```bash
cd %USERPROFILE%\orchestrator-mcp
npm install
```

---

## 5. Скиллы

42 скилла лежат в папке `skills/` репозитория. Скопировать в личную папку Claude:

```bash
xcopy /E /I /Y skills "%USERPROFILE%\.claude\skills"
```

После копирования перезапустите Claude Desktop — скиллы подхватятся автоматически.

---

## 6. LiteLLM (опционально)

Прокси подменяет Claude-модели через `routerai.ru`. Нужен только если хотите гонять модели через прокси.

Установка и запуск:

```bash
pip install "litellm[proxy]"
litellm --config ClaudeConfigLiteLLM.yaml --port 4000
```

В `ClaudeConfigLiteLLM.yaml` замените все `YOUR_ROUTERAI_API_KEY` на реальный ключ. Затем добавьте в `claude_desktop_config.json`:

```json
"env": {
  "ANTHROPIC_BASE_URL": "http://localhost:4000",
  "ANTHROPIC_AUTH_TOKEN": "sk-ваш-токен"
}
```

---

## 7. Машинно-зависимые пути — проверьте после установки

Эти места в конфиге содержат имя пользователя `YOUR_USERNAME`. `setup-config.ps1` подставляет его автоматически, но если правите конфиг руками — замените на своё:

| Что | Путь в конфиге |
|---|---|
| GitHub MCP | `YOUR_USERPROFILE/AppData/Local/github/github-mcp-server.exe` |
| memory-proxy | `YOUR_USERPROFILE/.claude/mcp/memory-proxy.cjs` |
| orchestrator | `YOUR_USERPROFILE/orchestrator-mcp/index.js` |
| n8n прокси | `C:/Users/YOUR_USERNAME/n8n-mcp-fix-proxy.mjs` |
| docker paths | `C:\Users\YOUR_USERNAME\AppData\Local` и т.д. |
| coworkUserFilesPath | `C:\Users\YOUR_USERNAME\Claude` |

> `n8n-mcp-fix-proxy.mjs` сам находит `mcp-remote` в вашем `%APPDATA%\npm` — править его не нужно.

---

## 8. Перезапуск и проверка

1. Полностью закройте Claude Desktop (трей → Exit), затем запустите заново.
2. Откройте список MCP — должно быть 14 серверов.
3. Если сервер не появился:
   - проверьте, что `claude_desktop_config.json` — валидный JSON;
   - в Claude Desktop есть логи: `%APPDATA%\Claude\logs\mcp-server-*.log`;
   - для `github` проверьте права токена (`repo`, `read:org`);
   - для `lean-ctx` — что `.cargo\bin` в `PATH`;
   - для `orchestrator-mcp` — что сделан `npm install`.

---

## 9. Чего в репозитории намеренно нет

| Что | Почему |
|---|---|
| Реальные ключи и токены | публичный репозиторий |
| `node_modules/` | размер, ставится через `npm install` |
| `orchestrator-mcp/runs/` | история запусков, локальные данные |
| `github-mcp-server.exe` | 25 МБ бинарник, качается с Releases |
| `web-search/` | больше не используется в этой сборке |
| Личные пути и идентификаторы аккаунта | приватность |

---

Лицензия: **MIT**. Сборка для личного использования — применяйте на свой страх и риск.
