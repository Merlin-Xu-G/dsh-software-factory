/**
 * Plugin row Config: the declarative surface every `/factory` run reads.
 * Unknown keys fail at activation (the plan-mode `resolveConfig` pattern) so
 * typos never silently disable a phase. Dependency-free on purpose: a local
 * bundle must not need zod or Schemastery installed beside it.
 */

/** Top-level keys allowed in the plugin row Config. */
const TOP_LEVEL_KEYS = new Set([
  'plan',
  'implement',
  'review',
  'guardrails',
  'test',
  'deploy',
  'regression',
  'evaluate',
  'guardrailCommand',
  'testCommand',
  'regressionCommand',
  'subagentImplementation',
  'autoOpenTab',
  'grill',
  'queueConcurrency',
]);

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
 * Read a positive-integer option (>= 1).
 * @param {Record<string, unknown>} raw owner object of the field.
 * @param {string} name field name for diagnostics.
 * @param {number} fallback value used when the field is absent.
 * @returns {number}
 */
function readPositiveInt(raw, name, fallback) {
  const value = raw[name] === undefined ? fallback : raw[name];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`software-factory config "${name}" must be a positive integer`);
  }
  return value;
}

/**
 * Validate and normalize the plugin config. Unknown keys fail at activation
 * (the plan-mode `resolveConfig` pattern) so typos never silently disable a
 * phase.
 *
 * @param {unknown} input raw row config; `{}`/`undefined` selects defaults.
 * @returns {Readonly<{plan: boolean, implement: boolean, review: boolean,
 *   guardrails: boolean,
 *   test: boolean, regression: boolean, evaluate: boolean,
 *   subagentImplementation: boolean, autoOpenTab: boolean,
 *   grill: boolean, queueConcurrency: number,
 *   deploy: {enabled: boolean, command: readonly string[]},
 *   guardrailCommand: readonly string[], testCommand: readonly string[],
 *   regressionCommand: readonly string[]}>}
 */
export function resolveConfig(input) {
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
    review: readBoolean(raw, 'review', true),
    guardrails: readBoolean(raw, 'guardrails', true),
    test: readBoolean(raw, 'test', true),
    regression: readBoolean(raw, 'regression', true),
    evaluate: readBoolean(raw, 'evaluate', true),
    subagentImplementation: readBoolean(raw, 'subagentImplementation', true),
    autoOpenTab: readBoolean(raw, 'autoOpenTab', true),
    grill: readBoolean(raw, 'grill', true),
    queueConcurrency: readPositiveInt(raw, 'queueConcurrency', 3),
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
 * Whether the deploy phase may run: it must be enabled AND name a command.
 * Deploying is the one phase that is off until explicitly configured.
 * @param {ReturnType<resolveConfig>} resolved
 * @returns {boolean}
 */
export function deployActive(resolved) {
  return resolved.deploy.enabled && resolved.deploy.command.length > 0;
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
