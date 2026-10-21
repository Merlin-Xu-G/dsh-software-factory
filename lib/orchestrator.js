/**
 * The queue runtime: schedules queued items onto worker sessions and settles
 * their outcomes. A worker is a ROOT agent session created through the host
 * `agents` service in the item's workspace — with the default model
 * selection as `agentOptions` (every shipped creation site passes it; a
 * worker without a model never runs its turn) and attached to its workspace
 * so the sidebar groups it — steered with the autonomous pipeline prompt,
 * and awaited with `whenIdle()` (once BEFORE the prompt, so a non-driving
 * creation settles immediately instead of hanging). Retrying a failed item
 * RESUMES the same worker session with a retry notice. The outcome is read
 * from the worker's own `factory` projection state host-side — the board
 * this plugin already maintains — so no new status channel exists. A failure
 * halts the queue (the user's policy); acknowledging resumes it.
 */
import { randomUUID } from 'node:crypto';
import { buildPipelinePrompt } from './prompt.js';
import { createPipelineMessage } from './command.js';
import { applyProjectOverrides, loadProjectOverrides } from './project-file.js';

/**
 * Read a worker run's verdict from its session's factory projection state.
 * The reason always carries the worker's last narration line when there is
 * one, so the queue UI shows real failure detail.
 * @param {object | undefined} state the `factory` projection state.
 * @param {number} eventCount events in the worker session at settle time.
 * @returns {{ok: boolean, reason: string}} the verdict.
 */
