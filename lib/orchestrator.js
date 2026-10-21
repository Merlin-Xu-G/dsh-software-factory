/**
 * The queue runtime: schedules queued items onto worker sessions and settles
 * their outcomes. A worker is a ROOT agent session created through the host
 * `agents` service in the item's workspace (visible in the sidebar, titled
 * by its leading `Factory queue: …` prompt line), steered with the
 * autonomous pipeline prompt, and awaited with `whenIdle()`. The outcome is
 * read from the worker's own `factory` projection state host-side — the
 * board this plugin already maintains — so no new status channel exists.
 * A failure halts the queue (the user's policy); acknowledging resumes it.
 */
import { randomUUID } from 'node:crypto';
import { buildPipelinePrompt } from './prompt.js';
import { createPipelineMessage } from './command.js';
import { applyProjectOverrides, loadProjectOverrides } from './project-file.js';

/**
 * Read a worker run's verdict from its session's factory projection state.
 * @param {object | undefined} state the `factory` projection state.
 * @returns {{ok: boolean, reason: string}} the verdict.
 */
function workerVerdict(state) {
  if (state === undefined || state === null || !Array.isArray(state.phases)) {
    return { ok: false, reason: 'no factory progress was recorded for the worker run' };
  }
  const failed = state.phases.find((phase) => phase.status === 'failed');
  if (failed !== undefined) {
    return { ok: false, reason: `phase ${failed.n}/9 ${failed.key} failed${failed.text ? `: ${failed.text}` : ''}` };
  }
  const final = state.phases[state.phases.length - 1];
  if (final === undefined || final.status !== 'done') {
    return { ok: false, reason: 'the worker settled before completing phase 9/9' };
  }
  return { ok: true, reason: 'phases complete' };
}

/**
 * Resolve the effective config for one worker: the plugin row Config merged
 * with the worker workspace's own `.factory.yml`, exactly like an
 * interactive run there. An invalid file fails the item loudly.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {ReturnType<import('./config.js').resolveConfig>} resolved
 * @param {string} workspace the item's workspace root.
 * @returns {Promise<object>} the effective config.
 */
async function effectiveWorkerConfig(ctx, resolved, workspace) {
  const agent = { session: { header: { cwd: workspace } } };
  const project = await loadProjectOverrides(ctx, agent, undefined);
  return applyProjectOverrides(resolved, project);
}

/**
 * Create the queue runtime.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context (the
 *   optional `agents` and `sessionProjections` services are read
 *   dynamically).
 * @param {ReturnType<import('./config.js').resolveConfig>} resolved
 *   effective plugin config.
 * @param {ReturnType<import('./queue.js').createQueueStore>} store the queue store.
 * @returns {object} the runtime API: `enqueueAndPump`, `pump`, `ack`,
 *   `statusText`.
 */
export function createQueueRuntime(ctx, resolved, store) {
  let pumping = false;
  let pumpAgain = false;

  /** Serialized pump: start every eligible item, then stop. */
  async function pump() {
    if (pumping) { pumpAgain = true; return; }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        const agents = ctx.get('agents');
        if (agents === undefined) return; // no agent surface: items stay queued
        for (;;) {
          const item = await store.pickNext(resolved.queueConcurrency);
          if (item === null) break;
          const sessionId = randomUUID();
          const claimed = await store.markRunning(item.id, sessionId);
          if (!claimed) continue; // lost a race (halted or already picked)
          try {
            const handle = await agents.create({ sessionId, meta: { cwd: item.workspace } });
            const agent = handle.agent;
            let effective = resolved;
            try {
              effective = await effectiveWorkerConfig(ctx, resolved, item.workspace);
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              await store.markFailed(item.id, `invalid .factory.yml in the worker workspace: ${reason}`);
              continue;
            }
            agent.followup(createPipelineMessage([
              { type: 'text', text: buildPipelinePrompt(effective, item.request, {
                autonomous: true,
                clarifications: item.clarifications,
                titleHint: `Factory queue ${item.id}: ${item.summary}`,
              }) },
            ]));
            watchWorker(item.id, agent);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            await store.markFailed(item.id, `worker session could not start: ${reason}`);
          }
        }
      } while (pumpAgain);
    } finally {
      pumping = false;
    }
  }

  /**
   * Await one running worker's idle transition and settle its item.
   * Fire-and-forget by design: many workers run concurrently.
   */
  function watchWorker(id, agent) {
    void (async () => {
      try {
        await agent.whenIdle();
      } catch {
        // The agent crashed or was disposed; treat as failure below.
      }
      try {
        const state = ctx.get('sessionProjections')?.stateOf(agent.session, 'factory');
        const verdict = workerVerdict(state);
        if (verdict.ok) await store.markSucceeded(id);
        else await store.markFailed(id, verdict.reason);
      } catch (error) {
        await store.markFailed(id, `outcome could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      await pump();
    })();
  }

  return {
    /**
     * Enqueue one fully-specified item and start scheduling.
     * @param {{request: string, summary?: string, scopes?: readonly string[],
     *   workspace: string, clarifications?: readonly {question: string, answer: string}[],
     *   sourceEvent?: string | null}} input
     * @returns {Promise<object>} the created queue item.
     */
    async enqueueAndPump(input) {
      const item = await store.enqueue(input);
      await pump();
      return item;
    },
    pump,
    /**
     * Acknowledge a halt (optionally naming the failed item).
     * @param {string | undefined} id
     * @returns {Promise<boolean>} whether a halt was cleared.
     */
    async ack(id) {
      const cleared = await store.ack(id);
      if (cleared) await pump();
      return cleared;
    },
    /** Human-readable queue status for the `/factory queue` command. */
    async statusText() {
      const queue = await store.snapshot();
      if (queue.items.length === 0) return 'Factory queue is empty.';
      const lines = queue.items.map((item) => {
        const where = item.workerSessionId ? ` (worker ${item.workerSessionId.slice(0, 8)})` : '';
        const reason = item.status === 'failed' && item.failureReason ? ` — ${item.failureReason}` : '';
        return `- [${item.id}] ${item.status}${where}: ${item.summary}${reason}`;
      });
      const halted = queue.halted
        ? `\nHALTED by a failure${queue.haltedBy ? ` (${queue.haltedBy})` : ''} — run /factory queue ack to resume.`
        : '';
      return `Factory queue (concurrency ${resolved.queueConcurrency}):${halted}\n${lines.join('\n')}`;
    },
  };
}
