/**
 * `dsh-pipeline-executor` — Cordis wiring: registers the `pipeline_stage`
 * and `pipeline_status` tools into the DeepSeek Harness.
 *
 * VERIFICATION LIMIT: this file imports the `@deepseek-ai/*` peer
 * dependencies, so NONE of it is exercised by `npm test` — the unit suite
 * targets the pure modules (`./manifest.js`, `./dispatch.js`) only. The
 * wiring below is proven by inspection against two references that loaded in
 * real dsh boots (`dsh-mp-automator/lib/index.js`, `dsh-forge-spike/lib/
 * index.js`) until the G1b live-boot stage runs. Every §2.1 BUILD.md boot
 * invariant is followed literally here: schemastery `z.object` Config,
 * explicit `additionalProperties` on every object schema, all imported seams
 * declared in `peerDependencies`.
 *
 * @module dsh-pipeline-executor
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { CODES, PipelineError, REMEDIES, TEXT_OUTPUT_SCHEMA, clampBytes, resolveOptions } from './manifest.js';
import { resolveSeams, defaultExecFile, runStage, statusReport } from './dispatch.js';

export const name = 'pipeline-executor';
export const inject = ['tools', 'subagents'];

/** Plugin configuration. */
export const Config = z.object({
  /**
   * Manifest path. Relative values resolve against `baseDir`. In production
   * the preset writes an ABSOLUTE path here via a `!!js` baseUrl expression
   * so the row travels with the preset copy.
   */
  manifestPath: z.string().default('manifest/pipeline.manifest.json'),
  /**
   * The preset/composition directory every manifest-internal path (roles/,
   * schemas/, manifest/prompts/) resolves against. Empty string = harness
   * cwd (test/dev fallback only — set it absolutely in deployments).
   */
  baseDir: z.string().default(''),
  /** Fanout (battery) dispatch cap; clamped to an integer 1–4. */
  maxConcurrentDispatches: z.number().default(2),
  /** Wall-clock backstop for one child dispatch. */
  dispatchTimeoutMs: z.number().default(1_800_000),
});

/** One model-facing failure block: code + message + remedy line (all codes carry one). */
function failureText(error) {
  if (error instanceof PipelineError) return error.toModelText();
  const fallback = new PipelineError(CODES.DISPATCH_FAILED, String(error?.message ?? error), { cause: error });
  return fallback.toModelText();
}

