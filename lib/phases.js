/**
 * The fixed pipeline identity shared by every other module: the ordered
 * phases, the statuses the projection tracks, and the narration-line
 * contract the prompt imposes on the agent. Pure data — no behavior.
 */

/**
 * The fixed pipeline identity: nine phases, in order. `key` is the slug used
 * in status lines; `toggle` names the Config boolean that enables the phase
 * (phase 1 capture is the request itself and is always enabled; phase 7
 * deploy is additionally gated on a configured deploy command).
 */
export const PHASES = [
  { key: 'capture', name: 'Capture the request', toggle: null },
  { key: 'plan', name: 'Plan the tasks', toggle: 'plan' },
  { key: 'implement', name: 'Implement the tasks', toggle: 'implement' },
  { key: 'review', name: 'Review the implementation', toggle: 'review' },
  { key: 'guardrails', name: 'Run guardrails', toggle: 'guardrails' },
  { key: 'test', name: 'Test the implementation', toggle: 'test' },
  { key: 'deploy', name: 'Deploy to test environment', toggle: 'deploy' },
  { key: 'regression', name: 'Run regression tests', toggle: 'regression' },
  { key: 'evaluate', name: 'Evaluate and report', toggle: 'evaluate' },
];

/** Phase statuses the projection tracks. */
export const PHASE_STATUSES = new Set(['pending', 'active', 'done', 'skipped', 'failed']);

/**
 * The narration contract this plugin's prompt imposes on the agent. Only
 * lines matching this pattern at line start fold projection state, so
 * unrelated text (including tool output echoing the prompt) can never be
 * misparsed as progress.
 */
export const STATUS_LINE_PATTERN = /^\[factory\] phase ([1-9])\/9 ([a-z]+): (.*)$/;

/**
 * The delivery narration contract: one `[factory] delivery: {json}` line the
 * run emits right before its final phase-9 status line, carrying the git
 * delivery outcome (branch / PR URL / degradation note) onto the projection
 * state the queue reads. Only lines matching this pattern at line start fold
 * delivery state, so unrelated text can never be misparsed.
 */
export const DELIVERY_LINE_PATTERN = /^\[factory\] delivery: (\{.*\})$/;
