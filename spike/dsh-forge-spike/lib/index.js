/**
 * `dsh-forge-spike` — E1' feasibility spike for dsh-pipeline-executor.
 *
 * Question under test: can a PLUGIN tool row dispatch a confined subagent
 * through the host `subagents` registry (`ctx.subagents.start('spawn', ...)`)
 * with persona + toolFilter + agentOptions + outputSchema, and collect the
 * structured result plus the child session id?
 *
 * VERIFICATION LIMIT: this file imports @deepseek-ai/* peers, so nothing in it
 * is exercisable offline; the spike's entire deliverable is the tool-result
 * and session-log evidence of one live dsh boot.
 *
 * Request shape mirrored from @deepseek-ai/dsh-tool-subagent (lib/index.js:221,
 * 269) and validated against @deepseek-ai/dsh-subagent SubagentRuntime.start
 * (lib/index.js:2504) and the in-process driver's startInProcessRun.
 *
 * @module dsh-forge-spike
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'forge-spike';
export const inject = ['tools', 'subagents'];
export const Config = z.object({});

const PERSONA = 'You are SPIKE-ROLE. Answer in exactly 5 words, then stop.';

export function apply(ctx, _config) {
  // Probe A: does ctx.get('subagents') resolve at APPLY time?
  let applyProbe;
  try {
    const svc = ctx.get('subagents');
    applyProbe = svc === undefined
      ? 'undefined'
      : `resolved providers=[${svc.list().join(',')}]`;
  } catch (error) {
    applyProbe = `threw: ${String(error?.message ?? error)}`;
  }

  ctx.tools.register(defineTool({
    name: 'spike_dispatch',
    description: 'E1 spike: dispatch ONE confined spawn subagent (SPIKE-ROLE persona, empty-allow toolFilter, pinned agentOptions, object outputSchema) and report the structured answer plus the child session id. Diagnostic tool; call it with the question to forward.',
    parameters: {
      question: {
        type: 'string',
        required: true,
        description: 'The question the confined child subagent must answer.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parent = exec.agent;
      if (!parent) throw new Error('spike_dispatch requires a calling agent (exec.agent was undefined)');

      // Probe B: does ctx.get('subagents') resolve at EXECUTE time?
      let executeProbe;
      let subagents;
      try {
        subagents = ctx.get('subagents');
        executeProbe = subagents === undefined
          ? 'undefined'
          : `resolved providers=[${subagents.list().join(',')}]`;
      } catch (error) {
        executeProbe = `threw: ${String(error?.message ?? error)}`;
      }
      if (subagents === undefined) {
        throw new Error(`subagents service unavailable at execute time (apply-time probe: ${applyProbe})`);
      }

      const request = {
        label: 'spike dispatch',
        prompt: [{ type: 'text', text: args.question }],
        parent,
        signal: exec.signal,
        persona: PERSONA,
        toolFilter: { allow: [] },
        agentOptions: {
          provider: 'deepseek-official',
          model: 'deepseek-v4-pro',
          maxTokens: 512,
        },
        outputSchema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        },
      };

      const run = await subagents.start('spawn', request);
      // Mirror dsh-tool-subagent's settleForegroundRun: collect the result and
      // dispose, never letting disposal mask an independent result failure.
      // Unlike the production tool, a non-`completed` stopReason is REPORTED
      // rather than thrown — the spike's job is evidence, not ergonomics.
      const [execution] = await Promise.allSettled([run.result]);
      const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())]);
      if (execution.status === 'rejected') throw execution.reason;
      if (disposal.status === 'rejected') throw disposal.reason;
      const result = execution.value;

      const outputText = result.output
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      const summary = [
        'SPIKE-EVIDENCE',
        `childSessionId=${run.id}`,
        `stopReason=${result.stopReason}`,
        `structured=${JSON.stringify(result.structured ?? null)}`,
        `outputText=${JSON.stringify(outputText)}`,
        `applyTimeProbe=${applyProbe}`,
        `executeTimeProbe=${executeProbe}`,
      ].join(' | ');
      return { summary };
    },
  }));
}
