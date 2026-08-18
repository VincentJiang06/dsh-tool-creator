/**
 * Pure manifest logic for `dsh-pipeline-executor`.
 *
 * Harness-free on purpose: everything here runs under `npm test` with no dsh
 * installation. The Cordis wiring lives in `./index.js`; the dispatch/gate/
 * ledger orchestration lives in `./dispatch.js`.
 *
 * Owns: fail-closed manifest validation (the shape pinned by
 * src/manifest/pipeline.manifest.json v1 — fields may only be added, never
 * reinterpreted), DISPATCH CONTEXT template rendering, the DSML collision
 * guard, path containment, output-schema loading, the error taxonomy with
 * its remedy map, byte clamping, and the path+mtime manifest cache.
 *
 * @module dsh-pipeline-executor/manifest
 */
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Error taxonomy — every code carries a remedy line (BUILD.md §9.5).
// ---------------------------------------------------------------------------

/** Failure vocabulary of the executor. Stable strings; the conductor branches on them. */
export const CODES = {
  MANIFEST_INVALID: 'MANIFEST_INVALID',
  STAGE_UNKNOWN: 'STAGE_UNKNOWN',
  ATTEMPT_EXCEEDED: 'ATTEMPT_EXCEEDED',
  DISPATCH_FAILED: 'DISPATCH_FAILED',
  ROLE_NO_OUTPUT: 'ROLE_NO_OUTPUT',
  GATE_SPAWN_FAILED: 'GATE_SPAWN_FAILED',
  LEDGER_WRITE_FAILED: 'LEDGER_WRITE_FAILED',
};

/** Code → what to do next. Grown from live incidents; never delete a line silently. */
export const REMEDIES = {
  [CODES.MANIFEST_INVALID]:
    'fix the named field/file in the pipeline manifest (or the preset copy it points at) — the executor refuses to guess; nothing was dispatched',
  [CODES.STAGE_UNKNOWN]:
    'call pipeline_status for the manifest sha and use one of the stage ids it lists — stage ids come from the manifest, never invent one',
  [CODES.ATTEMPT_EXCEEDED]:
    "this stage's retry budget is SPENT — STOP the pipeline and report; do not loop, do not raise the attempt number again",
  [CODES.DISPATCH_FAILED]:
    'the subagent registry refused the dispatch — check that the spawn provider row is mounted and the provider/model route exists, then retry ONCE',
  [CODES.ROLE_NO_OUTPUT]:
    'the role child ended without structured output (its prose is NOT parsed, by design) — inspect the gate log for this attempt, then re-run with attempt+1 if budget remains',
  [CODES.GATE_SPAWN_FAILED]:
    'the gate validator binary could not be spawned — install python3 / check the preset copy integrity (validators/ must travel with the manifest)',
  [CODES.LEDGER_WRITE_FAILED]:
    'the evidence ledger could not be appended — evidence is not optional; fix workspace permissions (evidence-ledger.jsonl and its directory must be writable) before re-running',
};

/**
 * An executor failure: stable code + human message + remedy line. A caller
 * that has DIAGNOSED the failure more precisely than the code's default
 * remedy may pass a `remedy` override (same code, sharper next step) — the
 * DISPATCH_FAILED whitelist split in dispatch.js is the canonical user.
 */
export class PipelineError extends Error {
  constructor(code, message, { cause, detail, remedy } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PipelineError';
    this.code = CODES[code] ? code : CODES.MANIFEST_INVALID;
    this.remedy = typeof remedy === 'string' && remedy !== '' ? remedy : REMEDIES[this.code];
    this.detail = detail;
  }

  /** One model-facing block: code, message, remedy. Self-contained. */
  toModelText() {
    return `pipeline executor failed [${this.code}]: ${this.message}\nremedy: ${this.remedy}`;
  }
}

// ---------------------------------------------------------------------------
// Small shared utilities
// ---------------------------------------------------------------------------

