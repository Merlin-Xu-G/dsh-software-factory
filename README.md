# dsh-software-factory

A DSH (DeepSeek Harness) Host plugin bundle that adds the **`/factory <request>`**
slash command: a managed software-delivery pipeline with exactly nine phases,
executed by the session's agent through DSH-native machinery — and delivering
every run through git automatically (branch, commits, push, PR).

```
/factory Add CSV export to the settings page
/factory --base release/1.2 Port the exporter to v2
```

The command steers one model-visible user message into the receiving agent —
the same mechanism `@deepseek-ai/dsh-plan-mode` uses for `/plan [message]` —
containing a structured pipeline prompt plus the user's request, then returns
a short success text. The agent runs the pipeline and narrates progress with
compact per-phase status lines such as:

```
[factory] phase 3/9 implement: implementing tasks 1-3
[factory] phase 6/9 test: pass — 42 checks green
```

A phase-LEAVE line's status must begin with a verdict word — `pass`, `fail`,
or `skip` — optionally followed by a dash and free prose; that first word
alone drives the tab's per-phase icon (see "Web client" below).

## Compatibility

- Minimum DSH: `>=0.2.0-rc.2` — declared in `package.json` → `engines.dsh`. DSH enforces this floor at install/activation and matches prerelease versions, so it never blocks a newer DSH.
- Latest tested DSH: `0.2.1-rc.2` — recorded in `package.json` → `dsh.latestTestedDshVersion`. Descriptive only; DSH does not enforce it.

## The nine phases

| # | Key | Phase | Driven by |
|---|-----|-------|-----------|
| 1 | `capture` | Capture the request | restate goal, deliverables, constraints; grill mode (default): unbounded `ask_user_question` batches across a fixed checklist until every dimension has the user's explicit answer (`grill: false` falls back to ask-only-when-ambiguous) |
| 2 | `plan` | Plan the tasks | a DETAILED plan for long runs: the session's planning facilities (todo list, or `exit_plan_mode` in plan mode), one todo per task naming goal, write scope, verification, and dependencies |
| 3 | `implement` | Implement the tasks | file tools (read/edit/write); for larger scopes, one subagent per task with disjoint write scopes |
| 4 | `review` | Review the implementation | re-read the full diff against the plan; defect, security, debug-code, and dead-code pass; verify no task was quietly deferred; fix findings before guardrails |
| 5 | `guardrails` | Run guardrails (lint, typecheck, format check) | configured commands via the shell tool; long runs as background jobs; non-zero exit = failure |
| 6 | `test` | Test the implementation | configured test commands the same way, plus local/manual checks where possible |
| 7 | `deploy` | Deploy to a test environment | **only** when `deploy.enabled` and `deploy.command` are configured; otherwise explicitly skipped |
| 8 | `regression` | Run regression tests | the configured regression suite; regressions compared against phase-6 results |
| 9 | `evaluate` | Evaluate and report | evaluate against the original request; summarize evidence and limitations; present deliverables |

Enabled phases may not be skipped: failures are fixed and retried within the
phase, or reported honestly. Disabled phases are still announced with a
`skipped` status line. Command results are reported honestly — a non-zero
exit code is a failure.

When a command list (guardrails / tests / regression) is not configured, the
prompt tells the agent to discover the repository's standard checks and run
those, and to state clearly when none exist.

## Git delivery (always on)

Every run — interactive and queue worker alike — delivers through git. The
instructions live in the pipeline prompt (no host-side git code: the worker
runs `git`/`gh` through its shell tool like any other phase), and delivery is
hardwired: there is no configuration switch.

- **Branch at run start, before phase 1.** Preflight: skip git entirely when
  the workspace is not a git repository (noted in the phase-9 report); fail
  before branching on a dirty tree (naming the dirty paths — pre-existing
  changes never leak into an automated PR); `git fetch origin` first; validate
  the base; create the working branch from the base's tip with `-2`, `-3`, …
  suffixes when the name exists locally or on origin.
- **Branch name: gitflow.** The phase-1 restatement classifies the request
  into `feature/`, `bugfix/`, `hotfix/`, `chore/`, or `docs/` plus a short
  kebab-case slug (e.g. `feature/csv-export`).
- **PR base: `--base <branch>`** on `/factory` (with or without `-q`), or a
  `"base"` field in the enqueue JSON; default `main`, falling back to the
  remote's default branch (`origin/HEAD`) when `main` exists nowhere and
  stating the substitution. A base missing on both origin and locally fails
  the run before any work. Any existing base is allowed, protected branches
  included — the factory pushes only its own head branch.
