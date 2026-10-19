/**
 * Orchestrator MCP Server for Claude Desktop.
 * Stateful multi-role pipeline (analyst → architect → approver → developer → devops → qa)
 * that Claude Desktop controls step-by-step: start, watch status, decide on gates.
 *
 * Design goals:
 *  - Claude owns the loop: it calls start/next/resolve, not a monolithic run.
 *  - Every gate result (APPROVED/REJECTED, PASSED/FAILED) carries explicit
 *    next-step instructions so Claude Desktop knows what to do.
 *  - Runs are persisted to <dir>/runs/<run_id>.json so status survives restarts.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Config ────────────────────────────────────────────────────────────────
const API_KEY = process.env.ROUTERAI_API_KEY || readApiKeyFromCreds()
const API_BASE = process.env.ROUTERAI_BASE_URL || 'https://routerai.ru/api/v1'
const PRO_MODEL = process.env.ORCH_PRO_MODEL || 'openai/openai/gpt-6-luna'
const FLASH_MODEL = process.env.ORCH_FLASH_MODEL || 'openai/deepseek/deepseek-v4.1-flash'

const RUNS_DIR = process.env.ORCH_RUNS_DIR || join(dirname(fileURLToPath(import.meta.url)), 'runs')

function readApiKeyFromCreds() {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '.'
    const creds = readFileSync(`${home}/.dsh/.credentials.yaml`, 'utf8')
    const m = creds.match(/ROUTERAI_API_KEY:\s*["']?([^"'\s]+)/)
    return m ? m[1] : undefined
  } catch { return undefined }
}

// ── Role prompts ─────────────────────────────────────────────────────────
const ROLES = {
  analyst: {
    model: PRO_MODEL,
    system: `Ты — Системный Аналитик. Преврати абстрактное задание в детальные требования: User Stories, Use Cases, функциональные и нефункциональные требования, критерии приёмки. Исследуй контекст, задавай уточнения если нужно. Не пиши код. Верни структурированный markdown.`,
  },
  architect: {
    model: PRO_MODEL,
    system: `Ты — ИТ-Архитектор. На основе требований спроектируй архитектуру: компоненты/модули, схему БД, стек технологий с обоснованием, API-контракты, риски. Если требования неполные или ошибочные — аргументированно критикуй и предлагай правки. Не пиши полный код. Верни структурированный markdown.`,
  },
  approver: {
    model: FLASH_MODEL,
    system: `Ты — Менеджер по качеству. Проверь итоговый документ от Аналитика и Архитектора. Если всё готово для разработки — ответь строго одним словом: APPROVED. Если есть проблемы — напиши REJECTED и перечисли причины и что исправить. Не пиши код.`,
  },
  developer: {
    model: PRO_MODEL,
    system: `Ты — Старший Разработчик. Ты не имеешь доступа к файлам и терминалу. Подготовь для Claude Code конкретный implementation handoff: целевые файлы, изменения, тесты и риски. Не утверждай, что файлы изменены или тесты запущены.`,
  },
  devops: {
    model: FLASH_MODEL,
    system: `Ты — DevOps-консультант. У тебя нет доступа к терминалу. Укажи необходимые команды сборки/проверки и ожидаемые результаты; не заявляй, что команды запускались.`,
  },
  qa: {
    model: FLASH_MODEL,
    system: `Ты — QA-рецензент. Ты не запускаешь тесты. Оцени только переданные реальные результаты проверок. Верни ровно один маркер VERDICT: PASSED или VERDICT: FAILED, затем краткое обоснование. PASSED допустим только если все перечисленные проверки имеют exit code 0 и предоставленное свидетельство достаточно.`,
  },
}

const PIPELINE = ['analyst', 'architect', 'approver', 'developer', 'devops', 'qa']
const DEFAULT_PIPELINE = ['analyst', 'architect', 'approver', 'developer', 'qa']
const SIMPLE_PIPELINE = ['analyst', 'approver', 'developer', 'qa']
const MUTATING_RUN_TOOLS = new Set([
  'orchestrate_next', 'orchestrate_resolve', 'orchestrate_submit_qa',
  'orchestrate_interject', 'orchestrate_edit', 'orchestrate_add_role',
])
const activeRuns = new Set()

// ── RouterAI chat helper ─────────────────────────────────────────────────
async function chat(model, system, user) {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: 6000,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`RouterAI API ${res.status}: ${text.slice(0, 300)}`)
  }
  const data = await res.json()
  return data?.choices?.[0]?.message?.content ?? ''
}

// ── Run persistence ──────────────────────────────────────────────────────
function runPath(id) { return join(RUNS_DIR, `${id}.json`) }

function saveRun(run) {
  mkdirSync(RUNS_DIR, { recursive: true })
  writeFileSync(runPath(run.id), JSON.stringify(run, null, 2), 'utf8')
}

function loadRun(id) {
  const p = runPath(id)
  if (!existsSync(p)) return undefined
  const run = JSON.parse(readFileSync(p, 'utf8'))
  run.mode ??= 'full'
  run.qaEvidence ??= null
  run.results ??= {}
  run.feedback ??= {}
  run.log ??= []
  return run
}

function newRunId() {
  return `run-${randomUUID()}`
}

// ── Shared memory (knowledge-graph style) ─────────────────────────────────
// A simple append-only JSONL memory that gives the orchestrator continuity
// across runs: project facts, past tasks, decisions, and observations are
// recalled into role prompts. Compatible with the MCP Reference Memory server
// format (entities/relations/observations) so other tools can share it.
const MEMORY_FILE = process.env.ORCH_MEMORY_FILE || join(
  process.env.USERPROFILE || process.env.HOME || '.',
  '.dsh-orchestrator-memory.jsonl',
)

function readMemory() {
  try {
    if (!existsSync(MEMORY_FILE)) return []
    const lines = readFileSync(MEMORY_FILE, 'utf8').split('\n').filter(Boolean)
    return lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

function appendMemory(entry) {
  try {
    mkdirSync(dirname(MEMORY_FILE), { recursive: true })
    writeFileSync(MEMORY_FILE, JSON.stringify(entry) + '\n', { flag: 'a' })
  } catch { /* memory is best-effort */ }
}

