/**
 * Browser-half checks against a fake DOM.
 *
 * This layer did not exist when the plugin first shipped, and its absence let a
 * malformed CSS selector reach users: `upsertStyle` built
 * `style[data-plugin-css=""dsh-manual-approval/client.css""]`, which throws at
 * activation and the harness reports as "failed to apply loader entry".
 *
 *   node scripts/selftest-client.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(here, '..', 'lib', 'client.js')

let checks = 0
const failures = []
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

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

/** Every selector the bundle builds, so they can all be validated as CSS. */
const selectorsUsed = []

function camelToKebab(value) {
  return value.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
}

function kebabToCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

/**
 * A CSS-selector validity check matching the browser's rule for what
 * `querySelector` accepts for the shapes this bundle uses: attribute presence,
 * an attribute equality with a properly quoted value, a bare type selector, and
 * a type selector carrying attribute presence.
 */
const VALID_SELECTOR = /^(?:[a-z]+|\[[a-z-]+\]|[a-z]+\[[a-z-]+\]|\[[a-z-]+="[^"\\]*"\]|[a-z]+\[[a-z-]+="[^"\\]*"\]|textarea|div)$/

function assertValidSelector(selector) {
  if (typeof selector !== 'string' || selector === '') {
    throw new Error(`empty selector passed to querySelector`)
  }
  // The exact bug: JSON.stringify inside quotes yields doubled quotes.
  if (selector.includes('""')) {
    throw new Error(`selector has doubled quotes and would throw in a browser: ${selector}`)
  }
  if (!VALID_SELECTOR.test(selector)) {
    throw new Error(`selector is not in the supported shape: ${selector}`)
  }
}

class FakeElement {
  constructor(tag, document) {
    this.tagName = String(tag).toUpperCase()
    this.ownerDocument = document
    this.children = []
    this.parentNode = null
    this.attributes = {}
    this._text = ''
    this.nodeType = 1
    // In a browser `dataset` and the `data-*` attributes are two views of the
    // same state: writing `el.dataset.x` creates `data-x`. A fake that keeps
    // them separate makes every attribute selector miss, which is how this
    // harness first lied about the style tag.
    const attributes = this.attributes
    this.dataset = new Proxy({}, {
      get: (_, key) => attributes[`data-${camelToKebab(String(key))}`],
      set: (_, key, value) => {
        attributes[`data-${camelToKebab(String(key))}`] = String(value)
        return true
      },
      has: (_, key) => Object.prototype.hasOwnProperty.call(attributes, `data-${camelToKebab(String(key))}`),
      deleteProperty: (_, key) => {
        delete attributes[`data-${camelToKebab(String(key))}`]
        return true
      },
      ownKeys: () => Object.keys(attributes)
        .filter(name => name.startsWith('data-'))
        .map(name => kebabToCamel(name.slice(5))),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    })
  }

  get textContent() { return this._text }
  set textContent(value) { this._text = String(value) }

  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) }
  addEventListener() {}
  removeEventListener() {}
  contains() { return false }
  closest() { return null }
  get firstElementChild() { return this.children[0] ?? null }

  querySelector(selector) {
    selectorsUsed.push(selector)
    assertValidSelector(selector)
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector) {
    selectorsUsed.push(selector)
    assertValidSelector(selector)
    const out = []
    const visit = node => {
      for (const child of node.children) {
        if (matches(child, selector)) out.push(child)
        visit(child)
      }
    }
    visit(this)
    return out
  }
}

/** Support only the selector shapes this bundle actually builds. */
function matches(element, selector) {
  let name = null
  let attribute = null
  let value = null
  const typed = /^([a-z]+)\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector)
  const bare = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector)
  if (typed) {
    name = typed[1].toUpperCase()
    attribute = typed[2]
    value = typed[3]
  } else if (bare) {
    attribute = bare[1]
    value = bare[2]
  } else {
    name = selector.toUpperCase()
  }
  if (name !== null && element.tagName !== name) return false
  if (attribute === null) return true
  if (!element.hasAttribute(attribute)) return false
  return value === undefined || element.getAttribute(attribute) === value
}

class FakeDocument {
  constructor(card = null) {
    this.nodeType = 9
    this.head = new FakeElement('head', this)
    this.body = new FakeElement('body', this)
    this.listeners = []
    this.documentElement = new FakeElement('html', this)
    /** Optional richer card used by tests that need a nested structure. */
    this.card = card
  }

  createElement(tag) { return new FakeElement(tag, this) }

  querySelector(selector) {
    selectorsUsed.push(selector)
    assertValidSelector(selector)
    // A test may supply its own richer card (a nested tree with concatenated
    // ancestor text); use it instead of scanning the fake head/body.
    if (selector === '[data-approval-key]' && this.card !== null) return this.card
    return this.querySelectorAll(selector)[0] ?? null
  }

