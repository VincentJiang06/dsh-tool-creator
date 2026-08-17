# dsh-pipeline-executor

> README stub — the full README (transcript, layer diagram, troubleshooting
> table) lands after G1b live verification. What is below is accurate now.

A [DeepSeek Harness](https://github.com/deepseek-ai) (dsh) plugin that runs a
**declarative multi-agent pipeline manifest**: each stage dispatches one or
more confined role subagents (persona + tool whitelist + output schema all
pinned by the manifest), the executor — never the model — writes the stage
artifact from the child's structured return, a mechanical gate (`execFile`
argv, no shell) passes verdict, and every attempt is recorded in an
append-only, machine-written evidence ledger (`evidence-ledger.jsonl`, all
sha256 computed from disk bytes). dsh-tool-creator is the first consumer.

## Tools

| tool | what it does |
|---|---|
| `pipeline_stage({stage, attempt?, target?})` | runs ONE manifest stage end-to-end: dispatch → executor-written artifact → gate → mandatory ledger line. Returns `stage= attempt= gateExit= artifact= childSessions= ledger=` facts (≤4000B); on a red gate, the gate-log tail. Never the role's prose. Since 0.1.2: when the stage's artifact basename is `decision-record.json` and the gate exited 0, the fact line additionally carries ` verdict=<battery_verdict>/<re_audit_verdict>` parsed from the executor-written record (fail-soft: omitted when unparseable/malformed, never guessed). |
| `pipeline_status({})` | read-only: manifest sha256, per-stage ledger evidence, this session's attempts, workspace layout. |

## Configuration

| key | default | meaning |
|---|---|---|
| `manifestPath` | `manifest/pipeline.manifest.json` | pipeline manifest; relative values resolve against `baseDir` |
| `baseDir` | `''` (harness cwd) | the preset/composition dir all manifest-internal paths (roles/, schemas/, manifest/prompts/) resolve against |
| `maxConcurrentDispatches` | `2` | fanout (battery) lens dispatch cap, clamped to an integer 1–4 |
| `dispatchTimeoutMs` | `1800000` | wall-clock backstop per child dispatch |

**Dispatch prompt template variables** — the complete `{{VAR}}` vocabulary a
`dispatch.promptTemplate` file may use (an unknown or unsupplied variable is
rejected fail-closed as `MANIFEST_INVALID`):

| variable | value |
|---|---|
| `{{WORKSPACE}}` | the calling session's workspace dir (absolute) |
| `{{TARGET}}` | the `pipeline_stage` `target` argument, or `unspecified` |
| `{{ARTIFACT}}` | the stage artifact's absolute path |
| `{{STAGE}}` / `{{ATTEMPT}}` | stage id / 1-based attempt number |
| `{{GATE_LOG_PREV}}` | attempt >1: a pointer line to the previous gate log (attempt 1: empty) |
| `{{PRESET_DIR}}` | the executor's **resolved absolute** `baseDir` — lets a prompt spell out preset-shipped commands absolutely, e.g. `python3 {{PRESET_DIR}}/validators/validate_report.py … --target-dir {{WORKSPACE}}/build` |

**Ledger `tokens` field:** the summed host
`tokenMeter.measure(childSession).totalTokens` across the attempt's children
(measured between each child's settlement and disposal via the run handle's
`localAgent.session`). When the meter or ANY child session is unreachable the
field is `null` — honest-null, never a partial sum, never fabricated.

**Path resolution in production:** the manifest and its referenced files are
preset-dir-relative so the pipeline travels with the preset copy. The plugin
row's config must therefore carry an ABSOLUTE `baseDir` written by the
composition itself, e.g. via a `!!js` baseUrl expression in the preset YAML:

```yaml
- id: pipeline-executor
  name: dsh-pipeline-executor
  config:
    baseDir: !!js new URL('.', baseUrl).pathname
    manifestPath: manifest/pipeline.manifest.json
```

The workspace (where `artifacts/`, `gate-logs/`, `build/` and the ledger
live) is the calling session's cwd. The executor's write surface is exactly:
the stage artifact, `artifacts/battery-lens-<lens>.json` for fanout lenses,
`gate-logs/<stage>.attempt<n>.log`, and the ledger — enumerated and tested.

## Error codes (every one carries a remedy line)

`MANIFEST_INVALID` · `STAGE_UNKNOWN` · `ATTEMPT_EXCEEDED` ·
`DISPATCH_FAILED` · `ROLE_NO_OUTPUT` · `GATE_SPAWN_FAILED` ·
`LEDGER_WRITE_FAILED` — see `lib/manifest.js` `REMEDIES` for the exact
remedy text. Dispatch-phase failures (`DISPATCH_FAILED`, `ROLE_NO_OUTPUT`,
`GATE_SPAWN_FAILED`) are ledgered with an `error` marker before the tool
call fails; a ledger-write failure outranks everything (evidence is not
optional).

## Verification status

- `npm test` (node --test, no harness, no network, fakes injected via the
  functions-only `_seams` config seam) — green, plus killed mutations
  (`test/MUTATIONS.md`). Since 0.1.1 the fakes validate every mounted tool's
  execute return against its declared `output.schema`, so the G1b
  schema-violation class dies offline.
- Live dsh boot (G1b, 2026-08-17) — GREEN; one live bug found and fixed
  (execute returns are host-validated against `output.schema`), now pinned by
  an offline regression test. SPEC.md `## Deviations` records the
  SPEC↔SPIKE-FINDINGS reconciliations and the 0.1.1 polish notes. One
  VERIFICATION LIMIT remains in `lib/index.js`: the tokenMeter adapter's
  `run.localAgent.session` path is proven against the installed host source
  but not yet observed live — the next boot must confirm a non-null `tokens`
  ledger field.
