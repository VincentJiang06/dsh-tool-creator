# dsh-tool-creator loop decisions

## L0 (2026-08-17)
- Greenfield repo ~/playground/dsh-tool-creator; proven assets (5 schemas, 7
  validators, 5 role packs, 2 target packs, orchestration-anchors) imported
  from plugin-creator vendor/ — all clean of local paths, reviewed on entry.
- Single-source charter: src/preset/charter.md → injected into BOTH
  dist/preset/agent.cordis.yml (web) and dist/profile-patch.yml (terminal).
  The two-plane persona drift bomb is dead by construction.
- Composition template decisions vs predecessor: tool-ralph OUT (D5),
  compaction group IN (E2 will measure; drop only with evidence, in L7),
  tool-skill/skill-filesystem deferred to L2 (preset-local skills decision),
  executor row = build-time insertion marker (L1).
- pipeline.manifest.json v1 drafted: 5 stages, per-role tools whitelist +
  maxTokens (runaway protection), gate cmds as argv arrays (no shell), battery
  fanout 5 lenses + synthesis. Executor implements EXACTLY this shape.
- G0: 23 files hashed+verified; no /Users/vince residue; deterministic regen.

## L1 spike E1' (2026-08-17): SEAM-CONFIRMED
subagents.start from a plugin row works first-try in a real boot; all four
confinement axes proven in the child session log. Eight implementation
deviations recorded in packages/dsh-pipeline-executor/SPIKE-FINDINGS.md —
law for the builder. Notables: toolFilter is {allow:[]} object form and
throws on unknown names (pre-validate against live tool list); structured
runs end with EMPTY text (never parse prose); reasoningEffort cannot be
pinned per-dispatch (E3 seam-level confirmed); persona is additive, and the
complete:true conductor-charter × role-persona interaction is UNTESTED →
mandatory G1b check. Dispatch overhead ~1.3K/0.1K tokens. Spike plugin kept
in spike/ as working reference; installed in headless profile (remove at L1).

## Rename (2026-08-17, user): dsh-tool-creator → dsh-tool-creator
Done now: preset id `tool-creator`, display name, charter/manifest/template
identity strings; remote → github.com/VincentJiang06/dsh-tool-creator (pushed).
npm `dsh-tool-creator` verified AVAILABLE. Executor plugin name UNCHANGED
(dsh-pipeline-executor — generic ecosystem piece, user approved separate).
DEFERRED until the in-flight L1 builder lands (writes absolute paths):
- [ ] local dir mv ~/playground/dsh-tool-creator → ~/playground/dsh-tool-creator
- [ ] residual comment sweep: build.mjs header, profile-patch generated
      comments, charter.md H1, RESUME.md title cleanup, packages/SPEC.md refs
- [ ] PLAN/DECISION docs in dsh-projects/creator-v2 + memory files

## G3 coherence round (2026-08-17): PASS, 3 P2 fixed
F1 eval_kind gained "trigger" (schema enum + role pack); F2 trigger-battery
design split specified (live protocol + pinned results, harness verifies
shape only — never re-runs activation); F3 skill pack no longer claims the
dispatch prompt carries validator commands (queued: executor {{PRESET_DIR}}
template var + commands into prompts/engineer.md — AFTER G1b lands, to avoid
installed-vs-repo drift mid-validation); F4 vendor/roles + scripts/ path rot
fixed; plugin REQUIRED wording + baseline-delta carve-out added. Flags 1/4
accepted as benign (noted), flag 5 out of quick-check scope.

## L1 G1b (2026-08-17): GREEN — L1 complete
All seven checks green from session-log/disk evidence: R1 decisive (complete
conductor charter shadowed by name in child scope — 0 marker hits across 5
children; role personas delivered); R2 branches identified live (tools.list
ABSENT on rc.6 → degraded branch proven safe by negative 2; tokenMeter is
measure() not read() → tokens:null disclosed, adapter = measure().totalTokens
queued; cwd green); R3 additionalProperties:true accepted; ledger sha256s
byte-exact vs recompute; fanout paths-only proven in synthesis prompt;
negatives both dispatch-free. ONE live bug found+fixed+re-proven: host
validates execute returns against output.schema → BUILD.md Invariant 5 added.
Queued for executor 0.1.1 polish: fakes validate returns, {{PRESET_DIR}}
template var + validator commands in engineer prompt (G3-F3 full fix),
tokenMeter adapter, DISPATCH_FAILED remedy split. G1b kit + evidence kept in
g1b/ (3-line ledger). Spend: well under ¥2.

## L2-B (2026-08-17): charter final + composition finalized, G2 green
Charter 150 lines, v4-pro house style, zero transcription mechanics; honest
verdict rule (battery summary carries no verdict on green → charter cites the
gate-validated artifact instead of self-asserting a level). Composition:
executor row injected via shipped-cordis baseUrl convention; tool-skill rows
omitted with dated comment; LATENT BOOT BUG fixed — L0 template named
dsh-compaction(/pruner) which has no such export on rc.6; real rows are
dsh-compaction-basic / dsh-compaction-tool-result-pruner (verified against
installed exports). Role packs: identity/path cleanup only, listed line by
line. QUEUED (next executor touch, likely L4 integration): battery stage
summary should carry verdict=<battery>/<re_audit> parsed from the
decision-record the executor itself writes — makes the charter's branch A
automatic.

