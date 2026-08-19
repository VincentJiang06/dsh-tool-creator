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

## R1 fix bundle landed (2026-08-18): F1-F4 closed, executor 0.1.4
$schema stripped everywhere + defensively in loader (host subset = deviation 9);
glob/grep out (final arrays verified against live known-tools list); guidance
40960 / composer 24576 + {{PRESET_DIR}} absolutes in all five prompts; F4 root
cause = @huanlin/dsh-plugin-yet-another-subagent registers an own-scope
subagent tool into EVERY agent (restrict-exempt by design); request maxDepth
caps only the direct child → branch (d): honest limit (SPEC + deviation 10) +
prompt-level ban in all five templates + battery session-log detection.
Composer role-pack delegation suggestions reconciled with the ban (2 passages,
conductor edit). 93/93 executor, 12/12 repo, 7/7 selftests; 0.1.4 in web
profile; dist reinstalled, hot-fix drift gone. Deployment note for docs: strict
confinement additionally requires not installing own-scope subagent plugins
(ya-subagent) in the serving profile.

## Battery scale reduction (2026-08-18, user directive)
R1-b battery a1 burned 464K tokens vs engineer's 143K — user: cut to
engineer level. Three cuts in src (NOT installed mid-run): default lenses
5→3 (coherence/gaming/reality; evidence+foundation opt-in via manifest for
high-stakes), lensMaxTokens 32768→12288, synthesis kept 24576 (it emits the
full decision record — R1-b's a1 ROLE_NO_OUTPUT at synthesis is under
diagnosis; starving it would reproduce the guidance-class death), lens
dispatch prompt now pins the attack surface to build/+spec with an explicit
depth-over-breadth budget note. Install deferred until the in-flight run
settles. Target: battery ≈ 150K.

## R1-b final (2026-08-18): four stages green a1, battery dead at the WALL
composer/guidance/engineer/zipper all green attempt 1 (F1-F3 fixes fully
verified by outcome). battery ROLE_NO_OUTPUT x3, synthesis child
stopReason=aborted each time — TIMEOUT wall, not token starvation: five
full-scale lenses (~470K tokens/attempt) consumed the dispatch window before
synthesis. Three attempts burned ~1.43M tokens; the user's scale-cut
directive (3 lenses / 12288) independently lands the fix; belt-and-suspenders
dispatchTimeoutMs 2.7M in the preset row. Queued to L7: on fanout retry,
reuse green lens artifacts and re-dispatch only the failed member (would
have saved ~1M tokens). B15 head-to-head now runnable from the r1b build.

## R1-c (2026-08-18): FIRST ACCEPTANCE MANIFEST BORN — the loop closes
Four stages a1 green; battery a1 gate-RED (validate_decision caught the
synthesis under-reporting effective_verdict 'draft' vs fold's 'candidate' +
two adjudicator field errors — the gate turned model imprecision into a
retry), battery a2 GREEN → acceptance-manifest.json: 80 files hashed,
verdicts {reAudit: candidate, battery: breaches_found (3P1/9P2/3P3),
effective: candidate} — the min-fold honestly caps its own product.
baselineDelta note: naive baseline 8/30 vs built skill 30/30 (+73pp).
Battery scale cut VERIFIED: ~250K/attempt vs 464-495K (-47%), synthesis
survived both attempts (wall no longer hit). T-D2 datum from R1-c era:
prompt-level ban held 0/4 role children spawning helpers (vs 9 pre-ban) —
instruction-level containment sufficed for v4-pro; door remains host-open.
B15 head-to-head banked from r1b build: 2W/1T/1L vs the 08-14 total loss
(win: corpus 26+27 classed vs 18+18, trigger battery 22+12 vs none; tie:
truncation; loss: backslash escaping — WHICH THE REALITY LENS ITSELF CAUGHT,
proving the battery detects the defect class the gate would then cap).

## F7 + hygiene (2026-08-18): fold aligned, reverify passes the real artifact
breaches_found→candidate everywhere (validate_decision/charter/anchors were
authoritative; the L4 standalone had invented →draft in reverify/docs/schema
description). Fabrication fixture updated (breaches_found+industrial). The
REAL r1c manifest now reverifies ok:true (80 hashes, schema, semantics,
fold) when checked from the artifact root — note for docs: the manifest
lives in artifacts/ until PACKAGING copies it to the artifact root.
Assembler now excludes __pycache__/.git/node_modules/.DS_Store from the walk
(r1c shipped .pyc whose bytes churn on harness re-runs → would trip
tree-unchanged). Ledger-pin 5-of-6 semantics documented.

