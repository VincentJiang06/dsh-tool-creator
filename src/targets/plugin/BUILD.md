# Target pack: `plugin` — build a real dsh plugin, and verify it like one

You are reading this because your dispatch prompt named this file as the BUILD CONVENTION for the
current run's build target. It is authoritative for **what the artifact IS, where its files go, and
what the harness is**. It is not a role charter and it does not compete with one: your role pack
(`roles/engineer.md`) still owns the judgment — red-first, layered evidence, evaluator
calibration, pre-registered stops. Where this pack and the Structure Contract disagree about a
path, the CONTRACT wins and the disagreement is a FINDING you report; where this pack and your role
pack appear to disagree about discipline, your role pack wins.

A dsh plugin is **an npm package that DeepSeek Harness loads into a Cordis composition**. Not a
folder of scripts, not a skill with code in it: a publishable ESM package with a `dsh` declaration,
a Cordis wiring module, and a unit suite that runs with no harness installed. The reference this
pack is modeled on is `dsh-web-search-serper` — a plugin that was verified to load in dsh. Every
convention below is that package's convention.

`<WS>` below is the workspace root your prompt gave you; `<WS>/build` is the build directory.
Nothing you write ever leaves `<WS>/build` and `<WS>/artifacts`.

---

## 1. The artifact tree

The package root IS `<WS>/build`. `package.json` sits at `<WS>/build/package.json`, not one level
down.

```
<WS>/build/
  package.json                     REQUIRED. the npm manifest + the `dsh` declaration (§3)
  cordis.patch.yml                 REQUIRED — every plugin ships at least the insert stanza (§4)
  README.md                        REQUIRED. install, configure, use, limits
  LICENSE                          REQUIRED. MIT, full text, real year + holder line
  lib/<domain>.js                  REQUIRED. PURE logic — ZERO @deepseek-ai imports (§2)
  lib/index.js                     REQUIRED. Cordis wiring — imports the seams (§2)
  test/unit/<area>.test.js         REQUIRED. node --test, over the pure module only (§5)
  test/fixtures/<class>/<case>.input.json     REQUIRED. one input per case
  test/fixtures/<class>/<case>.expected.json  REQUIRED. its pinned oracle, beside it
  evals/run_harness.sh             REQUIRED. THE harness (§6)
  evals/cases.json                 REQUIRED. the case index (§6)
  evals/red/<name>.log             REQUIRED. red-light output, captured before green exists
```

Split `lib/` further if the contract commissions it (`lib/normalize.js`, `lib/request.js`, …) — the
rule is not the file count, it is the seam line in §2. Every Structure Contract `content_ref` that
contains a slash and a file extension must exist here on disk when you return; the conductor
re-runs the structure gate fail-closed.

---

## 2. The seam line — the single most load-bearing rule of this target

Two kinds of module live under `lib/`, and the difference is mechanical:

- **Pure logic** (`lib/<domain>.js`, one or more files): option resolution, request building,
  response normalization, parsing, error mapping, redaction. It may import `node:` builtins and its
  own siblings. It imports **NOTHING** from `@deepseek-ai/*`. This is what the unit suite tests,
  and it is testable precisely because it runs outside a Harness installation.
- **Cordis wiring** (`lib/index.js`): imports the `@deepseek-ai/*` seams — the settings section,
  the credentials service, the launch environment, the capability it registers into, the real error
  class — resolves configuration, and hands the pure logic everything it needs by INJECTION.

Why the line is drawn there: the seam packages resolve only inside a dsh installation, so anything
that imports them cannot be executed by `npm test`. Everything you want proven must therefore sit
on the pure side, and the wiring side must stay thin enough to be reviewable by inspection.

Mechanical consequences you must satisfy:

- At least one file under `lib/` has no `@deepseek-ai/` import (else there is nothing to unit-test).
- At least one file under `lib/` DOES import `@deepseek-ai/*` (else you built a library, not a
  plugin, and dsh has nothing to mount).
- No test file may import `lib/index.js`, directly or transitively. If it does, `npm test` fails on
  an unresolvable peer dependency the moment the gate runs it in a clean tree.