## L2-A executor 0.1.1 (2026-08-17): 82/82, four changes + one self-caught vacuity
Fakes now validate execute returns against the shared TEXT_OUTPUT_SCHEMA
bytes (0.1.0 bug shape regression-pinned); {{PRESET_DIR}} closes G3-F3 (both
validator commands rendered absolute in engineer DISPATCH CONTEXT, test-pinned);
tokenMeter adapter LIVE via measure(session) between settlement and disposal,
all-children-or-null aggregation (partial sum = wrong number); DISPATCH_FAILED
remedy split on tools.restrict refusals. Four mutation probes red-then-restored;
the PRESET_DIR probe SURVIVED initially → relative-baseDir test added (the
discipline works on its own tests). VERIFICATION LIMIT queued: first live run
must observe a non-null tokens ledger field. L2 COMPLETE.

## L4 integration (2026-08-17): evidence SHIPS mechanically — GREEN
assemble_manifest.py (stdlib, --selftest 1 green + 3 sanity + 13/13 traps) is
the ONLY writer of acceptance-manifest.json; every field from machine/gated
sources (ledger, decision-record, dossier, lens artifacts, build-tree walk) —
evidence assembly never passes through a model. Refusal classes: fold mismatch
(ANY disagreement with recomputed min-fold, both directions), measured=true
without both parseable rates, silent-limit suppression (final guard re-checks
every not_run layer is named in limits[]), plus symlinks/mixed-ledger/missing
harness/breaches-with-zero-counts. Disclosed-not-guessed: dshVersion "unknown"
+ limits line; ledger-timing line (sha pins the pre-battery-line ledger — the
assembler runs INSIDE the battery gate); kit-staging line (the two validator
re-checks need validators/+artifacts/ staged at the artifact root; bare trees
fail them VISIBLY). Battery gate chain: `then` slot was free, so
validate_decision → then assemble_manifest directly — NO battery_gate.py
wrapper (dispatch.js `then` = exactly one follow-on, runs only on cmd exit 0,
its exit IS the gate verdict → refused assembly = red battery gate). Wrapper
only becomes necessary if a THIRD command ever joins a chain.
Executor 0.1.2 (88/88, +6): battery summary carries verdict=<battery>/<re_audit>
parsed fail-soft from the DISK decision-record — trigger is artifact BASENAME
decision-record.json (never stage id/position), green gate only (L2-B honest-
verdict rule), token guard /^[A-Za-z_-]{1,64}$/. Charter branch A verified BY
READING: "- If the battery stage's summary text carries a verdict value, copy
it unchanged." — fires automatically on the new format; charter untouched.
Note: the copied value is the battery/re_audit PAIR, not the folded level —
consistent with the charter's own prohibition on conductor-computed verdicts
(gateExit=0 attests the fold held inside the record).
scan_symbols.py (--selftest 1 green + 1 sanity + 6/6 traps; real-host smoke:
executor's own lib PASS, 2 pkgs + 2 named imports proven): slopsquatting/
hallucinated-API gate vs ~/.dsh/profiles/node_modules/@deepseek-ai. WIRING
DECISION: manifest has NO conditional gates (validateManifest: static
cmd/then; `target` feeds prompts only) → NOT forced into the engineer gate;
shipped as a battery-stage tool, advertised in prompts/battery.md with the
{{PRESET_DIR}} absolute-command convention (plugin targets only; exit 2 =
not-a-plugin = skip, not finding). False-negative bounds documented in-file
(export * → open surface = disclosed skip; unknown/CJS surface treated open —
never a false accusation).
Tests: repo 12/12 (+assembly.test.mjs: synthetic ws → assembler → packaging
copy → reverify --skip-commands GREEN; fold-mismatch refusal exit 1, nothing
written), executor 88/88, seven validator selftests green, build 32 files
hashed (+2), install --verify-only green, dist copies selftest green, edited
manifest passes the executor's own fail-closed loader.
LATENT HAZARD (pre-existing, all six gate commands incl. the new then): gate
argv paths like validators/… are preset-dir-relative in the manifest but
execFile cwd=workspace — first live run would red every gate unless the
preset dir is the cwd or paths are resolved/rewritten at mount. g1b sidestepped
it with absolute paths. Fix belongs with the L5 live-run prep, one change
covers all six commands uniformly.

## L5-R1 first live run (2026-08-17 18:00-18:43): stopped_unmet at guidance — six findings
WINS: conductor charter PERFECT across 3 failure classes (verbatim request.md,
DISPATCH_FAILED→reissue→STOP, ROLE_NO_OUTPUT→3 attempts→STOP, honest
stopped_unmet, correct STOP block every time); tokens VERIFICATION LIMIT
RESOLVED (composer green line tokens:46927, error lines null-by-design);
ledger hashes byte-exact; cost ¥2.65 off-peak for 3 attempts; loopback wire
proven (session.create{cwd,agentPreset}/session.prompt/session.export).
FIXES NEEDED (runner hot-fixed the INSTALLED copy; source repo pending):
F1 web host outputSchema subset REJECTS $schema keyword (5 role schemas) —
   strip in src + defensively in executor loadOutputSchema;
F2 glob/grep not global tools on this deployment — drop from manifest;
F3 guidance died 3× at maxTokens 16384 without structured_output (wandered:
   30+ reads + location-helper spawns) — raise guidance cap + give ALL five
   prompt templates {{PRESET_DIR}} absolute paths (kill the wandering);
F4 MAJOR: children carry a scoped 'subagent' tool EXEMPT from toolFilter
   (like structured_output) — roles spawned 9 helpers, one prompted "no
   charter restrictions"; helpers inherit pipeline_* tools (recursion
   hazard). T-D2 claim does NOT hold on web plane as stated. Investigate
   depth/deny seam; else honest-limit + persona ban + battery detection.
F6 minor: events.mux via curl yields no frames; session.list polling works.
B15 head-to-head: DNF (no build) — target unmet this round, re-fire after fixes.