export function apply(ctx, config = {}) {
  const options = resolveOptions(config);
  // Test seams: FUNCTIONS ONLY — a config-file value can never replace the
  // real subagents registry or the gate executor (resolveSeams drops
  // non-functions). Production passes nothing here.
  const seams = resolveSeams(config._seams);

  // Manifest cache is a PROJECT property (path+mtime keyed Map, §9.3);
  // stage-attempt tracking is a CONTEXT property (WeakMap keyed by the
  // session object, dies with the session).
  const manifestCache = new Map();
  const sessionStates = new WeakMap();
  // Defense-in-depth only: sessions without an object identity share
  // honestly-per-instance state rather than crashing.
  const sessionStateFallback = { stages: {} };
  const sessionStateOf = (exec) => {
    const session = exec?.agent?.session;
    if (!session) return sessionStateFallback;
    let state = sessionStates.get(session);
    if (!state) {
      state = { stages: {} };
      sessionStates.set(session, state);
    }
    return state;
  };

  /** The calling agent's workspace — stage artifacts, gate logs and the ledger live under it. */
  function workspaceOf(exec) {
    const cwd = exec?.agent?.session?.header?.cwd;
    if (!cwd) {
      throw new PipelineError(CODES.DISPATCH_FAILED, 'no workspace directory: this session has no cwd');
    }
    return cwd;
  }

  /**
   * Lazy service resolution (SPIKE finding: the spawn provider row applies
   * AFTER this plugin — provider lookup must happen at execute time).
   */
  function subagentsOf() {
    if (seams.subagents) return seams.subagents();
    const svc = ctx.get('subagents');
    if (!svc) {
      throw new PipelineError(CODES.DISPATCH_FAILED, 'subagents service unavailable at execute time — is the spawn provider row mounted in this composition?');
    }
    return svc;
  }

  /** Best-effort live tool list for whitelist pre-validation; undefined when not enumerable. */
  function listToolsOf() {
    if (seams.listTools) return seams.listTools();
    try {
      const tools = ctx.get('tools');
      const list = tools?.list?.();
      if (Array.isArray(list)) {
        return list.map((t) => (typeof t === 'string' ? t : t?.name)).filter((n) => typeof n === 'string');
      }
    } catch {
      /* not enumerable on this host — skip pre-validation */
    }
    return undefined;
  }

  /**
   * Per-child token measurement (lazy service resolution). G1b live finding:
   * the host `tokenMeter` exposes `measure(session, requestHeader?)`, NOT
   * `read()` — 0.1.0's `meter.read()` probe always degraded to null.
   *
   * The child session IS reachable from the executor's position: the spawn
   * provider's run handle carries `localAgent` (the in-process child agent —
   * `@deepseek-ai/dsh-subagent-in-process-driver` `drivePublishedRun` returns
   * `{id, localAgent, result, dispose}`), and `localAgent.session` is exactly
   * the session object `measure()` folds (`readResult` in the same driver
   * reads `child.session.events`). dispatch.js calls this BETWEEN result
   * settlement and disposal, the only window the session is guaranteed alive.
   *
   * `requestHeader` is deliberately NOT passed: it is optional (measure()
   * falls back to the session's own logged header), and the executor does not
   * guess envelope shapes it cannot verify offline. Every failure mode is
   * honest-null: no meter service, no measure(), a remote provider's run
   * without `localAgent`, or a measure() throw → null, never fabricated.
   *
   * VERIFICATION LIMIT: `run.localAgent.session` + `measure().totalTokens`
   * are proven by inspection of the INSTALLED host source (dsh-token-meter
   * `measure()` at lib/index.js:444, in-process driver run shape), not yet
   * observed through this adapter in a live executor run — the next live boot
   * must confirm a non-null `tokens` ledger field.
   */
  function measureTokensOf() {
    if (seams.measureTokens) return seams.measureTokens;
    return (session) => {
      try {
        const meter = ctx.get('tokenMeter');
        if (!meter || typeof meter.measure !== 'function' || !session) return null;
        const measured = meter.measure(session);
        return typeof measured?.totalTokens === 'number' ? measured.totalTokens : null;
      } catch {
        return null;
      }
    };
  }

  /** Shared execute wrapper: remedy-carrying failure mapping + byte clamp. */
  const guarded = (fn) => async (args, exec) => {
    try {
      const value = await fn(args, exec);
      // G1b live finding: the host VALIDATES the execute return against
      // output.schema (additionalProperties: false) — return EXACTLY the
      // declared {summary} shape. runStage's richer facts (gateExit,
      // ledgerLine, childSessionIds) stay library-internal for tests/callers.
      return { summary: clampBytes(value.summary, 4000) };
    } catch (error) {
      ctx.logger?.warn?.(`pipeline-executor: ${failureText(error)}`);
      throw new Error(clampBytes(failureText(error), 4000));
    }
  };

  // The declared schema lives in the PURE module (TEXT_OUTPUT_SCHEMA) so the
  // offline fakes mount and enforce the exact bytes the live host enforces.
  const textOutput = {
    schema: TEXT_OUTPUT_SCHEMA,
    render: (_args, value) => [{ type: 'text', text: value.summary }],
  };

  // Both tools are EXPLICITLY exclusive: they share the workspace ledger,
  // gate logs and the child-dispatch budget of one conversation.
  const register = (tool) => ctx.tools.register(defineTool({ isConcurrencySafe: () => false, ...tool }));

  register({
    name: 'pipeline_stage',
    description:
      'Run ONE stage of the declarative pipeline manifest end-to-end: dispatch the confined role subagent(s) ' +
      '(persona + tool whitelist + output schema from the manifest), write the stage artifact from the structured ' +
      'return, run the mechanical gate (argv, no shell), and append the mandatory evidence-ledger line. ' +
      'Returns stage/attempt/gateExit/artifact/childSessions/ledger facts; on a red gate, the gate-log tail. ' +
      'It NEVER relays role prose. Retry a red stage with attempt+1 — the retry budget lives in the manifest.',
    parameters: {
      stage: { type: 'string', required: true, description: 'stage id from the manifest (pipeline_status lists them)' },
      attempt: { type: 'number', description: '1-based attempt number (default 1); attempt N>1 points the role at the attempt N-1 gate log' },
      target: { type: 'string', description: 'build target kind rendered into the DISPATCH CONTEXT {{TARGET}} variable (e.g. "plugin", "skill"); also the stage target-filter key — a stage whose manifest `targets` list excludes this value is SKIPPED (ledgered, gateExit=0, no dispatch, no gate)' },
    },
    output: textOutput,
    timeoutMs: 3_600_000,
    presentCall: (args) => ({ card: 'generic', title: `pipeline stage ${args.stage}${args.attempt ? ` attempt ${args.attempt}` : ''}`, kind: 'execute', rawInput: JSON.stringify(args) }),
    execute: guarded(async (args, exec) => runStage(
      { stage: args.stage, attempt: args.attempt, target: args.target },
      {
        options,
        workspace: workspaceOf(exec),
        subagents: subagentsOf(),
        execFileImpl: seams.execFile ?? defaultExecFile,
        measureTokens: measureTokensOf(),
        listTools: listToolsOf(),
        parent: exec.agent,
        signal: exec.signal,
        manifestCache,
        sessionState: sessionStateOf(exec),
      },
    )),
  });

  register({
    name: 'pipeline_status',
    description:
      'Read-only pipeline status: manifest sha256, per-stage evidence from the ledger (last attempt, gate ' +
      'verdict), this session\'s attempts, and the workspace layout paths. No dispatch, no gate, no writes.',
    parameters: {},
    output: textOutput,
    timeoutMs: 60_000,
    presentCall: () => ({ card: 'generic', title: 'pipeline status', kind: 'read' }),
    execute: guarded(async (_args, exec) => statusReport({
      options,
      workspace: workspaceOf(exec),
      manifestCache,
      sessionState: sessionStateOf(exec),
    })),
  });

  ctx.logger?.info?.('pipeline-executor: 2 tools registered (manifest loads lazily at first use)');
}

export { CODES, REMEDIES, PipelineError, TEXT_OUTPUT_SCHEMA, resolveOptions, clampBytes } from './manifest.js';
export { resolveSeams, defaultExecFile, runStage, statusReport, appendLedger } from './dispatch.js';

export default { name, inject, Config, apply };
