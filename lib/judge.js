/**
 * The network-judge transport.
 *
 * This deliberately runs in the HOST process rather than the browser:
 *
 * - Node has no same-origin policy, so a judge on `127.0.0.1`, a plain-`http`
 *   intranet service, or an endpoint without permissive CORS headers is all
 *   reachable. A browser `fetch` would fail on CORS and mixed content.
 * - The URL and the request headers never reach the browser, so the Harness is
 *   never turned into an open proxy that a page could point anywhere.
 *
 * Every failure produces a `warn` decision carrying the concrete error, so a
 * judge can only ever ASK. It never fails open.
 */

import { decideFromJudgeResponse, judgeBody, parseHeaders, warningText } from './rules.js'

/** Cap on a judge response body. */
export const MAX_JUDGE_BYTES = 1024 * 1024

/**
 * A judge URL for messages and logs with any embedded credentials removed.
 * `http://user:pass@host/` is a legitimate thing to write, and that password
 * must not surface in an approval warning, a tool result, or a log line.
 */
export function redactUrl(url) {
  const text = typeof url === 'string' ? url : ''
  try {
    const parsed = new URL(text)
    if (parsed.username === '' && parsed.password === '') return text
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return text.replace(/\/\/[^/@\s]*@/, '//')
  }
}

/**
 * One signal aborting on either the rule's timeout or the caller's
 * cancellation. Every capability is feature-checked, because a missing
 * `AbortSignal.any` must degrade to a plain timeout instead of throwing and
 * breaking the rule.
 */
export function combineSignals(timeoutMs, callerSignal) {
  const hasAny = typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function'
  const hasTimeout = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
  const timeout = hasTimeout ? AbortSignal.timeout(timeoutMs) : undefined
  if (callerSignal === undefined || callerSignal === null) return timeout
  if (timeout === undefined) return callerSignal
  if (hasAny) return AbortSignal.any([callerSignal, timeout])
  // Without `any`, honour the caller: cancellation matters more than the rule's
  // own deadline.
  return callerSignal
}

/** Read a response body, refusing to buffer an unbounded one. */
export async function readCappedText(response, cap = MAX_JUDGE_BYTES) {
  const declared = Number(response?.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > cap) {
    throw new Error(`response is ${declared} bytes, over the ${cap} byte limit`)
  }
  const text = await response.text()
  if (text.length > cap) throw new Error(`response is over the ${cap} byte limit`)
  return text
}

function oneLine(value, cap) {
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length <= cap ? text : `${text.slice(0, cap)}…`
}

/** A failure verdict: a red warning carrying the concrete reason. */
function failure(rule, safeUrl, detail) {
  return {
    kind: 'warn',
    warning: `Network judge failed for rule "${rule.name}" (${safeUrl}): ${redactDetail(detail, safeUrl)}`,
    failed: true,
  }
}

/**
 * Strip `user:password@` from a message that may embed the request URL.
 *
 * Runtime errors quote the request, and Node's `fetch` even rejects a URL
 * carrying credentials with a message reproducing it verbatim — so sanitizing
 * the URL we build ourselves is not enough. Every `//…@host` credential form is
 * removed, because this text is shown in the approval card.
 */
export function redactDetail(detail) {
  const text = typeof detail === 'string' ? detail : String(detail)
  return text.replace(/(\/\/)[^/@\s]*@/g, '$1')
}

/**
 * Run one judge rule.
 *
 * @param rule - a compiled rule whose action is `judge`.
 * @param context - session facts for the DEFAULT body only (`{ cwd }`).
 * @param fetchImpl - the `fetch` to use, injected so tests need no global stub.
 * @returns `{ kind: 'approve' | 'deny' | 'warn', message?, warning?, failed? }`
 */
export async function runJudge(rule, toolName, args, captures, signal, fetchImpl = globalThis.fetch, log, context) {
  const safeUrl = redactUrl(rule.action.url)
  const say = typeof log === 'function' ? log : () => {}

  if (typeof fetchImpl !== 'function') {
    return failure(rule, safeUrl, 'this runtime provides no fetch implementation')
  }

  const body = judgeBody(rule, toolName, args, captures, context)
  let response
  try {
    const method = rule.action.method || 'POST'
    const requestHeaders = { ...parseHeaders(rule.action.headersText).headers }
    const hasBody = method !== 'GET' && method !== 'HEAD'
    if (hasBody && requestHeaders['content-type'] === undefined && requestHeaders['Content-Type'] === undefined) {
      requestHeaders['content-type'] = 'application/json'
    }
    response = await fetchImpl(rule.action.url, {
      method,
      headers: requestHeaders,
      ...(hasBody ? { body } : {}),
      signal: combineSignals(rule.action.timeoutMs, signal),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const safeDetail = redactDetail(detail)
    say(`judge "${rule.name}" request to ${safeUrl} failed: ${safeDetail}`)
    return failure(rule, safeUrl, safeDetail)
  }

  let text = ''
  try {
    text = await readCappedText(response)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return failure(rule, safeUrl, `could not read the response (${detail})`)
  }

  if (response.ok !== true) {
    return failure(rule, safeUrl, `HTTP ${response.status}${text.trim() === '' ? '' : ` — ${oneLine(text, 300)}`}`)
  }

  const decision = decideFromJudgeResponse(rule, text, captures)
  if (decision.kind === 'warn' && decision.failed !== true) {
    // An explicit `ask` verdict: keep its warning text, mark it as deliberate.
    return { kind: 'warn', warning: decision.warning === '' ? warningText(rule, captures) : decision.warning, rule }
  }
  say(`judge "${rule.name}" -> ${decision.kind}`)
  return decision
}