- **Commits as work lands** (implement/review): one commit per completed
  task or coherent chunk, review fixes as small fixup commits. Message
  format is exactly the `/draft-commit` format from dsh-git-actions — first
  line `type: brief description`, then one-sentence change bullets, no
  footer. Before every commit the worker refuses to commit run-created
  secret files (`.env`, `*.pem`, `id_rsa`, `*.key`); finding one fails the
  run.
- **Push + PR close phase 9, only after every phase passed.** A failing
  verification phase loops the pipeline back to plan (no iteration cap)
  until everything passes. Then one `git push -u origin <branch>` and one
  ready-for-review PR created exactly the `/draft-pr` way:
  `gh pr create --base <base> --head <branch> --title '<type>: …' --body-file …`
  with a `## Summary` bullet list mirroring the branch's commit bullets and
  a `## Verification` section fed by the phase evidence.
- **Degradations, honestly reported.** No `origin` remote → local-only
  delivery (branch + commit, no push/PR, warning recorded). Push failure
  (auth/network) → the run fails and is retryable. `gh` missing or a
  non-GitHub repo → the run SUCCEEDS push-only with the note
  'pushed, no PR — gh missing / not a GitHub repo'. An open PR already
  existing for the branch fails the pipeline for manual handling; merging
  and every post-PR step stay with the user.
- **The delivery line.** Right before the final phase-9 status line the run
  emits `[factory] delivery: {"branch":"…","pr":"…","note":"…"}`. The
  projection folds it (state v7) and the queue stores it on the item, so the
  queue panel shows the branch + PR link and `/factory queue` prints them.

## Install

Reviewed and installed by the Lead with the `plugin_manager` tool:

```
action: install_bundle
target: <absolute path of this repository>
```

The bundle inserts one row (`id: software-factory`) and needs no
dependencies, install scripts, or build tools.

## Configuration

All keys are optional. Defaults: **every phase enabled except deploy** (deploy
stays off until both `deploy.enabled` is true and a `deploy.command` is set)
and **the Factory tab auto-opens** when a run starts.

```yaml
- id: software-factory
  name: '@local/dsh-software-factory'
  config:
    plan: true                    # phase 2 toggle
    implement: true               # phase 3 toggle
    review: true                  # phase 4 toggle
    guardrails: true              # phase 5 toggle
    test: true                    # phase 6 toggle
    regression: true              # phase 8 toggle
    evaluate: true                # phase 9 toggle
    subagentImplementation: true  # prefer per-task subagent delegation in phase 3
    autoOpenTab: true             # auto-open the Factory sidebar tab when a run starts
    grill: true                   # interview the user (unbounded batches) before planning
    queueConcurrency: 3           # max simultaneously running queue workers
    guardrailCommand: 'npm run lint'        # string or array of strings
    testCommand: ['npm run typecheck', 'npm test']
    regressionCommand: 'npm run test:e2e'
    deploy:
      enabled: false
      command: './scripts/deploy-test.sh'
```

Notes:

- Command fields accept one string or an array of non-empty strings; each
  entry runs as its own shell invocation in phase order.
- `autoOpenTab` controls the Web client's auto-open only; the tab itself (and
  its guide entry) stays available either way. Set `autoOpenTab: false` to
  keep the sidebar untouched by `/factory` runs.
- `grill: false` restores ask-only-when-materially-ambiguous behavior; the
  detailed-plan requirements of phase 2 stay on either way.
- `queueConcurrency` is the queue's concurrent worker cap (see the queue
  section below); a positive integer.
- Unknown config keys fail at plugin activation (typos never silently
  disable a phase).
- A later patch layer overriding this row replaces `config` wholesale —
  restate every field you need (Cordis loader semantics).

## Per-project configuration: `.factory.yml`

Each repository can override the phase switches and append per-phase prompt
instructions, without touching the profile. When `/factory` runs, the plugin
reads `.factory.yml` from the session workspace root (the session's working
directory) at command time — the same resolution the shipped
`dsh-agent-instructions` uses for AGENTS.md discovery.

**Merge order**: plugin row Config (global defaults) ← `.factory.yml`
(project overrides). File phase toggles win; command lists
(`guardrailCommand` etc.) and the deploy gate (`deploy.enabled` +
`deploy.command`) stay plugin-Config-only. A missing file changes nothing.
An **invalid file fails loudly**: the command returns an error naming the
file, its line, and the problem, and the pipeline does not start.

