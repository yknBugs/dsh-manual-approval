/**
 * Rules-engine checks. Pure logic, no DSH profile required:
 *
 *   node scripts/selftest-rules.mjs
 */
import assert from 'node:assert/strict'
import {
  actionMessage,
  combinedJson,
  compileRule,
  compileRules,
  conditionTargets,
  countGroups,
  decideFromJudgeResponse,
  expandPlaceholders,
  firstMatch,
  judgeBody,
  parseHeaders,
  readJsonPath,
  warningText,
} from '../lib/rules.js'
import { emptyDocument, normalizeDocument, readDocument, writeDocument } from '../lib/store.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let checks = 0
const check = (name, fn) => {
  fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

/** Build a rule with sane defaults so each test states only what it exercises. */
const rule = (overrides = {}) => ({
  id: 'r1',
  name: 'test rule',
  enabled: true,
  conditions: [{ target: 'toolName', pattern: '^bash$' }],
  action: { kind: 'approve', message: '' },
  ...overrides,
})

const compile = raw => {
  const result = compileRule(raw, 0)
  assert.equal(result.ok, true, `expected a valid rule, got ${JSON.stringify(result.errors)}`)
  return result.rule
}

console.log('validation')

check('an invalid regex cannot be enabled and states why', () => {
  const result = compileRule(rule({ conditions: [{ target: 'toolName', pattern: '([' }] }), 0)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(line => line.includes('invalid regular expression')), JSON.stringify(result.errors))
})

check('an unknown match target is rejected', () => {
  const result = compileRule(rule({ conditions: [{ target: 'stdout', pattern: 'x' }] }), 0)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(line => line.includes('target must be one of')))
})

check('a rule with no conditions is rejected', () => {
  const result = compileRule(rule({ conditions: [] }), 0)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(line => line.includes('at least one condition')))
})

check('an unknown action is rejected', () => {
  const result = compileRule(rule({ action: { kind: 'explode' } }), 0)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(line => line.includes('action must be one of')))
})

check('a judge rule requires a URL', () => {
  const result = compileRule(rule({ action: { kind: 'judge', decisionPath: 'decision' } }), 0)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(line => line.includes('URL is required')))
})

check('a judge URL must be http(s)', () => {
  const result = compileRule(rule({ action: { kind: 'judge', url: 'file:///etc/passwd', decisionPath: 'd' } }), 0)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(line => line.includes('must start with http')))
})

check('a judge rule requires a decision path', () => {
  const result = compileRule(rule({ action: { kind: 'judge', url: 'http://127.0.0.1:1/x' } }), 0)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(line => line.includes('decision path is required')))
})

check('a bad header line is reported', () => {
  const result = compileRule(rule({ action: { kind: 'judge', url: 'http://x/y', decisionPath: 'd', headersText: 'no-colon-here' } }), 0)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(line => line.includes('Name: Value')))
})

check('every error is collected, not just the first', () => {
  const result = compileRule({ conditions: [{ target: 'bogus', pattern: '([' }], action: { kind: 'nope' } }, 2)
  assert.equal(result.ok, false)
  assert.ok(result.errors.length >= 3, JSON.stringify(result.errors))
})

check('an invalid rule is kept but inert in a compiled list', () => {
  const { rules } = compileRules([rule(), rule({ conditions: [{ target: 'toolName', pattern: '([' }] })], true)
  assert.equal(rules.length, 2)
  assert.equal(rules[0].invalid, undefined)
  assert.equal(rules[1].invalid, true)
  assert.equal(rules[1].enabled, false)
  assert.equal(firstMatch(rules, 'bash', {}, true).rule.index, 0)
})

console.log('group counting')

check('plain, non-capturing and lookaround groups are counted correctly', () => {
  assert.equal(countGroups('abc'), 0)
  assert.equal(countGroups('(a)'), 1)
  assert.equal(countGroups('(a)(b)'), 2)
  assert.equal(countGroups('(?:a)(b)'), 1)
  assert.equal(countGroups('(?=a)(b)'), 1)
  assert.equal(countGroups('(?<=a)(b)'), 1)
  assert.equal(countGroups('(?<name>a)'), 1)
  assert.equal(countGroups('\\((a)'), 1)
  assert.equal(countGroups('[(](a)'), 1)
  assert.equal(countGroups('(a(b(c)))'), 3)
})

