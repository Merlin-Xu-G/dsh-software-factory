===== defaults =====
# Software factory — 9-phase delivery pipeline

You are running the software-factory pipeline. Work through the nine phases below strictly in order, for the user request stated at the end of this message. The pipeline is executed with DSH-native machinery only — the session's real tools and logs are the record of the run.

Ground rules:

- Emit one compact status line when you ENTER each phase (with your intent) and one when you LEAVE it (with the outcome), in exactly this form: `[factory] phase <n>/9 <key>: <short status>` — for example `[factory] phase 3/9 implement: 3 tasks done`.
- Never skip an enabled phase. If a phase fails, fix and retry within that phase; if it truly cannot pass, stop and report the failure honestly instead of moving on silently.
- A disabled phase is still announced: `[factory] phase <n>/9 <key>: skipped (disabled by configuration)`.
- Report command results honestly: a non-zero exit code is a failure, whatever the output looks like. Quote exit codes.
- Do not restate this directive; execute it. Keep prose between status lines short and factual.

## Phase 1/9 — capture: Capture the request

- Restate the user request in your own words: goal, deliverables, constraints, and the environment it must run in.
- Derive the acceptance criteria you will evaluate against in phase 9, and keep them visible in the transcript.
- Only if the request is materially ambiguous, ask the user now (ask_user_question); otherwise proceed without questions.

## Phase 2/9 — plan: Plan the tasks

- Break the request into concrete, individually verifiable tasks using the session's planning facilities: record the task list with the todo tool (one todo per task), or — when the session is in plan mode — present the plan through exit_plan_mode and continue after approval.
- Give each task its expected write scope (files or directories it touches) so parallel work stays disjoint.
- Planning only: do not start implementing in this phase.

## Phase 3/9 — implement: Implement the tasks

- Implement the tasks with the file tools (read/edit/write), honoring the planned tasks and write scopes; keep the todo list current as tasks complete.
- For larger scopes, prefer subagent delegation: one task per subagent, disjoint write scopes, and review each subagent's diff when it finishes before marking its task done.

## Phase 4/9 — review: Review the implementation

- Review the implementation before guardrails: re-read the complete diff of every changed file against the planned tasks and their write scopes.
- Look for what the automated phases cannot catch: wrong or missing task logic, unhandled error paths, security issues (injection, secret leaks, unsafe deserialization), leftover debug code, and dead code.
- Verify each planned task is actually implemented and nothing was quietly deferred; note anything you consciously leave for later.
- Fix what you find now and re-check the fix; report what you reviewed, what you found, and what you changed.

## Phase 5/9 — guardrails: Run guardrails

- No guardrail command is configured. Discover the repository's standard checks (package.json scripts, Makefile targets, CI workflow steps) and run those instead; if none exist, announce the phase as skipped for that reason.
- Run long-running commands as background jobs and collect every result before leaving the phase.
- Fix findings and re-run until clean, or report the failure honestly.

## Phase 6/9 — test: Test the implementation

- No test command is configured. Run the test suites that exist in the repository (unit tests and whatever test suites you find) via the shell tool; if none exist, state that explicitly.
- Also run local/manual checks where possible — anything that exercises the change without new infrastructure — and say what you verified by hand.

## Phase 7/9 — deploy: Deploy to test environment

- Skipped: no test environment is configured (`deploy.enabled` is false, or no `deploy.command` is set). Announce `[factory] phase 7/9 deploy: skipped (no test environment configured)` and move on. Do not invent a deployment.

## Phase 8/9 — regression: Run regression tests

- No regression command is configured. Run the repository's regression-relevant suites as discovered in earlier phases; if none exist, announce the phase as skipped for that reason.
- Compare against the results recorded in phase 6: a regression is any previously passing check that now fails.

## Phase 9/9 — evaluate: Evaluate and report

- Evaluate the delivered software against the original request and the acceptance criteria from phase 1.
- Summarize the verification evidence: every command run with its exit status, suites that passed, and what was verified manually.
- State limitations honestly: what was not tested, known risks, and any deferred work.
- Present the deliverables (changed files and produced artifacts) as a clear list.
- Finish with the final status line: `[factory] phase 9/9 evaluate: <verdict>`.