  /** Search the whole document: head AND body, in tree order. */
  querySelectorAll(selector) {
    selectorsUsed.push(selector)
    assertValidSelector(selector)
    const out = []
    const visit = node => {
      for (const child of node.children) {
        if (matches(child, selector)) out.push(child)
        visit(child)
      }
    }
    visit(this.documentElement)
    visit(this.head)
    visit(this.body)
    return out
  }

  addEventListener(type, handler) { this.listeners.push({ type, handler }) }
  removeEventListener(type, handler) {
    this.listeners = this.listeners.filter(entry => entry.handler !== handler || entry.type !== type)
  }
}

/**
 * Build a standalone element tree with working descendant queries.
 *
 * `closest` is real, not a stub. It used to `return null` unconditionally, which
 * made every test of the feedback-commit path vacuous: `findPanel` starts with
 * `target.closest(...)`, so it could never resolve a panel and the tests passed
 * while live use silently dropped every note.
 */
function makeNestedElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    parentNode: null,
    attributes: {},
    _text: '',
    get textContent() { return this._text },
    set textContent(value) { this._text = String(value) },
    hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null },
    setAttribute(name, value) { this.attributes[name] = String(value) },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child },
    collect(selector, out = []) {
      for (const child of this.children) {
        if (matchesElement(child, selector)) out.push(child)
        child.collect(selector, out)
      }
      return out
    },
    querySelector(selector) { return this.collect(selector)[0] ?? null },
    querySelectorAll(selector) { return this.collect(selector) },
    addEventListener() {},
    removeEventListener() {},
    contains(node) {
      for (const child of this.children) {
        if (child === node || child.contains(node)) return true
      }
      return false
    },
    closest(selector) {
      let node = this
      while (node !== null && node !== undefined) {
        if (node.nodeType === 1 && matchesElement(node, selector)) return node
        node = node.parentNode
      }
      return null
    },
    get firstElementChild() { return this.children[0] ?? null },
  }
  return element
}

/** Attribute-or-tag matching, the subset these tests build. */
function matchesElement(element, selector) {
  const attribute = /^\[([a-z-]+)\]$/.exec(selector)
  if (attribute) return element.hasAttribute(attribute[1])
  return element.tagName === selector.toUpperCase()
}

/** Load the bundle's factory with fakes standing in for the browser. */
function loadBundle({ fetchImpl, occupied = [], withLocale = false, locale = 'en', localeRegisterThrows = false, card = null } = {}) {
  const document = new FakeDocument(card)
  const posted = []
  const registered = []
  const injected = []
  const warnings = []
  const localeRegistered = []

  /**
   * A `single` slot holds at most one registration per priority. Model that rule
   * rather than trusting the plugin: throw when a taken (slot, priority) is
   * claimed again, and otherwise let the LOWEST priority win. Without this the
   * priority assertion below would be vacuous.
   */
  const occupants = new Map()
  for (const entry of occupied) occupants.set(`${entry.slot}@${entry.priority ?? 0}`, entry.label ?? 'shipped')
  const winner = slot => {
    const taken = [...occupants.keys()]
      .filter(key => key.startsWith(`${slot}@`))
      .map(key => Number(key.slice(slot.length + 1)))
      .sort((a, b) => a - b)
    return taken.length === 0 ? undefined : taken[0]
  }

  const slots = {
    inject(key, callback) {
      injected.push(key)
      return callback()
    },
    register(options, component) {
      const slot = options.name
      const priority = Number.isInteger(options.priority) ? options.priority : 0
      const key = `${slot}@${priority}`
      if (occupants.has(key)) {
        throw new Error(
          `single slot "${slot}" already has a registration at priority ${priority} `
          + `(registered by ${occupants.get(key)}) — register at a different priority to shadow it (lowest renders)`,
        )
      }
      occupants.set(key, 'dsh-manual-approval')
      registered.push({ options, component, priority })
      return () => {}
    },
  }

  const ctx = {
    get: name => (name === 'slots' ? slots : name === 'locale' ? localeService : undefined),
    effect: (callback, label) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }

  /**
   * A locale service stand-in. It keeps the registered dictionaries and resolves
   * lookups the way the real one does: the active language first, then English,
   * then the key itself.
   */
  const localeDicts = new Map()
  const localeService = {
    register(ns, localeId, dict) {
      if (localeRegisterThrows) throw new Error('locale registry refused the namespace')
      localeDicts.set(`${ns}:${localeId}`, dict)
      localeRegistered.push({ ns, locale: localeId })
      return () => {}
    },
    bind(ns) {
      return (key, params) => {
        const active = localeDicts.get(`${ns}:${locale}`)
        const template = active?.[key] ?? localeDicts.get(`${ns}:en`)?.[key] ?? key
        if (params === undefined || params === null) return template
        return String(template).replace(/\{(\w+)\}/g, (match, name) => (
          params[name] === undefined || params[name] === null ? match : String(params[name])
        ))
      }
    },
  }

  let factory = null
  globalThis.window = {
    __ModuleLoader__: { load: descriptor => { factory = descriptor.factory } },
    __DSH_MANUAL_APPROVAL__: {
      token: 'test-token',
      endpoint: '/dsh-manual-approval/feedback',
      rulesEndpoint: '/dsh-manual-approval/feedback',
    },
    fetch: fetchImpl ?? (async (url, options) => {
      posted.push({ url, options })
      return { json: async () => ({ ok: true }) }
    }),
  }
  globalThis.document = document
  globalThis.fetch = globalThis.window.fetch
  globalThis.console = { ...console, warn: (...args) => { warnings.push(args.join(' ')) } }
  globalThis.React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}],
    useEffect: () => {},
  }

  const source = readFileSync(CLIENT, 'utf8')
  // The bundle is a script, not a module: evaluate it to capture the factory.
  // eslint-disable-next-line no-new-func
  new Function(source)()

  const module = factory(key => {
    if (key === 'react') return globalThis.React
    throw new Error(`unexpected require(${JSON.stringify(key)})`)
  })
  return { module, document, posted, registered, injected, ctx, occupants, winner, warnings, slots, localeRegistered, localeDicts }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