Full example (`.factory.yml` at the repository root):

```yaml
# Per-project overrides for the /factory pipeline.
phases:
  plan: true
  implement: true
  review: true
  guardrails: true
  test: true
  regression: false      # this repo has no regression suite yet
  evaluate: true

phasePrompts:
  plan: |
    Split backend and frontend tasks; the API contract in docs/api.md is
    authoritative.
  guardrails: |
    Run in this order:
    1. pnpm lint
    2. pnpm typecheck
    Never auto-fix formatting; report and stop.
  test: |
    Use `pnpm test --filter core` for unit tests; integration tests need the
    docker compose stack from scripts/dev.sh — start it as a background job.
  deploy: 'Deploy with ./scripts/deploy-test.sh, then curl the /healthz endpoint'
  evaluate: >-
    Include a section listing every changed file with a one-line rationale.
```

`phasePrompts.<phase>` is appended **verbatim** to that phase's generated
prompt section, but only when the phase actually runs (a disabled phase's
prompt override is not used; `deploy` prompt text applies only while deploy
is active via plugin Config).

### Supported format (strict subset)

The file is parsed by a dependency-free parser that accepts exactly this
subset — anything else is a loud, named error:

- Blank lines and `#` comments anywhere; UTF-8 BOM and CRLF tolerated; tabs
  in indentation are rejected.
- Two top-level mapping headers, each at most once, nothing after the colon:
  `phases:` and `phasePrompts:`.
- Nested entries at one consistent indentation (spaces only),
  `key: value` on a single line.
- `phases.<key>` ∈ `plan | implement | review | guardrails | test |
  regression | evaluate`, value exactly `true` or `false` (`yes`/`True` are
  errors — be explicit).
- `phasePrompts.<key>` ∈ `plan | implement | review | guardrails | test |
  deploy | regression | evaluate` (note: no `capture` — phase 1 is the
  request itself), value a string in one of these forms:
  - plain scalar — rest of the line, trimmed; a trailing ` # comment` is
    stripped;
  - `'single quoted'` (only escape: `''` → `'`) or `"double quoted"`
    (only escapes: `\"`, `\\`, `\n`, `\t`), single line;
  - block scalar `|` or `|-` (literal: line breaks preserved) or `>` or
    `>-` (folded: paragraph lines joined with one space, each blank-line run
    collapses to one paragraph break, deeper-indented lines stay verbatim).
    `|`/`>` keep exactly one trailing newline; `|-`/`>-` strip trailing
    newlines.
- Not supported (loud errors): lists, anchors/aliases, tags, multi-document
  input, multi-line plain scalars, deeper nesting, empty values.
- Size cap: 65536 chars — the content becomes part of the steered prompt.

## Right-sidebar progress tab (Web client)

The Web client gains a **Factory** tab in the right sidebar. It lists the
nine phases with live status (pending / active / done / skipped / failed),
shows the latest `[factory] phase …` narration line verbatim, and sits quiet
with an empty state while no run is active.

- **State source**: the Host's `factory` session projection folds
  `assistant/message` session-log events, matching ONLY lines that start
  with the plugin's own narration contract
  (`[factory] phase <n>/9 <key>: <status>`), counts each `/factory`
  `command/run` into a monotonic `runCount` on the same wire view, and
  captures the run's todo list as `plan` while the run is active (the whole
  list phase 2 records; the shipped `todos` projection is cleared on every
  turn, so it cannot serve a durable view). A phase's icon comes ONLY from
  the LEAVE line's leading verdict word (`pass`/`fail`/`skip`, the v6
  contract) — an earlier substring scan misread honest prose like "no check
  now fails" as a failure. The wire view reaches the
  client through the shipped session binding
  (`sessions.binding(id).session.projections.faceOf('factory')`) — the same
  host→client shape the shipped plan-mode and goal plugins use. Because it
  is a session projection, resume and fork restore the progress view.
