// test/assembly.test.mjs — L4 integration check: a synthetic pipeline
// workspace (executor-shaped ledger + gate-validated artifacts + a tiny build
// tree) goes through the MECHANICAL assembler (src/validators/
// assemble_manifest.py, the battery gate's `then` command) and the resulting
// acceptance-manifest.json must re-verify GREEN under tools/reverify.mjs in
// hash-only mode — the same verifier any installer/directory runs. Plus the
// fold-mismatch refusal: the assembler must REFUSE to write a manifest whose
// effective verdict disagrees with the recomputed min-fold.
//
// Run: node --test test/assembly.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ASSEMBLER = new URL('../src/validators/assemble_manifest.py', import.meta.url).pathname;
const REVERIFY = new URL('../tools/reverify.mjs', import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Synthetic workspace: exactly the artifacts the real pipeline produces
// ---------------------------------------------------------------------------

function greenDecision() {
  return {
    target: 'toy-skill',
    acceptance: {
      re_audit_verdict: 'industrial',
      battery_verdict: 'clean',
      battery_independence_tier: 'model',
      battery_stop_reason: 'E9 pre-registered condition fired',
      effective_verdict: 'industrial',
    },
  };
}

function greenDossier() {
  return {
    layers: [
      { layer: 'E-L0', eval_kind: 'regression', cases_total: 4, cases_passed: 4, verdict: 'green', notes: '' },
      {
        layer: 'E-L1', eval_kind: 'capability', cases_total: 20, cases_passed: 19, verdict: 'green',
        notes: 'baseline_delta: n/a — behavioral baseline captured as red artifact; no second graded arm this creation',
      },
      {
        layer: 'E-L4', eval_kind: 'capability', cases_total: 0, cases_passed: 0, verdict: 'not_run',
        notes: 'end-to-end workflow needs a live host session',
      },
    ],
    verification: {
      harness_ran: true, harness_path: 'evals/run_harness.sh',
      all_required_passed: true, command_output: '12/12 green', exit_code: 0,
    },
  };
}

function buildWorkspace({ decision = greenDecision() } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'l4-assembly-'));
  const ws = path.join(root, 'ws');
  const sha = 'c'.repeat(64);
  const ledger = [
    {
      ts: '2026-08-17T01:00:00Z', pipeline: 'tool-creator', manifestSha256: sha, stage: 'composer', attempt: 1,
      childSessionIds: ['sess-composer'], gateExit: 0, roleModel: 'deepseek-v4-pro', tokens: null, error: null,
    },
    {
      ts: '2026-08-17T02:00:00Z', pipeline: 'tool-creator', manifestSha256: sha, stage: 'engineer', attempt: 1,
      childSessionIds: ['sess-engineer'], gateExit: 0, roleModel: 'deepseek-v4-pro', tokens: 4242, error: null,
    },
  ];
  const files = {
    'ws/evidence-ledger.jsonl': ledger.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'ws/artifacts/decision-record.json': JSON.stringify(decision, null, 2) + '\n',
    'ws/artifacts/evidence-dossier.json': JSON.stringify(greenDossier(), null, 2) + '\n',
    'ws/artifacts/battery-lens-coherence.json': JSON.stringify({ findings: [{ lens: 'coherence', severity: 'P3', claim: 'wording nit' }], flags: [] }) + '\n',
    'ws/build/SKILL.md': '---\nname: toy-skill\nversion: 0.3.0\n---\n# toy-skill\nA fixture skill.\n',
    'ws/build/references/notes.md': '# notes\nfixture reference file.\n',
    'ws/build/evals/run_harness.sh': '#!/bin/sh\nexit 0\n',
    'fake-dsh/profiles/node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0-rc.7-test' }) + '\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return { root, ws, dshRoot: path.join(root, 'fake-dsh'), out: path.join(ws, 'artifacts', 'acceptance-manifest.json') };
}