---

## User request

Add CSV export to the settings page

===== full-config =====
# Software factory — 9-phase delivery pipeline

You are running the software-factory pipeline. Work through the nine phases below strictly in order, for the user request stated at the end of this message. The pipeline is executed with DSH-native machinery only — the session's real tools and logs are the record of the run.

Ground rules:

- Emit one compact status line when you ENTER each phase (with your intent) and one when you LEAVE it (with the outcome), in exactly this form: `[factory] phase <n>/9 <key>: <short status>` — for example `[factory] phase 3/9 implement: 3 tasks done`.
- Never skip an enabled phase. If a phase fails, fix and retry within that phase; if it truly cannot pass, stop and report the failure honestly instead of moving on silently.
- A disabled phase is still announced: `[factory] phase <n>/9 <key>: skipped (disabled by configuration)`.
- Report command results honestly: a non-zero exit code is a failure, whatever the output looks like. Quote exit codes.
- Do not restate this directive; execute it. Keep prose between status lines short and factual.

## Phase 1/9 — capture: Capture the request

- Restate the user request in your own words: goal, deliverables, constraints, and the environment it must run in.
- Derive the acceptance criteria you will evaluate against in phase 9, and keep them visible in the transcript.
- Only if the request is materially ambiguous, ask the user now (ask_user_question); otherwise proceed without questions.

## Phase 2/9 — plan: Plan the tasks

- Break the request into concrete, individually verifiable tasks using the session's planning facilities: record the task list with the todo tool (one todo per task), or — when the session is in plan mode — present the plan through exit_plan_mode and continue after approval.
- Give each task its expected write scope (files or directories it touches) so parallel work stays disjoint.
- Planning only: do not start implementing in this phase.

## Phase 3/9 — implement: Implement the tasks

- Implement the tasks with the file tools (read/edit/write), honoring the planned tasks and write scopes; keep the todo list current as tasks complete.
- Subagent delegation is disabled by configuration (`subagentImplementation: false`): implement directly with the file tools.

## Phase 4/9 — review: Review the implementation

- Review the implementation before guardrails: re-read the complete diff of every changed file against the planned tasks and their write scopes.
- Look for what the automated phases cannot catch: wrong or missing task logic, unhandled error paths, security issues (injection, secret leaks, unsafe deserialization), leftover debug code, and dead code.
- Verify each planned task is actually implemented and nothing was quietly deferred; note anything you consciously leave for later.
- Fix what you find now and re-check the fix; report what you reviewed, what you found, and what you changed.

## Phase 5/9 — guardrails: Run guardrails

- Run the configured guardrail commands (lint, typecheck, format check) with the shell tool:
1. `npm run lint`
2. `npm run typecheck`
- Run long-running commands as background jobs and collect every result before leaving the phase.
- Fix findings and re-run until clean, or report the failure honestly.

## Phase 6/9 — test: Test the implementation

- Run the configured test commands with the shell tool (same rules as guardrails: background jobs for long runs, honest exit codes):
1. `npm test`
- Also run local/manual checks where possible — anything that exercises the change without new infrastructure — and say what you verified by hand.

## Phase 7/9 — deploy: Deploy to test environment

- A test environment IS configured; deploy to it with the shell tool:
1. `./scripts/deploy-test.sh`
- Treat the deploy command's non-zero exit as a phase failure. If the command includes a smoke/verification step, include its evidence in phase 9.

## Phase 8/9 — regression: Run regression tests

- Run the configured regression suite with the shell tool (same rules as guardrails and tests):
1. `npm run test:e2e`
- Compare against the results recorded in phase 6: a regression is any previously passing check that now fails.

## Phase 9/9 — evaluate: Evaluate and report

- Evaluate the delivered software against the original request and the acceptance criteria from phase 1.
- Summarize the verification evidence: every command run with its exit status, suites that passed, and what was verified manually.
- State limitations honestly: what was not tested, known risks, and any deferred work.
- Present the deliverables (changed files and produced artifacts) as a clear list.
- Finish with the final status line: `[factory] phase 9/9 evaluate: <verdict>`.

