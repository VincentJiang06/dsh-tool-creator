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
export const SEAM_NAMES = ['subagents', 'execFile', 'getTokens', 'listTools'];

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
 * Dispatch ONE confined child and settle it (SPIKE settle pattern: collect
 * the result and dispose, never letting disposal mask a result failure).
 * Fail-closed success: `stopReason === 'completed'` AND structured present.
 */
async function dispatchChild(subagents, request) {
  let run;
  try {
    run = await subagents.start('spawn', request);
  } catch (error) {
    throw new PipelineError(CODES.DISPATCH_FAILED, `subagents.start threw: ${String(error?.message ?? error)}`, { cause: error });
  }
  const [execution] = await Promise.allSettled([run.result]);
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
  return { id: run.id, structured: result.structured };
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
 *   workspace (abs dir), subagents ({start}), execFileImpl, getTokens?,
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
  };

  const templateText = await readPresetFile(baseDir, stage.dispatch.promptTemplate, `dispatch.promptTemplate (${stage.dispatch.promptTemplate})`);
  const contextBlock = renderTemplate(templateText, vars, `promptTemplate ${stage.dispatch.promptTemplate}`);
  const outputSchema = await loadOutputSchema(resolve(baseDir, stage.dispatch.outputSchema));

  const provider = stage.provider ?? manifest.defaults.provider;
  const model = stage.model ?? manifest.defaults.model;
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
    artifactPath: null,
    artifactSha256: null,
    gateExit: null,
    gateLogPath: null,
    gateLogSha256: null,
  };

  const resolveTokens = async () => {
    try {
      const value = typeof deps.getTokens === 'function' ? await deps.getTokens() : null;
      return value ?? null; // absent host meter → null, DISCLOSED, never fabricated
    } catch {
      return null;
    }
  };

  const buildLedgerEntry = async (errorCode) => ({
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
    tokens: await resolveTokens(),
    error: errorCode ?? null,
  });

  let gateLogText = '';
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
      const child = await dispatchChild(deps.subagents, request);
      facts.childSessionIds.push(child.id);
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
          const child = await dispatchChild(deps.subagents, request);
          facts.childSessionIds.push(child.id);
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
      const synth = await dispatchChild(deps.subagents, synthRequest);
      facts.childSessionIds.push(synth.id);
      structured = synth.structured;
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

    const first = await runCmd(stage.gate.cmd);
    let gateExit = first.code;
    if (gateExit === 0 && stage.gate.then) {
      // `then` runs ONLY on a strict first-command success.
      const second = await runCmd(stage.gate.then);
      gateExit = second.code;
    }
    await writeFile(gateLogPath, gateLogText);
    facts.gateExit = gateExit;
    facts.gateLogPath = gateLogPath;
    facts.gateLogSha256 = sha256(await readFile(gateLogPath));
  } catch (error) {
    // Evidence of the failed attempt: dispatch-phase-and-later failures are
    // ledgered BEFORE the tool call fails (a ledger failure outranks them).
    if (error instanceof PipelineError && LEDGERED_CODES.has(error.code)) {
      error.ledgerLine = await appendLedger(ledgerPath, await buildLedgerEntry(error.code));
    }
    throw error;
  }

  // ---- mandatory evidence-ledger line -------------------------------------
  const ledgerLine = await appendLedger(ledgerPath, await buildLedgerEntry(null));

  // ---- per-session stage-attempt tracking (WeakMap-keyed by the caller) ----
  if (deps.sessionState) {
    deps.sessionState.stages[stageId] = { attempt, gateExit: facts.gateExit, ledgerLine };
  }

  let summary =
    `stage=${stageId} attempt=${attempt} gateExit=${facts.gateExit} artifact=${facts.artifactPath} ` +
    `childSessions=${facts.childSessionIds.join(',')} ledger=${ledgerLine}`;
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
