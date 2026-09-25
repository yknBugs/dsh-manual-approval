# scripts

Not part of the published package (`package.json` ships only `lib`,
`cordis.patch.yml` and the docs). Everything here supports testing and the one
repair this plugin's authoring session had to perform.

## Tests

```sh
npm test                                                          # all five offline suites
npm run test:boot                                                 # real harness boot (needs dsh)
npm run test:render                                               # real browser + real React (needs Edge/Chrome)
node scripts/selftest-client.mjs                                  # browser half against a fake DOM
node scripts/selftest-apply.mjs                                   # plugin shape + apply + gate
node scripts/selftest-rules.mjs                                   # rule engine
node scripts/selftest-judge.mjs                                   # judge transport
node --import ./scripts/register-stub.mjs scripts/selftest.mjs    # host-half internals
python scripts/verify-render.py                                    # real browser, real React
```

### `verify-render.py` — the browser half in a real browser

The Node suites drive `lib/client.js` with a hand-written hook runtime: they call
components by hand and stub `useState`, and their fake DOM only gained a real
`closest()` after a live bug slipped through. That is enough for logic, but it
cannot prove what real React and a real DOM do.

This suite boots a real host, reads the rule document from its private route, and
then opens the real bundle in headless Edge/Chrome to assert:

- the settings section renders one **collapsed** row per rule, expanding exactly
  one at a time through a real click and a real React state update;
- a note typed into the approval panel reaches the host when the user types and
  clicks allow **without clicking away first** — the failure this suite exists
  for. It mounts the shipped card's actual shape (`data-approval-key` → card →
  body with the panel, plus a **sibling** action row holding the buttons) and
  spies on `fetch` to see exactly what the plugin sent.

That sibling relationship is the whole point: the panel is not an ancestor of
the buttons, so resolving it by walking *up* from the clicked button can never
work, and roughly a hundred green unit checks did not notice.

Skips with exit 0 when no Chromium-family browser is installed, or when esm.sh
is unreachable for React.

### `selftest-client.mjs` — the browser half

Loads `lib/client.js` with fakes for `window`, `document` and `React`, then
asserts what the browser would otherwise only reveal as a red banner in the UI:

- the bundle loads and exposes `apply` / `inject`;
- **every selector it builds is valid CSS** — the check that was missing when a
  malformed `style[data-plugin-css=""…""]` selector (doubled quotes, from
  `JSON.stringify` *inside* an already-quoted attribute selector) reached users as
  `failed to apply loader entry`;
- the style tag is installed exactly once, even across repeated `apply`;
- both slots register, the settings section carries its id and label, `apply`
  returns a disposer, and it survives a missing slot service;
- the detail panel claims its **single** slot at a priority that shadows the
  shipped occupant, and a slot rejection warns instead of throwing out of `apply`.
  The fake slot registry models "one registration per priority, lowest renders"
  and throws on a taken pair, so those two checks are real rather than vacuous;
- **both dictionaries carry identical keys**, no value is empty, and the Chinese
  copy is genuinely translated (a key still matching English fails, except the
  four placeholder-only keys);
- both dictionaries register through the locale service, a locale failure warns
  instead of breaking activation, and **no user-visible prose is left hardcoded**
  in the code region;
- the tool name is read from the approval headline when the shipped card passes
  only `{ callId }`, and an explicit `toolName` prop still wins;
- the primary button uses a theme token the theme actually defines;
- the detail panel renders the tool name, the argument rows and the feedback box;
- clicking a decision control posts the feedback **with the key read from the
  approval headline**; an empty box, an unrelated click and a failing `fetch` all
  behave.

The fake DOM keeps `dataset` and the `data-*` attributes in sync and searches head
and body, because a fake that did neither made this harness lie twice before it
told the truth.

### `selftest-apply.mjs` — the one that catches boot breakers

Applies the Host half against a fake Cordis context and asserts what otherwise
only shows up as "the harness will not start":

