/**
 * @local/dsh-software-factory — Host half (entry).
 *
 * Registers the `/factory <request>` human command. The command steers one
 * model-visible user message into the receiving agent (the same mechanism
 * `@deepseek-ai/dsh-plan-mode` uses for `/plan [message]`): a structured
 * pipeline prompt for the 9 delivery phases, followed by the user's request.
 * The agent then executes the pipeline with DSH-native machinery — todo/plan
 * facilities, file tools, optional subagent delegation, the shell tool, and
 * background jobs — while narrating one compact status line per phase
 * transition.
 *
 * Module layout (each `lib/` module owns one domain):
 * - `lib/phases.js` — the pipeline identity: ordered phases, statuses, and
 *   the `[factory] phase <n>/9 <key>: <status>` narration contract.
 * - `lib/config.js` — the plugin row Config (`~standard` facade, unknown-key
 *   rejection) and the deploy gate.
 * - `lib/projection.js` — the `factory` session projection: the log fold,
 *   schema facades, and the wire view (running / runCount / autoOpen /
 *   plan / phases / lastLine) the Web client reads through
 *   `sessions.binding(id).session.projections.faceOf('factory')`.
 * - `lib/project-file.js` — the `.factory.yml` parser, workspace-root
 *   reader, and override merge (the dsh-agent-instructions pattern).
 * - `lib/prompt.js` — the steered pipeline prompt builder (grill, autonomous
 *   worker, and default modes; binding clarification answers).
 * - `lib/command.js` — the dsh-commands definition (`<request>`,
 *   `-q|--queue` enqueue with the structural batch + interview directive,
 *   `queue [ack [id]]`) and the immutable steered message.
 * - `lib/queue.js` — the global durable queue store (scope blocking,
 *   concurrency cap, halt-on-failure, crash recovery).
 * - `lib/orchestrator.js` — the worker runtime: root worker sessions in the
 *   item's workspace, verdicts read from their factory projection, and the
 *   queue's read-model/status surfaces.
 *
 * The projection is registered through the optional `sessionProjections`
 * service and the command through the optional `commands` service, so
 * profiles without either keep the rest fully functional. The plugin itself
 * owns no pipeline state: the steered message, the agent's tool calls, their
 * results, and the derived projection all reconstruct from the session log,
 * so fork/resume/replay reproduce the run.
 *
 * Contracts coded against (verified by inspection of the installed Harness):
 * - `ctx.commands.register({ name, description, input: { hint, attachments },
 *    recordInput, handler })` from the `commands` service
 *    (@deepseek-ai/dsh-commands). The handler receives
 *    `{ agent, rawInput, attachments, signal }` and its return value is
 *    awaited (`await withAbort(Promise.resolve(output), signal)`); it returns
 *    `{ kind: 'success', text? }` or `{ kind: 'error', text }`.
 * - `agent.steer(userMessage)` (dsh-agent-loop ReactLoopAgent) inserts the
 *    message for the next step AND wakes the driver; the message shape is
 *    `{ role: 'user', content: ContentBlock[], source: { kind: 'user' },
 *    id }` as produced by dsh-llm's `createUserMessage` (the id brand is a
 *    compile-time no-op, so a locally built frozen object is identical).
 * - `ctx.inject(['commands'], callback)` (cordis Context.inject) starts a
 *    child plugin only while the optional `commands` service exists and
 *    returns its fiber, whose `dispose()` is this plugin's cleanup.
 * - `export const Config` is consumed through the Standard Schema
 *    `~standard.validate` protocol (cordis `resolveConfig`), so the schema
 *    is a dependency-free implementation of that contract.
 */
import { resolveConfig, Config } from './lib/config.js';
import { buildFactoryProjectionDefinition } from './lib/projection.js';
import { defineFactoryCommand } from './lib/command.js';
import { createQueueStore } from './lib/queue.js';
import { createQueueRuntime } from './lib/orchestrator.js';

export { Config, resolveConfig };
export { parseFactoryYml, applyProjectOverrides } from './lib/project-file.js';
export { createQueueStore, eligibleToStart, resolveQueueDir } from './lib/queue.js';

/** Prefix of the enqueue payload line the interview directive elicits. */
const ENQUEUE_LINE_PREFIX = '[factory] enqueue:';

/**
 * Extract the enqueue payload JSON from one assistant text, if present.
 * @param {string} text one assistant message's text.
 * @returns {unknown | undefined} the parsed payload, or undefined.
 */
function parseEnqueuePayload(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(ENQUEUE_LINE_PREFIX)) continue;
    try {
      const parsed = JSON.parse(trimmed.slice(ENQUEUE_LINE_PREFIX.length));
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      // Malformed payload: warn and let the interview retry.
      return undefined;
    }
  }
  return undefined;
}