check('group numbers are sequential across conditions', () => {
  const compiled = compile(rule({
    conditions: [
      { target: 'toolName', pattern: '(bash)' },
      { target: 'argValue', pattern: '(rm)\\s+(\\S+)' },
    ],
  }))
  assert.equal(compiled.groupCount, 3)
  assert.deepEqual(compiled.conditions.map(c => [c.firstGroup, c.lastGroup]), [[1, 1], [2, 3]])
})

console.log('matching')

check('toolName matches the whole name', () => {
  const compiled = compile(rule({ conditions: [{ target: 'toolName', pattern: '^pwsh$' }] }))
  assert.notEqual(firstMatch([compiled], 'pwsh', {}, true), undefined)
  assert.equal(firstMatch([compiled], 'pwshx', {}, true), undefined)
})

check('argName matches any parameter name', () => {
  const compiled = compile(rule({ conditions: [{ target: 'argName', pattern: '^(command|cmd)$' }] }))
  assert.notEqual(firstMatch([compiled], 'pwsh', { command: 'ls' }, true), undefined)
  assert.equal(firstMatch([compiled], 'pwsh', { pattern: 'ls' }, true), undefined)
})

check('argValue matches any parameter value', () => {
  const compiled = compile(rule({ conditions: [{ target: 'argValue', pattern: 'rm\\s+-rf' }] }))
  assert.notEqual(firstMatch([compiled], 'bash', { command: 'sudo rm -rf /tmp/x' }, true), undefined)
  assert.equal(firstMatch([compiled], 'bash', { command: 'ls -la' }, true), undefined)
})

check('conditions are combined with AND', () => {
  const compiled = compile(rule({
    conditions: [
      { target: 'toolName', pattern: '^pwsh$' },
      { target: 'argValue', pattern: 'Remove-Item' },
    ],
  }))
  assert.notEqual(firstMatch([compiled], 'pwsh', { command: 'Remove-Item -Recurse x' }, true), undefined)
  assert.equal(firstMatch([compiled], 'read', { command: 'Remove-Item -Recurse x' }, true), undefined)
  assert.equal(firstMatch([compiled], 'pwsh', { command: 'Get-Date' }, true), undefined)
})

check('a condition over an absent bag never matches', () => {
  const compiled = compile(rule({ conditions: [{ target: 'argName', pattern: '.' }] }))
  assert.equal(firstMatch([compiled], 'glob', undefined, true), undefined)
  assert.equal(firstMatch([compiled], 'glob', {}, true), undefined)
})

check('numbers and booleans match as their textual form', () => {
  const numbers = compile(rule({ conditions: [{ target: 'argValue', pattern: '^42$' }] }))
  assert.notEqual(firstMatch([numbers], 'read', { limit: 42 }, true), undefined)
  assert.equal(firstMatch([numbers], 'read', { limit: true }, true), undefined)
  const bools = compile(rule({ conditions: [{ target: 'argValue', pattern: '^true$' }] }))
  assert.notEqual(firstMatch([bools], 'read', { force: true }, true), undefined)
  assert.equal(firstMatch([bools], 'read', { force: false }, true), undefined)
})

check('an array value is matched against its JSON text', () => {
  const compiled = compile(rule({ conditions: [{ target: 'argValue', pattern: '"a"' }, { target: 'argName', pattern: '^list$' }] }))
  assert.notEqual(firstMatch([compiled], 'tool', { list: ['a', 'b'] }, true), undefined)
})

check('conditionTargets reports the candidate strings per target', () => {
  assert.deepEqual(conditionTargets('toolName', 'bash', { a: 1 }), ['bash'])
  assert.deepEqual(conditionTargets('argName', 'bash', { a: 1, b: 2 }), ['a', 'b'])
  assert.deepEqual(conditionTargets('argValue', 'bash', { a: 1, b: 'two' }), ['1', 'two'])
})

console.log('rule order and switches')

check('the first matching rule wins', () => {
  const deny = compile(rule({ id: 'deny', name: 'deny bash', action: { kind: 'deny', message: 'no' } }))
  const allow = compile(rule({ id: 'allow', name: 'allow all', conditions: [{ target: 'toolName', pattern: '.*' }], action: { kind: 'approve' } }))
  const hit = firstMatch([deny, allow], 'bash', {}, true)
  assert.equal(hit.rule.id, 'deny')
})

