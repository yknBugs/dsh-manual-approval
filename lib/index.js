/**
 * Manual approval permission mode — Host half.
 *
 * This module deliberately has NO bare package imports. A plugin `link:`ed into
 * a profile resolves through its REAL path, so a bare `@deepseek-ai/...`
 * specifier climbs the checkout's own directory tree instead of the profile's
 * `node_modules`, and the whole plugin tree fails to load. Only `ctx` services,
 * Node built-ins and relative modules are used here.
 *
 * `manual` is an ordinary entry in the official permission-preset table (see
 * `cordis.patch.yml`): sandbox `danger-full-access` plus approval `ask`. Those
 * two knobs are what make this plugin almost pure policy:
 *
 *   - `danger-full-access` removes confinement, so a user-approved call has full
 *     execution authority with no platform-specific code anywhere here.
 *   - `tools/pre-execute` forces a review for EVERY tool call, including
 *     read/grep/glob/web search, so the model needs no elevation parameter and
 *     its tool arguments stay byte-identical.
 *
 * Review is then resolved by the user's rule list (`lib/rules.js`) in order, and
 * falls through to the official approval prompt when no rule decides.
 *
 * ## Feedback and warnings
 *
 * The shipped `ApprovalOutcome` vocabulary is four fixed strings with nowhere to
 * carry text, so the panel's feedback and a rule's warning travel over a private
 * loopback route owned here (`GET`/`POST <feedbackPath>`).
 *
 * A rule-generated rejection is deliberately produced by the SAME formatter as a
 * user-typed one (`feedbackSentence`), so the model cannot tell an automatic
 * denial from a human one.
 */

import { objectSchema } from './config.js'
import { runJudge } from './judge.js'
import { actionMessage, compileRules, describeRule, firstMatch, warningText } from './rules.js'
import { emptyDocument, readDocument, resolveDshHome, rulesPath, writeDocument } from './store.js'

/** The preset table key that activates this policy. */
export const MANUAL_PRESET = 'manual'

/** Marker leading our approval headline; the browser half recognises it. */
export const REASON_PREFIX = '[manual approval]'

/** Global the injected page snippet populates for the browser half. */
export const PAGE_GLOBAL = '__DSH_MANUAL_APPROVAL__'

/**
 * Mount-time configuration.
 *
 * This MUST be a schema object: Cordis resolves a plugin's config with
 * `Config['~standard'].validate(config)`. Exporting a plain defaults object here
 * throws `Cannot read properties of undefined (reading 'validate')` during boot
 * and takes the entire plugin tree down with it.
 */
export const Config = objectSchema({
  presetName: { kind: 'string', default: MANUAL_PRESET },
  feedbackPath: { kind: 'pattern', default: '/dsh-manual-approval/feedback' },
  rulesFile: { kind: 'string' },
  strictGuard: { kind: 'enum', values: ['off', 'bypass-guard'], default: 'off' },
  debug: { kind: 'boolean', default: false },
}, 'manual-approval')


const DEFAULT_FEEDBACK_PATH = '/dsh-manual-approval/feedback'

/** Per-value display cap inside one argument row. */
const MAX_PARAM_VALUE = 320
/** Per-call cap on the whole row block. */
const MAX_PARAM_BLOCK = 2600
/** Maximum accepted feedback body. */
const MAX_FEEDBACK_BYTES = 16 * 1024
/** Maximum accepted rule document. */
const MAX_RULES_BYTES = 1024 * 1024
/** Refuse absurd request bodies rather than buffering them. */
const MAX_REQUEST_BYTES = 2 * 1024 * 1024

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const SAFE_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/

function isLoopbackPeer(req) {
  const address = req?.socket?.remoteAddress
  if (typeof address !== 'string') return false
  if (LOOPBACK_PEERS.has(address)) return true
  return address.startsWith('::ffff:127.') || address.startsWith('127.')
}

/**
 * Per-pending-call state, keyed by `<sessionId>:<callId>`: the argument rows the
 * detail panel displays, the feedback the user typed, and any rule warning. It
 * also holds the rule document snapshot used for each call's decision.
 */
export class PendingStore {
  constructor(limit = 512, ttlMs = 15 * 60 * 1000) {
    this.entries = new Map()
    this.limit = limit
    this.ttlMs = ttlMs
  }

