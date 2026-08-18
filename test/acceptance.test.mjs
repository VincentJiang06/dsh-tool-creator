// test/acceptance.test.mjs — G4 gradientless check for the acceptance-manifest
// standard: a known-good toy artifact must verify green, and each seeded-bad
// variant must fail RED on the specific check that owns that failure mode —
// the assertions name WHICH check failed, never just "nonzero exit".
//
// Run: node --test test/acceptance.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { ACCEPTANCE_SCHEMA, computeRootHash } from '../tools/reverify.mjs';

const REVERIFY = new URL('../tools/reverify.mjs', import.meta.url).pathname;
const SCHEMA_FILE = new URL('../src/schemas/acceptance-manifest.json', import.meta.url).pathname;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// Fixture builder: a known-good toy artifact, built fresh per test
// ---------------------------------------------------------------------------
const PY_CONTENT_CHECK =
  "import sys;d=open('data/expected.txt','rb').read();ok=d==b'42\\n';" +
  "print('content-ok' if ok else 'content-bad');sys.exit(0 if ok else 3)";

function buildGoodArtifact() {
  const dir = mkdtempSync(path.join(tmpdir(), 'am-fixture-'));
  const files = {
    'SKILL.md': '# toy-skill\nA fixture artifact for the acceptance-manifest standard.\n',
    'data/expected.txt': '42\n',
    'evals/run_harness.sh': "#!/bin/sh\n# toy harness placeholder — referenced by harnessPath\nexit 0\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  const fileHashes = Object.fromEntries(
    Object.entries(files).map(([rel, content]) => [rel, sha256(Buffer.from(content, 'utf8'))]));
  const manifest = {
    manifestVersion: 1,
    artifact: {
      name: 'toy-skill',
      kind: 'skill',
      version: '0.1.0',
      rootHash: computeRootHash(fileHashes),
      files: fileHashes,
    },
    provenance: {
      pipeline: 'dsh-tool-creator',
      pipelineVersion: '0.0.1',
      createdAt: '2026-08-17T00:00:00Z',
      dshVersion: '1.0.0-rc.6',
      model: { provider: 'deepseek', id: 'deepseek-v4-pro' },
      evidenceLedgerSha256: sha256(Buffer.from('fixture-ledger\n', 'utf8')),
      sessionIds: ['sess-composer-1', 'sess-battery-1'],
    },
    verdicts: {
      reAudit: 'candidate',
      battery: 'clean',
      effective: 'candidate',
      batteryFindingsCounts: { p1: 0, p2: 0, p3: 1 },
    },
    reverify: {
      commands: [
        {
          id: 'exit-zero',
          argv: ['python3', '-c', 'import sys;sys.exit(0)'],
          cwd: '.',
          expectedExit: 0,
          description: 'trivial deterministic pass',
        },
        {
          id: 'content-check',
          argv: ['python3', '-c', PY_CONTENT_CHECK],
          cwd: '.',
          expectedExit: 0,
          description: 'real file-content check over data/expected.txt',
        },
      ],
      harnessPath: 'evals/run_harness.sh',
      expectedSummaryRegex: 'content-ok',
    },
    baselineDelta: {
      measured: false,
      note: 'toy fixture: no baseline experiment exists for a synthetic artifact',
    },
    limits: ['toy fixture: exit-code + byte checks only; no live-model layer exists to pin'],
  };
  writeManifest(dir, manifest);
  return { dir, manifest };
}