/** Recall recent entries relevant to the task (simple substring relevance). */
function recall(task, limit = 5) {
  const all = readMemory()
  const tokens = String(task || '').toLowerCase().split(/\W+/).filter(w => w.length > 3)
  const scored = all.map(e => {
    const hay = JSON.stringify(e).toLowerCase()
    const score = tokens.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0)
    return { e, score }
  }).filter(x => x.score > 0)
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(x => x.e)
}

/** Format recalled memory for a role prompt. */
function memoryContext(task) {
  const entries = recall(task)
  if (!entries.length) return ''
  return '\n\n📚 Память (из прошлых запусков):\n' + entries.map((e, i) =>
    `${i + 1}. ${e.type}: ${e.content}`,
  ).join('\n')
}

/** Record a run event into shared memory. */
function remember(run, event, detail, role) {
  appendMemory({
    ts: new Date().toISOString(),
    type: event,
    runId: run.id,
    task: String(run.task || '').slice(0, 300),
    role: role || run.roles[run.stepIndex],
    content: String(detail || '').slice(0, 1000),
  })
}

// ── Orchestrator state machine ───────────────────────────────────────────
// A run:
// {
//   id, task, cwd, roles, created,
//   stepIndex,          // index into roles
//   status: 'idle'|'running'|'waiting-gate'|'done'|'cancelled'|'error',
//   gate: undefined|{kind:'approval'|'qa', value:'APPROVED'|'REJECTED'|'PASSED'|'FAILED', detail, onReject:{target}},
//   results: {},         // role -> text
//   feedback: {},        // role -> accumulated review feedback (for retry loops)
//   log: [],             // [{step, role, status, at, note}]
// }

function buildPrompt(task, cwd, run, role) {
  const r = run.results
  let msg = `Задача:\n${task}\n\nРабочая директория: ${cwd || process.cwd()}`
  const fb = run.feedback[role]
  if (fb) msg += `\n\n⚠️ Замечания ревью (обязательно учесть):\n${fb}`
  if (role === 'qa' && run.qaEvidence) {
    msg += `\n\nФактически выполненные проверки Claude Code (это единственное свидетельство выполнения):\n${JSON.stringify(run.qaEvidence, null, 2)}`
  }
  // Inject relevant memory from previous runs so roles build on past work.
  const mem = memoryContext(task)
  if (mem) msg += mem

  if (role === 'architect') {
    if (r.analyst) msg += `\n\nТребования от Аналитика:\n${r.analyst}`
    else if (run.mode === 'full') msg += '\n\nЭто параллельный первичный анализ: работай только от исходной задачи, не ожидая вывода Аналитика.'
  } else if (role === 'approver') {
    if (r.analyst) msg += `\n\nТребования:\n${r.analyst}`
    if (r.architect) msg += `\n\nПроект архитектора:\n${r.architect}`
  } else if (role === 'developer') {
    msg += `\n\nУтверждено (APPROVED).`
    if (r.analyst) msg += `\n\nТребования:\n${r.analyst}`
    if (r.architect) msg += `\n\nАрхитектура:\n${r.architect}`
  } else if (role === 'devops') {
    if (r.developer) msg += `\n\nКод от Разработчика:\n${r.developer}`
  } else if (role === 'qa') {
    if (r.developer) msg += `\n\nПлан реализации от Разработчика:\n${r.developer}`
    if (r.devops) msg += `\n\nПлан проверок DevOps:\n${r.devops}`
  }
  return msg
}

