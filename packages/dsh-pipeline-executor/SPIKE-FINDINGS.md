# E1' spike findings — subagents.start seam (SEAM-CONFIRMED, 2026-08-17)

Live-proven in a real headless boot, evidence from tool-result/structural log
blocks only. Child session 4420152f… carried: persona verbatim as system line,
tools array = ["structured_output"] only, structured output captured, config
model=deepseek-v4-pro. Dispatch overhead measured: 1316 in / 91 out tokens.

## The exact request shape (copy this)

```js
const run = await subagents.start('spawn', {
  label: 'tool-creator <stage>',
  prompt: [{ type: 'text', text: dispatchText }],   // content-block ARRAY, not a string
  parent: exec.agent,                                // guard: if (!parent) throw
  signal: exec.signal,                               // REQUIRED — deref'd on entry
  persona: rolePackText,
  toolFilter: { allow: [...whitelist] },             // OBJECT form; bare array throws
  agentOptions: { provider, model, maxTokens },      // ONLY these three keys are sanctioned
  outputSchema,                                      // object-rooted, required as ARRAY, explicit additionalProperties
});
const [execution] = await Promise.allSettled([run.result]);
const [disposal]  = await Promise.allSettled([Promise.resolve().then(() => run.dispose())]);
// run.id = child session id; result = {output, structured?, stopReason}
```

## The eight deviations (implementation law)

1. `signal` is REQUIRED (in-process-driver derefs `.aborted` on entry).
2. `toolFilter` is `{allow?, deny?}`; `restrict()` THROWS on unknown tool
   names and on `run_code` — validate the manifest whitelist against the live
   tool list before dispatch, map failures to a clear MANIFEST/DEPLOYMENT
   error instead of a child-start crash.
3. Restrictions mask only INHERITED tools; the child's own scoped
   registrations (structured_output) are exempt — also means any per-child
   tool the executor registers bypasses its own filter. Don't.
4. Two schema dialects: `outputSchema` = standard JSON-Schema subset
   (required as array); `defineTool` parameters = per-property
   `required: true`. Never mix.
5. Never pass `descriptor` (runtime builds it from `label`).
6. `run.result` resolves even on abnormal ends. Success = `stopReason ===
   'completed'` AND `result.structured` present. Final assistant TEXT is
   typically EMPTY on structured runs (concludeTurn) — never parse text.
7. Persona is ADDITIVE: harness identity + the composition's tool-guidance
   prose remain in the child's system prompt (masked tools still described).
   Tolerable; role packs should not assume a clean prompt.
   ⚠ UNTESTED interaction: spike ran with no complete:true persona in the
   profile. The tool-creator profile-patch/preset sets `complete: true` on the
   CONDUCTOR charter — G1b MUST verify a role child still receives the ROLE
   persona (not the conductor charter) when dispatched from such a session.
8. `agentOptions` rides on top of the parent route; `reasoningEffort` came
   from deployment defaults and CANNOT be pinned per-dispatch (E3 confirmed
   at the seam level).

## L5-R1 live-run deviations (2026-08-18)

9. **The web host's outputSchema keyword subset refuses `$schema`.** The
   accepted subset is exactly: `type / oneOf / properties / required /
   additionalProperties / items / enum / const` plus the annotations
   `description / title / default / examples`. Anything else — including a
   top-level `$schema` — makes `subagents.start` throw `unsupported JSON
   schema: schema.$schema is not a supported keyword (subset:
   type/oneOf/properties/required/additionalProperties/items/enum/const +
   annotations)`. Sources: the live L5-R1 error text (conductor session
   `session-acf706a2…`, tool-creator-runs/r1-attempt-a-dispatchfail) and the
   host validator's whitelist sets in the installed `dsh-mcp-manager`
   (`lib/index.js`, minified: `new Set(["type","oneOf","properties",
   "required","additionalProperties","items","enum","const"])` + `new
   Set(["description","title","default","examples"])`). Consequences: the
   shipped role schemas carry no `$schema`, and `loadOutputSchema` strips a
   top-level `$schema` defensively before dispatch.

10. **Role children CAN delegate — confinement is tool-surface-level for
    INHERITED tools only (deviation 3's exemption, weaponized by the
    deployment).** Observed live in L5-R1: role children spawned 9 helper
    subagents (depth-2 sessions) despite `toolFilter: {allow: ["read"]}`.
    Mechanism, from installed source:
    - `dsh-tools` `ToolRuntime.view()`: "A restriction filters what a scope
      inherits — the global layer and every ancestor layer on its chain — and
      never what its OWN layer registers." Own-scope registrations are exempt
      by design (that is how `structured_output` reaches the child).
    - This deployment's `subagent` tool is
      `@huanlin/dsh-plugin-yet-another-subagent` (its bundle patch disables
      the official `dsh-tool-subagent` row). Its `apply()` hooks
      `ctx.on("agent/created", …)` and calls
      `agent.ctx.tools.register(buildTool(…))` — a per-agent `subagent` tool
      registered into EVERY agent's own scope, including every executor
      child. Own-scope ⇒ exempt from the executor's toolFilter; `deny:
      ["subagent"]` would not strip it either.
    - A request-level depth cap EXISTS but cannot express "this child may not
      delegate": `subagents.start` accepts `maxDepth`
      (`SubagentRuntime.start` → `assertSubagentMaxDepth`, capability-gated
      on the provider's `depthLimit`; the in-process spawn provider declares
      `depthLimit: true`). Semantics (`resolveChildDepth(parent, maxDepth)`
      in dsh-subagent): the cap applies ONLY to the child THIS request
      starts (`childDepth = parentDepth + 1 > maxDepth ⇒ SubagentDepthError`)
      and is NOT inherited — a helper the child spawns is a FRESH request
      whose `maxDepth` comes from the deployment tool's own config
      (ya-subagent profile "general": `maxDepth: 3`). `maxDepth: 1` on the
      executor's request admits the role child and constrains nothing below
      it; `maxDepth: 0` refuses the role child itself. No hack was added.
    - Helpers run UNfiltered (profile "general" `toolFilter: none`), so they
      inherit the full global surface including `pipeline_stage` /
      `pipeline_status` (the executor is a host-plane bundle in the web
      profile) — the recursion hazard is real.
    Mitigation shipped instead (honest limit): SPEC "Delegation confinement
    limit" section; a persona-level ban line in all five dispatch-context
    templates ("You must not use the subagent tool; work is yours alone.");
    and a mechanical battery-stage session-log detection documented in
    `manifest/prompts/battery.md` (helper sessions are keyed by
    `parentSession` = a ledgered `childSessionIds` id in the host session
    store — children of children are NOT cheaply detectable at the executor's
    seam: the tool name is deployment-config-dependent, the run handle
    exposes only the direct child session, and only within the
    settlement-to-disposal window).

## Service resolution

`ctx.get('subagents')` resolves at apply AND execute time, but the provider
list is EMPTY at apply time (spawn row applies later) — provider lookup must
be lazy (execute-time), like dsh-tool-subagent's event-driven pattern.

## Spike artifacts

`spike/dsh-forge-spike/` in this repo (working reference implementation);
installed in the headless profile as `dsh-forge-spike` (remove with
`dsh plugin --profile headless remove dsh-forge-spike` when L1 lands).