- the default export has `name` / `apply` / `inject`;
- `Config` is a **Standard Schema** — `Config['~standard'].validate()` exists,
  returns synchronously, and applies defaults. A plain defaults object there
  throws `Cannot read properties of undefined (reading 'validate')` during boot
  and takes the whole plugin tree down;
- `apply` mounts without throwing and registers the private route, the page tap,
  the gate, post-execute and the cleanup listeners;
- the route refuses a non-loopback peer and a missing token;
- a manual-mode call asks and then runs when allowed, a non-manual session is
  untouched, a missing approval service fails closed, a rule can allow without
  asking, a rule denial is byte-identical to a user denial, and a warn rule
  carries its warning to the panel.

The fake context models Cordis faithfully where it matters: an injected
dependency appears as `ctx.<name>` **and** resolves through `ctx.get`, and
`inject` resolves through `ctx.get` too. An earlier version of this fake did
neither, and the false confidence it produced is exactly why this plugin first
shipped a boot-breaking bug.

### `verify-boot.py` — real boot, real route

Starts a throwaway profile on its own port and checks the plugin actually
functioned, not merely that the process started:

1. the harness boots and prints its URL;
2. the page is served — note the root `?token=` **mints a browser cookie and
   303-redirects**, so the client must keep cookies;
3. the plugin's page globals are injected (the index tap ran);
4. the private route answers 403 without a token and returns the rule snapshot
   with one — a 403 proves the Host half mounted, a 404 proves it did not;
5. a deliberately broken regex round-trips as reported-but-unusable.

It boots with `DSH_HOME` pointed at a throwaway profile under the system temp
directory, so it never touches a real profile. See
[Running the Python suites anywhere](#running-the-python-suites-anywhere).

`selftest-rules.mjs` pins the rule semantics: validation (an invalid regex cannot
be enabled and says why), group counting, target matching for tool name /
parameter name / parameter value, AND across conditions, first-match-wins
ordering, the master switch, capture extraction from the combined document,
`$1`/`${N}` substitution, JSON paths, every judge-response failure mode, header
parsing, and the on-disk store's round trip, error reporting and normalization.

`selftest-judge.mjs` runs a real loopback HTTP server and drives the judge
transport against it: request method/headers/body, GET omitting the body,
unreachable host, non-2xx, non-JSON, an oversized and an over-declared response,
a hung endpoint timing out, credential redaction, and signal degradation.

`selftest.mjs` covers the Host half's pure logic: argument-line rendering and its
caps, the approval headline and the `(ref …)` key the browser half parses back
out, call-key construction, manual-mode detection including subagent
inheritance, cycle and depth termination, the one shared decision formatter, and
the pending-store's bounds, TTL and consumption semantics.

`register-stub.mjs` links a throwaway `node_modules/@deepseek-ai/dsh-llm` to a
minimal local stub so `lib/index.js` can be imported from this checkout. The
plugin itself imports **no** packages, so this shim never applies at runtime.

## Tarball helper

`pack-dir.mjs <source-dir> <target-tgz>` packs a directory into an npm-style
tarball (`package/…` entries, POSIX separators, gzip).

The other session-repair helpers that used to live here (a placeholder-tarball
builder, its restorer, and an installer verifier) were removed: they referenced
one machine's absolute profile path and a different plugin's tarball, so they
were neither portable nor this package's concern.

## Running the Python suites anywhere

Both `verify-boot.py` and `verify-render.py` derive every path from their own
location and create their throwaway profile on first run, so a fresh clone works
on any machine at any path. Two environment variables adjust them:

| Variable | Effect |
| --- | --- |
| `DSH_TEST_HOME` | where the throwaway profile lives (default: a `dsh-manual-approval-testhome` directory under the system temp dir) |
| `DSH_BIN` | the `dsh` executable to boot (default: `dsh` on `PATH`) |
| `DSH_BROWSER` | the Chromium-family browser `verify-render.py` should drive |

Deleting the throwaway home is always safe; the next run rebuilds the profile and
re-installs its dependencies.