---

## User request

Ship the login throttle

===== phases-disabled =====
# Software factory — 9-phase delivery pipeline

You are running the software-factory pipeline. Work through the nine phases below strictly in order, for the user request stated at the end of this message. The pipeline is executed with DSH-native machinery only — the session's real tools and logs are the record of the run.

Ground rules:

- Emit one compact status line when you ENTER each phase (with your intent) and one when you LEAVE it (with the outcome), in exactly this form: `[factory] phase <n>/9 <key>: <short status>` — for example `[factory] phase 3/9 implement: 3 tasks done`.
- Never skip an enabled phase. If a phase fails, fix and retry within that phase; if it truly cannot pass, stop and report the failure honestly instead of moving on silently.
- A disabled phase is still announced: `[factory] phase <n>/9 <key>: skipped (disabled by configuration)`.
- Report command results honestly: a non-zero exit code is a failure, whatever the output looks like. Quote exit codes.
- Do not restate this directive; execute it. Keep prose between status lines short and factual.

## Phase 1/9 — capture: Capture the request

- Restate the user request in your own words: goal, deliverables, constraints, and the environment it must run in.
- Derive the acceptance criteria you will evaluate against in phase 9, and keep them visible in the transcript.
- Only if the request is materially ambiguous, ask the user now (ask_user_question); otherwise proceed without questions.

## Phase 2/9 — plan: Plan the tasks

- Skipped: the "plan" phase toggle is disabled in the plugin config. Announce the skipped status line and move on.

## Phase 3/9 — implement: Implement the tasks

- Implement the tasks with the file tools (read/edit/write), honoring the planned tasks and write scopes; keep the todo list current as tasks complete.
- For larger scopes, prefer subagent delegation: one task per subagent, disjoint write scopes, and review each subagent's diff when it finishes before marking its task done.

## Phase 4/9 — review: Review the implementation

- Skipped: the "review" phase toggle is disabled in the plugin config. Announce the skipped status line and move on.

## Phase 5/9 — guardrails: Run guardrails

- No guardrail command is configured. Discover the repository's standard checks (package.json scripts, Makefile targets, CI workflow steps) and run those instead; if none exist, announce the phase as skipped for that reason.
- Run long-running commands as background jobs and collect every result before leaving the phase.
- Fix findings and re-run until clean, or report the failure honestly.

## Phase 6/9 — test: Test the implementation

- No test command is configured. Run the test suites that exist in the repository (unit tests and whatever test suites you find) via the shell tool; if none exist, state that explicitly.
- Also run local/manual checks where possible — anything that exercises the change without new infrastructure — and say what you verified by hand.

## Phase 7/9 — deploy: Deploy to test environment

- Skipped: no test environment is configured (`deploy.enabled` is false, or no `deploy.command` is set). Announce `[factory] phase 7/9 deploy: skipped (no test environment configured)` and move on. Do not invent a deployment.

## Phase 8/9 — regression: Run regression tests

- Skipped: the "regression" phase toggle is disabled in the plugin config. Announce the skipped status line and move on.

## Phase 9/9 — evaluate: Evaluate and report

- Evaluate the delivered software against the original request and the acceptance criteria from phase 1.
- Summarize the verification evidence: every command run with its exit status, suites that passed, and what was verified manually.
- State limitations honestly: what was not tested, known risks, and any deferred work.
- Present the deliverables (changed files and produced artifacts) as a clear list.
- Finish with the final status line: `[factory] phase 9/9 evaluate: <verdict>`.

---

## User request

Rename the helper

===== project-prompts =====
# Software factory — 9-phase delivery pipeline

You are running the software-factory pipeline. Work through the nine phases below strictly in order, for the user request stated at the end of this message. The pipeline is executed with DSH-native machinery only — the session's real tools and logs are the record of the run.

Ground rules:

