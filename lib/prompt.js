/**
 * The pipeline prompt builder: renders the steered markdown that drives the
 * agent through the nine phases, honoring the effective config (plugin row
 * Config merged with `.factory.yml` overrides). Every static block is a
 * multi-line template literal that reads exactly as the agent receives it;
 * dynamic content (command lists, project prompts, the request) interpolates
 * in one place per block.
 */
import { PHASES } from './phases.js';
import { deployActive } from './config.js';
import { PROJECT_FILE_NAME } from './project-file.js';

/** Heading, mission, and ground rules shared by every run (static). */
const PREAMBLE = `# Software factory — 9-phase delivery pipeline

You are running the software-factory pipeline. Work through the nine phases below strictly in order, for the user request stated at the end of this message. The pipeline is executed with DSH-native machinery only — the session's real tools and logs are the record of the run.

Ground rules:

- Emit one compact status line when you ENTER each phase (with your intent) and one when you LEAVE it (with the outcome), in exactly this form: \`[factory] phase <n>/9 <key>: <short status>\` — for example \`[factory] phase 3/9 implement: 3 tasks done\`.
- Never skip an enabled phase. If a phase fails, fix and retry within that phase; if it truly cannot pass, stop and report the failure honestly instead of moving on silently.
- A disabled phase is still announced: \`[factory] phase <n>/9 <key>: skipped (disabled by configuration)\`.
- Report command results honestly: a non-zero exit code is a failure, whatever the output looks like. Quote exit codes.
- Do not restate this directive; execute it. Keep prose between status lines short and factual.`;

/**
 * Render a numbered command list for the prompt.
 * @param {readonly string[]} commands
 * @returns {string} markdown lines, empty when nothing is configured.
 */
function renderCommandList(commands) {
  if (commands.length === 0) return '';
  return commands.map((command, index) => `${index + 1}. \`${command}\``).join('\n');
}

/** Clarification dimensions every grill covers, in order. */
const GRILL_DIMENSIONS = [
  'functional scope and explicit non-goals',
  'data model and storage location',
  'limits and their semantics (what is capped, where the cap applies — e.g. cap-at-injection vs cap-at-source)',
  'configuration surface and defaults',
  'UI or CLI behavior and placement',
  'error and edge-case handling',
  'backward compatibility and migration',
  'security and safety expectations',
  'how the result will be verified',
];

/**
 * The capture phase's instruction block under one run mode.
 * - autonomous: the clarification answers gathered at enqueue are binding
 *   acceptance inputs; the run never asks.
 * - grill: interview the user with ask_user_question batches, without any
 *   batch cap, until every dimension above is settled by an explicit answer.
 * - default: ask only on material ambiguity.
 * @param {{autonomous?: boolean, grill?: boolean}} options
 * @returns {string} the capture instruction block.
 */
function captureInstructions(options) {
  if (options.autonomous) {
    return `- Restate the user request in your own words: goal, deliverables, constraints, and the environment it must run in.
- The clarification answers listed after the ground rules are BINDING acceptance inputs from the user; treat them exactly like the request itself and evaluate against them in phase 9.
- This run is autonomous: do not ask the user anything; where an answer is missing, choose the stated option or the conservative default, and record the assumption in the phase-9 report.`;
  }
  if (options.grill) {
    return `- Restate the user request in your own words: goal, deliverables, constraints, and the environment it must run in.
- Before planning ANYTHING, interview the user with the ask_user_question tool until the request is materially clear. Cover every one of these dimensions:
${GRILL_DIMENSIONS.map((dimension) => `  - ${dimension}`).join('\n')}
- Question discipline: batch related questions (up to four per call); every question offers concrete options with one marked (Recommended) or accepts free text; never invent an answer the user did not give; a dimension is settled ONLY by the user's explicit answer.
- There is NO batch limit and NO time limit on this interview — keep asking in as many rounds as needed. Do not soften, skip, or collapse dimensions the user has not answered. When you believe everything is clear, restate the settled decisions in one compact list and proceed.
- Do not start phase 2 until the interview is complete.`;
  }
  return `- Restate the user request in your own words: goal, deliverables, constraints, and the environment it must run in.
- Derive the acceptance criteria you will evaluate against in phase 9, and keep them visible in the transcript.
- Only if the request is materially ambiguous, ask the user now (ask_user_question); otherwise proceed without questions.`;
}

