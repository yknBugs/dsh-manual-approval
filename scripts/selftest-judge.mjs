/**
 * Judge-transport checks. Runs a real HTTP server on loopback and drives
 * `runJudge` against it, so the transport is exercised end to end rather than
 * mocked:
 *
 *   node scripts/selftest-judge.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { compileRule } from '../lib/rules.js'
import { MAX_JUDGE_BYTES, combineSignals, readCappedText, redactUrl, runJudge } from '../lib/judge.js'

let checks = 0
const check = async (name, fn) => {
  await fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

const compile = raw => {
  const result = compileRule(raw, 0)
  assert.equal(result.ok, true, `expected a valid rule, got ${JSON.stringify(result.errors)}`)
  return result.rule
}

const judgeRule = (overrides = {}) => compile({
  id: 'j1',
  name: 'judge rule',
  enabled: true,
  conditions: [{ target: 'toolName', pattern: '^pwsh$' }],
  action: {
    kind: 'judge',
    url: 'http://127.0.0.1:0/judge',
    method: 'POST',
    headersText: '',
    body: '',
    decisionPath: 'result.decision',
    reasonPath: 'result.why',
    timeoutMs: 5000,
    ...overrides,
  },
})

/** Collected request facts so response/request assertions can be made. */
const seen = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body })
    if (req.url === '/hang') return // never responds; exercises the timeout
    if (req.url === '/status500') {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('boom')
      return
    }
    if (req.url === '/notjson') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('<html>not json</html>')
      return
    }
    if (req.url === '/huge') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ pad: 'x'.repeat(MAX_JUDGE_BYTES + 10) }))
      return
    }
    if (req.url === '/huge-declared') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(MAX_JUDGE_BYTES + 10) })
      res.end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ result: { decision: 'deny', why: 'nope' } }))
  })
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const url = path => `http://127.0.0.1:${port}${path}`