  touch(key) {
    this.sweep()
    if (this.entries.has(key)) return this.entries.get(key)
    if (this.entries.size >= this.limit) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    const entry = { rows: undefined, feedback: undefined, warning: undefined, ruleName: undefined, at: Date.now() }
    this.entries.set(key, entry)
    return entry
  }

  putRows(key, rows) {
    const entry = this.touch(key)
    entry.rows = rows
    entry.at = Date.now()
  }

  putWarning(key, warning, ruleName) {
    const entry = this.touch(key)
    entry.warning = warning
    entry.ruleName = ruleName
    entry.at = Date.now()
  }

  view(key) {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    return { rows: entry.rows, warning: entry.warning, ruleName: entry.ruleName }
  }

  putFeedback(key, text) {
    const entry = this.touch(key)
    entry.feedback = text
    entry.at = Date.now()
  }

  /**
   * Read the feedback without consuming it.
   *
   * `tools/result` fires BEFORE `tools/post-execute`, so a consumer that removed
   * the entry could destroy the value before post-execute reads it. Reading here
   * and letting the settlement listener remove the entry makes the ordering
   * irrelevant.
   */
  peekFeedback(key) {
    return this.entries.get(key)?.feedback
  }

  delete(key) {
    this.entries.delete(key)
  }

  sweep() {
    const cutoff = Date.now() - this.ttlMs
    for (const [key, entry] of this.entries) {
      if (entry.at < cutoff) this.entries.delete(key)
    }
  }
}

function asString(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}

function oneLine(value, cap) {
  const flat = asString(value).replace(/\s+/g, ' ').trim()
  return flat.length <= cap ? flat : `${flat.slice(0, cap)}…`
}

/** One prompt line per tool argument. */
export function formatParameterLines(args) {
  if (args === null || args === undefined) return ['(no arguments)']
  if (typeof args !== 'object' || Array.isArray(args)) return [`value: ${oneLine(args, MAX_PARAM_VALUE)}`]
  const keys = Object.keys(args)
  if (keys.length === 0) return ['(no arguments)']
  return keys.map(key => `${key}: ${oneLine(args[key], MAX_PARAM_VALUE)}`)
}

/**
 * The approval card's headline. Kept short: the browser half reads its feedback
 * key from the end of this exact text, so it must never be truncated. The full
 * argument list is fetched over the private channel instead, because the
 * approval event's shape is fixed and its codec refuses unknown fields.
 */
export function buildApprovalReason(toolName, flow, key) {
  const name = typeof toolName === 'string' ? toolName : 'unknown tool'
  const description = typeof flow === 'string' && flow.trim() !== '' ? ` — ${oneLine(flow, 200)}` : ''
  const ref = typeof key === 'string' && key !== '' ? ` (ref ${key})` : ''
  return `${REASON_PREFIX} Confirm tool call: ${name}${description}${ref}`
}

/** Argument rows for the detail panel, bounded. */
export function buildParameterRows(args) {
  const rows = formatParameterLines(args)
  const kept = []
  let total = 0
  for (const row of rows) {
    if (total + row.length > MAX_PARAM_BLOCK) {
      kept.push(`…(${rows.length - kept.length} more)`)
      break
    }
    total += row.length
    kept.push(row)
  }
  return kept
}

/** Stable per-call key. `<sessionId>:<callId>` — neither id contains a colon. */
export function callKey(agent, call) {
  if (agent === undefined || call === undefined || call === null) return undefined
  const sessionId = agent?.session?.id
  const callId = call?.callId
  if (sessionId === undefined || callId === undefined) return undefined
  return `${String(sessionId)}:${String(callId)}`
}

function randomToken() {
  try {
    return globalThis.crypto.randomUUID().replace(/-/g, '')
  } catch {
    return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  }
}

function readPageGlobals(globalObject) {
  const holder = globalObject?.[PAGE_GLOBAL]
  if (holder === null || typeof holder !== 'object') {
    return { token: '', endpoint: DEFAULT_FEEDBACK_PATH, rulesEndpoint: DEFAULT_FEEDBACK_PATH }
  }
  const pick = value => (typeof value === 'string' && SAFE_PATH.test(value) ? value : DEFAULT_FEEDBACK_PATH)
  return {
    token: typeof holder.token === 'string' ? holder.token : '',
    endpoint: pick(holder.endpoint),
    rulesEndpoint: pick(holder.rulesEndpoint),
  }
}