- **Registration** (client half, `client.js`): one tab type through
  `ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })` —
  the public two-stage path every shipped tab type uses. The `guide` entry
  is what makes the tab reachable: a page type without `patterns` opens
  only by kind, and the guide capsule (plus the strip's add control) is the
  shipped way a user opens one — picking it calls `openTab('factory')`.
  The body and chip occupants register in the keyed
  `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` seats under the
  type id. The body's `inject(sessionId)` returns a face whose
  `hooks.factoryState` value is the projection face itself — an observable
  snapshot source (`{ getSnapshot, subscribe }`) that the shipped renderer
  binds into the `useFactoryState(selector)` selector hook; the chip
  receives the framework's `useTabInfo` hook. A session without the
  projection reads as an `undefined` snapshot and renders the
  "progress unavailable" state.
- **Queue panel registration**: the global queue page registers as a
  root-scoped `main` keyed-slot entry (`ctx.slots.register({ name: 'main',
  key, locale, inject }, Page)`) addressed by the SAME id as its
  `sidebar.panellist` rail entry (`{ id, order, label }`) — the public
  two-stage path the shipped plugins/task panels use. The rail icon is the
  factory glyph at the rail's own `{ size, active }` props; the entry's
  `locale` namespace supplies the page's `t` prop. Nothing ever auto-opens
  the panel — the Factory tab's auto-open on a run start is unchanged and
  independent.
- **Auto-open**: running `/factory` opens the tab by itself. The client
  watches the on-screen session's `factory` face (via
  `ctx.sidebarRight.mounted`, the shipped on-screen-session observable) and
  calls the shipped `ctx.sidebarRight.openTab('factory')` — which also
  expands the column — when `runCount` increments live. Baselines never
  open anything, so connects, replays, and session switches stay quiet, and
  a run in a session you are not looking at is ignored (the tab shows the
  on-screen session's progress). The `autoOpenTab` plugin config (default
  on) gates the open — it travels in the projection's wire view (`autoOpen`),
  so there is no separate client-side setting.
- **Plan subpage**: the plan phase row is a button that swaps the tab body
  to a detail page listing the run's whole plan — every todo with its live
  status — followed by a back control returning to the phase list. A run
  without a recorded plan shows an explicit empty state on that page.
- **Queue panel**: the global factory queue lives in its own left-sidebar
  panel — an icon in the sidebar rail (the first plugin-contributed entry)
  opening a central page. See the next section.
- **Styling**: theme tokens only (`--dsw-alias-*`, `--dsw-radius-*`,
  `--dsw-font-mono`); React from the browser module table; no Harness
  client package is imported.
- **Localization**: the client registers two key-identical dictionaries
  with the client locale service under the `softwareFactory` namespace —
  Chinese as the source of truth and an English mirror — and the user's
  client language picks the wording.

## The factory queue

Long, unattended work runs through one **global queue** shared by every
session, executed by **worker sessions** the plugin itself starts:

```
/factory -q Build the retention pipeline      # or --queue
/factory -q --base release/1.2 Ship the port  # PR base for the worker
/factory queue                                # queue status text
/factory queue ack [id]                       # acknowledge a halt and resume
/factory queue retry <id>                     # re-queue a failed item (resumes its worker)
/factory queue rm <id>                        # remove an item (alias: remove)
```

- **Grill at enqueue**: `-q` first asks one structural batch (target
  workspace, write scopes, summary, notes) through the question composer,
  then steers an **enqueue interview** into the session — the same unbounded
  grilling as an interactive run. The interview ends with one
  `[factory] enqueue: {json}` line; the plugin's host listener turns it into
  a queue item (idempotent per session event, so replays never duplicate).
  A `--base <branch>` flag on the command flows into the interview's
  structural answers and is carried verbatim as the JSON's `"base"` field —
  the PR base for the worker's git delivery.
- **Workers are root sessions**: each item runs in its own agent session in
  the item's workspace — created with the item's model selection (see the
  next bullet; a worker without a model never runs), attached to that
  workspace so the sidebar
  groups it, titled by its leading `Factory queue <id>: <summary>` prompt
  line, with its own live Factory tab — steered with the autonomous pipeline
  prompt (the clarification answers are binding; the worker never asks). The
  worker workspace's own `.factory.yml` applies; an invalid one fails the
  item loudly.
