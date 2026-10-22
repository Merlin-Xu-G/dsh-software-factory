/**
 * The `/factory` human command: the dsh-commands definition plus the
 * immutable steered message it submits.
 *
 * Grammar (the command owns it — the framework passes one raw string):
 * - `/factory <request>` — interactive run in this session.
 * - `/factory -q <request>` / `/factory --queue <request>` — enqueue into the
 *   global factory queue: the handler asks one structural batch immediately
 *   (workspace, write scopes, summary, notes), then steers an enqueue
 *   interview directive; the unbounded design grilling happens in-turn, and
 *   the interview's final `[factory] enqueue: {json}` line is picked up by
 *   the host listener that creates the queue item.
 * - `/factory queue` — queue status text.
 * - `/factory queue ack [id]` — acknowledge a halted queue and resume.
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
export function createPipelineMessage(content) {
  return deepFreeze({
    role: 'user',
    content: [...content],
    source: { kind: 'user' },
    id: randomUUID(),
  });
}

/**
 * Split the leading `-q` / `--queue` flags off the raw input.
 * @param {string} rawInput
 * @returns {{queue: boolean, rest: string}}
 */
function parseQueueFlags(rawInput) {
  let queue = false;
  const tokens = rawInput.trim().split(/\s+/).filter((token) => token !== '');
  while (tokens.length > 0 && (tokens[0] === '-q' || tokens[0] === '--queue')) {
    queue = true;
    tokens.shift();
  }
  return { queue, rest: tokens.join(' ') };
}

/**
 * Ask the structural enqueue batch through the user-questions service.
 * Returns null when the user dismissed the questions (enqueue cancelled);
 * empty strings when no user-questions service is composed (fire-and-forget).
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {object} agent the invoking agent.
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{summary: string, scopes: string[], workspace: string,
 *   notes: string} | null>}
 */
async function askStructuralBatch(ctx, agent, signal) {
  const questions = ctx.get('userQuestions');
  if (questions === undefined) return { summary: '', scopes: [], workspace: '', notes: '' };
  const cwd = agent?.session?.header?.cwd ?? process.cwd();
  let answers;
  try {
    answers = await questions.ask({
      agent,
      signal,
      questions: [
        {
          id: 'workspace',
          question: 'Which workspace should this queued request run in?',
          header: 'Workspace',
          options: [{ label: cwd, description: 'This session\'s workspace (Recommended)' }],
        },
        {
          id: 'scopes',
          question: 'Which files or directories will this request touch (its write scopes, one per line)? Empty means the whole workspace.',
          header: 'Write scopes',
        },
        {
          id: 'summary',
          question: 'One-line summary for the queue list?',
          header: 'Summary',
        },
        {
          id: 'notes',
          question: 'Anything else the worker must know before starting?',
          header: 'Notes',
        },
      ],
    });
  } catch {
    return null;
  }
  const pick = (id) => {
    const entry = answers?.answers?.find((answer) => answer.id === id);
    const selected = entry?.selected?.[0];
    const custom = typeof entry?.custom === 'string' ? entry.custom.trim() : '';
    return typeof selected === 'string' && selected !== '' ? selected : custom;
  };
  return {
    summary: pick('summary') ?? '',
    scopes: (pick('scopes') ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== ''),
    workspace: pick('workspace') ?? '',
    notes: pick('notes') ?? '',
  };
}

/**
 * Build the enqueue interview directive steered into the session: the
 * unbounded design grilling, ending in the enqueue payload line.
 * @param {string} request
 * @param {{summary: string, scopes: string[], workspace: string, notes: string}} structural
 * @returns {string} the directive text.
 */
function buildEnqueueDirective(request, structural) {
  return `Factory queue enqueue interview

Conduct the clarification interview for the following request NOW, in this session, using the ask_user_question tool. This is a long-running request the user will NOT review again — every design decision must be settled by their explicit answer before it is queued.

## Request

${request}

## Structural answers already given

- Workspace: ${structural.workspace === '' ? '(this session\'s workspace)' : structural.workspace}
- Write scopes: ${structural.scopes.length === 0 ? '(whole workspace)' : structural.scopes.join(', ')}
- Summary: ${structural.summary === '' ? '(derive one from the request)' : structural.summary}
${structural.notes === '' ? '' : `- Notes: ${structural.notes}`}

## Interview rules

- Cover every material dimension of this request: functional scope and non-goals, data model and storage, limits and their semantics, configuration and defaults, UI/CLI behavior, error and edge cases, backward compatibility, security, verification.
- Ask in batches of up to four questions; every question offers concrete options with one marked (Recommended) or accepts free text. There is NO batch limit — keep asking until every dimension is settled by the user's explicit answer.
- When everything is settled, emit EXACTLY ONE line in this form and nothing after it:
[factory] enqueue: {"request":"…","summary":"…","scopes":["…"],"clarifications":[{"question":"…","answer":"…"}]}
  ("request" is the FULL original request verbatim, JSON-escaped onto one line; summary overrides the structural summary only if the interview refined it; scopes refine the structural scopes; clarifications carries every settled decision as question/answer pairs. Optionally the JSON may also name "provider", "model", and/or "reasoningEffort" — per-field overrides of the worker's model selection, which otherwise inherits this session's current model and thinking effort; name a field ONLY when the user explicitly asked for a different worker model or effort, and invalid values are silently dropped. Keep the JSON on one line.)`;
}

