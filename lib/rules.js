/**
 * The automatic-approval rule engine — pure, dependency-free, and the single
 * place a rule is compiled, matched, or turned into a message.
 *
 * ## Matching model
 *
 * A rule is a list of conditions combined with logical AND. Each condition
 * matches ONE target, chosen by its `target` field:
 *
 *   - `toolName`  — the regex runs against the whole tool name.
 *   - `argName`   — the regex runs against each argument name in turn; the
 *                   condition holds when ANY name matches.
 *   - `argValue`  — the regex runs against each argument value in turn; the
 *                   condition holds when ANY value matches.
 *
 * Conditions therefore never have to escape JSON: `file_path` matches a
 * parameter name, `C:\\Users` matches a path value.
 *
 * ## Capture groups
 *
 * A rule's capture groups are numbered GLOBALLY and SEQUENTIALLY across its
 * conditions, in condition order and left-to-right within each pattern; group 0
 * is never addressable. Values are extracted in a SECOND step from one combined
 * JSON document, because a captured parameter may come from any part of the
 * call:
 *
 *   `{"<toolName>":{"<argName>":"<argValue>", ...}}`
 *
 * A group whose pattern did not match contributes an empty string. Reasons and
 * warnings substitute `$1`..`$9` and `${N}`.
 */

/** Match targets, in the order the settings dropdown presents them. */
export const TARGETS = ['toolName', 'argName', 'argValue']

/** Action kinds. `judge` asks a remote endpoint; the other three are local. */
export const ACTIONS = ['approve', 'deny', 'warn', 'judge']

/** Decision vocabulary of a judge response. */
export const JUDGE_DECISIONS = ['approve', 'deny', 'ask']

/** Default body template shown in the settings editor. */
export const DEFAULT_JUDGE_BODY = '{"toolName":{...}}'

/** Per-argument-value cap when building the combined JSON document. */
const MAX_VALUE_CHARS = 20000
/** Cap on a single match target string. */
const MAX_TARGET_CHARS = 200000

// ---------------------------------------------------------------------------
// Combined document + capture-group addressing
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON for one call.
 *
 * Without context this is exactly `{"<tool>":{...}}`. When the judge supplies
 * the session's working directory it is added as a SIBLING field of the tool
 * entry:
 *
 *   `{"cwd":"<absolute path>","<tool>":{...}}`
 *
 * It is deliberately NOT a `{cwd}` placeholder: only the DEFAULT body carries
 * it, so a body the user wrote is sent exactly as written.
 */
export function combinedJson(toolName, args, context) {
  const tool = typeof toolName === 'string' && toolName !== '' ? toolName : 'unknown'
  const bag = {}
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    for (const key of Object.keys(args)) bag[key] = args[key]
  }
  const payload = { [tool]: bag }
  const cwd = context?.cwd
  if (typeof cwd === 'string' && cwd !== '') {
    // `cwd` first, so a human reading the body sees the context before the call.
    return stringify({ cwd, ...payload })
  }
  return stringify(payload)
}

function stringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return '{}'
  }
}

/**
 * Flatten a regex match into capture-group values.
 * Group 0 (the whole match) is intentionally dropped — `$0` is not addressable,
 * so `$1` is always the first parenthesis pair in the rule.
 */
function groupValues(match) {
  const values = []
  for (let index = 1; index < match.length; index += 1) {
    const value = match[index]
    values.push(value === undefined ? '' : String(value))
  }
  return values
}

/**
 * Substitution map for the standard replacement syntax.
 * `groups` is indexed by the GLOBAL group number starting at 1.
 */
export function substitutionMap(groups) {
  return {
    lookup(index) {
      if (!Number.isInteger(index) || index < 1) return ''
      return index - 1 < groups.length ? groups[index - 1] : ''
    },
  }
}

/**
 * Expand `$1`..`$9` and `${N}` in a message template.
 *
 * - `$$` yields a literal `$`.
 * - `$12` means group 12; `$1` followed by a literal digit needs `${1}2`.
 * - A reference with no captured value becomes an empty string.
 */
export function expandPlaceholders(template, groups) {
  if (typeof template !== 'string' || template === '') return ''
  const lookup = substitutionMap(groups).lookup
  let out = ''
  for (let index = 0; index < template.length; index += 1) {
    const char = template.charAt(index)
    if (char !== '$') {
      out += char
      continue
    }
    const next = template.charAt(index + 1)
    if (next === '$') {
      out += '$'
      index += 1
      continue
    }
    if (next === '{') {
      const close = template.indexOf('}', index + 2)
      if (close === -1) {
        out += char
        continue
      }
      const body = template.slice(index + 2, close)
      if (/^\d+$/.test(body)) {
        out += lookup(Number(body))
        index = close
        continue
      }
      out += char
      continue
    }
    if (/[0-9]/.test(next)) {
      let end = index + 1
      while (end < template.length && /[0-9]/.test(template.charAt(end))) end += 1
      out += lookup(Number(template.slice(index + 1, end)))
      index = end - 1
      continue
    }
    out += char
  }
  return out
}

