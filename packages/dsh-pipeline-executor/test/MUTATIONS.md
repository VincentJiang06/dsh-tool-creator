# G1a mutation kills — dsh-pipeline-executor 0.1.0 (2026-08-17)

Procedure per mutation: back up pristine `lib/` → apply the single-point
mutation to `lib/dispatch.js` → run `npm test` (73 tests) → confirm RED and
record the failing test names → restore pristine bytes (diff-verified) →
confirm the suite is green again (73/73). Baseline stability: 10 consecutive
green runs before the campaign.

## Mutation (a) — ledger write silently disabled

```diff
@@ appendLedger @@
     const lineNo = existing.split('\n').filter((line) => line !== '').length + 1;
-    await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`);
+    // MUTATION (a): ledger write silently disabled
+    // await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`);
     return lineNo;
```

Result: **KILLED — 11 failed / 62 passed.** Failing tests:

1. happy path: dispatch, executor-written artifact, gate, mandatory ledger line
2. tokens ride the ledger when the meter resolves; a throwing meter degrades to null
3. non-zero gate exit is reported (not thrown), with the gate-log tail; ledgered
4. ROLE_NO_OUTPUT: structured missing OR stopReason not completed — ledgered, correct code
5. DISPATCH_FAILED carries the provider error verbatim; ledgered
6. GATE_SPAWN_FAILED: missing validator binary — remedy names python3; artifact + log still evidenced
7. LEDGER_WRITE_FAILED when the ledger cannot be appended (evidence is not optional)
8. appendLedger is append-only with 1-based line numbers
9. statusReport: manifest sha, per-stage ledger evidence, session attempts, layout
10. fanout: 5 confined lens dispatches + synthesis; executor writes every lens artifact
11. a failing lens fails the stage fail-closed: ledgered, synthesis never dispatched

Why it dies: every ledger assertion reads the JSONL from **disk** (`readLedger`),
never the tool's return value — a no-op append that still returns a line
number cannot fake evidence.

## Mutation (b) — toolFilter omitted from the dispatch request

```diff
@@ buildRequest @@
       persona: `${rolePackText}\n\n${contextBlock}`,
-      toolFilter: { allow: [...tools] },
+      // MUTATION (b): toolFilter omitted from the dispatch request
       agentOptions: {
```

Result: **KILLED — 2 failed / 71 passed.** Failing tests:

1. confinement: SPIKE-shaped request — persona bytes, whitelist toolFilter, pinned agentOptions
   (`assert.deepEqual(request.toolFilter, { allow: ['read', 'glob', 'grep'] })` → actual `undefined`)
2. fanout: 5 confined lens dispatches + synthesis; executor writes every lens artifact
   (per-lens `{allow: ['read', 'grep']}` and synthesis `{allow: ['read']}` deep-equals)

## Mutation (c) — gate exit code hardcoded to 0

```diff
@@ runStage gate section @@
     await writeFile(gateLogPath, gateLogText);
-    facts.gateExit = gateExit;
+    facts.gateExit = 0; // MUTATION (c): gate exit code hardcoded to 0
     facts.gateLogPath = gateLogPath;
```

Result: **KILLED — 3 failed / 70 passed.** Failing tests:

1. non-zero gate exit is reported (not thrown), with the gate-log tail; ledgered
   (summary must carry `gateExit=3` + log tail; disk ledger line must carry `gateExit: 3`)
2. gate `then` chaining: second command only on strict first success
   (`then`-command exit 7 / first-command exit 2 must surface as the verdict)
3. statusReport: manifest sha, per-stage ledger evidence, session attempts, layout
   (status must render `last attempt=2 gateExit=3 red` from the ledger)

## Post-campaign state

Pristine `lib/` restored byte-identical (diff-verified against the backup);
final `npm test`: 73/73 green.
