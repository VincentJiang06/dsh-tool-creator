/**
 * Stage orchestration for `dsh-pipeline-executor` — dispatch, gate, ledger.
 *
 * Harness-free on purpose: everything here runs under `npm test` with no dsh
 * installation. The two side-effecting collaborators are INJECTED seams
 * (functions only — `resolveSeams`): the host `subagents` registry and the
 * gate's `execFile`. Filesystem work uses `node:` builtins directly and is
 * exercised against temp workspaces by the unit suite.
 *
 * The subagents.start request shape follows SPIKE-FINDINGS.md (live-proven
 * law): prompt as content-block ARRAY, `parent` guarded, `signal` REQUIRED,
 * `toolFilter` in `{allow: [...]}` object form, `agentOptions` restricted to
 * {provider, model, maxTokens}, object-rooted outputSchema with `required`
 * as array, never a `descriptor`. Success is `stopReason === 'completed'`
 * AND `structured` present — child TEXT is never parsed (fail-closed).
 *
 * Write surface (enumerable, tested): the stage artifact, lens artifacts
 * under the artifacts dir, gate logs under the gate-logs dir, and the
 * evidence ledger. Nothing else, ever.
 *
 * @module dsh-pipeline-executor/dispatch
 */
import { execFile as nodeExecFile } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  CODES,
  PipelineError,
  TEMPLATE_VARS,
  assertNoDsml,
  clampBytes,
  loadManifest,
  loadOutputSchema,
  renderTemplate,
  sha256,
} from './manifest.js';

/** Wall-clock backstop for one gate command (validators are quick; a hung one must not wedge the tool). */
export const GATE_TIMEOUT_MS = 300_000;

/** Executor-written lens artifact name prefix (pinned by SPEC test 5). */
export const LENS_ARTIFACT_PREFIX = 'battery-lens-';

/** Error codes that are LEDGERED before the tool call fails (evidence of the attempt). */
export const LEDGERED_CODES = new Set([CODES.DISPATCH_FAILED, CODES.ROLE_NO_OUTPUT, CODES.GATE_SPAWN_FAILED]);

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** The seam names the executor accepts. Anything else in `_seams` is ignored. */
export const SEAM_NAMES = ['subagents', 'execFile', 'measureTokens', 'listTools'];

/**
 * Resolve test seams from a raw `_seams` object: FUNCTIONS ONLY. A value that
 * is not a function is dropped, so a config-file value (string, object) can
 * never replace the real implementation — only in-process test code can.
 */
export function resolveSeams(raw) {
  const seams = {};
  if (raw !== null && typeof raw === 'object') {
    for (const name of SEAM_NAMES) {
      if (typeof raw[name] === 'function') seams[name] = raw[name];
    }
  }
  return seams;
}

/**
 * Default gate executor: node execFile, argv array, NO shell. Resolves
 * `{code, stdout, stderr, timedOut?}` for every completed spawn — a non-zero
 * exit is DATA (the gate verdict), not an exception. Rejects only when the
 * process could not be spawned at all (ENOENT, EACCES, …) — that rejection
 * is what `GATE_SPAWN_FAILED` maps.
 */
export function defaultExecFile(file, argv, { cwd, signal, timeoutMs } = {}) {
  return new Promise((resolvePromise, reject) => {
    nodeExecFile(
      file,
      argv,
      { cwd, signal, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ code: 0, stdout, stderr });
        } else if (error.killed === true || error.code === 'ETIMEDOUT') {
          resolvePromise({ code: null, stdout, stderr, timedOut: true });
        } else if (typeof error.code === 'number') {
          resolvePromise({ code: error.code, stdout, stderr });
        } else {
          reject(error);
        }
      },
    );
  });
}

/** Combine the caller's abort signal with the dispatch timeout (SPIKE dev 1: signal is REQUIRED). */
export function dispatchSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// ---------------------------------------------------------------------------
// Ledger — append-only JSONL, mandatory, hashes from disk bytes
// ---------------------------------------------------------------------------

/**
 * Append ONE entry to the evidence ledger. Returns the 1-based line number
 * of the appended line. Any failure is LEDGER_WRITE_FAILED — evidence is not
 * optional, so the caller MUST let this fail the tool call.
 */