/** sha256 hex of a Buffer/string. All ledger hashes go through this, from DISK bytes. */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Hard byte clamp for model-facing text (BUILD.md §9.2). UTF-8-safe: never
 * splits a multibyte sequence; when the clamp bites it SAYS so.
 */
export function clampBytes(text, maxBytes = 4000) {
  const s = String(text);
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  const note = `\n[truncated at ${maxBytes}B — full detail is on disk in the workspace]`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(note, 'utf8'));
  const head = buf.subarray(0, budget).toString('utf8').replace(/�+$/u, '');
  return head + note;
}

/**
 * The two-char DSML collision sequence `<｜` ('<' + U+FF5C). Any text that is
 * interpolated into a child dispatch and carries it is rejected fail-closed
 * (v4-pro research: it collides with the model's special-token markup).
 */
export const DSML_SEQUENCE = '<｜';

/**
 * The output schema BOTH registered tools declare (defineTool per-property
 * `required: true` dialect). The live host validates every execute RETURN
 * against this, additionalProperties-strict (BUILD.md Invariant 5, learned
 * live in G1b: extra keys beyond {summary} turned a fully successful stage
 * run into a tool error). Exported from this pure module so the offline test
 * fakes mount and enforce the REAL declared schema — the schema-violation
 * class must die offline, not on the first live call.
 */
export const TEXT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { summary: { type: 'string', required: true } },
};

/** Throw MANIFEST_INVALID when `text` carries the DSML collision sequence. */
export function assertNoDsml(text, sourceName) {
  if (String(text).includes(DSML_SEQUENCE)) {
    throw new PipelineError(
      CODES.MANIFEST_INVALID,
      `${sourceName} contains the DSML collision sequence "<｜" — refusing to interpolate it into a dispatch`,
    );
  }
}

// ---------------------------------------------------------------------------
// Config resolution (pure — index.js hands the raw config here)
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  manifestPath: 'manifest/pipeline.manifest.json',
  maxConcurrentDispatches: 2,
  dispatchTimeoutMs: 1_800_000,
};

/**
 * Clamp/normalize plugin config. Junk never unbounds anything: unusable
 * values fall back to the default, and the fanout cap is a 1–4 integer.
 */