function writeManifest(dir, manifest) {
  writeFileSync(path.join(dir, 'acceptance-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

function runReverify(dir, extraArgs = []) {
  const r = spawnSync(process.execPath,
    [REVERIFY, '--manifest', path.join(dir, 'acceptance-manifest.json'), '--json', ...extraArgs],
    { encoding: 'utf8' });
  assert.equal(r.error, undefined);
  let json;
  try { json = JSON.parse(r.stdout); }
  catch { assert.fail(`non-JSON output (exit ${r.status}):\n${r.stdout}\n${r.stderr}`); }
  return { status: r.status, json };
}

function statusOf(json, id) {
  const c = json.checks.find((c) => c.id === id);
  assert.ok(c, `check "${id}" missing from output (have: ${json.checks.map((x) => x.id).join(', ')})`);
  return c;
}

// ---------------------------------------------------------------------------
// Schema-drift guard: the embedded copy IS the file
// ---------------------------------------------------------------------------
test('embedded schema is byte-equal (as data) to src/schemas/acceptance-manifest.json', () => {
  assert.deepStrictEqual(JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')), ACCEPTANCE_SCHEMA);
});

// ---------------------------------------------------------------------------
// Green direction
// ---------------------------------------------------------------------------
test('known-good artifact: every check PASS, exit 0', () => {
  const { dir } = buildGoodArtifact();
  try {
    const { status, json } = runReverify(dir);
    assert.equal(status, 0);
    assert.equal(json.ok, true);
    for (const id of ['schema-shape', 'semantic', 'verdict-fold',
      'hash:SKILL.md', 'hash:data/expected.txt', 'hash:evals/run_harness.sh',
      'unlisted-files', 'root-hash', 'harness-path',
      'cmd:exit-zero', 'cmd:content-check', 'summary-regex', 'tree-unchanged']) {
      assert.equal(statusOf(json, id).status, 'PASS', `expected ${id} PASS`);
    }
    assert.deepStrictEqual(json.failed, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('known-good artifact, human table mode: prints PASS summary', () => {
  const { dir } = buildGoodArtifact();
  try {
    const r = spawnSync(process.execPath,
      [REVERIFY, '--manifest', path.join(dir, 'acceptance-manifest.json')], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /schema-shape\s+PASS/);
    assert.match(r.stdout, /reverify: PASS \(13\/13 checks\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('hash-only mode (--skip-commands): command checks SKIP, exit 0', () => {
  const { dir } = buildGoodArtifact();
  try {
    const { status, json } = runReverify(dir, ['--skip-commands']);
    assert.equal(status, 0);
    assert.equal(json.mode, 'hash-only');
    assert.equal(statusOf(json, 'root-hash').status, 'PASS');
    for (const id of ['cmd:exit-zero', 'cmd:content-check', 'summary-regex', 'tree-unchanged']) {
      assert.equal(statusOf(json, id).status, 'SKIP');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Red direction — seeded-bad variants, each asserting WHICH check failed
// ---------------------------------------------------------------------------
test('seeded bad (i): one file byte flipped -> hash:data/expected.txt FAIL, commands refused', () => {
  const { dir } = buildGoodArtifact();
  try {
    writeFileSync(path.join(dir, 'data/expected.txt'), '43\n'); // the flip
    const { status, json } = runReverify(dir);
    assert.equal(status, 1);
    assert.deepStrictEqual([...json.failed].sort(), ['hash:data/expected.txt', 'root-hash']);
    assert.match(statusOf(json, 'hash:data/expected.txt').detail, /sha256 mismatch: manifest [a-f0-9]{64}, disk [a-f0-9]{64}/);
    // fail-closed: unverified bytes are never executed
    for (const id of ['cmd:exit-zero', 'cmd:content-check', 'summary-regex', 'tree-unchanged']) {
      const c = statusOf(json, id);
      assert.equal(c.status, 'SKIP');
      assert.match(c.detail, /not run: hash verification failed/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('seeded bad (ii): expectedExit mismatch -> cmd:exit-zero FAIL, everything else green', () => {
  const { dir, manifest } = buildGoodArtifact();
  try {
    manifest.reverify.commands[0].expectedExit = 1; // command really exits 0
    writeManifest(dir, manifest); // manifest itself is not hashed, so hashes stay green
    const { status, json } = runReverify(dir);
    assert.equal(status, 1);
    assert.deepStrictEqual(json.failed, ['cmd:exit-zero']);
    assert.match(statusOf(json, 'cmd:exit-zero').detail, /expected exit 1, got 0/);
    assert.equal(statusOf(json, 'cmd:content-check').status, 'PASS');
    assert.equal(statusOf(json, 'tree-unchanged').status, 'PASS');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('seeded bad (iii): missing required field -> schema-shape FAIL, nothing else evaluated', () => {
  const { dir, manifest } = buildGoodArtifact();
  try {
    delete manifest.verdicts;
    writeManifest(dir, manifest);
    const { status, json } = runReverify(dir);
    assert.equal(status, 1);
    assert.deepStrictEqual(json.failed, ['schema-shape']);
    assert.match(statusOf(json, 'schema-shape').detail, /missing required field "verdicts"/);
    // fail-closed: shape failure stops the run before hashes or commands
    assert.equal(json.checks.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The honesty gates the standard exists for
// ---------------------------------------------------------------------------
test('fabricated verdict: effective above the battery min-fold -> verdict-fold FAIL', () => {
  const { dir, manifest } = buildGoodArtifact();
  try {
    manifest.verdicts.battery = 'breaches_found'; // caps effective at candidate (F7-aligned fold)
    manifest.verdicts.reAudit = 'industrial';
    manifest.verdicts.effective = 'industrial';   // fabricated: exceeds the breaches_found cap
    writeManifest(dir, manifest);
    const { status, json } = runReverify(dir);
    assert.equal(status, 1);
    assert.deepStrictEqual(json.failed, ['verdict-fold']);
    assert.match(statusOf(json, 'verdict-fold').detail, /exceeds min-fold/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('baselineDelta fabrication guard: measured=false with empty note -> semantic FAIL', () => {
  const { dir, manifest } = buildGoodArtifact();
  try {
    manifest.baselineDelta = { measured: false, note: '  ' };
    writeManifest(dir, manifest);
    const { status, json } = runReverify(dir);
    assert.equal(status, 1);
    assert.deepStrictEqual(json.failed, ['semantic']);
    assert.match(statusOf(json, 'semantic').detail, /measured=false requires a non-empty note/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tamper by addition: rogue file on disk -> unlisted-files FAIL, commands refused', () => {
  const { dir } = buildGoodArtifact();
  try {
    writeFileSync(path.join(dir, 'evals/rogue.sh'), 'echo pwned\n');
    const { status, json } = runReverify(dir);
    assert.equal(status, 1);
    assert.deepStrictEqual(json.failed, ['unlisted-files']);
    assert.match(statusOf(json, 'unlisted-files').detail, /on disk but not in manifest: evals\/rogue\.sh/);
    assert.equal(statusOf(json, 'cmd:exit-zero').status, 'SKIP');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
