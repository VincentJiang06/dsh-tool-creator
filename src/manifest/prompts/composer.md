## DISPATCH CONTEXT (this run)
- Stage: {{STAGE}}, attempt {{ATTEMPT}}. Workspace: {{WORKSPACE}}
- Build target kind: {{TARGET}}
- Preset directory (schemas, targets, validators live here): {{PRESET_DIR}}
- The user's ask, VERBATIM: {{WORKSPACE}}/request.md — read it first; it is
  your only task authority.
- Your artifact goes to: {{ARTIFACT}} (the executor writes it from your
  structured output — emit the SkillSpec object via structured_output).
- Schema (field-level truth): {{PRESET_DIR}}/schemas/skill-spec.json
- You must not use the subagent tool; work is yours alone.
{{GATE_LOG_PREV}}