console.log('bundle load')

await check('the bundle loads and exposes apply/inject', async () => {
  const { module } = loadBundle()
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots', 'locale'])
})

await check('the manifest declares the client dependencies the bundle needs', () => {
  // The host boot wires `dsh.client.inject` into the client boot graph; a
  // dependency declared only inside the bundle reaches the plugin context too
  // late. Missing `@deepseek-ai/dsh-client-locale` here is exactly why the
  // settings page stayed English while the rest of DSH was Chinese.
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const declared = manifest.dsh?.client?.inject ?? []
  assert.ok(
    declared.includes('@deepseek-ai/dsh-client-locale'),
    `dsh.client.inject must name the locale package, got ${JSON.stringify(declared)}`,
  )
  assert.deepEqual(loadBundle().module.inject, ['slots', 'locale'], 'the bundle and the manifest must agree')
})

console.log('localization')

/** The bundle exposes its dictionaries for inspection. */
function readDictionaries() {
  return loadBundle().module.__dict
}

await check('both dictionaries carry exactly the same keys', () => {
  const dict = readDictionaries()
  const en = Object.keys(dict.en).sort()
  const zh = Object.keys(dict.zh).sort()
  assert.ok(en.length > 40, `expected a substantial dictionary, found ${en.length}`)
  assert.deepEqual(zh, en, 'a key present in only one language leaves the other untranslated')
})

await check('no dictionary value is empty', () => {
  const dict = readDictionaries()
  for (const locale of ['en', 'zh']) {
    for (const [key, value] of Object.entries(dict[locale])) {
      assert.equal(typeof value, 'string', `${locale}.${key} must be a string`)
      assert.ok(value.trim() !== '', `${locale}.${key} must not be empty`)
    }
  }
})

await check('the Chinese dictionary is genuinely translated', () => {
  const dict = readDictionaries()
  // Keys whose value is code or a placeholder may legitimately match English.
  const allowed = new Set([
    'rule.patternPlaceholder', 'rule.urlPlaceholder',
    'rule.decisionPathPlaceholder', 'rule.reasonPathPlaceholder',
  ])
  const untranslated = Object.keys(dict.en)
    .filter(key => dict.en[key] === dict.zh[key] && !allowed.has(key))
  assert.deepEqual(untranslated, [], `these keys were never translated: ${untranslated.join(', ')}`)
})

await check('the plugin registers both dictionaries through the locale service', () => {
  const fake = loadBundle({ withLocale: true })
  fake.module.apply(fake.ctx)
  assert.deepEqual(fake.localeRegistered, [
    { ns: 'manual-approval', locale: 'en' },
    { ns: 'manual-approval', locale: 'zh' },
  ], 'both shipped languages must be registered')
})

await check('a locale failure warns instead of breaking activation', () => {
  const fake = loadBundle({ withLocale: true, localeRegisterThrows: true })
  const dispose = fake.module.apply(fake.ctx)
  assert.equal(typeof dispose, 'function')
  assert.equal(
    fake.registered.some(entry => entry.options.name === 'settings.section'),
    true,
    'the settings page must still register',
  )
  assert.ok(fake.warnings.some(line => line.includes('translations')), JSON.stringify(fake.warnings))
})

await check('no user-visible prose is left hardcoded in the code region', () => {
  const text = readFileSync(CLIENT, 'utf8')
  const code = text.slice(text.indexOf("var inject = ['slots']"))
  const leaked = [
    "'Parameters (unavailable)'",
    "'Add a note or a reason for your decision…'",
    "'Manual mode rules'",
    "'Rules active'",
    "'When off, every rule is inert and every call asks.'",
    "'Add rule'",
    "'Match target'",
    "'Regular expression'",
    "'Warning text (optional)'",
    "'Decision path (required)'",
    "'This rule captures no groups.'",
    "'Collapse it to keep the list short.'",
    "'No conditions yet — this rule matches everything.'",
  ]
  const found = leaked.filter(literal => code.includes(literal))
  assert.deepEqual(found, [], `these strings must go through translate(): ${found.join(', ')}`)
})

