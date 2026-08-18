#!/usr/bin/env node
// tools/reverify.mjs — standalone re-verifier for the acceptance-manifest standard (D4).
//
// Given an artifact directory containing acceptance-manifest.json, it:
//   (a) validates the manifest's shape (fail-closed: nothing else runs on a bad shape),
//   (b) recomputes every file hash and the rootHash (fail-closed: commands from a
//       tampered tree are NEVER executed — we only run bytes the manifest pinned),
//   (c) runs every reverify command via execFile argv (no shell) with a per-command
//       timeout, comparing exit codes, then re-hashes the tree to prove the commands
//       were side-effect-free inside it.
//
// Exits 0 iff every evaluated check passes. node >= 20, zero dependencies, ESM,
// no network (the STANDARD requires offline commands; this tool does not sandbox —
// see docs/ACCEPTANCE-MANIFEST.md "Honest limits").
//
// Usage:
//   node tools/reverify.mjs <artifact-dir>
//   node tools/reverify.mjs --manifest <path/to/acceptance-manifest.json>
// Flags:
//   --skip-commands   hash-only mode (shape + hashes; cmd:*/summary/tree checks SKIP)
//   --json            machine output (single JSON object on stdout)
//   --timeout-ms <n>  per-command timeout (default 120000, the gate's timeout)

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 120_000;
const MANIFEST_BASENAME = 'acceptance-manifest.json';

