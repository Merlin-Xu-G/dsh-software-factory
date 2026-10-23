/**
 * The global factory queue: one durable, host-owned queue shared by every
 * session. State is a plain JSON document under the DSH home
 * (`$DSH_HOME/factory-queue/queue.json`, atomically written), so the queue
 * survives restarts; on load, items left `running` by a dead process are
 * re-queued (their orphaned worker sessions remain in the sidebar).
 *
 * Scheduling rules (the user's grilled decisions): FIFO order, a
 * configurable concurrency cap, and write-scope blocking — an item does not
 * START while a running item's scopes overlap it in the same workspace. Any
 * failure HALTS the queue until acknowledged; acknowledgement keeps the
 * failed item failed and frees the rest. Removing rows only ever drops
 * them (survivors keep their ids), and the moment zero rows remain the
 * counter resets, so the next enqueue is q1 again.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeSelection } from './selection.js';

/** Normalize an item's captured agent-preset (mode) id. */
function normalizePreset(raw) {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

/**
 * Normalize one item's git-delivery outcome (the worker's
 * `[factory] delivery:` line, settled onto the item at success): every
 * field a non-empty string or null; anything else is null. `null` delivery
 * means the run recorded none (pre-upgrade items, failed runs, non-git
 * workspaces that never emitted the line).
 * @param {unknown} raw
 * @returns {{branch: string | null, pr: string | null, note: string | null} | null}
 */
export function normalizeDelivery(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const pick = (value) => (typeof value === 'string' && value.trim() !== '' ? value : null);
  const delivery = { branch: pick(raw.branch), pr: pick(raw.pr), note: pick(raw.note) };
  return delivery.branch === null && delivery.pr === null && delivery.note === null ? null : delivery;
}

/** Item statuses the queue tracks. */
export const QUEUE_ITEM_STATUSES = ['queued', 'running', 'succeeded', 'failed'];

/**
 * Resolve the queue directory: non-blank `$DSH_HOME` env override, else
 * `~/.dsh` (the shipped dsh-home-paths rule). No machine-specific paths in
 * tracked files — resolution is runtime-only.
 * @returns {string} absolute queue directory.
 */
export function resolveQueueDir(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'factory-queue');
}

/**
 * Normalize one write scope for conflict comparison: lowercase, forward
 * slashes, no trailing slash. Empty string means "the whole workspace".
 * @param {string} scope
 * @returns {string}
 */
function normalizeScope(scope) {
  return String(scope).replaceAll('\\', '/').replace(/\/+$/, '').trim().toLowerCase();
}

/**
 * Whether two scopes conflict (overlap) within the same workspace: either
 * covers the whole workspace, they are equal, or one contains the other as a
 * path prefix.
 * @param {string} left normalized scope.
 * @param {string} right normalized scope.
 * @returns {boolean}
 */
