# E1' spike findings — subagents.start seam (SEAM-CONFIRMED, 2026-08-17)

Live-proven in a real headless boot, evidence from tool-result/structural log
blocks only. Child session 4420152f… carried: persona verbatim as system line,
tools array = ["structured_output"] only, structured output captured, config
model=deepseek-v4-pro. Dispatch overhead measured: 1316 in / 91 out tokens.

## The exact request shape (copy this)

```js
const run = await subagents.start('spawn', {
  label: 'forge <stage>',
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
   profile. The forge profile-patch/preset sets `complete: true` on the
   CONDUCTOR charter — G1b MUST verify a role child still receives the ROLE
   persona (not the conductor charter) when dispatched from such a session.
8. `agentOptions` rides on top of the parent route; `reasoningEffort` came
   from deployment defaults and CANNOT be pinned per-dispatch (E3 confirmed
   at the seam level).

## Service resolution

`ctx.get('subagents')` resolves at apply AND execute time, but the provider
list is EMPTY at apply time (spawn row applies later) — provider lookup must
be lazy (execute-time), like dsh-tool-subagent's event-driven pattern.

## Spike artifacts

`spike/dsh-forge-spike/` in this repo (working reference implementation);
installed in the headless profile as `dsh-forge-spike` (remove with
`dsh plugin --profile headless remove dsh-forge-spike` when L1 lands).