// ---------------------------------------------------------------------------
// Embedded schema — MUST stay byte-equal (as parsed JSON) to
// src/schemas/acceptance-manifest.json, which is the normative source; the
// drift test in test/acceptance.test.mjs deepStrictEqual's the two. Embedded
// so a copied-out reverify.mjs stays a single self-contained file.
// ---------------------------------------------------------------------------
export const ACCEPTANCE_SCHEMA = {
  title: 'AcceptanceManifest — evidence-in-artifact (D4, the category-creating standard)',
  description: "Machine-readable acceptance record shipped INSIDE every created artifact as acceptance-manifest.json at the artifact root. Any installer or directory (dsh-suite class) re-runs it with tools/reverify.mjs: 'verified on rc.6' becomes 're-verify on rc.7'. Field names are camelCase to match the evidence ledger lines the executor writes (packages/dsh-pipeline-executor/SPEC.md), which this manifest summarizes — NOT the snake_case of the pipeline-internal sibling schemas, because those never leave the factory and this file does. Uses only the draft-07-compatible keyword subset (type/required/enum/const/pattern/items/additionalProperties) so the zero-dependency validator embedded in tools/reverify.mjs can enforce it byte-for-byte; that embedded copy MUST stay identical to this file (drift-tested in test/acceptance.test.mjs).",
  type: 'object',
  additionalProperties: false,
  required: ['manifestVersion', 'artifact', 'provenance', 'verdicts', 'reverify', 'baselineDelta', 'limits'],
  properties: {
    manifestVersion: { const: 1, description: 'Bump only with a migration note in docs/ACCEPTANCE-MANIFEST.md; verifiers fail closed on unknown versions.' },
    artifact: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'kind', 'version', 'rootHash', 'files'],
      properties: {
        name: { type: 'string', description: 'artifact name as installed (skill dir name / npm package name / preset id)' },
        kind: { type: 'string', enum: ['skill', 'plugin', 'preset'], description: 'the three target packs (D3)' },
        version: { type: 'string' },
        rootHash: {
          type: 'string',
          pattern: '^[a-f0-9]{64}$',
          description: "sha256 (lowercase hex) of the canonical file-hash list: take every path in `files` sorted by byte order of its UTF-8 encoding; emit one line per path as '<sha256><space><space><path>'; join lines with '\\n' and terminate with a trailing '\\n'; hash the UTF-8 bytes of that text. Identical to `shasum -a 256` output format over the sorted list, so `shasum -a 256 -c` can double as a third-party checker.",
        },
        files: {
          type: 'object',
          description: "COMPLETE coverage: every file under the artifact directory, recursively, EXCEPT acceptance-manifest.json itself at the root — mapping posix relative path (no leading './', '/' separators) to lowercase-hex sha256 of the file bytes. Symlinks are illegal in a manifested artifact (the verifier fails them). An on-disk file absent from this map is tampering, not tolerance.",
          additionalProperties: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        },
      },
    },
    provenance: {
      type: 'object',
      additionalProperties: false,
      required: ['pipeline', 'pipelineVersion', 'createdAt', 'dshVersion', 'model', 'evidenceLedgerSha256', 'sessionIds'],
      properties: {
        pipeline: { type: 'string', description: "e.g. 'dsh-tool-creator'" },
        pipelineVersion: { type: 'string' },
        createdAt: { type: 'string', description: 'ISO 8601 UTC timestamp (annotation only — the embedded validator does not parse dates)' },
        dshVersion: { type: 'string', description: 'pinned host version the battery ran under — the drift axis re-verification exists for' },
        model: {
          type: 'object',
          additionalProperties: false,
          required: ['provider', 'id'],
          properties: {
            provider: { type: 'string' },
            id: { type: 'string', description: "e.g. 'deepseek-v4-pro' — verdicts are model-pinned; a base-model change expires them (A37)" },
          },
        },
        evidenceLedgerSha256: {
          type: 'string',
          pattern: '^[a-f0-9]{64}$',
          description: "sha256 of the executor's evidence-ledger.jsonl for this creation run. The ledger is written mechanically by dsh-pipeline-executor from disk bytes and session records — never model-transcribed (R5). The manifest carries its hash, not its contents: live-model evidence is pinned, not replayed.",
        },
        sessionIds: { type: 'array', items: { type: 'string' }, description: "child session ids from the ledger's childSessionIds — the audit trail into host session logs" },
      },
    },
    verdicts: {
      type: 'object',
      additionalProperties: false,
      required: ['reAudit', 'battery', 'effective', 'batteryFindingsCounts'],
      properties: {
        reAudit: { type: 'string', enum: ['draft', 'candidate', 'industrial'], description: '= decision-record acceptance.re_audit_verdict' },
        battery: { type: 'string', enum: ['clean', 'breaches_found', 'not_run'], description: '= decision-record acceptance.battery_verdict' },
        effective: {
          type: 'string',
          enum: ['draft', 'candidate', 'industrial'],
          description: 'min-fold (O5, aligned with validate_decision.py + orchestration-anchors §2 — F7 fix 2026-08-18): rank draft<candidate<industrial; battery caps the rank at clean→industrial, not_run→candidate, breaches_found→candidate; effective = min(reAudit, cap). The verifier recomputes this fold and fails a manifest whose written effective exceeds it — a verdict above the fold is fabricated, not optimistic.',
        },
        batteryFindingsCounts: {
          type: 'object',
          additionalProperties: false,
          required: ['p1', 'p2', 'p3'],
          properties: {
            p1: { type: 'integer' },
            p2: { type: 'integer' },
            p3: { type: 'integer' },
          },
          description: 'adversarial-battery finding counts by severity; all zero is legal only with battery=clean',
        },
      },
    },
    reverify: {
      type: 'object',
      additionalProperties: false,
      required: ['commands', 'harnessPath'],
      properties: {
        commands: {
          type: 'array',
          description: "The re-runnable acceptance: every command MUST be deterministic, offline, and side-effect-free inside the artifact tree (scratch goes to $REVERIFY_TMP; the verifier proves the tree unchanged by re-hashing after the run). Executed via execFile argv — no shell, no interpolation. Typically wraps the target's evals/run_harness.sh (targets/*/BUILD.md §evaluation harness).",
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'argv', 'cwd', 'expectedExit', 'description'],
            properties: {
              id: { type: 'string', description: "unique within the manifest; the verifier reports 'cmd:<id>'" },
              argv: { type: 'array', items: { type: 'string' }, description: 'argv[0] is the binary; non-empty (verifier-enforced)' },
              cwd: { type: 'string', description: 'relative to the artifact root; must resolve INSIDE it (verifier-enforced, no traversal)' },
              expectedExit: { type: 'integer' },
              description: { type: 'string' },
            },
          },
        },
        harnessPath: { type: 'string', description: 'artifact-relative path to the battery harness file (the BUILD.md evals/run_harness.sh convention); must exist in `files`' },
        expectedSummaryRegex: { type: 'string', description: 'optional: a JS regex source that must match the concatenated stdout of all reverify commands in order — pins the harness summary line, not just exit codes' },
      },
    },
    baselineDelta: {
      type: 'object',
      additionalProperties: false,
      required: ['measured', 'note'],
      properties: {
        measured: { type: 'boolean', description: 'true iff a no-artifact baseline comparison was actually run this creation (LANDSCAPE (c).2)' },
        passRate: { type: 'number', description: 'required when measured=true (verifier-enforced); fraction in [0,1] of graded cases the artifact won' },
        baselineRate: { type: 'number', description: 'required when measured=true (verifier-enforced); fraction in [0,1] the no-artifact baseline won' },
        note: { type: 'string', description: 'when measured=false this MUST say why (non-empty, verifier-enforced) — n/a-with-reason is legal, a fabricated rate is not' },
      },
    },
    limits: {
      type: 'array',
      items: { type: 'string' },
      description: "honest verification limits, one per string — e.g. 'preset E-L4 not_run: mount guards, standing-mount behavior and session lock not observed outside a live host'. An empty array claims there are none; that claim is auditable.",
    },
  },
};

