# dsh-pipeline-executor — implementation spec (L1 contract)

npm package `dsh-pipeline-executor`, independently published, generically
useful: a dsh plugin that runs a declarative multi-agent pipeline manifest
with per-role confinement, mechanical gates, and a machine-written evidence
ledger. dsh-tool-creator is its first consumer. Everything in
`../../src/targets/plugin/BUILD.md` applies to this package itself —
including §2.1 boot invariants and §9 tool discipline.

## Tools (all `isConcurrencySafe: () => false`)

### `pipeline_stage({ stage, attempt })`
Runs ONE stage of the manifest end-to-end inside the tool call:

1. Load + validate the manifest (fail-closed; schema below). Manifest path
   comes from plugin config, resolved relative to the plugin row's
   composition dir (preset-dir-relative — travels with the copy).
2. Resolve the stage row. `attempt` (default 1, max 1+retries from manifest)
   selects retry behavior: on attempt>1 the dispatch prompt appends the
   pointer to `gate-logs/<stage>.attempt<n-1>.log` (feedback via filesystem,
   never inline paste).
3. Dispatch the role subagent(s) via the host `subagents` registry, spawn
   provider:
   - `persona` = the role pack file's full text (read at dispatch time from
     the manifest's preset-relative path) + a trailing DISPATCH CONTEXT block
     (workspace paths, target, artifact path) rendered from
     `dispatch.promptTemplate`.
   - `toolFilter` = the stage's `role.tools` whitelist, verbatim.
   - `agentOptions` = {provider, model, maxTokens} from stage row (defaults
     from manifest.defaults).
   - `outputSchema` = the JSON schema file named by the stage (object-rooted;
     validated at load).
   - Fanout stages (battery): dispatch each lens sequentially or with a small
     concurrency cap (config `maxConcurrentDispatches`, default 2), then the
     synthesis dispatch which receives the lens outputs' ARTIFACT PATHS (lens
     outputs are written to `artifacts/battery-lens-<lens>.json` by the
     executor from the structured returns — the model never relays them).
4. Write the stage artifact: the role's structured output is written by the
   EXECUTOR to the manifest's `artifact` path (the role also builds files
   under build/ itself via its tools; the JSON artifact is executor-written
   to kill the "model wrote different bytes than it returned" class).
5. Run the gate: `execFile` the manifest's argv (no shell), cwd = workspace,
   capture both streams to `gate-logs/<stage>.attempt<n>.log`. A `then`
   second command runs only if the first exits 0.
6. Append ONE evidence-ledger line (see format) — write is mandatory; a
   ledger-write failure fails the tool call (evidence is not optional).
7. Return (byte-clamped ≤4000B, self-contained):
   `stage=<id> attempt=<n> gateExit=<code> artifact=<path> childSessions=<ids> ledger=<line-no>`
   plus on failure the last ~20 lines of the gate log. NEVER the role's
   prose.

### `pipeline_status({})`
Read-only: manifest sha256, stages completed this session (from the ledger),
workspace paths. No dispatch, no gate.

## Evidence ledger (`evidence-ledger.jsonl`, append-only)
One JSON object per stage attempt:
`{ts, pipeline, manifestSha256, stage, attempt, childSessionIds[], artifactPath, artifactSha256, gateExit, gateLogPath, gateLogSha256, roleModel, durationMs, tokens?}`
- `tokens` filled iff the host tokenMeter is resolvable (`ctx.get` — optional,
  absence disclosed as `tokens: null`, never fabricated).
- All hashes computed by the executor from disk bytes.

## Config (schemastery z.object, all keys explicit)
- `manifestPath` (string, default `manifest/pipeline.manifest.json`)
- `maxConcurrentDispatches` (number, clamped int 1–4, default 2)
- `dispatchTimeoutMs` (number, default 1_800_000)
State rules per BUILD.md §9.3: anything keyed by conversation state uses the
session object (WeakMap); the manifest cache is keyed by resolved path+mtime
(project property).

## Error taxonomy (every code carries a remedy line)
`MANIFEST_INVALID` (fail-closed parse/schema, name the field) ·
`STAGE_UNKNOWN` · `ATTEMPT_EXCEEDED` (stage's retry budget spent — the
conductor must STOP, not loop) · `DISPATCH_FAILED` (subagents.start threw —
include provider error verbatim) · `ROLE_NO_OUTPUT` (child settled without
structured output — treated as gate-red, ledgered, NOT retried silently) ·
`GATE_SPAWN_FAILED` (validator binary missing — remedy: install python3 /
check preset copy integrity) · `LEDGER_WRITE_FAILED`.

## Hard rules
- Only strict structured output counts; a child's text prose is logged to
  gate-logs but never parsed for results (fail-closed, BUILD.md §9.5).
- The executor never edits build/ or artifacts/ content beyond writing the
  structured artifact + ledger + gate logs (its own write surface is
  enumerable and tested).
- No network. No shell strings — argv arrays only.
- Sanitize dispatch-prompt interpolations for `<｜` sequences (DSML collision,
  v4-pro research) — reject with MANIFEST_INVALID naming the offending file.

## Tests (node --test, fake `subagents` + fake execFile injected via config
seam `_seams` — functions only, config-file values can never replace them)
1. Happy path: manifest→dispatch→gate→ledger, all fields present.
2. Confinement: dispatch request carries exactly the whitelist toolFilter +
   persona bytes = role-pack file bytes (hash compare).
3. Fail-closed: missing artifact / non-zero gate / child no-output → correct
   codes, ledger still written.
