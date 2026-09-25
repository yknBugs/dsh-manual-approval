/**
 * Pure-logic checks for the Host half. Run with:
 *
 *   node --import ./scripts/register-stub.mjs scripts/selftest.mjs
 *
 * `scripts/register-stub.mjs` maps `@deepseek-ai/dsh-llm` to a local stub so the
 * module can be imported outside an installed profile.
 */
import assert from 'node:assert/strict'
import {
  buildApprovalReason,
  buildParameterRows,
  callKey,
  feedbackSentence,
  formatParameterLines,
  manualAuthority,
  MANUAL_PRESET,
  PendingStore,
  REASON_PREFIX,
  rejectionResult,
} from '../lib/index.js'

let checks = 0
const check = (name, fn) => {
  fn()
  checks += 1
  console.log(`  ok  ${name}`)
}

console.log('parameter rendering')

check('one line per argument, in insertion order', () => {
  const rows = formatParameterLines({ pattern: 'TODO', path: 'src', include: '*.ts' })
  assert.deepEqual(rows, ['pattern: TODO', 'path: src', 'include: *.ts'])
})

check('empty and missing arguments still render a row', () => {
  assert.deepEqual(formatParameterLines({}), ['(no arguments)'])
  assert.deepEqual(formatParameterLines(null), ['(no arguments)'])
  assert.deepEqual(formatParameterLines(undefined), ['(no arguments)'])
})

check('scalar arguments render as a value row', () => {
  assert.deepEqual(formatParameterLines('raw'), ['value: raw'])
})

check('newlines in a value are flattened so each argument stays one line', () => {
  const rows = formatParameterLines({ command: 'line one\nline two' })
  assert.deepEqual(rows, ['command: line one line two'])
})

check('long values are capped', () => {
  const rows = formatParameterLines({ blob: 'x'.repeat(1000) })
  assert.equal(rows.length, 1)
  assert.ok(rows[0].length < 400, `expected a capped row, got ${rows[0].length} chars`)
  assert.ok(rows[0].endsWith('…'))
})

check('nested objects survive as JSON on one line', () => {
  const rows = formatParameterLines({ options: { a: 1, b: [2, 3] } })
  assert.deepEqual(rows, ['options: {"a":1,"b":[2,3]}'])
})

check('row count is bounded by the block cap', () => {
  const many = {}
  for (let index = 0; index < 400; index += 1) many[`k${index}`] = 'v'.repeat(200)
  const rows = buildParameterRows(many)
  assert.ok(rows.length < 400, 'expected truncation')
  assert.ok(rows[rows.length - 1].startsWith('…('), `expected a truncation marker, got ${rows[rows.length - 1]}`)
})

console.log('approval headline')

check('headline carries the marker, the tool name and the ref key', () => {
  const reason = buildApprovalReason('bash', 'List files', 'sess-1:call-9')
  assert.ok(reason.startsWith(REASON_PREFIX))
  assert.ok(reason.includes('bash'))
  assert.ok(reason.includes('List files'))
  assert.ok(reason.endsWith('(ref sess-1:call-9)'))
})

check('the ref is parseable by the client regex', () => {
  const reason = buildApprovalReason('grep', undefined, 'session-abc:call_12')
  const match = /\(ref\s+([^)]+)\)\s*$/.exec(reason)
  assert.notEqual(match, null)
  assert.equal(match[1], 'session-abc:call_12')
})

