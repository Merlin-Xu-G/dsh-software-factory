/**
 * The `factory` session projection: the pure fold that derives pipeline
 * progress from the session log, and the definition registered through the
 * optional `sessionProjections` service. The registry only calls
 * `schema.parse(...)` on state and wire values, so the schemas here are
 * dependency-free `{ parse }` facades (the same trick as `Config`'s
 * `~standard`, one protocol level up). The wire view reaches the Web client
 * through the shipped session binding (`projections.faceOf('factory')`) —
 * the exact host→client shape plan-mode and goal use — and carries the
 * board (running / runCount / autoOpen / phases / lastLine) plus the run's
 * captured `plan` (the whole todo list recorded during phase 2).
 */
import { PHASES, PHASE_STATUSES, STATUS_LINE_PATTERN } from './phases.js';

/**
 * The session-projection key whose wire view the Web client's right-sidebar
 * tab reads (`sessions.binding(id).session.projections.faceOf('factory')`).
 */
export const FACTORY_PROJECTION_KEY = 'factory';

/** Todo item statuses the captured plan may carry (the todo tool's union). */
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);

/**
 * Build the initial projection state: nine pending phases, no run, no plan.
 * @returns {{running: boolean, phases: {n: number, key: string,
 *   status: string, text: string | null}[], lastLine: string | null}}
 */
function emptyProjectionState() {
  return {
    running: false,
    /** Monotonic count of `/factory` command runs in the log (auto-open signal). */
    runCount: 0,
    /**
     * The run's whole plan: the latest `todo/write` list folded while the run
     * was active (phase 2 records the plan there). Null until phase 2 writes.
     */
    plan: null,
    phases: PHASES.map((phase, index) => ({
      n: index + 1,
      key: phase.key,
      status: 'pending',
      text: null,
    })),
    lastLine: null,
  };
}

/**
 * Fold one narration line into a fresh state (or the same reference when
 * nothing changes). Deterministic and clock-free: replay-safe.
 * @param {ReturnType<emptyProjectionState>} state current state.
 * @param {number} n phase number from the line (1-9).
 * @param {string} key phase key from the line.
 * @param {string} text status text after the colon.
 * @param {string} rawLine the full verbatim line.
 * @returns {ReturnType<emptyProjectionState>} next state.
 */
function foldStatusLine(state, n, key, text, rawLine) {
  if (PHASES[n - 1].key !== key) return state;
  let phases = state.phases.map((phase) => ({ ...phase }));
  // A phase-1 line always opens a run: reset every stale phase unless the
  // board is already pristine (the first line ever, or right after a reset).
  // Gating on `!state.running` would miss a board abandoned mid-run by a
  // failure (only a phase-8 line settles `running`), whose stale rows would
  // then survive into the next run — the done-closure below never rewrites
  // a `failed` phase.
  if (n === 1 && phases[0].status !== 'pending') {
    phases = emptyProjectionState().phases;
    // A fresh run has no plan until its phase 2 writes one.
    state = { ...state, plan: null };
  }
  // Progression: entering phase n closes every earlier open phase as done.
  for (let i = 0; i < n - 1; i += 1) {
    if (phases[i].status === 'active' || phases[i].status === 'pending') {
      phases[i] = { ...phases[i], status: 'done' };
    }
  }
  // v6 verdict-token contract: a LEAVE line's status must BEGIN with a
  // verdict word (pass/fail/skip); only that first word decides the phase
  // status, so honest prose after it ("no previously passing check now
  // fails", "one transient failure — resolved") can never flip the board's
  // icon. Enter lines carry no verdict token and stay active until a later
  // phase line closes them as done.
  const verdict = /^[a-z]+/.exec(text.toLowerCase())?.[0] ?? '';
  const status = (verdict === 'fail' || verdict === 'failed')
    ? 'failed'
    : (verdict === 'skip' || verdict === 'skipped')
      ? 'skipped'
      : n === PHASES.length || verdict === 'pass' || verdict === 'passed' || verdict === 'done'
        ? 'done'
        : 'active';
  phases[n - 1] = { ...phases[n - 1], status, text };
  const final = phases[PHASES.length - 1].status;
  return {
    running: final !== 'done' && final !== 'failed' && final !== 'skipped',
    runCount: state.runCount,
    plan: state.plan,
    phases,
    lastLine: rawLine,
  };
}

