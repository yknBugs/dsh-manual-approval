/**
 * Applies the Host half against a fake Cordis context with real assertions.
 *
 * This is the check that catches boot-breaking mistakes without needing a full
 * harness boot: a bad export shape, a missing service, a throwing `apply`, or a
 * route that never registers.
 *
 *   node scripts/selftest-apply.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin, { Config, feedbackSentence, rejectionResult } from '../lib/index.js'

/**
 * Isolate the rule store BEFORE the first `apply()`.
 *
 * The plugin reads `<DSH_HOME>/manual-approval/rules.json` when it mounts, and
 * `DSH_HOME` defaults to the developer's real `~/.dsh`. Without this, a checkout
 * whose owner has an "allow read" rule makes the gate tests silently change
 * behaviour: the rule approves the call and `approval.request` is never reached,
 * so the suite passes or fails depending on whose machine it runs on. It did
 * exactly that here. `resolveDshHome` reads the environment on every call, so
 * setting it now is enough — no reload needed.
 */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-apply-home-'))
mkdirSync(join(TEST_HOME, 'manual-approval'), { recursive: true })
writeFileSync(
  join(TEST_HOME, 'manual-approval', 'rules.json'),
  JSON.stringify({ version: 1, masterEnabled: true, rules: [] }),
  { encoding: 'utf8', flag: 'w' },
)
process.env.DSH_HOME = TEST_HOME

let checks = 0
const failures = []

/**
 * Run one check, awaiting async bodies so a rejection is attributed to its own
 * check instead of surfacing as an unhandled rejection after the summary.
 */