- Where the pure module needs a class it cannot import (the harness's real error type), define a
  local stand-in with the identical constructor shape and let `lib/index.js` inject the real one.
  That is the reference's pattern, and it keeps error mapping unit-testable.

`lib/index.js` exports the Cordis surface: `name` (the plugin name Loader diagnostics print),
`inject` (the capabilities it requires, when it requires any), `Config` (the runtime schema for its
settings, when it takes settings), and `apply(ctx, config)` — the function Cordis calls to register
the plugin. Re-export the pure module's public names from `lib/index.js` so consumers have one
entry point.

`lib/index.js` MUST carry a **VERIFICATION LIMIT** comment at the top, in plain words: that because
this file imports the `@deepseek-ai/*` peer dependencies, none of it is exercised by `npm test`,
that the unit suite targets the pure module only, and that the wiring is proven by inspection
against a reference implementation until the dsh integration stage runs. An honest limit note is a
dossier-grade fact; a silent one is the green-but-wrong shape this whole pipeline exists to catch.

### 2.1 Load-time invariants dsh enforces (these CANNOT be caught offline)

The wiring layer is the one part of the package `npm test` cannot exercise — the pack says so
honestly two paragraphs up, and that honesty has a price: every invariant dsh checks when it LOADS
the plugin has to be carried here as a written rule, because the alternative is discovering it as a
crash in a real boot. This section is the accumulating list of those invariants. Follow every rule
in it literally. Each one is here because a build that satisfied every offline gate still failed at
load.

**Invariant 1 — `Config` must be a Standard-Schema object, never a plain object.**

Cordis validates a plugin's config at load time with:

```js
// @deepseek-ai/cordis/lib/index.js:957
const result = runtime.Config["~standard"].validate(config);
```

A plain object has no `"~standard"` property, so `Config["~standard"]` is `undefined` and reading
`.validate` throws before your `apply()` ever runs. The whole plugin tree fails, and the message
looks like this:

```
dsh: plugin tree failed to load: failed to apply loader entry tool-<slug> (dsh-tool-<slug>):
Cannot read properties of undefined (reading 'validate')
```

If you see that message, this is what it is. Nothing in `npm pack --dry-run`, `npm test`, the
golden-pair replay, or a package-shape check can produce it, because none of them load the plugin.

So, mechanically:

- If the plugin takes settings: `import z from '@deepseek-ai/schemastery';` and
  `export const Config = z.object({ /* fields */ });`.
- If the plugin takes NO settings: either omit the `Config` export entirely, or
  `export const Config = z.object({});`.
- NEVER `export const Config = {}`, never `Object.freeze({})`, never a hand-rolled object with a
  `validate` method you wrote yourself. The gate-proven reference
  (`dsh-web-search-serper/lib/index.js`) uses `z.object({...})` from `@deepseek-ai/schemastery`,
  which implements `"~standard"`. Copy that, not a shape that merely looks harmless.

**Invariant 2 — every `@deepseek-ai/*` package `lib/index.js` imports must appear in
`peerDependencies`.**

That includes `@deepseek-ai/schemastery` the moment `Config` uses it. A seam that is imported but
not declared as a peer resolves to nothing inside the harness installation, and the plugin fails at
load for the same class of reason as Invariant 1: the import is fine on disk and fatal on boot.
Cross-check the import list at the top of `lib/index.js` against `peerDependencies` in `package.json`
(§3) line by line before you return; the two lists must match. Declaring a seam as a peer is what
makes it resolve to the HARNESS's instance rather than a private copy.

(Do not be misled by the reference package: `dsh-web-search-serper` lists `@deepseek-ai/schemastery`
under `dependencies`, and either placement loads in a normally-installed deployment. But this
pipeline grades `npm test` in a tree with NO `node_modules` and NO install step (§8), where a
`dependencies` entry is neither installed nor resolvable — `peerDependencies` is the placement
verified against a real dsh boot here, and it is what this pack requires.)

**Invariant 3 — every OBJECT schema a tool declares must set `additionalProperties` explicitly.**

The host validates every registered tool's parameter and output schemas at boot and REJECTS an
object schema that does not carry an explicit `additionalProperties: true` or `false` — the boot
error says exactly that. Nothing offline produces it: `npm test`, `npm pack --dry-run` and the
golden-pair replay all pass a schema that will kill the real boot. (Field origin: the
dsh-mp-automator build hit three defects that ONLY a real boot could surface; this was one.)
Mechanically: when you write `{ type: 'object', properties: {...} }` anywhere in a tool
declaration, write `additionalProperties: false` beside it in the same edit, every time.

**Invariant 4 — dependency discipline on `@deepseek-ai/*`: never `dependencies`, and "optional"
must be real.**

Two field incidents, one rule each:

- A `@deepseek-ai/*` seam listed under regular `dependencies` installs a PRIVATE copy inside the
  plugin. The host then runs TWO instances of that package (e.g. two `dsh-tools`), and the failure
  surfaces far from the cause, at runtime, as broken tool dispatch — observed live as
  `Cannot read properties of undefined (reading 'prepare')` followed by
  `tool_calls must be followed by tool messages`. The deployment-side workaround is a pnpm
  override; the correct fix is that the plugin never does this. Seams are `peerDependencies`,
  period (Invariant 2 says why they resolve at all; this says why `dependencies` actively breaks
  a working host).
- A peer marked optional in `peerDependenciesMeta` that `lib/index.js` imports UNCONDITIONALLY is
  a lie with a delay: on a deployment without that package the whole profile boot dies with
  `ERR_MODULE_NOT_FOUND` — every plugin in the profile, not just yours. If the import is
  unconditional, the peer is a hard requirement: declare it so, and say in the README that
  installing the plugin may require `dsh plugin add <peer>`. Mark a peer optional ONLY when the
  code path that imports it is itself conditional.

**Verify before you claim done.** You cannot run a real dsh boot from inside the sandbox, so there
is no evidence available to you that these invariants hold. Therefore: (a) follow the rules above
literally rather than reasoning about whether a given shape "should" work, and (b) record `E-L4`
wiring as `not_run` in the dossier with the reason — exactly as §7's `E-L4` row already requires. A
green `E-L4` you did not observe is a fabricated verdict, and these two invariants are precisely
the failures such a green would hide.

---

## 3. `package.json` — required keys, and the `dsh` field

```json
{
  "name": "dsh-<slug>",
  "description": "<one line: what it registers into dsh, and with what>",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./<domain>": { "default": "./lib/<domain>.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/<domain>.js", "cordis.patch.yml", "README.md", "LICENSE"],
  "scripts": { "test": "node --test test/unit/*.test.js" },
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "publishConfig": { "access": "public" },
  "keywords": ["deepseek-harness", "dsh-plugin", "<domain>"],
  "license": "MIT",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" },
  "dependencies": {}
}
```

- **`type: "module"`** — dsh plugins are ESM. A CommonJS package is rejected.
- **`dsh`** is the field that makes the package a PLUGIN rather than an ordinary npm library: it is
  how dsh recognizes it, and how `dsh plugin --profile <p> add <name>` knows what to compose.
  `dsh.bundle.patch` is a package-relative path to the Cordis patch (§4) that is applied as its own
  layer when the bundle is installed, and removed when the package is removed. Declare it. A
  package with no `dsh` field is not a plugin, however good its code is.
- **`peerDependencies`** carry every `@deepseek-ai/*` seam `lib/index.js` imports (`cordis`, and
  whichever `dsh-*` packages you use: credentials, launch-environment, settings, and the capability
  package itself). They are peers because they must be the HARNESS's instances, not private copies.
- **`dependencies`** stay EMPTY unless a standalone library is genuinely bundled at runtime. They
  are never needed by the unit suite: the gate runs `npm test` in a tree with no `node_modules` and
  performs no install, so a test that needs an installed dependency is a red gate.
- **`scripts.test`** is `node --test test/unit/*.test.js`. No test framework, no runner dependency.
- **`license`** is `MIT`, matched by a real `LICENSE` file.

---

## 4. `cordis.patch.yml`

A YAML list of row patches applied to the composition when the bundle is installed. Two shapes,
both from the reference:

```yaml
# 1. select this plugin inside an existing row's config
- id: <existing-row-id>
  config:
    <selector>: <this-plugin-id>

# 2. mount this plugin's own row beside the base bundle's rows
- insert:
    - id: <plugin-row-id>
      name: '<package-name>'
```

Comment each stanza with what it does and what removing the bundle restores. If your plugin patches
no existing row, it still ships the `insert` stanza — that is the row that mounts it.

---

## 5. The unit suite

- `node --test` only, files named `test/unit/<area>.test.js`, using `node:assert/strict` and
  `node:test`. Nothing else.
- It imports the PURE module and only the pure module.
- **No network, ever.** Inject the transport (a `fetch`-shaped function, a client object) into the
  pure logic and pass a stub in tests. A test that reaches the internet is non-deterministic, and
  the L0 gate re-runs it. A separate `test/live.mjs` for a manual, key-requiring smoke run is
  allowed — it must NOT be part of `scripts.test`.
- **Table-driven over golden pairs**: the suite loads `test/fixtures/<class>/<case>.input.json`,
  runs the pure function, and deep-compares against `<case>.expected.json`. Inline assertions are
  allowed in addition to, never instead of, the pinned pairs.
- Cover, at minimum: the identity/registration constants, request construction, response
  normalization (including rows that must be DROPPED), error mapping for each error class, and
  secret redaction if the plugin handles a credential — an error message or log line that can leak
  a key is a named failure class and it needs its own fixture.

---

## 6. The evaluation harness

**The harness command for a plugin target is `npm test`** — the unit suite over the pure logic is
what proves the plugin works. But `verification.harness_path` must name a FILE: the L0 gate
resolves it relative to `<WS>/build`, requires it to exist, and dispatches it by extension
(`.sh`/`.py`/`.js`/`.mjs`) or by the executable bit. **Do NOT record the bare string `npm test`
there — it is not a file and the gate fails closed.**

So: wrap the command in `<WS>/build/evals/run_harness.sh` and record

```
verification.harness_path = "evals/run_harness.sh"
```

(relative to `<WS>/build`; an absolute path is also accepted). The script runs from `<WS>/build` as
its working directory and must, in order:

1. `npm pack --dry-run` — packaging/manifest soundness (this is your `E-L0` evidence; it is offline);
2. `npm test` — the unit suite;
3. any golden-pair replay not already covered by step 2, reading `evals/cases.json`;
4. print one line per layer with `passed/total`, plus case id, expected and produced for each
   failure;
5. exit `0` if and only if every required case passed — propagate a non-zero exit from any step,
   and do not swallow it.

It must be deterministic, offline, self-contained, and finish well inside 120 seconds (the gate's
timeout). The gate RE-RUNS it: a second run that disagrees with the exit code you recorded fails the
stage.

`evals/cases.json` is the case index. One entry per case:

```json
{"id": "escaping/quote-inside-value",
 "layer": "E-L1",
 "eval_kind": "capability",
 "failure_class": "escaping",
 "spec_source": "build_spec.failure_cost#2",
 "input": "test/fixtures/escaping/quote-inside-value.input.json",
 "expected": "test/fixtures/escaping/quote-inside-value.expected.json",
 "compare": "deep-equal"}
```

`spec_source` points at the upstream SkillSpec field that named this failure class, or the string
`brainstormed` for a class you added yourself. It is what makes "one fixture per named class"
checkable by someone who is not you.

Red logs live in `evals/red/`; their paths go into `red_light_history.red_artifact_path`, resolved
relative to `<WS>/build`, and the file must be non-empty — its size is measured.

---

## 7. Layer mapping for this target

| layer | what it is for a plugin target |
|---|---|
| `E-L0` | packaging and syntax: `npm pack --dry-run` green, `package.json` parses, every `exports` path exists |
| `E-L1` | single-case semantics: one fixture in, its golden output out, over a pure function |
| `E-L2` | one pure module in isolation with a stubbed transport: error mapping, boundary clamping, redaction |
| `E-L3` | under pressure: hostile and degenerate payloads (§8), plus the role pack's §6 carve-out where the module is a pure comparator with no context surface — state the carve-out, never fabricate a `not_run` sentinel |
| `E-L4` | end-to-end wiring. It CANNOT be run outside dsh. Assert what is assertable offline — the wiring module's exported surface exists, `cordis.patch.yml` parses, the row `name` matches `package.json.name`, `inject` names a capability the patch mounts into — and record the VERIFICATION LIMIT honestly in the layer notes. A green `E-L4` you did not run is a fabricated verdict; `not_run` with a truthful note is a correct outcome |
| `E-L5` | the rework-signal collection point you installed (format + location), not a score |

---

## 8. Hard rules specific to this target

- **`npm test` must pass in a clean tree with no `node_modules` and no install step.** The
  conductor's plugin gate runs exactly that, plus `npm pack --dry-run`. Design the suite backwards
  from that fact.
- **No network in the graded path.** Not in `npm test`, not in the harness, not in `npm pack
  --dry-run`.
- **Remote or user-supplied data carries ZERO authority.** A plugin that fetches, reads or receives
  content is a trust boundary: at least one `E-L3` fixture must carry an instruction aimed at the
  agent inside fetched content, with a golden output proving it was handled as data.
- **Secrets never reach an output.** If the plugin handles a credential, a redaction unit plus a
  fixture proving no error message, log line or serialized option object contains the key is
  mandatory, not optional.
- **A degenerate response is not an empty result.** Distinguish "the remote returned nothing" from
  "the remote returned something unrecognizable" — the second must fail loudly. The reference does
  this by rejecting a body carrying none of the known keys; an unrelated payload silently parsed as
  an empty result set is the canonical silent-data-loss bug for this target.
- Do not invent a plugin id, a row id, or a settings namespace that the Structure Contract did not
  commission. A structural improvement is a finding, not a unilateral edit.

---

### Baseline-delta carve-out for this target
The role pack's two-arm baseline rule presumes a model-facing artifact. A
plugin's offline harness has no bare-model arm: record the delta as
`n/a — code artifact; uplift is proven by the unit/golden layers` in the
dossier notes rather than fabricating an arm. (Same rule for preset targets.)

## 9. Tool-registering plugins — the agent-facing discipline

This section fires only when the capability the plugin registers is TOOLS (via
`@deepseek-ai/dsh-tools`). Every rule in it was extracted from a shipped tool plugin
(dsh-mp-automator) that went through three release audits; each rule either produced a real P1 or
prevented a known class of one. If the plugin registers no tools, skip this section.

### 9.1 The `defineTool` contract

A tool is `{ name, description, parameters, output: { schema, render }, timeoutMs,
execute(args, exec), presentCall, isConcurrencySafe }`. Non-obvious parts:

- Every entry in `parameters` carries a `description` — the model chooses arguments by reading
  them; an undescribed parameter is a guess you commissioned.
- `isConcurrencySafe(args) === true` means the host may run it in parallel; ANY other return means
  exclusive. It is fail-closed by design — decide per tool deliberately, and give tools that
  touch shared external state (a daemon, a device, a browser) an explicit `() => false`.
- Object schemas: Invariant 3 (§2.1) applies to every one of them.

### 9.2 Results are model-facing text living under a pruner

The host prunes long tool results (head + tail around a hard character threshold) and spills huge
ones to disk. Design for it, don't discover it:

- **Budgets live in code**: byte-clamp every result below the pruner's threshold yourself, and
  when the clamp bites, SAY so in the output ("truncated at NB — ask for a narrower view").
  A silently pruned result reads as complete and is the quiet ancestor of wrong verdicts.
- **Self-contained results**: never "see above" / "as shown earlier" — long sessions get
  compacted and the referent disappears. Each result must stand alone.
- **Compaction-safe wording**: state facts as past events ("an identical image was attached
  earlier this session"), never as claims about the current context ("the image is still in your
  context") — the second becomes false the moment the host prunes old turns.

- **Template-token hygiene (v4-pro)**: the DeepSeek chat template assigns
  meaning to `<｜…｜>` special-token sequences (DSML). A tool result that
  contains such a sequence — echoed file content, scraped text, error output —
  collides with the wire grammar. Scan every model-facing string for the
  two-character prefix `<｜` and replace or reject it, disclosed.

### 9.3 State keying — ask what the state is a property OF (field P1)

One plugin instance serves MANY sessions in the dsh host. Before caching anything in `apply()`'s
closure, answer one question: is this a property of the PROJECT (disk state, build freshness, a
per-directory bridge) or of the SESSION'S CONTEXT (what this conversation saw, was billed, was
told)?

- Project property → `Map` keyed by cwd. Correct: the fact is true for every session.
- Context property → `WeakMap` keyed by the session object (`exec.agent.session`), so the state
  dies with the session. cwd-keying a context property makes the tool LIE to fresh sessions —
  the shipped incident: a new conversation's first screenshot was told "the image is already in
  your context" because another session in the same directory had attached it.

### 9.4 Never mirror host- or daemon-owned mutable state

If an external system invalidates or renumbers handles invisibly (reconnect, navigation, a second
client attaching), no plugin-side mirror or generation counter can win — the invalidation you
cannot observe is the one that kills you. Change the addressing model instead: re-resolve from a
stable key (a selector, a name, a path) INSIDE one exclusive tool call, and let no volatile handle
cross a tool-call boundary. If the model must see handles (as reading labels), say in the tool
output that they must never be fed back in.

### 9.5 Failure text is half the contract

- Parsing is fail-closed: only strict `ok === true` is success; a missing document, a null, an
  `ok` that is truthy-but-not-true — all refusals.
- Map every known failure code to a REMEDY line ("what to do next"), and grow that map from live
  incidents — a remedy map that never changes after release is one nobody is feeding.
- Three disclosure classes that must never blur, each with distinct wording: **deliberate
  economy/skip** ("not attached — token economy") vs **attempted-and-failed** ("attaching failed:
  <why> — fallback below") vs **capability-unknown** ("capability unknown — the artifact is on
  disk but NOT in context"). A model that cannot tell these apart will either retry economy skips
  forever or trust failures silently.
- Never utter a capability claim the host did not confirm on THIS call: "this route CAN receive
  images" is speakable only after `resolveModelInfo` actually listed `image` — not because the
  operator's config suggests it.

### 9.6 Expensive attachments need an economy

Anything the tool ATTACHES to the context that re-bills on every later request (images above all)
gets three mechanisms, in this order: content-hash dedupe (unchanged payload → skip, free,
disclosed as economy), a per-session budget (clamped non-negative integer; `0` = disabled with a
deliberate message; junk input falls back to the default, never to unlimited), and an honest
exhaustion message that names the billing reason. The cheap artifact (a fact table, a path) always
ships regardless.

### 9.7 Modality is per-route, and text is the default reality

Image capability must be gated per call: `await llm.resolveModelInfo(provider, model)` and check
`inputModalities`. The deepseek adapter hardcodes `['text']`; pi-ai providers derive modalities
from the operator's hand-declared `model.input`. So design BOTH paths from day one — a text path
that carries the full assertion power (structured facts any model can check) and an attach path
that adds pixels on routes that declared them — and make the result say which path fired. A
text-only model that "took a screenshot" it can never see will describe what it imagines.

### 9.8 Driving an external CLI

- **stderr is half the contract**: CLIs print thrown errors to stderr, and `execFile` embeds child
  stderr inside `error.message`. Therefore parse structured output from BOTH streams FIRST, and
  only if neither parses classify the failure — structurally (`error.killed`, `ETIMEDOUT`,
  `ENOENT`, `ABORT_ERR`), never by message-substring matching, which the embedded stderr will
  defeat.
- **Negotiate the CLI version at first use** against an explicit semver window (e.g.
  `>=0.2.0 <0.3.0`), cache the probe, and refuse outside the window with an upgrade hint. An
  unversioned bridge fails as a stream of misparses instead of one clear refusal.

### 9.9 README for a tool plugin

Order it by the reader's path: what it is (with a transcript) → how it works (layer diagram) →
quick start → tool table → why to trust it → configuration → troubleshooting (error code →
remedy, mirroring §9.5's map) → design notes. When the plugin's domain audience is the Chinese
ecosystem (WeChat, 小程序, domestic platforms), the README is bilingual with 中文 leading.
