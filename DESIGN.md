# Design

`dsh-manual-approval` is a policy plugin, not an executor. It adds one preset
row to the official permission table and one gate to the official tool pipeline;
it owns no sandbox, no transport override, and no platform branch.

## Upstream seams used

Verified against Harness `0.1.5-rc.3`.

| Seam | Used for |
| --- | --- |
| `@deepseek-ai/dsh-permission-presets` | the preset table entry `manual`, and `ctx.permissionPresets.current(session)` to detect the active mode per session |
| `@deepseek-ai/dsh-sandbox` + `dsh-sandbox-policy` | `sandbox: 'danger-full-access'`, which the policy resolver passes through unconfined |
| `@deepseek-ai/dsh-tools` | the `tools/pre-execute` waterfall (the allow/deny/ask gate), `tools/post-execute` (attach context), `tools/result` (settle), and the optional monotonic `ctx.tools.guard()` |
| `@deepseek-ai/dsh-user-approval` | `ctx.approval.request(...)` and the exact `allowed-once` grant |
| `@deepseek-ai/dsh-client-ui-approval` | the `conversation.approval.detail` slot, declared by the shipped card as a child of its `conversation.composer` takeover with owner props `{ callId }` |
| `@deepseek-ai/dsh-host-webserver` | `register({ kind: 'exact', path, handler })` and `tapIndex(transform)` for the private feedback route |
| `@deepseek-ai/dsh-agent` + `dsh-session` | `session.header.origin === 'subagent'` and `session.header.parentSession` for inheritance |

## Permission integration

`cordis.patch.yml` republishes the preset table. Manual is first, because the
client renders options in table order.

| Preset | Sandbox | Approval |
| --- | --- | --- |
| **manual** | `danger-full-access` | `ask` |
| read-only | `read-only` | `ask` |
| workspace-write | `workspace-write` | `ask` |
| danger-full-access | `danger-full-access` | `never` |

`defaultPreset` is pinned to `workspace-write`. Installing a permission plugin
must not silently change what a fresh session is allowed to do; the user selects
Manual deliberately.

The two knobs do the work, which is why there is no elevation logic anywhere:

- `danger-full-access` → `ctx.sandboxPolicy.resolve()` yields an unconfined mode,
  so an approved call executes with the harness process's own authority.
- `approval: 'ask'` → the session policy does not short-circuit the request to
  `rejected`/`unavailable` before an answerer sees it.

## Decision order

1. **Mode detection.** `manualAuthority(exec, …)` checks the calling agent's
   session: `ctx.permissionPresets.current(session) === 'manual'`. If not, walk
   `session.header.parentSession` while `origin === 'subagent'` (cycle-guarded,
   bounded by the durable lineage) so official in-process children inherit the
   parent's Manual mode. Any other session is untouched.
2. **Eligibility.** A non-Manual execution returns `next()` immediately; other
   modes keep their shipped behavior exactly.
3. **Decision seam.** `decideManualCall()` returns `ask` | `allow` | `deny`.
   Today it always asks. This is the single function the follow-up rules work
   replaces.
4. **Argument publication.** The rows for the panel are stored under
   `<sessionId>:<callId>` *before* the ask, so the detail is available the moment
   the card renders.
5. **The ask.** `ctx.approval.request({ agent, toolName, callId, reason, signal })`
   with a short reason. Only `allowed-once` proceeds. `rejected` returns a denial
   that tells the model not to retry unchanged; `cancelled` and `unavailable`
   also deny, because an unanswered request is not a grant.
6. **The gate.** Returning `ask` from a `prepend: true` listener means no later
   pre-execute listener answers first, so a tool that would otherwise auto-allow
   still reaches the human.
7. **Settlement.** `tools/post-execute` attaches the user's feedback to the
   outcome as an `additionalContexts` user message; `tools/result` and
   `session/disposed` clear per-call state.

### Why the arguments do not ride the approval request

`ApprovalRequestEvent` is a fixed shape (`agent`, `toolName`, `callId`, `reason`,
`signal`) forwarded to the browser through a generated codec. Adding a custom
field risks codec rejection and is not a contract this plugin may extend. Instead:

