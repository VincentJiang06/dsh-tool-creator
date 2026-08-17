# dsh-forge-spike

E1' feasibility spike for dsh-pipeline-executor: proves that a plugin tool row
can dispatch a confined subagent through the host `subagents` registry
(`ctx.subagents.start('spawn', request)`) with persona + toolFilter +
agentOptions + outputSchema, in a real dsh boot.

One tool: `spike_dispatch { question }`. Not for production use.

Install: `npm pack` → `dsh plugin --profile <p> add ./dsh-forge-spike-0.0.1.tgz`.
