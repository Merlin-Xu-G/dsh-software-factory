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
 *   phases / lastLine) the Web client reads through
 *   `sessions.binding(id).session.projections.faceOf('factory')`.
 * - `lib/project-file.js` — the `.factory.yml` parser, workspace-root
 *   reader, and override merge (the dsh-agent-instructions pattern).
 * - `lib/prompt.js` — the steered pipeline prompt builder.
 * - `lib/command.js` — the dsh-commands definition and the immutable
 *   steered message (dsh-llm `createUserMessage` shape).
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

export { Config, resolveConfig };
export { parseFactoryYml, applyProjectOverrides } from './lib/project-file.js';

/**
 * Host plugin entry. Registers the `/factory` command against the optional
 * `commands` service and the `factory` projection against the optional
 * `sessionProjections` service; returns the injected fibers' disposal as
 * cleanup.
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
  const fiber = ctx.inject(['commands'], (commandCtx) => {
    return commandCtx.commands.register(defineFactoryCommand(ctx, resolved));
  });
  return () => {
    fiber.dispose();
    projectionFiber.dispose();
  };
}