export async function appendLedger(ledgerPath, entry) {
  try {
    let existing = '';
    try {
      existing = await readFile(ledgerPath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const lineNo = existing.split('\n').filter((line) => line !== '').length + 1;
    await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`);
    return lineNo;
  } catch (error) {
    throw new PipelineError(
      CODES.LEDGER_WRITE_FAILED,
      `could not append to the evidence ledger at ${ledgerPath}: ${String(error?.message ?? error)}`,
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function readPresetFile(baseDir, rel, what) {
  const abs = resolve(baseDir, rel);
  try {
    return await readFile(abs, 'utf8');
  } catch (error) {
    throw new PipelineError(CODES.MANIFEST_INVALID, `${what} not readable at ${abs}: ${String(error?.message ?? error)}`, { cause: error });
  }
}

/**
 * Pre-validate a stage tool whitelist against the live tool list (SPIKE
 * dev 2: the host restrict() THROWS on unknown names and on run_code — that
 * crash must become a clear manifest/deployment error instead).
 * `listTools` may be undefined (registry not enumerable) — then only the
 * unconditional run_code rule applies.
 */
export function checkToolWhitelist(tools, { listTools, field }) {
  if (tools.includes('run_code')) {
    throw new PipelineError(CODES.MANIFEST_INVALID, `${field} includes "run_code" — the host toolFilter always refuses it; remove it from the manifest whitelist`);
  }
  const live = typeof listTools === 'function' ? listTools() : undefined;
  if (Array.isArray(live)) {
    const missing = tools.filter((tool) => !live.includes(tool));
    if (missing.length > 0) {
      throw new PipelineError(
        CODES.MANIFEST_INVALID,
        `${field} names tool(s) not registered in this deployment: ${missing.join(', ')} — the child start would crash in restrict(); fix the manifest whitelist or mount the missing plugin(s)`,
      );
    }
  }
}

/**
 * A child-start crash caused by the host's `tools.restrict()` refusing a
 * whitelist name (G1b live shape: `tools.restrict() names unknown global
 * tool "x"; known global tools: …`). This is a MANIFEST/DEPLOYMENT problem —
 * the generic DISPATCH_FAILED remedy ("check the spawn provider row") would
 * send the conductor to the wrong place, so the remedy is split.
 */
export const RESTRICT_REFUSAL = /tools\.restrict|unknown global tool/;

/** The DISPATCH_FAILED remedy when the crash is a whitelist/deployment mismatch. */
export const RESTRICT_REMEDY =
  'the manifest whitelist names a tool absent from this deployment — the host tools.restrict() refused it at '
  + 'child start; fix the manifest whitelist or install/mount the plugin that provides the missing tool '
  + '(retrying the same dispatch will crash again)';

/**
 * Dispatch ONE confined child and settle it (SPIKE settle pattern: collect
 * the result and dispose, never letting disposal mask a result failure).
 * Fail-closed success: `stopReason === 'completed'` AND structured present.
 *
 * `measureTokens(childSession)` (optional) is called BETWEEN result
 * settlement and disposal — the only window where the child session
 * (`run.localAgent.session`, in-process spawn provider run shape) is
 * guaranteed alive. Every failure of the measurement degrades to null
 * (honest-null beats a wrong number), never to a dispatch failure.
 */
async function dispatchChild(subagents, request, measureTokens) {
  let run;
  try {
    run = await subagents.start('spawn', request);
  } catch (error) {
    const message = String(error?.message ?? error);
    throw new PipelineError(CODES.DISPATCH_FAILED, `subagents.start threw: ${message}`, {
      cause: error,
      ...(RESTRICT_REFUSAL.test(message) ? { remedy: RESTRICT_REMEDY } : {}),
    });
  }
  const [execution] = await Promise.allSettled([run.result]);
  let tokens = null;
  if (execution.status === 'fulfilled' && typeof measureTokens === 'function') {
    try {
      const session = run.localAgent?.session;
      tokens = session ? (await measureTokens(session)) ?? null : null;
    } catch {
      tokens = null;
    }
  }
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())]);
  if (execution.status === 'rejected') {
    throw new PipelineError(
      CODES.DISPATCH_FAILED,
      `child run ${run.id ?? '?'} failed: ${String(execution.reason?.message ?? execution.reason)}`,
      { cause: execution.reason },
    );
  }
  if (disposal.status === 'rejected') {
    throw new PipelineError(
      CODES.DISPATCH_FAILED,
      `child run ${run.id ?? '?'} could not be disposed: ${String(disposal.reason?.message ?? disposal.reason)}`,
      { cause: disposal.reason },
    );
  }
  const result = execution.value;
  if (result?.stopReason !== 'completed' || result?.structured === undefined || result?.structured === null) {
    throw new PipelineError(
      CODES.ROLE_NO_OUTPUT,
      `child ${run.id ?? '?'} settled without structured output (stopReason=${result?.stopReason ?? 'unknown'}) — its text prose is never parsed for results`,
    );
  }
  return { id: run.id, structured: result.structured, tokens };
}

/**
 * The artifact basename that marks a stage as producing a decision record.
 * The verdict passthrough triggers on THIS filename — mechanical, never on
 * stage position or stage id (a renamed/reordered pipeline must not silently
 * gain or lose the behavior).
 */
export const DECISION_RECORD_BASENAME = 'decision-record.json';

/**
 * Mechanically stamp the pipeline's capability-level CONSTANT into a
 * decision-record's structured object, IN PLACE, before the executor writes
 * it to disk (0.1.6).
 *
 * The capability level of this pipeline is a STRUCTURAL CONSTANT, not a
 * per-run model judgment: a machine factory adjudicates every gate by
 * machine, its human veto reserved-but-not-exercised. The executor therefore
 * records it the SAME way it records `sha256` from disk bytes — a structural
 * fact, never invented content. This exists because battery synthesis
 * authored `capability_level` NON-DETERMINISTICALLY: R3 wrote O-L3 (the record
 * passed) and R2 wrote O-L0 (validator-rejected → retries → stopped_unmet)
 * from the SAME installed doctrine. A pipeline constant must not depend on
 * model compliance, so the executor makes the manifest constant authoritative.
 *
 * Conservative — it stamps only fields that ALREADY EXIST in shape and never
 * fabricates gates: it overwrites the scalar `capability_level`, and sets
 * `adjudicator: "machine"` on every existing gate object; if there is no
 * `gates` array (or a differently-shaped record) it stamps just the
 * `capability_level` scalar and leaves the rest untouched. A non-object
 * (or a falsy level) is returned unchanged. Pure/in-place, exported for tests.
 */
export function stampCapabilityLevel(structured, capabilityLevel) {
  if (!capabilityLevel || structured === null || typeof structured !== 'object' || Array.isArray(structured)) {
    return structured;
  }
  // Copy before writing: the structured tool result arrives DEEP-FROZEN from
  // the host (dsh-mcp-manager recursively Object.freeze's every tool result to
  // enforce lossless-JSON immutability), so an in-place assignment throws
  // TypeError in strict mode — a real-host crash the non-frozen test fakes
  // never saw (0.1.6 field regression). structuredClone yields a writable
  // deep copy; the caller must use the RETURN value.
  const out = structuredClone(structured);
  out.capability_level = capabilityLevel;
  if (Array.isArray(out.gates)) {
    for (const gate of out.gates) {
      if (gate !== null && typeof gate === 'object' && !Array.isArray(gate)) {
        gate.adjudicator = 'machine';
      }
    }
  }
  return out;
}

/**
 * Values that may ride the summary fact line. The acceptance enums are
 * single lowercase words; anything outside this shape (spaces, newlines,
 * `=`/`/` separators) would corrupt the machine-parseable line, so it is
 * treated as malformed and OMITTED — fail-soft, never guessed.
 */
const VERDICT_TOKEN = /^[A-Za-z_-]{1,64}$/;

/**
 * Parse an executor-written decision-record artifact's text and return the
 * ` verdict=<battery_verdict>/<re_audit_verdict>` summary suffix, or '' when
 * anything about it is unparseable/malformed (fail-soft: the summary then
 * simply carries no verdict and the conductor charter's fallback line
 * applies). Pure and exported so the fail-soft matrix is unit-testable.
 */
export function verdictSuffixFromRecord(text) {
  try {
    const acceptance = JSON.parse(text)?.acceptance;
    const battery = acceptance?.battery_verdict;
    const reAudit = acceptance?.re_audit_verdict;
    if (typeof battery === 'string' && VERDICT_TOKEN.test(battery)
      && typeof reAudit === 'string' && VERDICT_TOKEN.test(reAudit)) {
      return ` verdict=${battery}/${reAudit}`;
    }
  } catch {
    // fall through — unparseable is omitted, never guessed
  }
  return '';
}

/**
 * Render EVERY element of a gate argv through the dispatch-template renderer
 * (0.1.3). Gates run with cwd = workspace, so a manifest spells preset-shipped
 * validator paths as `{{PRESET_DIR}}/…` and workspace paths as
 * `{{WORKSPACE}}/…` — the SAME variable vocabulary the prompts get. Explicit
 * templating, no path heuristics: an untemplated element passes through
 * byte-identical. Fail-closed on BOTH template sides (renderTemplate: unknown
 * UPPERCASE token, DSML in a value or in the rendered text) AND on any
 * leftover `{{…}}` form the vocabulary regex does not even match (e.g.
 * lowercase `{{workspace}}`) — an unresolved token must never reach execFile
 * as a literal argv element.
 */
export function renderGateArgv(argv, vars, sourceName) {
  return argv.map((arg, i) => {
    const rendered = renderTemplate(arg, vars, `${sourceName}[${i}]`);
    const leftover = /\{\{[^{}]*\}\}/u.exec(rendered);
    if (leftover) {
      throw new PipelineError(
        CODES.MANIFEST_INVALID,
        `${sourceName}[${i}] carries unrenderable template token ${leftover[0]} — gate argv tokens must come from the vocabulary ${TEMPLATE_VARS.map((v) => `{{${v}}}`).join(', ')}`,
      );
    }
    return rendered;
  });
}

/** Last `n` lines of a text blob (gate-log tail for red results). */
export function tailLines(text, n = 20) {
  const lines = String(text).split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/** Strip a trailing slash from a layout dir entry for display joins. */
const dirRel = (value) => String(value).replace(/[\\/]+$/u, '');

// ---------------------------------------------------------------------------
// runStage — one manifest stage, end-to-end inside one tool call
// ---------------------------------------------------------------------------

/**
 * Run ONE stage of the manifest: load+validate → resolve stage/attempt →
 * dispatch confined child(ren) → executor-write the artifact → run the gate
 * → append the mandatory evidence-ledger line → return the byte-clamped
 * summary. See SPEC.md; deviations recorded there.
 *
 * @param {{stage: string, attempt?: number, target?: string}} args
 * @param {object} deps everything injected:
 *   options {manifestPath, baseDir, maxConcurrentDispatches, dispatchTimeoutMs},
 *   workspace (abs dir), subagents ({start}), execFileImpl, measureTokens?,
 *   listTools?, parent (calling agent), signal?, manifestCache (Map),
 *   sessionState ({stages:{}}).
 */
export async function runStage(args, deps) {
  const t0 = Date.now();
  const { options, workspace } = deps;
  const stageId = args.stage;
  const target = typeof args.target === 'string' && args.target !== '' ? args.target : 'unspecified';

  const attempt = Number(args.attempt ?? 1);
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new PipelineError(CODES.MANIFEST_INVALID, `attempt must be an integer >= 1, got ${JSON.stringify(args.attempt)}`);
  }
  if (typeof workspace !== 'string' || workspace === '') {
    throw new PipelineError(CODES.DISPATCH_FAILED, 'no workspace directory: this session has no cwd');
  }

  const baseDir = options.baseDir || '.';
  const loaded = await loadManifest({ manifestPath: options.manifestPath, baseDir, cache: deps.manifestCache });
  const { manifest } = loaded;

  const stage = manifest.stages.find((s) => s.id === stageId);
  if (!stage) {
    throw new PipelineError(
      CODES.STAGE_UNKNOWN,
      `stage "${stageId}" is not in the manifest — stages: ${manifest.stages.map((s) => s.id).join(', ')}`,
    );
  }

  const retries = stage.retries ?? manifest.defaults.retries;
  const maxAttempt = 1 + retries;
  if (attempt > maxAttempt) {
    throw new PipelineError(
      CODES.ATTEMPT_EXCEEDED,
      `stage "${stageId}" allows ${maxAttempt} attempt(s) (1 + ${retries} retries); attempt ${attempt} exceeds the budget`,
    );
  }

  const layout = manifest.defaults.workspaceLayout;
  const artifactsDir = join(workspace, layout.artifacts);
  const gateLogsDir = join(workspace, layout.gateLogs);
  const ledgerPath = join(workspace, layout.ledger);
  const gateLogPath = join(gateLogsDir, `${stageId}.attempt${attempt}.log`);

  const provider = stage.provider ?? manifest.defaults.provider;
  const model = stage.model ?? manifest.defaults.model;

  // ---- per-stage target filter (0.1.5) ------------------------------------
  // A stage row may carry `targets: [<kind>, …]`; when this call's target
  // value (absent → "unspecified") is NOT in the list the stage is SKIPPED:
  // no dispatch, no gate, no artifact — but the skip IS evidence, so ONE
  // ledger line is written ({skipped: true, reason, gateExit: 0}) and the
  // summary discloses it. gateExit 0 lets the conductor's branch table
  // proceed. Filter semantics: an unknown target value is never an error;
  // an absent `targets` field means the stage always runs.
  if (stage.targets !== undefined && !stage.targets.includes(target)) {
    const reason = `target filter: ${target} not in ${JSON.stringify(stage.targets)}`;
    const ledgerLine = await appendLedger(ledgerPath, {
      ts: new Date().toISOString(),
      pipeline: manifest.pipeline,
      manifestSha256: loaded.sha256,
      stage: stageId,
      attempt,
      skipped: true,
      reason,
      childSessionIds: [],
      artifactPath: null,
      artifactSha256: null,
      gateExit: 0,
      gateLogPath: null,
      gateLogSha256: null,
      roleModel: model,
      durationMs: Date.now() - t0,
      tokens: null,
      error: null,
    });
    if (deps.sessionState) {
      deps.sessionState.stages[stageId] = { attempt, gateExit: 0, ledgerLine };
    }
    const summary = `stage=${stageId} SKIPPED (target filter) gateExit=0 ledger=${ledgerLine}`;
    return { summary: clampBytes(summary, 4000), gateExit: 0, ledgerLine, childSessionIds: [] };
  }

  await mkdir(artifactsDir, { recursive: true });
  await mkdir(gateLogsDir, { recursive: true });

  // DISPATCH CONTEXT variables. GATE_LOG_PREV: attempt 1 renders empty;
  // attempt>1 appends the POINTER to the previous gate log — feedback flows
  // via the filesystem, never inline paste.
  const prevLogAbs = join(gateLogsDir, `${stageId}.attempt${attempt - 1}.log`);
  const vars = {
    WORKSPACE: workspace,
    TARGET: target,
    ARTIFACT: join(workspace, stage.artifact),
    STAGE: stageId,
    ATTEMPT: String(attempt),
    GATE_LOG_PREV: attempt > 1
      ? `- Previous attempt's gate log: ${prevLogAbs} — read it from disk FIRST; it is why this attempt exists.`
      : '',
    // The resolved ABSOLUTE preset dir, so prompts can spell out
    // preset-shipped commands (validators/…) with no cwd guessing.
    PRESET_DIR: resolve(baseDir),
  };

  const templateText = await readPresetFile(baseDir, stage.dispatch.promptTemplate, `dispatch.promptTemplate (${stage.dispatch.promptTemplate})`);
  const contextBlock = renderTemplate(templateText, vars, `promptTemplate ${stage.dispatch.promptTemplate}`);
  const outputSchema = await loadOutputSchema(resolve(baseDir, stage.dispatch.outputSchema));

  // Gate argv is rendered UP FRONT (0.1.3): a bad token in `cmd` OR `then`
  // refuses the stage while NOTHING has been dispatched (MANIFEST_INVALID's
  // remedy line promises "nothing was dispatched" — keep it true).
  const gateCmd = renderGateArgv(stage.gate.cmd, vars, `gate.cmd for stage ${stageId}`);
  const gateThen = stage.gate.then
    ? renderGateArgv(stage.gate.then, vars, `gate.then for stage ${stageId}`)
    : undefined;

  if (!deps.parent) {
    throw new PipelineError(CODES.DISPATCH_FAILED, 'pipeline_stage requires a calling agent (exec.agent was undefined)');
  }
  const signal = dispatchSignal(deps.signal, options.dispatchTimeoutMs);

  /** Assemble one SPIKE-shaped start request. Persona = role-pack bytes + trailing DISPATCH CONTEXT block. */
  const buildRequest = async ({ label, personaPath, tools, maxTokens, promptText }, schema) => {
    const rolePackText = await readPresetFile(baseDir, personaPath, `role pack (${personaPath})`);
    assertNoDsml(rolePackText, `role pack ${personaPath}`);
    assertNoDsml(promptText, `dispatch prompt for ${label}`);
    checkToolWhitelist(tools, { listTools: deps.listTools, field: `tool whitelist for ${label}` });
    return {
      label,
      prompt: [{ type: 'text', text: promptText }],
      parent: deps.parent,
      signal,
      persona: `${rolePackText}\n\n${contextBlock}`,
      toolFilter: { allow: [...tools] },
      agentOptions: {
        provider,
        model,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      },
      outputSchema: schema,
    };
  };

  const facts = {
    childSessionIds: [],
    childTokens: [],
    artifactPath: null,
    artifactSha256: null,
    gateExit: null,
    gateLogPath: null,
    gateLogSha256: null,
  };

  /**
   * Ledger `tokens`: the summed per-child `measure().totalTokens` — but ONLY
   * when EVERY child of this attempt yielded a number. A partial sum is a
   * wrong number, and honest-null beats a wrong number: no meter, no
   * reachable child session, or any measurement failure → null, DISCLOSED,
   * never fabricated.
   */
  const tokensOfAttempt = () => (
    facts.childTokens.length > 0 && facts.childTokens.every((t) => typeof t === 'number')
      ? facts.childTokens.reduce((a, b) => a + b, 0)
      : null
  );

  const buildLedgerEntry = (errorCode) => ({
    ts: new Date().toISOString(),
    pipeline: manifest.pipeline,
    manifestSha256: loaded.sha256,
    stage: stageId,
    attempt,
    childSessionIds: [...facts.childSessionIds],
    artifactPath: facts.artifactPath,
    artifactSha256: facts.artifactSha256,
    gateExit: facts.gateExit,
    gateLogPath: facts.gateLogPath,
    gateLogSha256: facts.gateLogSha256,
    roleModel: model,
    durationMs: Date.now() - t0,
    tokens: tokensOfAttempt(),
    error: errorCode ?? null,
  });

  let gateLogText = '';
  let verdictSuffix = '';
  try {
    // ---- dispatch ---------------------------------------------------------
    let structured;
    if (stage.role) {
      const request = await buildRequest({
        label: `tool-creator ${stageId}`,
        personaPath: stage.role.persona,
        tools: stage.role.tools,
        maxTokens: stage.role.maxTokens,
        promptText: `Begin stage "${stageId}" (attempt ${attempt}). Your persona is the complete charter; work in the workspace and emit your result via structured_output.`,
      }, outputSchema);
      const child = await dispatchChild(deps.subagents, request, deps.measureTokens);
      facts.childSessionIds.push(child.id);
      facts.childTokens.push(child.tokens);
      structured = child.structured;
    } else {
      // ---- fanout (battery): lens dispatches under the concurrency cap ----
      const fan = stage.fanout;
      const lensSchema = fan.lensOutputSchema
        ? await loadOutputSchema(resolve(baseDir, fan.lensOutputSchema))
        : { type: 'object', properties: {}, additionalProperties: true };
      const lensArtifacts = new Map();
      const queue = [...fan.lenses];
      const worker = async () => {
        while (queue.length > 0) {
          const lens = queue.shift();
          const request = await buildRequest({
            label: `tool-creator ${stageId} lens ${lens}`,
            personaPath: fan.lensPersona,
            tools: fan.lensTools,
            maxTokens: fan.lensMaxTokens,
            promptText: `Begin stage "${stageId}" (attempt ${attempt}). You are the "${lens}" lens — run exactly that lens per your persona and emit your findings via structured_output.`,
          }, lensSchema);
          const child = await dispatchChild(deps.subagents, request, deps.measureTokens);
          facts.childSessionIds.push(child.id);
          facts.childTokens.push(child.tokens);
          // The EXECUTOR writes the lens artifact from the structured return —
          // the model never relays payloads between children.
          const lensPath = join(artifactsDir, `${LENS_ARTIFACT_PREFIX}${lens}.json`);
          await writeFile(lensPath, `${JSON.stringify(child.structured, null, 2)}\n`);
          lensArtifacts.set(lens, lensPath);
        }
      };
      const workerCount = Math.min(options.maxConcurrentDispatches, fan.lenses.length);
      const settled = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
      const failed = settled.find((s) => s.status === 'rejected');
      if (failed) throw failed.reason;

      // Synthesis receives the lens artifact PATHS, never the payloads.
      const pathsList = fan.lenses.map((lens) => `- ${lensArtifacts.get(lens)}`).join('\n');
      const synthRequest = await buildRequest({
        label: `tool-creator ${stageId} synthesis`,
        personaPath: fan.synthesis.persona,
        tools: fan.synthesis.tools,
        maxTokens: fan.synthesis.maxTokens,
        promptText: `Begin synthesis for stage "${stageId}" (attempt ${attempt}). Read the lens artifacts from disk (paths only — payloads are NOT inlined here):\n${pathsList}\nHunt cross-lens interactions and emit the decision via structured_output.`,
      }, outputSchema);
      const synth = await dispatchChild(deps.subagents, synthRequest, deps.measureTokens);
      facts.childSessionIds.push(synth.id);
      facts.childTokens.push(synth.tokens);
      structured = synth.structured;
    }

    // ---- capability-level mechanical stamp (0.1.6) ------------------------
    // A STRUCTURAL-CONSTANT stamp (like sha256), NOT content invention: this
    // machine factory's capability level is fixed, but battery synthesis
    // authored it non-deterministically (R2 wrote O-L0 → validator-rejected →
    // stopped_unmet; R3 wrote O-L3 → passed; same installed doctrine). So the
    // executor overwrites capability_level to the manifest constant and sets
    // every gate's adjudicator to "machine" before the record hits disk.
    // Gated on the decision-record artifact FILENAME (the same mechanical
    // trigger as the verdict passthrough — never stage id/position) AND on the
    // manifest declaring capabilityLevel (absent → no stamping, back-compat).
    if (manifest.capabilityLevel && stage.artifact.split(/[\\/]/u).pop() === DECISION_RECORD_BASENAME) {
      structured = stampCapabilityLevel(structured, manifest.capabilityLevel);
    }

    // ---- artifact: EXECUTOR-written from the structured return ------------
    const artifactPath = join(workspace, stage.artifact);
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(structured, null, 2)}\n`);
    facts.artifactPath = artifactPath;
    facts.artifactSha256 = sha256(await readFile(artifactPath)); // DISK bytes, not the in-memory value

    // ---- gate: execFile argv, no shell, cwd = workspace -------------------
    const runCmd = async (argv) => {
      try {
        const r = await deps.execFileImpl(argv[0], argv.slice(1), { cwd: workspace, signal: deps.signal, timeoutMs: GATE_TIMEOUT_MS });
        gateLogText += `$ ${argv.join(' ')}\n--- stdout ---\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}\n--- exit ${r.code}${r.timedOut ? ' (TIMED OUT)' : ''} ---\n`;
        return r;
      } catch (error) {
        gateLogText += `$ ${argv.join(' ')}\n--- spawn failed: ${String(error?.message ?? error)} ---\n`;
        await writeFile(gateLogPath, gateLogText);
        facts.gateLogPath = gateLogPath;
        facts.gateLogSha256 = sha256(await readFile(gateLogPath));
        throw new PipelineError(
          CODES.GATE_SPAWN_FAILED,
          `gate command "${argv[0]}" could not be spawned: ${String(error?.message ?? error)}`,
          { cause: error },
        );
      }
    };

    const first = await runCmd(gateCmd);
    let gateExit = first.code;
    if (gateExit === 0 && gateThen) {
      // `then` runs ONLY on a strict first-command success.
      const second = await runCmd(gateThen);
      gateExit = second.code;
    }
    await writeFile(gateLogPath, gateLogText);
    facts.gateExit = gateExit;
    facts.gateLogPath = gateLogPath;
    facts.gateLogSha256 = sha256(await readFile(gateLogPath));

    // ---- verdict passthrough (0.1.2): decision-record stages only ---------
    // Trigger is the manifest-declared artifact FILENAME, and only a
    // gate-validated (exit 0) record ever carries its verdicts into the
    // summary — the charter cites gate-validated artifacts, nothing weaker.
    // The bytes are re-read from DISK (never the in-memory structured value):
    // the summary reports what the artifact says, not what the child said.
    if (gateExit === 0 && stage.artifact.split(/[\\/]/u).pop() === DECISION_RECORD_BASENAME) {
      try {
        verdictSuffix = verdictSuffixFromRecord(await readFile(artifactPath, 'utf8'));
      } catch {
        verdictSuffix = ''; // fail-soft: unreadable artifact → no verdict, never a guess
      }
    }
  } catch (error) {
    // Evidence of the failed attempt: dispatch-phase-and-later failures are
    // ledgered BEFORE the tool call fails (a ledger failure outranks them).
    if (error instanceof PipelineError && LEDGERED_CODES.has(error.code)) {
      error.ledgerLine = await appendLedger(ledgerPath, buildLedgerEntry(error.code));
    }
    throw error;
  }

  // ---- mandatory evidence-ledger line -------------------------------------
  const ledgerLine = await appendLedger(ledgerPath, buildLedgerEntry(null));

  // ---- per-session stage-attempt tracking (WeakMap-keyed by the caller) ----
  if (deps.sessionState) {
    deps.sessionState.stages[stageId] = { attempt, gateExit: facts.gateExit, ledgerLine };
  }

  let summary =
    `stage=${stageId} attempt=${attempt} gateExit=${facts.gateExit} artifact=${facts.artifactPath} ` +
    `childSessions=${facts.childSessionIds.join(',')} ledger=${ledgerLine}${verdictSuffix}`;
  if (facts.gateExit !== 0) {
    summary += `\n--- gate log tail (${facts.gateLogPath}) ---\n${tailLines(gateLogText, 20)}`;
  }
  return { summary: clampBytes(summary, 4000), gateExit: facts.gateExit, ledgerLine, childSessionIds: [...facts.childSessionIds] };
}

// ---------------------------------------------------------------------------
// statusReport — read-only: manifest sha, ledger evidence, workspace paths
// ---------------------------------------------------------------------------

/**
 * Read-only status: manifest sha256, per-stage evidence from the ledger,
 * this session's attempts, workspace layout. No dispatch, no gate, no write.
 */
export async function statusReport(deps) {
  const { options, workspace } = deps;
  const baseDir = options.baseDir || '.';
  const loaded = await loadManifest({ manifestPath: options.manifestPath, baseDir, cache: deps.manifestCache });
  const { manifest } = loaded;
  const layout = manifest.defaults.workspaceLayout;
  const ledgerPath = join(workspace, layout.ledger);

  let entries = [];
  let unparseable = 0;
  try {
    const text = await readFile(ledgerPath, 'utf8');
    for (const line of text.split('\n')) {
      if (line === '') continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        unparseable += 1; // disclosed below — a corrupt ledger line must never pass silently
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { summary: clampBytes(`pipeline=${manifest.pipeline} manifestSha256=${loaded.sha256}\nledger UNREADABLE at ${ledgerPath}: ${error.message}`, 4000) };
    }
  }

  const byStage = new Map();
  for (const e of entries) {
    if (e && typeof e.stage === 'string') byStage.set(e.stage, e);
  }
  const sessionStages = deps.sessionState?.stages ?? {};

  const lines = [
    `pipeline=${manifest.pipeline} manifestSha256=${loaded.sha256}`,
    `manifest=${loaded.path}`,
    `workspace=${workspace} artifacts=${dirRel(layout.artifacts)}/ build=${dirRel(layout.build)}/ gateLogs=${dirRel(layout.gateLogs)}/ ledger=${layout.ledger}`,
    `ledger: ${entries.length} line(s)${unparseable > 0 ? ` (WARNING: ${unparseable} unparseable line(s) skipped)` : ''}`,
  ];
  for (const stage of manifest.stages) {
    const last = byStage.get(stage.id);
    const mine = sessionStages[stage.id];
    const ledgerBit = last
      ? `last attempt=${last.attempt} gateExit=${last.gateExit}${last.error ? ` error=${last.error}` : ''} ${last.gateExit === 0 ? 'GREEN' : 'red'}`
      : 'no evidence yet';
    lines.push(`stage ${stage.id}: ${ledgerBit}${mine ? ` | this session: attempt=${mine.attempt} gateExit=${mine.gateExit}` : ''}`);
  }
  return { summary: clampBytes(lines.join('\n'), 4000) };
}