function runAssembler(fx) {
  return spawnSync('python3', [
    ASSEMBLER, '--workspace', fx.ws, '--build-subdir', 'build', '--out', fx.out,
    '--provider', 'deepseek-official', '--dsh-root', fx.dshRoot,
  ], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// GREEN end-to-end: assemble → package (copy to artifact root) → reverify
// ---------------------------------------------------------------------------

test('synthetic workspace assembles, and reverify --skip-commands is GREEN end-to-end', () => {
  const fx = buildWorkspace();
  try {
    const asm = runAssembler(fx);
    assert.equal(asm.status, 0, `assembler failed:\n${asm.stdout}\n${asm.stderr}`);
    assert.match(asm.stdout, /^PASS: /);

    // Packaging step (what an installer does): the manifest travels INTO the
    // artifact root. The assembler excluded the basename from the walk, so
    // the copy does not disturb the pinned hashes.
    const shipped = path.join(fx.ws, 'build', 'acceptance-manifest.json');
    copyFileSync(fx.out, shipped);

    const rv = spawnSync(process.execPath, [REVERIFY, '--manifest', shipped, '--json', '--skip-commands'], { encoding: 'utf8' });
    const json = JSON.parse(rv.stdout);
    assert.equal(rv.status, 0, `reverify red:\n${rv.stdout}`);
    assert.equal(json.ok, true);
    assert.equal(json.mode, 'hash-only');
    for (const id of ['schema-shape', 'semantic', 'verdict-fold', 'root-hash', 'unlisted-files', 'harness-path',
      'hash:SKILL.md', 'hash:references/notes.md', 'hash:evals/run_harness.sh']) {
      const check = json.checks.find((c) => c.id === id);
      assert.ok(check, `check ${id} missing`);
      assert.equal(check.status, 'PASS', `expected ${id} PASS, got ${check.status}: ${check.detail}`);
    }

    // Content spot-checks: everything mechanical, nothing model-shaped.
    const manifest = JSON.parse(readFileSync(fx.out, 'utf8'));
    assert.equal(manifest.artifact.name, 'toy-skill');
    assert.equal(manifest.artifact.kind, 'skill');
    assert.equal(manifest.artifact.version, '0.3.0');
    assert.deepEqual(Object.keys(manifest.artifact.files).sort(),
      ['SKILL.md', 'evals/run_harness.sh', 'references/notes.md']);
    assert.equal(manifest.provenance.model.id, 'deepseek-v4-pro');
    assert.equal(manifest.provenance.dshVersion, '1.0.0-rc.7-test');
    assert.deepEqual(manifest.provenance.sessionIds, ['sess-composer', 'sess-engineer']);
    assert.deepEqual(manifest.verdicts, {
      reAudit: 'industrial', battery: 'clean', effective: 'industrial',
      batteryFindingsCounts: { p1: 0, p2: 0, p3: 1 },
    });
    assert.equal(manifest.baselineDelta.measured, false);
    assert.match(manifest.baselineDelta.note, /n\/a/);
    assert.ok(manifest.limits.some((l) => l.includes('E-L4')), 'not_run layer named in limits');
    assert.deepEqual(manifest.reverify.commands.map((c) => c.id), ['harness', 'validate-dossier', 'validate-structure']);
    for (const cmd of manifest.reverify.commands) {
      assert.equal(cmd.cwd, '.');
      for (const arg of cmd.argv) assert.ok(!path.isAbsolute(arg), `argv must be relative, got ${arg}`);
    }
    assert.equal(manifest.reverify.harnessPath, 'evals/run_harness.sh');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The refusal the standard exists for: fold mismatch never ships
// ---------------------------------------------------------------------------

test('fold mismatch: assembler REFUSES (exit 1, names the discrepancy, writes nothing)', () => {
  const decision = greenDecision();
  decision.acceptance.battery_verdict = 'not_run'; // caps at candidate
  decision.acceptance.effective_verdict = 'industrial'; // fabricated above the fold
  const fx = buildWorkspace({ decision });
  try {
    const asm = runAssembler(fx);
    assert.equal(asm.status, 1);
    assert.match(asm.stdout, /fold mismatch/);
    assert.match(asm.stdout, /not_run/);
    assert.match(asm.stdout, /industrial/);
    assert.match(asm.stdout, /candidate/, 'the recomputed fold value is named');
    assert.equal(existsSync(fx.out), false, 'no manifest bytes exist after a refusal');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