/**
 * Build the `/factory` command definition for one effective plugin row
 * Config (the `commands` service contract).
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {ReturnType<import('./config.js').resolveConfig>} resolved
 *   resolved plugin row config.
 * @param {object} queueRuntime the queue runtime (enqueue/ack/status).
 * @returns {object} the command definition to register.
 */
export function defineFactoryCommand(ctx, resolved, queueRuntime) {
  return {
    name: 'factory',
    description: 'Run the 9-phase software-factory delivery pipeline on a request',
    input: {
      hint: '[-q|--queue] <request> | queue [ack [id]]',
      attachments: true,
    },
    // The steered pipeline message already carries the request verbatim;
    // recording the raw input too would duplicate it in the session log.
    recordInput: false,
    handler: async ({ agent, rawInput = '', attachments = [], signal }) => {
      const input = rawInput.trim();

      // Queue management: `/factory queue [ack [id]]` and `queue retry <id>`.
      if (input === 'queue' || input.startsWith('queue ')) {
        const tokens = input.split(/\s+/);
        if (tokens[1] === 'ack') {
          const cleared = await queueRuntime.ack(tokens[2]);
          return cleared
            ? { kind: 'success', text: 'Queue halt acknowledged — scheduling resumed. Watch the Factory queue page or run /factory queue.' }
            : { kind: 'error', text: 'The queue is not halted (or the id does not name the failed item); nothing to acknowledge.' };
        }
        if (tokens[1] === 'retry') {
          if (typeof tokens[2] !== 'string' || tokens[2] === '') {
            return { kind: 'error', text: 'Usage: /factory queue retry <id> — the id of the failed item, shown by /factory queue.' };
          }
          const requeued = await queueRuntime.retry(tokens[2]);
          return requeued
            ? { kind: 'success', text: `Item ${tokens[2]} re-queued — its worker session resumes where the failed attempt left off. Watch the Factory queue page or run /factory queue.` }
            : { kind: 'error', text: `Item ${tokens[2]} is not a failed item; only failed items can retry (use /factory queue rm to remove it).` };
        }
        if (tokens[1] === 'rm' || tokens[1] === 'remove') {
          if (typeof tokens[2] !== 'string' || tokens[2] === '') {
            return { kind: 'error', text: 'Usage: /factory queue rm <id> — the id shown by /factory queue.' };
          }
          const removed = await queueRuntime.remove(tokens[2]);
          return removed
            ? { kind: 'success', text: `Item ${tokens[2]} removed (a running worker was cancelled); the queue resumes if this failure had halted it.` }
            : { kind: 'error', text: `Item ${tokens[2]} does not exist.` };
        }
        return { kind: 'success', text: await queueRuntime.statusText() };
      }

      const { queue, rest: request } = parseQueueFlags(input);
      if (request === '' && attachments.length === 0) {
        return {
          kind: 'error',
          text: 'Usage: /factory [-q|--queue] <request> — or /factory queue [ack [id]] for the queue.',
        };
      }

      // Enqueue path: structural batch, then the unbounded interview in-turn.
      if (queue) {
        const structural = await askStructuralBatch(ctx, agent, signal);
        if (structural === null) {
          return { kind: 'error', text: 'Enqueue cancelled — the structural questions were dismissed.' };
        }
        agent.steer(createPipelineMessage([
          ...attachments,
          { type: 'text', text: buildEnqueueDirective(request, structural) },
        ]));
        return {
          kind: 'success',
          text: `Enqueue interview started — answer the batches until everything is settled; the final enqueue line queues it. Track it with /factory queue or the Factory queue page. Scopes: ${structural.scopes.length === 0 ? 'whole workspace' : structural.scopes.join(', ')}.`,
        };
      }

      // Interactive path.
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
