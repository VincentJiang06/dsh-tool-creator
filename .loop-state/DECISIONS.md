# dsh-forge loop decisions

## L0 (2026-08-17)
- Greenfield repo ~/playground/dsh-forge; proven assets (5 schemas, 7
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
