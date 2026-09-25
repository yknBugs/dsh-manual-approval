# dsh-manual-approval

[中文说明](./README_ZH.md)

A fourth permission mode for **DeepSeek Harness**: **Manual**. Every tool call —
including a plain file read, a `grep`, a `glob`, or a web search — opens an
approval card first. You see the tool name, every argument on its own line, and
an optional feedback box; your decision is the only thing that lets the call run.

## Why

The three shipped modes each make one trade-off for you:

| Mode | Sandbox | Approval |
| --- | --- | --- |
| Read Only | `read-only` | on demand |
| Workspace Write | `workspace-write` | on demand |
| Full access | `danger-full-access` | never |

"On demand" means a tool decides when to ask, and a tool that does not ask runs
immediately. "Never" means nothing asks at all. Manual closes that gap: not one
tool decides — you decide, every single time, with the arguments in front of you.

## What Manual does

- **Every call is confirmed.** The plugin returns `ask` for *all* tool calls in a
  Manual session, before any other pre-execute listener can answer.
- **The model changes nothing.** No elevation parameter, no extra field, no
  different call shape. Tool arguments are byte-identical to any other mode.
- **No sandbox.** Manual bundles `danger-full-access`, so an approved call has
  full execution authority, including writes outside the workspace. There is no
  platform-specific code in this plugin — it works the same on Linux, macOS and
  Windows.
- **Arguments are shown, not summarised.** The detail panel lists one line per
  argument. For shell tools it also shows the model's own one-line `description`
  of what the command does.
- **Optional feedback per call.** Whatever you type in the feedback box is
  attached to that call's result, as a note when it was allowed and as the
  rejection reason when it was denied. So your reasoning reaches the model in the
  place it is acting on.
- **Fail closed.** Closing the card, having no approval path, or an approval
  error all mean the call does *not* run.

## Install

Installing adds the package, links the plugin into the profile, and applies the
bundle's patch. The new preset and the Host gate take effect on the **next**
profile start: restart `dsh web` (or your profile) after installing.

```sh
dsh plugin --profile web add dsh-manual-approval
```

Or from a checkout:

```sh
git clone <this repo> dsh-manual-approval
dsh plugin --profile web add ./dsh-manual-approval
dsh --profile web --dump-config   # verify composition
```

Then pick **Manual** in the permission selector, or run `/permission manual`.

To remove it:

```sh
dsh plugin --profile web remove dsh-manual-approval
```

### Verifying an install

```sh
npm test                     # the offline suites
npm run test:boot            # boots a real `dsh web` on a throwaway profile
```

`dsh --profile web --dump-config` is the composition check; look for the
`manual-approval` row and for `id: permission` marked as patched by
`dsh-manual-approval`.

### What installing changes

The package ships its own `cordis.patch.yml` (`dsh.bundle.patch`), so installing
it is enough — you never edit the host composition by hand. The patch does two
things:

1. republishes the `permission` preset table with `manual` added **first**, so
   the selector shows Manual at the top;
2. inserts this plugin's Host half.

> **Compatibility note.** Entry 1 restates the built-in presets so the table is
> complete. If a future Harness release adds a fifth built-in preset, this file
> must be updated to include it. Removing the plugin removes the patch with it.

## Automatic rules

While Manual is the active mode, each call is first checked against your own
ordered rule list (**Settings → Manual mode rules**). The first matching rule
decides; with no match, the call opens the normal approval prompt.

A rule is a list of **conditions** (all must match) plus one **action**.

Each condition picks one target and one regular expression:

| Target | The regex is tested against |
| --- | --- |
| Tool name | the whole tool name, e.g. `^pwsh$` |
| Parameter name | each argument name in turn, e.g. `^(command\|cmd)$` |
| Parameter value | each argument value in turn, e.g. `rm\s+-rf` |

Conditions never need to escape JSON: `file_path` matches a parameter *name*,
`C:\Users` matches a path *value*.

| Action | Effect |
| --- | --- |
| **Allow** | the call runs immediately, no prompt |
| **Deny** | the call does not run; its reason is returned to the model |
| **Warn at approval** | still asks you, but shows your text in red in the card |
| **Network judge** | POSTs the call to your endpoint and applies its verdict |

A **catch-all rule** — one condition, target Tool name, pattern `.*`, action
Allow, placed first — makes Manual behave exactly like Full access. That is the
escape hatch, and it is why rules are reorderable.

### Reason text and capture groups

A rule's reason (or warning) may reference capture groups as `$1`, `$2`, … or
`${12}`; `$$` is a literal `$`. Groups are numbered **globally across the rule's
conditions**, in condition order and left to right, and the settings page shows
each condition's group numbers next to its pattern so you never have to count
them.

Values are taken from one combined JSON document built from the whole call,
because a captured parameter may come from any part of it:

```json
{"cwd":"<session working directory>","<toolName>":{"<argName>":"<argValue>", ...}}
```

`cwd` is present only when the session reports one, and always comes first. There
is no `{cwd}` placeholder to write: it is simply a field of the document, so a
pattern may match it like any other value.

So a pattern like `"command":"([^"]+)"` can capture the command text even though
its own condition matched a parameter name. A group whose pattern does not match
that document contributes an empty string.

