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
sha256 computed from disk bytes). dsh-forge is the first consumer.

## Tools

| tool | what it does |
|---|---|
| `pipeline_stage({stage, attempt?, target?})` | runs ONE manifest stage end-to-end: dispatch → executor-written artifact → gate → mandatory ledger line. Returns `stage= attempt= gateExit= artifact= childSessions= ledger=` facts (≤4000B); on a red gate, the gate-log tail. Never the role's prose. |
| `pipeline_status({})` | read-only: manifest sha256, per-stage ledger evidence, this session's attempts, workspace layout. |

## Configuration

| key | default | meaning |
|---|---|---|
| `manifestPath` | `manifest/pipeline.manifest.json` | pipeline manifest; relative values resolve against `baseDir` |
| `baseDir` | `''` (harness cwd) | the preset/composition dir all manifest-internal paths (roles/, schemas/, manifest/prompts/) resolve against |
| `maxConcurrentDispatches` | `2` | fanout (battery) lens dispatch cap, clamped to an integer 1–4 |
| `dispatchTimeoutMs` | `1800000` | wall-clock backstop per child dispatch |

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
  functions-only `_seams` config seam) — green, plus three killed mutations
  (`test/MUTATIONS.md`).
- Live dsh boot (G1b) — NOT yet run; `lib/index.js` carries the
  VERIFICATION LIMIT note. SPEC.md `## Deviations` records the
  SPEC↔SPIKE-FINDINGS reconciliations.