await check('the bundle builds only valid CSS selectors', async () => {
  selectorsUsed.length = 0
  const { module, ctx } = loadBundle()
  module.apply(ctx)
  for (const selector of selectorsUsed) assertValidSelector(selector)
  assert.ok(selectorsUsed.length > 0, 'the bundle must query the DOM')
})

await check('the exact shipped bug is rejected by the validator', () => {
  // Guard the guard: if assertValidSelector accepted this, it would not protect
  // anything.
  assert.throws(
    () => assertValidSelector('style[data-plugin-css=""dsh-manual-approval/client.css""]'),
    /doubled quotes/,
  )
  assertValidSelector('style[data-plugin-css]')
})

await check('the style tag is created once and installed', async () => {
  const { module, ctx, document } = loadBundle()
  module.apply(ctx)
  const styles = document.querySelectorAll('style[data-plugin-css]')
  assert.equal(styles.length, 1, 'one style tag')
  assert.equal(styles[0].dataset.pluginCss, 'dsh-manual-approval/client.css')
  assert.equal(styles[0].dataset.plugin, 'dsh-manual-approval')
  assert.ok(styles[0].textContent.includes('.dshm_body'), 'the CSS is inlined')

  // Applying twice must not add a second tag.
  module.apply(ctx)
  assert.equal(document.querySelectorAll('style[data-plugin-css]').length, 1)
})

console.log('registration')

await check('it registers the approval detail panel and the settings section', async () => {
  const { module, ctx, registered, injected } = loadBundle()
  module.apply(ctx)
  assert.deepEqual(injected, ['conversation.approval.detail', 'settings.section'])
  const names = registered.map(entry => entry.options.name)
  assert.deepEqual(names, ['conversation.approval.detail', 'settings.section'])
  const section = registered[1]
  assert.equal(section.options.id, 'manual-approval')
  // The nav label is a thunk so it follows the active language instead of
  // freezing whatever language the page first rendered in.
  assert.equal(typeof section.options.label, 'function')
  const label = section.options.label()
  assert.ok(label === 'Manual mode rules' || label === '手动批准规则', `unexpected label: ${label}`)
  for (const entry of registered) assert.equal(typeof entry.component, 'function')
})

await check('apply returns a disposer and survives a missing slot service', async () => {
  const { module } = loadBundle()
  const bare = { get: () => undefined, effect: () => () => {} }
  const dispose = module.apply(bare)
  assert.equal(typeof dispose, 'function')
  dispose()
})

await check('the detail panel claims the slot at a priority that shadows the shipped one', async () => {
  // The shipped ui-chat registers at the default 0, so 0 is taken; the whole
  // point is that this plugin must NOT claim 0 and must still win the seam.
  const { module, ctx, registered, winner, occupants } = loadBundle({
    occupied: [{ slot: 'conversation.approval.detail', priority: 0, label: 'dsh-client-ui-chat' }],
  })
  module.apply(ctx)
  const detail = registered.find(entry => entry.options.name === 'conversation.approval.detail')
  assert.ok(detail !== undefined, 'the panel must still register')
  assert.ok(Number.isInteger(detail.priority), 'priority must be an explicit integer')
  assert.notEqual(detail.priority, 0, 'priority 0 is already occupied by the shipped UI')
  assert.ok(detail.priority < 0, `expected a lower priority than 0, got ${detail.priority}`)
  assert.equal(winner('conversation.approval.detail'), detail.priority, 'the plugin must win the single slot')
  assert.equal(occupants.get('conversation.approval.detail@0'), 'dsh-client-ui-chat', 'the shipped occupant stays registered')
})

await check('registering into an occupied single slot never throws out of apply', async () => {
  // Even if the slot contract changes and the priority is rejected, the client
  // plugin tree must survive: a throw here fails THIS plugin's entry and the
  // harness then reports the whole tree as failed to load.
  const { module, ctx, registered, warnings } = loadBundle({
    occupied: [
      { slot: 'conversation.approval.detail', priority: 0, label: 'ui-chat' },
      { slot: 'conversation.approval.detail', priority: -1, label: 'someone-else' },
    ],
  })
  const dispose = module.apply(ctx)
  assert.equal(typeof dispose, 'function')
  assert.equal(registered.some(entry => entry.options.name === 'conversation.approval.detail'), false)
  // The settings section is independent and must still register.
  assert.equal(registered.some(entry => entry.options.name === 'settings.section'), true)
  assert.ok(warnings.some(line => line.includes('conversation.approval.detail')), JSON.stringify(warnings))
})

console.log('the approval panel')

await check('the tool name comes from the headline when no prop is passed', async () => {
  // The shipped card renders its `detail` slot with ONLY `{ callId }`, so a
  // prop-based label showed the placeholder "tool call" while the real name sat
  // in the headline right above the panel.
  const fake = loadBundle()
  fake.module.apply(fake.ctx)
  const card = fake.document.createElement('div')
  card.setAttribute('data-approval-key', 'approval:1')
  const headline = fake.document.createElement('div')
  headline.textContent = '[manual approval] Confirm tool call: write (ref session-9:call_abc)'
  card.appendChild(headline)
  fake.document.body.appendChild(card)

  const detail = fake.registered[0].component
  const rendered = JSON.stringify(detail({ callId: 'call_abc' }))
  assert.ok(rendered.includes('write'), `the real tool name must be shown: ${rendered.slice(0, 240)}`)
  assert.ok(!rendered.includes('tool call'), 'the placeholder must not appear when the headline names the tool')
})