/**
 * Host plugin entry. Registers the `/factory` command against the optional
 * `commands` service, the `factory` projection against the optional
 * `sessionProjections` service, the global queue (store + worker runtime +
 * the read-only queue.json route against the optional `webServer` service),
 * and the enqueue listener that turns an interview's final
 * `[factory] enqueue: {json}` line into a queue item; returns the injected
 * fibers' disposal as cleanup.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {unknown} config raw row config (already validated via `Config`).
 * @returns {() => void} cleanup.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const projectionFiber = ctx.inject(['sessionProjections'], (projectionCtx) => {
    return projectionCtx.sessionProjections.register(buildFactoryProjectionDefinition(resolved.autoOpenTab));
  });
  const store = createQueueStore();
  const runtime = createQueueRuntime(ctx, resolved, store);

  // The enqueue listener: an interview's final narration line enqueues.
  const stopListener = ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return;
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) return;
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    if (!text.includes(ENQUEUE_LINE_PREFIX)) return;
    const payload = parseEnqueuePayload(text);
    if (payload === undefined) {
      ctx.logger.warn('software-factory: enqueue line was malformed — not queued');
      return;
    }
    const sourceEvent = `${session.id}:${event.seq}`;
    void store.hasSourceEvent(sourceEvent).then(async (seen) => {
      if (seen) return;
      await runtime.enqueueAndPump({
        request: typeof payload.request === 'string' && payload.request !== ''
          ? payload.request
          : text.split('\n').find((line) => line.trim().startsWith(ENQUEUE_LINE_PREFIX)) ?? '',
        summary: typeof payload.summary === 'string' ? payload.summary : '',
        scopes: Array.isArray(payload.scopes)
          ? payload.scopes.filter((scope) => typeof scope === 'string')
          : [],
        workspace: session.header?.cwd ?? process.cwd(),
        clarifications: Array.isArray(payload.clarifications)
          ? payload.clarifications
          : [],
        sourceEvent,
      });
    }).catch((error) => {
      ctx.logger.warn('software-factory: enqueue failed: %o', error);
    });
  });

  // The queue surface: a same-origin JSON route (the shipped client-hmr
  // route pattern). GET is the read model; POST carries the ack/retry
  // actions from the queue page's buttons and REQUIRES the custom
  // `x-dsh-factory-action` header — a non-simple header forces a CORS
  // preflight on cross-origin requests, which this host never answers, so
  // other origins cannot forge a POST (classic CSRF cannot set custom
  // headers without preflight).
  const routeFiber = ctx.inject(['webServer'], (webCtx) => {
    return webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/@local/dsh-software-factory/queue.json',
      handler: async (req, res) => {
        const send = (status, payload) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(req.method === 'HEAD' ? undefined : JSON.stringify(payload));
        };
        try {
          if (req.method === 'GET' || req.method === 'HEAD') {
            const queue = await store.snapshot();
            return send(200, {
              halted: queue.halted,
              haltedBy: queue.haltedBy,
              concurrency: resolved.queueConcurrency,
              items: queue.items.map((item) => ({
                id: item.id,
                summary: item.summary,
                status: item.status,
                scopes: item.scopes,
                workspace: item.workspace,
                workerSessionId: item.workerSessionId,
                enqueuedAt: item.enqueuedAt,
                startedAt: item.startedAt,
                endedAt: item.endedAt,
                failureReason: item.failureReason,
              })),
            });
          }
          if (req.method === 'POST') {
            if (req.headers['x-dsh-factory-action'] !== 'queue') {
              return send(403, { error: 'missing x-dsh-factory-action: queue header' });
            }
            const body = await new Promise((resolve, reject) => {
              let data = '';
              req.on('data', (chunk) => {
                data += chunk;
                if (data.length > 4096) req.destroy();
              });
              req.on('end', () => {
                try {
                  resolve(JSON.parse(data));
                } catch (error) {
                  reject(error);
                }
              });
              req.on('error', reject);
            });
            const id = typeof body?.id === 'string' ? body.id : undefined;
            if (body?.action === 'ack') {
              const cleared = await runtime.ack(id);
              return send(cleared ? 200 : 409, { ok: cleared });
            }
            if (body?.action === 'retry' && typeof id === 'string') {
              const requeued = await runtime.retry(id);
              return send(requeued ? 200 : 409, { ok: requeued });
            }
            return send(400, { error: 'expected {"action":"ack"|"retry","id":…}' });
          }
          return send(405, { error: 'GET/HEAD/POST only' });
        } catch (error) {
          return send(500, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    });
  });

  const fiber = ctx.inject(['commands'], (commandCtx) => {
    return commandCtx.commands.register(defineFactoryCommand(ctx, resolved, runtime));
  });

  // Resume scheduling after a restart (crash recovery already re-queued
  // running items at store load).
  void runtime.pump();

  return () => {
    fiber.dispose();
    routeFiber.dispose();
    stopListener();
    projectionFiber.dispose();
  };
}
