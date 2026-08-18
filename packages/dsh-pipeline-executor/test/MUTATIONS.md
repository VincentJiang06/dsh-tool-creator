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

# 0.1.3 mutation kill — gate argv templating (2026-08-17)

Same procedure: back up pristine `lib/` → single-point mutation → `npm test`
(92 tests) → confirm RED, record failing names → restore (diff-verified
byte-identical) → confirm green (92/92).

## Mutation (d) — gate argv rendering disabled

```diff
@@ renderGateArgv @@
 export function renderGateArgv(argv, vars, sourceName) {
+  return argv; // MUTATION (d): gate argv rendering disabled
   return argv.map((arg, i) => {
```

Result: **KILLED — 4 failed / 88 passed.** Failing tests:

1. gate argv templating: {{PRESET_DIR}}/{{WORKSPACE}}/{{STAGE}}/{{ATTEMPT}}/{{ARTIFACT}} render ABSOLUTE in both cmd and then
   (execFile received the literal `{{…}}` tokens instead of absolute paths — both the cmd and then deep-equals)
2. gate argv unknown token: MANIFEST_INVALID naming the token, NOTHING dispatched (cmd and then alike)
   (`assert.rejects` never fired — the unknown token passed through silently)
3. renderGateArgv unit: passthrough, rendering, DSML guard, out-of-vocabulary forms
   (rendered deep-equal + DSML/leftover `grab` calls all returned instead of throwing)
4. every shipped gate command renders through the argv templater: absolute paths, no leftover tokens (0.1.3)
   (the shipped manifest's `{{PRESET_DIR}}/validators/…` elements surfaced unrendered)

Why it dies: the templating tests assert on the argv **execFile actually
received** (fake execFile call capture) and on the **shipped manifest bytes**,
never on the renderer's return value alone — an executor that stops rendering
cannot fake absolute gate paths.

## Post-campaign state (0.1.3)

Pristine `lib/` restored byte-identical (diff-verified against the backup);
final `npm test`: 92/92 green.

# 0.1.5 mutation kill — per-stage target filter (2026-08-18)

Same procedure: back up pristine `lib/` → single-point mutation → `npm test`
(101 tests) → confirm RED, record failing names → restore (diff-verified
byte-identical) → confirm green (101/101).

## Mutation (e) — target filter check removed

```diff
@@ runStage target filter @@
-  if (stage.targets !== undefined && !stage.targets.includes(target)) {
+  if (false && stage.targets !== undefined && !stage.targets.includes(target)) { // MUTATION (e): target filter check removed
```

Result: **KILLED — 2 failed / 99 passed.** Failing tests:

1. target filter: a stage whose targets list excludes the call target is SKIPPED — no dispatch, no gate, skip ledgered
   (`subagents.calls.length` 1 instead of 0, `execFileImpl.calls.length` 1 instead of 0, summary was the normal
   fact line instead of `stage=alpha SKIPPED (target filter) gateExit=0 ledger=1`, disk ledger line lacked
   `skipped`/`reason`, write surface grew artifact + gate log)
2. target filter: an absent target param filters as "unspecified" — honest reason, never guessed
   (stage dispatched instead of skipping; no skip line on disk)

Why it dies: the skip tests assert on what the fakes actually RECEIVED (zero
`subagents.start` calls, zero gate spawns), on the ledger JSONL read from
DISK, and on the enumerated write surface — an executor that stops filtering
cannot fake a skip.

## Post-campaign state (0.1.5)

Pristine `lib/` restored byte-identical (diff-verified against the backup);
final `npm test`: 101/101 green.