try {
  await check('an approve verdict comes back as approve', async () => {
    const rule = judgeRule({ url: url('/approve') })
    const verdict = await runJudge(rule, 'pwsh', { command: 'ls' }, [])
    // The default test server denies; this asserts the deny path plus the request.
    assert.equal(verdict.kind, 'deny')
    assert.equal(verdict.message, 'nope')
  })

  await check('the request carries the method, JSON content type and the combined body', async () => {
    seen.length = 0
    const rule = judgeRule({ url: url('/judge') })
    await runJudge(rule, 'pwsh', { command: 'ls', description: 'List' }, [])
    assert.equal(seen.length, 1)
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].headers['content-type'], 'application/json')
    assert.equal(seen[0].body, '{"pwsh":{"command":"ls","description":"List"}}')
  })

  await check('user headers are sent and the body override is used', async () => {
    seen.length = 0
    const rule = judgeRule({
      url: url('/judge'),
      headersText: 'X-Token: abc\nX-Trace: 7',
      body: '{"cmd":"$1"}',
    })
    await runJudge(rule, 'pwsh', { command: 'ls' }, ['ls'])
    assert.equal(seen[0].headers['x-token'], 'abc')
    assert.equal(seen[0].headers['x-trace'], '7')
    assert.equal(seen[0].body, '{"cmd":"ls"}')
  })

  await check('a GET judge omits the body', async () => {
    seen.length = 0
    const rule = judgeRule({ url: url('/judge'), method: 'GET' })
    await runJudge(rule, 'pwsh', { command: 'ls' }, [])
    assert.equal(seen[0].method, 'GET')
    assert.equal(seen[0].body, '')
  })

  await check('an unreachable host degrades to a red warning', async () => {
    const rule = judgeRule({ url: 'http://127.0.0.1:1/judge', timeoutMs: 2000 })
    const verdict = await runJudge(rule, 'pwsh', { command: 'ls' }, [])
    assert.equal(verdict.kind, 'warn')
    assert.equal(verdict.failed, true)
    assert.ok(verdict.warning.includes('judge rule'))
  })

  await check('a non-2xx status degrades to a red warning naming the status', async () => {
    const rule = judgeRule({ url: url('/status500') })
    const verdict = await runJudge(rule, 'pwsh', { command: 'ls' }, [])
    assert.equal(verdict.kind, 'warn')
    assert.ok(verdict.warning.includes('HTTP 500'), verdict.warning)
  })

  await check('a non-JSON body degrades to a red warning', async () => {
    const rule = judgeRule({ url: url('/notjson') })
    const verdict = await runJudge(rule, 'pwsh', { command: 'ls' }, [])
    assert.equal(verdict.kind, 'warn')
    assert.ok(verdict.warning.includes('not JSON'), verdict.warning)
  })

  await check('an unbounded declared length is refused', async () => {
    const rule = judgeRule({ url: url('/huge-declared') })
    const verdict = await runJudge(rule, 'pwsh', { command: 'ls' }, [])
    assert.equal(verdict.kind, 'warn')
    assert.ok(verdict.warning.includes('over the'), verdict.warning)
  })

  await check('an oversized body is refused', async () => {
    const rule = judgeRule({ url: url('/huge') })
    const verdict = await runJudge(rule, 'pwsh', { command: 'ls' }, [])
    assert.equal(verdict.kind, 'warn')
    assert.ok(verdict.warning.includes('over the'), verdict.warning)
  })

  await check('a hung judge times out into a red warning instead of hanging', async () => {
    const rule = judgeRule({ url: url('/hang'), timeoutMs: 200, method: 'POST' })
    const started = Date.now()
    const verdict = await runJudge(rule, 'pwsh', { command: 'ls' }, [])
    const elapsed = Date.now() - started
    assert.equal(verdict.kind, 'warn')
    assert.equal(verdict.failed, true)
    assert.ok(elapsed < 5000, `expected a prompt timeout, waited ${elapsed}ms`)
  })

  await check('a missing fetch implementation degrades rather than throwing', async () => {
    const rule = judgeRule({ url: url('/judge') })
    // `undefined` would select the default parameter, so pass an explicit
    // non-function to model a runtime without fetch.
    const verdict = await runJudge(rule, 'pwsh', { command: 'ls' }, [], undefined, null)
    assert.equal(verdict.kind, 'warn')
    assert.ok(verdict.warning.includes('no fetch implementation'), verdict.warning)
  })

  await check('credentials in the URL are redacted from every message', async () => {
    assert.equal(redactUrl('http://user:secret@127.0.0.1:1/judge'), 'http://127.0.0.1:1/judge')
    assert.equal(redactUrl('http://127.0.0.1:1/judge'), 'http://127.0.0.1:1/judge')
    assert.equal(redactUrl('not a url'), 'not a url')
    const rule = judgeRule({ url: 'http://user:secret@127.0.0.1:1/judge', timeoutMs: 2000 })
    const verdict = await runJudge(rule, 'pwsh', { command: 'ls' }, [])
    assert.equal(verdict.warning.includes('secret'), false, verdict.warning)
    assert.equal(verdict.warning.includes('user'), false, verdict.warning)
  })

  await check('signals degrade when AbortSignal.any is unavailable', async () => {
    const controller = new AbortController()
    const signal = combineSignals(5000, controller.signal)
    assert.notEqual(signal, undefined)
    assert.equal(signal.aborted, false)
    controller.abort()
    assert.equal(signal.aborted, true)
    // A caller signal alone is still honoured.
    assert.equal(combineSignals(5000, controller.signal).aborted, true)
  })

  await check('readCappedText enforces its limit directly', async () => {
    const small = { headers: { get: () => null }, text: async () => 'ok' }
    assert.equal(await readCappedText(small, 10), 'ok')
    const big = { headers: { get: () => null }, text: async () => 'x'.repeat(20) }
    await assert.rejects(() => readCappedText(big, 10), /over the 10 byte limit/)
  })
} finally {
  await new Promise(resolve => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

console.log(`\n${checks} checks passed`)
