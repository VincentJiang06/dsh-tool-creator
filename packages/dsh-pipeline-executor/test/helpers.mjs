/**
 * Shared fixtures for the dsh-pipeline-executor unit suite.
 *
 * Everything is offline and injected: a fake `subagents` registry, a fake
 * gate `execFile`, and per-test temp preset/workspace directories. No test
 * imports lib/index.js (it imports @deepseek-ai/* peers and cannot resolve
 * in a clean tree) — the suite targets the pure modules only.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The REAL shipped manifest — it must pass validation (SPEC test 1). */
export const REPO_MANIFEST_PATH = fileURLToPath(new URL('../../../src/manifest/pipeline.manifest.json', import.meta.url));

/** The REAL shipped output schemas — they must pass the loader (G1b guard). */
export const REPO_SCHEMAS_DIR = fileURLToPath(new URL('../../../src/schemas/', import.meta.url));

export const ROLE_ALPHA = 'You are ALPHA-ROLE.\nRed-first discipline; evidence over claims.\n';
export const ROLE_LENS = 'You are BATTERY-LENS.\nAttack the target through exactly one lens.\n';
export const ROLE_SYNTH = 'You are BATTERY-SYNTHESIS.\nRead lens artifacts from disk; emit the decision.\n';

export const TEMPLATE = [
  '## DISPATCH CONTEXT (this run)',
  '- Stage: {{STAGE}}, attempt {{ATTEMPT}}. Workspace: {{WORKSPACE}}',
  '- Build target kind: {{TARGET}}',
  '- Artifact: {{ARTIFACT}}',
  '{{GATE_LOG_PREV}}',
  '',
].join('\n');

export const ALPHA_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};

export const DECISION_SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string' } },
  required: ['verdict'],
  additionalProperties: false,
};

export const LENSES = ['coherence', 'gaming', 'evidence', 'reality', 'foundation'];

/** A minimal manifest exercising both stage shapes (single role + fanout). */
export function fixtureManifest() {
  return {
    manifestVersion: 1,
    pipeline: 'fixture',
    defaults: {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      retries: 2,
      workspaceLayout: {
        request: 'request.md',
        artifacts: 'artifacts/',
        build: 'build/',
        gateLogs: 'gate-logs/',
        ledger: 'evidence-ledger.jsonl',
      },
    },
    stages: [
      {
        id: 'alpha',
        role: { persona: 'roles/alpha.md', tools: ['read', 'glob', 'grep'], maxTokens: 4096 },
        dispatch: { promptTemplate: 'manifest/prompts/alpha.md', outputSchema: 'schemas/alpha-out.json' },
        artifact: 'artifacts/alpha.json',
        gate: { cmd: ['validator', 'artifacts/alpha.json'] },
      },
      {
        id: 'battery',
        fanout: {
          lenses: [...LENSES],
          lensPersona: 'roles/lens.md',
          lensTools: ['read', 'grep'],
          lensMaxTokens: 2048,
          synthesis: { persona: 'roles/synth.md', tools: ['read'], maxTokens: 2048 },
        },
        dispatch: { promptTemplate: 'manifest/prompts/alpha.md', outputSchema: 'schemas/decision.json' },
        artifact: 'artifacts/decision.json',
        gate: { cmd: ['validator', 'artifacts/decision.json'] },
      },
    ],
  };
}

/**
 * Build a temp preset dir + workspace dir. `mutate(manifest)` may edit the
 * fixture manifest before it is written. Cleanup is registered on `t`.
 */