- **Workers inherit the start session's model and mode**: at enqueue time
  the host listener snapshots the enqueuing session's effective selection —
  a pending `model/selection` event first, else the session's last request
  header (an adapter-defaulted reasoning effort is skipped), else the
  global default selection — and its current **mode** (agent preset:
  Standard, Creator, …, from the `agentPreset` session projection), and
  stores both on the queue item. Worker `agentOptions` carry that
  snapshot's provider, model, AND reasoning effort on both create and
  resume, and the worker composes under the captured preset's tool tree
  instead of always the default's, so retries and crash recovery run under
  the same selection and mode. Items written before the snapshots existed
  run on the full global default selection (effort included) and the
  default preset. The enqueue JSON line may optionally name `provider`,
  `model`, and/or `reasoningEffort` — per-field overrides of the captured
  selection (naming only the effort keeps the session's model); invalid or
  unresolvable fields are dropped leniently. If the captured model or
  preset is no longer available when the worker starts (provider removed,
  credential dropped, preset uninstalled), the worker falls back to the
  global default selection and/or default preset and the item records a
  fallback note — shown on the queue page — instead of failing. The queue
  page shows a compact `mode · provider/model · effort` chip per item; the
  `/factory queue` list output stays unchanged.
- **Scheduling**: FIFO with the `queueConcurrency` cap (default 3) and
  write-scope blocking — an item does not start while a running item's
  scopes overlap it in the same workspace (whole-workspace scopes conflict
  with everything there; different workspaces never conflict).
- **Failure halts the queue** (the configured policy): the item is marked
  failed with a reason carrying its last narration line, nothing new
  starts, and the queue page shows a halt banner until you acknowledge
  (`/factory queue ack [id]`) or **retry** — `/factory queue retry <id>` or
  the failed row's Retry button resumes the SAME worker session (its
  transcript and answers carry over) with a retry notice; the halt lifts.
- **Durability**: the queue is a JSON document under
  `$DSH_HOME/factory-queue/queue.json`, written atomically on every change
  (the rename retries briefly on Windows's transient EPERM while another
  handle holds the file open, so a concurrent reader can never drop an
  enqueue); after a restart, items left running are re-queued (their
  orphaned worker sessions stay in the sidebar) and scheduling resumes.
- **Git delivery metadata**: a succeeding worker's
  `[factory] delivery:` line settles onto the item as `delivery`
  (`{branch, pr, note}`); the queue panel renders the branch name, a PR
  link to the recorded URL, and the degradation note for push-only runs,
  and `/factory queue` prints `branch <name>, PR <url>` on the item line.
  Items enqueued before this existed simply carry no delivery.
- **Queue UI**: a global left-sidebar panel (an icon in the sidebar rail —
  the factory glyph, always present — opening a central page; it is never
  auto-opened) polls the plugin's same-origin route
  `/plugins/@local/dsh-software-factory/queue.json` every 2s ONLY while the
  panel is open (no badge, no background traffic) and lists every item —
  status, scopes, failure reason, an Open button jumping to the worker
  session, a Retry button on failed rows, and a Remove button on every row
  (the CLI equivalent is `/factory queue rm <id>`) — under a one-line stats
  strip (`2/3 running · 5 queued · 1 failed`) computed from the route's
  `stats` fields (per-status counts plus running-vs-cap). A **Clean**
  control behind a two-step inline confirm (arm → Confirm) sweeps the
  finished rows — succeeded AND failed, never queued/running — removing
  queue rows only (worker sessions stay), which also lifts a halt caused
  by a swept failure; it reuses the per-item remove action, so an enqueue
  racing the sweep simply lands between two removes. Item ids (`q1`,
  `q2`, …) are never renumbered: removing rows keeps the survivors' ids,
  and numbering restarts at `q1` only when a removal empties the queue
  (the Clean sweep lands there too) — a live row surviving a sweep
  correctly keeps the counter going. Clean is panel-only: there is no CLI
  clean command. GET is the read model; the
  ack/retry actions POST with a custom `x-dsh-factory-action` header (a
  non-simple header forces a CORS preflight this host never answers, so
  other origins cannot forge a POST). Worker verdicts come from each
  worker's own `factory` projection board, read host-side — no new status
  channel: a run succeeds when no phase failed and its final phase reached
  a terminal verdict — `done`, or `skipped` (a workspace whose
  `.factory.yml` disables the trailing phases legitimately ends its board
  with the phase-9 `skip (disabled by configuration)` leave line).

## Design notes

- **Command registration**: `ctx.commands.register({ name: 'factory',
  description, input: { hint: '[-q|--queue] [--base <branch>] <request> | queue [ack [id]]', attachments: true },
  recordInput: false, handler })` — the `@deepseek-ai/dsh-commands`
  contract. `recordInput: false` because the steered pipeline message already
  carries the request verbatim in the session log. The handler is async
  (the registry awaits its result) so it can read `.factory.yml` first.
- **Workspace root + file read**: `agent.session.header.cwd ?? process.cwd()`
  for the root, then the optional `fs` service
  (`resolve(name, { cwd, signal })` → `stat` → `readText`) with a `node:fs`
  fallback — the exact pattern the shipped `dsh-agent-instructions` uses for
  instruction files. The command's abort signal is honored throughout.
