/**
 * The pipeline prompt builder: renders the steered markdown that drives the
 * agent through the nine phases plus the always-on git delivery contract,
 * honoring the effective config (plugin row Config merged with `.factory.yml`
 * overrides). Every static block is a multi-line template literal that reads
 * exactly as the agent receives it; dynamic content (command lists, project
 * prompts, the request, the PR base) interpolates in one place per block.
 */
import { PHASES } from './phases.js';
import { deployActive } from './config.js';
import { PROJECT_FILE_NAME } from './project-file.js';

/** Heading, mission, and ground rules shared by every run (static). */
const PREAMBLE = `# Software factory — 9-phase delivery pipeline

You are running the software-factory pipeline. Work through the nine phases below strictly in order, for the user request stated at the end of this message. The pipeline is executed with DSH-native machinery only — the session's real tools and logs are the record of the run.

Ground rules:

- Emit one compact status line when you ENTER each phase (with your intent) and one when you LEAVE it (with the outcome), in exactly this form: \`[factory] phase <n>/9 <key>: <short status>\` — an enter line states the intent (\`[factory] phase 3/9 implement: implementing tasks 1-3\`).
- A LEAVE line's status MUST begin with a verdict word — \`pass\`, \`fail\`, or \`skip\` — optionally followed by a dash and free prose: \`[factory] phase 6/9 test: pass — 42 checks green\`, \`[factory] phase 5/9 guardrails: fail — lint exit 1\`. The verdict word alone drives the progress board's icon, so a passing line's status must never contain the words fail, error, or blocked — put honest detail after the dash on fail and skip lines instead.
- Never skip an enabled phase. If a phase fails, fix and retry within that phase; if it truly cannot pass, stop and report the failure honestly instead of moving on silently.
- A disabled phase is still announced: \`[factory] phase <n>/9 <key>: skip (disabled by configuration)\`.
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

/** The gitflow classification bullet shared by every capture mode. */
const CAPTURE_GITFLOW = `- Classify this request's git delivery prefix — feature/ (new capability), bugfix/ (defect fix), hotfix/ (urgent production fix), chore/ (tooling, dependencies, CI, refactoring), docs/ (documentation only) — and derive a short kebab-case slug from the request, and state both in the restatement: they name this run's working branch (see the Git delivery section).`;

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
${CAPTURE_GITFLOW}
- The clarification answers listed after the ground rules are BINDING acceptance inputs from the user; treat them exactly like the request itself and evaluate against them in phase 9.
- This run is autonomous: do not ask the user anything; where an answer is missing, choose the stated option or the conservative default, and record the assumption in the phase-9 report.`;
  }
  if (options.grill) {
    return `- Restate the user request in your own words: goal, deliverables, constraints, and the environment it must run in.
${CAPTURE_GITFLOW}
- Before planning ANYTHING, interview the user with the ask_user_question tool until the request is materially clear. Cover every one of these dimensions:
${GRILL_DIMENSIONS.map((dimension) => `  - ${dimension}`).join('\n')}
- Question discipline: batch related questions (up to four per call); every question offers concrete options with one marked (Recommended) or accepts free text; never invent an answer the user did not give; a dimension is settled ONLY by the user's explicit answer.
- There is NO batch limit and NO time limit on this interview — keep asking in as many rounds as needed. Do not soften, skip, or collapse dimensions the user has not answered. When you believe everything is clear, restate the settled decisions in one compact list and proceed.
- Do not start phase 2 until the interview is complete.`;
  }
  return `- Restate the user request in your own words: goal, deliverables, constraints, and the environment it must run in.
${CAPTURE_GITFLOW}
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
- Close the run per the Git delivery section: name the branch and the PR URL (or the push-only / no-git note) in the report, emit the delivery line, and only then the final status line.
- Finish with the final status line: \`[factory] phase 9/9 evaluate: pass — <verdict>\` (or \`fail — <verdict>\`; the leading verdict word is required).`;

/**
 * The git delivery section: the autonomous branch/commit/push/PR contract
 * shared by every run (hardwired always-on — no configuration switch). The
 * preflight runs at run start BEFORE phase 1, commits accumulate during
 * implement and review, and push + PR close phase 9; only the base-branch
 * rule is dynamic (the explicit --base choice vs the default).
 * @param {string | undefined} base the explicit PR base branch, undefined
 *   when the run uses the default.
 * @returns {string} the section.
 */