- the reason ends with `(ref <sessionId>:<callId>)`, which the panel reads from
  the rendered headline;
- the panel `GET`s that key over the private route to receive the rows.

This keeps the approval contract untouched and the panel's data on a channel this
plugin owns.

## The feedback channel

The shipped `ApprovalOutcome` is `'allowed-once' | 'rejected' | 'cancelled' |
'unavailable'` — four strings, nowhere for text. So feedback travels on a route
the Host registers on `ctx.webServer`:

- `tapIndex` injects exactly `{ token, endpoint }` into the served page. The token
  is generated once per process and reused via `globalThis` so repeated HMR
  mounts do not invalidate a page already holding it.
- `GET  <path>?key=…` returns that call's argument rows.
- `POST <path>` stores feedback text for that call.

Both verbs require:

1. **a loopback peer address** — the `webServer` may bind `0.0.0.0`, and nothing
   legitimate reaches this route from another machine;
2. **the per-process token** in `x-manual-approval-token`.

Nothing else crosses. The route reads no credentials, touches no filesystem, and
returns no Host state; it accepts short strings into a bounded, age-swept map.

The browser half sends the feedback from a **capture-phase** click listener that
does not `stopPropagation`, so the note is committed in the same user action that
answers the approval while the official button (`拒绝` / `允许一次`) still performs
the decision. Delivery failure never blocks a decision.

### The panel is a sibling of the buttons, not an ancestor

The shipped approval card (`@deepseek-ai/dsh-client-ui-approval`) renders:

```
[data-approval-key]
  └ card
     ├ body      → headline, command  ← `conversation.approval.detail` renders HERE
     └ actionRow → Reject, Allow once
```

So the detail panel and the decision buttons are **siblings**. Resolving "which
panel does this button belong to" by walking *up* from the clicked element can
therefore never find it, and any code that assumed the panel contained the
buttons silently drops every note: the click is delivered, the lookup returns
null, and the failure looks like nothing happened.

`findPanel` resolves structurally instead — take the `[data-approval-key]` the
control belongs to, then look for the panel inside it, keeping the up-walk as a
fallback for a card that *does* nest them. A document-wide fallback is allowed
only when exactly one panel exists, so it can never attach a note to the wrong
call.

Two consequences are pinned by tests, because both were live defects:

- the Node suite builds this sibling shape explicitly (the fake DOM needs a real
  `closest()`; while it returned null the test was vacuous);
- `pointerdown` **and** `click` both fire for one real press, so the commit is
  deduplicated per panel and reset whenever the box's text changes. Without it,
  one answer delivered the same note twice.

## The rule engine

`lib/rules.js` is pure and dependency-free, so its semantics are pinned by unit
tests rather than by inspection. `lib/store.js` owns the on-disk document.
`lib/judge.js` owns the judge transport.

### Decision order

Within a Manual session, one call is resolved as:

1. **Rules, in order.** The first rule whose conditions all match is terminal:
   `approve` runs the tool, `deny` returns the reason, `warn` continues to the
   prompt carrying its warning, `judge` calls the endpoint and then applies that
   verdict. A rule match never falls through to a later rule.
2. **No match → the human.** The approval prompt opens, with any rule warning
   attached.

`approve` and a judge's `approve` skip the prompt entirely and record the call in
`approvedCalls`. Everything else reaches a human or a denial.

### Conditions

A condition matches ONE target, which is exactly the dropdown the settings page
shows:

| Target | Candidates, in order |
| --- | --- |
| `toolName` | the whole tool name |
| `argName` | each argument name |
| `argValue` | each argument value |

A condition holds when **any** candidate matches; the conditions of a rule are
combined with AND. This is why patterns never escape JSON: `file_path` targets a
parameter name and `C:\Users` targets a path value.

Values are rendered for matching as `String(value)` for primitives and
`JSON.stringify` for objects and arrays. Every candidate is length-bounded so a
pathological call cannot make matching expensive.

### Capture groups

Numbering is **global and sequential across the rule's conditions**, in condition
order and left to right, starting at 1. Group 0 (the whole match) is deliberately
not addressable.

Values come from a SECOND pass over one combined document:

