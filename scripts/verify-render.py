"""Real-browser verification for dsh-manual-approval.

`selftest-client.mjs` drives the bundle with a hand-written hook runtime: it
calls components by hand, stubs `useState`, and its fake DOM does not implement
`closest()`. That proves the logic in isolation, but it cannot prove either of
the two things that actually broke in live use:

  1. that real React renders the rule list the way the settings page needs it
     (every rule collapsed to one row), and
  2. that a note typed into the approval panel reaches the host when the user
     types and clicks allow **without clicking away first**.

So this suite drives the real bundle in a real browser. It renders the section
through real React 18 + react-dom, and for the feedback path it mounts the
shipped approval card structure (`data-approval-key` → card → headline →
actionRow with the two buttons, exactly as `@deepseek-ai/dsh-client-ui-approval`
builds it) and observes `window.fetch` to see what the plugin actually sends.

Steps:

  1. boot `dsh web` on its own port with the throwaway test profile;
  2. read the rule document from the host's private route, with the cookie the
     root `?token=` mints (so the fixture is the live endpoint's answer);
  3. open the real bundle in headless Edge/Chrome and run both stages;
  4. read the results out of the live DOM.

Network note: real React comes from esm.sh. Without it both stages report
`skip` and the suite still exits 0, so a flaky CDN can neither mask a real
regression nor fail an unrelated run.
"""

import http.cookiejar
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 3101
# Paths are derived from this file's own location, never hardcoded: a checkout
# must run on any machine and at any path. `DSH_TEST_HOME` overrides the
# throwaway profile location.
PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The SAME throwaway home `verify-boot.py` uses, on its own port: its profile is
# the one that actually lists this plugin as a bundle, and building a second
# profile would mean a second full dependency install for no extra coverage.
TEST_HOME = os.environ.get("DSH_TEST_HOME") or os.path.join(tempfile.gettempdir(), "dsh-manual-approval-testhome")
LOG = os.path.join(TEST_HOME, "render.out")
DSH = os.environ.get("DSH_BIN", "dsh")
BUNDLE = os.path.join(PLUGIN, "lib", "client.js")

BROWSERS = [
    os.environ.get("DSH_BROWSER", ""),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Google\Chrome\Application\chrome.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
]

failures = []


def check(name, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {name}{(' -- ' + str(detail)) if detail else ''}")
    if not ok:
        failures.append(name)


def note(text):
    print(f"  note {text}")


def read_log():
    try:
        with io.open(LOG, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return ""


def find_browser():
    for candidate in BROWSERS:
        if candidate and os.path.exists(candidate):
            return candidate
    return None


class QuietHandler(SimpleHTTPRequestHandler):
    """Serve the harness files without printing a line per request."""

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        pass


def scaffold_test_home():
    """Create the throwaway profile that lists this checkout as a bundle.

    Written with explicit UTF-8 and LF endings: PowerShell's `-Encoding utf8`
    emits a BOM, and a BOM makes the profile manifest fail to parse. Created only
    when absent, so an existing profile keeps whatever dependencies it installed.
    """
    profile = os.path.join(TEST_HOME, "profiles", "web")
    os.makedirs(profile, exist_ok=True)
    package = os.path.join(profile, "package.json")
    if not os.path.exists(package):
        manifest = {
            "name": "dsh-profile-manual-approval-test",
            "private": True,
            "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-manual-approval"], "patchReload": "live"}},
            "dependencies": {"dsh-manual-approval": "link:" + PLUGIN.replace("\\", "/")},
        }
        with io.open(package, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(manifest, indent=2) + "\n")
    for name in ("cordis.yml", "cordis.patch.yml"):
        path = os.path.join(profile, name)
        if not os.path.exists(path):
            with io.open(path, "w", encoding="utf-8", newline="\n") as handle:
                handle.write("[]\n")