await check('an explicit toolName prop still wins', async () => {
  const fake = loadBundle()
  fake.module.apply(fake.ctx)
  const detail = fake.registered[0].component
  const rendered = JSON.stringify(detail({ callId: 'call_abc', toolName: 'grep' }))
  assert.ok(rendered.includes('grep'))
})

await check('a headline description is not swallowed into the tool name', async () => {
  // A greedy `Confirm tool call: (.+?)(\(ref…\))?$` takes the model's own
  // description along with the name, which flooded the card with that text.
  for (const [headline, expected] of [
    ['[manual approval] Confirm tool call: pwsh — Read remaining literals in context (ref session-9:call_x)', 'pwsh'],
    ['[manual approval] Confirm tool call: write — Add the file (ref s:c)', 'write'],
    ['[manual approval] Confirm tool call: grep (ref s:c)', 'grep'],
  ]) {
    const fake = loadBundle()
    fake.module.apply(fake.ctx)
    const card = fake.document.createElement('div')
    card.setAttribute('data-approval-key', 'approval:1')
    const node = fake.document.createElement('div')
    node.textContent = headline
    card.appendChild(node)
    fake.document.body.appendChild(card)

    const rendered = JSON.stringify(fake.registered[0].component({ callId: 'x' }))
    assert.ok(rendered.includes(`"${expected}"`), `expected the name ${expected}, got: ${rendered.slice(0, 260)}`)
    assert.ok(!rendered.includes('Read remaining literals'), 'the description must not leak into the name')
    assert.ok(!rendered.includes('Add the file'), 'the description must not leak into the name')
    assert.ok(!rendered.includes('(ref '), 'the ref must not leak into the name')
  }
})

await check('an ancestor carrying the same text does not leak the argument rows into the title', async () => {
  // The card wraps its headline AND this panel in one body div. That ancestor's
  // textContent starts with the marker too and concatenates everything inside it,
  // so reading the first match rendered the whole argument list into the title.
  const card = makeNestedElement('div')
  card.setAttribute('data-approval-key', 'approval:1')
  const body = makeNestedElement('div')
  const headline = makeNestedElement('div')
  headline.textContent = '[manual approval] Confirm tool call: edit — Add the file (ref s:c)'
  const panelHost = makeNestedElement('div')
  const rows = makeNestedElement('div')
  rows.textContent = 'file_path: D:\\a.txt'
  panelHost.appendChild(rows)
  body.appendChild(headline)
  body.appendChild(panelHost)
  card.appendChild(body)
  // Give the ancestor the concatenated text a real browser would compute.
  body.textContent = headline.textContent + rows.textContent

  const fake = loadBundle({ card })
  fake.module.apply(fake.ctx)
  const rendered = JSON.stringify(fake.registered[0].component({ callId: 'c' }))

  assert.ok(rendered.includes('edit'), `the tool name must be the headline's name: ${rendered.slice(0, 240)}`)
  assert.ok(!rendered.includes('Add the file'), 'the description must not reach the title')
  assert.ok(!rendered.includes('file_path'), 'the argument rows must NOT be rendered into the title')
  assert.ok(rendered.includes('"c"'), 'the call id must still resolve')
})

console.log('rule list')

/** A minimal hook runtime: enough to mount a component and let its effect fire. */
function installHookRuntime() {
  let cursor = 0
  let effects = []
  const pending = []
  globalThis.React.useState = initial => {
    const slot = cursor
    cursor += 1
    if (!(slot in pending)) pending[slot] = typeof initial === 'function' ? initial() : initial
    return [pending[slot], next => {
      pending[slot] = typeof next === 'function' ? next(pending[slot]) : next
    }]
  }
  globalThis.React.useEffect = (callback) => { effects.push(callback) }
  return {
    /** Render once, then run any effects registered during that render. */
    render: component => {
      cursor = 0
      effects = []
      const tree = component()
      const queued = effects
      return { tree, mount: () => { for (const effect of queued) effect() } }
    },
  }
}

/**
 * Walk a rendered tree, calling function components as React would.
 *
 * `React.createElement(RuleEditor, …)` yields a descriptor whose `type` is the
 * function; without invoking it the card's own markup never exists.
 */
function walkTree(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) { for (const child of node) walkTree(child, visit); return }
  if (typeof node === 'string' || typeof node === 'number') return
  if (typeof node !== 'object') return
  if (typeof node.type === 'function') {
    walkTree(node.type(Object.assign({}, node.props, { children: node.children })), visit)
    return
  }
  visit(node)
  if (Array.isArray(node.children)) for (const child of node.children) walkTree(child, visit)
}

