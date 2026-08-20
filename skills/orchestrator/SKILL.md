---
name: orchestrator
description: Multi-agent orchestration for this environment — runs the 6-role pipeline (analyst → architect → approver → developer → devops → qa) with auto-retry on gates, human-in-the-loop control, and shared memory. Use when the user wants to delegate work to a team of roles, run a build pipeline, review/approve requirements, or when multiple specialized agents should cooperate on one task. Covers the DSH orchestrator (dsh-agent-teams), the Claude Code subagents + /orchestrate, and the Claude Desktop orchestrator-mcp (8 tools).
---

# Orchestrator

Это окружение умеет запускать многоагентный конвейер из 6 ролей. Три реализации — выбирай по контексту.

## Роли (одинаковые везде)

| Роль | Что делает | Модель |
|---|---|---|
| **analyst** | Требования: User Stories, Use Cases, функциональные/нефункциональные, критерии приёмки | deepseek-v4-pro |
| **architect** | Архитектура: компоненты, БД, стек, API-контракты, критика требований | deepseek-v4-pro |
| **approver** | Гейт качества: APPROVED / REJECTED (+причины) | deepseek-chat |
| **developer** | Пишет код по ТЗ, файлы, тесты | deepseek-v4-pro |
| **devops** | Сборка, Docker, окружение, запуск тестов | deepseek-chat |
| **qa** | Автотесты: PASSED / FAILED (+логи) | deepseek-chat |

Конвейер: `analyst → architect → approver → developer → devops → qa`.
Гейты: **approver** (REJECTED возвращает к analyst), **qa** (FAILED возвращает к developer).

⚠️ **Модели:** никогда не используй `deepseek-v4-flash` через RouterAI — отдаёт пустой content. Тяжёлые роли = `deepseek-v4-pro`, рутина = `deepseek/deepseek-chat`.

## 1. Claude Code — субагенты + /orchestrate (этот терминал)

Субагенты: `~/.claude/agents/{analyst,architect,approver,developer,devops,qa}.md`.
Команда: `/orchestrate` — запускает конвейер по цепочке через Task tool (Agent tool, subagent_type).

Запуск: делегируй через Agent tool, передавая результат предыдущей роли в prompt следующей.
- Если approver вернул REJECTED — вернись к analyst с причинами.
- Если qa вернул FAILED — вернись к developer с логами.
- Повторяй, пока гейты не пройдут (авто-цикл от тебя, не от пользователя).

## 2. Claude Desktop — orchestrator-mcp (MCP-сервер)

Сервер: `C:/Users/motin/orchestrator-mcp/index.js`, 8 инструментов. Вызывает DeepSeek (RouterAI) напрямую.

**Протокол цикла (Claude Desktop владеет циклом):**
1. `orchestrate_start` {task, roles?, cwd?, autoRetry?, maxRetries?} → вернёт `run_id`
2. `orchestrate_status` {run_id} — смотреть прогресс (✅/▶️/⏸), есть ли гейт
3. `orchestrate_next` {run_id} — продвинуть конвейер
4. На гейте: `orchestrate_resolve` {run_id, action}:
   - `retry` {target, feedback} — вернуть роль на доработку с замечаниями
   - `skip` — пропустить гейт
   - `stop` — остановить запуск
5. `orchestrate_result` {run_id, role} — прочитать текст этапа

**Полное погружение (human-in-the-loop):**
- `orchestrate_interject` {run_id, role?, message} — вмешаться: указание роли (роль перезапустится с ним)
- `orchestrate_edit` {run_id, role, text} — править результат этапа вручную
- `orchestrate_add_role` {run_id, role, index?} — вставить роль (напр. security-review)

**Автоповтор:** `autoRetry` (по умолчанию true) — REJECTED/FAILED сам возвращается на target с фидбеком до `maxRetries` (по умолчанию 2). Transient API-ошибки тоже ретраятся. Когда попытки исчерпаны — waiting-gate, решение за человеком/Claude.

**Ошибка на гейте — что делать Claude:** не паникуй. Прочитай `detail`, выбери retry/skip/stop и вызови `orchestrate_resolve`. Retry обычно правильный выбор, если причины устранимы.

## 3. DSH — dsh-agent-teams

Капитан-сессия в DeepSeek Harness (web, порт 3080). Инструменты `agent_teams_*`:
create, add_member, remove_member, create_task, reassign_task, claim_task, update_task, send_message, status, delete.
Состояние в `/.agent-teams/`, до 8 членов, memberModel deepseek-v4.
Управление — естественным языком: «Use AgentTeams: собери команду, разбей на задачи...».

## Память

- Claude Desktop knowledge graph (local-memory): сущность `DSH_Orchestrator`, роли `*_role`, `RouterAI`.
- Оркестратор: `~/.dsh-orchestrator-memory.jsonl` — роли получают контекст из прошлых запусков.
- При работе — пиши ключевые факты в память (create_entities/add_observations), чтобы следующая сессия знала.

## Применение

Когда пользователь говорит «сделай X командой», «запусти оркестратор», «собери аналитика/архитектора/разработчика»:
1. Пойми, какая реализация доступна (Claude Code здесь, Desktop MCP, DSH).
2. Запусти конвейер (или первый этап), покажи план.
3. Контролируй цикл: смотри статусы, решай на гейтах, вмешивайся при необходимости.
4. Собери итоговый отчёт по ролям.