function detectGate(role, output) {
  if (role === 'approver') {
    const verdict = output.match(/^\s*(APPROVED|REJECTED)\b/i)?.[1]?.toUpperCase()
    if (verdict === 'APPROVED') return { kind: 'approval', value: 'APPROVED', detail: output }
    return {
      kind: 'approval',
      value: 'REJECTED',
      detail: verdict === 'REJECTED' ? output : `Нет явного APPROVED. Ответ модели: ${output}`,
      onReject: { target: 'analyst', reason: 'Причины отклонения (передать аналитику на доработку):\n' + output },
    }
  }
  if (role === 'qa') {
    const verdict = output.match(/VERDICT:\s*(PASSED|FAILED)\b/i)?.[1]?.toUpperCase()
    if (verdict === 'PASSED') return { kind: 'qa', value: 'PASSED', detail: output }
    return {
      kind: 'qa',
      value: 'FAILED',
      detail: verdict === 'FAILED' ? output : `Нет явного маркера VERDICT: PASSED. Ответ модели: ${output}`,
      onReject: { target: 'developer', reason: 'QA не подтвердил успешную проверку:\n' + output },
    }
  }
  return undefined
}

// Advance the pipeline. With autoRetry enabled, a failed gate (REJECTED/FAILED)
// or a transient API error is retried automatically up to run.maxRetries,
// rewinding to the failed gate's target and re-running the chain with the
// review feedback. When retries are exhausted, pauses at a waiting-gate for a
// human decision. Returns the updated run.
function simpleTask(task) {
  const text = String(task || '').trim()
  const scopeCount = (text.match(/\b(and|plus|across|multiple|several|services|modules|components|platform|system|интеграц|нескольк|сервис|модул|компонент|систем|платформ)\b/gi) || []).length
  return text.length <= 90 && scopeCount === 0
}

async function runRole(run, role) {
  const cfg = ROLES[role]
  let transient = 0
  while (true) {
    run.status = 'running'
    run.log.push({ step: run.stepIndex, role, status: 'running', at: new Date().toISOString() })
    saveRun(run)
    try {
      return await chat(cfg.model, cfg.system, buildPrompt(run.task, run.cwd, run, role))
    } catch (err) {
      if (!run.autoRetry || transient >= run.maxRetries) throw err
      transient += 1
      run.log.push({ step: run.stepIndex, role, status: `transient error, retrying (${transient}/${run.maxRetries})`, at: new Date().toISOString() })
      saveRun(run)
    }
  }
}

async function advance(run, autoRetry = false) {
  while (true) {
    const roles = run.roles
    const role = roles[run.stepIndex]
    if (!role) {
      run.status = 'done'
      run.log.push({ step: run.stepIndex, role: '—', status: 'done', at: new Date().toISOString() })
      saveRun(run)
      remember(run, 'run-done', 'Pipeline finished. Final outputs saved in run record.')
      return run
    }

    let outputs
    try {
      if (run.stepIndex === 0 && run.mode === 'full' && roles[0] === 'analyst' && roles[1] === 'architect' && !run.results.analyst && !run.results.architect) {
        const [analyst, architect] = await Promise.all([
          runRole(run, 'analyst'),
          runRole(run, 'architect'),
        ])
        outputs = { analyst, architect }
      } else {
        outputs = { [role]: await runRole(run, role) }
      }
    } catch (err) {
      run.status = 'error'
      run.error = String(err.message || err)
      run.log.push({ step: run.stepIndex, role, status: `error: ${run.error.slice(0, 120)}`, at: new Date().toISOString() })
      saveRun(run)
      return run
    }

    Object.assign(run.results, outputs)
    const doneRole = role
    const finishedPrep = run.stepIndex === 0 && outputs.analyst !== undefined && outputs.architect !== undefined
    run.stepIndex += finishedPrep ? 2 : 1
    run.status = 'idle'
    run.log.push({ step: run.stepIndex, role: finishedPrep ? 'analyst+architect' : role, status: 'done', at: new Date().toISOString() })
    saveRun(run)
    for (const [resultRole, result] of Object.entries(outputs)) {
      remember(run, 'role-done', String(result || '').slice(0, 500), resultRole)
    }
    if (finishedPrep) continue

    const gate = detectGate(role, outputs[role])
    if (!gate) {
      if (role === 'developer') {
        run.status = 'waiting-execution'
        run.log.push({ step: run.stepIndex, role, status: 'waiting for Claude Code implementation and executed checks', at: new Date().toISOString() })
        saveRun(run)
        return run
      }
      if (role === 'devops') continue
      continue
    }

    // Gate passed.
    if (gate.value === 'APPROVED') {
      run.status = 'waiting-gate'
      run.gate = gate
      run.log.push({ step: run.stepIndex, role, status: `gate:${gate.kind}=${gate.value}`, at: new Date().toISOString() })
      saveRun(run)
      return run
    }
    if (gate.value === 'PASSED') {
      run.status = 'done'
      run.gate = gate
      run.log.push({ step: run.stepIndex, role, status: `gate:${gate.kind}=PASSED`, at: new Date().toISOString() })
      saveRun(run)
      remember(run, 'run-done', 'QA passed with submitted execution evidence.')
      return run
    }

    // QA failures wait for fresh implementation and execution evidence.
    if (gate.kind === 'qa') {
      run.status = 'waiting-execution'
      run.gate = gate
      run.log.push({ step: run.stepIndex, role, status: 'qa evidence review failed; awaiting retry or more work', at: new Date().toISOString() })
      saveRun(run)
      return run
    }

    // Gate failed (REJECTED/FAILED). Auto-retry with feedback up to maxRetries.
    const retriesUsed = run.gateRetries || 0
    if (autoRetry && retriesUsed < run.maxRetries) {
      run.gateRetries = retriesUsed + 1
      const target = gate.onReject.target
      run.feedback[target] = gate.onReject.reason
      run.log.push({ step: run.stepIndex, role, status: `gate ${gate.value} → retry ${target} (${run.gateRetries}/${run.maxRetries})`, at: new Date().toISOString() })
      // Rewind to target and re-run the chain from there.
      const tIdx = run.roles.indexOf(target)
      if (tIdx === -1) {
        run.status = 'waiting-gate'
        run.gate = gate
        saveRun(run)
        return run
      }
      for (const r of run.roles.slice(tIdx)) delete run.results[r]
      run.stepIndex = tIdx
      run.gate = undefined
      saveRun(run)
      continue // loop → re-run target
    }

    // Out of retries → pause for a human decision.
    run.status = 'waiting-gate'
    run.gate = gate
    run.log.push({ step: run.stepIndex, role, status: `gate:${gate.kind}=${gate.value} (retries exhausted)`, at: new Date().toISOString() })
    saveRun(run)
    remember(run, `gate-${gate.value}`, gate.detail)
    return run
  }
}