/** Collect every text node under a rendered tree. */
function flattenText(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return flattenText(node.type(Object.assign({}, node.props, { children: node.children })))
    if (Array.isArray(node.children)) return flattenText(node.children)
  }
  return ''
}

function findByClass(node, className) {
  return findByClassAll(node, className)[0] ?? null
}

/** Every element carrying `className`, in tree order, expanding components. */
function findByClassAll(node, className) {
  const out = []
  const visit = current => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) { current.forEach(visit); return }
    if (typeof current.type === 'function') {
      visit(current.type(Object.assign({}, current.props, { children: current.children })))
      return
    }
    if (typeof current.props?.className === 'string' && current.props.className.split(/\s+/).includes(className)) out.push(current)
    if (Array.isArray(current.children)) current.children.forEach(visit)
  }
  visit(node)
  return out
}

await check('a rule card starts collapsed: only the name and a summary row', async () => {
  // The reported problem: every rule rendered its full editor at once, so one
  // rule filled most of the settings pane and reordering was unusable.
  const hooks = loadBundle({
    fetchImpl: async () => ({
      json: async () => ({
        ok: true,
        masterEnabled: true,
        path: '/tmp/rules.json',
        errors: [],
        compiled: [{ index: 0, valid: true, groupCount: 0, errors: [] }],
        rules: [{
          id: 'r1',
          name: 'Allow reads',
          enabled: true,
          conditions: [{ target: 'toolName', pattern: '^read$' }],
          action: { kind: 'approve', message: '' },
        }],
      }),
    }),
  })
  const hooksRuntime = installHookRuntime()
  hooks.module.apply(hooks.ctx)
  const section = hooks.registered[1].component
  const first = hooksRuntime.render(section)
  first.mount()
  await new Promise(resolve => setTimeout(resolve, 0))
  const { tree } = hooksRuntime.render(section)

  const text = flattenText(tree)
  // The name lives on a control's `value`, not in a text node: a textarea that
  // renders its own value as a child is not how React works.
  const nameInput = findByClass(tree, 'dshm_text')
  assert.ok(nameInput !== null && nameInput.props.value === 'Allow reads', `the name must stay visible: ${JSON.stringify(nameInput && nameInput.props)}`)
  assert.ok(text.includes('Enabled'), 'the enable toggle stays reachable while collapsed')
  assert.ok(text.includes('Tool name ≈ ^read$'), `the collapsed row needs a summary: ${text.slice(0, 400)}`)
  assert.ok(!text.includes('Conditions (all must match'), 'no rule may render its editor by default')
  assert.ok(!text.includes('Regular expression'), 'no rule may render its inputs by default')
  assert.equal(findByClass(tree, 'dshm_editor'), null, 'the editor container must not be in the collapsed tree')
  assert.ok(findByClass(tree, 'dshm_summary') !== null, 'the summary row is the collapsed body')
  assert.ok(text.includes('Allow'), 'the collapsed row still states its action')
})