/** The plan phase's instruction block: always a detailed, verifiable plan. */
const PLAN = `- Break the request into concrete, individually verifiable tasks using the session's planning facilities: record the task list with the todo tool (one todo per task), or — when the session is in plan mode — present the plan through exit_plan_mode and continue after approval.
- This run may span hours or days: the plan must be DETAILED. For every task state — its goal in one sentence; the files or directories it will touch (its write scope); how that task alone will be verified (command or manual check); and which tasks it depends on.
- Derive the plan from the user's clarification answers where present; every settled decision maps to at least one task or an explicit non-goal.
- Keep the todo list current as tasks complete; a reviewer reading only the todo list should understand the whole run.`;

/** Static instruction block for the review phase. */
const REVIEW = `- Review the implementation before guardrails: re-read the complete diff of every changed file against the planned tasks and their write scopes.
- Look for what the automated phases cannot catch: wrong or missing task logic, unhandled error paths, security issues (injection, secret leaks, unsafe deserialization), leftover debug code, and dead code.
- Verify each planned task is actually implemented and nothing was quietly deferred; note anything you consciously leave for later.
- Fix what you find now and re-check the fix; report what you reviewed, what you found, and what you changed.`;

/** Static instruction block for the evaluate phase. */
const EVALUATE = `- Evaluate the delivered software against the original request and the acceptance criteria from phase 1.
- Summarize the verification evidence: every command run with its exit status, suites that passed, and what was verified manually.
- State limitations honestly: what was not tested, known risks, and any deferred work.
- Present the deliverables (changed files and produced artifacts) as a clear list.
- Finish with the final status line: \`[factory] phase 9/9 evaluate: <verdict>\`.`;

/**
 * The instruction block for one phase under one effective config: static
 * text where the phase has none, a config- or mode-dependent variant where
 * command lists, toggles, or the run mode change the wording.
 * @param {string} key the phase key.
 * @param {ReturnType<import('./config.js').resolveConfig>} resolved
 *   effective config.
 * @param {{autonomous?: boolean, grill?: boolean}} options run mode.
 * @returns {string} the phase's instruction block.
 */
function phaseInstructions(key, resolved, options) {
  switch (key) {
    case 'capture':
      return captureInstructions(options);
    case 'plan':
      return PLAN;
    case 'implement':
      return resolved.subagentImplementation
        ? `- Implement the tasks with the file tools (read/edit/write), honoring the planned tasks and write scopes; keep the todo list current as tasks complete.
- For larger scopes, prefer subagent delegation: one task per subagent, disjoint write scopes, and review each subagent's diff when it finishes before marking its task done.`
        : `- Implement the tasks with the file tools (read/edit/write), honoring the planned tasks and write scopes; keep the todo list current as tasks complete.
- Subagent delegation is disabled by configuration (\`subagentImplementation: false\`): implement directly with the file tools.`;
    case 'review':
      return REVIEW;
    case 'guardrails': {
      const list = renderCommandList(resolved.guardrailCommand);
      return list !== ''
        ? `- Run the configured guardrail commands (lint, typecheck, format check) with the shell tool:
${list}
- Run long-running commands as background jobs and collect every result before leaving the phase.
- Fix findings and re-run until clean, or report the failure honestly.`
        : `- No guardrail command is configured. Discover the repository's standard checks (package.json scripts, Makefile targets, CI workflow steps) and run those instead; if none exist, announce the phase as skipped for that reason.
- Run long-running commands as background jobs and collect every result before leaving the phase.
- Fix findings and re-run until clean, or report the failure honestly.`;
    }
    case 'test': {
      const list = renderCommandList(resolved.testCommand);
      return list !== ''
        ? `- Run the configured test commands with the shell tool (same rules as guardrails: background jobs for long runs, honest exit codes):
${list}
- Also run local/manual checks where possible — anything that exercises the change without new infrastructure — and say what you verified by hand.`
        : `- No test command is configured. Run the test suites that exist in the repository (unit tests and whatever test suites you find) via the shell tool; if none exist, state that explicitly.
- Also run local/manual checks where possible — anything that exercises the change without new infrastructure — and say what you verified by hand.`;
    }
    case 'deploy':
      return `- A test environment IS configured; deploy to it with the shell tool:
${renderCommandList(resolved.deploy.command)}
- Treat the deploy command's non-zero exit as a phase failure. If the command includes a smoke/verification step, include its evidence in phase 9.`;
    case 'regression': {
      const list = renderCommandList(resolved.regressionCommand);
      return list !== ''
        ? `- Run the configured regression suite with the shell tool (same rules as guardrails and tests):
${list}
- Compare against the results recorded in phase 6: a regression is any previously passing check that now fails.`
        : `- No regression command is configured. Run the repository's regression-relevant suites as discovered in earlier phases; if none exist, announce the phase as skipped for that reason.
- Compare against the results recorded in phase 6: a regression is any previously passing check that now fails.`;
    }
    case 'evaluate':
      return EVALUATE;
    default:
      return '';
  }
}

