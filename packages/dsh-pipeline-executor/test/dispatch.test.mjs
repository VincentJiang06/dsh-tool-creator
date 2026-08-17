/** Unit suite: runStage orchestration — dispatch, gate, ledger, retries, seams. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { CODES, PipelineError, TEXT_OUTPUT_SCHEMA, sha256 } from '../lib/manifest.js';
import { appendLedger, checkToolWhitelist, resolveSeams, runStage, statusReport, tailLines } from '../lib/dispatch.js';
import {
  ALPHA_SCHEMA,
  ROLE_ALPHA,
  grab,
  listFiles,
  makeDeps,
  makeFakeExecFile,
  makeFakeSubagents,
  makeFixture,
  mountTool,
  readLedger,
  validateAgainstSchema,
} from './helpers.mjs';

const LEDGER = 'evidence-ledger.jsonl';

// ---------------------------------------------------------------------------
// 1. Happy path: manifest → dispatch → artifact → gate → ledger
// ---------------------------------------------------------------------------

test('happy path: dispatch, executor-written artifact, gate, mandatory ledger line', async (t) => {
  const fx = await makeFixture(t);
  const deps = makeDeps(fx, { subagents: makeFakeSubagents({ behavior: { structured: { ok: true } } }) });
  const out = await runStage({ stage: 'alpha' }, deps);

  // Summary format is the SPEC-pinned fact line.
  assert.match(out.summary, /^stage=alpha attempt=1 gateExit=0 artifact=\S+ childSessions=child-1 ledger=1$/);
  assert.equal(out.gateExit, 0);

  // Artifact: executor-written from the structured return, bytes on disk.
  const artifactPath = join(fx.ws, 'artifacts', 'alpha.json');
  const artifactBytes = await readFile(artifactPath);
  assert.deepEqual(JSON.parse(artifactBytes.toString('utf8')), { ok: true });

  // Gate log captured on disk, argv visible.
  const logPath = join(fx.ws, 'gate-logs', 'alpha.attempt1.log');
  const logText = await readFile(logPath, 'utf8');
  assert.match(logText, /\$ validator artifacts\/alpha\.json/);
  assert.match(logText, /gate ok/);

  // The ledger line is read from DISK — the return value is never trusted
  // for evidence (this is the assertion that kills mutation (a)).
  const entries = await readLedger(join(fx.ws, LEDGER));
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(e.pipeline, 'fixture');
  const manifestBytes = await readFile(join(fx.preset, 'manifest', 'pipeline.manifest.json'));
  assert.equal(e.manifestSha256, sha256(manifestBytes), 'manifest sha from disk bytes');
  assert.equal(e.stage, 'alpha');
  assert.equal(e.attempt, 1);
  assert.deepEqual(e.childSessionIds, ['child-1']);
  assert.equal(e.artifactPath, artifactPath);
  assert.equal(e.artifactSha256, sha256(artifactBytes), 'artifact sha from disk bytes');
  assert.equal(e.gateExit, 0);
  assert.equal(e.gateLogPath, logPath);
  assert.equal(e.gateLogSha256, sha256(await readFile(logPath)), 'gate log sha from disk bytes');
  assert.equal(e.roleModel, 'deepseek-v4-pro');
  assert.equal(typeof e.durationMs, 'number');
  assert.equal(e.tokens, null, 'no token meter → null, disclosed, never fabricated');
  assert.equal(e.error, null);

  // Write surface is enumerable: artifact + gate log + ledger, NOTHING else.
  assert.deepEqual(await listFiles(fx.ws), [
    'artifacts/alpha.json',
    'evidence-ledger.jsonl',
    'gate-logs/alpha.attempt1.log',
  ]);

  // Session-keyed stage-attempt tracking updated.
  assert.deepEqual(deps.sessionState.stages.alpha, { attempt: 1, gateExit: 0, ledgerLine: 1 });
});

test('tokenMeter adapter: measure(childSession).totalTokens rides the ledger; a throwing meter degrades to null', async (t) => {
  const fx = await makeFixture(t);
  const measured = [];
  await runStage({ stage: 'alpha' }, makeDeps(fx, {
    measureTokens: (session) => { measured.push(session); return 1316; },
  }));
  await runStage({ stage: 'alpha', attempt: 2 }, makeDeps(fx, {
    measureTokens: () => { throw new Error('meter offline'); },
  }));
  const entries = await readLedger(join(fx.ws, LEDGER));
  assert.equal(entries[0].tokens, 1316);
  // The adapter is handed the CHILD's session from the run handle (spawn
  // provider run shape: {id, localAgent, result, dispose}) — never the parent's.
  assert.deepEqual(measured, [{ id: 'session-child-1' }]);
  assert.equal(entries[1].tokens, null, 'a throwing meter is honest-null, never fabricated');
});

test('token measurement happens BETWEEN result settlement and disposal, and a run without localAgent stays null', async (t) => {
  const fx = await makeFixture(t);
  const subagents = makeFakeSubagents();
  await runStage({ stage: 'alpha' }, makeDeps(fx, {
    subagents,
    measureTokens: (session) => { subagents.order.push({ op: 'measure', id: session.id }); return 42; },
  }));
  // Measure first, dispose second — after dispose() the child agent is torn
  // down and the session is no longer guaranteed alive.
  assert.deepEqual(subagents.order, [
    { op: 'measure', id: 'session-child-1' },
    { op: 'dispose', id: 'child-1' },
  ]);

  // A provider whose run handle carries no localAgent (child session NOT
  // reachable from the executor's position) → tokens null, meter never asked.
  const noAgent = makeFakeSubagents({ behavior: { structured: { ok: true }, noLocalAgent: true } });
  let meterAsked = false;
  await runStage({ stage: 'alpha', attempt: 2 }, makeDeps(fx, {
    subagents: noAgent,
    measureTokens: () => { meterAsked = true; return 99; },
  }));
  const entries = await readLedger(join(fx.ws, LEDGER));
  assert.equal(entries[0].tokens, 42);
  assert.equal(entries[1].tokens, null);
  assert.equal(meterAsked, false, 'no session to measure → the meter is not called');
});

// ---------------------------------------------------------------------------
// 2. Confinement: the start request carries exactly the manifest's contract
// ---------------------------------------------------------------------------

test('confinement: SPIKE-shaped request — persona bytes, whitelist toolFilter, pinned agentOptions', async (t) => {
  const fx = await makeFixture(t);
  const subagents = makeFakeSubagents();
  await runStage({ stage: 'alpha', target: 'plugin' }, makeDeps(fx, { subagents }));

  assert.equal(subagents.calls.length, 1);
  const { provider, request } = subagents.calls[0];
  assert.equal(provider, 'spawn');
  assert.equal(request.label, 'tool-creator alpha');

  // prompt is a content-block ARRAY, not a string (SPIKE deviation).
  assert.ok(Array.isArray(request.prompt));
  assert.equal(request.prompt.length, 1);
  assert.equal(request.prompt[0].type, 'text');
  assert.match(request.prompt[0].text, /Begin stage "alpha" \(attempt 1\)/);

  // Persona = role-pack file bytes VERBATIM (hash-compared) + DISPATCH CONTEXT.
  const roleBytes = await readFile(join(fx.preset, 'roles', 'alpha.md'), 'utf8');
  assert.ok(request.persona.startsWith(roleBytes), 'persona starts with the role pack');
  assert.equal(sha256(request.persona.slice(0, roleBytes.length)), sha256(roleBytes));
  assert.equal(roleBytes, ROLE_ALPHA);
  assert.match(request.persona, /## DISPATCH CONTEXT \(this run\)/);
  assert.match(request.persona, /Build target kind: plugin/);
  assert.ok(request.persona.includes(`Workspace: ${fx.ws}`));
  assert.ok(request.persona.includes(join(fx.ws, 'artifacts', 'alpha.json')), 'ARTIFACT rendered');
  assert.ok(request.persona.includes(`Preset dir: ${fx.preset}`), 'PRESET_DIR rendered as the resolved absolute baseDir');

  // toolFilter: OBJECT form, exactly the manifest whitelist, verbatim.
  // (This deep-equal is the assertion that kills mutation (b).)
  assert.deepEqual(request.toolFilter, { allow: ['read', 'glob', 'grep'] });

  // agentOptions: ONLY the three sanctioned keys.
  assert.deepEqual(request.agentOptions, { provider: 'deepseek-official', model: 'deepseek-v4-pro', maxTokens: 4096 });
  assert.deepEqual(Object.keys(request.agentOptions).sort(), ['maxTokens', 'model', 'provider']);

  // outputSchema: the stage's schema file, object-rooted, required as ARRAY.
  assert.deepEqual(request.outputSchema, ALPHA_SCHEMA);

  // parent guarded, signal REQUIRED, descriptor never passed.
  assert.equal(request.parent.id, 'parent-agent');
  assert.ok(request.signal instanceof AbortSignal, 'signal present (deref-safe)');
  assert.ok(!('descriptor' in request), 'descriptor is never passed');
});

test('PRESET_DIR renders ABSOLUTE even when the configured baseDir is relative', async (t) => {
  const fx = await makeFixture(t);
  const subagents = makeFakeSubagents();
  const deps = makeDeps(fx, { subagents });
  deps.options.baseDir = relative(process.cwd(), fx.preset); // test/dev fallback shape
  await runStage({ stage: 'alpha' }, deps);
  const { persona } = subagents.calls[0].request;
  assert.ok(persona.includes(`Preset dir: ${fx.preset}`), 'resolved to the absolute preset dir');
  assert.ok(!persona.includes(`Preset dir: ${deps.options.baseDir}\n`), 'never the raw relative value');
});

test('whitelist pre-validation: run_code and deployment-unknown tools are refused before dispatch', async (t) => {
  const rcError = grab(() => checkToolWhitelist(['read', 'run_code'], { field: 'stage alpha tools' }));
  assert.ok(rcError instanceof PipelineError && rcError.code === CODES.MANIFEST_INVALID);
  assert.match(rcError.message, /run_code/);
  checkToolWhitelist(['read'], { field: 'x' }); // no live list → only the run_code rule

  const fx = await makeFixture(t);
  const subagents = makeFakeSubagents();
  await assert.rejects(
    runStage({ stage: 'alpha' }, makeDeps(fx, { subagents, listTools: () => ['read', 'glob'] })),
    (e) => e.code === CODES.MANIFEST_INVALID && /grep/.test(e.message) && /restrict\(\)/.test(e.message),
  );
  assert.equal(subagents.calls.length, 0, 'refused BEFORE any child start');
});

// ---------------------------------------------------------------------------
// 3. Fail-closed: gate red, no output, dispatch failure, gate spawn failure
// ---------------------------------------------------------------------------

test('non-zero gate exit is reported (not thrown), with the gate-log tail; ledgered', async (t) => {
  const fx = await makeFixture(t);
  const deps = makeDeps(fx, {
    execFileImpl: makeFakeExecFile({ behavior: { code: 3, stdout: 'checking...\n', stderr: 'FAIL: artifact missing field spec_source\n' } }),
  });
  const out = await runStage({ stage: 'alpha' }, deps);

  // This assertion set kills mutation (c): a hardcoded gateExit=0 would
  // report green, drop the tail, and write a lying ledger line.
  assert.equal(out.gateExit, 3);
  assert.match(out.summary, /gateExit=3/);
  assert.match(out.summary, /--- gate log tail /);
  assert.match(out.summary, /FAIL: artifact missing field spec_source/);
  assert.ok(Buffer.byteLength(out.summary, 'utf8') <= 4000);

  const entries = await readLedger(join(fx.ws, LEDGER));
  assert.equal(entries[0].gateExit, 3);
  assert.equal(entries[0].error, null, 'a red gate is evidence, not an executor error');
  assert.deepEqual(deps.sessionState.stages.alpha, { attempt: 1, gateExit: 3, ledgerLine: 1 });
});

test('gate `then` chaining: second command only on strict first success', async (t) => {
  const fx = await makeFixture(t, {
    mutate: (m) => { m.stages[0].gate.then = ['validator2', '--check-files']; },
  });

  // First exits 0 → then runs, and ITS code is the gate verdict.
  const execA = makeFakeExecFile({ behavior: (file) => (file === 'validator2' ? { code: 7, stderr: 'structure drift\n' } : { code: 0 }) });
  const outA = await runStage({ stage: 'alpha' }, makeDeps(fx, { execFileImpl: execA }));
  assert.equal(execA.calls.length, 2);
  assert.deepEqual(execA.calls[1].argv, ['--check-files']);
  assert.equal(execA.calls[1].file, 'validator2');
  assert.equal(outA.gateExit, 7);

  // First exits non-zero → then NEVER runs.
  const execB = makeFakeExecFile({ behavior: { code: 2 } });
  const outB = await runStage({ stage: 'alpha', attempt: 2 }, makeDeps(fx, { execFileImpl: execB }));
  assert.equal(execB.calls.length, 1);
  assert.equal(outB.gateExit, 2);
});

test('gate runs with cwd = workspace and argv arrays (no shell)', async (t) => {
  const fx = await makeFixture(t);
  const execFileImpl = makeFakeExecFile();
  await runStage({ stage: 'alpha' }, makeDeps(fx, { execFileImpl }));
  assert.equal(execFileImpl.calls[0].opts.cwd, fx.ws);
  assert.equal(execFileImpl.calls[0].file, 'validator');
  assert.deepEqual(execFileImpl.calls[0].argv, ['artifacts/alpha.json']);
});

test('ROLE_NO_OUTPUT: structured missing OR stopReason not completed — ledgered, correct code', async (t) => {
  const fx = await makeFixture(t);
  const depsA = makeDeps(fx, { subagents: makeFakeSubagents({ behavior: { structured: undefined, stopReason: 'completed' } }) });
  await assert.rejects(
    runStage({ stage: 'alpha' }, depsA),
    (e) => e instanceof PipelineError && e.code === CODES.ROLE_NO_OUTPUT && /never parsed/.test(e.message),
  );

  const depsB = makeDeps(fx, { subagents: makeFakeSubagents({ behavior: { structured: { ok: true }, stopReason: 'aborted' } }) });
  await assert.rejects(
    runStage({ stage: 'alpha', attempt: 2 }, depsB),
    (e) => e.code === CODES.ROLE_NO_OUTPUT && /stopReason=aborted/.test(e.message),
  );

  const entries = await readLedger(join(fx.ws, LEDGER));
  assert.equal(entries.length, 2, 'both failed attempts are ledgered');
  assert.equal(entries[0].error, CODES.ROLE_NO_OUTPUT);
  assert.equal(entries[0].artifactPath, null, 'no artifact was written');
  assert.equal(entries[0].gateExit, null, 'gate never ran');
  assert.equal(entries[1].attempt, 2);
});

test('DISPATCH_FAILED carries the provider error verbatim; ledgered', async (t) => {
  const fx = await makeFixture(t);
  await assert.rejects(
    runStage({ stage: 'alpha' }, makeDeps(fx, { subagents: makeFakeSubagents({ startThrows: 'restrict() refused: unknown tool "web_search"' }) })),
    (e) => e.code === CODES.DISPATCH_FAILED && /restrict\(\) refused: unknown tool "web_search"/.test(e.message),
  );
  const entries = await readLedger(join(fx.ws, LEDGER));
  assert.equal(entries[0].error, CODES.DISPATCH_FAILED);
  assert.deepEqual(entries[0].childSessionIds, []);
});

test('DISPATCH_FAILED remedy split: a tools.restrict/unknown-global-tool crash blames the manifest whitelist, not the spawn provider row', async (t) => {
  const fx = await makeFixture(t);
  // The G1b-observed live shape (deployment without the whitelisted tool).
  await assert.rejects(
    runStage({ stage: 'alpha' }, makeDeps(fx, {
      subagents: makeFakeSubagents({ startThrows: 'tools.restrict() names unknown global tool "grep"; known global tools: glob, read' }),
    })),
    (e) => e instanceof PipelineError
      && e.code === CODES.DISPATCH_FAILED
      && /manifest whitelist names a tool absent from this deployment/.test(e.remedy)
      && /install\/mount the plugin/.test(e.remedy)
      && !/spawn provider row/.test(e.remedy)
      && /manifest whitelist/.test(e.toModelText()),
  );
  // Any other provider error keeps the generic spawn-provider remedy.
  await assert.rejects(
    runStage({ stage: 'alpha', attempt: 2 }, makeDeps(fx, {
      subagents: makeFakeSubagents({ startThrows: 'provider route "deepseek-official" unavailable' }),
    })),
    (e) => e.code === CODES.DISPATCH_FAILED
      && /spawn provider row/.test(e.remedy)
      && !/manifest whitelist/.test(e.remedy),
  );
});

test('GATE_SPAWN_FAILED: missing validator binary — remedy names python3; artifact + log still evidenced', async (t) => {
  const fx = await makeFixture(t);
  const deps = makeDeps(fx, { execFileImpl: makeFakeExecFile({ behavior: { spawnError: { code: 'ENOENT' } } }) });
  await assert.rejects(
    runStage({ stage: 'alpha' }, deps),
    (e) => e instanceof PipelineError && e.code === CODES.GATE_SPAWN_FAILED && /install python3/.test(e.remedy),
  );
  const entries = await readLedger(join(fx.ws, LEDGER));
  const e = entries[0];
  assert.equal(e.error, CODES.GATE_SPAWN_FAILED);
  assert.ok(e.artifactPath, 'artifact WAS written before the gate');
  assert.equal(e.artifactSha256, sha256(await readFile(e.artifactPath)));
  assert.ok(e.gateLogPath, 'spawn failure captured in the gate log');
  assert.match(await readFile(e.gateLogPath, 'utf8'), /spawn failed/);
});

test('LEDGER_WRITE_FAILED when the ledger cannot be appended (evidence is not optional)', async (t) => {
  const fx = await makeFixture(t, {
    mutate: (m) => { m.defaults.workspaceLayout.ledger = 'missing-dir/evidence-ledger.jsonl'; },
  });
  await assert.rejects(
    runStage({ stage: 'alpha' }, makeDeps(fx)),
    (e) => e instanceof PipelineError && e.code === CODES.LEDGER_WRITE_FAILED && /writable/.test(e.remedy),
  );
});

test('appendLedger is append-only with 1-based line numbers', async (t) => {
  const fx = await makeFixture(t);
  const path = join(fx.ws, 'l.jsonl');
  assert.equal(await appendLedger(path, { a: 1 }), 1);
  assert.equal(await appendLedger(path, { a: 2 }), 2);
  assert.equal(await appendLedger(path, { a: 3 }), 3);
  const entries = await readLedger(path);
  assert.deepEqual(entries.map((e) => e.a), [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// 4. Retry semantics
// ---------------------------------------------------------------------------

test('attempt 2 points the role at the previous gate log; attempt 1 does not', async (t) => {
  const fx = await makeFixture(t);
  const subagents = makeFakeSubagents();
  await runStage({ stage: 'alpha' }, makeDeps(fx, { subagents }));
  await runStage({ stage: 'alpha', attempt: 2 }, makeDeps(fx, { subagents }));

  const persona1 = subagents.calls[0].request.persona;
  const persona2 = subagents.calls[1].request.persona;
  assert.ok(!persona1.includes('gate-logs'), 'attempt 1 has no gate-log pointer');
  assert.ok(persona2.includes(join(fx.ws, 'gate-logs', 'alpha.attempt1.log')), 'attempt 2 points at attempt 1 log');
  assert.match(persona2, /read it from disk FIRST/i);
  // Pointer only — the log CONTENT is never inline-pasted.
  assert.ok(!persona2.includes('gate ok'), 'log content stays on disk');
});

test('attempt beyond the budget → ATTEMPT_EXCEEDED, nothing dispatched, nothing ledgered', async (t) => {
  const fx = await makeFixture(t); // retries: 2 → max attempt 3
  const subagents = makeFakeSubagents();
  await assert.rejects(
    runStage({ stage: 'alpha', attempt: 4 }, makeDeps(fx, { subagents })),
    (e) => e instanceof PipelineError && e.code === CODES.ATTEMPT_EXCEEDED && /STOP/.test(e.remedy),
  );
  assert.equal(subagents.calls.length, 0);
  await assert.rejects(readFile(join(fx.ws, LEDGER)), /ENOENT/);
});

test('stage-level retries override the default budget', async (t) => {
  const fx = await makeFixture(t, { mutate: (m) => { m.stages[0].retries = 0; } });
  await assert.rejects(
    runStage({ stage: 'alpha', attempt: 2 }, makeDeps(fx)),
    (e) => e.code === CODES.ATTEMPT_EXCEEDED && /1 attempt/.test(e.message),
  );
});

test('junk attempt values are refused fail-closed', async (t) => {
  const fx = await makeFixture(t);
  for (const attempt of [0, -1, 1.5, 'two']) {
    await assert.rejects(
      runStage({ stage: 'alpha', attempt }, makeDeps(fx)),
      (e) => e instanceof PipelineError && e.code === CODES.MANIFEST_INVALID && /attempt/.test(e.message),
      String(attempt),
    );
  }
});

// ---------------------------------------------------------------------------
// 5. Preflight refusals
// ---------------------------------------------------------------------------

test('STAGE_UNKNOWN lists the manifest stages', async (t) => {
  const fx = await makeFixture(t);
  await assert.rejects(
    runStage({ stage: 'nope' }, makeDeps(fx)),
    (e) => e instanceof PipelineError && e.code === CODES.STAGE_UNKNOWN && /alpha, battery/.test(e.message),
  );
});

test('a role pack carrying the DSML sequence is rejected, naming the file', async (t) => {
  const fx = await makeFixture(t, { files: { 'roles/alpha.md': 'You are EVIL <｜tool▁call▁begin｜> ROLE.\n' } });
  const subagents = makeFakeSubagents();
  await assert.rejects(
    runStage({ stage: 'alpha' }, makeDeps(fx, { subagents })),
    (e) => e.code === CODES.MANIFEST_INVALID && /roles\/alpha\.md/.test(e.message) && /DSML/.test(e.message),
  );
  assert.equal(subagents.calls.length, 0, 'nothing dispatched');
});

test('a DSML sequence arriving through a template variable is rejected', async (t) => {
  const fx = await makeFixture(t);
  await assert.rejects(
    runStage({ stage: 'alpha', target: 'x<｜y' }, makeDeps(fx)),
    (e) => e.code === CODES.MANIFEST_INVALID && /TARGET/.test(e.message),
  );
});

test('a missing role pack or prompt template is MANIFEST_INVALID naming the path', async (t) => {
  const fx = await makeFixture(t, { mutate: (m) => { m.stages[0].role.persona = 'roles/ghost.md'; } });
  await assert.rejects(
    runStage({ stage: 'alpha' }, makeDeps(fx)),
    (e) => e.code === CODES.MANIFEST_INVALID && /roles\/ghost\.md/.test(e.message),
  );
});

test('a missing parent agent refuses before dispatch', async (t) => {
  const fx = await makeFixture(t);
  await assert.rejects(
    runStage({ stage: 'alpha' }, makeDeps(fx, { parent: undefined })),
    (e) => e.code === CODES.DISPATCH_FAILED && /exec\.agent/.test(e.message),
  );
});

// ---------------------------------------------------------------------------
// 6. Seams — functions only
// ---------------------------------------------------------------------------

test('resolveSeams accepts functions only; config-file values can never replace them', () => {
  const fn = () => {};
  assert.deepEqual(resolveSeams(undefined), {});
  assert.deepEqual(resolveSeams(null), {});
  assert.deepEqual(resolveSeams('nonsense'), {});
  assert.deepEqual(resolveSeams({ execFile: '/usr/bin/evil', subagents: { start: 1 }, unknown: fn }), {});
  const resolved = resolveSeams({ execFile: fn, subagents: fn, measureTokens: fn, listTools: fn, extra: fn });
  assert.deepEqual(Object.keys(resolved).sort(), ['execFile', 'listTools', 'measureTokens', 'subagents']);
  assert.equal(resolved.execFile, fn);
});

test('tailLines keeps the last N lines', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join('\n');
  const tail = tailLines(text, 20);
  assert.ok(tail.startsWith('line-31'));
  assert.ok(tail.endsWith('line-50'));
  assert.equal(tail.split('\n').length, 20);
  assert.equal(tailLines('a\nb', 20), 'a\nb');
});

// ---------------------------------------------------------------------------
// 7. pipeline_status: read-only evidence view
// ---------------------------------------------------------------------------

test('statusReport: manifest sha, per-stage ledger evidence, session attempts, layout', async (t) => {
  const fx = await makeFixture(t);
  const sessionState = { stages: {} };
  await runStage({ stage: 'alpha' }, makeDeps(fx, { sessionState }));
  await runStage({ stage: 'alpha', attempt: 2 }, makeDeps(fx, {
    sessionState,
    execFileImpl: makeFakeExecFile({ behavior: { code: 3 } }),
  }));

  const { summary } = await statusReport({
    options: { manifestPath: 'manifest/pipeline.manifest.json', baseDir: fx.preset },
    workspace: fx.ws,
    manifestCache: new Map(),
    sessionState,
  });
  const manifestBytes = await readFile(join(fx.preset, 'manifest', 'pipeline.manifest.json'));
  assert.match(summary, /pipeline=fixture/);
  assert.ok(summary.includes(`manifestSha256=${sha256(manifestBytes)}`));
  assert.match(summary, /ledger: 2 line\(s\)/);
  assert.match(summary, /stage alpha: last attempt=2 gateExit=3 red \| this session: attempt=2 gateExit=3/);
  assert.match(summary, /stage battery: no evidence yet/);
  assert.match(summary, /artifacts=artifacts\//);
  assert.ok(Buffer.byteLength(summary, 'utf8') <= 4000);
});

test('statusReport on a fresh workspace: no ledger yet is not an error', async (t) => {
  const fx = await makeFixture(t);
  const { summary } = await statusReport({
    options: { manifestPath: 'manifest/pipeline.manifest.json', baseDir: fx.preset },
    workspace: fx.ws,
    sessionState: { stages: {} },
  });
  assert.match(summary, /ledger: 0 line\(s\)/);
  assert.match(summary, /stage alpha: no evidence yet/);
});

test('statusReport discloses unparseable ledger lines instead of skipping silently', async (t) => {
  const fx = await makeFixture(t);
  await runStage({ stage: 'alpha' }, makeDeps(fx));
  const { appendFile } = await import('node:fs/promises');
  await appendFile(join(fx.ws, LEDGER), 'CORRUPT-NOT-JSON\n');
  const { summary } = await statusReport({
    options: { manifestPath: 'manifest/pipeline.manifest.json', baseDir: fx.preset },
    workspace: fx.ws,
    sessionState: { stages: {} },
  });
  assert.match(summary, /WARNING: 1 unparseable line\(s\) skipped/);
});

// ---------------------------------------------------------------------------
// 8. Manifest cache is reused across calls (project property)
// ---------------------------------------------------------------------------

test('the manifest cache is keyed by path+mtime and reused across stage runs', async (t) => {
  const fx = await makeFixture(t);
  const manifestCache = new Map();
  await runStage({ stage: 'alpha' }, makeDeps(fx, { manifestCache }));
  await runStage({ stage: 'alpha', attempt: 2 }, makeDeps(fx, { manifestCache }));
  assert.equal(manifestCache.size, 1);
});

// ---------------------------------------------------------------------------
// 9. Fake host mount — execute returns die offline on schema violation
//    (BUILD.md Invariant 5; regression for the 0.1.0 G1b live bug)
// ---------------------------------------------------------------------------

test('REGRESSION (0.1.0 G1b): the fakes catch an execute return with keys beyond the declared output schema', async (t) => {
  const fx = await makeFixture(t);

  // The 0.1.0 bug shape, byte-for-byte: the tool returned runStage's RICH
  // result ({summary, gateExit, ledgerLine, childSessionIds}) while declaring
  // TEXT_OUTPUT_SCHEMA ({summary} only, additionalProperties: false). The
  // live host rejected every extra key AFTER the stage had fully succeeded.
  const buggy = mountTool({
    name: 'pipeline_stage',
    output: { schema: TEXT_OUTPUT_SCHEMA },
    execute: () => runStage({ stage: 'alpha' }, makeDeps(fx)),
  });
  await assert.rejects(
    buggy.execute({}, {}),
    (e) => /is not a declared property \(additionalProperties: false\)/.test(e.message)
      && /gateExit/.test(e.message)
      && /ledgerLine/.test(e.message)
      && /childSessionIds/.test(e.message),
  );

  // The 0.1.1 shape — exactly the declared {summary} — passes the same mount.
  const fixed = mountTool({
    name: 'pipeline_stage',
    output: { schema: TEXT_OUTPUT_SCHEMA },
    execute: async () => ({ summary: (await runStage({ stage: 'alpha', attempt: 2 }, makeDeps(fx))).summary }),
  });
  const value = await fixed.execute({}, {});
  assert.match(value.summary, /^stage=alpha attempt=2 gateExit=0 /);
});

test('validateAgainstSchema: strict walk — both required dialects, nesting, type checks', () => {
  // defineTool dialect: per-property required: true (TEXT_OUTPUT_SCHEMA shape).
  assert.deepEqual(validateAgainstSchema({ summary: 'ok' }, TEXT_OUTPUT_SCHEMA), []);
  assert.match(validateAgainstSchema({}, TEXT_OUTPUT_SCHEMA).join(';'), /missing required property/);
  assert.match(validateAgainstSchema({ summary: 7 }, TEXT_OUTPUT_SCHEMA).join(';'), /must be a string/);

  // outputSchema dialect: required as ARRAY + nested strict objects.
  const nested = {
    type: 'object',
    additionalProperties: false,
    required: ['inner'],
    properties: {
      inner: {
        type: 'object',
        additionalProperties: false,
        properties: { n: { type: 'number' } },
      },
      list: { type: 'array', items: { type: 'string' } },
    },
  };
  assert.deepEqual(validateAgainstSchema({ inner: { n: 1 }, list: ['a'] }, nested), []);
  assert.match(validateAgainstSchema({ inner: { n: 1, rogue: true } }, nested).join(';'), /"return\.inner\.rogue" is not a declared property/);
  assert.match(validateAgainstSchema({ inner: {}, list: ['a', 2] }, nested).join(';'), /"return\.list\[1\]" must be a string/);
  assert.match(validateAgainstSchema('nope', nested).join(';'), /must be an object/);
});

test('mountTool refuses a tool with no declared output.schema', () => {
  const error = grab(() => mountTool({ name: 'bare', execute: async () => ({}) }));
  assert.match(error.message, /declares no output\.schema/);
});
