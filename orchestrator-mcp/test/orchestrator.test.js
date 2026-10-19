import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverPath = fileURLToPath(new URL('../index.js', import.meta.url))

async function setup(t, responder) {
  const temp = await mkdtemp(join(tmpdir(), 'orchestrator-test-'))
  const requests = []
  const httpServer = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const parsed = JSON.parse(body)
    requests.push(parsed)
    const content = await responder(parsed, requests.length)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content } }] }))
  })
  httpServer.listen(0, '127.0.0.1')
  await once(httpServer, 'listening')
  const { port } = httpServer.address()
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      ROUTERAI_API_KEY: 'test-key',
      ROUTERAI_BASE_URL: `http://127.0.0.1:${port}`,
      ORCH_PRO_MODEL: 'openai/openai/gpt-6-luna',
      ORCH_FLASH_MODEL: 'openai/deepseek/deepseek-v4.1-flash',
      ORCH_RUNS_DIR: join(temp, 'runs'),
      ORCH_MEMORY_FILE: join(temp, 'memory.jsonl'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = Buffer.alloc(0)
  child.stdout.on('data', chunk => { stdout = Buffer.concat([stdout, chunk]) })
  const pending = new Map()
  let nextId = 1
  child.stdout.on('data', () => {
    while (true) {
      const newline = stdout.indexOf(10)
      if (newline < 0) break
      const line = stdout.subarray(0, newline).toString()
      stdout = stdout.subarray(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    }
  })
  child.stderr.on('data', () => {})
  function send(method, params = {}) {
    const id = nextId++
    const promise = new Promise(resolve => pending.set(id, resolve))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return promise
  }
  await send('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.1' },
  })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  async function call(name, args) {
    const response = await send('tools/call', { name, arguments: args })
    if (response.error) throw new Error(response.error.message)
    const result = response.result
    const text = result.content?.map(item => item.text).join('\n') || ''
    return { ...result, text }
  }
  t.after(async () => {
    child.kill()
    httpServer.close()
    await rm(temp, { recursive: true, force: true })
  })
  return { call, requests }
}

test('starts parallel full-mode analysis then pauses at approval gate', async t => {
  const { call, requests } = await setup(t, parsed => {
    const role = parsed.messages[0].content
    if (role.includes('Системный Аналитик')) return 'ANALYSIS_DONE'
    if (role.includes('ИТ-Архитектор')) return 'ARCHITECTURE_DONE'
    if (role.includes('Менеджер по качеству')) return 'APPROVED'
    return 'UNEXPECTED'
  })
  const result = await call('orchestrate_start', { task: 'Build a multi-service billing platform', mode: 'full' })
  assert.match(result.text, /approval = APPROVED/)
  assert.match(result.text, /Согласование пройдено/)
  assert.equal(requests.length, 3)
  assert.deepEqual(requests.slice(0, 2).map(req => req.model), [
    'openai/openai/gpt-6-luna',
    'openai/openai/gpt-6-luna',
  ])
  assert.match(requests[2].messages[1].content, /ANALYSIS_DONE/)
  assert.match(requests[2].messages[1].content, /ARCHITECTURE_DONE/)
})

test('auto mode uses simple prep for a narrowly scoped request', async t => {
  const { call, requests } = await setup(t, parsed => {
    const prompt = parsed.messages[0].content
    if (prompt.includes('Системный Аналитик')) return 'APPROVED'
    if (prompt.includes('Менеджер по качеству')) return 'APPROVED'
    return 'UNEXPECTED'
  })
  const result = await call('orchestrate_start', { task: 'Fix typo in README.md', mode: 'auto' })
  assert.match(result.text, /approval = APPROVED/)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].model, 'openai/openai/gpt-6-luna')
  assert.equal(requests[1].model, 'openai/deepseek/deepseek-v4.1-flash')
})

test('approval stops before developer and next returns implementation handoff', async t => {
  const { call, requests } = await setup(t, parsed => {
    const system = parsed.messages[0].content
    if (system.includes('Системный Аналитик')) return 'ANALYSIS_DONE'
    if (system.includes('ИТ-Архитектор')) return 'ARCHITECTURE_DONE'
    if (system.includes('Менеджер по качеству')) return 'APPROVED'
    if (system.includes('Старший Разработчик')) return 'IMPLEMENTATION_HANDOFF'
    return 'UNEXPECTED'
  })
  const start = await call('orchestrate_start', { task: 'Implement multi tenant auth across API and database', mode: 'full' })
  assert.match(start.text, /approval = APPROVED/)
  assert.equal(requests.some(req => req.messages[0].content.includes('Старший Разработчик')), false)
  const continued = await call('orchestrate_next', { run_id: start.text.match(/run-[a-f0-9-]+/)[0] })
  assert.match(continued.text, /waiting-execution/)
  assert.match(continued.text, /waiting for Claude Code implementation/)
})