// ---------------------------------------------------------------------------
// Minimal hand-rolled schema-shape validator. Deliberately a SUBSET of JSON
// Schema, and honest about it: it supports exactly the keywords the acceptance
// manifest schema uses —
//   type (object/array/string/integer/number/boolean), required, properties,
//   additionalProperties (false | subschema), items (single subschema),
//   enum, const, pattern (on strings).
// NOT supported (and deliberately absent from the schema): $ref, allOf/anyOf/
// oneOf/not, format, min*/max*, propertyNames, patternProperties, conditional
// (if/then/else) keywords. Conditional rules (baselineDelta, verdict fold,
// argv non-empty, cwd containment) are enforced as explicit semantic checks
// below instead of schema keywords. Annotation keys ($schema/title/description)
// are ignored.
// ---------------------------------------------------------------------------
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer'; // integer is also a number
  return typeof v;
}

function typeMatches(declared, v) {
  const t = typeOf(v);
  if (declared === 'number') return t === 'number' || t === 'integer';
  if (declared === 'integer') return t === 'integer';
  return declared === t;
}

export function validateShape(schema, value, at = '$', errors = []) {
  if ('const' in schema) {
    if (value !== schema.const) errors.push(`${at}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return errors;
  }
  if ('enum' in schema) {
    if (!schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]`);
    return errors;
  }
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${at}: expected ${schema.type}, got ${typeOf(value)}`);
    return errors; // wrong type — deeper checks would be noise
  }
  if (schema.type === 'string' && schema.pattern) {
    if (!new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match pattern ${schema.pattern}`);
  }
  if (schema.type === 'array' && schema.items) {
    value.forEach((item, i) => validateShape(schema.items, item, `${at}[${i}]`, errors));
  }
  if (schema.type === 'object') {
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${at}: missing required field "${req}"`);
    }
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (k in props) {
        validateShape(props[k], v, `${at}.${k}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}: unknown field "${k}"`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateShape(schema.additionalProperties, v, `${at}.${k}`, errors);
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
function sha256File(p) { return sha256(readFileSync(p)); }

// Canonical rootHash: paths sorted by UTF-8 byte order; one line per path
// '<sha256>  <path>'; joined with '\n'; trailing '\n'; sha256 of UTF-8 bytes.
export function computeRootHash(fileHashes) {
  const paths = Object.keys(fileHashes)
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  const text = paths.map((p) => `${fileHashes[p]}  ${p}`).join('\n') + (paths.length ? '\n' : '');
  return sha256(Buffer.from(text, 'utf8'));
}

// Recursive listing of relative posix paths; symlinks reported separately (illegal).
function walkTree(root) {
  const files = [];
  const symlinks = [];
  (function walk(rel) {
    const abs = rel ? path.join(root, rel) : root;
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) symlinks.push(childRel);
      else if (ent.isDirectory()) walk(childRel);
      else if (ent.isFile()) files.push(childRel);
      else symlinks.push(childRel); // sockets/fifos: equally illegal
    }
  })('');
  return { files, symlinks };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------
const RANK = { draft: 0, candidate: 1, industrial: 2 };
const BATTERY_CAP = { clean: 2, not_run: 1, breaches_found: 1 };

function semanticErrors(manifest, root) {
  const errs = [];
  const ids = new Set();
  for (const cmd of manifest.reverify.commands) {
    if (ids.has(cmd.id)) errs.push(`reverify.commands: duplicate id "${cmd.id}"`);
    ids.add(cmd.id);
    if (cmd.argv.length === 0) errs.push(`reverify.commands[${cmd.id}]: argv must be non-empty`);
    const resolved = path.resolve(root, cmd.cwd);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      errs.push(`reverify.commands[${cmd.id}]: cwd "${cmd.cwd}" resolves outside the artifact root`);
    }
  }
  const bd = manifest.baselineDelta;
  if (bd.measured) {
    for (const k of ['passRate', 'baselineRate']) {
      if (typeof bd[k] !== 'number') errs.push(`baselineDelta: measured=true requires ${k}`);
      else if (bd[k] < 0 || bd[k] > 1) errs.push(`baselineDelta.${k}: ${bd[k]} outside [0,1]`);
    }
  } else if (!bd.note.trim()) {
    errs.push('baselineDelta: measured=false requires a non-empty note (n/a-with-reason is legal, silence is not)');
  }
  for (const p of Object.keys(manifest.artifact.files)) {
    if (p.startsWith('/') || p.startsWith('./') || p.split('/').includes('..')) {
      errs.push(`artifact.files: illegal path "${p}" (must be relative posix, no traversal)`);
    }
  }
  return errs;
}

function verdictFoldError(verdicts) {
  const cap = BATTERY_CAP[verdicts.battery];
  const expected = Math.min(RANK[verdicts.reAudit], cap);
  if (RANK[verdicts.effective] > expected) {
    const name = Object.keys(RANK).find((k) => RANK[k] === expected);
    return `effective "${verdicts.effective}" exceeds min-fold: min(reAudit=${verdicts.reAudit}, batteryCap[${verdicts.battery}]) = "${name}"`;
  }
  return null;
}

function runCommand(cmd, root, timeoutMs, scratch) {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? scratch,
    LC_ALL: 'C',
    TMPDIR: scratch,
    REVERIFY_TMP: scratch,
  };
  return new Promise((resolve) => {
    execFile(cmd.argv[0], cmd.argv.slice(1), {
      cwd: path.resolve(root, cmd.cwd),
      env,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        const why = error.killed ? `timed out after ${timeoutMs}ms` : `spawn failed: ${error.code ?? error.message}`;
        resolve({ exit: null, stdout: stdout ?? '', stderr: stderr ?? '', why });
      } else {
        resolve({ exit: error ? error.code : 0, stdout, stderr, why: null });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Main verification
// ---------------------------------------------------------------------------
export async function reverify(manifestPath, { skipCommands = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const root = path.dirname(path.resolve(manifestPath));
  const checks = [];
  const add = (id, kind, status, detail = '') => { checks.push({ id, kind, status, detail }); };
  const result = () => ({
    ok: checks.every((c) => c.status !== 'FAIL'),
    manifest: path.resolve(manifestPath),
    artifactRoot: root,
    mode: skipCommands ? 'hash-only' : 'full',
    checks,
    failed: checks.filter((c) => c.status === 'FAIL').map((c) => c.id),
  });

  // Phase A — shape (fail-closed: a malformed manifest gets NO further evaluation)
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    add('schema-shape', 'shape', 'FAIL', `manifest unreadable: ${e.message}`);
    return result();
  }
  const shapeErrs = validateShape(ACCEPTANCE_SCHEMA, manifest);
  if (shapeErrs.length) {
    add('schema-shape', 'shape', 'FAIL', shapeErrs.join('; '));
    return result();
  }
  add('schema-shape', 'shape', 'PASS');

  const semErrs = semanticErrors(manifest, root);
  add('semantic', 'shape', semErrs.length ? 'FAIL' : 'PASS', semErrs.join('; '));
  const foldErr = verdictFoldError(manifest.verdicts);
  add('verdict-fold', 'shape', foldErr ? 'FAIL' : 'PASS', foldErr ?? '');
  if (semErrs.length || foldErr) return result();

  // Phase B — hashes (byte-exact; commands never run over a tree that fails here)
  const declared = manifest.artifact.files;
  const { files: onDisk, symlinks } = walkTree(root);
  const diskHashes = {};
  for (const [rel, expected] of Object.entries(declared)) {
    let actual;
    try {
      actual = sha256File(path.join(root, ...rel.split('/')));
    } catch {
      add(`hash:${rel}`, 'hash', 'FAIL', 'file missing from disk');
      continue;
    }
    diskHashes[rel] = actual;
    if (actual === expected) add(`hash:${rel}`, 'hash', 'PASS');
    else add(`hash:${rel}`, 'hash', 'FAIL', `sha256 mismatch: manifest ${expected}, disk ${actual}`);
  }
  const extras = onDisk.filter((p) => p !== MANIFEST_BASENAME && !(p in declared));
  const symDetail = symlinks.length ? `symlinks/specials illegal: ${symlinks.join(', ')}` : '';
  if (extras.length || symlinks.length) {
    add('unlisted-files', 'hash', 'FAIL',
      [extras.length ? `on disk but not in manifest: ${extras.join(', ')}` : '', symDetail].filter(Boolean).join('; '));
  } else {
    add('unlisted-files', 'hash', 'PASS');
  }
  const recomputedRoot = computeRootHash(diskHashes);
  if (Object.keys(diskHashes).length === Object.keys(declared).length
      && recomputedRoot === manifest.artifact.rootHash) {
    add('root-hash', 'hash', 'PASS');
  } else {
    add('root-hash', 'hash', 'FAIL', `manifest ${manifest.artifact.rootHash}, recomputed ${recomputedRoot}`);
  }
  if (manifest.reverify.harnessPath in declared) add('harness-path', 'hash', 'PASS');
  else add('harness-path', 'hash', 'FAIL', `harnessPath "${manifest.reverify.harnessPath}" not in artifact.files`);

  const hashesGreen = checks.every((c) => c.status !== 'FAIL');

  // Phase C — commands (only over a hash-verified tree; fail-closed otherwise)
  const skipWhy = skipCommands ? 'skipped: --skip-commands'
    : !hashesGreen ? 'not run: hash verification failed (refusing to execute unverified bytes)' : null;
  if (skipWhy) {
    for (const cmd of manifest.reverify.commands) add(`cmd:${cmd.id}`, 'command', 'SKIP', skipWhy);
    if (manifest.reverify.expectedSummaryRegex !== undefined) add('summary-regex', 'command', 'SKIP', skipWhy);
    add('tree-unchanged', 'command', 'SKIP', skipWhy);
    return result();
  }

  const scratch = mkdtempSync(path.join(tmpdir(), 'reverify-'));
  let allStdout = '';
  for (const cmd of manifest.reverify.commands) {
    const r = await runCommand(cmd, root, timeoutMs, scratch);
    allStdout += r.stdout;
    if (r.why) add(`cmd:${cmd.id}`, 'command', 'FAIL', r.why);
    else if (r.exit === cmd.expectedExit) add(`cmd:${cmd.id}`, 'command', 'PASS');
    else add(`cmd:${cmd.id}`, 'command', 'FAIL',
      `expected exit ${cmd.expectedExit}, got ${r.exit}${r.stderr ? ` — stderr: ${r.stderr.slice(0, 400)}` : ''}`);
  }
  if (manifest.reverify.expectedSummaryRegex !== undefined) {
    const re = new RegExp(manifest.reverify.expectedSummaryRegex);
    if (re.test(allStdout)) add('summary-regex', 'command', 'PASS');
    else add('summary-regex', 'command', 'FAIL', `combined stdout does not match /${manifest.reverify.expectedSummaryRegex}/`);
  }
  // Side-effect proof: the artifact tree must be byte-identical after the run.
  const after = walkTree(root);
  const afterExtras = after.files.filter((p) => p !== MANIFEST_BASENAME && !(p in declared));
  const mutated = Object.keys(declared).filter((rel) => {
    try { return sha256File(path.join(root, ...rel.split('/'))) !== declared[rel]; }
    catch { return true; }
  });
  if (afterExtras.length || mutated.length || after.symlinks.length) {
    add('tree-unchanged', 'command', 'FAIL',
      `commands changed the artifact tree — new: [${afterExtras.join(', ')}], mutated/removed: [${mutated.join(', ')}]`);
  } else {
    add('tree-unchanged', 'command', 'PASS');
  }
  return result();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { manifest: null, skipCommands: false, json: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') opts.manifest = argv[++i];
    else if (a === '--skip-commands') opts.skipCommands = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--timeout-ms') opts.timeoutMs = Number(argv[++i]);
    else if (!a.startsWith('-') && !opts.manifest) opts.manifest = path.join(a, MANIFEST_BASENAME);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.manifest) throw new Error(`usage: reverify.mjs <artifact-dir> | --manifest <path> [--skip-commands] [--json] [--timeout-ms <n>]`);
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive number');
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(e.message + '\n');
    process.exit(2);
  }
  const res = await reverify(opts.manifest, { skipCommands: opts.skipCommands, timeoutMs: opts.timeoutMs });
  if (opts.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  } else {
    const width = Math.max(12, ...res.checks.map((c) => c.id.length)) + 2;
    for (const c of res.checks) {
      process.stdout.write(c.id.padEnd(width) + c.status + '\n');
      if (c.detail && c.status !== 'PASS') process.stdout.write(' '.repeat(4) + c.detail + '\n');
    }
    const passed = res.checks.filter((c) => c.status === 'PASS').length;
    const evaluated = res.checks.filter((c) => c.status !== 'SKIP').length;
    process.stdout.write(`\nreverify: ${res.ok ? 'PASS' : 'FAIL'} (${passed}/${evaluated} checks${res.mode === 'hash-only' ? ', hash-only mode' : ''})\n`);
  }
  process.exit(res.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