/** Assert-and-return the projection state shape (a `.parse` facade body). */
function validateProjectionState(input) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('factory projection state must be an object');
  }
  if (typeof input.running !== 'boolean') throw new Error('factory projection state "running" must be a boolean');
  if (!Number.isSafeInteger(input.runCount) || input.runCount < 0) {
    throw new Error('factory projection state "runCount" must be a non-negative integer');
  }
  if (!Array.isArray(input.phases) || input.phases.length !== PHASES.length) {
    throw new Error(`factory projection state "phases" must be an array of ${PHASES.length} entries`);
  }
  input.phases.forEach((phase, index) => {
    if (typeof phase !== 'object' || phase === null) throw new Error(`factory projection phase ${index + 1} must be an object`);
    if (phase.n !== index + 1 || phase.key !== PHASES[index].key) {
      throw new Error(`factory projection phase ${index + 1} identity mismatch`);
    }
    if (!PHASE_STATUSES.has(phase.status)) throw new Error(`factory projection phase ${index + 1} has unknown status "${String(phase.status)}"`);
    if (phase.text !== null && typeof phase.text !== 'string') throw new Error(`factory projection phase ${index + 1} text must be a string or null`);
  });
  if (input.lastLine !== null && typeof input.lastLine !== 'string') {
    throw new Error('factory projection state "lastLine" must be a string or null');
  }
  if (input.plan !== null) {
    if (!Array.isArray(input.plan)) throw new Error('factory projection state "plan" must be null or an array');
    input.plan.forEach((item, index) => {
      if (typeof item !== 'object' || item === null
        || typeof item.content !== 'string'
        || !TODO_STATUSES.has(item.status)) {
        throw new Error(`factory projection plan item ${index + 1} must be { content, status } with a todo status`);
      }
    });
  }
  return input;
}

/** Assert-and-return the projection wire view: the state shape plus `autoOpen`. */
function validateWireView(input) {
  const state = validateProjectionState(input);
  if (typeof input.autoOpen !== 'boolean') {
    throw new Error('factory projection wire view "autoOpen" must be a boolean');
  }
  return state;
}

/**
 * Build the factory progress projection definition. The wire view carries the
 * row config's `autoOpenTab` switch (default on) so the client's auto-open
 * honors the same declarative configuration; it is a view-time constant, not
 * folded state, so no stateVersion bump.
 * @param {boolean} autoOpenTab whether the Web client auto-opens its tab on a run start.
 * @returns {object} the projection definition to register.
 */
export function buildFactoryProjectionDefinition(autoOpenTab) {
  return {
    key: FACTORY_PROJECTION_KEY,
    // v6: verdict-token narration contract — a LEAVE line's status begins
    // with pass/fail/skip and only that first word folds a failure/skip (the
    // v5 substring scan misread honest prose like "no check now fails").
    // v5: the state captures the run's plan — the latest `todo/write` list
    // folded while the run is active (the shipped `todos` projection is
    // cleared on every turn/start, so it cannot serve a durable view). v4:
    // nine-phase identity — `review` inserted between implement and
    // guardrails, so every phase number from 4 on shifted and the narration
    // contract reads `<n>/9` (old `/8` lines no longer match, so boards of
    // past runs fold as pristine). v3 added the `runCount` command-run
    // counter; v2 made a phase-1 line reset the board unconditionally.
    stateVersion: 6,
    stateSchema: { parse: validateProjectionState },
    init: () => emptyProjectionState(),
    apply: (state, event) => {
      // A `/factory` invocation (dsh-commands logs `{ commandId, name, source }`
      // before the handler runs; `args` is absent because recordInput is false).
      if (event.type === 'command/run' && event.data?.name === 'factory') {
        return { ...state, runCount: state.runCount + 1 };
      }
      // The plan: capture the whole todo list while a run is active. After
      // the run settles, unrelated todo writes (a later plain turn) must not
      // overwrite the finished run's plan.
      if (event.type === 'todo/write' && state.running === true && Array.isArray(event.data?.todos)) {
        return {
          ...state,
          plan: event.data.todos.map((item) => ({ content: item.content, status: item.status })),
        };
      }
      if (event.type !== 'assistant/message') return state;
      const content = event.data?.message?.content;
      if (!Array.isArray(content)) return state;
      const text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
      let next = state;
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        const match = STATUS_LINE_PATTERN.exec(trimmed);
        if (!match) continue;
        next = foldStatusLine(next, Number(match[1]), match[2], match[3], trimmed);
      }
      return next;
    },
    wire: {
      viewSchema: { parse: validateWireView },
      view: (state) => ({
        running: state.running,
        runCount: state.runCount,
        autoOpen: autoOpenTab,
        plan: state.plan === null ? null : state.plan.map((item) => ({ ...item })),
        phases: state.phases.map((phase) => ({ ...phase })),
        lastLine: state.lastLine,
      }),
    },
  };
}
