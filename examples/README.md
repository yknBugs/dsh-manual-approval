# examples

`rules.example.json` is a ready-to-edit copy of the rule document. The plugin
stores its own copy at:

```
<DSH_HOME>/manual-approval/rules.json
```

Use the settings page (**Settings → Manual mode rules**) to edit it; copying this
file over that path is equivalent and useful for seeding a fresh install.

Every rule here starts `enabled: false` except the first, so importing the file
changes nothing until you turn a rule on.

## 1. Warn on a recursive delete of a root or a system tree

Three conditions, all of which must match:

| Target | Purpose |
| --- | --- |
| `toolName` = `^(pwsh\|bash)$` | only shell calls |
| `argValue` = a recursive-delete flag | `rm -rf`, `Remove-Item -Recurse`, `rd /s`, … |
| `argValue` = a root-ish operand | a bare drive root, `%SystemRoot%`, `C:\Windows`, `/`, `--no-preserve-root` |

The action is `warn`, so the call still comes to you — but the approval card
carries the warning in red. That is the intended shape for a pattern you cannot
judge mechanically with certainty: it forces attention without pretending to be
an authority.

Note that the escape-heavy patterns are JSON-escaped regexes: in the editor you
type `C:\\` where the JSON shows `C:\\\\`.

## 2. Deny an encoded shell payload

`-EncodedCommand`, `FromBase64String`, `Invoke-Expression` and `iex` mean the
command cannot be reviewed by reading it. Denying is the documented answer when
the *shape* of the call defeats review, rather than guessing at its content.

The denial reads exactly like one you typed yourself, because both go through one
formatter.

## 3. Allow read-only inspection tools

`read`, `glob` and `grep` are not the calls manual review is protecting. Allowing
them keeps the mode livable.

> A rule whose only condition is `toolName` = `.*` with the `approve` action,
> placed first, makes Manual behave exactly like Full access. That is intended —
> it is the escape hatch, and it is why rule order is editable.

## 4. Ask a local judge

Posts the call as JSON to a service you run and reads the verdict back:

```jsonc
// request body (the default when the body field is empty)
{"pwsh":{"command":"Remove-Item -Recurse C:\\tmp","description":"Clean temp"}}

// any of these responses decide the call
{"result":{"decision":"approve","why":"scoped to a temp path"}}
{"result":{"decision":"deny","why":"outside the workspace"}}
{"result":{"decision":"ask","why":"target is ambiguous"}}
```

`decisionPath` and `reasonPath` are dot/bracket paths into the response
(`result.decision`, `choices[0].verdict`, …).

If **anything** goes wrong — host unreachable, non-2xx status, body not JSON,
path missing, value not one of `approve`/`deny`/`ask` — the rule degrades to a
red warning showing the concrete error and the call still comes to you. A judge
never fails open.