await check('one card expands on demand and leaves the others collapsed', async () => {
  const hooks = loadBundle({
    fetchImpl: async () => ({
      json: async () => ({
        ok: true,
        masterEnabled: true,
        path: '/tmp/rules.json',
        errors: [],
        compiled: [
          { index: 0, valid: true, groupCount: 0, errors: [] },
          { index: 1, valid: true, groupCount: 0, errors: [] },
        ],
        rules: [
          { id: 'r1', name: 'First rule', enabled: true, conditions: [{ target: 'toolName', pattern: '^read$' }], action: { kind: 'approve', message: '' } },
          { id: 'r2', name: 'Second rule', enabled: true, conditions: [{ target: 'argValue', pattern: 'secret' }], action: { kind: 'deny', message: 'no' } },
        ],
      }),
    }),
  })
  const hooksRuntime = installHookRuntime()
  hooks.module.apply(hooks.ctx)
  const section = hooks.registered[1].component
  hooksRuntime.render(section).mount()
  await new Promise(resolve => setTimeout(resolve, 0))

  // No shared open-state in the section: each card owns its own, so expanding
  // one cannot open the other.
  const collapsed = flattenText(hooksRuntime.render(section).tree)
  const collapsedNames = []
  findByClassAll(hooksRuntime.render(section).tree, 'dshm_text').forEach(node => collapsedNames.push(node.props.value))
  assert.deepEqual(collapsedNames, ['First rule', 'Second rule'], `both rows render collapsed: ${JSON.stringify(collapsedNames)}`)
  assert.equal((collapsed.match(/Conditions \(all must match/g) ?? []).length, 0, 'both start collapsed')

  // Toggling the card's own control is pure client state: no request is needed.
  const before = hooks.posted.length
  const tree = hooksRuntime.render(section).tree
  const cards = []
  walkTree(tree, node => {
    if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes('dshm_card')) cards.push(node)
  })
  assert.equal(cards.length, 2, 'two cards render')
  const toggle = findByClass(cards[0], 'dshm_toggle')
  assert.ok(toggle !== null, 'a card exposes its own expand control')
  assert.equal(toggle.props['aria-expanded'], 'false', 'the card announces its collapsed state')
  toggle.props.onClick()
  const expanded = flattenText(hooksRuntime.render(section).tree)
  assert.ok(expanded.includes('Conditions (all must match'), 'the clicked card expands')
  assert.equal((expanded.match(/Conditions \(all must match/g) ?? []).length, 1, 'only the clicked card expands')
  assert.equal(hooks.posted.length, before, 'collapsing is client-side state, not a request')
})

await check('the primary button uses a theme token that exists', async () => {  // `--dsw-alias-label-on-fill` is not in the shipped theme, which made the
  // Save/Saved label invisible. Assert the token the theme actually defines.
  const source = readFileSync(CLIENT, 'utf8')
  assert.ok(source.includes('var(--dsw-alias-label-primary-foreground'), 'the primary label needs the real foreground token')
  const primaryRule = /\.dshm_btnPrimary\{[^}]*\}/.exec(source)
  assert.ok(primaryRule !== null, 'the primary button rule must exist')
  assert.ok(!/color:var\(--dsw-alias-label-on-fill/.test(primaryRule[0]), `the rule must not use the missing token: ${primaryRule[0]}`)
})

await check('the detail panel renders the tool name, rows and a feedback box', async () => {
  const { module, ctx, registered } = loadBundle()
  module.apply(ctx)
  const detail = registered[0].component
  const tree = detail({ callId: 'call-1', toolName: 'grep' })
  // The textarea is what the commit listener reads.
  const serialized = JSON.stringify(tree)
  assert.ok(serialized.includes('Feedback'), 'the panel explains the box')
  assert.ok(serialized.includes('grep'), 'the tool name is shown')
})

await check('clicking a decision control posts the feedback before it resolves', async () => {
  const { module, ctx, document, posted } = loadBundle()
  module.apply(ctx)

  // A pending card, as the shipped approval UI renders it.
  const card = document.createElement('div')
  card.setAttribute('data-approval-key', 'approval:1')
  const headline = document.createElement('div')
  headline.textContent = '[manual approval] Confirm tool call: grep (ref s1:c1)'
  const panel = document.createElement('div')
  panel.setAttribute('data-dsh-manual-approval-panel', 'true')
  const textarea = document.createElement('textarea')
  textarea.value = 'because reasons'
  panel.appendChild(textarea)
  card.appendChild(headline)
  card.appendChild(panel)
  document.body.appendChild(card)

  const click = document.listeners.find(entry => entry.type === 'click')
  assert.ok(click !== undefined, 'a capture-phase click listener must be installed')
  click.handler({ target: textarea })

  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(posted.length, 1, 'one feedback POST')
  assert.equal(posted[0].url, '/dsh-manual-approval/feedback')
  assert.equal(posted[0].options.headers['x-manual-approval-token'], 'test-token')
  const body = JSON.parse(posted[0].options.body)
  assert.equal(body.key, 's1:c1', 'the key comes from the headline ref')
  assert.equal(body.text, 'because reasons')
})

await check('a note typed and answered without clicking away still reaches the host', async () => {
  // The reported bug: typing then clicking 允许/拒绝 immediately lost the note
  // unless the box was blurred first. The draft is therefore cached on every
  // keystroke and committed on pointerdown as well as click.
  const { module, ctx, document, posted } = loadBundle()
  module.apply(ctx)

  const card = document.createElement('div')
  card.setAttribute('data-approval-key', 'approval:1')
  const headline = document.createElement('div')
  headline.textContent = '[manual approval] Confirm tool call: read (ref s1:c9)'
  const panel = document.createElement('div')
  panel.setAttribute('data-dsh-manual-approval-panel', 'true')
  const textarea = document.createElement('textarea')
  textarea.value = 'hold on, check this first'
  panel.appendChild(textarea)
  card.appendChild(headline)
  card.appendChild(panel)
  document.body.appendChild(card)

  const input = document.listeners.find(entry => entry.type === 'input')
  assert.ok(input !== undefined, 'keystrokes must be remembered')
  input.handler({ target: textarea })

  // The card re-renders as the decision is taken: the box is emptied before the
  // click is delivered, so the cached draft is what must be sent.
  panel.querySelector('textarea').value = ''

  const pointerdown = document.listeners.find(entry => entry.type === 'pointerdown')
  assert.ok(pointerdown !== undefined, 'pointerdown must commit too')
  pointerdown.handler({ target: textarea })

  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(posted.length, 1, 'the cached note must be posted exactly once')
  assert.equal(JSON.parse(posted[0].options.body).text, 'hold on, check this first')
})

await check('the panel is found as a sibling of the button row, as the shipped card builds it', async () => {
  // The live bug: `@deepseek-ai/dsh-client-ui-approval` renders
  //
  //   [data-approval-key]
  //     └ card
  //        ├ body      → headline, command (THIS plugin's panel)
  //        └ actionRow → Reject, Allow once
  //
  // so the panel is the button row's SIBLING. `findPanel` used to only walk up
  // from the clicked button, which can never reach a sibling, so every note was
  // dropped when the user answered by clicking allow. This test fails against
  // that implementation.
  const { module, ctx, document, posted } = loadBundle()
  module.apply(ctx)

  const card = makeNestedElement('div')
  card.setAttribute('data-approval-key', 'sess-1:call-1')
  const body = makeNestedElement('div')
  const headline = makeNestedElement('div')
  headline.textContent = '[manual approval] Confirm tool call: read (ref sess-1:call-1)'
  const command = makeNestedElement('div')
  const panel = makeNestedElement('div')
  panel.setAttribute('data-dsh-manual-approval-panel', 'true')
  const textarea = makeNestedElement('textarea')
  textarea.value = 'typed then answered directly'
  panel.appendChild(textarea)
  command.appendChild(panel)
  body.appendChild(headline)
  body.appendChild(command)
  const actionRow = makeNestedElement('div')
  const allow = makeNestedElement('button')
  allow.textContent = 'Allow once'
  actionRow.appendChild(allow)
  card.appendChild(body)
  card.appendChild(actionRow)
  document.body.appendChild(card)

  // `resolveRefKey` reads the card, so the document must expose it.
  const originalQuerySelector = document.querySelector.bind(document)
  document.querySelector = selector => (
    selector === '[data-approval-key]' ? card : originalQuerySelector(selector)
  )

  // A real press fires both, and the shipped button answers on click.
  const commit = type => {
    for (const listener of document.listeners.filter(entry => entry.type === type)) {
      listener.handler({ target: allow })
    }
  }
  commit('pointerdown')
  commit('click')
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(posted.length, 1, `the sibling panel must be found exactly once, posts=${posted.length}`)
  assert.equal(JSON.parse(posted[0].options.body).text, 'typed then answered directly')
  assert.equal(JSON.parse(posted[0].options.body).key, 'sess-1:call-1')
})

await check('the submit carries the header the route requires', async () => {
  // `sendBeacon` cannot set a custom header and a `keepalive` request raced the
  // decision, so neither is used.
  const source = readFileSync(CLIENT, 'utf8')
  assert.ok(!/\.sendBeacon\s*\(/.test(source), 'sendBeacon cannot carry the token header')
  const start = source.indexOf('function submitFeedback')
  assert.ok(start !== -1, 'submitFeedback must exist')
  // Brace-count to the real end of the function: a regex would stop at the first
  // nested closing brace.
  let depth = 0
  let end = start
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) { end = index; break }
    }
  }
  const body = source.slice(start, end + 1)
  // Ignore prose: only the CODE must avoid these.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(!code.includes('keepalive'), 'a fire-and-forget request raced the decision')
  assert.ok(code.includes('x-manual-approval-token'), 'the token header must be sent')
  assert.ok(!/\.sendBeacon\s*\(/.test(code), 'sendBeacon cannot carry the token header')
})

