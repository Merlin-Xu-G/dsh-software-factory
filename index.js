/**
 * @local/dsh-software-factory — Host half.
 *
 * Registers the `/factory <request>` human command. The command steers one
 * model-visible user message into the receiving agent (the same mechanism
 * `@deepseek-ai/dsh-plan-mode` uses for `/plan [message]`): a structured
 * pipeline prompt for the 8 delivery phases below, followed by the user's
 * request. The agent then executes the pipeline with DSH-native machinery —
 * todo/plan facilities, file tools, optional subagent delegation, the shell
 * tool, and background jobs — while narrating one compact status line per
 * phase transition.
 *
 * Progress observability: the `factory` session projection folds the
 * session log's `assistant/message` events, matching ONLY lines that start
 * with the plugin's own narration contract (`[factory] phase <n>/8 <key>:
 * <status>`), and publishes a wire view per session. The Web client half
 * (client.js, right-sidebar tab) reads it through the shipped session
 * binding (`sessions.binding(id).session.projections.faceOf('factory')`) —
 * the same host→client shape the shipped plan-mode and goal plugins use.
 * The projection is registered through the optional `sessionProjections`
 * service, so profiles without it keep the command fully functional.
 *
 * The plugin itself owns no pipeline state: the steered message, the agent's
 * tool calls, their results, and the derived projection all reconstruct
 * from the session log, so fork/resume/replay reproduce the run. This keeps
 * the "session log is the only source of truth" practice of the Harness.
 *
 * Per-project overrides: when `/factory` runs, the plugin reads
 * `.factory.yml` from the session workspace root — resolved exactly the way
 * the shipped `@deepseek-ai/dsh-agent-instructions` resolves instruction
 * files: `agent.session.header.cwd ?? process.cwd()` for the root, then the
 * optional `fs` service (`ctx.get('fs')`: `resolve(path, { cwd, signal })` →
 * `stat(target, signal)` → `readText(target, signal)`) with a `node:fs`
 * fallback when the service is absent. The file may override the six phase
 * toggles and append per-phase prompt text (see `parseFactoryYml`); the
 * plugin row Config stays the global default layer and keeps command lists
 * and the deploy gate to itself. A missing file changes nothing; an invalid
 * file fails loudly with the file named.
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
 *    returns its fiber, whose `dispose()` is this plugin's cleanup. The
 *    `fs` service is looked up dynamically with `ctx.get('fs')` (the
 *    dsh-agent-instructions pattern): it is the preferred read path, and the
 *    node:fs fallback keeps the command working when it is absent.
 * - `export const Config` is consumed through the Standard Schema
 *    `~standard.validate` protocol (cordis `resolveConfig`), so the schema
 *    below is a dependency-free implementation of that contract.
 */