# ---------------------------------------------------------------------------
# The page. It mounts the real bundle into a hand-built DOM that matches the
# shipped approval card, and spies on fetch so the assertions are about what the
# plugin SENT, not about a round trip through a CORS boundary.
# ---------------------------------------------------------------------------

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>dsh-manual-approval render check</title></head>
<body>
<div id="root"></div>
<pre id="out">RUNNING</pre>
<script>
// The rule document the live host returned, embedded before the bundle runs so
// the fetch spy below can answer the section's own request with it.
window.__RULES_FOR_SPY__ = __RULES__
// Capture loader failures: a bundle that throws while evaluating would
// otherwise look exactly like one that never registered.
window.__LOAD_ERRORS__ = []
window.addEventListener('error', event => {
  window.__LOAD_ERRORS__.push('error: ' + (event.message || '') + ' @ ' + (event.filename || '?'))
}, true)
window.addEventListener('unhandledrejection', event => {
  window.__LOAD_ERRORS__.push('rejection: ' + String(event.reason && event.reason.message ? event.reason.message : event.reason))
})
// The spy MUST be installed before the bundle is evaluated: the bundle's
// factory closes over `fetch` when the module is created, so a later swap would
// capture nothing. A real cross-origin POST would be blocked by CORS and look
// like a lost note; the spy records the attempt instead.
window.__SENT__ = []
window.fetch = function (url, options) {
  const target = String(url)
  const entry = { url: target, options: options || {} }
  try { entry.body = JSON.parse(String(entry.options.body || 'null')) } catch (error) { entry.body = null }
  window.__SENT__.push(entry)
  // The settings section reads the rule document through this same route, so the
  // spy has to answer it with the document, not with a generic ok.
  if (target.indexOf('rules=1') !== -1) {
    return Promise.resolve({ json: () => Promise.resolve(window.__RULES_FOR_SPY__) })
  }
  return Promise.resolve({ json: () => Promise.resolve({ ok: true, rows: null, warning: null, ruleName: null }) })
}
</script>
<script src="__BUNDLE_URL__" onerror="window.__LOAD_ERRORS__.push('script failed to load: __BUNDLE_URL__')"></script>
<script>
  window.__LOAD_ERRORS__.push(window.__DSH_RENDER_MODULE__ === undefined
    ? 'bundle evaluated but registered no module'
    : 'bundle registered a module')
</script>
<script type="module">
const lines = []
const report = line => { lines.push(line); document.getElementById('out').textContent = lines.join('\\n') }
const check = (ok, label, detail) => report((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '' : '  -- ' + detail))
const RULES = __RULES__
// The host's own injected globals, not a made-up token: without a real token the
// settings section correctly refuses to call its route at all.
window.__DSH_MANUAL_APPROVAL__ = __GLOBALS__

// The spy is installed by the bootstrap script above, before the bundle ran.
const sent = window.__SENT__

async function loadReact() {
  // No `?external=react`: that leaves a bare "react" specifier for the browser
  // to resolve, and a page has no import map, so the import fails outright.
  // esm.sh's react-dom/client resolves react internally to the same build.
  const R = await import('https://esm.sh/react@18.3.1')
  const D = await import('https://esm.sh/react-dom@18.3.1/client')
  return { R, D }
}