// ── Formatting helpers ───────────────────────────────────────────────────
function formatStatus(run) {
  const roles = run.roles
  const lines = roles.map((r, i) => {
    const done = run.results[r]
    const isCurrent = i === run.stepIndex
    const isGate = run.gate && i === run.stepIndex
    const marker = done ? '✅' : isGate ? '⏸' : isCurrent ? '▶️' : '⬜'
    const extra = isGate ? ` [GATE ${run.gate.kind}=${run.gate.value}]` : ''
    return `${marker} ${r}${extra}`
  })
  return [
    `## Оркестратор: ${run.id}`,
    ``,
    `**Статус:** ${run.status}`,
    `**Задача:** ${run.task.slice(0, 120)}`,
    ``,
    `**Конвейер:**`,
    ...lines.map(l => `- ${l}`),
    ``,
    run.log.length ? `**Лог:**` : '',
    ...run.log.slice(-10).map(l => `- ${l.at.slice(11, 19)} ${l.role}: ${l.status}`),
  ].join('\n')
}

// Format a gate result with explicit instructions for Claude Desktop.
function formatGate(run) {
  const g = run.gate
  if (!g) return formatStatus(run)
  const isOk = g.value === 'APPROVED' || g.value === 'PASSED'
  const lines = [
    `## Гейт: ${g.kind} = ${g.value}`,
    ``,
    `**Запуск:** ${run.id}`,
    `**Этап:** ${run.roles[run.stepIndex]} (шаг ${run.stepIndex + 1} из ${run.roles.length})`,
    ``,
  ]
  if (isOk) {
    if (g.kind === 'approval') {
      lines.push(
        `✅ Согласование пройдено.`,
        ``,
        `**Следующее действие:** вызови \`orchestrate_next\` с run_id="${run.id}" для developer handoff.`,
        ``,
      )
    } else {
      lines.push(`✅ QA пройден по предоставленным результатам. Запуск завершён.`, ``)
    }
  } else {
    lines.push(
      `❌ Гейт не пройден (${g.value}).`,
      ``,
      `**Проблема:**`,
      g.detail.slice(0, 2000),
      ``,
      `## Что делать — выбери действие:`,
      ``,
      `1. **Вернуть на доработку (рекомендуется):** вызови \`orchestrate_resolve\` с`,
      `   run_id="${run.id}", action="retry", target="${g.onReject.target}", feedback="<причины>".`,
      `   Оркестратор перезапустит ${g.onReject.target} с учётом замечаний, затем повторит цепочку.`,
      ``,
      `2. **Пропустить этап:** вызови \`orchestrate_resolve\` с run_id="${run.id}", action="skip".`,
      ``,
      `3. **Остановить:** вызови \`orchestrate_resolve\` с run_id="${run.id}", action="stop".`,
      ``,
    )
  }
  return lines.join('\n')
}