- Emit one compact status line when you ENTER each phase (with your intent) and one when you LEAVE it (with the outcome), in exactly this form: `[factory] phase <n>/9 <key>: <short status>` — for example `[factory] phase 3/9 implement: 3 tasks done`.
- Never skip an enabled phase. If a phase fails, fix and retry within that phase; if it truly cannot pass, stop and report the failure honestly instead of moving on silently.
- A disabled phase is still announced: `[factory] phase <n>/9 <key>: skipped (disabled by configuration)`.
- Report command results honestly: a non-zero exit code is a failure, whatever the output looks like. Quote exit codes.
- Do not restate this directive; execute it. Keep prose between status lines short and factual.

## Phase 1/9 — capture: Capture the request

- Restate the user request in your own words: goal, deliverables, constraints, and the environment it must run in.
- Derive the acceptance criteria you will evaluate against in phase 9, and keep them visible in the transcript.
- Only if the request is materially ambiguous, ask the user now (ask_user_question); otherwise proceed without questions.

## Phase 2/9 — plan: Plan the tasks

- Break the request into concrete, individually verifiable tasks using the session's planning facilities: record the task list with the todo tool (one todo per task), or — when the session is in plan mode — present the plan through exit_plan_mode and continue after approval.
- Give each task its expected write scope (files or directories it touches) so parallel work stays disjoint.
- Planning only: do not start implementing in this phase.

Project instructions for this phase (appended verbatim from .factory.yml):

Split backend and frontend tasks.

## Phase 3/9 — implement: Implement the tasks

- Implement the tasks with the file tools (read/edit/write), honoring the planned tasks and write scopes; keep the todo list current as tasks complete.
- For larger scopes, prefer subagent delegation: one task per subagent, disjoint write scopes, and review each subagent's diff when it finishes before marking its task done.

## Phase 4/9 — review: Review the implementation

- Review the implementation before guardrails: re-read the complete diff of every changed file against the planned tasks and their write scopes.
- Look for what the automated phases cannot catch: wrong or missing task logic, unhandled error paths, security issues (injection, secret leaks, unsafe deserialization), leftover debug code, and dead code.
- Verify each planned task is actually implemented and nothing was quietly deferred; note anything you consciously leave for later.
- Fix what you find now and re-check the fix; report what you reviewed, what you found, and what you changed.

Project instructions for this phase (appended verbatim from .factory.yml):

Check error paths first.
Then security.

## Phase 5/9 — guardrails: Run guardrails

- No guardrail command is configured. Discover the repository's standard checks (package.json scripts, Makefile targets, CI workflow steps) and run those instead; if none exist, announce the phase as skipped for that reason.
- Run long-running commands as background jobs and collect every result before leaving the phase.
- Fix findings and re-run until clean, or report the failure honestly.

## Phase 6/9 — test: Test the implementation

- No test command is configured. Run the test suites that exist in the repository (unit tests and whatever test suites you find) via the shell tool; if none exist, state that explicitly.
- Also run local/manual checks where possible — anything that exercises the change without new infrastructure — and say what you verified by hand.

## Phase 7/9 — deploy: Deploy to test environment

- A test environment IS configured; deploy to it with the shell tool:
1. `deploy.sh`
- Treat the deploy command's non-zero exit as a phase failure. If the command includes a smoke/verification step, include its evidence in phase 9.

Project instructions for this phase (appended verbatim from .factory.yml):

curl /healthz afterwards.

## Phase 8/9 — regression: Run regression tests

- No regression command is configured. Run the repository's regression-relevant suites as discovered in earlier phases; if none exist, announce the phase as skipped for that reason.
- Compare against the results recorded in phase 6: a regression is any previously passing check that now fails.

## Phase 9/9 — evaluate: Evaluate and report

- Evaluate the delivered software against the original request and the acceptance criteria from phase 1.
- Summarize the verification evidence: every command run with its exit status, suites that passed, and what was verified manually.
- State limitations honestly: what was not tested, known risks, and any deferred work.
- Present the deliverables (changed files and produced artifacts) as a clear list.
- Finish with the final status line: `[factory] phase 9/9 evaluate: <verdict>`.

Project instructions for this phase (appended verbatim from .factory.yml):

List every changed file.

---

## User request

(Stated in the attachments accompanying this message — treat them as the request.)
