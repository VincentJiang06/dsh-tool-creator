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