function scopesConflict(left, right) {
  if (left === '' || right === '') return true;
  if (left === right) return true;
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Whether a queued item may start now: the queue is not halted, the
 * concurrency cap has room, and no running item's scopes conflict with it
 * (scopes never conflict across different workspaces).
 * @param {object} queue the queue state.
 * @param {{workspace: string, scopes: readonly string[]}} item the candidate.
 * @param {number} concurrency the configured cap.
 * @returns {boolean}
 */
export function eligibleToStart(queue, item, concurrency) {
  if (queue.halted) return false;
  if (queue.items.filter((candidate) => candidate.status === 'running').length >= concurrency) {
    return false;
  }
  const normalized = item.scopes.map(normalizeScope);
  return !queue.items.some((candidate) => {
    if (candidate.status !== 'running' || candidate.workspace !== item.workspace) return false;
    return candidate.scopes
      .map(normalizeScope)
      .some((scope) => normalized.some((mine) => scopesConflict(mine, scope)));
  });
}

/**
 * Validate and normalize one queue item from untrusted input.
 * @param {unknown} raw
 * @returns {{id: string, summary: string, request: string,
 *   clarifications: {question: string, answer: string}[], scopes: string[],
 *   workspace: string, status: string, workerSessionId: string | null,
 *   enqueuedAt: string, startedAt: string | null, endedAt: string | null,
 *   failureReason: string | null, sourceEvent: string | null,
 *   selection: {provider: string, model: string, reasoningEffort?: string} | null,
 *   agentPreset: string | null, modelNote: string | null,
 *   base: string | null, delivery: {branch: string | null,
 *   pr: string | null, note: string | null} | null}}
 */
function normalizeItem(raw) {
  if (typeof raw !== 'object' || raw === null) throw new Error('queue item must be an object');
  const scopes = Array.isArray(raw.scopes)
    ? raw.scopes.filter((scope) => typeof scope === 'string' && scope.trim() !== '')
    : [];
  const clarifications = Array.isArray(raw.clarifications)
    ? raw.clarifications
      .filter((item) => typeof item?.question === 'string' && typeof item?.answer === 'string'
        && item.question.trim() !== '' && item.answer.trim() !== '')
      .map(({ question, answer }) => ({ question: question.trim(), answer: answer.trim() }))
    : [];
  const status = QUEUE_ITEM_STATUSES.includes(raw.status) ? raw.status : 'queued';
  if (typeof raw.request !== 'string' || raw.request.trim() === '') {
    throw new Error('queue item "request" must be a non-empty string');
  }
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : randomUUID(),
    summary: typeof raw.summary === 'string' && raw.summary.trim() !== ''
      ? raw.summary.trim()
      : `${raw.request.trim().slice(0, 60)}${raw.request.trim().length > 60 ? '…' : ''}`,
    request: raw.request.trim(),
    clarifications,
    scopes,
    workspace: typeof raw.workspace === 'string' && raw.workspace.trim() !== ''
      ? raw.workspace.trim()
      : process.cwd(),
    status,
    workerSessionId: typeof raw.workerSessionId === 'string' ? raw.workerSessionId : null,
    enqueuedAt: typeof raw.enqueuedAt === 'string' ? raw.enqueuedAt : new Date().toISOString(),
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
    endedAt: typeof raw.endedAt === 'string' ? raw.endedAt : null,
    failureReason: typeof raw.failureReason === 'string' ? raw.failureReason : null,
    sourceEvent: typeof raw.sourceEvent === 'string' ? raw.sourceEvent : null,
    // The enqueue-time model-selection snapshot (provider/model/effort) the
    // worker runs under; null on legacy items written before it existed.
    selection: normalizeSelection(raw.selection),
    // The start session's mode (agent preset id) the worker runs under;
    // null on legacy items runs the default preset.
    agentPreset: normalizePreset(raw.agentPreset),
    modelNote: typeof raw.modelNote === 'string' && raw.modelNote !== '' ? raw.modelNote : null,
    // The PR base branch the worker's git delivery targets (--base flag /
    // enqueue JSON "base"); null means the default rule (main, falling back
    // to the remote default branch) applies.
    base: typeof raw.base === 'string' && raw.base.trim() !== '' ? raw.base.trim() : null,
    // The run's git-delivery outcome (branch / PR URL / degradation note),
    // recorded when the worker succeeds; null on items that never delivered.
    delivery: normalizeDelivery(raw.delivery),
  };
}

/** Validate and normalize the persisted queue document. */
function normalizeQueue(raw) {
  const base = typeof raw === 'object' && raw !== null ? raw : {};
  const items = Array.isArray(base.items) ? base.items.map(normalizeItem) : [];
  const failed = items.find((item) => item.status === 'failed' && base.halted);
  return {
    halted: base.halted === true,
    haltedBy: failed ? failed.id : null,
    nextId: Number.isSafeInteger(base.nextId) && base.nextId > 0 ? base.nextId : items.length + 1,
    items,
  };
}

/**
 * Create the queue store bound to one directory. Loading is lazy and every
 * mutation persists before it returns, so a crash never loses an enqueue.
 * @param {{dir?: string}} options overrides for tests.
 * @returns {object} the store API.
 */