export function resolveOptions(config = {}) {
  const cap = Number(config.maxConcurrentDispatches);
  const timeout = Number(config.dispatchTimeoutMs);
  return {
    manifestPath: typeof config.manifestPath === 'string' && config.manifestPath !== ''
      ? config.manifestPath
      : DEFAULTS.manifestPath,
    baseDir: typeof config.baseDir === 'string' ? config.baseDir : '',
    maxConcurrentDispatches: Number.isFinite(cap)
      ? Math.min(4, Math.max(1, Math.floor(cap)))
      : DEFAULTS.maxConcurrentDispatches,
    dispatchTimeoutMs: Number.isFinite(timeout) && timeout > 0
      ? Math.floor(timeout)
      : DEFAULTS.dispatchTimeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Manifest validation — fail-closed, names the offending field
// ---------------------------------------------------------------------------

const PATH_SAFE_ID = /^[A-Za-z0-9_-]+$/;

const invalid = (field, why) =>
  new PipelineError(CODES.MANIFEST_INVALID, `manifest field ${field} ${why}`);

/** Manifest-internal paths are preset-dir-relative: relative, no `..`, no NUL. */
function checkRelPath(value, field) {
  if (typeof value !== 'string' || value === '') throw invalid(field, 'must be a non-empty string path');
  if (isAbsolute(value)) throw invalid(field, `must be preset-dir-relative, got absolute path "${value}"`);
  if (value.includes('\0')) throw invalid(field, 'contains a NUL byte');
  const segments = value.split(/[\\/]/u);
  if (segments.includes('..')) throw invalid(field, `must not contain ".." segments, got "${value}"`);
  return value;
}

function checkString(value, field) {
  if (typeof value !== 'string' || value === '') throw invalid(field, 'must be a non-empty string');
  return value;
}

function checkTools(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw invalid(field, 'must be a non-empty array of tool names');
  for (const [i, tool] of value.entries()) {
    if (typeof tool !== 'string' || tool === '') throw invalid(`${field}[${i}]`, 'must be a non-empty string');
  }
  return value;
}

function checkMaxTokens(value, field) {
  if (!Number.isInteger(value) || value <= 0) throw invalid(field, 'must be a positive integer');
  return value;
}

function checkRole(role, field) {
  if (role === null || typeof role !== 'object') throw invalid(field, 'must be an object');
  checkRelPath(role.persona, `${field}.persona`);
  checkTools(role.tools, `${field}.tools`);
  if (role.maxTokens !== undefined) checkMaxTokens(role.maxTokens, `${field}.maxTokens`);
  return role;
}

function checkArgv(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw invalid(field, 'must be a non-empty argv array (no shell strings)');
  for (const [i, arg] of value.entries()) {
    if (typeof arg !== 'string') throw invalid(`${field}[${i}]`, 'must be a string');
  }
  return value;
}

/**
 * Validate a parsed pipeline manifest, fail-closed. Returns the manifest on
 * success; throws MANIFEST_INVALID naming the first offending field.
 *
 * Unknown extra fields are TOLERATED (the manifest contract says fields may
 * only be added, never reinterpreted); everything the executor consumes is
 * checked strictly.
 */
export function validateManifest(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw invalid('(root)', 'must be a JSON object');
  }
  if (doc.manifestVersion !== 1) throw invalid('manifestVersion', `must be the integer 1, got ${JSON.stringify(doc.manifestVersion)}`);
  checkString(doc.pipeline, 'pipeline');

  const d = doc.defaults;
  if (d === null || typeof d !== 'object') throw invalid('defaults', 'must be an object');
  checkString(d.provider, 'defaults.provider');
  checkString(d.model, 'defaults.model');
  if (!Number.isInteger(d.retries) || d.retries < 0) throw invalid('defaults.retries', 'must be a non-negative integer');
  const layout = d.workspaceLayout;
  if (layout === null || typeof layout !== 'object') throw invalid('defaults.workspaceLayout', 'must be an object');
  for (const key of ['request', 'artifacts', 'build', 'gateLogs', 'ledger']) {
    checkRelPath(layout[key], `defaults.workspaceLayout.${key}`);
  }

  if (!Array.isArray(doc.stages) || doc.stages.length === 0) throw invalid('stages', 'must be a non-empty array');
  const seen = new Set();
  for (const [i, stage] of doc.stages.entries()) {
    const f = `stages[${i}]`;
    if (stage === null || typeof stage !== 'object') throw invalid(f, 'must be an object');
    checkString(stage.id, `${f}.id`);
    if (!PATH_SAFE_ID.test(stage.id)) throw invalid(`${f}.id`, `must match ${PATH_SAFE_ID} (it names gate-log files), got "${stage.id}"`);
    if (seen.has(stage.id)) throw invalid(`${f}.id`, `duplicates stage id "${stage.id}"`);
    seen.add(stage.id);

    if (stage.role === undefined && stage.fanout === undefined) throw invalid(f, 'must carry either role or fanout');
    if (stage.role !== undefined && stage.fanout !== undefined) throw invalid(f, 'must carry role OR fanout, not both');
    if (stage.role !== undefined) checkRole(stage.role, `${f}.role`);
    if (stage.fanout !== undefined) {
      const fan = stage.fanout;
      if (fan === null || typeof fan !== 'object') throw invalid(`${f}.fanout`, 'must be an object');
      if (!Array.isArray(fan.lenses) || fan.lenses.length === 0) throw invalid(`${f}.fanout.lenses`, 'must be a non-empty array');
      const lensSeen = new Set();
      for (const [j, lens] of fan.lenses.entries()) {
        if (typeof lens !== 'string' || !PATH_SAFE_ID.test(lens)) {
          throw invalid(`${f}.fanout.lenses[${j}]`, `must match ${PATH_SAFE_ID} (it names lens artifact files), got ${JSON.stringify(lens)}`);
        }
        if (lensSeen.has(lens)) throw invalid(`${f}.fanout.lenses[${j}]`, `duplicates lens "${lens}"`);
        lensSeen.add(lens);
      }
      checkRelPath(fan.lensPersona, `${f}.fanout.lensPersona`);
      checkTools(fan.lensTools, `${f}.fanout.lensTools`);
      if (fan.lensMaxTokens !== undefined) checkMaxTokens(fan.lensMaxTokens, `${f}.fanout.lensMaxTokens`);
      if (fan.lensOutputSchema !== undefined) checkRelPath(fan.lensOutputSchema, `${f}.fanout.lensOutputSchema`);
      checkRole(fan.synthesis, `${f}.fanout.synthesis`);
    }

    const dispatch = stage.dispatch;
    if (dispatch === null || typeof dispatch !== 'object') throw invalid(`${f}.dispatch`, 'must be an object');
    checkRelPath(dispatch.promptTemplate, `${f}.dispatch.promptTemplate`);
    checkRelPath(dispatch.outputSchema, `${f}.dispatch.outputSchema`);

    checkRelPath(stage.artifact, `${f}.artifact`);

    const gate = stage.gate;
    if (gate === null || typeof gate !== 'object') throw invalid(`${f}.gate`, 'must be an object');
    checkArgv(gate.cmd, `${f}.gate.cmd`);
    if (gate.then !== undefined) checkArgv(gate.then, `${f}.gate.then`);

    if (stage.targets !== undefined) {
      // 0.1.5 target filter: OPTIONAL non-empty array of target-kind strings.
      // Presence gates the stage on pipeline_stage's `target` value; absence
      // means the stage always runs (fail-open by absence of the field).
      if (!Array.isArray(stage.targets) || stage.targets.length === 0) {
        throw invalid(`${f}.targets`, 'must be a non-empty array of target kind strings when present');
      }
      for (const [j, kind] of stage.targets.entries()) {
        if (typeof kind !== 'string' || kind === '') throw invalid(`${f}.targets[${j}]`, 'must be a non-empty string');
      }
    }

    if (stage.retries !== undefined && (!Number.isInteger(stage.retries) || stage.retries < 0)) {
      throw invalid(`${f}.retries`, 'must be a non-negative integer');
    }
    if (stage.provider !== undefined) checkString(stage.provider, `${f}.provider`);
    if (stage.model !== undefined) checkString(stage.model, `${f}.model`);
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Manifest loading + cache (project property → Map keyed by resolved path;
// entry invalidated by mtimeMs — BUILD.md §9.3)
// ---------------------------------------------------------------------------

/**
 * Load + validate the manifest at `manifestPath` (resolved against `baseDir`
 * when relative). `cache` is a Map owned by the caller (one per plugin
 * instance): key = resolved path, value = {mtimeMs, bytes, sha256, manifest}.
 *
 * Fail-closed: unreadable file, non-JSON, or invalid shape all throw
 * MANIFEST_INVALID naming the path/field. Returns
 * `{path, bytes, sha256, manifest}` with `manifest` deep-frozen upstream of
 * nobody — callers must not mutate it.
 */
export async function loadManifest({ manifestPath, baseDir = '', cache }) {
  const path = isAbsolute(manifestPath) ? manifestPath : resolve(baseDir || '.', manifestPath);
  let mtimeMs;
  try {
    ({ mtimeMs } = await stat(path));
  } catch (error) {
    throw new PipelineError(CODES.MANIFEST_INVALID, `manifest not readable at ${path}: ${error.message}`, { cause: error });
  }
  const cached = cache?.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached;

  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new PipelineError(CODES.MANIFEST_INVALID, `manifest not readable at ${path}: ${error.message}`, { cause: error });
  }
  let doc;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new PipelineError(CODES.MANIFEST_INVALID, `manifest at ${path} is not valid JSON: ${error.message}`, { cause: error });
  }
  validateManifest(doc);
  const entry = { path, mtimeMs, bytes, sha256: sha256(bytes), manifest: doc };
  cache?.set(path, entry);
  return entry;
}

/**
 * Load + validate an output schema file (SPIKE deviation 4: standard
 * JSON-Schema subset — object-rooted, `required` as ARRAY when present,
 * explicit boolean `additionalProperties` at the root).
 *
 * A top-level `$schema` key is STRIPPED before the schema is handed to
 * dispatch (SPIKE deviation 9, learned live in L5-R1): the web host's
 * outputSchema validator accepts only the keyword subset
 * type/oneOf/properties/required/additionalProperties/items/enum/const plus
 * the annotations description/title/default/examples, and REFUSES `$schema`
 * ("unsupported JSON schema: schema.$schema is not a supported keyword").
 * The shipped schemas no longer carry it; this strip is defense-in-depth for
 * schema files authored elsewhere.
 */
export async function loadOutputSchema(absPath) {
  let text;
  try {
    text = await readFile(absPath, 'utf8');
  } catch (error) {
    throw new PipelineError(CODES.MANIFEST_INVALID, `output schema not readable at ${absPath}: ${error.message}`, { cause: error });
  }
  let schema;
  try {
    schema = JSON.parse(text);
  } catch (error) {
    throw new PipelineError(CODES.MANIFEST_INVALID, `output schema at ${absPath} is not valid JSON: ${error.message}`, { cause: error });
  }
  if (schema === null || typeof schema !== 'object' || schema.type !== 'object') {
    throw new PipelineError(CODES.MANIFEST_INVALID, `output schema at ${absPath} must be object-rooted (type: "object")`);
  }
  if (typeof schema.additionalProperties !== 'boolean') {
    throw new PipelineError(CODES.MANIFEST_INVALID, `output schema at ${absPath} must set an explicit boolean additionalProperties at the root`);
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    throw new PipelineError(CODES.MANIFEST_INVALID, `output schema at ${absPath} must express required as an ARRAY (outputSchema dialect), got ${typeof schema.required}`);
  }
  delete schema.$schema; // deviation 9: the host outputSchema subset refuses the keyword
  return schema;
}

// ---------------------------------------------------------------------------
// DISPATCH CONTEXT template rendering
// ---------------------------------------------------------------------------

/**
 * The complete variable vocabulary a promptTemplate may use. `PRESET_DIR` is
 * the executor's resolved absolute `baseDir` — it lets a dispatch prompt
 * spell out preset-shipped commands (validators/…) as absolute paths.
 */
export const TEMPLATE_VARS = ['WORKSPACE', 'TARGET', 'ARTIFACT', 'STAGE', 'ATTEMPT', 'GATE_LOG_PREV', 'PRESET_DIR'];

/**
 * Render a DISPATCH CONTEXT template. Fail-closed on BOTH sides:
 * - a `{{VAR}}` in the template outside the vocabulary (or missing from
 *   `vars`) is MANIFEST_INVALID naming the variable and the template file
 *   (a typo must never ship as a literal `{{TARGT}}` in a child prompt);
 * - any interpolated VALUE carrying the DSML sequence is rejected
 *   (`assertNoDsml`), naming the template file.
 */
export function renderTemplate(templateText, vars, sourceName = 'promptTemplate') {
  const unknown = new Set();
  const rendered = String(templateText).replace(/\{\{([A-Z_]+)\}\}/gu, (match, name) => {
    if (!TEMPLATE_VARS.includes(name) || !(name in vars)) {
      unknown.add(name);
      return match;
    }
    const value = String(vars[name]);
    assertNoDsml(value, `${sourceName} variable {{${name}}}`);
    return value;
  });
  if (unknown.size > 0) {
    throw new PipelineError(
      CODES.MANIFEST_INVALID,
      `${sourceName} uses unknown/unsupplied template variable(s): ${[...unknown].map((v) => `{{${v}}}`).join(', ')} — vocabulary is ${TEMPLATE_VARS.map((v) => `{{${v}}}`).join(', ')}`,
    );
  }
  assertNoDsml(rendered, sourceName);
  return rendered;
}
