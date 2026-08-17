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