function workerVerdict(state, eventCount) {
  const lastLine = typeof state?.lastLine === 'string' && state.lastLine !== ''
    ? ` (last: ${state.lastLine})`
    : '';
  if (eventCount === 0) {
    return { ok: false, reason: 'the worker session recorded no events — its turn never started' };
  }
  if (state === undefined || state === null || !Array.isArray(state.phases)) {
    return { ok: false, reason: `no factory progress was recorded for the worker run${lastLine}` };
  }
  const failed = state.phases.find((phase) => phase.status === 'failed');
  if (failed !== undefined) {
    return { ok: false, reason: `phase ${failed.n}/9 ${failed.key} failed${failed.text ? `: ${failed.text}` : ''}${lastLine}` };
  }
  const final = state.phases[state.phases.length - 1];
  if (final === undefined || final.status !== 'done') {
    return { ok: false, reason: `the worker settled before completing phase 9/9${lastLine}` };
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
 * Resolve the worker's model options from the default model selection — the
 * same source every shipped agent-creation site uses. Null when no default
 * model service is composed (the item then fails loudly).
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @returns {{provider: string, model: string} | null}
 */
function workerAgentOptions(ctx) {
  const defaultModel = ctx.get('agentDefaultModel');
  if (defaultModel === undefined) return null;
  const selection = defaultModel.currentSelection();
  if (typeof selection?.provider !== 'string' || typeof selection?.model !== 'string') return null;
  return { provider: selection.provider, model: selection.model };
}

/**
 * Attach a worker session to the workspace covering its cwd, so the sidebar
 * groups it under that workspace instead of leaving it ungrouped (the
 * session-controller pattern: every created session is attached).
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {string} cwd the item's workspace root.
 * @param {string} sessionId the worker session id.
 */
async function attachToWorkspace(ctx, cwd, sessionId) {
  const registry = ctx.get('workspaceRegistry');
  if (registry === undefined || typeof registry.list !== 'function') return;
  const normalize = (path) => String(path).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const target = normalize(cwd);
  const workspace = registry.list().find((candidate) => {
    const root = normalize(candidate.path ?? '');
    return root === target || target.startsWith(`${root}/`);
  });
  if (workspace === undefined || typeof workspace.attachSession !== 'function') return;
  try {
    await workspace.attachSession(sessionId);
  } catch {
    // Grouping is cosmetic for the queue; the run continues unattached.
  }
}

/**
 * Create the queue runtime.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context (the
 *   optional `agents`, `agentDefaultModel`, `workspaceRegistry`, and
 *   `sessionProjections` services are read dynamically).
 * @param {ReturnType<import('./config.js').resolveConfig>} resolved
 *   effective plugin config.
 * @param {ReturnType<import('./queue.js').createQueueStore>} store the queue store.
 * @returns {object} the runtime API: `enqueueAndPump`, `pump`, `ack`,
 *   `retry`, `statusText`.
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
        const agentOptions = workerAgentOptions(ctx);
        if (agentOptions === null) {
          // Without a model selection no worker can run; record it once per
          // item instead of silently wedging the queue.
          for (;;) {
            const item = await store.pickNext(resolved.queueConcurrency);
            if (item === null) break;
            await store.markFailed(item.id, 'no default model selection is available for worker sessions');
          }
          return;
        }
        for (;;) {
          const item = await store.pickNext(resolved.queueConcurrency);
          if (item === null) break;
          // A fresh run mints a session id; a retry keeps the item's worker.
          const sessionId = item.workerSessionId ?? randomUUID();
          const isResume = item.workerSessionId !== null;
          const claimed = await store.markRunning(item.id, sessionId);
          if (!claimed) continue; // lost a race (halted or already picked)
          try {
            let agent;
            if (isResume) {
              // Retry (or crash recovery): resume the SAME worker session —
              // its transcript already carries the earlier clarification
              // answers and progress.
              agent = agents.get(sessionId)
                ?? (await agents.resume({ resumeSessionId: sessionId, agentOptions })).agent;
            } else {
              const handle = await agents.create({
                sessionId,
                meta: { cwd: item.workspace },
                agentOptions,
              });
              agent = handle.agent;
              await agent.whenIdle(); // settle a non-driving creation now
              await attachToWorkspace(ctx, item.workspace, sessionId);
            }
            let effective = resolved;
            try {
              effective = await effectiveWorkerConfig(ctx, resolved, item.workspace);
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              await store.markFailed(item.id, `invalid .factory.yml in the worker workspace: ${reason}`);
              continue;
            }
            const resumeNotice = 'RESUMED after a failed attempt or interruption. Read the transcript above, fix what went wrong or pick up where the run left off, and continue the pipeline; every earlier clarification answer still binds.';
            agent.followup(createPipelineMessage([
              { type: 'text', text: buildPipelinePrompt(effective, item.request, {
                autonomous: true,
                clarifications: item.clarifications,
                titleHint: `Factory queue ${item.id}: ${item.summary}`,
                ...(isResume ? { notice: resumeNotice } : {}),
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
        const eventCount = typeof agent.session.seq === 'number' ? agent.session.seq : 0;
        const verdict = workerVerdict(state, eventCount);
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
    /**
     * Retry a failed item: it re-queues with its worker session retained,
     * and scheduling resumes (resuming the halt it caused).
     * @param {string} id
     * @returns {Promise<boolean>} whether the item was re-queued.
     */
    async retry(id) {
      const requeued = await store.retry(id);
      if (requeued) await pump();
      return requeued;
    },
    /**
     * Remove one item (any status): a still-running worker is cancelled
     * first; a halt it caused lifts; scheduling resumes.
     * @param {string} id
     * @returns {Promise<boolean>} whether the item was removed.
     */
    async remove(id) {
      const item = await store.find(id);
      if (item === null) return false;
      if (item.status === 'running' && item.workerSessionId !== null) {
        const agents = ctx.get('agents');
        const live = agents?.get(item.workerSessionId);
        if (live !== undefined) {
          try {
            live.cancel({ kind: 'parent' });
          } catch {
            // An already-settling worker: removal proceeds regardless.
          }
        }
      }
      const removed = await store.remove(id);
      if (removed) await pump();
      return removed;
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
        ? `\nHALTED by a failure${queue.haltedBy ? ` (${queue.haltedBy})` : ''} — run /factory queue ack to resume, or /factory queue retry <id> to retry.`
        : '';
      return `Factory queue (concurrency ${resolved.queueConcurrency}):${halted}\n${lines.join('\n')}`;
    },
  };
}