export async function makeFixture(t, { mutate, files } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dpe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preset = join(root, 'preset');
  const ws = join(root, 'ws');
  await mkdir(join(preset, 'manifest', 'prompts'), { recursive: true });
  await mkdir(join(preset, 'roles'), { recursive: true });
  await mkdir(join(preset, 'schemas'), { recursive: true });
  await mkdir(ws, { recursive: true });

  const manifest = fixtureManifest();
  mutate?.(manifest);
  await writeFile(join(preset, 'manifest', 'pipeline.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(preset, 'manifest', 'prompts', 'alpha.md'), TEMPLATE);
  await writeFile(join(preset, 'roles', 'alpha.md'), ROLE_ALPHA);
  await writeFile(join(preset, 'roles', 'lens.md'), ROLE_LENS);
  await writeFile(join(preset, 'roles', 'synth.md'), ROLE_SYNTH);
  await writeFile(join(preset, 'schemas', 'alpha-out.json'), `${JSON.stringify(ALPHA_SCHEMA, null, 2)}\n`);
  await writeFile(join(preset, 'schemas', 'decision.json'), `${JSON.stringify(DECISION_SCHEMA, null, 2)}\n`);
  for (const [rel, content] of Object.entries(files ?? {})) {
    await writeFile(join(preset, rel), content);
  }
  return { root, preset, ws, manifest };
}

/**
 * Fake `subagents` registry. `plan.behavior` may be an object or a
 * `(request, id) => behavior` function; behavior = {structured, stopReason,
 * output, reject}. Tracks every request and the max in-flight concurrency.
 */
export function makeFakeSubagents(plan = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let n = 0;
  return {
    calls,
    get maxInFlight() { return maxInFlight; },
    async start(provider, request) {
      calls.push({ provider, request });
      if (plan.startThrows) {
        throw plan.startThrows instanceof Error ? plan.startThrows : new Error(String(plan.startThrows));
      }
      n += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const id = `child-${n}`;
      const behave = (typeof plan.behavior === 'function' ? plan.behavior(request, id) : plan.behavior) ?? {};
      const result = (async () => {
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        if (behave.reject) throw behave.reject;
        return {
          output: behave.output ?? [],
          structured: 'structured' in behave ? behave.structured : { ok: true },
          stopReason: behave.stopReason ?? 'completed',
        };
      })();
      return { id, result, dispose: plan.dispose ?? (() => {}) };
    },
  };
}

/**
 * Fake gate executor. `plan.behavior` may be an object or a
 * `(file, argv, opts, callNo) => behavior` function; behavior = {code,
 * stdout, stderr, spawnError}.
 */
export function makeFakeExecFile(plan = {}) {
  const calls = [];
  const fn = async (file, argv, opts) => {
    calls.push({ file, argv, opts });
    const behave = (typeof plan.behavior === 'function' ? plan.behavior(file, argv, opts, calls.length) : plan.behavior) ?? {};
    if (behave.spawnError) {
      const error = new Error(behave.spawnError.message ?? `spawn ${file} ${behave.spawnError.code ?? 'ENOENT'}`);
      Object.assign(error, behave.spawnError);
      throw error;
    }
    return { code: behave.code ?? 0, stdout: behave.stdout ?? 'gate ok\n', stderr: behave.stderr ?? '' };
  };
  fn.calls = calls;
  return fn;
}

/** Standard runStage deps over a fixture; override anything per test. */
export function makeDeps(fx, overrides = {}) {
  return {
    options: {
      manifestPath: 'manifest/pipeline.manifest.json',
      baseDir: fx.preset,
      maxConcurrentDispatches: 2,
      dispatchTimeoutMs: 60_000,
    },
    workspace: fx.ws,
    subagents: makeFakeSubagents(),
    execFileImpl: makeFakeExecFile(),
    parent: { id: 'parent-agent' },
    signal: undefined,
    manifestCache: new Map(),
    sessionState: { stages: {} },
    ...overrides,
  };
}

/** Recursive file listing (workspace-relative, sorted) — the write-surface probe. */
export async function listFiles(dir, prefix = '') {
  const { readdir } = await import('node:fs/promises');
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await listFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/** Run `fn`, return the error it throws; fail the test if it does not throw. */
export function grab(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, but it returned');
}

/** Parse the ledger from DISK (never trust return values for evidence). */
export async function readLedger(ledgerPath) {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(ledgerPath, 'utf8');
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}