check('a catch-all allow first reproduces full-access behavior', () => {
  const allow = compile(rule({ conditions: [{ target: 'toolName', pattern: '.*' }], action: { kind: 'approve' } }))
  assert.notEqual(firstMatch([allow], 'anything', { x: 1 }, true), undefined)
})

check('the master switch disables every rule', () => {
  const allow = compile(rule({ conditions: [{ target: 'toolName', pattern: '.*' }], action: { kind: 'approve' } }))
  assert.equal(firstMatch([allow], 'bash', {}, false), undefined)
})

check('a disabled rule is skipped in favor of a later one', () => {
  const disabled = compile(rule({ id: 'off', enabled: false, conditions: [{ target: 'toolName', pattern: '.*' }], action: { kind: 'deny' } }))
  const allow = compile(rule({ id: 'on', conditions: [{ target: 'toolName', pattern: '.*' }], action: { kind: 'approve' } }))
  const hit = firstMatch([disabled, allow], 'bash', {}, true)
  assert.equal(hit.rule.id, 'on')
})

console.log('capture groups and substitution')

check('the combined document is one JSON object keyed by tool name', () => {
  assert.equal(combinedJson('bash', { command: 'ls' }), '{"bash":{"command":"ls"}}')
  assert.equal(combinedJson('glob', {}), '{"glob":{}}')
  assert.equal(combinedJson(undefined, undefined), '{"unknown":{}}')
})

check('a judge context adds cwd as a sibling field, and only when present', () => {
  // `cwd` is a JSON field of the DEFAULT body, never a `{cwd}` placeholder.
  assert.equal(
    combinedJson('bash', { command: 'ls' }, { cwd: 'D:\\work' }),
    '{"cwd":"D:\\\\work","bash":{"command":"ls"}}',
  )
  assert.equal(combinedJson('bash', { command: 'ls' }, {}), '{"bash":{"command":"ls"}}')
  assert.equal(combinedJson('bash', { command: 'ls' }, { cwd: '' }), '{"bash":{"command":"ls"}}')
  assert.equal(combinedJson('bash', { command: 'ls' }, undefined), '{"bash":{"command":"ls"}}')
})

check('captures come from the combined document in global order', () => {
  // Patterns written with `\\.` because the combined document is JSON: the dot
  // in `"command"` is a literal dot followed by the escaped quote.
  const compiled = compile(rule({
    conditions: [
      { target: 'toolName', pattern: '(bash)' },
      { target: 'argName', pattern: 'command' },
      { target: 'argValue', pattern: 'rm\\s+-rf\\s+([a-z/]+)' },
    ],
  }))
  const hit = firstMatch([compiled], 'bash', { command: 'rm -rf /tmp' }, true)
  assert.notEqual(hit, undefined)
  assert.equal(compiled.groupCount, 2)
  assert.deepEqual(hit.captures, ['bash', '/tmp'])
})

check('the tool name is capturable because it keys the combined document', () => {
  const compiled = compile(rule({ conditions: [{ target: 'toolName', pattern: '(bash)' }] }))
  const hit = firstMatch([compiled], 'bash', { a: 'x' }, true)
  assert.deepEqual(hit.captures, ['bash'])
})

check('a group the document cannot satisfy contributes an empty value', () => {
  // Condition 1 matches the call's tool name and also keys the document, so it
  // captures. Condition 2 matches a value, so it captures too.
  const compiled = compile(rule({
    conditions: [
      { target: 'toolName', pattern: '(bash)' },
      { target: 'argValue', pattern: '(x)' },
    ],
  }))
  const hit = firstMatch([compiled], 'bash', { a: 'x' }, true)
  assert.notEqual(hit, undefined)
  assert.equal(compiled.groupCount, 2)
  assert.deepEqual(hit.captures, ['bash', 'x'])
})

check('an unmatched optional group inside a match becomes empty', () => {
  const compiled = compile(rule({
    conditions: [
      { target: 'toolName', pattern: '(bash)' },
      { target: 'argValue', pattern: '(x)(y)?' },
    ],
  }))
  const hit = firstMatch([compiled], 'bash', { a: 'x' }, true)
  assert.notEqual(hit, undefined)
  assert.equal(compiled.groupCount, 3)
  assert.deepEqual(hit.captures, ['bash', 'x', ''])
})