function gitDeliverySection(base) {
  const baseLine = base === undefined
    ? 'The PR base branch defaults to `main`; when the repository has no `main` branch on either origin or locally, use the remote\'s default branch (`git symbolic-ref --short refs/remotes/origin/HEAD`, stripping the `origin/` prefix) and state that substitution clearly in the phase-9 report.'
    : `The PR base branch is \`${base}\` — the user's explicit --base choice; any existing branch is a valid base (protected bases like release/* included: the factory pushes only its own head branch).`;
  return `## Git delivery (automatic)

This pipeline delivers through git: no human will branch, commit, push, or open the PR for you. Delivery is hardwired and always on. The preflight below runs at run start, BEFORE phase 1; commits accumulate during implement and review; push and PR close phase 9.

### Preflight (run start, before phase 1)

- If the workspace is not a git repository (\`git rev-parse --is-inside-work-tree\` fails), run the whole pipeline WITHOUT git delivery: skip branch, commit, push, and PR entirely, and state that omission in the phase-9 report and the delivery line.
- Refuse to start on a dirty tree: uncommitted changes at run start fail the run BEFORE any branching, with an error naming the dirty paths — pre-existing changes must never leak into an automated PR.
- Run \`git fetch origin\` first. A fetch that cannot reach the network is not fatal by itself: continue from local refs (the phase-9 push will fail loudly if connectivity is truly broken).
- ${baseLine}
- The base must exist on origin (\`origin/<base>\`) or locally (\`<base>\`); missing on both fails the run BEFORE any work with a clear error naming the base.
- With no \`origin\` remote, delivery is local-only: create the branch and commit as usual, skip push and PR, and record a clear warning in the phase-9 report and the delivery line.
- Create the working branch from the base's tip: \`git switch -c <prefix>/<slug> origin/<base>\` (or the local \`<base>\` when origin lacks it). If that name already exists — locally OR on origin — retry with a \`-2\`, \`-3\`, … suffix until unique; the run stays autonomous.

### Branch name

- Prefix: the gitflow classification stated in the phase-1 restatement — \`feature/\` (new capability), \`bugfix/\` (defect fix), \`hotfix/\` (urgent production fix), \`chore/\` (tooling, dependencies, CI, refactoring), \`docs/\` (documentation only).
- Slug: a short kebab-case derivation of the request or summary (e.g. \`feature/csv-export\`, \`bugfix/queue-halt-race\`).

### Commits (during implement and review)

- Commit logical chunks as work lands: each completed task or coherent chunk gets its own commit; review fixes add small fixup commits. Nothing the run changed stays uncommitted at the end.
- Commit message format (exactly the /draft-commit format from dsh-git-actions): the first line is \`type: brief description\` with type one of feature/fix/docs/chore/refactor as applicable, then one-sentence change bullets (one \`-\` bullet per line); no footer.
- Secret guard before every commit: if the run itself created an obvious secret file (\`.env\`, \`*.pem\`, \`id_rsa\`, \`*.key\`), do NOT commit it — its presence means the run produced credentials: fail the run and report the file.

### Push + PR (close of phase 9)

- Push and PR happen ONLY when every phase passed. A failing verification phase sends the pipeline back to plan to fix the issues and re-run, looping without an iteration cap until all phases pass (the ground rule to stop and report honestly when a phase truly cannot pass still applies — and then there is no push and no PR).
- Push once: \`git push -u origin <branch>\`. A push failure (auth, network) marks the run FAILED — retryable, never claimed as success.
- Create the PR exactly the /draft-pr way (dsh-git-actions): \`gh pr create --base <base> --head <branch> --title '<type>: <brief description>' --body-file <file>\` — ready for review, NOT a draft. Title: \`type: brief description\` like a commit; body: a \`## Summary\` bullet list mirroring the branch's commit bullets plus a \`## Verification\` section stating what was checked, fed by the phase evidence.
- \`gh\` missing or the repository not on GitHub: the run still SUCCEEDS as push-only — record 'pushed, no PR — gh missing / not a GitHub repo' in the phase-9 report and the delivery line.
- An open PR already exists for the branch (e.g. after a retry): fail the pipeline and wait for the user to handle it manually. Merging and everything after the PR stay with the user — the pipeline never merges.

### Delivery line

- Immediately BEFORE the final phase-9 status line, emit EXACTLY ONE line for the queue's bookkeeping, in this form and nothing else on that line:
  \`[factory] delivery: {"branch":"<branch>","pr":"<pr url>","note":"<note>"}\`
  (\`pr\` is null when no PR was created; \`note\` carries the degradation or omission reason — e.g. 'pushed, no PR — gh missing / not a GitHub repo', 'no git repository — git delivery omitted' — and is omitted on a clean delivery. Keep the JSON on one line.)`;
}

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
 *   answer: string}[], titleHint?: string, notice?: string, base?: string}} options run
 *   mode: `autonomous` never asks (queue workers); `clarifications` embed
 *   binding answers; `titleHint` is a leading line for the session-title
 *   model (worker sessions lead with `Factory queue: <summary>`); `notice`
 *   is a short leading banner (a retry/resume notice for resumed workers);
 *   `base` names the explicit PR base branch (--base flag / enqueue JSON
 *   `base` field) — absent renders the default-main rule in the Git
 *   delivery section.
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
  const rawBase = typeof options.base === 'string' ? options.base.trim() : '';
  const git = gitDeliverySection(rawBase === '' ? undefined : rawBase);
  const lead = [
    typeof options.titleHint === 'string' && options.titleHint !== '' ? options.titleHint : '',
    typeof options.notice === 'string' && options.notice !== '' ? options.notice : '',
  ].filter((line) => line !== '').join('\n\n');
  const leadText = lead === '' ? '' : `${lead}\n\n`;
  return [
    `${leadText}${PREAMBLE}`,
    ...(clarifications === '' ? [] : [clarifications]),
    git,
    ...sections,
    `---\n\n## User request\n\n${requestText}\n`,
  ].join('\n\n');
}