function indexInjection(token, endpoint, rulesEndpoint) {
  const payload = JSON.stringify({ token, endpoint, rulesEndpoint })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
  return `<script>window.${PAGE_GLOBAL}=${payload}</script>`
}

function readJsonBody(req, limit = MAX_REQUEST_BYTES) {
  return new Promise(resolve => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        resolve(undefined)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => resolve(undefined))
    req.on('end', () => {
      if (size === 0) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
  })
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

/**
 * The private route's request handler.
 *
 * Two guards, in this order: the peer must be loopback (the `webServer` may bind
 * `0.0.0.0`, and nothing legitimate reaches this route from another machine),
 * and the request must carry the per-process token the page was given. Together
 * they make it impossible for another origin, or another host, to read the rule
 * document or forge approval feedback.
 *
 * The route never touches credentials, files outside the rules document, or Host
 * state; it moves short strings and the rule document between the Host and the
 * page this Host itself served.
 */
export function createRouteHandler({ pending, snapshot, putRules, readToken, log }) {
  return async function handleRoute(req, res) {
    if (req.method !== 'POST' && req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'GET or POST only' })
      return
    }
    if (!isLoopbackPeer(req)) {
      sendJson(res, 403, { ok: false, error: 'loopback only' })
      return
    }
    const token = readToken()
    if (token === '' || req.headers['x-manual-approval-token'] !== token) {
      sendJson(res, 403, { ok: false, error: 'bad token' })
      return
    }

    // GET ?rules=1 — the settings page reads the rule document.
    if (req.method === 'GET' && queryValue(req.url, 'rules') === '1') {
      sendJson(res, 200, snapshot())
      return
    }

    // GET ?key=… — the approval panel reads one call's rows and warning.
    if (req.method === 'GET') {
      const key = queryValue(req.url, 'key')
      const view = key === '' ? undefined : pending.view(key)
      sendJson(res, 200, {
        ok: true,
        rows: Array.isArray(view?.rows) ? view.rows : null,
        warning: typeof view?.warning === 'string' ? view.warning : null,
        ruleName: typeof view?.ruleName === 'string' ? view.ruleName : null,
      })
      return
    }

    const body = await readJsonBody(req)
    if (body === undefined || typeof body !== 'object' || body === null) {
      sendJson(res, 400, { ok: false, error: 'bad body' })
      return
    }

    // POST { rules: {...} } — the settings page writes the document.
    if (body.rules !== undefined) {
      let serialized
      try {
        serialized = JSON.stringify(body.rules)
      } catch {
        sendJson(res, 400, { ok: false, error: 'the rule document is not JSON' })
        return
      }
      if (Buffer.byteLength(serialized, 'utf8') > MAX_RULES_BYTES) {
        sendJson(res, 413, { ok: false, error: 'rule document too large' })
        return
      }
      try {
        putRules(body.rules)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        sendJson(res, 500, { ok: false, error: `could not save rules: ${detail}` })
        return
      }
      log(`rules saved (${snapshot().rules.length} rule(s))`)
      sendJson(res, 200, snapshot())
      return
    }

    // POST { key, text } — the approval panel submits feedback.
    const key = typeof body.key === 'string' ? body.key : ''
    const text = typeof body.text === 'string' ? body.text : ''
    if (key === '' || key.length > 512) {
      sendJson(res, 400, { ok: false, error: 'bad key' })
      return
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_FEEDBACK_BYTES) {
      sendJson(res, 413, { ok: false, error: 'feedback too long' })
      return
    }
    if (text.trim() !== '') pending.putFeedback(key, text.trim())
    log(`feedback recorded for ${key}`)
    sendJson(res, 200, { ok: true })
  }
}

/** Percent-decoded `?key=` from a request URL. */
function queryValue(url, name) {
  const query = String(url ?? '').split('?')[1] ?? ''
  const pattern = new RegExp(`(?:^|&)${name}=([^&]*)`)
  return decodeURIComponent((pattern.exec(query)?.[1] ?? '').trim())
}