check('captures use only the first match of each pattern', () => {
  const compiled = compile(rule({
    conditions: [
      { target: 'toolName', pattern: '(bash)' },
      { target: 'argValue', pattern: '(a)+' },
    ],
  }))
  const hit = firstMatch([compiled], 'bash', { x: 'aaa' }, true)
  assert.notEqual(hit, undefined)
  // `(a)+` captures the LAST repetition in JS regex semantics.
  assert.deepEqual(hit.captures, ['bash', 'a'])
})

check('$1 and ${1} both substitute', () => {
  assert.equal(expandPlaceholders('saw $1', ['a']), 'saw a')
  assert.equal(expandPlaceholders('saw ${1}', ['a']), 'saw a')
  assert.equal(expandPlaceholders('$1 and $2', ['a', 'b']), 'a and b')
  assert.equal(expandPlaceholders('${12}', new Array(12).fill('x').map((_, i) => String(i + 1))), '12')
})

check('$12 means group 12, and ${1}2 means group 1 then a literal 2', () => {
  assert.equal(expandPlaceholders('$12', ['a']), '')
  const groups = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
  assert.equal(expandPlaceholders('$12', groups), 'twelve')
  assert.equal(expandPlaceholders('${1}2', groups), 'one2')
})

check('$$ is a literal dollar sign', () => {
  assert.equal(expandPlaceholders('cost is $$5', []), 'cost is $5')
})

check('a missing group becomes empty instead of the literal text', () => {
  assert.equal(expandPlaceholders('[$3]', ['a']), '[]')
  // `$0` is the whole match, which is deliberately not addressable.
  assert.equal(expandPlaceholders('[$0]', ['a']), '[]')
})

check('an unterminated brace is left alone', () => {
  assert.equal(expandPlaceholders('$ {1}', []), '$ {1}')
  assert.equal(expandPlaceholders('a $', []), 'a $')
})

check('actionMessage expands, warningText falls back to the rule name', () => {
  const withMessage = compile(rule({ action: { kind: 'deny', message: 'Remove of $1 denied' } }))
  assert.equal(actionMessage(withMessage, ['/tmp/x']), 'Remove of /tmp/x denied')

  const withoutMessage = compile(rule({ name: 'danger: recursion', action: { kind: 'warn', message: '' } }))
  assert.equal(warningText(withoutMessage, []), 'The parameters matched rule "danger: recursion".')

  const withContent = compile(rule({ action: { kind: 'warn', message: 'Warning: this may delete files' } }))
  assert.equal(warningText(withContent, []), 'Warning: this may delete files')
})

console.log('json paths')

check('dotted and indexed paths resolve', () => {
  const value = { decision: 'deny', data: { items: [{ verdict: 'approve' }] } }
  assert.equal(readJsonPath(value, 'decision'), 'deny')
  assert.equal(readJsonPath(value, 'data.items[0].verdict'), 'approve')
  assert.equal(readJsonPath(value, 'data.items.0.verdict'), 'approve')
  assert.equal(readJsonPath(value, 'missing'), undefined)
  assert.equal(readJsonPath(value, ''), undefined)
})

console.log('judge responses')

const judgeRule = compile(rule({
  name: 'remote judge',
  action: { kind: 'judge', url: 'http://127.0.0.1:9/judge', decisionPath: 'result.decision', reasonPath: 'result.why' },
}))

check('approve and deny map to their branches', () => {
  const approve = decideFromJudgeResponse(judgeRule, JSON.stringify({ result: { decision: 'approve', why: 'ok' } }), [])
  assert.equal(approve.kind, 'approve')
  assert.equal(approve.message, 'ok')
  const deny = decideFromJudgeResponse(judgeRule, JSON.stringify({ result: { decision: 'deny', why: 'no' } }), [])
  assert.equal(deny.kind, 'deny')
  assert.equal(deny.message, 'no')
})

check('ask maps to the warning branch', () => {
  const ask = decideFromJudgeResponse(judgeRule, JSON.stringify({ result: { decision: 'ask', why: 'be careful' } }), [])
  assert.equal(ask.kind, 'warn')
  assert.equal(ask.warning, 'be careful')
})

check('ask with no reason falls back to the rule name', () => {
  const ask = decideFromJudgeResponse(judgeRule, JSON.stringify({ result: { decision: 'ask' } }), [])
  assert.equal(ask.kind, 'warn')
  assert.ok(ask.warning.includes('remote judge'))
})