- **Submission**: `agent.steer(userMessage)` — inserts the message for the
  next step and wakes the driver. The message is built locally in the exact
  shape of dsh-llm's `createUserMessage` (`{ role, content, source: { kind:
  'user' }, id }`, deep-frozen); the identity brand is a compile-time no-op,
  so the bundle carries zero runtime dependencies.
- **Optional service**: the command is registered inside
  `ctx.inject(['commands'], ...)`, so the plugin stays dormant in profiles
  without the command surface instead of throwing. The `fs` service is a
  dynamic `ctx.get('fs')` lookup (also the agent-instructions pattern), not a
  static injection, so it remains an optimization path only.
- **YAML subset**: `.factory.yml` is parsed by an in-module strict parser
  (`parseFactoryYml`, exported for reuse/testing) documented above; no YAML
  dependency. Invalid input is a named-file, named-line error, and the
  command refuses to start the pipeline rather than silently ignoring the
  file.
- **Config schema**: `export const Config` implements the Standard Schema
  `~standard.validate` protocol that Cordis `resolveConfig` calls. Being
  vendor-unknown, Settings surfaces that project known schema vendors will
  not render a live form for it; configure via the patch row (above).
- **No plugin-owned pipeline state**: the steered message, tool calls, and
  results all live in the session log, so fork/resume/replay reconstruct a
  run. A per-phase `factory/phase` process event was considered and
  deliberately skipped: the plugin cannot observe model-side phase
  transitions cheaply (the agent emits the status lines), and no consumer
  exists in v1.
- **Progress observability**: the `factory` session projection (registered
  through the optional `sessionProjections` service) folds
  `assistant/message` events against the narration contract only, so tool
  output echoing the prompt can never be misparsed. Its state and wire
  schemas are dependency-free `{ parse }` facades — the registry only calls
  `schema.parse(...)`. Fold semantics: entering phase n closes earlier open
  phases as done; a LEAVE line's leading verdict word alone decides its
  status (`fail`/`failed` → failed, `skip`/`skipped` → skipped, otherwise
  `done` when the line is phase 9's or the word is `pass`/`passed`/`done`;
  anything else stays active — the v6 contract); the run settles when
  phase 9 reaches a terminal status; a later phase-1 line starts a fresh
  run; `command/run` events naming this
  command bump the monotonic `runCount` (the auto-open signal), the wire
  view carries the row config's `autoOpenTab` switch as `autoOpen` so the
  client honors the same declarative configuration, `todo/write`
  snapshots fold into the durable `plan` while a run is active (v5; the
  shipped `todos` projection is turn-scoped), and the
  `[factory] delivery: {json}` line folds the git-delivery outcome
  (`{branch, pr, note}`) for the queue's read side (v7).
- **Locale**: `locale/en.json` + `locale/zh.json` carry the Plugin Manager
  title/description; `icon.svg` is the card icon; the client tab registers
  its own `softwareFactory` dictionary with the client locale service.

## Repository layout

The Host half is split into one domain module per file under `lib/`; the
entry (`index.js`) only wires them together. The Web half must stay one
self-contained bundle file (the client-modules contract makes a plugin
bundle a single module node whose imports may only be module-table leaves),
organized internally by section.

```
package.json        manifest: @local/dsh-software-factory, dsh.bundle.patch + dsh.client
cordis.patch.yml    insert row `software-factory`
index.js            Host half entry: re-exports Config + parser, wires the
                    command, projection, queue (store + runtime + route), and
                    the enqueue listener fibers
lib/phases.js       pipeline identity: ordered phases, statuses, status/delivery line patterns
lib/config.js       plugin row Config (~standard facade, unknown-key rejection, deploy gate)
lib/projection.js   `factory` session projection: fold, schema facades, wire view
lib/project-file.js `.factory.yml` parser + workspace-root reader + override merge
lib/prompt.js       pipeline prompt builder (grill / autonomous / default modes)
lib/command.js      dsh-commands definition + steered message + enqueue directive
lib/queue.js        global durable queue store (scope blocking, cap, halt/ack)
lib/selection.js    worker model-selection capture, JSON overrides, availability
lib/orchestrator.js queue runtime: worker sessions + verdicts + status text
client.js           Web half: right-sidebar Factory tab + left-sidebar queue panel
locale/en.json      display metadata (English)
locale/zh.json      display metadata (Chinese)
icon.svg            plugin icon
README.md           this file
AGENTS.md           agent conventions for this repository
test/               behavioral suite (npm test): smoke.mjs + prompt-equivalence.mjs
```
