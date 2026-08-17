/**
 * `dsh-g1b-conductor` — G1b live-validation shim.
 *
 * Joins the one-shot headless MAIN agent to the `g1b-conductor` agent preset,
 * whose standing scope carries the production-shaped `complete: true`
 * conductor persona. In web deployments the host apiproxy installs this join
 * at session creation; the headless one-shot runner has no such caller, so
 * this shim performs the same public-API join (`agentPresets.mount`) on
 * `agent/created`.
 *
 * Child agents are NOT joined here: dsh-subagent's `applyChildComposition`
 * joins them to the parent's standing mount via `agentPresets.composeFrom`,
 * which is exactly the production path R1 must exercise. The
 * `composedPreset(...) !== undefined` check below is what keeps this shim's
 * hands off them.
 *
 * @module dsh-g1b-conductor
 */
export const name = 'g1b-preset-join';
export const inject = ['agentPresets'];

export function apply(ctx, config = {}) {
  const presetId =
    typeof config.preset === 'string' && config.preset !== '' ? config.preset : 'g1b-conductor';

  // Pre-warm discovery at boot so the agent/created join races the first
  // turn as little as possible (module + roster reads happen here, not there).
  const warm = ctx
    .get('agentPresets')
    .resolveMountable(presetId)
    .then(
      () => ctx.logger?.info?.(`g1b-preset-join: preset "${presetId}" resolvable`),
      (error) =>
        ctx.logger?.warn?.(
          `g1b-preset-join: preset "${presetId}" NOT resolvable: ${String(error?.message ?? error)}`,
        ),
    );

  ctx.on('agent/created', ({ agent }) => {
    const presets = ctx.get('agentPresets');
    if (!presets || !agent?.ctx) return;
    // Children joined their parent's standing mount during setup
    // (composeFrom); only a preset-less top-level agent gets the join.
    if (presets.composedPreset(agent.ctx) !== undefined) return;
    warm
      .then(() => presets.mount(agent.ctx, presetId))
      .then((preset) =>
        ctx.logger?.info?.(`g1b-preset-join: agent ${agent.id} joined preset "${preset.id}"`),
      )
      .catch((error) =>
        ctx.logger?.warn?.(
          `g1b-preset-join: join failed for agent ${agent.id}: ${String(error?.message ?? error)}`,
        ),
      );
  });
}

export default { name, inject, apply };