4. Retry semantics: attempt 2 prompt carries the gate-log pointer; attempt
   beyond budget → ATTEMPT_EXCEEDED.
5. Fanout: 5 lens dispatches + synthesis receives paths not payloads.
6. MUTATIONS (each must kill): (a) ledger write disabled → tests red;
   (b) toolFilter dropped from request → confinement test red; (c) gateExit
   hardcoded 0 → fail-closed test red.

## Open item from spike E1'
The exact `subagents.start` request field shapes (persona/toolFilter nesting,
parent acquisition, empty-toolFilter behavior) come from the spike report —
builder must reconcile this spec against it and record deviations in
.loop-state/DECISIONS.md.

## Deviations (G1a build, 2026-08-17 — SPIKE-FINDINGS wins over SPEC where they conflict)

1. **Request shape follows SPIKE verbatim.** `subagents.start('spawn', {label,
   prompt: [content-block], parent (guarded), signal (REQUIRED, combined with
   the dispatchTimeoutMs via AbortSignal.any), persona, toolFilter: {allow:
   [...]} OBJECT form, agentOptions: {provider, model, maxTokens} only,
   outputSchema})`; `descriptor` is never passed. Settle = allSettled on
   run.result then dispose (spike pattern); success = `stopReason ===
   'completed'` AND `structured` present — child TEXT is never parsed.
2. **toolFilter pre-validation (SPIKE deviation 2).** `run_code` in a manifest
   whitelist is always rejected; when the live tool list is enumerable, an
   unknown tool name is rejected BEFORE dispatch. Both map to
   MANIFEST_INVALID with a deployment-flavored remedy (SPEC's "clear
   MANIFEST/DEPLOYMENT error") rather than a child-start crash.
3. **`{{TARGET}}` source was undefined in SPEC.** The promptTemplates consume
   it ("Build target kind"), so `pipeline_stage` gained an OPTIONAL `target`
   string parameter; absent → rendered as `unspecified` (honest, never
   guessed). Additive to the SPEC tool signature.
4. **Lens outputSchema is not in the manifest.** Lens dispatches use a
   permissive object-rooted schema `{type:'object', properties:{},
   additionalProperties:true}` (explicit additionalProperties per SPIKE
   deviation 4); the stage's `dispatch.outputSchema` binds the SYNTHESIS
   dispatch only. An ADDITIVE optional manifest field
   `fanout.lensOutputSchema` overrides the permissive default.
5. **Ledger `error` field (additive).** DISPATCH_FAILED / ROLE_NO_OUTPUT /
   GATE_SPAWN_FAILED attempts are ledgered before the tool call fails,
   carrying `error: <code>` (null on ledgered successes, including red
   gates). Pre-flight refusals (MANIFEST_INVALID, STAGE_UNKNOWN,
   ATTEMPT_EXCEEDED) are NOT ledgered — nothing was dispatched.
6. **A red gate is a reported outcome, not a tool error** (per SPEC's return
   format): the tool returns `gateExit=<n>` plus the log tail; only the
   executor-failure taxonomy throws.
7. **Config gained `baseDir`** (test fallback; production carries an absolute
   value via a `!!js` baseUrl expression — see README). `manifestPath` may
   also be absolute, in which case it is used as-is.
8. **Deviations recorded here** (this section) per the L1 build instruction,
   superseding this file's older pointer to `.loop-state/DECISIONS.md`.
9. **Env hygiene for gate subprocesses is deferred to G1b:** the default
   execFile inherits the parent env (no `scrubbedParentEnv` — that seam
   lives in `@deepseek-ai/dsh-subprocess`, an extra peer this package does
   not yet declare). Open risk, recorded below in G1b terms.

## 0.1.1 polish deviations (2026-08-17, post-G1b)

10. **`{{PRESET_DIR}}` template variable (additive).** The dispatch-prompt
    vocabulary gained `PRESET_DIR` = the executor's RESOLVED ABSOLUTE
    `baseDir`, so prompts can spell out preset-shipped commands absolutely
    (closes coherence finding G3-F3: the skill target pack's §5 promises the
    engineer dispatch prompt carries the two validator self-check commands).
11. **Ledger `tokens` is a NUMBER (or null), not `read()`'s shape.** G1b
    proved the host meter is `tokenMeter.measure(session, requestHeader?)`,
    not `read()`. The adapter measures each child's session
    (`run.localAgent.session`, in-process spawn run shape) between settlement
    and disposal and ledgers the SUM of `measure().totalTokens` — but only
    when EVERY child of the attempt measured; otherwise `null` (a partial sum
    is a wrong number). `requestHeader` is never passed (no guessed shapes).
    VERIFICATION LIMIT: proven against installed host source, not yet
    observed live (see lib/index.js).
12. **DISPATCH_FAILED remedy split.** When `subagents.start`'s error matches
    `tools.restrict` / `unknown global tool` (host `restrict()` refusing a
    whitelist name at child start), the remedy names the manifest-whitelist/
    deployment mismatch instead of the generic "check the spawn provider
    row". Same taxonomy code; `PipelineError` gained a remedy override.
13. **Offline fakes enforce Invariant 5.** `test/helpers.mjs` `mountTool`
    validates every mounted tool's execute return against its declared
    `output.schema` (additionalProperties-strict walk mirroring the host);
    the exact 0.1.0 G1b bug shape (runStage's rich result returned verbatim)
    is pinned as a regression test. The declared schema moved to the pure
    module (`TEXT_OUTPUT_SCHEMA` in lib/manifest.js) so fakes and wiring
    share one set of bytes.
