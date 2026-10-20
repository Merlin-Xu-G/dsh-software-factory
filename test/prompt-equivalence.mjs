/**
 * Prompt snapshot test: render buildPipelinePrompt for a matrix of effective
 * configs and compare the combined rendering byte-for-byte against the
 * committed baseline `test/prompt-baseline.md`.
 *
 * Fixture strategy: the baseline is a CAPTURED snapshot, committed on
 * purpose — a runtime re-derivation from the same builder under test would
 * be circular and could not detect regressions. History: the original .tmp
 * harness rendered the matrix twice, before (`prompt-before.md`, push-append
 * implementation) and after (`prompt-after.md`, multi-line template
 * literals) the prompt rewrite; the two files were byte-identical (same
 * SHA-256), which proved the refactor preserved the prompt. One canonical
 * copy of that content is committed here as `test/prompt-baseline.md`.
 *
 * Usage:
 *   node test/prompt-equivalence.mjs           compare against the baseline (test mode)
 *   node test/prompt-equivalence.mjs <out.md>  write the combined snapshot (original harness mode;
 *                                               use to re-capture after an intentional prompt
 *                                               change, then diff and copy over the baseline)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildPipelinePrompt } from '../lib/prompt.js';

const base = {
  plan: true,
  implement: true,
  review: true,
  guardrails: true,
  test: true,
  regression: true,
  evaluate: true,
  subagentImplementation: true,
  autoOpenTab: true,
  deploy: { enabled: false, command: [] },
  guardrailCommand: [],
  testCommand: [],
  regressionCommand: [],
};

const scenarios = [
  ['defaults', base, 'Add CSV export to the settings page'],
  ['full-config', {
    ...base,
    subagentImplementation: false,
    deploy: { enabled: true, command: ['./scripts/deploy-test.sh'] },
    guardrailCommand: ['npm run lint', 'npm run typecheck'],
    testCommand: ['npm test'],
    regressionCommand: ['npm run test:e2e'],
  }, 'Ship the login throttle'],
  ['phases-disabled', {
    ...base,
    plan: false,
    review: false,
    regression: false,
  }, 'Rename the helper'],
  ['project-prompts', {
    ...base,
    deploy: { enabled: true, command: ['deploy.sh'] },
    phasePrompts: {
      plan: 'Split backend and frontend tasks.',
      review: 'Check error paths first.\nThen security.',
      deploy: 'curl /healthz afterwards.',
      evaluate: 'List every changed file.',
    },
  }, ''],
];

const out = [];
for (const [name, resolved, request] of scenarios) {
  out.push(`===== ${name} =====`);
  out.push(buildPipelinePrompt(Object.freeze(resolved), request));
}
const rendered = out.join('\n');

if (process.argv[2] === undefined) {
  const baselinePath = new URL('./prompt-baseline.md', import.meta.url);
  const baseline = readFileSync(baselinePath, 'utf8');
  if (rendered === baseline) {
    console.log(`prompt snapshot PASS (${scenarios.length} scenarios, byte-identical to test/prompt-baseline.md)`);
    process.exit(0);
  }
  const renderedLines = rendered.split('\n');
  const baselineLines = baseline.split('\n');
  let firstDiff = -1;
  for (let i = 0; i < Math.max(renderedLines.length, baselineLines.length); i += 1) {
    if (renderedLines[i] !== baselineLines[i]) { firstDiff = i; break; }
  }
  console.error(`prompt snapshot FAIL — rendered prompt differs from test/prompt-baseline.md (line ${firstDiff + 1}, ${renderedLines.length} rendered vs ${baselineLines.length} baseline lines)`);
  if (firstDiff >= 0) {
    console.error(`  rendered: ${JSON.stringify(renderedLines[firstDiff])}`);
    console.error(`  baseline: ${JSON.stringify(baselineLines[firstDiff])}`);
  }
  process.exit(1);
} else {
  writeFileSync(process.argv[2], rendered, 'utf8');
  console.log(`wrote ${process.argv[2]} (${scenarios.length} scenarios)`);
}