import { randomUUID } from 'node:crypto';
import { readFile as nodeReadFile, stat as nodeStat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The fixed pipeline identity: eight phases, in order. `key` is the slug used
 * in status lines; `toggle` names the Config boolean that enables the phase
 * (phase 1 capture is the request itself and is always enabled; phase 6
 * deploy is additionally gated on a configured deploy command).
 */
const PHASES = [
  { key: 'capture', name: 'Capture the request', toggle: null },
  { key: 'plan', name: 'Plan the tasks', toggle: 'plan' },
  { key: 'implement', name: 'Implement the tasks', toggle: 'implement' },
  { key: 'guardrails', name: 'Run guardrails', toggle: 'guardrails' },
  { key: 'test', name: 'Test the implementation', toggle: 'test' },
  { key: 'deploy', name: 'Deploy to test environment', toggle: 'deploy' },
  { key: 'regression', name: 'Run regression tests', toggle: 'regression' },
  { key: 'evaluate', name: 'Evaluate and report', toggle: 'evaluate' },
];

const TOP_LEVEL_KEYS = new Set([
  'plan',
  'implement',
  'guardrails',
  'test',
  'deploy',
  'regression',
  'evaluate',
  'guardrailCommand',
  'testCommand',
  'regressionCommand',
  'subagentImplementation',
]);

/** The per-project file this plugin reads from the session workspace root. */
const PROJECT_FILE_NAME = '.factory.yml';

/** Phase toggles a `.factory.yml` may override (deploy stays plugin-Config-only). */
const PROJECT_TOGGLE_KEYS = new Set([
  'plan',
  'implement',
  'guardrails',
  'test',
  'regression',
  'evaluate',
]);

/** Phases a `.factory.yml` `phasePrompts` entry may target (deploy prompts DO apply). */
const PROJECT_PROMPT_KEYS = new Set([
  'plan',
  'implement',
  'guardrails',
  'test',
  'deploy',
  'regression',
  'evaluate',
]);

/** Top-level keys allowed in a `.factory.yml`. */
const PROJECT_TOP_KEYS = new Set(['phases', 'phasePrompts']);

/** Upper bound for `.factory.yml` size — it becomes part of the steered prompt. */
const PROJECT_FILE_MAX_CHARS = 65536;

/**
 * The session-projection key whose wire view the Web client's right-sidebar
 * tab reads (`sessions.binding(id).session.projections.faceOf('factory')`).
 */
const FACTORY_PROJECTION_KEY = 'factory';

/**
 * The narration contract this plugin's prompt imposes on the agent. Only
 * lines matching this pattern at line start fold projection state, so
 * unrelated text (including tool output echoing the prompt) can never be
 * misparsed as progress.
 */
const STATUS_LINE_PATTERN = /^\[factory\] phase ([1-8])\/8 ([a-z]+): (.*)$/;

/** Phase statuses the projection tracks. */
const PHASE_STATUSES = new Set(['pending', 'active', 'done', 'skipped', 'failed']);

/**
 * Build the initial projection state: eight pending phases, no run.
 * @returns {{running: boolean, phases: {n: number, key: string,
 *   status: string, text: string | null}[], lastLine: string | null}}
 */
function emptyProjectionState() {
  return {
    running: false,
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
 * @param {number} n phase number from the line (1-8).
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
  }
  // Progression: entering phase n closes every earlier open phase as done.
  for (let i = 0; i < n - 1; i += 1) {
    if (phases[i].status === 'active' || phases[i].status === 'pending') {
      phases[i] = { ...phases[i], status: 'done' };
    }
  }
  const lower = text.toLowerCase();
  const status = lower.includes('skip')
    ? 'skipped'
    : (lower.includes('fail') || lower.includes('error') || lower.includes('blocked'))
      ? 'failed'
      : n === PHASES.length ? 'done' : 'active';
  phases[n - 1] = { ...phases[n - 1], status, text };
  const final = phases[PHASES.length - 1].status;
  return {
    running: final !== 'done' && final !== 'failed' && final !== 'skipped',
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
  return input;
}

/**
 * The factory progress projection. The session-projection registry only
 * calls `schema.parse(...)` on state and wire values, so the schemas below
 * are dependency-free `{ parse }` facades (the same trick as `Config`'s
 * `~standard`, one protocol level up). The wire view reaches the Web client
 * through the shipped session binding (`projections.faceOf('factory')`) —
 * the exact host→client shape plan-mode and goal use.
 */
const factoryProjectionDefinition = {
  key: FACTORY_PROJECTION_KEY,
  // v2: a phase-1 line now resets the board unconditionally (v1 gated the
  // reset on `!running`, so a run abandoned mid-failure kept its stale rows
  // and a `failed` phase survived into the next run).
  stateVersion: 2,
  stateSchema: { parse: validateProjectionState },
  init: () => emptyProjectionState(),
  apply: (state, event) => {
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
    viewSchema: { parse: validateProjectionState },
    view: (state) => ({
      running: state.running,
      phases: state.phases.map((phase) => ({ ...phase })),
      lastLine: state.lastLine,
    }),
  },
};

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
 * Read a boolean option.
 * @param {Record<string, unknown>} raw owner object of the field.
 * @param {string} name field name for diagnostics.
 * @param {boolean} fallback value used when the field is absent.
 * @returns {boolean}
 */
function readBoolean(raw, name, fallback) {
  const value = raw[name] === undefined ? fallback : raw[name];
  if (typeof value !== 'boolean') {
    throw new TypeError(`software-factory config "${name}" must be a boolean`);
  }
  return value;
}

/**
 * Read a command option: one non-empty string or an array of them,
 * normalized to a frozen array of strings.
 * @param {Record<string, unknown>} raw owner object of the field.
 * @param {string} name field name for diagnostics.
 * @param {readonly string[]} fallback value used when the field is absent.
 * @returns {readonly string[]}
 */
function readCommands(raw, name, fallback) {
  const value = raw[name] === undefined ? fallback : raw[name];
  const list = typeof value === 'string' ? [value] : value;
  if (
    !Array.isArray(list)
    || list.some((entry) => typeof entry !== 'string' || entry.trim() === '')
  ) {
    throw new TypeError(
      `software-factory config "${name}" must be a non-empty command string or an array of non-empty command strings`,
    );
  }
  return Object.freeze([...list]);
}

/**
 * Validate and normalize the plugin config. Unknown keys fail at activation
 * (the plan-mode `resolveConfig` pattern) so typos never silently disable a
 * phase.
 *
 * @param {unknown} input raw row config; `{}`/`undefined` selects defaults.
 * @returns {Readonly<{plan: boolean, implement: boolean, guardrails: boolean,
 *   test: boolean, regression: boolean, evaluate: boolean,
 *   subagentImplementation: boolean, deploy: {enabled: boolean, command: readonly string[]},
 *   guardrailCommand: readonly string[], testCommand: readonly string[],
 *   regressionCommand: readonly string[]}>}
 */
function resolveConfig(input) {
  const raw = input === undefined || input === null ? {} : input;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('software-factory config must be an object');
  }
  const unknown = Object.keys(raw).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `software-factory config has unknown key(s) ${unknown.join(', ')} — allowed keys: ${[...TOP_LEVEL_KEYS].join(', ')}`,
    );
  }
  const deployRaw = raw.deploy === undefined ? {} : raw.deploy;
  if (typeof deployRaw !== 'object' || deployRaw === null || Array.isArray(deployRaw)) {
    throw new TypeError('software-factory config "deploy" must be an object');
  }
  const deployUnknown = Object.keys(deployRaw).filter((key) => key !== 'enabled' && key !== 'command');
  if (deployUnknown.length > 0) {
    throw new TypeError('software-factory config "deploy" allows only "enabled" and "command"');
  }
  return Object.freeze({
    plan: readBoolean(raw, 'plan', true),
    implement: readBoolean(raw, 'implement', true),
    guardrails: readBoolean(raw, 'guardrails', true),
    test: readBoolean(raw, 'test', true),
    regression: readBoolean(raw, 'regression', true),
    evaluate: readBoolean(raw, 'evaluate', true),
    subagentImplementation: readBoolean(raw, 'subagentImplementation', true),
    deploy: Object.freeze({
      enabled: readBoolean(deployRaw, 'enabled', false),
      command: readCommands(deployRaw, 'command', []),
    }),
    guardrailCommand: readCommands(raw, 'guardrailCommand', []),
    testCommand: readCommands(raw, 'testCommand', []),
    regressionCommand: readCommands(raw, 'regressionCommand', []),
  });
}

