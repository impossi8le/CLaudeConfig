# Задание для Claude на новом компьютере

> **Этот файл — промпт для Claude Code.** Передайте его агенту на новой машине.
> Если ты Claude и читаешь это — выполни шаги по порядку, сообщая о результатах.

---

## Задача

Развернуть сборку CLaudeConfig (14 MCP-серверов + 42 скилла) на этой машине.

Репозиторий: `https://github.com/impossi8le/CLaudeConfig`

## Контекст

Репозиторий содержит **только конфигурацию и плейсхолдеры** — реальных ключей там нет.
Ключи вводит владелец машины. Твоя задача — подготовить окружение и собрать рабочий конфиг.

---

## Шаги

### Шаг 1. Проверить окружение

Выполни и покажи результат:

```bash
node --version
python --version
git --version
```

Требования: Node.js 18+, Python 3.9+, Git. Если чего-то нет — сообщи владельцу и остановись.

Опционально (только если нужны соответствующие серверы):

```bash
docker --version
cargo --version
```

### Шаг 2. Клонировать репозиторий

```bash
git clone https://github.com/impossi8le/CLaudeConfig.git
cd CLaudeConfig
```

### Шаг 3. Установить зависимости

```bash
install.bat
```

Скрипт поставит npm- и pip-пакеты, создаст папки, скопирует прокси.

**Проверь:** вывод не должен содержать ошибок установки. Если какой-то пакет не встал — зафиксируй какой именно.

### Шаг 4. Собрать конфиг с ключами

**ВАЖНО: этот шаг требует ввода владельца.** Скрипт спросит ключи интерактивно:

```powershell
powershell -ExecutionPolicy Bypass -File setup-config.ps1
```

Скажи владельцу, какие данные понадобятся (Enter — пропустить ненужное):

| Ключ | Где взять |
|---|---|
| GitHub PAT | GitHub → Settings → Developer settings → PAT (права `repo`, `read:org`) |
| Tavily API Key | https://app.tavily.com |
| n8n URL + Bearer токен | n8n → Settings → MCP Server |
| SSH хост / логин / пароль | владелец знает |
| routerai.ru API ключ | https://routerai.ru |

Скрипт запишет результат в `%APPDATA%\Claude\claude_desktop_config.json`.

> Не запускай этот шаг в фоне — нужен интерактивный ввод.

### Шаг 5. Доустановить компоненты, которых нет в репозитории

Спроси владельца, какие из них нужны, и выполни только нужные:

**5.1. `github-mcp-server.exe`** (нужен для сервера `github`)

Скачать последний релиз с https://github.com/github/github-mcp-server/releases
и положить в `%LOCALAPPDATA%\github\github-mcp-server.exe`.

```bash
mkdir -p "$LOCALAPPDATA/github"
```

**5.2. `lean-ctx`** (нужен для сервера `lean-ctx`)

```bash
cargo install lean-ctx
```

Проверь, что `%USERPROFILE%\.cargo\bin` есть в `PATH`:

```bash
which lean-ctx
```

**5.3. `orchestrator-mcp`** (нужен для сервера `orchestrator-mcp`)

```bash
cd "$USERPROFILE/orchestrator-mcp" && npm install
```

Если папки нет — скопируй её из `CLaudeConfig/orchestrator-mcp` и выполни `npm install` там.

### Шаг 6. Скопировать скиллы

```bash
xcopy /E /I /Y skills "%USERPROFILE%\.claude\skills"
```

Проверь количество:

```bash
ls -1 "$USERPROFILE/.claude/skills" | wc -l
```

Ожидается 42.

### Шаг 7. Проверить итог

1. Убедись, что `claude_desktop_config.json` — валидный JSON:

```bash
python -c "import json,os; json.load(open(os.path.expandvars(r'%APPDATA%\Claude\claude_desktop_config.json'),encoding='utf-8')); print('JSON OK')"
```

2. Посчитай серверы:

```bash
python -c "import json,os; d=json.load(open(os.path.expandvars(r'%APPDATA%\Claude\claude_desktop_config.json'),encoding='utf-8')); print(len(d['mcpServers']),'servers')"
```

Ожидается 14.

3. Попроси владельца **полностью** перезапустить Claude Desktop (трей → Exit).

4. После перезапуска проверь логи, если серверы не появились:

```bash
ls -la "$APPDATA/Claude/logs/" | grep mcp
```

---

## Правила для тебя

- **Не выдумывай ключи и не подставляй заглушки вместо реальных** — если владелец пропустил ключ, соответствующий сервер просто не заработает, это нормально.
- **Не коммить реальный конфиг с ключами** обратно в репозиторий.
- **Не удаляй** существующий конфиг владельца, если он уже был — сначала спроси.
- Если шаг падает — покажи точную ошибку и предложи причину, не переходи дальше молча.
- В конце дай краткий отчёт: что установлено, что пропущено, что требует внимания владельца.
