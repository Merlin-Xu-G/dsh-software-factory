/**
 * The per-project `.factory.yml` override layer: the strict-subset parser,
 * the workspace-root reader (fs service with a node:fs fallback), and the
 * merge into the resolved plugin row Config. Invalid input is always a loud,
 * named-file, named-line error; a missing file changes nothing.
 */
import { readFile as nodeReadFile, stat as nodeStat } from 'node:fs/promises';
import { join } from 'node:path';

/** The per-project file this plugin reads from the session workspace root. */
export const PROJECT_FILE_NAME = '.factory.yml';

/** Phase toggles a `.factory.yml` may override (deploy stays plugin-Config-only). */
const PROJECT_TOGGLE_KEYS = new Set([
  'plan',
  'implement',
  'review',
  'guardrails',
  'test',
  'regression',
  'evaluate',
]);

/** Phases a `.factory.yml` `phasePrompts` entry may target (deploy prompts DO apply). */
const PROJECT_PROMPT_KEYS = new Set([
  'plan',
  'implement',
  'review',
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
 * Parse the `.factory.yml` subset. Dependency-free on purpose; the supported
 * grammar (documented in README) is exactly:
 *
 * - optional blank lines and `#` comments anywhere;
 * - two top-level mapping headers `phases:` and `phasePrompts:` (each at
 *   most once, nothing after the colon);
 * - nested entries at one consistent indentation (spaces only — tabs are an
 *   error), `key: value` on a single line;
 * - `phases.<key>`: `plan|implement|review|guardrails|test|regression|
 *   evaluate` = `true` or `false` (exactly; `yes`/`True` are errors);
 * - `phasePrompts.<key>`: `plan|implement|review|guardrails|test|deploy|
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
export async function loadProjectOverrides(ctx, agent, signal) {
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
 * @param {ReturnType<import('./config.js').resolveConfig>} resolved
 *   plugin row config.
 * @param {{phases?: Record<string, boolean>, phasePrompts?: Record<string, string>}} project
 *   parsed `.factory.yml` (or empty).
 * @returns {Readonly<object & {phasePrompts: Readonly<Record<string, string>>}>}
 */
export function applyProjectOverrides(resolved, project) {
  const phases = project?.phases ?? {};
  const phasePrompts = project?.phasePrompts ?? {};
  return Object.freeze({
    ...resolved,
    plan: phases.plan ?? resolved.plan,
    implement: phases.implement ?? resolved.implement,
    review: phases.review ?? resolved.review,
    guardrails: phases.guardrails ?? resolved.guardrails,
    test: phases.test ?? resolved.test,
    regression: phases.regression ?? resolved.regression,
    evaluate: phases.evaluate ?? resolved.evaluate,
    phasePrompts: Object.freeze({ ...phasePrompts }),
  });
}
