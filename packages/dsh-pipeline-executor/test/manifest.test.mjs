/** Unit suite: pure manifest logic (validation, templates, clamps, taxonomy, cache). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODES,
  DSML_SEQUENCE,
  PipelineError,
  REMEDIES,
  TEMPLATE_VARS,
  assertNoDsml,
  clampBytes,
  loadManifest,
  loadOutputSchema,
  renderTemplate,
  resolveOptions,
  sha256,
  validateManifest,
} from '../lib/manifest.js';
import { REPO_MANIFEST_PATH, REPO_SCHEMAS_DIR, fixtureManifest, grab } from './helpers.mjs';

// ---------------------------------------------------------------------------
// The shipped manifest is the contract: it must pass, exactly as on disk.
// ---------------------------------------------------------------------------

test('the shipped pipeline.manifest.json passes validation verbatim', async () => {
  const doc = JSON.parse(await readFile(REPO_MANIFEST_PATH, 'utf8'));
  assert.equal(validateManifest(doc), doc);
  assert.equal(doc.stages.length, 5);
});

test('every shipped output schema passes the outputSchema loader', async () => {
  const files = (await readdir(REPO_SCHEMAS_DIR)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 5, `expected the five shipped schemas, found ${files.length}`);
  for (const file of files) {
    const schema = await loadOutputSchema(join(REPO_SCHEMAS_DIR, file));
    assert.equal(schema.type, 'object', file);
    assert.equal(typeof schema.additionalProperties, 'boolean', file);
  }
});

// ---------------------------------------------------------------------------
// Fail-closed validation — each rejection names the offending field
// ---------------------------------------------------------------------------

const REJECTIONS = [
  ['manifestVersion !== 1', (m) => { m.manifestVersion = 2; }, /manifestVersion/],
  ['missing pipeline name', (m) => { delete m.pipeline; }, /\bpipeline\b/],
  ['negative defaults.retries', (m) => { m.defaults.retries = -1; }, /defaults\.retries/],
  ['missing workspaceLayout.ledger', (m) => { delete m.defaults.workspaceLayout.ledger; }, /workspaceLayout\.ledger/],
  ['empty stages', (m) => { m.stages = []; }, /stages/],
  ['duplicate stage id', (m) => { m.stages[1].id = 'alpha'; }, /duplicates stage id "alpha"/],
  ['path-unsafe stage id', (m) => { m.stages[0].id = 'a/b'; }, /stages\[0\]\.id/],
  ['role.tools not an array', (m) => { m.stages[0].role.tools = 'read'; }, /role\.tools/],
  ['empty role.tools', (m) => { m.stages[0].role.tools = []; }, /role\.tools/],
  ['absolute persona path', (m) => { m.stages[0].role.persona = '/etc/passwd'; }, /absolute/],
  ['dot-dot artifact path', (m) => { m.stages[0].artifact = '../escape.json'; }, /"\.\."/],
  ['gate.cmd as shell string', (m) => { m.stages[0].gate.cmd = 'python3 v.py'; }, /gate\.cmd/],
  ['empty gate.cmd argv', (m) => { m.stages[0].gate.cmd = []; }, /gate\.cmd/],
  ['non-string gate.cmd entry', (m) => { m.stages[0].gate.cmd = ['python3', 42]; }, /gate\.cmd\[1\]/],
  ['stage with role AND fanout', (m) => { m.stages[0].fanout = m.stages[1].fanout; }, /not both/],
  ['stage with neither role nor fanout', (m) => { delete m.stages[0].role; }, /role or fanout/],
  ['duplicate lens', (m) => { m.stages[1].fanout.lenses[1] = 'coherence'; }, /duplicates lens/],
  ['path-unsafe lens name', (m) => { m.stages[1].fanout.lenses[0] = 'a/b'; }, /lenses\[0\]/],
  ['missing fanout synthesis', (m) => { delete m.stages[1].fanout.synthesis; }, /synthesis/],
  ['non-integer maxTokens', (m) => { m.stages[0].role.maxTokens = 'lots'; }, /maxTokens/],
  ['missing dispatch.promptTemplate', (m) => { delete m.stages[0].dispatch.promptTemplate; }, /promptTemplate/],
  ['missing dispatch.outputSchema', (m) => { delete m.stages[0].dispatch.outputSchema; }, /outputSchema/],
];

test('validateManifest rejects fail-closed, naming the field', async (t) => {
  for (const [label, mutate, pattern] of REJECTIONS) {
    await t.test(label, () => {
      const doc = fixtureManifest();
      mutate(doc);
      const error = grab(() => validateManifest(doc));
      assert.ok(error instanceof PipelineError, label);
      assert.equal(error.code, CODES.MANIFEST_INVALID, label);
      assert.match(error.message, pattern, label);
      assert.ok(error.remedy.length > 0, 'remedy present');
    });
  }
});

test('validateManifest tolerates additive unknown fields ($comment etc.)', () => {
  const doc = fixtureManifest();
  doc.$comment = 'additive';
  doc.stages[0].futureField = { anything: true };
  assert.equal(validateManifest(doc), doc);
});

// ---------------------------------------------------------------------------
// Template rendering + DSML guard
// ---------------------------------------------------------------------------

const VARS = {
  WORKSPACE: '/ws',
  TARGET: 'plugin',
  ARTIFACT: '/ws/artifacts/x.json',
  STAGE: 'alpha',
  ATTEMPT: '2',
  GATE_LOG_PREV: '- Previous attempt gate log: /ws/gate-logs/alpha.attempt1.log',
};

test('renderTemplate substitutes the full vocabulary', () => {
  const rendered = renderTemplate(
    'w={{WORKSPACE}} t={{TARGET}} a={{ARTIFACT}} s={{STAGE}} n={{ATTEMPT}}\n{{GATE_LOG_PREV}}',
    VARS,
    'tmpl',
  );
  assert.equal(rendered, 'w=/ws t=plugin a=/ws/artifacts/x.json s=alpha n=2\n- Previous attempt gate log: /ws/gate-logs/alpha.attempt1.log');
  assert.deepEqual(TEMPLATE_VARS, ['WORKSPACE', 'TARGET', 'ARTIFACT', 'STAGE', 'ATTEMPT', 'GATE_LOG_PREV']);
});

test('renderTemplate renders GATE_LOG_PREV empty on attempt 1', () => {
  const rendered = renderTemplate('head\n{{GATE_LOG_PREV}}\ntail', { ...VARS, GATE_LOG_PREV: '' }, 'tmpl');
  assert.equal(rendered, 'head\n\ntail');
});

test('renderTemplate rejects an unknown template variable, naming it', () => {
  const error = grab(() => renderTemplate('x {{TARGT}} y', VARS, 'prompts/a.md'));
  assert.ok(error instanceof PipelineError);
  assert.equal(error.code, CODES.MANIFEST_INVALID);
  assert.match(error.message, /\{\{TARGT\}\}/);
  assert.match(error.message, /prompts\/a\.md/);
});

test('renderTemplate rejects DSML in an interpolated VALUE, naming the source', () => {
  const error = grab(() => renderTemplate('t={{TARGET}}', { ...VARS, TARGET: `x${DSML_SEQUENCE}y` }, 'prompts/a.md'));
  assert.ok(error instanceof PipelineError);
  assert.equal(error.code, CODES.MANIFEST_INVALID);
  assert.match(error.message, /\{\{TARGET\}\}/);
});

test('renderTemplate rejects DSML living in the template body itself', () => {
  const error = grab(() => renderTemplate(`before ${DSML_SEQUENCE} after {{STAGE}}`, VARS, 'prompts/a.md'));
  assert.ok(error instanceof PipelineError);
  assert.equal(error.code, CODES.MANIFEST_INVALID);
});

test('assertNoDsml names the offending file', () => {
  const error = grab(() => assertNoDsml(`a${DSML_SEQUENCE}b`, 'roles/alpha.md'));
  assert.ok(error instanceof PipelineError);
  assert.match(error.message, /roles\/alpha\.md/);
  assert.doesNotThrow(() => assertNoDsml('clean <| ascii pipe is fine', 'roles/alpha.md'));
});

// ---------------------------------------------------------------------------
// Byte clamp
// ---------------------------------------------------------------------------

test('clampBytes passes short text through untouched', () => {
  assert.equal(clampBytes('short', 4000), 'short');
});

test('clampBytes clamps to the byte budget and SAYS so', () => {
  const clamped = clampBytes('x'.repeat(10_000), 4000);
  assert.ok(Buffer.byteLength(clamped, 'utf8') <= 4000, 'within budget');
  assert.match(clamped, /truncated at 4000B/);
});

test('clampBytes never splits a multibyte sequence', () => {
  const clamped = clampBytes('测'.repeat(5_000), 4000);
  assert.ok(Buffer.byteLength(clamped, 'utf8') <= 4000);
  assert.ok(!clamped.includes('�'), 'no replacement character');
});

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

test('resolveOptions applies defaults and clamps junk (never unbounds)', () => {
  assert.deepEqual(resolveOptions(), {
    manifestPath: 'manifest/pipeline.manifest.json',
    baseDir: '',
    maxConcurrentDispatches: 2,
    dispatchTimeoutMs: 1_800_000,
  });
  assert.equal(resolveOptions({ maxConcurrentDispatches: 0 }).maxConcurrentDispatches, 1);
  assert.equal(resolveOptions({ maxConcurrentDispatches: 9 }).maxConcurrentDispatches, 4);
  assert.equal(resolveOptions({ maxConcurrentDispatches: 3.7 }).maxConcurrentDispatches, 3);
  assert.equal(resolveOptions({ maxConcurrentDispatches: 'many' }).maxConcurrentDispatches, 2);
  assert.equal(resolveOptions({ dispatchTimeoutMs: -5 }).dispatchTimeoutMs, 1_800_000);
  assert.equal(resolveOptions({ dispatchTimeoutMs: 'soon' }).dispatchTimeoutMs, 1_800_000);
  assert.equal(resolveOptions({ manifestPath: '' }).manifestPath, 'manifest/pipeline.manifest.json');
  assert.equal(resolveOptions({ baseDir: '/abs' }).baseDir, '/abs');
});

// ---------------------------------------------------------------------------
// Error taxonomy — every code carries a remedy line
// ---------------------------------------------------------------------------

test('every error code carries a non-empty remedy line', () => {
  for (const code of Object.values(CODES)) {
    assert.equal(typeof REMEDIES[code], 'string', code);
    assert.ok(REMEDIES[code].length > 20, `${code} remedy is substantive`);
  }
});

test('PipelineError.toModelText is self-contained: code + message + remedy', () => {
  const error = new PipelineError(CODES.GATE_SPAWN_FAILED, 'python3 missing');
  const text = error.toModelText();
  assert.match(text, /\[GATE_SPAWN_FAILED\]/);
  assert.match(text, /python3 missing/);
  assert.match(text, /remedy: /);
  assert.match(text, /install python3/);
});

test('PipelineError coerces an unknown code to MANIFEST_INVALID (fail-closed)', () => {
  const error = new PipelineError('NOT_A_CODE', 'x');
  assert.equal(error.code, CODES.MANIFEST_INVALID);
  assert.ok(error.remedy.length > 0);
});

// ---------------------------------------------------------------------------
// loadManifest: fail-closed + path+mtime cache
// ---------------------------------------------------------------------------

test('loadManifest caches by path+mtime and invalidates on change', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dpe-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'm.json');
  await writeFile(path, JSON.stringify(fixtureManifest()));
  const cache = new Map();

  const first = await loadManifest({ manifestPath: path, cache });
  const second = await loadManifest({ manifestPath: path, cache });
  assert.equal(second, first, 'same mtime → cached entry object reused');
  assert.equal(cache.size, 1);
  assert.equal(first.sha256, sha256(await readFile(path)));

  const changed = fixtureManifest();
  changed.pipeline = 'fixture-v2';
  await writeFile(path, JSON.stringify(changed));
  const future = new Date(Date.now() + 10_000);
  await utimes(path, future, future);
  const third = await loadManifest({ manifestPath: path, cache });
  assert.notEqual(third, first, 'mtime change → reload');
  assert.equal(third.manifest.pipeline, 'fixture-v2');
});

test('loadManifest fails closed on a missing or non-JSON manifest', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dpe-bad-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await assert.rejects(
    loadManifest({ manifestPath: join(dir, 'absent.json') }),
    (e) => e instanceof PipelineError && e.code === CODES.MANIFEST_INVALID && /not readable/.test(e.message),
  );

  const bad = join(dir, 'bad.json');
  await writeFile(bad, '{not json');
  await assert.rejects(
    loadManifest({ manifestPath: bad }),
    (e) => e instanceof PipelineError && e.code === CODES.MANIFEST_INVALID && /not valid JSON/.test(e.message),
  );
});

// ---------------------------------------------------------------------------
// loadOutputSchema: SPIKE deviation 4 dialect checks
// ---------------------------------------------------------------------------

test('loadOutputSchema enforces the outputSchema dialect', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dpe-schema-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const write = async (name, doc) => {
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(doc));
    return path;
  };

  const good = await write('good.json', { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false });
  assert.deepEqual((await loadOutputSchema(good)).required, ['a']);

  const arrayRoot = await write('array.json', { type: 'array', items: {} });
  await assert.rejects(loadOutputSchema(arrayRoot), (e) => e.code === CODES.MANIFEST_INVALID && /object-rooted/.test(e.message));

  const noAdd = await write('noadd.json', { type: 'object', properties: {} });
  await assert.rejects(loadOutputSchema(noAdd), (e) => e.code === CODES.MANIFEST_INVALID && /additionalProperties/.test(e.message));

  const perProp = await write('perprop.json', { type: 'object', properties: { a: { type: 'string' } }, required: 'a', additionalProperties: false });
  await assert.rejects(loadOutputSchema(perProp), (e) => e.code === CODES.MANIFEST_INVALID && /ARRAY/.test(e.message));

  await assert.rejects(loadOutputSchema(join(dir, 'absent.json')), (e) => e.code === CODES.MANIFEST_INVALID);
});
