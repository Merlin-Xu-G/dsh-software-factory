/**
 * The `/factory` human command: the dsh-commands definition plus the
 * immutable steered message it submits. The handler reads `.factory.yml`,
 * merges it into the resolved row Config, builds the pipeline prompt, and
 * steers the receiving agent.
 */
import { randomUUID } from 'node:crypto';
import { PROJECT_FILE_NAME, applyProjectOverrides, loadProjectOverrides } from './project-file.js';
import { buildPipelinePrompt } from './prompt.js';

/**
 * Recursively freeze plain data (arrays/objects) in place, mirroring the
 * immutable-message invariant of dsh-llm's message constructors.
 * @param {unknown} value
 * @returns {unknown} the same reference, frozen.
 */
function deepFreeze(value) {
  if (value !== null && (typeof value === 'object' || Array.isArray(value))) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Build the immutable steered user message, matching the shape of dsh-llm's
 * `createUserMessage` (role, content blocks, user source, fresh identity).
 * @param {readonly object[]} content admitted content blocks.
 * @returns {object} frozen user message.
 */
function createPipelineMessage(content) {
  return deepFreeze({
    role: 'user',
    content: [...content],
    source: { kind: 'user' },
    id: randomUUID(),
  });
}

/**
 * Build the `/factory` command definition for one effective plugin row
 * Config (the `commands` service contract: name, description, input,
 * recordInput, handler).
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 *   (used for the optional `fs` service in `.factory.yml` reads).
 * @param {ReturnType<import('./config.js').resolveConfig>} resolved
 *   resolved plugin row config.
 * @returns {object} the command definition to register.
 */
export function defineFactoryCommand(ctx, resolved) {
  return {
    name: 'factory',
    description: 'Run the 9-phase software-factory delivery pipeline on a request',
    input: {
      hint: '<request>',
      attachments: true,
    },
    // The steered pipeline message already carries the request verbatim;
    // recording the raw input too would duplicate it in the session log.
    recordInput: false,
    handler: async ({ agent, rawInput = '', attachments = [], signal }) => {
      const request = rawInput.trim();
      if (request === '' && attachments.length === 0) {
        return {
          kind: 'error',
          text: 'Usage: /factory <request> — state what to build or change; the pipeline takes it from there.',
        };
      }
      let effective;
      let projectApplied = false;
      try {
        const project = await loadProjectOverrides(ctx, agent, signal);
        projectApplied = Object.keys(project.phases).length > 0
          || Object.keys(project.phasePrompts).length > 0;
        effective = applyProjectOverrides(resolved, project);
      } catch (error) {
        // Cancellation is not a config problem: let it surface as a thrown
        // handler so the registry settles it as an aborted command.
        if (signal?.aborted) throw error;
        return {
          kind: 'error',
          text: `${PROJECT_FILE_NAME} is invalid and was NOT applied — fix it and rerun /factory. ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const text = request === '' ? '' : buildPipelinePrompt(effective, request);
      agent.steer(
        createPipelineMessage([
          ...attachments,
          ...(text === '' ? [] : [{ type: 'text', text }]),
        ]),
      );
      return {
        kind: 'success',
        text: projectApplied
          ? `Factory pipeline started — 9 phases in order; ${PROJECT_FILE_NAME} overrides applied. Watch for [factory] phase lines in the conversation.`
          : 'Factory pipeline started — 9 phases in order; watch for [factory] phase lines in the conversation.',
      };
    },
  };
}