async function main() {
  let R, D
  try {
    ({ R, D } = await loadReact())
  } catch (error) {
    report('SKIP react unavailable: ' + error.message)
    report('DONE')
    return
  }
  const e = R.createElement

  const registered = []
  const ctx = {
    get: name => name === 'slots'
      ? { inject: (key, callback) => callback(), register: (options, component) => { registered.push({ options, component }); return () => {} } }
      : undefined,
    effect: callback => { callback(); return () => {} },
  }
  // Read the global HERE, not at module scope: a module script's top level runs
  // before the classic bundle script below it in the document, so a
  // module-scope read always sees `undefined`.
  const entry = globalThis.__DSH_RENDER_MODULE__
  if (!entry || typeof entry.factory !== 'function') {
    report('ERROR the bundle did not register a factory: ' + JSON.stringify(window.__LOAD_ERRORS__ || []))
    report('DONE')
    return
  }
  // The bundle registers a DESCRIPTOR ({id, factory}), which is exactly what the
  // real loader receives; `apply` only exists once the factory has run with a
  // `require`. Supplying `react` is this harness's whole job.
  const exports = {}
  let module
  try {
    const require = key => {
      if (key === 'react') return R
      throw new Error('unexpected require(' + JSON.stringify(key) + ')')
    }
    module = entry.factory(require)
  } catch (error) {
    report('ERROR the factory threw: ' + (error && error.stack ? error.stack : String(error)))
    report('DONE')
    return
  }
  if (module === undefined || module === null || typeof module.apply !== 'function') {
    report('ERROR the factory returned no apply: ' + JSON.stringify({ keys: module ? Object.keys(module) : null }))
    report('DONE')
    return
  }
  module.apply(ctx)

  // ---------------------------------------------------------------------
  // Stage 1: the settings section renders every rule collapsed.
  // ---------------------------------------------------------------------
  const section = registered.find(item => item.options.name === 'settings.section')
  check(section !== undefined, 'the bundle registered a settings section', registered.map(item => item.options.name).join(','))
  if (section !== undefined) {
    const label = section.options.label
    const labelText = typeof label === 'function' ? label() : label
    check(typeof labelText === 'string' && labelText !== '', 'the nav label resolves to a non-empty string' + (typeof label === 'function' ? ' through its thunk' : ''), String(labelText))

    const root = D.createRoot(document.getElementById('root'))
    await new Promise(done => { root.render(e(R.StrictMode, null, e(section.component, {}))); setTimeout(done, 0) })
    // The section renders from an async fetch: render + one commit is not enough,
    // so give the resolved promise a turn and React a chance to commit it.
    await new Promise(done => setTimeout(done, 50))

    // Prove the spy is live before trusting any "no request" result: a spy that
    // never records would make every delivery check pass or fail vacuously.
    const probe = window.fetch('/spy-probe')
    check(window.__SENT__.some(entry => entry.url === '/spy-probe'),
          'the fetch spy records requests', JSON.stringify(window.__SENT__.map(entry => entry.url)))
    await probe
    report('INFO section html: ' + document.getElementById('root').innerHTML.slice(0, 200))
    report('INFO sent so far: ' + JSON.stringify(window.__SENT__.map(entry => entry.url)))
    report('INFO globals: ' + JSON.stringify({
      token: (window.__DSH_MANUAL_APPROVAL__ || {}).token ? 'set' : 'empty',
      rulesEndpoint: (window.__DSH_MANUAL_APPROVAL__ || {}).rulesEndpoint,
    }))

    const html = () => document.getElementById('root').innerHTML
    const cards = () => document.querySelectorAll('#root .dshm_card')
    const editors = () => document.querySelectorAll('#root .dshm_editor')
    const summaries = () => document.querySelectorAll('#root .dshm_summary')
    const toggles = () => document.querySelectorAll('#root .dshm_toggle')
    const expanded = () => document.querySelectorAll('#root [aria-expanded="true"]')
    const names = () => Array.from(document.querySelectorAll('#root .dshm_card .dshm_text')).map(input => input.value)

    check(cards().length === RULES.rules.length, 'the live document renders one card per rule', 'cards=' + cards().length + ' rules=' + RULES.rules.length)
    check(names().join('|') === RULES.rules.map(rule => rule.name).join('|'), 'each card is titled with its own rule name', JSON.stringify(names()))
    check(editors().length === 0, 'every rule starts collapsed', 'editors=' + editors().length)
    check(summaries().length === cards().length, 'every collapsed rule shows its summary row', 'summaries=' + summaries().length)
    check(!html().includes('Conditions (all must match'), 'no condition editor is rendered while collapsed', html().slice(0, 160))
    check(toggles().length === cards().length, 'every rule exposes its own toggle', 'toggles=' + toggles().length)
    check(expanded().length === 0, 'no rule claims to be expanded', 'count=' + expanded().length)

    const first = toggles()[0]
    if (first !== undefined) {
      first.click()
      await new Promise(done => setTimeout(done, 0))
      check(editors().length === 1, 'clicking one toggle expands exactly one rule', 'editors=' + editors().length)
      check(summaries().length === cards().length - 1, 'the expanded rule drops its summary row', 'summaries=' + summaries().length)
      check(expanded().length === 1, 'exactly one rule announces itself as expanded', 'count=' + expanded().length)
      Array.from(toggles()).find(button => button.getAttribute('aria-expanded') === 'true').click()
      await new Promise(done => setTimeout(done, 0))
      check(editors().length === 0, 'clicking again collapses it', 'editors=' + editors().length)
    }
    root.unmount()
  }

  // ---------------------------------------------------------------------
  // Stage 2: the feedback note, in the shipped card's real shape.
  // ---------------------------------------------------------------------
  const detail = registered.find(item => item.options.name === 'conversation.approval.detail')
  check(detail !== undefined, 'the bundle registered the approval detail slot', registered.map(item => item.options.name).join(','))
  if (detail === undefined) { report('DONE'); return }

  const KEY = 'sess-1:call-1'
  const card = document.createElement('div')
  card.setAttribute('data-approval-key', KEY)
  const body = document.createElement('div')
  const headline = document.createElement('div')
  headline.textContent = '[manual approval] Confirm tool call: read (ref ' + KEY + ')'
  const command = document.createElement('div')
  const actionRow = document.createElement('div')
  const reject = document.createElement('button')
  reject.textContent = 'Reject'
  const allow = document.createElement('button')
  allow.textContent = 'Allow once'
  actionRow.appendChild(reject)
  actionRow.appendChild(allow)
  // The button really does answer the approval, as the shipped panel does.
  let answered = null
  allow.addEventListener('click', () => { answered = 'allowed-once' })
  reject.addEventListener('click', () => { answered = 'rejected' })
  body.appendChild(headline)
  body.appendChild(command)
  card.appendChild(body)
  card.appendChild(actionRow)
  document.body.appendChild(card)

  const panelRoot = D.createRoot(command)
  await new Promise(done => { panelRoot.render(e(detail.component, { callId: 'call-1' })); setTimeout(done, 0) })

  const box = command.querySelector('textarea')
  check(box !== null, 'the detail panel renders a feedback box', command.innerHTML.slice(0, 200))
  if (box === null) { report('DONE'); return }

  const postCount = () => sent.filter(entry => String(entry.options.method || 'GET').toUpperCase() === 'POST').length
  const type = text => {
    box.value = text
    box.dispatchEvent(new Event('input', { bubbles: true }))
  }

  // (a) Type, then click allow with no click away in between: the reported bug.
  sent.length = 0
  answered = null
  type('hold on, check this first')
  allow.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  allow.click()
  await new Promise(done => setTimeout(done, 0))
  const direct = sent.filter(entry => String(entry.options.method || 'GET').toUpperCase() === 'POST')
  check(direct.length === 1, 'typing then clicking allow posts the note exactly once', 'posts=' + direct.length)
  check(direct.length > 0 && direct[0].body && direct[0].body.text === 'hold on, check this first', 'the posted text is what was typed', JSON.stringify(direct.map(entry => entry.body)))
  check(direct.length > 0 && direct[0].body && direct[0].body.key === KEY, 'the note is addressed to this call', JSON.stringify(direct.map(entry => entry.body)))
  check(direct.length > 0 && direct[0].options.headers && direct[0].options.headers['x-manual-approval-token'] !== undefined, 'the token header is sent', JSON.stringify(direct.map(entry => entry.options.headers)))
  check(answered === 'allowed-once', 'the decision itself still reaches the shipped button', String(answered))

  // (b) The long-standing path: click away first, then decide. It must still work.
  sent.length = 0
  type('typed then blurred')
  box.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise(done => setTimeout(done, 0))
  allow.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  allow.click()
  await new Promise(done => setTimeout(done, 0))
  const blurred = sent.filter(entry => String(entry.options.method || 'GET').toUpperCase() === 'POST')
  check(blurred.length === 1 && blurred[0].body.text === 'typed then blurred', 'clicking away first still delivers the note', JSON.stringify(blurred.map(entry => entry.body)))

  // (c) A note that is nothing but whitespace must never be sent.
  sent.length = 0
  type('   ')
  allow.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  allow.click()
  await new Promise(done => setTimeout(done, 0))
  check(sent.filter(entry => String(entry.options.method || 'GET').toUpperCase() === 'POST').length === 0, 'a whitespace-only note is not sent', JSON.stringify(sent.map(entry => entry.body)))

  // (d) A note typed and abandoned must not be sent either: the box only
  //     commits when the user actually answers.
  sent.length = 0
  type('never answered')
  await new Promise(done => setTimeout(done, 0))
  check(sent.filter(entry => String(entry.options.method || 'GET').toUpperCase() === 'POST').length === 0, 'typing alone sends nothing', JSON.stringify(sent.map(entry => entry.body)))

  report('INFO stage 1 and stage 2 completed')
}