test('QA evidence requires successful checks and an explicit pass verdict', async t => {
  const { call, requests } = await setup(t, parsed => {
    const system = parsed.messages[0].content
    if (system.includes('Системный Аналитик')) return 'ANALYSIS_DONE'
    if (system.includes('ИТ-Архитектор')) return 'ARCHITECTURE_DONE'
    if (system.includes('Менеджер по качеству')) return 'APPROVED'
    if (system.includes('Старший Разработчик')) return 'IMPLEMENTATION_HANDOFF'
    if (system.includes('QA-рецензент')) return 'VERDICT: PASSED'
    return 'UNEXPECTED'
  })
  const start = await call('orchestrate_start', { task: 'Implement full billing workflow across services', mode: 'full' })
  const runId = start.text.match(/run-[a-f0-9-]+/)[0]
  const handoff = await call('orchestrate_next', { run_id: runId })
  assert.match(handoff.text, /waiting-execution/)
  const failed = await call('orchestrate_submit_qa', {
    run_id: runId,
    checks: [{ name: 'unit tests', command: 'npm test', exitCode: 1, output: 'one test failed' }],
  })
  assert.match(failed.text, /FAILED/)
  assert.equal(requests.some(req => req.messages[0].content.includes('QA-рецензент')), false)
  const passed = await call('orchestrate_submit_qa', {
    run_id: runId,
    checks: [{ name: 'unit tests', command: 'npm test', exitCode: 0, output: 'all tests passed' }],
  })
  assert.match(passed.text, /PASSED/)
})

test('QA retry clears old evidence and produces a new implementation handoff', async t => {
  const { call, requests } = await setup(t, parsed => {
    const system = parsed.messages[0].content
    if (system.includes('Системный Аналитик')) return 'ANALYSIS_DONE'
    if (system.includes('ИТ-Архитектор')) return 'ARCHITECTURE_DONE'
    if (system.includes('Менеджер по качеству')) return 'APPROVED'
    if (system.includes('Старший Разработчик')) return 'IMPLEMENTATION_HANDOFF'
    if (system.includes('QA-рецензент')) return 'VERDICT: FAILED'
    return 'UNEXPECTED'
  })
  const start = await call('orchestrate_start', { task: 'Implement subscription billing in multiple services', mode: 'full' })
  const runId = start.text.match(/run-[a-f0-9-]+/)[0]
  await call('orchestrate_next', { run_id: runId })
  const rejected = await call('orchestrate_submit_qa', {
    run_id: runId,
    checks: [{ name: 'unit tests', command: 'npm test', exitCode: 0, output: 'tests passed' }],
  })
  assert.match(rejected.text, /FAILED/)
  const retried = await call('orchestrate_resolve', { run_id: runId, action: 'retry' })
  assert.match(retried.text, /waiting-execution/)
  assert.match(retried.text, /implementation and executed checks/)
  assert.equal(requests.filter(req => req.messages[0].content.includes('Старший Разработчик')).length, 2)
  assert.equal(requests.some(req => req.messages[0].content.includes('Старший Разработчик') && req.messages[1].content.includes('tests passed')), false)
})

test('QA cannot pass on ambiguous free-form model output', async t => {
  const { call } = await setup(t, parsed => {
    const system = parsed.messages[0].content
    if (system.includes('Системный Аналитик')) return 'ANALYSIS_DONE'
    if (system.includes('ИТ-Архитектор')) return 'ARCHITECTURE_DONE'
    if (system.includes('Менеджер по качеству')) return 'APPROVED'
    if (system.includes('Старший Разработчик')) return 'IMPLEMENTATION_HANDOFF'
    if (system.includes('QA-рецензент')) return 'Looks good to me.'
    return 'UNEXPECTED'
  })
  const start = await call('orchestrate_start', { task: 'Implement complex billing changes across services', mode: 'full' })
  const runId = start.text.match(/run-[a-f0-9-]+/)[0]
  await call('orchestrate_next', { run_id: runId })
  const result = await call('orchestrate_submit_qa', {
    run_id: runId,
    checks: [{ name: 'unit tests', command: 'npm test', exitCode: 0, output: 'passed' }],
  })
  assert.doesNotMatch(result.text, /GATE qa=PASSED/)
})
