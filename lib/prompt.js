/**
 * The pipeline prompt builder: renders the steered markdown that drives the
 * agent through the nine phases, honoring the effective config (plugin row
 * Config merged with `.factory.yml` overrides).
 */
import { PHASES } from './phases.js';
import { deployActive } from './config.js';
import { PROJECT_FILE_NAME } from './project-file.js';

/**
 * Render a numbered command list for the prompt.
 * @param {readonly string[]} commands
 * @returns {string} markdown lines, empty when nothing is configured.
 */
function renderCommandList(commands) {
  if (commands.length === 0) return '';
  return commands.map((command, index) => `${index + 1}. \`${command}\``).join('\n');
}

/**
 * Build the full pipeline prompt steered into the agent.
 * @param {ReturnType<import('./project-file.js').applyProjectOverrides>} resolved
 *   effective config (plugin row Config merged with `.factory.yml`
 *   overrides + phasePrompts).
 * @param {string} request the user's raw request text (already trimmed).
 * @returns {string} markdown prompt.
 */
export function buildPipelinePrompt(resolved, request) {
  const lines = [];
  lines.push('# Software factory — 9-phase delivery pipeline');
  lines.push('');
  lines.push(
    'You are running the software-factory pipeline. Work through the nine phases below strictly in order, for the user request stated at the end of this message. The pipeline is executed with DSH-native machinery only — the session\'s real tools and logs are the record of the run.',
  );
  lines.push('');
  lines.push('Ground rules:');
  lines.push('');
  lines.push(
    '- Emit one compact status line when you ENTER each phase (with your intent) and one when you LEAVE it (with the outcome), in exactly this form: `[factory] phase <n>/9 <key>: <short status>` — for example `[factory] phase 3/9 implement: 3 tasks done`.',
  );
  lines.push(
    '- Never skip an enabled phase. If a phase fails, fix and retry within that phase; if it truly cannot pass, stop and report the failure honestly instead of moving on silently.',
  );
  lines.push(
    '- A disabled phase is still announced: `[factory] phase <n>/9 <key>: skipped (disabled by configuration)`.',
  );
  lines.push(
    '- Report command results honestly: a non-zero exit code is a failure, whatever the output looks like. Quote exit codes.',
  );
  lines.push(
    '- Do not restate this directive; execute it. Keep prose between status lines short and factual.',
  );

  const enabled = (phase) => {
    if (phase.toggle === null) return true;
    if (phase.toggle === 'deploy') return deployActive(resolved);
    return resolved[phase.toggle];
  };

  for (let index = 0; index < PHASES.length; index += 1) {
    const phase = PHASES[index];
    const number = index + 1;
    lines.push('');
    lines.push(`## Phase ${number}/9 — ${phase.key}: ${phase.name}`);
    if (!enabled(phase)) {
      if (phase.key === 'deploy') {
        lines.push('');
        lines.push(
          '- Skipped: no test environment is configured (`deploy.enabled` is false, or no `deploy.command` is set). Announce `[factory] phase 7/9 deploy: skipped (no test environment configured)` and move on. Do not invent a deployment.',
        );
      } else {
        lines.push('');
        lines.push(
          `- Skipped: the "${phase.toggle}" phase toggle is disabled in the plugin config. Announce the skipped status line and move on.`,
        );
      }
      continue;
    }
    lines.push('');
    switch (phase.key) {
      case 'capture':
        lines.push('- Restate the user request in your own words: goal, deliverables, constraints, and the environment it must run in.');
        lines.push('- Derive the acceptance criteria you will evaluate against in phase 9, and keep them visible in the transcript.');
        lines.push('- Only if the request is materially ambiguous, ask the user now (ask_user_question); otherwise proceed without questions.');
        break;
      case 'plan':
        lines.push('- Break the request into concrete, individually verifiable tasks using the session\'s planning facilities: record the task list with the todo tool (one todo per task), or — when the session is in plan mode — present the plan through exit_plan_mode and continue after approval.');
        lines.push('- Give each task its expected write scope (files or directories it touches) so parallel work stays disjoint.');
        lines.push('- Planning only: do not start implementing in this phase.');
        break;
      case 'implement':
        lines.push('- Implement the tasks with the file tools (read/edit/write), honoring the planned tasks and write scopes; keep the todo list current as tasks complete.');
        if (resolved.subagentImplementation) {
          lines.push('- For larger scopes, prefer subagent delegation: one task per subagent, disjoint write scopes, and review each subagent\'s diff when it finishes before marking its task done.');
        } else {
          lines.push('- Subagent delegation is disabled by configuration (`subagentImplementation: false`): implement directly with the file tools.');
        }
        break;
      case 'review':
        lines.push('- Review the implementation before guardrails: re-read the complete diff of every changed file against the planned tasks and their write scopes.');
        lines.push('- Look for what the automated phases cannot catch: wrong or missing task logic, unhandled error paths, security issues (injection, secret leaks, unsafe deserialization), leftover debug code, and dead code.');
        lines.push('- Verify each planned task is actually implemented and nothing was quietly deferred; note anything you consciously leave for later.');
        lines.push('- Fix what you find now and re-check the fix; report what you reviewed, what you found, and what you changed.');
        break;
      case 'guardrails': {
        const list = renderCommandList(resolved.guardrailCommand);
        if (list !== '') {
          lines.push('- Run the configured guardrail commands (lint, typecheck, format check) with the shell tool:');
          lines.push(list);
        } else {
          lines.push('- No guardrail command is configured. Discover the repository\'s standard checks (package.json scripts, Makefile targets, CI workflow steps) and run those instead; if none exist, announce the phase as skipped for that reason.');
        }
        lines.push('- Run long-running commands as background jobs and collect every result before leaving the phase.');
        lines.push('- Fix findings and re-run until clean, or report the failure honestly.');
        break;
      }
      case 'test': {
        const list = renderCommandList(resolved.testCommand);
        if (list !== '') {
          lines.push('- Run the configured test commands with the shell tool (same rules as guardrails: background jobs for long runs, honest exit codes):');
          lines.push(list);
        } else {
          lines.push('- No test command is configured. Run the test suites that exist in the repository (unit tests and whatever test suites you find) via the shell tool; if none exist, state that explicitly.');
        }
        lines.push('- Also run local/manual checks where possible — anything that exercises the change without new infrastructure — and say what you verified by hand.');
        break;
      }
      case 'deploy': {
        const list = renderCommandList(resolved.deploy.command);
        lines.push('- A test environment IS configured; deploy to it with the shell tool:');
        lines.push(list);
        lines.push('- Treat the deploy command\'s non-zero exit as a phase failure. If the command includes a smoke/verification step, include its evidence in phase 9.');
        break;
      }
      case 'regression': {
        const list = renderCommandList(resolved.regressionCommand);
        if (list !== '') {
          lines.push('- Run the configured regression suite with the shell tool (same rules as guardrails and tests):');
          lines.push(list);
        } else {
          lines.push('- No regression command is configured. Run the repository\'s regression-relevant suites as discovered in earlier phases; if none exist, announce the phase as skipped for that reason.');
        }
        lines.push('- Compare against the results recorded in phase 6: a regression is any previously passing check that now fails.');
        break;
      }
      case 'evaluate':
        lines.push('- Evaluate the delivered software against the original request and the acceptance criteria from phase 1.');
        lines.push('- Summarize the verification evidence: every command run with its exit status, suites that passed, and what was verified manually.');
        lines.push('- State limitations honestly: what was not tested, known risks, and any deferred work.');
        lines.push('- Present the deliverables (changed files and produced artifacts) as a clear list.');
        lines.push('- Finish with the final status line: `[factory] phase 9/9 evaluate: <verdict>`.');
        break;
      default:
        break;
    }
    const projectPrompt = resolved.phasePrompts?.[phase.key];
    if (typeof projectPrompt === 'string' && projectPrompt !== '') {
      lines.push('');
      lines.push(`Project instructions for this phase (appended verbatim from ${PROJECT_FILE_NAME}):`);
      lines.push('');
      lines.push(projectPrompt);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## User request');
  lines.push('');
  if (request !== '') {
    lines.push(request);
  } else {
    lines.push('(Stated in the attachments accompanying this message — treat them as the request.)');
  }
  lines.push('');
  return lines.join('\n');
}