/**
 * Resolve the session that owns this execution when it is in manual mode,
 * walking the durable `parentSession` chain so official in-process subagents
 * inherit the parent's manual mode.
 */
export function manualAuthority(exec, lookupAgent, currentPreset, presetName) {
  const isManual = agent => {
    const session = agent?.session
    if (session === undefined) return false
    try {
      return currentPreset(session) === presetName
    } catch {
      return false
    }
  }
  if (isManual(exec?.agent)) return exec.agent
  let session = exec?.agent?.session
  const visited = new Set()
  while (session?.header?.origin === 'subagent' && session.header.parentSession !== undefined) {
    const parentSessionId = session.header.parentSession
    const key = String(parentSessionId)
    if (visited.has(key)) return undefined
    visited.add(key)
    const parent = lookupAgent(parentSessionId)
    if (parent === undefined) return undefined
    if (isManual(parent)) return parent
    session = parent.session
  }
  return undefined
}

/**
 * Is this the gate's provisional denial line, and nothing else?
 *
 * The gate has to state a verdict before the user's note can have arrived, so a
 * denial starts life as "… left no rejection reason." A note later replaces that
 * sentence; anything the tool itself contributed is kept. Recognising the line
 * by its exact prefix — this plugin's own marker plus the shared formatter's
 * tail — means a plain tool error is never rewritten in the user's voice.
 */
export function isProvisionalDenial(content) {
  if (!Array.isArray(content) || content.length !== 1) return false
  const block = content[0]
  if (block === null || typeof block !== 'object' || block.type !== 'text') return false
  const text = typeof block.text === 'string' ? block.text : ''
  return text.startsWith(`Error: ${REASON_PREFIX}`) && text.endsWith('left no rejection reason.')
}

/**
 * The sentence shared by a user-typed decision and a rule-generated one.
 * Keeping ONE formatter is what makes an automatic rejection indistinguishable
 * from a hand-written one.
 */
export function feedbackSentence(text, toolName, field) {
  const name = typeof toolName === 'string' ? toolName : 'the tool'
  const body = typeof text === 'string' && text.trim() !== '' ? text.trim() : ''
  return body === ''
    ? `[manual approval] The user reviewed \`${name}\` and left no ${field}.`
    : `[manual approval] The user reviewed \`${name}\` and added this ${field}:\n${body}`
}

/** The tool result a user rejection produces. */
export function rejectionResult(text, toolName) {
  return {
    kind: 'deny',
    reason: feedbackSentence(text, toolName, 'rejection reason'),
  }
}