/** Count the parenthesis groups in a pattern, ignoring escapes and classes. */
export function countGroups(pattern) {
  if (typeof pattern !== 'string') return 0
  let count = 0
  let inClass = false
  let escaped = false
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index)
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (inClass) {
      if (char === ']') inClass = false
      continue
    }
    if (char === '[') {
      inClass = true
      continue
    }
    if (char !== '(') continue
    // `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>` — only `(?<name>` captures.
    const ahead = pattern.slice(index + 1, index + 4)
    if (ahead.startsWith('?:') || ahead.startsWith('?=') || ahead.startsWith('?!')) continue
    if (ahead.startsWith('?<=') || ahead.startsWith('?<!')) continue
    count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// Compilation and validation
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asText(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Compile one rule. Never throws: syntax errors are returned so the settings
 * editor can show exactly why a rule cannot be enabled.
 *
 * @returns `{ ok: true, rule }` or `{ ok: false, errors }`
 */
export function compileRule(raw, index = 0) {
  const errors = []
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [`rule ${index + 1} is not an object`] }
  }

  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `rule-${index + 1}`
  const name = asText(raw.name).trim()
  const enabled = raw.enabled !== false

  if (!Array.isArray(raw.conditions) || raw.conditions.length === 0) {
    errors.push('at least one condition is required')
  }

  const conditions = []
  let groupCursor = 1
  const rawConditions = Array.isArray(raw.conditions) ? raw.conditions : []
  rawConditions.forEach((condition, conditionIndex) => {
    const label = `condition ${conditionIndex + 1}`
    if (!isPlainObject(condition)) {
      errors.push(`${label} is not an object`)
      return
    }
    const target = asText(condition.target)
    if (!TARGETS.includes(target)) {
      errors.push(`${label}: target must be one of ${TARGETS.join(', ')}`)
    }
    const pattern = asText(condition.pattern)
    if (pattern === '') {
      errors.push(`${label}: a pattern is required`)
      return
    }
    let regex = null
    try {
      regex = new RegExp(pattern, typeof condition.flags === 'string' ? condition.flags : '')
    } catch (error) {
      errors.push(`${label}: invalid regular expression — ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const groups = countGroups(pattern)
    const first = groupCursor
    const last = groups === 0 ? 0 : groupCursor + groups - 1
    groupCursor += groups
    conditions.push({ target, pattern, regex, groups, firstGroup: first, lastGroup: last })
  })

  const action = isPlainObject(raw.action) ? raw.action : {}
  const kind = asText(action.kind)
  if (!ACTIONS.includes(kind)) {
    errors.push(`action must be one of ${ACTIONS.join(', ')}`)
  }

  const compiledAction = { kind, message: asText(action.message) }
  if (kind === 'judge') {
    const url = asText(action.url).trim()
    if (url === '') {
      errors.push('judge: a URL is required')
    } else if (!/^https?:\/\//i.test(url)) {
      errors.push('judge: the URL must start with http:// or https://')
    }
    compiledAction.url = url
    compiledAction.method = asText(action.method).trim().toUpperCase() || 'POST'
    if (!/^[A-Z]+$/.test(compiledAction.method)) {
      errors.push('judge: the method must be letters only')
    }
    compiledAction.headersText = asText(action.headersText)
    const headerCheck = parseHeaders(compiledAction.headersText)
    if (headerCheck.error !== undefined) errors.push(`judge: ${headerCheck.error}`)
    compiledAction.body = asText(action.body)
    compiledAction.decisionPath = asText(action.decisionPath).trim()
    if (compiledAction.decisionPath === '') {
      errors.push('judge: the response decision path is required')
    }
    compiledAction.reasonPath = asText(action.reasonPath).trim()
    const timeout = Number(action.timeoutMs)
    compiledAction.timeoutMs = Number.isFinite(timeout) && timeout >= 100 && timeout <= 120000 ? timeout : 10000
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    rule: {
      id,
      name: name === '' ? `Rule ${index + 1}` : name,
      enabled,
      conditions,
      groupCount: groupCursor - 1,
      action: compiledAction,
      source: raw,
    },
  }
}

/**
 * Compile a whole list. `killSwitch` mirrors the master switch the settings page
 * owns: while it is off, every rule is inert regardless of its own enable flag.
 *
 * @returns `{ rules, enabled, errors }` where `errors` is keyed by rule index.
 */
export function compileRules(rawList, killSwitch = true) {
  const list = Array.isArray(rawList) ? rawList : []
  const rules = []
  const errorsByIndex = {}
  list.forEach((raw, index) => {
    const result = compileRule(raw, index)
    if (result.ok) {
      rules.push({ ...result.rule, index })
      return
    }
    errorsByIndex[index] = result.errors
    rules.push({
      index,
      id: isPlainObject(raw) && typeof raw.id === 'string' && raw.id !== '' ? raw.id : `rule-${index + 1}`,
      name: isPlainObject(raw) && typeof raw.name === 'string' && raw.name.trim() !== ''
        ? raw.name.trim()
        : `Rule ${index + 1}`,
      enabled: false,
      conditions: [],
      groupCount: 0,
      action: { kind: isPlainObject(raw?.action) ? asText(raw.action.kind) : '' },
      source: isPlainObject(raw) ? raw : {},
      invalid: true,
      errors: errorsByIndex[index],
    })
  })
  return { rules, enabled: killSwitch !== false, errors: errorsByIndex }
}

/** Which rules the settings page may enable: valid, and non-empty pattern set. */
export function validatable(raw) {
  return compileRule(raw, 0).ok
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/** Parse a `Name: Value` per line header block. */
export function parseHeaders(text) {
  const headers = {}
  if (typeof text !== 'string' || text.trim() === '') return { headers }
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    const at = line.indexOf(':')
    if (at <= 0) return { headers: {}, error: `header line ${index + 1} is not "Name: Value"` }
    const name = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (name === '') return { headers: {}, error: `header line ${index + 1} has an empty name` }
    if (/[^A-Za-z0-9!#$%&'*+.^_`|~-]/.test(name)) {
      return { headers: {}, error: `header line ${index + 1} has an invalid name "${name}"` }
    }
    headers[name] = value
  }
  return { headers }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function valueText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function clamped(text) {
  return text.length > MAX_TARGET_CHARS ? text.slice(0, MAX_TARGET_CHARS) : text
}

/** The candidate strings one condition tests, given a call. */
export function conditionTargets(target, toolName, args) {
  if (target === 'toolName') {
    return typeof toolName === 'string' ? [clamped(toolName)] : []
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return []
  const keys = Object.keys(args)
  if (target === 'argName') return keys.map(clamped)
  return keys.map(key => clamped(valueText(args[key]).slice(0, MAX_VALUE_CHARS)))
}

/**
 * Evaluate one compiled rule against a call.
 *
 * @returns `undefined` when the rule does not apply, else
 *          `{ captures: string[] }` with globally ordered group values.
 */
export function matchRule(rule, toolName, args) {
  if (rule === undefined || rule.invalid === true) return undefined
  for (const condition of rule.conditions) {
    const candidates = conditionTargets(condition.target, toolName, args)
    let matched = false
    for (const candidate of candidates) {
      condition.regex.lastIndex = 0
      if (condition.regex.exec(candidate) === null) continue
      matched = true
      break
    }
    if (!matched) return undefined
  }
  // Capture values are extracted from the combined document, in global order,
  // so a group may name a parameter outside the text its own condition matched.
  const document = combinedJson(toolName, args)
  return { captures: extractFromDocument(rule, document) }
}

/**
 * Re-run each condition against the combined JSON document and collect group
 * values in global order. This is the pass the settings page describes when it
 * says a capture may come from any argument of the call.
 */
function extractFromDocument(rule, document) {
  const values = []
  for (const condition of rule.conditions) {
    if (condition.groups === 0) continue
    condition.regex.lastIndex = 0
    const result = condition.regex.exec(document)
    if (result === null) {
      for (let pad = 0; pad < condition.groups; pad += 1) values.push('')
      continue
    }
    for (const value of groupValues(result)) values.push(value)
  }
  // Pad so the array length always equals the rule's declared group count.
  while (values.length < rule.groupCount) values.push('')
  return values.slice(0, rule.groupCount)
}

/**
 * First matching, ENABLED rule wins. Order is the settings page's order, which
 * is why that page offers reordering: a catch-all `.*` rule placed first turns
 * Manual into Full access.
 */
export function firstMatch(rules, toolName, args, masterEnabled = true) {
  if (masterEnabled === false) return undefined
  for (const rule of rules) {
    if (rule.enabled !== true || rule.invalid === true) continue
    const match = matchRule(rule, toolName, args)
    if (match === undefined) continue
    return { rule, captures: match.captures }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Messages and decisions
// ---------------------------------------------------------------------------

/** The red warning shown in the approval card for a `warn` action. */
export function warningText(rule, groups) {
  const content = expandPlaceholders(rule.action.message, groups).trim()
  if (content !== '') return content
  return `The parameters matched rule "${rule.name}".`
}

/** The reason text a local `approve` or `deny` action produces. */
export function actionMessage(rule, groups) {
  return expandPlaceholders(rule.action.message, groups).trim()
}

/**
 * Read a dot/bracket path out of parsed JSON.
 * `a.b`, `a[0].b` and `["a","b"]`-free plain keys are all supported.
 */
export function readJsonPath(value, path) {
  if (typeof path !== 'string' || path.trim() === '') return undefined
  const parts = []
  for (const segment of path.split('.')) {
    const text = segment.trim()
    if (text === '') continue
    const nameMatch = /^([^[\]]*)((?:\[\d+\])*)$/.exec(text)
    if (nameMatch === null) return undefined
    if (nameMatch[1] !== '') parts.push(nameMatch[1])
    for (const indexMatch of nameMatch[2].matchAll(/\[(\d+)\]/g)) parts.push(Number(indexMatch[1]))
  }
  if (parts.length === 0) return undefined
  let cursor = value
  for (const part of parts) {
    if (cursor === null || cursor === undefined) return undefined
    if (typeof part === 'number') {
      if (!Array.isArray(cursor)) return undefined
      cursor = cursor[part]
      continue
    }
    if (typeof cursor !== 'object') return undefined
    cursor = cursor[part]
  }
  return cursor
}

/**
 * Decide the outcome of a judge response body.
 *
 * Every failure mode returns a `warn` decision carrying the reason in red, which
 * is the documented fallback: the call is still shown to the user, with the
 * concrete error visible, rather than silently allowed or blocked.
 */
export function decideFromJudgeResponse(rule, bodyText, groups) {
  const fallback = detail => ({
    kind: 'warn',
    warning: `Network judge failed for rule "${rule.name}": ${detail}`,
    failed: true,
  })
  let parsed
  try {
    parsed = JSON.parse(bodyText)
  } catch (error) {
    return fallback(`the response body is not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  const decision = readJsonPath(parsed, rule.action.decisionPath)
  if (decision === undefined || decision === null) {
    return fallback(`no value at decision path "${rule.action.decisionPath}"`)
  }
  if (!JUDGE_DECISIONS.includes(String(decision))) {
    return fallback(`decision path "${rule.action.decisionPath}" is "${String(decision)}", expected one of ${JUDGE_DECISIONS.join(', ')}`)
  }
  const rawReason = rule.action.reasonPath === '' ? undefined : readJsonPath(parsed, rule.action.reasonPath)
  if (rawReason !== undefined && rawReason !== null && typeof rawReason !== 'string') {
    return fallback(`reason path "${rule.action.reasonPath}" is not a string`)
  }
  const reason = typeof rawReason === 'string' ? rawReason : ''
  if (String(decision) === 'approve') return { kind: 'approve', message: reason, rule }
  if (String(decision) === 'deny') return { kind: 'deny', message: reason, rule }
  return { kind: 'warn', warning: reason.trim() === '' ? warningText(rule, groups) : reason, rule }
}

/** Build the judge request body, honouring the user's override. */
/**
 * Build the judge request body.
 *
 * A body the user wrote is expanded (`$1`…`$9`, `${N}`) and sent as written. Only
 * the DEFAULT body carries the session context, so an existing judge service
 * never has its agreed payload changed underneath it.
 */
export function judgeBody(rule, toolName, args, groups, context) {
  const override = typeof rule.action.body === 'string' ? rule.action.body.trim() : ''
  if (override !== '' && override !== DEFAULT_JUDGE_BODY) {
    return expandPlaceholders(override, groups)
  }
  return combinedJson(toolName, args, context)
}

/** Validate one judge response body without a network call (settings preview). */
export function validateJudgeResponse(rule, bodyText) {
  return decideFromJudgeResponse(rule, bodyText, [])
}

/** Human-readable summary of a rule, used in settings and diagnostics. */
export function describeRule(rule) {
  if (rule.invalid === true) return `${rule.name} (invalid)`
  const conditions = rule.conditions
    .map(condition => `${condition.target} ≈ /${condition.pattern}/`)
    .join(' AND ')
  return `${rule.name}: ${conditions} → ${rule.action.kind}`
}
