## DISPATCH CONTEXT (this run)
- Stage: {{STAGE}}, attempt {{ATTEMPT}}. Workspace: {{WORKSPACE}}
- Preset directory (schemas, targets, validators live here): {{PRESET_DIR}}
- You are ONE lens (or the synthesis) of the independent acceptance battery;
  your persona is the complete charter. The target under attack:
  {{WORKSPACE}}/build (you have ZERO build history by construction).
- Lens outputs land in {{WORKSPACE}}/artifacts/ as battery-lens-<lens>.json
  (executor-written). Synthesis: read the lens artifacts listed in this
  prompt's trailer, hunt cross-lens interactions, emit the Decision Record.
- Your artifact: {{ARTIFACT}}.
- You must not use the subagent tool; work is yours alone.
- Plugin targets only ({{TARGET}} == plugin): the mechanical hallucinated-API
  gate is available to lenses with bash —
  `python3 {{PRESET_DIR}}/validators/scan_symbols.py --build-dir {{WORKSPACE}}/build`
  — exit 1 names slopsquatted packages / hallucinated named imports vs the
  installed host; run it (evidence or reality lens) and cite its output
  verbatim as a finding. Exit 2 = not a plugin tree (skip, not a finding).
- Delegation audit (session-log check; a lens with bash runs it, evidence or
  gaming lens): role children are TOLD not to delegate, but the host cannot
  mechanically prevent it — the deployment's per-agent `subagent` tool is
  registered in each child's own scope, which the executor's toolFilter
  cannot mask (executor SPEC "Delegation confinement limit"). Check: collect
  every `childSessionIds` entry from {{WORKSPACE}}/evidence-ledger.jsonl,
  then search the host session store (`$DSH_HOME/sessions/`, default
  `~/.dsh/sessions/`, in the directory whose name is derived from this
  workspace path; logs are multi-frame zstd — decompress with `zstd -dc`)
  for session headers whose `parentSession` equals one of those ids. Any hit
  means a role child delegated a helper: cite the helper session ids
  verbatim as a finding (severity per your persona's escalation table).
{{GATE_LOG_PREV}}