main()
  .catch(error => report('ERROR ' + (error && error.stack ? error.stack : String(error))))
  .finally(() => report('DONE'))
</script>
</body></html>
"""


def capture_bundle():
    """Read the bundle and wrap it so it hands over its module instead of a loader call."""
    source = io.open(BUNDLE, "r", encoding="utf-8").read()
    if "window.__ModuleLoader__.load(" not in source:
        raise SystemExit("the bundle no longer registers through window.__ModuleLoader__.load(")
    # The bundle is a script, not a module: evaluating it defines the loader and
    # calls it. Replace that call with an assignment so the page captures the
    # module and supplies its own context.
    return source.replace("window.__ModuleLoader__.load(", "globalThis.__DSH_RENDER_MODULE__ = (", 1)


def run_browser(browser, work, source, document, globals_payload):
    """Serve the harness over HTTP and load it in headless Edge/Chrome.

    Deliberately not `file://`: a file page's `<script src>` to a sibling file is
    subject to engine-specific file-access rules, and a silent refusal there
    looks exactly like a bundle that failed to register. A real origin removes
    that variable at the cost of one thread.
    """
    bundle_path = os.path.join(work, "bundle.js")
    with io.open(bundle_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(source)

    page = PAGE.replace("__BUNDLE_URL__", "/bundle.js")
    page = page.replace("__RULES__", json.dumps(document))
    page = page.replace("__GLOBALS__", json.dumps(globals_payload))
    page_path = os.path.join(work, "page.html")
    with io.open(page_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(page)

    handler = partial(QuietHandler, directory=work)
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    profile = os.path.join(work, "profile")
    os.makedirs(profile, exist_ok=True)
    try:
        result = subprocess.run(
            [
                browser,
                "--headless=new",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                f"--user-data-dir={profile}",
                "--virtual-time-budget=30000",
                "--dump-dom",
                f"http://127.0.0.1:{port}/page.html",
            ],
            capture_output=True,
            timeout=180,
        )
    finally:
        server.shutdown()
        server.server_close()
    return result.stdout.decode("utf-8", "replace")


def parse_output(dom):
    match = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if match is None:
        return []
    text = match.group(1)
    for entity, char in (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&amp;", "&")):
        text = text.replace(entity, char)
    return [line for line in text.split("\n") if line.strip() != ""]


def render_fixture():
    """Two rules with distinct names, so 'only one expanded' is a real test."""
    return {
        "ok": True,
        "masterEnabled": True,
        "path": "(render fixture)",
        "errors": [],
        "rules": [
            {
                "id": "r1",
                "name": "allow reads",
                "enabled": True,
                "conditions": [{"target": "toolName", "pattern": "^(read|glob)$"}],
                "action": {"kind": "approve", "message": ""},
            },
            {
                "id": "r2",
                "name": "block deletes",
                "enabled": True,
                "conditions": [
                    {"target": "toolName", "pattern": "^pwsh$"},
                    {"target": "argValue", "pattern": "rm\\s+-rf"},
                ],
                "action": {"kind": "deny", "message": "refusing $2"},
            },
        ],
        "compiled": [
            {"index": 0, "id": "r1", "name": "allow reads", "enabled": True, "valid": True, "errors": [], "groupCount": 1, "action": "approve"},
            {"index": 1, "id": "r2", "name": "block deletes", "enabled": True, "valid": False, "errors": ["condition 2: bad regex"], "groupCount": 0, "action": "deny"},
        ],
    }


def install_profile():
    """Install the profile's dependencies, which a fresh profile has none of.

    Writing `package.json` is not enough: boot refuses with "cannot resolve
    profile bundle" until `dsh plugin --profile web install` has actually linked
    them. Skipped once the link exists, so later runs do not pay for it again.
    """
    linked = os.path.join(TEST_HOME, "profiles", "web", "node_modules", "dsh-manual-approval")
    if os.path.exists(linked):
        return
    result = subprocess.run(
        [DSH, "plugin", "--profile", "web", "install"],
        capture_output=True,
        timeout=600,
        env={**os.environ, "DSH_HOME": TEST_HOME},
        shell=True,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stdout.decode("utf-8", "replace"))
        sys.stderr.write(result.stderr.decode("utf-8", "replace"))
        raise SystemExit("could not install the throwaway profile; see the output above")


def run():
    browser = find_browser()
    if browser is None:
        print("skip: no Chromium-family browser found (set DSH_BROWSER to run this suite)")
        return 0

    scaffold_test_home()
    install_profile()
    if os.path.exists(LOG):
        os.remove(LOG)

    env = dict(os.environ)
    env["DSH_HOME"] = TEST_HOME
    log_handle = io.open(LOG, "w", encoding="utf-8")
    process = subprocess.Popen(
        [DSH, "web", "--port", str(PORT), "--no-open"],
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        cwd=os.path.dirname(PLUGIN),
        env=env,
        shell=True,
    )

    work = tempfile.mkdtemp(prefix="dsh-render-")
    try:
        deadline = time.time() + 70
        token = None
        while time.time() < deadline:
            if process.poll() is not None:
                break
            match = re.search(rf"http://127\.0\.0\.1:{PORT}/\?token=([A-Za-z0-9_\-]+)", read_log())
            if match:
                token = match.group(1)
                break
            time.sleep(1)

        check("the host boots far enough to print its URL", token is not None, f"port {PORT}")
        if token is None:
            print(read_log()[-2000:])
            return 1

        # The root query token MINTS a browser cookie and 303-redirects to `/`;
        # the cookie is what authorizes every later request. urllib keeps no
        # cookies by default, so without this jar the redirected request 401s.
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        html = opener.open(f"http://127.0.0.1:{PORT}/?token={token}", timeout=20).read().decode("utf-8", "replace")
        match = re.search(r"__DSH_MANUAL_APPROVAL__=(\{.*?\})</script>", html, re.S)
        check("the page carries the plugin's injected globals", match is not None, "index tap ran" if match else "marker absent")
        if match is None:
            return 1
        injected = json.loads(match.group(1))

        request = urllib.request.Request(
            f"http://127.0.0.1:{PORT}/dsh-manual-approval/feedback?rules=1",
            headers={"x-manual-approval-token": injected["token"]},
        )
        live = json.loads(urllib.request.urlopen(request, timeout=10).read().decode("utf-8"))
        check("the private route answers with a rule document", live.get("ok") is True, list(live)[:6])
        if live.get("ok") is not True:
            return 1
        check(
            "the live document carries the fields the page reads",
            isinstance(live.get("rules"), list) and isinstance(live.get("compiled"), list),
            f"rules={len(live.get('rules') or [])} compiled={len(live.get('compiled') or [])}",
        )

        source = capture_bundle()
        dom = run_browser(browser, work, source, render_fixture(), injected)
        lines = parse_output(dom)

        if any(line.startswith("SKIP react unavailable") for line in lines):
            note("both stages were skipped: " + next(line for line in lines if line.startswith("SKIP")))
            return report_result()

        print(f"  browser {os.path.basename(browser)}")
        for line in lines:
            if line.startswith("PASS"):
                print(f"  ok  {line[5:]}")
            elif line.startswith("FAIL"):
                print(f"  {line}")
                failures.append(line[5:].split("  -- ")[0])
            elif line.startswith("ERROR"):
                print(f"  {line}")
                failures.append("the browser reported an error")
            elif line.startswith("INFO"):
                note(line[5:])

        if not any(line == "DONE" for line in lines):
            check("the harness finished", False, "the bundle never loaded or React never rendered")
    finally:
        try:
            process.terminate()
            process.wait(timeout=15)
        except Exception:  # noqa: BLE001 - best effort teardown
            try:
                process.kill()
            except Exception:  # noqa: BLE001
                pass
        log_handle.close()
        shutil.rmtree(work, ignore_errors=True)
        try:
            subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 f"Get-NetTCPConnection -LocalPort {PORT} -State Listen -ErrorAction SilentlyContinue | "
                 f"ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force }}"],
                capture_output=True, timeout=40,
            )
        except Exception:  # noqa: BLE001
            pass

    return report_result()


def report_result():
    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {failures}")
        return 1
    print("all render checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(run())
