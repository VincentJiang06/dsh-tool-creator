/** Unit suite: battery fanout — lens pool, executor-written lens artifacts, path-only synthesis. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CODES } from '../lib/manifest.js';
import { runStage } from '../lib/dispatch.js';
import {
  DECISION_SCHEMA,
  LENSES,
  ROLE_LENS,
  ROLE_SYNTH,
  makeDeps,
  makeFakeExecFile,
  makeFakeSubagents,
  makeFixture,
  readLedger,
} from './helpers.mjs';

/** Behavior keyed off the dispatch label: lenses return sentinels, synthesis the verdict. */
function batteryBehavior(request) {
  const lensMatch = request.label.match(/lens (\S+)$/);
  if (lensMatch) return { structured: { finding: `SENTINEL-${lensMatch[1]}`, lens: lensMatch[1] } };
  return { structured: { verdict: 'ship' } };
}

test('fanout: 5 confined lens dispatches + synthesis; executor writes every lens artifact', async (t) => {
  const fx = await makeFixture(t);
  const subagents = makeFakeSubagents({ behavior: batteryBehavior });
  let artifactExistedAtGateTime = null;
  const execFileImpl = makeFakeExecFile({
    behavior: () => {
      artifactExistedAtGateTime = existsSync(join(fx.ws, 'artifacts', 'decision.json'));
      return { code: 0 };
    },
  });
  const deps = makeDeps(fx, { subagents, execFileImpl });
  const out = await runStage({ stage: 'battery', target: 'plugin' }, deps);

  // 5 lens dispatches then 1 synthesis, all through the spawn provider.
  assert.equal(subagents.calls.length, 6);
  const lensCalls = subagents.calls.slice(0, 5);
  const synthCall = subagents.calls[5];
  assert.deepEqual(lensCalls.map((c) => c.request.label).sort(), LENSES.map((l) => `forge battery lens ${l}`).sort());
  assert.equal(synthCall.request.label, 'forge battery synthesis');

  // Concurrency cap NEVER exceeded. (SPEC allows sequential-or-capped, so
  // the deterministic invariant is the upper bound; whether both workers
  // overlap in a given run depends on real fs timing inside buildRequest —
  // the cap=1 test below pins the strict-sequencing side.)
  assert.ok(subagents.maxInFlight <= 2, `maxInFlight ${subagents.maxInFlight} exceeds the cap`);
  assert.ok(subagents.maxInFlight >= 1);

  // Confinement per dispatch class.
  for (const call of lensCalls) {
    assert.ok(call.request.persona.startsWith(ROLE_LENS), 'lens persona = lens role pack');
    assert.deepEqual(call.request.toolFilter, { allow: ['read', 'grep'] });
    assert.equal(call.request.agentOptions.maxTokens, 2048);
    // Default lens schema: permissive but object-rooted with EXPLICIT additionalProperties.
    assert.deepEqual(call.request.outputSchema, { type: 'object', properties: {}, additionalProperties: true });
    const lens = call.request.label.match(/lens (\S+)$/)[1];
    assert.match(call.request.prompt[0].text, new RegExp(`You are the "${lens}" lens`));
  }
  assert.ok(synthCall.request.persona.startsWith(ROLE_SYNTH), 'synthesis persona = synthesis role pack');
  assert.deepEqual(synthCall.request.toolFilter, { allow: ['read'] });
  assert.deepEqual(synthCall.request.outputSchema, DECISION_SCHEMA);

  // The EXECUTOR wrote each lens artifact from the structured return.
  for (const lens of LENSES) {
    const lensPath = join(fx.ws, 'artifacts', `battery-lens-${lens}.json`);
    assert.deepEqual(JSON.parse(await readFile(lensPath, 'utf8')), { finding: `SENTINEL-${lens}`, lens });
  }

  // Synthesis receives the artifact PATHS — never the payloads.
  const synthPrompt = synthCall.request.prompt[0].text;
  for (const lens of LENSES) {
    assert.ok(synthPrompt.includes(join(fx.ws, 'artifacts', `battery-lens-${lens}.json`)), `path for ${lens} listed`);
  }
  assert.ok(!synthPrompt.includes('SENTINEL-'), 'lens payloads are NOT relayed through the model');
  assert.ok(!synthCall.request.persona.includes('SENTINEL-'), 'nor through the persona');

  // Stage artifact = the SYNTHESIS structured return; gate ran AFTER it existed.
  assert.deepEqual(JSON.parse(await readFile(join(fx.ws, 'artifacts', 'decision.json'), 'utf8')), { verdict: 'ship' });
  assert.equal(artifactExistedAtGateTime, true, 'gate ran after the synthesis artifact was written');
  assert.equal(out.gateExit, 0);

  // One ledger line for the whole fanout stage, carrying all 6 child ids.
  const entries = await readLedger(join(fx.ws, 'evidence-ledger.jsonl'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].childSessionIds.length, 6);
  assert.equal(new Set(entries[0].childSessionIds).size, 6);
});

test('fanout honors maxConcurrentDispatches = 1 (strictly sequential lenses)', async (t) => {
  const fx = await makeFixture(t);
  const subagents = makeFakeSubagents({ behavior: batteryBehavior });
  const deps = makeDeps(fx, { subagents });
  deps.options.maxConcurrentDispatches = 1;
  await runStage({ stage: 'battery' }, deps);
  assert.equal(subagents.maxInFlight, 1);
  assert.equal(subagents.calls.length, 6);
});

test('a failing lens fails the stage fail-closed: ledgered, synthesis never dispatched', async (t) => {
  const fx = await makeFixture(t);
  const subagents = makeFakeSubagents({
    behavior: (request) => (request.label.endsWith('lens gaming')
      ? { structured: undefined, stopReason: 'error' }
      : batteryBehavior(request)),
  });
  await assert.rejects(
    runStage({ stage: 'battery' }, makeDeps(fx, { subagents })),
    (e) => e.code === CODES.ROLE_NO_OUTPUT,
  );
  assert.ok(!subagents.calls.some((c) => c.request.label === 'forge battery synthesis'), 'no synthesis after a lens failure');
  const entries = await readLedger(join(fx.ws, 'evidence-ledger.jsonl'));
  assert.equal(entries[0].error, CODES.ROLE_NO_OUTPUT);
  assert.equal(entries[0].artifactPath, null, 'no stage artifact from a broken battery');
});

test('fanout.lensOutputSchema (additive field) replaces the permissive lens schema', async (t) => {
  const fx = await makeFixture(t, {
    mutate: (m) => { m.stages[1].fanout.lensOutputSchema = 'schemas/alpha-out.json'; },
  });
  const subagents = makeFakeSubagents({ behavior: batteryBehavior });
  await runStage({ stage: 'battery' }, makeDeps(fx, { subagents }));
  const lensCall = subagents.calls.find((c) => /lens /.test(c.request.label));
  assert.equal(lensCall.request.outputSchema.additionalProperties, false);
  assert.deepEqual(lensCall.request.outputSchema.required, ['ok']);
});