await check('an empty feedback box posts nothing', async () => {
  const { module, ctx, document, posted } = loadBundle()
  module.apply(ctx)
  const card = document.createElement('div')
  card.setAttribute('data-approval-key', 'approval:1')
  const headline = document.createElement('div')
  headline.textContent = '[manual approval] Confirm tool call: grep (ref s1:c1)'
  const panel = document.createElement('div')
  panel.setAttribute('data-dsh-manual-approval-panel', 'true')
  const textarea = document.createElement('textarea')
  textarea.value = '   '
  panel.appendChild(textarea)
  card.appendChild(headline)
  card.appendChild(panel)
  document.body.appendChild(card)

  document.listeners.find(entry => entry.type === 'click').handler({ target: textarea })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(posted.length, 0)
})

await check('a click outside the panel is ignored', async () => {
  const { module, ctx, document, posted } = loadBundle()
  module.apply(ctx)
  const outside = document.createElement('button')
  document.body.appendChild(outside)
  document.listeners.find(entry => entry.type === 'click').handler({ target: outside })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(posted.length, 0)
})

await check('a failing fetch never throws out of the click handler', async () => {
  const { module, ctx, document } = loadBundle({
    fetchImpl: async () => { throw new Error('network down') },
  })
  module.apply(ctx)
  const card = document.createElement('div')
  card.setAttribute('data-approval-key', 'approval:1')
  const headline = document.createElement('div')
  headline.textContent = '[manual approval] Confirm tool call: grep (ref s1:c1)'
  const panel = document.createElement('div')
  panel.setAttribute('data-dsh-manual-approval-panel', 'true')
  const textarea = document.createElement('textarea')
  textarea.value = 'note'
  panel.appendChild(textarea)
  card.appendChild(headline)
  card.appendChild(panel)
  document.body.appendChild(card)

  document.listeners.find(entry => entry.type === 'click').handler({ target: textarea })
  await new Promise(resolve => setTimeout(resolve, 0))
})

console.log(`\n${checks} checks passed`)
if (failures.length > 0) {
  console.log(`failed: ${failures.join(', ')}`)
  process.exit(1)
}