export function createQueueStore(options = {}) {
  const dir = options.dir ?? resolveQueueDir();
  const file = join(dir, 'queue.json');
  let state = null;
  let loading = null;
  // Mutations serialize through this chain: two concurrent transitions
  // (the pump's markRunning and a watcher's settlement, say) would otherwise
  // race their atomic writes through the SAME tmp path and one rename would
  // fail with ENOENT, killing a whole pump loop.
  let writeChain = Promise.resolve();

  /** Load (once) and crash-recover: items left running re-queue. */
  async function ensureLoaded() {
    if (state !== null) return state;
    if (loading === null) {
      loading = (async () => {
        let raw;
        try {
          raw = JSON.parse(await readFile(file, 'utf8'));
        } catch (error) {
          if (error && typeof error === 'object' && error.code === 'ENOENT') raw = {};
          else throw error;
        }
        const loaded = normalizeQueue(raw);
        let recovered = false;
        for (const item of loaded.items) {
          if (item.status === 'running') {
            item.status = 'queued';
            item.workerSessionId = null;
            item.startedAt = null;
            recovered = true;
          }
        }
        state = loaded;
        if (recovered) await persist();
        return state;
      })();
    }
    return loading;
  }

  async function persist() {
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    // Windows: renaming over queue.json can transiently fail with EPERM
    // while another handle holds the destination open (a concurrent reader,
    // a backup, an antivirus scan). A microsecond-level overlap must never
    // drop an enqueue — retry the rename briefly before giving up.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tmp, file);
        return;
      } catch (error) {
        if (!(error && typeof error === 'object' && error.code === 'EPERM') || attempt >= 9) {
          throw error;
        }
        await new Promise((resolve) => { setTimeout(resolve, 10 + attempt * 10); });
      }
    }
  }

  /** Apply one mutation atomically: clone, mutate, persist — serialized. */
  async function mutate(fn) {
    const run = writeChain.then(async () => {
      const current = await ensureLoaded();
      const next = normalizeQueue(JSON.parse(JSON.stringify(current)));
      const result = fn(next);
      state = next;
      await persist();
      return result;
    });
    writeChain = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    /** Full queue snapshot (deep copy). */
    async snapshot() {
      return JSON.parse(JSON.stringify(await ensureLoaded()));
    },
    /**
     * Enqueue one request.
     * @param {{request: string, summary?: string, scopes?: readonly string[],
     *   workspace: string, clarifications?: readonly {question: string, answer: string}[],
     *   base?: string, sourceEvent?: string | null}} input
     * @returns {Promise<object>} the created item.
     */
    async enqueue(input) {
      return mutate((queue) => {
        const item = normalizeItem({ ...input, status: 'queued', id: `q${queue.nextId}` });
        queue.nextId += 1;
        queue.items.push(item);
        return JSON.parse(JSON.stringify(item));
      });
    },
    /** Whether an enqueue from this source event was already recorded. */
    async hasSourceEvent(sourceEvent) {
      const queue = await ensureLoaded();
      return queue.items.some((item) => item.sourceEvent === sourceEvent);
    },
    /** First queued item eligible to start under the cap and scope rules. */
    async pickNext(concurrency) {
      const queue = await ensureLoaded();
      const candidate = queue.items.find((item) => item.status === 'queued'
        && eligibleToStart(queue, item, concurrency));
      return candidate === undefined ? null : JSON.parse(JSON.stringify(candidate));
    },
    /** Count of currently running items. */
    async runningCount() {
      const queue = await ensureLoaded();
      return queue.items.filter((item) => item.status === 'running').length;
    },
    /** Mark an item running under its worker session. */
    async markRunning(id, workerSessionId) {
      return mutate((queue) => {
        const item = queue.items.find((candidate) => candidate.id === id);
        if (item === undefined || item.status !== 'queued') return false;
        item.status = 'running';
        item.workerSessionId = workerSessionId;
        item.startedAt = new Date().toISOString();
        return true;
      });
    },
    /**
     * Mark an item succeeded, recording its git-delivery outcome (the
     * worker's `[factory] delivery:` line: branch / PR URL / degradation
     * note — null when the run emitted none).
     * @param {string} id
     * @param {{branch?: string | null, pr?: string | null,
     *   note?: string | null} | null} [delivery]
     * @returns {Promise<boolean>} whether the item transitioned.
     */
    async markSucceeded(id, delivery = null) {
      return mutate((queue) => {
        const item = queue.items.find((candidate) => candidate.id === id);
        if (item === undefined || item.status !== 'running') return false;
        item.status = 'succeeded';
        item.endedAt = new Date().toISOString();
        item.delivery = normalizeDelivery(delivery);
        return true;
      });
    },
    /**
     * Mark an item failed and HALT the queue (the user's failure policy).
     * @returns {Promise<boolean>} whether the item transitioned.
     */
    async markFailed(id, reason) {
      return mutate((queue) => {
        const item = queue.items.find((candidate) => candidate.id === id);
        if (item === undefined || item.status !== 'running') return false;
        item.status = 'failed';
        item.endedAt = new Date().toISOString();
        item.failureReason = typeof reason === 'string' && reason !== '' ? reason : 'worker run failed';
        queue.halted = true;
        queue.haltedBy = item.id;
        return true;
      });
    },
    /**
     * Acknowledge the halt: the failed item stays failed; the queue resumes.
     * @returns {Promise<boolean>} whether a halt was cleared.
     */
    async ack(id) {
      return mutate((queue) => {
        if (!queue.halted) return false;
        if (typeof id === 'string' && id !== '' && queue.haltedBy !== id
          && !queue.items.some((item) => item.id === id && item.status === 'failed')) {
          return false;
        }
        queue.halted = false;
        queue.haltedBy = null;
        return true;
      });
    },
    /**
     * Re-queue a failed item for another attempt: its worker session id is
     * RETAINED (the retry resumes that same worker), the failure is cleared,
     * and a halt this item caused is lifted. Only failed items can retry.
     * @returns {Promise<boolean>} whether the item transitioned.
     */
    async retry(id) {
      return mutate((queue) => {
        const item = queue.items.find((candidate) => candidate.id === id);
        if (item === undefined || item.status !== 'failed') return false;
        item.status = 'queued';
        item.failureReason = null;
        item.startedAt = null;
        item.endedAt = null;
        if (queue.halted && queue.haltedBy === item.id) {
          queue.halted = false;
          queue.haltedBy = null;
        }
        return true;
      });
    },
    /**
     * Remove one item from the queue entirely (any status; the runtime
     * cancels a still-running worker first). A halt this item caused lifts.
     * Emptying the queue resets `nextId` to 1, so item numbering restarts
     * at q1 on the next enqueue — the panel's Clean sweep lands here too,
     * because it reuses this remove action per swept row. Surviving rows
     * are never renumbered, and an enqueue racing a sweep simply lands
     * between two removes (the queue is non-empty again, so no reset
     * fires — ids can never collide).
     * @param {string} id
     * @returns {Promise<boolean>} whether the item was removed.
     */
    async remove(id) {
      return mutate((queue) => {
        const index = queue.items.findIndex((candidate) => candidate.id === id);
        if (index === -1) return false;
        queue.items.splice(index, 1);
        if (queue.halted && queue.haltedBy === id) {
          queue.halted = false;
          queue.haltedBy = null;
        }
        // The queue just emptied: numbering restarts at q1.
        if (queue.items.length === 0) queue.nextId = 1;
        return true;
      });
    },
    /**
     * Record (or clear) the model-fallback note shown on the queue page —
     * set when a worker could not run on its snapshot selection and fell
     * back to the global default selection.
     * @param {string} id
     * @param {string | null} note
     * @returns {Promise<boolean>} whether the item exists.
     */
    async setModelNote(id, note) {
      return mutate((queue) => {
        const item = queue.items.find((candidate) => candidate.id === id);
        if (item === undefined) return false;
        item.modelNote = typeof note === 'string' && note !== '' ? note : null;
        return true;
      });
    },
    /** Find one item by id. */
    async find(id) {
      const queue = await ensureLoaded();
      const item = queue.items.find((candidate) => candidate.id === id);
      return item === undefined ? null : JSON.parse(JSON.stringify(item));
    },
  };
}