/**
 * Render one phase's complete prompt section: heading, instructions (or the
 * skip announcement when the phase is disabled), and any verbatim project
 * prompt appended from `.factory.yml`.
 * @param {{key: string, name: string, toggle: string | null}} phase
 *   the phase identity.
 * @param {number} number the phase's 1-based position.
 * @param {ReturnType<import('./config.js').resolveConfig>} resolved
 *   effective config.
 * @param {{autonomous?: boolean, grill?: boolean}} options run mode.
 * @returns {string} the section, without leading or trailing newlines.
 */
function phaseSection(phase, number, resolved, options) {
  const heading = `## Phase ${number}/9 — ${phase.key}: ${phase.name}`;
  const enabled = phase.toggle === null
    || (phase.toggle === 'deploy' ? deployActive(resolved) : resolved[phase.toggle]);
  const body = enabled
    ? phaseInstructions(phase.key, resolved, options)
    : phase.key === 'deploy'
      ? `- Skipped: no test environment is configured (\`deploy.enabled\` is false, or no \`deploy.command\` is set). Announce \`[factory] phase 7/9 deploy: skipped (no test environment configured)\` and move on. Do not invent a deployment.`
      : `- Skipped: the "${phase.toggle}" phase toggle is disabled in the plugin config. Announce the skipped status line and move on.`;
  const projectPrompt = resolved.phasePrompts?.[phase.key];
  const appendix = typeof projectPrompt === 'string' && projectPrompt !== ''
    ? `\n\nProject instructions for this phase (appended verbatim from ${PROJECT_FILE_NAME}):\n\n${projectPrompt}`
    : '';
  return `${heading}\n\n${body}${appendix}`;
}

/**
 * Render the binding clarification answers gathered before this run (from the
 * interactive interview or the enqueue grill) as a prompt section.
 * @param {readonly {question: string, answer: string}[]} clarifications
 * @returns {string} the section, empty when there are none.
 */
function clarificationSection(clarifications) {
  const answers = Array.isArray(clarifications)
    ? clarifications.filter((item) => typeof item?.question === 'string'
      && typeof item?.answer === 'string' && item.question !== '' && item.answer !== '')
    : [];
  if (answers.length === 0) return '';
  return [
    '## Clarification answers (binding)',
    '',
    'The user answered these before the run started. Treat every answer as part of the request; evaluate against them in phase 9.',
    '',
    ...answers.map(({ question, answer }) => `- **${question}**\n  ${answer}`),
  ].join('\n');
}

/**
 * Build the full pipeline prompt steered into the agent.
 * @param {ReturnType<import('./project-file.js').applyProjectOverrides>} resolved
 *   effective config (plugin row Config merged with `.factory.yml`
 *   overrides + phasePrompts).
 * @param {string} request the user's raw request text (already trimmed).
 * @param {{autonomous?: boolean, clarifications?: readonly {question: string,
 *   answer: string}[], titleHint?: string, notice?: string}} options run
 *   mode: `autonomous` never asks (queue workers); `clarifications` embed
 *   binding answers; `titleHint` is a leading line for the session-title
 *   model (worker sessions lead with `Factory queue: <summary>`); `notice`
 *   is a short leading banner (a retry/resume notice for resumed workers).
 * @returns {string} markdown prompt.
 */
export function buildPipelinePrompt(resolved, request, options = {}) {
  const mode = {
    autonomous: options.autonomous === true,
    grill: options.autonomous !== true && resolved.grill !== false,
  };
  const sections = PHASES.map((phase, index) => phaseSection(phase, index + 1, resolved, mode));
  const requestText = request !== ''
    ? request
    : '(Stated in the attachments accompanying this message — treat them as the request.)';
  const clarifications = clarificationSection(options.clarifications);
  const lead = [
    typeof options.titleHint === 'string' && options.titleHint !== '' ? options.titleHint : '',
    typeof options.notice === 'string' && options.notice !== '' ? options.notice : '',
  ].filter((line) => line !== '').join('\n\n');
  const leadText = lead === '' ? '' : `${lead}\n\n`;
  return [
    `${leadText}${PREAMBLE}`,
    ...(clarifications === '' ? [] : [clarifications]),
    ...sections,
    `---\n\n## User request\n\n${requestText}\n`,
  ].join('\n\n');
}