check('no ref is appended when the call has no id', () => {
  const reason = buildApprovalReason('read', undefined, undefined)
  assert.equal(/\(ref/.test(reason), false)
  assert.equal(reason, `${REASON_PREFIX} Confirm tool call: read`)
})

check('the model description is included when present', () => {
  const reason = buildApprovalReason('pwsh', 'List files in current directory', 'a:b')
  assert.ok(reason.includes('List files in current directory'))
})

console.log('call key')

check('key is sessionId:callId', () => {
  assert.equal(callKey({ session: { id: 's1' } }, { callId: 'c1' }), 's1:c1')
})

check('key is absent when either half is missing', () => {
  assert.equal(callKey(undefined, { callId: 'c1' }), undefined)
  assert.equal(callKey({ session: { id: 's1' } }, {}), undefined)
  assert.equal(callKey({ session: {} }, { callId: 'c1' }), undefined)
})

console.log('mode detection')

const presetReader = value => () => value
/** A deployment whose effective preset is `name` for every session. */
const globalPreset = name => () => name
const agentFor = (id, session) => ({ id, session })

check('a direct manual session is authoritative', () => {
  const exec = { agent: agentFor('a', { id: 's1', header: {} }) }
  assert.notEqual(manualAuthority(exec, () => undefined, presetReader(MANUAL_PRESET), MANUAL_PRESET), undefined)
})

check('another mode is never authoritative', () => {
  const exec = { agent: agentFor('a', { id: 's1', header: {} }) }
  assert.equal(manualAuthority(exec, () => undefined, presetReader('workspace-write'), MANUAL_PRESET), undefined)
})

check('a throwing preset reader fails closed, not open', () => {
  const exec = { agent: agentFor('a', { id: 's1', header: {} }) }
  const boom = () => { throw new Error('projection missing') }
  assert.equal(manualAuthority(exec, () => undefined, boom, MANUAL_PRESET), undefined)
})

check('an in-process subagent inherits the parent session mode', () => {
  const parent = agentFor('parent', { id: 'p1', header: {} })
  const child = agentFor('child', { id: 'c1', header: { origin: 'subagent', parentSession: 'p1' } })
  const lookup = id => (String(id) === 'p1' ? parent : undefined)
  // The parent is manual; the child's own session is not.
  const presets = new Map([['p1', MANUAL_PRESET]])
  const reader = session => presets.get(String(session.id))
  assert.equal(manualAuthority({ agent: child }, lookup, reader, MANUAL_PRESET), parent)
})

check('a subagent of a non-manual parent is not manual', () => {
  const parent = agentFor('parent', { id: 'p1', header: {} })
  const child = agentFor('child', { id: 'c1', header: { origin: 'subagent', parentSession: 'p1' } })
  const lookup = id => (String(id) === 'p1' ? parent : undefined)
  const presets = new Map([['p1', 'danger-full-access']])
  const reader = session => presets.get(String(session.id))
  assert.equal(manualAuthority({ agent: child }, lookup, reader, MANUAL_PRESET), undefined)
})

check('the child\'s own manual mode wins over a non-manual parent', () => {
  const parent = agentFor('parent', { id: 'p1', header: {} })
  const child = agentFor('child', { id: 'c1', header: { origin: 'subagent', parentSession: 'p1' } })
  const lookup = id => (String(id) === 'p1' ? parent : undefined)
  const presets = new Map([['p1', 'workspace-write'], ['c1', MANUAL_PRESET]])
  const reader = session => presets.get(String(session.id))
  assert.equal(manualAuthority({ agent: child }, lookup, reader, MANUAL_PRESET), child)
})

check('a grandchild reaches a manual grandparent through a child whose own mode is not manual', () => {
  const grandparent = agentFor('gp', { id: 'g1', header: {} })
  const parent = agentFor('p', { id: 'p1', header: { origin: 'subagent', parentSession: 'g1' } })
  const child = agentFor('c', { id: 'c1', header: { origin: 'subagent', parentSession: 'p1' } })
  const agents = new Map([['g1', grandparent], ['p1', parent]])
  const lookup = id => agents.get(String(id))
  const presets = new Map([['g1', MANUAL_PRESET], ['p1', 'workspace-write']])
  const reader = session => presets.get(String(session.id))
  assert.equal(manualAuthority({ agent: child }, lookup, reader, MANUAL_PRESET), grandparent)
})

check('a missing parent stops the walk instead of guessing', () => {
  const child = agentFor('child', { id: 'c1', header: { origin: 'subagent', parentSession: 'gone' } })
  assert.equal(manualAuthority({ agent: child }, () => undefined, globalPreset('workspace-write'), MANUAL_PRESET), undefined)
})

check('a parent cycle terminates', () => {
  const first = agentFor('a', { id: 'a', header: { origin: 'subagent', parentSession: 'b' } })
  const second = agentFor('b', { id: 'b', header: { origin: 'subagent', parentSession: 'a' } })
  const lookup = id => (String(id) === 'a' ? first : String(id) === 'b' ? second : undefined)
  assert.equal(manualAuthority({ agent: first }, lookup, globalPreset('workspace-write'), MANUAL_PRESET), undefined)
})

check('the walk is bounded even when every hop looks like a subagent', () => {
  const sessions = new Map()
  for (let index = 0; index < 5000; index += 1) {
    sessions.set(`s${index}`, agentFor(`a${index}`, {
      id: `s${index}`,
      header: { origin: 'subagent', parentSession: `s${index + 1}` },
    }))
  }
  const lookup = id => sessions.get(String(id))
  // A terminal hop whose parent is missing must end the walk, not hang.
  sessions.set('s5000', agentFor('a5000', { id: 's5000', header: { origin: 'subagent', parentSession: 'missing' } }))
  assert.equal(manualAuthority({ agent: sessions.get('s0') }, lookup, globalPreset('workspace-write'), MANUAL_PRESET), undefined)
})

check('a non-subagent origin does not walk upward', () => {
  const exec = { agent: agentFor('a', { id: 's1', header: { origin: 'user', parentSession: 'p1' } }) }
  assert.equal(manualAuthority(exec, () => agentFor('p', { id: 'p1', header: {} }), globalPreset('workspace-write'), MANUAL_PRESET), undefined)
})

console.log('decision sentences')

check('a user rejection and a rule rejection use one formatter', () => {
  const byUser = rejectionResult('because it deletes files', 'bash')
  const byRule = rejectionResult('because it deletes files', 'bash')
  assert.deepEqual(byUser, byRule)
  assert.equal(byUser.kind, 'deny')
  assert.ok(byUser.reason.includes('because it deletes files'))
  assert.ok(byUser.reason.includes('rejection reason'))
})

check('an empty reason still produces the same sentence shape', () => {
  const empty = feedbackSentence('', 'read', 'rejection reason')
  assert.ok(empty.includes('read'))
  assert.ok(empty.includes('left no rejection reason'))
  assert.equal(rejectionResult(undefined, 'read').reason, empty)
})

check('the allowed branch of the same formatter says note', () => {
  const note = feedbackSentence('looks fine', 'read', 'note')
  assert.ok(note.includes('looks fine'))
  assert.ok(note.includes('this note'))
})

console.log('pending store')

check('rows are returned for their own key only', () => {
  const store = new PendingStore()
  store.putRows('s1:c1', ['a: 1'])
  assert.deepEqual(store.view('s1:c1').rows, ['a: 1'])
  assert.equal(store.view('s1:c2'), undefined)
})

check('a warning is stored alongside the rows for its own call', () => {
  const store = new PendingStore()
  store.putRows('s1:c1', ['a: 1'])
  store.putWarning('s1:c1', 'careful', 'danger rule')
  assert.equal(store.view('s1:c1').warning, 'careful')
  assert.equal(store.view('s1:c1').ruleName, 'danger rule')
  assert.equal(store.view('s1:c2'), undefined)
})

check('feedback is readable without being consumed', () => {
  // `tools/result` fires before `tools/post-execute`, so the delivery step must
  // not destroy the value while reading it; the settlement listener removes the
  // entry instead.
  const store = new PendingStore()
  store.putRows('s1:c1', [])
  store.putFeedback('s1:c1', 'because')
  assert.equal(store.peekFeedback('s1:c1'), 'because')
  assert.equal(store.peekFeedback('s1:c1'), 'because', 'a second read still sees it')
  store.delete('s1:c1')
  assert.equal(store.peekFeedback('s1:c1'), undefined)
})

check('feedback survives a later row publication for the same call', () => {
  const store = new PendingStore()
  store.putRows('s1:c1', ['a: 1'])
  store.putFeedback('s1:c1', 'noted')
  store.putRows('s1:c1', ['a: 2'])
  assert.equal(store.peekFeedback('s1:c1'), 'noted')
})

check('deleting a call drops both its rows and its feedback', () => {
  const store = new PendingStore()
  store.putRows('s1:c1', ['a: 1'])
  store.putFeedback('s1:c1', 'text')
  store.delete('s1:c1')
  assert.equal(store.view('s1:c1'), undefined)
  assert.equal(store.peekFeedback('s1:c1'), undefined)
})

check('the store is bounded', () => {
  const store = new PendingStore(4, 60_000)
  for (let index = 0; index < 20; index += 1) store.putRows(`s:c${index}`, [])
  assert.ok(store.entries.size <= 4, `expected <= 4 entries, got ${store.entries.size}`)
})

check('aged entries are swept', () => {
  const store = new PendingStore(64, 1)
  store.putRows('s:c1', ['a: 1'])
  const until = Date.now() + 5
  while (Date.now() < until) { /* let the entry age past its ttl */ }
  store.sweep()
  assert.equal(store.entries.size, 0)
})

console.log(`\n${checks} checks passed`)