const check = async (name, fn) => {
  try {
    await fn()
  } catch (error) {
    failures.push(name)
    console.log(`  FAIL ${name}`)
    console.log(`       ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    return
  }
  checks += 1
  console.log(`  ok  ${name}`)
}

console.log('module shape')

await check('the default export is a Cordis plugin', () => {
  assert.equal(typeof plugin, 'object')
  assert.equal(plugin.name, 'manual-approval')
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(Array.isArray(plugin.inject))
})

check('the plugin injects its boot-critical dependencies', () => {
  // `webServer` is listed because it mounts after this plugin: waiting for it is
  // what makes the route and page tap register at all.
  assert.deepEqual(plugin.inject, ['tools', 'approval', 'permissionPresets', 'webServer'])
})

await check('Config is a Standard Schema, not a defaults object', () => {
  // Cordis resolves config with `Config['~standard'].validate(config)`.
  assert.equal(typeof Config['~standard'], 'object')
  assert.equal(typeof Config['~standard'].validate, 'function')
  assert.equal(Config['~standard'].validate({})?.issues, undefined)
})

await check('Config validation is synchronous and applies defaults', () => {
  const result = Config['~standard'].validate({})
  assert.equal('then' in result, false, 'async config validation is rejected by Cordis')
  assert.equal(result.issues, undefined)
  assert.equal(result.value.presetName, 'manual')
  assert.equal(result.value.strictGuard, 'off')
  assert.equal(result.value.debug, false)
})

await check('Config validation accepts explicit values and rejects bad ones', () => {
  const good = Config['~standard'].validate({ presetName: 'custom', strictGuard: 'bypass-guard', debug: true })
  assert.equal(good.issues, undefined)
  assert.equal(good.value.presetName, 'custom')
  assert.equal(good.value.strictGuard, 'bypass-guard')
  assert.equal(good.value.debug, true)

  const bad = Config['~standard'].validate({ strictGuard: 'nonsense' })
  assert.notEqual(bad.issues, undefined)
  assert.equal(bad.value, undefined)

  const badBool = Config['~standard'].validate({ debug: 'yes' })
  assert.notEqual(badBool.issues, undefined)
})

console.log('apply against a fake context')

/** A minimal but honest fake of the Cordis context surface this plugin uses. */
function fakeContext(options = {}) {
  const listeners = new Map()
  const routes = []
  const taps = []
  const guardFns = []
  const effects = []
  const logs = []
  const services = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
      tapIndex(transform) {
        taps.push(transform)
        return () => {}
      },
    },
    agents: { get: () => undefined },
    approval: {
      request: async () => options.approvalOutcome ?? 'allowed-once',
    },
    permissionPresets: {
      current: () => options.preset ?? 'manual',
    },
  }
  const ctx = {
    get: name => services[name],
    on: (event, handler) => {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    /**
     * Cordis runs an injection callback as soon as the named services exist, and
     * again after a reload. The fake resolves through `ctx.get` — the same route
     * `apply` itself uses — so a test that removes a service removes it from both
     * paths. Reading the closure directly here would make the harness lie.
     */
    inject: (names, callback) => {
      const found = names.map(name => ctx.get(name))
      if (found.every(value => value !== undefined)) callback(...found)
      return () => {}
    },
    effect: callback => {
      const dispose = callback()
      effects.push(dispose)
      return () => {}
    },
    logger: { info: message => logs.push(String(message)), error: message => logs.push(String(message)) },
    // Cordis materialises an injected dependency as `ctx.<name>`, which is how
    // this plugin reads `ctx.permissionPresets`, `ctx.approval` and `ctx.tools`.
    // A fake that answers only `ctx.get` silently makes every mode check fail
    // closed, which is exactly the kind of harness lie this suite exists to
    // prevent.
    tools: { guard: fn => { guardFns.push(fn); return () => {} } },
    approval: services.approval,
    permissionPresets: services.permissionPresets,
    webServer: services.webServer,
  }
  return { ctx, listeners, routes, taps, guardFns, logs, services }
}

await check('apply mounts without throwing and registers its route', () => {
  const fake = fakeContext()
  const returned = plugin.apply(fake.ctx, {})
  assert.equal(fake.routes.length, 1, 'the private route must register')
  assert.equal(fake.routes[0].path, '/dsh-manual-approval/feedback')
  assert.equal(fake.routes[0].kind, 'exact')
  assert.equal(typeof fake.routes[0].handler, 'function')
  assert.equal(fake.taps.length, 1, 'the page tap must register')
  assert.equal(typeof returned, 'object', 'apply may return a preview handle')
})

await check('apply logs its mount line even without debug', () => {
  const fake = fakeContext()
  plugin.apply(fake.ctx, {})
  assert.ok(fake.logs.some(line => line.includes('mounted')), JSON.stringify(fake.logs))
})

await check('apply is safe with no config at all', () => {
  const fake = fakeContext()
  plugin.apply(fake.ctx, undefined)
  assert.equal(fake.routes.length, 1)
})

await check('a composition with no webServer mounts without routes', () => {
  const fake = fakeContext()
  const withoutWeb = { ...fake.ctx, get: name => (name === 'webServer' ? undefined : fake.ctx.get(name)), webServer: undefined }
  plugin.apply(withoutWeb, { debug: true })
  // `inject` never fires without the service, so neither the route nor the tap
  // exists — but the gate still does, and the mount line is still logged.
  assert.equal(fake.routes.length, 0, 'no route may be registered without a web server')
  assert.equal(fake.taps.length, 0)
  assert.equal(fake.listeners.get('tools/pre-execute')?.length, 1, 'the gate must still work')
  assert.ok(fake.logs.some(line => line.includes('mounted')), JSON.stringify(fake.logs))
})

await check('apply survives a throwing logger', () => {
  const fake = fakeContext()
  const hostile = { ...fake.ctx, logger: { info: () => { throw new Error('logger exploded') } } }
  plugin.apply(hostile, {})
  assert.equal(fake.routes.length, 1)
})

await check('apply registers the pre-execute gate, post-execute and result cleanup', () => {
  const fake = fakeContext()
  plugin.apply(fake.ctx, {})
  assert.equal(fake.listeners.get('tools/pre-execute')?.length, 1)
  assert.equal(fake.listeners.get('tools/post-execute')?.length, 1)
  assert.equal(fake.listeners.get('tools/result')?.length, 1)
  assert.equal(fake.listeners.get('session/disposed')?.length, 1)
})

await check('strictGuard registers a guard only when configured', () => {
  const off = fakeContext()
  plugin.apply(off.ctx, {})
  assert.equal(off.guardFns.length, 0)

  const on = fakeContext()
  plugin.apply(on.ctx, { strictGuard: 'bypass-guard' })
  assert.equal(on.guardFns.length, 1)
})

await check('the page tap injects a token and the route path', () => {
  const fake = fakeContext()
  plugin.apply(fake.ctx, {})
  const html = fake.taps[0]('<!doctype html><html><head></head><body></body></html>')
  assert.ok(html.includes('__DSH_MANUAL_APPROVAL__'), html.slice(0, 200))
  const payload = injectedPayload(html)
  assert.ok(payload !== undefined, 'the injected payload must parse')
  assert.ok(payload.token.length > 8, 'the token must be non-trivial')
  assert.equal(payload.endpoint, '/dsh-manual-approval/feedback')
  assert.equal(payload.rulesEndpoint, '/dsh-manual-approval/feedback')
})

await check('the route refuses a non-loopback peer before reading the token', async () => {
  const fake = fakeContext()
  plugin.apply(fake.ctx, {})
  const response = fakeResponse()
  await fake.routes[0].handler({ method: 'GET', url: '/x?rules=1', headers: {}, socket: { remoteAddress: '10.0.0.5' } }, response)
  assert.equal(response.status, 403)
})

await check('the route refuses a missing token on loopback', async () => {
  const fake = fakeContext()
  plugin.apply(fake.ctx, {})
  const response = fakeResponse()
  await fake.routes[0].handler({ method: 'GET', url: '/x?rules=1', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, response)
  assert.equal(response.status, 403)
})

console.log('the gate')

await check('a manual-mode call asks the approval service and runs when allowed', async () => {
  const fake = fakeContext({ approvalOutcome: 'allowed-once' })
  plugin.apply(fake.ctx, {})
  const handler = fake.listeners.get('tools/pre-execute')[0]
  const asked = []
  fake.ctx.get('approval').request = async request => {
    asked.push(request)
    return 'allowed-once'
  }
  let nextCalled = false
  const decision = await handler({ name: 'read', callId: 'c1', arguments: { file_path: 'a.txt' }, agent: { session: { id: 's1' } } }, async () => {
    nextCalled = true
    return { kind: 'allow' }
  })
  assert.equal(decision.kind, 'allow')
  assert.equal(nextCalled, true)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].toolName, 'read')
  assert.ok(asked[0].reason.includes('(ref s1:c1)'), asked[0].reason)
})

await check('a rejected call denies with the shared sentence shape', async () => {
  const fake = fakeContext({ approvalOutcome: 'rejected' })
  plugin.apply(fake.ctx, {})
  const handler = fake.listeners.get('tools/pre-execute')[0]
  const decision = await handler({ name: 'pwsh', callId: 'c1', arguments: { command: 'ls' }, agent: { session: { id: 's1' } } }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.reason, rejectionResult(undefined, 'pwsh').reason)
})

await check('the typed reason reaches a DENIED result although tools/result fires first', async () => {
  // The ordering bug: `tools/result` fires BEFORE `tools/post-execute`, so a
  // settlement listener that removes the pending entry would destroy the user's
  // feedback before the delivery step reads it. The rejection path is the one
  // that matters, because the tool never runs there.
  const fake = fakeContext({ approvalOutcome: 'rejected' })
  plugin.apply(fake.ctx, {})
  const feedbackToken = injectedPayload(fake.taps[0]('</head>')).token

  const key = 's1:c1'
  const exec = { name: 'pwsh', callId: 'c1', arguments: { command: 'rm -rf /' }, agent: { session: { id: 's1' } } }

  // The user types their reason while the card is open, then answers it.
  const post = fakeResponse()
  await fake.routes[0].handler(
    fakeRequest({
      headers: { 'x-manual-approval-token': feedbackToken },
      body: { key, text: 'do not touch that file' },
    }),
    post,
  )
  const gate = fake.listeners.get('tools/pre-execute')[0]
  const denial = await gate(exec, async () => ({ kind: 'allow' }))
  assert.equal(denial.kind, 'deny')

  // The harness settles the call: `tools/result` runs BEFORE `tools/post-execute`.
  // The envelope carries the GATE'S OWN reason, as the real harness does. Passing
  // a placeholder like `Error: denied` is what let the live duplication through:
  // the provisional sentence was never in the fixture, so nothing could notice it
  // had not been replaced.
  const envelope = { isError: true, content: [{ type: 'text', text: `Error: ${denial.reason}` }] }
  for (const listener of fake.listeners.get('tools/result') ?? []) listener(exec, envelope)
  let delivered = null
  for (const listener of fake.listeners.get('tools/post-execute') ?? []) {
    delivered = await listener(exec, envelope, async () => ({ kind: 'accept' }))
  }
  assert.ok(delivered !== null, 'post-execute must run')
  const text = JSON.stringify(delivered)
  assert.ok(text.includes('do not touch that file'), `the typed reason must reach the result: ${text}`)
  assert.ok(text.includes('rejection reason'), `and it must be labelled a rejection reason: ${text}`)

  // Exactly ONE delivery: the sentence used to be appended to the content AND
  // injected as an additional context, so the model read it twice.
  const occurrences = text.split('do not touch that file').length - 1
  assert.equal(occurrences, 1, `the note must appear once, found ${occurrences}: ${text}`)
  assert.equal(delivered.additionalContexts, undefined, 'no duplicate context channel')

  // The reported bug: the result claimed BOTH "left no rejection reason" and the
  // reason the user actually typed, because the gate's provisional sentence was
  // appended to instead of replaced.
  assert.ok(
    !text.includes('left no rejection reason'),
    `the provisional verdict must be replaced, not stacked: ${text}`,
  )
  assert.equal(
    text.split('The user reviewed').length - 1,
    1,
    `exactly one verdict sentence may survive: ${text}`,
  )
})

await check('a denial with no note is not written a second time', async () => {
  // `Error: [manual approval] … left no rejection reason.` is the tool's own
  // error line. Delivery must add NOTHING for a note-less denial, otherwise the
  // text the user saw was duplicated.
  const fake = fakeContext({ approvalOutcome: 'rejected' })
  plugin.apply(fake.ctx, {})
  const exec = { name: 'read', callId: 'c1', arguments: { file_path: 'a.txt' }, agent: { session: { id: 's1' } } }
  const gate = fake.listeners.get('tools/pre-execute')[0]
  const denial = await gate(exec, async () => ({ kind: 'allow' }))
  assert.equal(denial.kind, 'deny')
  // The verdict is whatever the gate returned; the harness renders it as the
  // tool's error line.
  const envelope = { isError: true, content: [{ type: 'text', text: `Error: ${denial.reason}` }] }

  for (const listener of fake.listeners.get('tools/result') ?? []) listener(exec, envelope)
  let delivered = null
  for (const listener of fake.listeners.get('tools/post-execute') ?? []) {
    delivered = await listener(exec, envelope, async () => ({ kind: 'accept' }))
  }
  assert.deepEqual(delivered, { kind: 'accept' }, 'nothing may be appended for a note-less denial')
  const occurrences = JSON.stringify(envelope).split('left no rejection reason').length - 1
  assert.equal(occurrences, 1, `the verdict must appear once, found ${occurrences}`)
})

await check('a non-manual session is untouched', async () => {
  const fake = fakeContext({ preset: 'workspace-write' })
  plugin.apply(fake.ctx, {})
  const handler = fake.listeners.get('tools/pre-execute')[0]
  let asked = false
  fake.ctx.get('approval').request = async () => {
    asked = true
    return 'allowed-once'
  }
  const decision = await handler({ name: 'read', callId: 'c1', arguments: {}, agent: { session: { id: 's1' } } }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'allow')
  assert.equal(asked, false)
})

await check('a missing approval service fails closed', async () => {
  const bare = fakeContext()
  const withoutApproval = { ...bare.ctx, get: name => (name === 'approval' ? undefined : bare.ctx.get(name)), approval: undefined }
  plugin.apply(withoutApproval, {})
  const handler = bare.listeners.get('tools/pre-execute')[0]
  const decision = await handler({ name: 'read', callId: 'c1', arguments: {}, agent: { session: { id: 's1' } } }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'deny')
  assert.ok(decision.reason.includes('no approval path'), decision.reason)
})

await check('a rule can allow a call without asking', async () => {
  const fake = fakeContext()
  const { handler } = await withRules(fake, [
    { id: 'r', name: 'allow reads', enabled: true, conditions: [{ target: 'toolName', pattern: '^read$' }], action: { kind: 'approve', message: '' } },
  ])
  let asked = false
  fake.ctx.get('approval').request = async () => {
    asked = true
    return 'rejected'
  }
  const decision = await handler({ name: 'read', callId: 'c1', arguments: {}, agent: { session: { id: 's1' } } }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'allow')
  assert.equal(asked, false)
})

await check('a rule deny is indistinguishable from a user denial', async () => {
  const fake = fakeContext()
  const { handler } = await withRules(fake, [
    { id: 'r', name: 'deny shell', enabled: true, conditions: [{ target: 'toolName', pattern: '^pwsh$' }], action: { kind: 'deny', message: 'not allowed' } },
  ])
  const decision = await handler({ name: 'pwsh', callId: 'c1', arguments: { command: 'ls' }, agent: { session: { id: 's1' } } }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'deny')
  const userStyle = rejectionResult('not allowed', 'pwsh').reason
  assert.equal(decision.reason, userStyle)
})

await check('a warn rule still asks and carries the warning to the panel', async () => {
  const fake = fakeContext({ approvalOutcome: 'allowed-once' })
  const { handler } = await withRules(fake, [
    { id: 'r', name: 'danger', enabled: true, conditions: [{ target: 'argValue', pattern: 'rm -rf' }], action: { kind: 'warn', message: 'looks destructive' } },
  ])
  const decision = await handler({ name: 'bash', callId: 'c1', arguments: { command: 'rm -rf /' }, agent: { session: { id: 's1' } } }, async () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'allow')
  const route = fake.routes[0]
  const response = fakeResponse()
  const token = injectedPayload(fake.taps[0]('</head>')).token
  await route.handler({ method: 'GET', url: '/x?key=s1:c1', headers: { 'x-manual-approval-token': token }, socket: { remoteAddress: '127.0.0.1' } }, response)
  assert.equal(response.body.warning, 'looks destructive')
  assert.equal(response.body.ruleName, 'danger')
  assert.deepEqual(response.body.rows, ['command: rm -rf /'])
})



/** Pull the injected page payload out of rendered HTML. */
function injectedPayload(html) {
  const start = html.indexOf('window.__DSH_MANUAL_APPROVAL__=')
  if (start === -1) return undefined
  const from = start + 'window.__DSH_MANUAL_APPROVAL__='.length
  const end = html.indexOf('</script>', from)
  if (end === -1) return undefined
  try {
    return JSON.parse(html.slice(from, end))
  } catch {
    return undefined
  }
}

/** A minimal IncomingMessage stand-in that emits one JSON body. */
function fakeRequest({ method = 'POST', url = '/x', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const handlers = new Map()
  const request = {
    method,
    url,
    headers,
    socket: { remoteAddress },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return request
    },
    destroy() {},
  }
  // Deliver after the handler has subscribed, as a real socket would.
  queueMicrotask(() => {
    if (body !== undefined) {
      const chunk = Buffer.from(JSON.stringify(body), 'utf8')
      for (const handler of handlers.get('data') ?? []) handler(chunk)
    }
    for (const handler of handlers.get('end') ?? []) handler()
  })
  return request
}

/** Apply the plugin with a temporary rule file, then return the gate handler. */
async function withRules(fake, rules) {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dshma-apply-'))
  const file = join(dir, 'rules.json')
  writeFileSync(file, JSON.stringify({ version: 1, masterEnabled: true, rules }), 'utf8')
  plugin.apply(fake.ctx, { rulesFile: file })
  const handlers = fake.listeners.get('tools/pre-execute')
  return { handler: handlers[handlers.length - 1] }
}

/** A minimal ServerResponse stand-in capturing status and body. */
function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(payload) {
      try {
        this.body = JSON.parse(payload)
      } catch {
        this.body = payload
      }
    },
  }
}

await check('the shared formatter is exported for both decision sources', () => {
  assert.equal(feedbackSentence('x', 'read', 'note').includes('x'), true)
})

console.log(`\n${checks} checks passed`)
if (failures.length > 0) {
  console.log(`failed: ${failures.join(', ')}`)
  process.exit(1)
}