/**
 * The plugin's Config schema, implementing the Standard Schema `~standard`
 * protocol that cordis `resolveConfig` calls (`Config['~standard'].validate`).
 * Dependency-free on purpose: a local bundle must not need zod or Schemastery
 * installed beside it. The Settings/Config-inspect surfaces that project
 * known schema vendors will not render a form for this schema; the row config
 * in `cordis.patch.yml` remains the declarative way to configure the plugin.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: '@local/dsh-software-factory',
    validate(raw) {
      try {
        return { value: resolveConfig(raw) };
      } catch (error) {
        return {
          issues: [
            {
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  },
};

/**
 * Render a numbered command list for the prompt.
 * @param {readonly string[]} commands
 * @returns {string} markdown lines, empty when nothing is configured.
 */
function renderCommandList(commands) {
  if (commands.length === 0) return '';
  return commands.map((command, index) => `${index + 1}. \`${command}\``).join('\n');
}

/**
 * Whether the deploy phase may run: it must be enabled AND name a command.
 * Deploying is the one phase that is off until explicitly configured.
 */
function deployActive(resolved) {
  return resolved.deploy.enabled && resolved.deploy.command.length > 0;
}

/**
 * Parse the `.factory.yml` subset. Dependency-free on purpose; the supported
 * grammar (documented in README) is exactly:
 *
 * - optional blank lines and `#` comments anywhere;
 * - two top-level mapping headers `phases:` and `phasePrompts:` (each at
 *   most once, nothing after the colon);
 * - nested entries at one consistent indentation (spaces only — tabs are an
 *   error), `key: value` on a single line;
 * - `phases.<key>`: `plan|implement|guardrails|test|regression|evaluate` =
 *   `true` or `false` (exactly; `yes`/`True` are errors);
 * - `phasePrompts.<key>`: `plan|implement|guardrails|test|deploy|
 *   regression|evaluate` = a string — plain scalar (trailing ` # comment`
 *   stripped), single-quoted (only `''` escape), double-quoted (only `\"`,
 *   `\\`, `\n`, `\t` escapes), or a block scalar `|` / `|-` (literal) or
 *   `>` / `>-` (folded: paragraph lines joined with one space, blank lines
 *   collapse to one paragraph break, deeper-indented lines stay verbatim);
 *   `|`/`>` keep one trailing newline, `|-`/`>-` strip it;
 * - nothing else: no lists, anchors, tags, multi-document input, multi-line
 *   plain scalars, or deeper nesting.
 *
 * Every violation throws an Error naming the file and line.
 *
 * @param {string} text raw file content (UTF-8; BOM and CRLF tolerated).
 * @param {{displayName?: string}} options error-naming options.
 * @returns {Readonly<{phases: Readonly<Record<string, boolean>>,
 *   phasePrompts: Readonly<Record<string, string>>}>}
 */
