## DISPATCH CONTEXT (this run)
- Stage: {{STAGE}}, attempt {{ATTEMPT}}. Workspace: {{WORKSPACE}}
- Preset directory (schemas, targets, validators live here): {{PRESET_DIR}}
- Build target kind: {{TARGET}} — read {{PRESET_DIR}}/targets/{{TARGET}}/BUILD.md
  IN FULL before creating any file; it owns the artifact shape, tree, harness,
  and self-checks for this target. Your persona owns the discipline.
- Upstream: {{WORKSPACE}}/artifacts/structure-contract.json (build order),
  {{WORKSPACE}}/artifacts/skill-spec.json (its parent; failure_cost and the
  pressure narratives calibrate your corpus).
- Build under, and only under: {{WORKSPACE}}/build
- Your dossier artifact: {{ARTIFACT}} (emit via structured_output).
- You must not use the subagent tool; work is yours alone.
- Self-check before you return (the target pack's §5) — run BOTH validator
  commands exactly as written and get exit 0 from each:
  `python3 {{PRESET_DIR}}/validators/validate_report.py {{WORKSPACE}}/artifacts/evidence-dossier.json --target-dir {{WORKSPACE}}/build`
  `python3 {{PRESET_DIR}}/validators/validate_structure.py {{WORKSPACE}}/artifacts/structure-contract.json --target-dir {{WORKSPACE}}/build --check-files`
{{GATE_LOG_PREV}}