```json
{"<toolName>":{"<argName>":"<argValue>", ...}}
```

so a group may name any part of the call, not only the text its own condition
matched. A pattern that does not match the document contributes empty strings for
its groups; the result is always padded to the rule's declared group count, so
`$k` is positionally stable regardless of which conditions matched.

`$1`..`$9` and `${N}` are substituted; `$$` is a literal `$`; an unknown `$x`
is left alone. `$12` means group 12 — `$1` followed by a literal digit needs
`${1}2`.

### Why a rule denial is not marked as automatic

`feedbackSentence()` is the single formatter for both a reason the user typed in
the approval card and a reason a rule produced. A rule denial therefore reaches
the model as the same sentence a hand-written denial would, and the model cannot
use the text to tell them apart. This is a deliberate requirement, not an
oversight: a distinguishable "automatic denial" would invite the model to argue
with the rule or route around it.

### Judge transport

`lib/judge.js` runs in the Host on purpose. Node has no same-origin policy, so a
loopback endpoint, a plain-`http` intranet service, or a host without permissive
CORS headers all work; a browser `fetch` would fail on CORS and mixed content,
and forwarding the URL from the page would make the Harness an open proxy.

Every failure — no `fetch`, unreachable host, non-2xx, invalid JSON, missing
path, value outside `approve|deny|ask`, a non-string reason, timeout, or an
oversized body — produces a `warn` decision carrying the concrete error. A judge
therefore cannot fail open, and cannot fail closed either: it degrades into a
question the user can still answer.

Capabilities are feature-checked rather than assumed: `AbortSignal.any` and
`AbortSignal.timeout` are each optional, and a missing `any` degrades to the
caller's signal instead of throwing.

Credentials embedded in a judge URL are stripped from every message, warning and
log line. Runtime errors quote the request — Node's `fetch` even rejects a
credential-bearing URL by reproducing it — so the sanitizer scrubs the
`//user:pass@host` form out of the error text itself, not just out of the URL the
plugin built.

### Persistence

`<DSH_HOME>/manual-approval/rules.json` holds the raw editor document:

```json
{ "version": 1, "masterEnabled": true, "rules": [ /* exactly what the editor submitted */ ] }
```

The plugin never rewrites the user's text. Compilation happens on read, so a rule
with a syntax error survives on disk, is reported to the editor with its reason,
and cannot be enabled until it is fixed. Writes are atomic (temp file + rename).
A damaged file reports its error and loads nothing rather than silently becoming
"no rules".

### Settings surface

The page registers into `settings.section` under its own id, so it is additive
beside the shipped sections. It edits the document through the same private
loopback route as the feedback box, which now serves three verbs:

| Request | Meaning |
| --- | --- |
| `GET ?rules=1` | the rule document plus per-rule validity and errors |
| `POST {rules}` | replace the document, recompile, answer with the fresh snapshot |
| `GET ?key=…` | one pending call's argument rows and rule warning |
| `POST {key,text}` | the approval panel's feedback |

## Invariants

- A Manual session never executes a tool call without an `allowed-once` outcome,
  an explicit `approve` decision, or a judge `approve`.
- No decision path fails open: a throw, a missing answerer, a withdrawn request,
  a missing approval service, and every judge failure either deny or ask.
- Rules are evaluated only for Manual sessions, and only in the order configured.
- An invalid rule is inert: it can never match, and it cannot be enabled.
- Session identity decides the mode; a session in any other mode is bit-for-bit
  unaffected.
- No platform branch exists in this repository; the plugin behaves identically on
  Linux, macOS and Windows.
- No credential, key, or Host object is sent to the browser by this plugin. The
  only page-injected values are a random token and a route path; judge URLs and
  judge headers stay on the Host.

## Coverage boundary

Gated: every call dispatched through the Harness tool registry, including
delegated in-process subagents that inherit the mode.

Not gated: out-of-process providers (Codex, ACP, SDK) which own their internal
tool loops; direct Node filesystem or process work performed by other Host
plugins outside `ctx.tools`; a compromised Harness runtime; and commands a user
launches outside Harness. Installed Host plugins already run trusted process code
and remain part of the trusted computing base.