export function parseFactoryYml(text, options = {}) {
  const displayName = options.displayName ?? PROJECT_FILE_NAME;
  const fail = (lineNumber, detail) => new Error(`${displayName} line ${lineNumber}: ${detail}`);
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r\n|\n|\r/);
  const phases = {};
  const phasePrompts = {};
  const seenTop = new Set();
  let topKey = null;
  let childIndent = -1;

  /** Split a line into its space indentation and content; tabs are an error. */
  const splitIndent = (raw, lineNumber) => {
    const match = /^([ \t]*)(.*)$/.exec(raw);
    if (match[1].includes('\t')) {
      throw fail(lineNumber, 'tabs are not allowed in indentation; use spaces');
    }
    return { indent: match[1].length, content: match[2] };
  };

  /** Strip a trailing comment (` # …`) from an unquoted scalar. */
  const stripComment = (scalar) => {
    for (let i = 0; i < scalar.length; i += 1) {
      if (scalar[i] !== '#') continue;
      if (i === 0 || scalar[i - 1] === ' ' || scalar[i - 1] === '\t') return scalar.slice(0, i);
    }
    return scalar;
  };

  /** Parse a single-line quoted string value. */
  const parseQuoted = (rest, lineNumber, childKey) => {
    if (rest.startsWith("'")) {
      const match = /^'((?:[^']|'')*)'(.*)$/.exec(rest);
      if (!match) throw fail(lineNumber, `"${childKey}" has an unterminated single-quoted value`);
      if (match[2].trim() !== '') {
        throw fail(lineNumber, `"${childKey}" has unexpected content after the closing quote`);
      }
      return match[1].replace(/''/g, "'");
    }
    const match = /^"((?:[^"\\]|\\.)*)"(.*)$/.exec(rest);
    if (!match) throw fail(lineNumber, `"${childKey}" has an unterminated double-quoted value`);
    if (match[2].trim() !== '') {
      throw fail(lineNumber, `"${childKey}" has unexpected content after the closing quote`);
    }
    return match[1].replace(/\\(.)/g, (whole, escaped) => {
      switch (escaped) {
        case '"': return '"';
        case '\\': return '\\';
        case 'n': return '\n';
        case 't': return '\t';
        default:
          throw fail(lineNumber, `"${childKey}" uses unsupported escape "\\${escaped}" (supported: \\" \\\\ \\n \\t)`);
      }
    });
  };

  /** Collect and render a `|`/`|-`/`>`/`>-` block scalar starting after `index`. */
  const parseBlockScalar = (indicator, lines, index, nestedIndent, headerLineNumber) => {
    const collected = [];
    let contentIndent = -1;
    let i = index + 1;
    while (i < lines.length) {
      const raw = lines[i];
      if (raw.trim() === '') {
        collected.push('');
        i += 1;
        continue;
      }
      const { indent, content } = splitIndent(raw, i + 1);
      if (indent <= nestedIndent) break;
      if (contentIndent === -1) contentIndent = indent;
      if (indent < contentIndent) {
        throw fail(i + 1, `inconsistent block-scalar indentation (expected ${contentIndent} spaces)`);
      }
      collected.push(`${' '.repeat(indent - contentIndent)}${content}`);
      i += 1;
    }
    while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
    if (collected.length === 0) {
      throw fail(headerLineNumber, `block scalar "${indicator}" has no content`);
    }
    let value;
    if (indicator === '|' || indicator === '|-') {
      value = collected.join('\n');
      if (indicator === '|') value += '\n';
    } else {
      const out = [];
      let paragraph = [];
      const flush = () => {
        if (paragraph.length > 0) {
          out.push(paragraph.join(' '));
          paragraph = [];
        }
      };
      for (const line of collected) {
        if (line === '') {
          flush();
          continue;
        }
        if (line.startsWith(' ')) {
          flush();
          out.push(line);
          continue;
        }
        paragraph.push(line);
      }
      flush();
      value = out.join('\n');
      if (indicator === '>') value += '\n';
    }
    return { value, nextIndex: i };
  };

  /** Parse one `key: rest` child entry at `index`; returns value + next index. */
  const parseChildValue = (currentTop, childKey, rest, index, nestedIndent) => {
    const lineNumber = index + 1;
    const indicator = stripComment(rest).trim();
    if (indicator === '|' || indicator === '|-' || indicator === '>' || indicator === '>-') {
      return parseBlockScalar(indicator, lines, index, nestedIndent, lineNumber);
    }
    const trimmed = rest.trim();
    if (currentTop === 'phases') {
      const boolText = stripComment(trimmed).trim();
      if (boolText !== 'true' && boolText !== 'false') {
        throw fail(lineNumber, `phases.${childKey} must be true or false (got "${boolText}")`);
      }
      return { value: boolText === 'true', nextIndex: index + 1 };
    }
    if (trimmed === '') throw fail(lineNumber, `"${childKey}" is missing a value`);
    if (trimmed.startsWith("'") || trimmed.startsWith('"')) {
      return { value: parseQuoted(trimmed, lineNumber, childKey), nextIndex: index + 1 };
    }
    const plain = stripComment(trimmed).trim();
    if (plain === '') throw fail(lineNumber, `"${childKey}" is missing a value`);
    return { value: plain, nextIndex: index + 1 };
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmedRaw = raw.trim();
    if (trimmedRaw === '' || trimmedRaw.startsWith('#')) {
      i += 1;
      continue;
    }
    const { indent, content } = splitIndent(raw, i + 1);
    if (indent === 0) {
      topKey = null;
      childIndent = -1;
      const entry = /^([^\s:]+):\s*(.*)$/.exec(content);
      if (!entry) throw fail(i + 1, `expected a "key:" line, got "${content}"`);
      const [, key, rest] = entry;
      if (!PROJECT_TOP_KEYS.has(key)) {
        throw fail(i + 1, `unknown top-level key "${key}" — allowed keys: ${[...PROJECT_TOP_KEYS].join(', ')}`);
      }
      if (seenTop.has(key)) throw fail(i + 1, `duplicate top-level key "${key}"`);
      if (stripComment(rest).trim() !== '') {
        throw fail(i + 1, `"${key}:" must be a mapping header with nothing after the colon`);
      }
      seenTop.add(key);
      topKey = key;
      i += 1;
      continue;
    }
    if (topKey === null) throw fail(i + 1, 'unexpected indentation (no open mapping)');
    if (childIndent === -1) childIndent = indent;
    if (indent !== childIndent) {
      throw fail(i + 1, `inconsistent indentation: expected ${childIndent} space(s), found ${indent}`);
    }
    const entry = /^([^\s:]+):\s*(.*)$/.exec(content);
    if (!entry) throw fail(i + 1, `expected "key: value", got "${content}"`);
    const [, childKey, rest] = entry;
    const allowed = topKey === 'phases' ? PROJECT_TOGGLE_KEYS : PROJECT_PROMPT_KEYS;
    if (!allowed.has(childKey)) {
      throw fail(i + 1, `unknown key "${childKey}" under "${topKey}" — allowed keys: ${[...allowed].join(', ')}`);
    }
    const parsed = parseChildValue(topKey, childKey, rest, i, childIndent);
    if (topKey === 'phases') phases[childKey] = parsed.value;
    else phasePrompts[childKey] = parsed.value;
    i = parsed.nextIndex;
  }
  return Object.freeze({
    phases: Object.freeze({ ...phases }),
    phasePrompts: Object.freeze({ ...phasePrompts }),
  });
}