## Wall-clock compression (2026-08-18, user directive: full run <1h)
R1-c anatomy: 78.7min = engineer 23.4 (irreducible real work) + battery 33
(two attempts) + rest ~22. Three levers, no quality cut: zipper → v4-flash
(mechanical stage, gate-guarded, also first live E5 datum), battery lens
concurrency 2→3 (three lenses simultaneous), remaining matrix runs
parallelized where evidence allows. Projected single-attempt full run
≈56-58min. Source-only; install scheduled BETWEEN R2 and R3 (never mutate an
in-flight run's engine). Deeper cuts if still needed (queued, need evidence):
composer→flash trial, engineer corpus floor tuning — both quality-risky,
gate-measurable, L7.

## Two-phase UX (2026-08-18, user directive): grill → pipeline, 一次通过
User clarified the product shape: users FIRST run a grill-me interrogation
to forge an airtight spec (~20-30min interactive, normal session), THEN the
pipeline works from it (~30-40min) — total ≈1h, hard budget 2h, first-pass
success over raw speed. Shipped: skills/spec-grill (interrogation doctrine +
the TOOL-CREATOR SPEC v1 output contract; installed by install.sh into
~/.dsh/skills for NORMAL sessions), charter Step 0.5 intake gate (SPEC block
→ pass; else name+function+trigger heuristic; refusal = stopped_needs_spec
in minutes with the grill pointer — never an hour of misdirection), composer
spec-block fast path (grilled spec is primary source, no re-litigation).
Wall-clock levers stack: flash zipper + zipper skipped for plugin/preset
(0.1.5 target filter, in flight) + 3-way lenses → pipeline phase projected
30-40min; sub-30 candidates (flash composer/guidance trial, engineer batch
writes) gated on R3 measurements.

## R2 (2026-08-19): stopped_unmet at battery — two synthesis-record defect classes
Build green (dsh-acceptance-badge exists); battery a1 fold under-report +
O-L0/adjudicator trap, a2 synthesis max-tokens (plugin targets yield bigger
findings volumes), a3 O-L0 trap alone. Fixes: synthesis 24576→32768;
battery dispatch prompt gains the ADJUDICATION TOPOLOGY law (machine
adjudicator; O-L0 illegal in-run; write the fold's output). Honest note:
R2 ran mixed-config (mid-flight preset install during the two-phase-UX step
— my own install-discipline violation; per-line manifestSha256 in the ledger
discloses provenance mechanically). Plan: R3 first (timing measurement),
then resume R2's battery on the same workspace (fresh session, ledger
continues) to birth the plugin manifest for ~¥5.

## R2/R3 findings fixed (2026-08-19): O-L3 machine factory + target-aware intake
R2 anomaly (O-L0 human-adjudicator deadlock): the O-L0 "ships here" line was
skill-creator-max's HUMAN-factory heritage; the tool-creator MACHINE factory's
level is O-L3 (battery auto-executes, human veto reserved-not-exercised,
disclosed as a limit). Fixed in anchors + battery dispatch prompt (write
O-L3/adjudicator:machine, never O-L0 — three battery deaths traced here). The
validator O-L0 rule is CORRECT and stays (claiming O-L0 does require human
gates); the bug was synthesis claiming a level it can't honor.
R3 finding (over-strict intake): component (c) was skill-shaped (trigger/IO
example); preset has no trigger phrase. Made (c) target-aware: operating
domain / enforced discipline satisfies it for preset/plugin. Both were
GATE-DESIGN defects surfaced by faithful conductor behavior — the value of
running real cases. R4=clean pass banked; wall-clock <1h still unmeasured
(R3 stopped at intake); R2/R3 both re-fireable now.

## R3 refire (2026-08-19): two gate fixes VERIFIED live, third defect surfaced
Intake gate (target-aware) PASSED the preset request — no false refusal.
O-L3 doctrine VERIFIED: r3 decision-record shows capability_level=O-L3 +
all-machine adjudicators (the R2 deadlock class is dead). zipper SKIPPED
(skipped=True, target filter working). Four stages green a1
(composer 65.7K / guidance 65.5K / engineer 187.6K / zipper 0). Battery a1
gate-RED on a THIRD, deeper defect: assemble_manifest looked for artifact-root
markers only at build/, but a preset's tree is build/preset/ (BUILD.md §1).
Added artifact_root() helper (routes walk + identity to build/preset/ when
markers are there; selftest still green) — but that surfaced the real preset
EVIDENCE-MODEL gap: the harness lives at build/evals/ (creation-time tool,
must not ship into the preset per BUILD.md), so it is not in the shipped
tree. Handed to a subagent: preset harness is workspace-anchored for the
command phase + disclosed as a limit; hash phase re-runnable from the shipped
preset alone. R3 will stop_unmet this pass; resume its battery after the fix.

## R3 preset artifact + evidence COMPLETE (2026-08-19) — first preset manifest
The R3 preset build's acceptance evidence is fully valid: manually running the
battery gate's exact assemble command against the r3 tree with the installed
(fixed) validator → PASS, acceptance-manifest.json born, kind=preset,
capability_level O-L3, verdicts {candidate/breaches_found→candidate,
1P1/2P2/2P3}, 4 limits incl. the preset workspace-anchored-harness limit;
reverify from the shipped build/preset/ tree → ok:true. The live battery a1
red was a TIMING artifact (ran under the pre-install validator); same command
PASSES post-install. Three preset evidence-model defect layers all closed:
artifact_root(build/preset/), workspace-anchored harness, reverify preset-aware.
Remaining: a live battery-green pass (cosmetic — the evidence is proven) +
R2 plugin manifest. Wall-clock (R3 upstream, from ledger): composer→zipper
all a1, engineer heaviest; full <1h timing measurable once a clean single-run
lands.

## R3 LIVE-GREEN + R2 non-determinism root cause (2026-08-19)
R3 battery went LIVE-GREEN on a2 (a1 red was pre-install timing) → preset
acceptance-manifest born live (kind=preset, O-L3). So skill(R1-c) + preset(R3)
both have live-green manifests. R2 (plugin) resumed but battery a1/a3 red,
a2 ROLE_NO_OUTPUT: synthesis wrote capability_level O-L0 (adjudicators all
machine) → validate_decision's O-L0-requires-human rule rejects. ROOT CAUSE:
capability_level is a PIPELINE CONSTANT (this is a machine factory = O-L3),
not a per-run model judgment — but synthesis authors it and does so
NON-DETERMINISTICALLY (R3 wrote O-L3, R2 wrote O-L0 despite identical
installed doctrine, session fired AFTER install). Instruction-level doctrine
is unreliable; the fix is MECHANICAL: executor stamps capabilityLevel from
manifest config into the decision-record (like it stamps sha256 — recording a
structural constant, not inventing a judgment); validator requires O-L3+machine;
synthesis stops authoring it. This directly serves 一次通过. Delegated.

## L5 wall-clock first measurement (R3, 2026-08-19)
Clean single-attempt: 62.4 min (composer 8.6 + guidance 9.5 + engineer 26.5 +
zipper 0/SKIPPED + battery-a2 17.8). Two poles: engineer 26.5 (irreducible
real code+30-fixture work) and battery 17.8 (3-way lens concurrency already
on; 3 lenses @12288). Slightly OVER the <1h target. Levers for sub-60 (L7,
gate-measured): engineer corpus-floor tuning (risky — B15 win came from深语料),
composer/guidance → flash trial (composer 8.6→~3? guidance 9.5→~4?), battery
lens cap trim. R2 provenance lesson LEDGERED: NEVER install mid-run — the
per-line manifestSha256 fail-close (2 versions → refuse) is correct and caught
my own violation; clean-workspace re-run is the remedy.

## L5 CLOSED (2026-08-19): three targets banked live-green
R2d (fresh workspace, executor 0.1.7): battery a1 GREEN first-pass, plugin
acceptance-manifest born — kind=plugin, capability_level O-L3 all-machine
(the 0.1.7 structuredClone stamp fix PROVEN: stamp worked without the frozen
crash), verdicts candidate/breaches_found→candidate (1P1/4P2/4P3), reverify
ok:true, scan_symbols clean, 63.5min (engineer needed a2 — placeholder-path
model imprecision, gate-caught). Three targets now have live-green manifests:
skill (R1-c, B15 不再输), preset (R3, O-L3), plugin (R2d, O-L3). R4 fault
injection = clean stopped_unmet. Invariant 6 (never mutate frozen tool
results) added to BUILD.md — 6th boot-only invariant, all field-earned.
L5 close: all matrix runs done, differential battery banked, wall-clock
~62-63min (over the <1h goal — engineer + battery are the poles; sub-60 is
L7 with flash-tier trials). → L6 attack + release.

## L7 cost compression: flash tier (2026-08-19, post-v0.1.0)
Scope decided from L5's own measurements (62.4min = composer 8.6 + guidance
9.5 + engineer 26.5 + battery 17.8; lens 3-way concurrency ALREADY on):
- APPLIED: composer/guidance/zipper → deepseek-v4-flash via stage-level
  `model` override (executor already supported stage.model since manifest
  schema day one — manifest-only change). Rationale: all three are fully
  gate-guarded (validate_spec/structure/dossier + charter retry table) — the
  quality floor is held by GATES, not the model. Engineer stays v4-pro (B15
  quality pole: 30+30 corpus). Battery stays v4-pro (verdict-bearing model,
  T-D6/A37 pin).
- PROVENANCE: derive_provenance now emits a mechanical mixed-model limits[]
  line (stage=model per ledger roleModel; battery's own line lands post-
  assembly per LEDGER_TIMING_LIMIT, stated). model.id joins all models used
  (conservative A37: verdicts expire when ANY changes). Selftest: mixed
  sanity-pass + green-fixture no-mixed assertion.
- REJECTED (evidence-based): lens cache-prefix stagger — persona (the shared
  bulk) is already the request prefix, divergence starts at the short lens
  line; the remaining lever is only the 3-way concurrency race, worth
  ~$0.1-0.2/run against an executor timing knob + wall-clock cost. Not worth
  it. Engineer corpus-floor trim — B15's win came from corpus depth; user
  priority is 一次通过 over speed. Battery lens/cap trim — already cut 47%
  in L5; further trim erodes the attack surface the differential claims
  stand on.
- Projection: 62.4 − (8.6−~3) − (9.5−~4) ≈ 51min. L7-V1 validation run
  (r5, R1-comparable csv-md-table, off-peak) IN FLIGHT — gate-measured,
  results land below.