check('every failure mode falls back to a red warning, never to allow or block', () => {
  const cases = [
    ['not json at all', 'not JSON'],
    [JSON.stringify({ result: {} }), 'no value at decision path'],
    [JSON.stringify({ result: { decision: 'maybe' } }), 'expected one of'],
    [JSON.stringify({ result: { decision: 'deny', why: 42 } }), 'is not a string'],
  ]
  for (const [body, expected] of cases) {
    const verdict = decideFromJudgeResponse(judgeRule, body, [])
    assert.equal(verdict.kind, 'warn', `body ${body} produced ${verdict.kind}`)
    assert.equal(verdict.failed, true)
    assert.ok(verdict.warning.includes(expected), `${verdict.warning} should mention "${expected}"`)
  }
})

check('the reason path is unaffected by capture substitution', () => {
  const verdict = decideFromJudgeResponse(judgeRule, JSON.stringify({ result: { decision: 'deny', why: 'literal $1 stays' } }), ['captured'])
  assert.equal(verdict.message, 'literal $1 stays')
})

check('the default judge body is the combined document', () => {
  assert.equal(judgeBody(judgeRule, 'bash', { command: 'ls' }, []), '{"bash":{"command":"ls"}}')
})

check('the default judge body carries cwd when the session provides one', () => {
  assert.equal(
    judgeBody(judgeRule, 'bash', { command: 'ls' }, [], { cwd: 'D:\\work' }),
    '{"cwd":"D:\\\\work","bash":{"command":"ls"}}',
  )
})

check('a user-written judge body is sent as written, with no cwd injected', () => {
  const custom = compile(rule({ action: { kind: 'judge', url: 'http://x/y', decisionPath: 'd', body: '{"cmd":"$1"}' } }))
  assert.equal(judgeBody(custom, 'bash', { command: 'ls' }, ['ls'], { cwd: 'D:\\work' }), '{"cmd":"ls"}')
})

check('a judge body override is expanded with captures', () => {
  const custom = compile(rule({ action: { kind: 'judge', url: 'http://x/y', decisionPath: 'd', body: '{"cmd":"$1"}' } }))
  assert.equal(judgeBody(custom, 'bash', { command: 'ls' }, ['ls']), '{"cmd":"ls"}')
})

console.log('headers')

check('headers parse one per line', () => {
  const { headers, error } = parseHeaders('Authorization: Bearer x\nX-Trace: 1')
  assert.equal(error, undefined)
  assert.deepEqual(headers, { Authorization: 'Bearer x', 'X-Trace': '1' })
})

check('blank header text means no headers', () => {
  assert.deepEqual(parseHeaders('').headers, {})
  assert.deepEqual(parseHeaders('   \n  ').headers, {})
})

console.log('store')

check('a missing file loads the empty document', () => {
  const result = readDocument(join(tmpdir(), 'dsh-manual-approval-does-not-exist.json'))
  assert.equal(result.existed, false)
  assert.deepEqual(result.document, emptyDocument())
})

check('a round trip preserves the raw rule text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshma-'))
  try {
    const file = join(dir, 'rules.json')
    const document = { version: 1, masterEnabled: false, rules: [{ id: 'a', name: 'A', enabled: true, conditions: [{ target: 'toolName', pattern: '([' }], action: { kind: 'approve' } }] }
    writeDocument(document, file)
    const back = readDocument(file)
    assert.equal(back.document.masterEnabled, false)
    assert.equal(back.document.rules[0].conditions[0].pattern, '([')
    assert.ok(readFileSync(file, 'utf8').endsWith('\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('a damaged file reports an error and loads nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshma-'))
  try {
    const file = join(dir, 'rules.json')
    writeFileSync(file, '{ not json', 'utf8')
    const result = readDocument(file)
    assert.equal(result.existed, true)
    assert.ok(result.error.includes('not valid JSON'))
    assert.deepEqual(result.document.rules, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('a non-object document normalizes to the empty one', () => {
  assert.deepEqual(normalizeDocument(null), emptyDocument())
  assert.deepEqual(normalizeDocument([1, 2]), emptyDocument())
  assert.deepEqual(normalizeDocument({ rules: 'nope' }).rules, [])
})

console.log(`\n${checks} checks passed`)