/**
 * Read `.factory.yml` from the session workspace root. Returns empty
 * overrides when the file is absent; throws a named-file Error when it is
 * too large or invalid.
 *
 * The root and read path follow the shipped dsh-agent-instructions pattern:
 * `agent.session.header.cwd ?? process.cwd()`, the `fs` service when
 * present (`resolve` → `stat` → `readText`, abort-aware), `node:fs`
 * otherwise.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {{session?: {header?: {cwd?: string}}}} agent the receiving agent.
 * @param {AbortSignal | undefined} signal command abort signal.
 * @returns {Promise<Readonly<{phases: Record<string, boolean>,
 *   phasePrompts: Record<string, string>}>>}
 */
async function loadProjectOverrides(ctx, agent, signal) {
  const cwd = agent?.session?.header?.cwd ?? process.cwd();
  const displayName = `${PROJECT_FILE_NAME} (workspace root ${cwd})`;
  const empty = Object.freeze({ phases: Object.freeze({}), phasePrompts: Object.freeze({}) });
  const fileSystem = typeof ctx?.get === 'function' ? ctx.get('fs') : undefined;
  let text;
  if (fileSystem !== undefined) {
    const target = await fileSystem.resolve(PROJECT_FILE_NAME, {
      cwd,
      ...(signal === undefined ? {} : { signal }),
    });
    signal?.throwIfAborted();
    const info = await fileSystem.stat(target, signal);
    signal?.throwIfAborted();
    if (info === undefined || info.type !== 'file') return empty;
    text = await fileSystem.readText(target, signal);
  } else {
    const path = join(cwd, PROJECT_FILE_NAME);
    try {
      const info = await nodeStat(path, signal === undefined ? undefined : { signal });
      if (!info.isFile()) return empty;
    } catch (error) {
      if (error && typeof error === 'object' && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return empty;
      throw error;
    }
    text = await nodeReadFile(path, { encoding: 'utf8', ...(signal === undefined ? {} : { signal }) });
  }
  signal?.throwIfAborted();
  if (text.length > PROJECT_FILE_MAX_CHARS) {
    throw new Error(`${displayName}: file is too large (${text.length} chars; max ${PROJECT_FILE_MAX_CHARS})`);
  }
  return parseFactoryYml(text, { displayName });
}

/**
 * Merge plugin row Config (defaults) with `.factory.yml` (project overrides):
 * file phase toggles win, command lists and the deploy gate stay
 * plugin-Config-only, file phasePrompts attach verbatim.
 *
 * @param {ReturnType<resolveConfig>} resolved plugin row config.
 * @param {{phases?: Record<string, boolean>, phasePrompts?: Record<string, string>}} project
 *   parsed `.factory.yml` (or empty).
 * @returns {Readonly<ReturnType<resolveConfig> & {phasePrompts: Readonly<Record<string, string>>}>}
 */
export function applyProjectOverrides(resolved, project) {
  const phases = project?.phases ?? {};
  const phasePrompts = project?.phasePrompts ?? {};
  return Object.freeze({
    ...resolved,
    plan: phases.plan ?? resolved.plan,
    implement: phases.implement ?? resolved.implement,
    guardrails: phases.guardrails ?? resolved.guardrails,
    test: phases.test ?? resolved.test,
    regression: phases.regression ?? resolved.regression,
    evaluate: phases.evaluate ?? resolved.evaluate,
    phasePrompts: Object.freeze({ ...phasePrompts }),
  });
}

/**
 * Build the full pipeline prompt steered into the agent.
 * @param {ReturnType<typeof applyProjectOverrides>} resolved effective config
 *   (plugin row Config merged with `.factory.yml` overrides + phasePrompts).
 * @param {string} request the user's raw request text (already trimmed).
 * @returns {string} markdown prompt.
 */
function buildPipelinePrompt(resolved, request) {
  const lines = [];
  lines.push('# Software factory — 8-phase delivery pipeline');
  lines.push('');
  lines.push(
    'You are running the software-factory pipeline. Work through the eight phases below strictly in order, for the user request stated at the end of this message. The pipeline is executed with DSH-native machinery only — the session\'s real tools and logs are the record of the run.',
  );
  lines.push('');
  lines.push('Ground rules:');
  lines.push('');
  lines.push(
    '- Emit one compact status line when you ENTER each phase (with your intent) and one when you LEAVE it (with the outcome), in exactly this form: `[factory] phase <n>/8 <key>: <short status>` — for example `[factory] phase 3/8 implement: 3 tasks done`.',
  );
  lines.push(
    '- Never skip an enabled phase. If a phase fails, fix and retry within that phase; if it truly cannot pass, stop and report the failure honestly instead of moving on silently.',
  );
  lines.push(
    '- A disabled phase is still announced: `[factory] phase <n>/8 <key>: skipped (disabled by configuration)`.',
  );
  lines.push(
    '- Report command results honestly: a non-zero exit code is a failure, whatever the output looks like. Quote exit codes.',
  );
  lines.push(
    '- Do not restate this directive; execute it. Keep prose between status lines short and factual.',
  );

  const enabled = (phase) => {
    if (phase.toggle === null) return true;
    if (phase.toggle === 'deploy') return deployActive(resolved);
    return resolved[phase.toggle];
  };

  for (let index = 0; index < PHASES.length; index += 1) {
    const phase = PHASES[index];
    const number = index + 1;
    lines.push('');
    lines.push(`## Phase ${number}/8 — ${phase.key}: ${phase.name}`);
    if (!enabled(phase)) {
      if (phase.key === 'deploy') {
        lines.push('');
        lines.push(
          '- Skipped: no test environment is configured (`deploy.enabled` is false, or no `deploy.command` is set). Announce `[factory] phase 6/8 deploy: skipped (no test environment configured)` and move on. Do not invent a deployment.',
        );
      } else {
        lines.push('');
        lines.push(
          `- Skipped: the "${phase.toggle}" phase toggle is disabled in the plugin config. Announce the skipped status line and move on.`,
        );
      }
      continue;
    }
    lines.push('');
    switch (phase.key) {
      case 'capture':
        lines.push('- Restate the user request in your own words: goal, deliverables, constraints, and the environment it must run in.');
        lines.push('- Derive the acceptance criteria you will evaluate against in phase 8, and keep them visible in the transcript.');
        lines.push('- Only if the request is materially ambiguous, ask the user now (ask_user_question); otherwise proceed without questions.');
        break;
      case 'plan':
        lines.push('- Break the request into concrete, individually verifiable tasks using the session\'s planning facilities: record the task list with the todo tool (one todo per task), or — when the session is in plan mode — present the plan through exit_plan_mode and continue after approval.');
        lines.push('- Give each task its expected write scope (files or directories it touches) so parallel work stays disjoint.');
        lines.push('- Planning only: do not start implementing in this phase.');
        break;
      case 'implement':
        lines.push('- Implement the tasks with the file tools (read/edit/write), honoring the planned tasks and write scopes; keep the todo list current as tasks complete.');
        if (resolved.subagentImplementation) {
          lines.push('- For larger scopes, prefer subagent delegation: one task per subagent, disjoint write scopes, and review each subagent\'s diff when it finishes before marking its task done.');
        } else {
          lines.push('- Subagent delegation is disabled by configuration (`subagentImplementation: false`): implement directly with the file tools.');
        }
        break;
      case 'guardrails': {
        const list = renderCommandList(resolved.guardrailCommand);
        if (list !== '') {
          lines.push('- Run the configured guardrail commands (lint, typecheck, format check) with the shell tool:');
          lines.push(list);
        } else {
          lines.push('- No guardrail command is configured. Discover the repository\'s standard checks (package.json scripts, Makefile targets, CI workflow steps) and run those instead; if none exist, announce the phase as skipped for that reason.');
        }
        lines.push('- Run long-running commands as background jobs and collect every result before leaving the phase.');
        lines.push('- Fix findings and re-run until clean, or report the failure honestly.');
        break;
      }
      case 'test': {
        const list = renderCommandList(resolved.testCommand);
        if (list !== '') {
          lines.push('- Run the configured test commands with the shell tool (same rules as guardrails: background jobs for long runs, honest exit codes):');
          lines.push(list);
        } else {
          lines.push('- No test command is configured. Run the test suites that exist in the repository (unit tests and whatever test suites you find) via the shell tool; if none exist, state that explicitly.');
        }
        lines.push('- Also run local/manual checks where possible — anything that exercises the change without new infrastructure — and say what you verified by hand.');
        break;
      }
      case 'deploy': {
        const list = renderCommandList(resolved.deploy.command);
        lines.push('- A test environment IS configured; deploy to it with the shell tool:');
        lines.push(list);
        lines.push('- Treat the deploy command\'s non-zero exit as a phase failure. If the command includes a smoke/verification step, include its evidence in phase 8.');
        break;
      }
      case 'regression': {
        const list = renderCommandList(resolved.regressionCommand);
        if (list !== '') {
          lines.push('- Run the configured regression suite with the shell tool (same rules as guardrails and tests):');
          lines.push(list);
        } else {
          lines.push('- No regression command is configured. Run the repository\'s regression-relevant suites as discovered in earlier phases; if none exist, announce the phase as skipped for that reason.');
        }
        lines.push('- Compare against the results recorded in phase 5: a regression is any previously passing check that now fails.');
        break;
      }
      case 'evaluate':
        lines.push('- Evaluate the delivered software against the original request and the acceptance criteria from phase 1.');
        lines.push('- Summarize the verification evidence: every command run with its exit status, suites that passed, and what was verified manually.');
        lines.push('- State limitations honestly: what was not tested, known risks, and any deferred work.');
        lines.push('- Present the deliverables (changed files and produced artifacts) as a clear list.');
        lines.push('- Finish with the final status line: `[factory] phase 8/8 evaluate: <verdict>`.');
        break;
      default:
        break;
    }
    const projectPrompt = resolved.phasePrompts?.[phase.key];
    if (typeof projectPrompt === 'string' && projectPrompt !== '') {
      lines.push('');
      lines.push(`Project instructions for this phase (appended verbatim from ${PROJECT_FILE_NAME}):`);
      lines.push('');
      lines.push(projectPrompt);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## User request');
  lines.push('');
  if (request !== '') {
    lines.push(request);
  } else {
    lines.push('(Stated in the attachments accompanying this message — treat them as the request.)');
  }
  lines.push('');
  return lines.join('\n');
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
 * Host plugin entry. Registers the `/factory` command against the optional
 * `commands` service and returns the injected fiber's disposal as cleanup.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {unknown} config raw row config (already validated via `Config`).
 * @returns {() => void} cleanup.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const projectionFiber = ctx.inject(['sessionProjections'], (projectionCtx) => {
    return projectionCtx.sessionProjections.register(factoryProjectionDefinition);
  });
  const fiber = ctx.inject(['commands'], (commandCtx) => {
    return commandCtx.commands.register({
      name: 'factory',
      description: 'Run the 8-phase software-factory delivery pipeline on a request',
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
            ? `Factory pipeline started — 8 phases in order; ${PROJECT_FILE_NAME} overrides applied. Watch for [factory] phase lines in the conversation.`
            : 'Factory pipeline started — 8 phases in order; watch for [factory] phase lines in the conversation.',
        };
      },
    });
  });
  return () => {
    fiber.dispose();
    projectionFiber.dispose();
  };
}