// ── MCP Server ───────────────────────────────────────────────────────────
const server = new Server(
  { name: 'orchestrator-mcp', version: '0.2.0' },
  { capabilities: { tools: {} } },
)

const COMMON_PROPS = {
  run_id: { type: 'string', description: 'ID запуска (возвращается из orchestrate_start)' },
  task: { type: 'string', description: 'Описание задачи' },
  cwd: { type: 'string', description: 'Рабочая директория (по умолчанию текущая)' },
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'orchestrate_start',
      description: `Создать новый запуск конвейера и выполнить первый этап. Роли по умолчанию: analyst → architect → approver → developer → devops → qa. Возвращает run_id и текущий статус. Управление циклом: orchestrate_status (смотреть), orchestrate_next (продвинуть), orchestrate_resolve (решить на гейте).`,
      inputSchema: {
        type: 'object',
        properties: {
          task: COMMON_PROPS.task,
          mode: { type: 'string', enum: ['auto', 'simple', 'full'], description: 'Режим подготовки: auto (по умолчанию), simple или full.' },
          roles: {
            type: 'array',
            items: { type: 'string', enum: PIPELINE },
            description: 'Роли для выполнения (по умолчанию все 6)',
          },
          cwd: COMMON_PROPS.cwd,
          autoRetry: { type: 'boolean', description: 'Автоматически повторять упавший гейт (REJECTED/FAILED) с фидбеком. По умолчанию true.' },
          maxRetries: { type: 'number', description: 'Сколько раз повторять гейт, прежде чем спросить человека. По умолчанию 2.' },
        },
        required: ['task'],
      },
    },
    {
      name: 'orchestrate_status',
      description: `Посмотреть текущий статус запуска: какой этап идёт, что готово, есть ли ожидающий гейт (approval/qa). Используй для контроля прогресса.`,
      inputSchema: {
        type: 'object',
        properties: { run_id: COMMON_PROPS.run_id },
        required: ['run_id'],
      },
    },
    {
      name: 'orchestrate_next',
      description: `Продвинуть конвейер до следующего гейта. После developer-этапа Claude Code должен применить handoff и передать фактические проверки через orchestrate_submit_qa.`,
      inputSchema: {
        type: 'object',
        properties: { run_id: COMMON_PROPS.run_id },
        required: ['run_id'],
      },
    },
    {
      name: 'orchestrate_submit_qa',
      description: 'Передать фактические результаты проверок, выполненных Claude Code. QA-гейт оценивает только эти данные; сообщайте реальные команды, exit code и краткий вывод.',
      inputSchema: {
        type: 'object',
        properties: {
          run_id: COMMON_PROPS.run_id,
          checks: {
            type: 'array', minItems: 1,
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                command: { type: 'string' },
                exitCode: { type: 'number' },
                output: { type: 'string' },
              },
              required: ['name', 'command', 'exitCode', 'output'],
            },
          },
        },
        required: ['run_id', 'checks'],
      },
    },
    {
      name: 'orchestrate_resolve',
      description: `Решить, что делать с ожидающим гейтом (REJECTED/FAILED). action="retry" — вернуть этап на доработку с фидбеком (перезапустит target и цепочку), action="skip" — пропустить гейт и продолжить, action="stop" — остановить запуск.`,
      inputSchema: {
        type: 'object',
        properties: {
          run_id: COMMON_PROPS.run_id,
          action: { type: 'string', enum: ['retry', 'skip', 'stop'], description: 'Действие на гейте' },
          target: { type: 'string', enum: PIPELINE, description: 'Куда вернуть на доработку (для retry)' },
          feedback: { type: 'string', description: 'Замечания для доработки (для retry)' },
        },
        required: ['run_id', 'action'],
      },
    },
    {
      name: 'orchestrate_result',
      description: `Получить полный текст результата конкретного этапа (роли).`,
      inputSchema: {
        type: 'object',
        properties: {
          run_id: COMMON_PROPS.run_id,
          role: { type: 'string', enum: PIPELINE, description: 'Роль, чей результат читать' },
        },
        required: ['run_id', 'role'],
      },
    },
    {
      name: 'orchestrate_interject',
      description: `Полное погружение: вмешаться в цикл прямо сейчас. Отправить указание/вопрос/уточнение текущей (или любой) роли. Указание сохранится как feedback и будет учтено при следующем выполнении роли. Если роль уже выполнена — она будет перезапущена с этим указанием.`,
      inputSchema: {
        type: 'object',
        properties: {
          run_id: COMMON_PROPS.run_id,
          role: { type: 'string', enum: PIPELINE, description: 'Кому адресовано (по умолчанию текущая роль)' },
          message: { type: 'string', description: 'Указание/вопрос/уточнение' },
        },
        required: ['run_id', 'message'],
      },
    },
    {
      name: 'orchestrate_edit',
      description: `Отредактировать результат этапа вручную (например, после ревью пользователя) перед передачей следующей роли. Перезаписывает сохранённый текст результата.`,
      inputSchema: {
        type: 'object',
        properties: {
          run_id: COMMON_PROPS.run_id,
          role: { type: 'string', enum: PIPELINE, description: 'Чей результат править' },
          text: { type: 'string', description: 'Новый полный текст результата' },
        },
        required: ['run_id', 'role', 'text'],
      },
    },
    {
      name: 'orchestrate_add_role',
      description: `Вставить роль в конвейер на определённую позицию (например, добавить security-review после developer, или повторно выполнить роль).`,
      inputSchema: {
        type: 'object',
        properties: {
          run_id: COMMON_PROPS.run_id,
          role: { type: 'string', enum: PIPELINE, description: 'Роль для вставки' },
          index: { type: 'number', description: 'Позиция в конвейере (0-based; по умолчанию в конец)' },
        },
        required: ['run_id', 'role'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  if (!API_KEY) throw new Error('ROUTERAI_API_KEY не задан (нужен ключ RouterAI)')
  const lockId = MUTATING_RUN_TOOLS.has(name) ? String(args?.run_id || '') : ''
  if (lockId && activeRuns.has(lockId)) {
    return { content: [{ type: 'text', text: `Запуск ${lockId} уже изменяется другим запросом; повтори позже.` }], isError: true }
  }
  if (lockId) activeRuns.add(lockId)

  try {
    switch (name) {
      case 'orchestrate_start': {
        const task = String(args?.task || '')
        const requestedMode = ['auto', 'simple', 'full'].includes(args?.mode) ? args.mode : 'auto'
        const mode = requestedMode === 'auto' ? (simpleTask(task) ? 'simple' : 'full') : requestedMode
        const roles = Array.isArray(args?.roles) && args.roles.length
          ? args.roles.map(String)
          : [...(mode === 'simple' ? SIMPLE_PIPELINE : DEFAULT_PIPELINE)]
        const cwd = args?.cwd ? String(args.cwd) : undefined
        const autoRetry = args?.autoRetry !== false
        const maxRetries = Number(args?.maxRetries) || 2
        const run = {
          id: newRunId(),
          task, cwd, roles, mode,
          autoRetry, maxRetries,
          created: new Date().toISOString(),
          stepIndex: 0,
          gateRetries: 0,
          status: 'idle',
          gate: undefined,
          qaEvidence: null,
          results: {},
          feedback: {},
          log: [{ step: 0, role: roles[0], status: 'created', at: new Date().toISOString() }],
        }
        saveRun(run)
        await advance(run, run.autoRetry)
        let text = formatStatus(run)
        if (run.gate) text = formatGate(run)
        return { content: [{ type: 'text', text: `🎬 Запуск создан: **${run.id}**\n\n` + text }] }
      }

      case 'orchestrate_status': {
        const run = loadRun(String(args?.run_id || ''))
        if (!run) return { content: [{ type: 'text', text: `Запуск "${args?.run_id}" не найден.` }], isError: true }
        let text = run.gate ? formatGate(run) : formatStatus(run)
        return { content: [{ type: 'text', text }] }
      }

      case 'orchestrate_submit_qa': {
        const run = loadRun(String(args?.run_id || ''))
        if (!run) return { content: [{ type: 'text', text: `Запуск "${args?.run_id}" не найден.` }], isError: true }
        if (run.status !== 'waiting-execution' || run.gate?.kind === 'approval') {
          return { content: [{ type: 'text', text: 'QA доступен только после approval-гейта и developer handoff.' }], isError: true }
        }
        const checks = Array.isArray(args?.checks) ? args.checks : []
        if (!checks.length || checks.some(check => !check.name || !check.command || !Number.isInteger(check.exitCode) || typeof check.output !== 'string')) {
          return { content: [{ type: 'text', text: 'Нужна минимум одна проверка с name, command, integer exitCode и output.' }], isError: true }
        }
        run.qaEvidence = checks.map(({ name, command, exitCode, output }) => ({ name: String(name), command: String(command), exitCode, output: String(output).slice(0, 3000) }))
        if (run.qaEvidence.some(check => check.exitCode !== 0)) {
          run.status = 'waiting-execution'
          run.gate = { kind: 'qa', value: 'FAILED', detail: 'Одна или несколько реальных проверок завершились с ошибкой.', onReject: { target: 'developer', reason: JSON.stringify(run.qaEvidence) } }
          run.log.push({ step: run.stepIndex, role: 'qa', status: 'checks failed; developer changes and fresh checks required', at: new Date().toISOString() })
          saveRun(run)
          return { content: [{ type: 'text', text: `QA не запущен: есть проверки с ненулевым exit code. Исправь изменения, запусти проверки заново и передай свежие результаты.\n\n${formatStatus(run)}` }] }
        }
        run.results.qa = await chat(ROLES.qa.model, ROLES.qa.system, buildPrompt(run.task, run.cwd, run, 'qa'))
        const gate = detectGate('qa', run.results.qa)
        run.gate = gate
        run.status = gate.value === 'PASSED' ? 'done' : 'waiting-execution'
        run.log.push({ step: run.stepIndex, role: 'qa', status: `gate:qa=${gate.value}`, at: new Date().toISOString() })
        saveRun(run)
        if (gate.value === 'PASSED') remember(run, 'run-done', 'QA passed with submitted execution evidence.')
        return { content: [{ type: 'text', text: formatGate(run) }] }
      }

      case 'orchestrate_next': {
        const run = loadRun(String(args?.run_id || ''))
        if (!run) return { content: [{ type: 'text', text: `Запуск "${args?.run_id}" не найден.` }], isError: true }
        if (run.status === 'waiting-execution' && run.gate?.kind !== 'qa') {
          return { content: [{ type: 'text', text: `Ждём, пока Claude Code применит handoff и выполнит реальные проверки. Затем вызови orchestrate_submit_qa с run_id="${run.id}" и командами, exit code и кратким выводом.` }], isError: true }
        }
        if (run.status === 'waiting-gate') {
          if (run.gate?.kind === 'approval' && run.gate.value === 'APPROVED') {
            run.gate = undefined
            run.status = 'idle'
            saveRun(run)
          } else {
            return {
              content: [{ type: 'text', text: `Гейт ожидает решения. Сначала вызови orchestrate_resolve (retry/skip/stop), затем orchestrate_next.\n\n${formatGate(run)}` }],
              isError: true,
            }
          }
        }
        if (run.status === 'done') {
          return { content: [{ type: 'text', text: 'Запуск уже завершён.' }], isError: true }
        }
        await advance(run, run.autoRetry)
        let text = run.gate ? formatGate(run) : formatStatus(run)
        return { content: [{ type: 'text', text }] }
      }

      case 'orchestrate_resolve': {
        const run = loadRun(String(args?.run_id || ''))
        if (!run) return { content: [{ type: 'text', text: `Запуск "${args?.run_id}" не найден.` }], isError: true }
        const qaRetry = run.status === 'waiting-execution' && run.gate?.kind === 'qa'
        if (run.status !== 'waiting-gate' && !qaRetry) {
          return { content: [{ type: 'text', text: 'Нет ожидающего гейта. Вызови orchestrate_status для проверки.' }], isError: true }
        }
        const action = String(args?.action || '')
        const g = run.gate
        if (action === 'retry') {
          const target = qaRetry ? 'developer' : String(args?.target || g?.onReject?.target || 'analyst')
          const feedback = String(args?.feedback || g?.onReject?.reason || '')
          run.feedback[target] = feedback
          // Rewind to target: retry that role and everything after it.
          const targetIdx = run.roles.indexOf(target)
          if (qaRetry) {
            run.qaEvidence = null
            run.gate = undefined
            run.status = 'idle'
            const developerIdx = run.roles.indexOf('developer')
            if (developerIdx === -1) return { content: [{ type: 'text', text: 'Developer отсутствует в конвейере; QA retry невозможен.' }], isError: true }
            for (const role of run.roles.slice(developerIdx)) delete run.results[role]
            run.stepIndex = developerIdx
            saveRun(run)
            await advance(run, run.autoRetry)
            return { content: [{ type: 'text', text: `QA retry: выполни новый handoff и повторно запусти проверки.\n\n${formatStatus(run)}` }] }
          }
          if (targetIdx === -1) {
            return { content: [{ type: 'text', text: `Роль "${target}" не в конвейере.` }], isError: true }
          }
          // Drop results from target onwards so the chain recomputes.
          for (const r of run.roles.slice(targetIdx)) delete run.results[r]
          run.stepIndex = targetIdx
          run.gate = undefined
          run.gateRetries = 0
          run.status = 'idle'
          run.log.push({ step: targetIdx, role: target, status: 'retry (feedback)', at: new Date().toISOString() })
          saveRun(run)
          await advance(run, run.autoRetry)
          let text = run.gate ? formatGate(run) : formatStatus(run)
          return { content: [{ type: 'text', text: `🔁 Возвращаю на доработку: **${target}**\n\n` + text }] }
        }
        if (action === 'skip') {
          run.stepIndex += 1
          run.gate = undefined
          run.status = 'idle'
          run.log.push({ step: run.stepIndex, role: '—', status: 'gate skipped', at: new Date().toISOString() })
          saveRun(run)
          await advance(run, run.autoRetry)
          let text = run.gate ? formatGate(run) : formatStatus(run)
          return { content: [{ type: 'text', text: `⏭ Пропущено. ` + text }] }
        }
        if (action === 'stop') {
          run.status = 'cancelled'
          run.log.push({ step: run.stepIndex, role: '—', status: 'cancelled', at: new Date().toISOString() })
          saveRun(run)
          remember(run, 'run-cancelled', 'Stopped by user decision.')
          return { content: [{ type: 'text', text: `🛑 Запуск ${run.id} остановлен.` }] }
        }
        return { content: [{ type: 'text', text: `Неизвестное действие: ${action}. Доступно: retry, skip, stop.` }], isError: true }
      }

      case 'orchestrate_result': {
        const run = loadRun(String(args?.run_id || ''))
        if (!run) return { content: [{ type: 'text', text: `Запуск "${args?.run_id}" не найден.` }], isError: true }
        const role = String(args?.role || '')
        const text = run.results[role]
        if (!text) return { content: [{ type: 'text', text: `Этап "${role}" ещё не выполнен.` }], isError: true }
        return { content: [{ type: 'text', text: `## Результат этапа: ${role}\n\n${text}` }] }
      }

      case 'orchestrate_interject': {
        const run = loadRun(String(args?.run_id || ''))
        if (!run) return { content: [{ type: 'text', text: `Запуск "${args?.run_id}" не найден.` }], isError: true }
        const message = String(args?.message || '')
        const role = String(args?.role || run.roles[run.stepIndex])
        if (!run.roles.includes(role)) {
          return { content: [{ type: 'text', text: `Роль "${role}" не в конвейере: ${run.roles.join(', ')}.` }], isError: true }
        }
        // Append instruction to feedback; role reruns on next advance.
        const prior = run.feedback[role] ? run.feedback[role] + '\n\n' : ''
        run.feedback[role] = prior + `👤 Указание пользователя/Claude:\n${message}`
        // If role already produced output, mark for rerun by rewinding to it.
        if (run.results[role] || run.roles.indexOf(role) <= run.stepIndex) {
          const idx = run.roles.indexOf(role)
          for (const r of run.roles.slice(idx)) delete run.results[r]
          run.stepIndex = idx
          run.gate = undefined
          run.status = 'idle'
        }
        run.log.push({ step: run.stepIndex, role, status: 'interjected (feedback)', at: new Date().toISOString() })
        saveRun(run)
        return { content: [{ type: 'text', text: `✋ Вмешательство сохранено для роли **${role}**.\n\n${formatStatus(run)}\n\nВызови orchestrate_next, чтобы применить.` }] }
      }

      case 'orchestrate_edit': {
        const run = loadRun(String(args?.run_id || ''))
        if (!run) return { content: [{ type: 'text', text: `Запуск "${args?.run_id}" не найден.` }], isError: true }
        const role = String(args?.role || '')
        const text = String(args?.text || '')
        if (!run.roles.includes(role)) {
          return { content: [{ type: 'text', text: `Роль "${role}" не в конвейере: ${run.roles.join(', ')}.` }], isError: true }
        }
        run.results[role] = text
        run.log.push({ step: run.stepIndex, role, status: 'edited manually', at: new Date().toISOString() })
        saveRun(run)
        return { content: [{ type: 'text', text: `✏️ Результат роли **${role}** обновлён вручную.\n\n${formatStatus(run)}` }] }
      }

      case 'orchestrate_add_role': {
        const run = loadRun(String(args?.run_id || ''))
        if (!run) return { content: [{ type: 'text', text: `Запуск "${args?.run_id}" не найден.` }], isError: true }
        const role = String(args?.role || '')
        if (!run.roles.includes(role) || !ROLES[role]) {
          return { content: [{ type: 'text', text: `Роль "${role}" не поддерживается. Доступно: ${PIPELINE.join(', ')}.` }], isError: true }
        }
        let idx = Number(args?.index)
        if (!Number.isFinite(idx)) idx = run.roles.length
        if (idx < 0) idx = 0
        if (idx > run.roles.length) idx = run.roles.length
        run.roles.splice(idx, 0, role)
        // If inserted before current step, adjust stepIndex.
        if (idx <= run.stepIndex) run.stepIndex += 1
        run.log.push({ step: run.stepIndex, role, status: `inserted at ${idx}`, at: new Date().toISOString() })
        saveRun(run)
        return { content: [{ type: 'text', text: `➕ Роль **${role}** вставлена на позицию ${idx}.\n\n${formatStatus(run)}` }] }
      }

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Ошибка оркестратора: ${err.message}` }], isError: true }
  } finally {
    if (lockId) activeRuns.delete(lockId)
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