// ---------------------------------------------------------------------------
// Host half
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const presetName = typeof config.presetName === 'string' && config.presetName !== '' ? config.presetName : MANUAL_PRESET
  const feedbackPath = typeof config.feedbackPath === 'string' && SAFE_PATH.test(config.feedbackPath)
    ? config.feedbackPath
    : DEFAULT_FEEDBACK_PATH
  const strictGuard = config.strictGuard === 'bypass-guard' ? 'bypass-guard' : 'off'
  const debug = config.debug === true

  const pending = new PendingStore()
  const approvedCalls = new Set()
  const consumedFeedback = new WeakSet()
  /**
   * Calls this plugin denied by itself, keyed by `sessionId:callId`.
   *
   * A denial already carries the user's sentence as the tool's error reason, so
   * the delivery step must NOT append it a second time. This set is what tells
   * the two cases apart.
   */
  const deniedCalls = new Set()
  const childAgent = sessionId => ctx.get('agents')?.get(sessionId)
  const currentPreset = session => ctx.permissionPresets.current(session)
  const authorityFor = exec => manualAuthority(exec, childAgent, currentPreset, presetName)
  const isManual = exec => authorityFor(exec) !== undefined

  const log = message => {
    if (!debug) return
    say(message)
  }

  /**
   * Always printed. Boot-time facts a user cannot otherwise see — whether the
   * Host half mounted, whether its route registered, which mode it reads — must
   * not hide behind a debug flag; "the mode is missing" has to be diagnosable
   * from the console alone.
   */
  const say = message => {
    try {
      ctx.logger?.info?.(`[manual-approval] ${message}`)
    } catch {
      // Logging never breaks a decision path.
    }
  }

  // ---- rule document ------------------------------------------------------
  const storePath = config.rulesFile === undefined ? rulesPath(resolveDshHome()) : String(config.rulesFile)

  let document = emptyDocument()
  let loadError
  try {
    const loaded = readDocument(storePath)
    document = loaded.document
    loadError = loaded.error
    if (loadError !== undefined) log(`rules file problem: ${loadError}`)
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error)
  }

  let state = {}

  /** Recompile from the current document. Cheap; rules are few. */
  const recompile = () => {
    const compiled = compileRules(document.rules, document.masterEnabled)
    state = {
      document,
      compiled,
      rules: compiled.rules,
      enabled: compiled.enabled,
    }
    return state
  }
  recompile()

  const snapshot = () => ({
    ok: true,
    masterEnabled: state.document.masterEnabled !== false,
    // The raw rule text, so the settings editor round-trips exactly what the
    // user wrote (invalid patterns included) instead of a re-serialization.
    rules: state.document.rules.map(entry => entry),
    compiled: state.rules.map(rule => ({
      index: rule.index,
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled === true && rule.invalid !== true,
      valid: rule.invalid !== true,
      errors: rule.invalid === true ? (rule.errors ?? ['invalid rule']) : [],
      groupCount: rule.groupCount ?? 0,
      action: rule.action?.kind ?? '',
    })),
    errors: loadError === undefined ? [] : [loadError],
    path: storePath,
  })

  // ---- private HTTP route -------------------------------------------------
  // The per-process token is minted unconditionally, before the carrier exists,
  // so the page tap and the route handler always agree on it.
  let token = ''
  try {
    const holder = globalThis[PAGE_GLOBAL]
    if (typeof holder?.token === 'string' && holder.token !== '') token = holder.token
  } catch {
    token = ''
  }
  if (token === '') {
    token = randomToken()
    try {
      globalThis[PAGE_GLOBAL] = { token, endpoint: feedbackPath, rulesEndpoint: feedbackPath }
    } catch {
      log('could not publish the private-route token on globalThis')
    }
  }

  const tapIndex = server => {
    if (typeof server?.tapIndex !== 'function') {
      log('the web server exposes no index tap; the page will not receive its token')
      return
    }
    ctx.effect(() => server.tapIndex(html => {
      const globals = readPageGlobals(globalThis)
      if (globals.token === '') return html
      const snippet = indexInjection(globals.token, globals.endpoint, globals.rulesEndpoint)
      return html.includes('</head>') ? html.replace('</head>', `${snippet}</head>`) : `${snippet}${html}`
    }), 'manual-approval: page injection')
  }

  // `ctx.inject` runs the callback as soon as the browser carrier exists, and
  // re-runs it after a reload. Reading `ctx.get('webServer')` once inside `apply`
  // is NOT equivalent: if this plugin's fiber happens to initialise first, that
  // read sees `undefined` and both registrations are silently skipped, which
  // looks exactly like "the plugin is not installed".
  // The browser carrier mounts AFTER this plugin, so `webServer` is a listed
  // dependency: the fiber waits for it instead of racing it. That is the only
  // arrangement observed to register the route reliably — a one-shot
  // `ctx.get('webServer')` saw `undefined` and silently skipped both
  // registrations, which looks exactly like "the plugin is not installed".
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    tapIndex(webServer)
    ctx.effect(() => {
      const dispose = webServer.register({
        kind: 'exact',
        path: feedbackPath,
        handler: createRouteHandler({
          pending,
          snapshot,
          putRules: next => {
            document = writeDocument(next, storePath)
            loadError = undefined
            recompile()
          },
          readToken: () => token,
          log,
        }),
      })
      return dispose
    }, 'manual-approval: private route')
  }

  // ---- the gate -----------------------------------------------------------
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!isManual(exec)) return next()

    const args = exec?.arguments
    const flow = args !== null && typeof args === 'object' ? args.description : undefined
    const key = callKey(exec?.agent, exec)
    const toolName = typeof exec?.name === 'string' ? exec.name : 'unknown tool'

    /**
     * Deny this call, remembering that its reason is already in the result.
     *
     * The denial sentence becomes the tool's error reason, so appending it again
     * during delivery produced the duplicated `Error: [manual approval] …` the
     * user saw.
     */
    const deny = text => {
      if (key !== undefined) deniedCalls.add(key)
      return rejectionResult(text, toolName)
    }

    // 1. The user's rules decide first, in order; the first match wins and its
    //    action is terminal. With no match the call falls through to the prompt.
    const hit = firstMatch(state.rules, toolName, args, state.enabled)
    let warning
    let warningRule
    if (hit !== undefined) {
      const { rule, captures } = hit
      const action = rule.action.kind
      log(`rule "${rule.name}" matched ${toolName} -> ${action}`)

      if (action === 'approve') {
        if (key !== undefined) {
          approvedCalls.add(key)
          pending.touch(key)
        }
        return next()
      }
      if (action === 'deny') {
        // Deliberately the same shape a user rejection produces.
        return deny(actionMessage(rule, captures))
      }
      if (action === 'warn') {
        warning = warningText(rule, captures)
        warningRule = rule.name
      }
      if (action === 'judge') {
        const verdict = await runJudgeFor(rule, toolName, args, captures, exec?.signal, exec)
        if (verdict.kind === 'approve') {
          if (key !== undefined) {
            approvedCalls.add(key)
            pending.touch(key)
          }
          return next()
        }
        if (verdict.kind === 'deny') {
          return deny(verdict.message)
        }
        warning = verdict.warning
        warningRule = rule.name
      }
    }

    // 2. No rule decided: ask the human, with any warning attached.
    const approval = ctx.get('approval')
    if (approval === undefined || typeof approval.request !== 'function') {
      return { kind: 'deny', reason: `[manual approval unavailable] ${toolName} was not executed: no approval path is composed` }
    }

    let outcome
    try {
      if (key !== undefined) {
        pending.putRows(key, buildParameterRows(args))
        if (typeof warning === 'string' && warning !== '') pending.putWarning(key, warning, warningRule)
      }
      outcome = await approval.request({
        agent: exec.agent,
        toolName,
        ...(exec.callId === undefined ? {} : { callId: exec.callId }),
        reason: buildApprovalReason(toolName, flow, key),
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      })
    } catch (error) {
      if (key !== undefined) pending.delete(key)
      const detail = error instanceof Error ? error.message : String(error)
      return { kind: 'deny', reason: `[manual approval failed] ${toolName} was not executed: ${detail}` }
    }

    if (outcome === 'allowed-once') {
      if (key !== undefined) approvedCalls.add(key)
      log(`allowed ${toolName}`)
      return next()
    }
    if (outcome === 'rejected') {
      log(`rejected ${toolName}`)
      // The user's own typed reason, when present, becomes the tool's error
      // reason through this single return value — so delivery must not repeat it.
      return deny(undefined)
    }
    log(`withdrawn ${toolName} (${outcome})`)
    return {
      kind: 'deny',
      reason: `[manual approval withdrawn] ${toolName} was not executed: the request settled as "${outcome}".`,
    }
  }, { prepend: true })

  // ---- judge ---------------------------------------------------------------
  /**
   * Run one judge rule with the session's working directory.
   *
   * The cwd travels as a sibling field of the DEFAULT body only
   * (`{"cwd":…,"<tool>":{…}}`); a body the user wrote is sent exactly as written,
   * so no existing judge service has its agreed payload changed underneath it.
   */
  const runJudgeFor = (rule, toolName, args, captures, signal, exec) => {
    const cwd = authorityFor(exec)?.session?.header?.cwd
    return runJudge(rule, toolName, args, captures, signal, globalThis.fetch, log, {
      cwd: typeof cwd === 'string' ? cwd : undefined,
    })
  }

  // ---- optional monotonic backstop ----------------------------------------
  if (strictGuard === 'bypass-guard') {
    ctx.tools.guard(exec => {
      if (!isManual(exec)) return undefined
      const args = exec?.arguments
      if (args === null || typeof args !== 'object') return undefined
      if (!('sandbox_permissions' in args) && !('justification' in args)) return undefined
      return `[manual approval] ${exec.name} passes sandbox_permissions/justification, which manual mode does not use: the user decides every call directly. Retry the same call with both fields absent.`
    })
  }

  // ---- deliver the user's note into the tool result ------------------------
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept') return decision
    const key = callKey(exec?.agent, exec)
    if (key === undefined) return decision
    const denied = deniedCalls.has(key)
    if (pending.entries.size === 0) {
      if (denied) deniedCalls.delete(key)
      return decision
    }
    if (consumedFeedback.has(exec)) return decision

    // `tools/result` fires BEFORE this event, which is why the settlement
    // listener must not remove the entry: doing so discarded the user's typed
    // reason on a denied call before delivery could read it. The note is read
    // here and reclaimed only after this decision has been made.
    const text = pending.peekFeedback(key)
    pending.delete(key)
    if (denied) deniedCalls.delete(key)

    // A DENIED call is still manual even though the tool never ran and
    // `isManual` may now answer false; that this plugin denied it is the proof.
    if (!denied && result?.isError !== true && !isManual(exec)) return decision
    // The gate's denial reason already carries the verdict, so a denial without a
    // note has nothing left to add — appending it again caused the duplicate.
    if (text === undefined) return decision

    consumedFeedback.add(exec)
    const field = result?.isError === true ? 'rejection reason' : 'note'
    const sentence = feedbackSentence(text, exec?.name, field)
    // ONE delivery channel only.
    //
    // The sentence used to be appended to `content` AND injected as an
    // `additionalContext` message, so the model read the same text twice. It now
    // travels only inside the call's own result, which is where the user asked
    // for it ("appended to the tool result") and where it answers the call the
    // model actually made.
    const prior = [...(decision.content ?? result?.content ?? [])]

    // A DENIAL must state the user's reason INSTEAD of the provisional sentence.
    //
    // The gate writes `… left no rejection reason.` before it can know whether a
    // note is coming, because the note arrives over the private route and races
    // the outcome. On a denied call that sentence IS the tool's error line, so
    // appending the real reason produced a result that claimed both:
    //
    //   Error: [manual approval] The user reviewed `pwsh` and left no rejection reason.
    //   [manual approval] The user reviewed `pwsh` and added this rejection reason: …
    //
    // Replace the provisional line rather than stack a second verdict on top.
    // The sentence still comes from the ONE shared formatter, so an automatic
    // rejection stays indistinguishable from a hand-written one.
    if (result?.isError === true && denied && isProvisionalDenial(prior)) {
      return { ...decision, content: [{ type: 'text', text: `Error: ${sentence}` }] }
    }

    return {
      ...decision,
      content: [...prior, { type: 'text', text: sentence }],
    }
  })

  ctx.on('tools/result', exec => {
    const key = callKey(exec?.agent, exec)
    if (key === undefined) return
    // Only the approval grant is settled here. The pending entry is NOT removed:
    // `tools/result` runs BEFORE `tools/post-execute`, so deleting it here is what
    // silently discarded the user's typed reason on a denied call. Delivery reads
    // the value in post-execute, and the store's own TTL sweep reclaims entries
    // whose result never came back through that pipeline.
    approvedCalls.delete(key)
  })

  ctx.on('session/disposed', session => {
    const prefix = `${String(session?.id)}:`
    for (const key of approvedCalls) {
      if (key.startsWith(prefix)) approvedCalls.delete(key)
    }
  })

  // Logged at info level on every mount: whether the Host half actually took
  // effect is the first thing to check when the mode appears to be missing.
  try {
    ctx.logger?.info?.(`[manual-approval] mounted: preset "${presetName}", ${state.rules.length} rule(s), route ${feedbackPath}`)
  } catch {
    // A logger hiccup must not stop the mount.
  }

  // Exposed for the selftest and for a settings preview.
  return { snapshot, describe: () => state.rules.map(describeRule) }
}

const plugin = {
  name: 'manual-approval',
  /**
   * `webServer` IS a listed dependency. The browser carrier mounts after this
   * plugin in the composed tree, so the fiber must wait for it: with only
   * `ctx.get('webServer')` at apply time the service was absent and both the
   * route and the page tap were silently skipped.
   */
  inject: ['tools', 'approval', 'permissionPresets', 'webServer'],
  Config,
  apply,
}

export default plugin