### Rule denials are indistinguishable from yours

An automatic denial goes through **the same formatter** as a denial you type in
the approval card, so the model cannot tell a rule's rejection from a hand-written
one. There is no "automatic denial" marker anywhere in the tool result.

### Language

The approval panel and the settings page ship **English and Simplified Chinese**
copy, registered through the DSH locale service (`ctx.locale`), so they follow the
language chosen in **Settings → General → Language** — switching it re-labels the
page and the card without a reload. English is the fallback for any key the active
language misses, and it also answers when no locale service is composed at all, so
the UI is never keyless.

Rule *patterns* and the technical field names stay as they are: a regular
expression and a JSON path are not prose.

### Network judge

The judge runs **in the Host process**, not the browser. That matters: Node has
no same-origin policy, so `http://127.0.0.1:…`, a plain-`http` intranet service,
or an endpoint without permissive CORS headers all work. A browser `fetch` would
fail on CORS and mixed content, and routing it through the page would turn the
Harness into an open proxy.

- `POST` with `content-type: application/json` by default; method, headers and
  body are all editable.
- The default body is the combined JSON document above; an override may use
  `$1`, `$2`, ….
- `decisionPath` (required) and `reasonPath` (optional) are dot/bracket paths
  into the response — `result.decision`, `choices[0].verdict`, ….
- The decision value must be `"approve"`, `"deny"` or `"ask"`, corresponding to
  Allow, Deny and Warn at approval.
- The reason from `reasonPath` is a literal string: it is **not** run through
  capture substitution.
- **Any** failure — unreachable host, non-2xx, invalid JSON, missing path,
  unexpected value, timeout, over-large body — falls back to a red warning
  showing the concrete error, and the call still comes to you. A judge can only
  ever ask; it never fails open.
- Credentials written into the URL (`http://user:pass@host/`) are stripped from
  every message, warning and log line. Note that Node's `fetch` refuses such
  URLs outright, so send a token as a header instead.

Rules live at `<DSH_HOME>/manual-approval/rules.json`, written atomically, and
are re-compiled on every read. A rule with a syntax error is kept on disk and
reported in the settings page rather than being silently dropped, and it cannot
be enabled until it is valid. A master switch disables the whole list at once.
See [`examples/`](./examples) for a ready-to-edit document, including a warning
pattern for destructive recursive deletes.

## Security of the private channel

The feedback box and the settings page need a Client → Host path, and the shipped
approval outcome vocabulary is four fixed strings with nowhere to carry text.
This plugin adds one private loopback HTTP route instead.

What that route exposes, and what it does not:

- The page is given exactly two values: a **per-process random token** and a
  fixed route path. No model or provider credentials, no API keys, no
  environment variables, no session content, and no Host objects are ever sent to
  the browser by this plugin.
- The route **requires a loopback peer address and that token**. The token exists
  because a DSH web server may bind `0.0.0.0`; without it, another machine on the
  network could forge approval feedback or rewrite your rules.
- It moves short strings and the rule document between the Host and its own page:
  it never reads files outside `<DSH_HOME>/manual-approval/`, never touches
  credentials, and never returns Host state.
- Judge URLs and judge headers stay on the Host; the browser never learns them.
- Entries are deleted when their call settles and swept by age.

If your composition has no `webServer`, the plugin still gates every call and
rules still work; only feedback delivery and the settings page are disabled.

## What Manual does not claim

- **It is not a classifier.** Manual has no built-in opinion about whether a call
  is dangerous. It guarantees a human saw it, or that one of *your* rules decided.
  Approving without reading remains the failure mode this design cannot prevent.
- **A rule is only as good as its pattern.** A rule that allows too much is
  indistinguishable from Full access; a rule that warns too much trains you to
  click through. Rules are yours to get right, which is why the settings page
  shows group numbers, refuses to enable an invalid pattern, and evaluates in the
  order you set.
- **A prompt is not a substitute for reading.** The whole value here is that the
  arguments are laid out for you before you click.
- **Approval-parameter misuse is opt-in policed.** Manual mode makes
  `sandbox_permissions`/`justification` meaningless. Set `strictGuard:
  'bypass-guard'` in the plugin config to deny any Manual-mode call that still
  carries them.
- **Out-of-process agents are outside the boundary.** Codex, ACP and SDK
  providers run their own tool loops and their own permission controls.
- **Direct Node filesystem work by other Host plugins** never passes through
  `ctx.tools` and so is never gated here.
- **A network judge is a remote authority you chose.** Its verdict is applied
  as-is, in the Host process, with the trust you extend to that endpoint. Write
  credentials as headers rather than in the URL, and keep the endpoint on a host
  you trust as much as the Harness itself.

## Configuration

All optional, in the host row config:

```yaml
- id: manual-approval
  name: 'dsh-manual-approval'
  config:
    presetName: manual                              # the preset key that activates this policy
    feedbackPath: /dsh-manual-approval/feedback     # loopback route for feedback + rules
    rulesFile: ''                                   # override the rules.json path
    strictGuard: 'off'                              # or 'bypass-guard'
    debug: false                                    # log each decision
```

## Design

See [DESIGN.md](./DESIGN.md) for the exact seams, the decision order, and the
rule engine's semantics.

## License

MIT
