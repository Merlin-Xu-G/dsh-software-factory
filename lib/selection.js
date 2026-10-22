/**
 * Worker model-selection capture and resolution.
 *
 * Queue workers inherit the START session's model and thinking effort: the
 * enqueue listener snapshots that session's effective selection host-side
 * (exactly how the session controller's own `selectionFor` reads it —
 * pending `model/selection` event first, then the last `request/header`
 * with adapter-defaulted effort skipped, then the global default
 * selection, which carries its `reasoningEffort`) and stores the snapshot
 * on the durable queue item, so retries and crash recovery resume under
 * the same selection. The enqueue JSON line may name `provider`,
 * `model`, or `reasoningEffort` per-field on top of the snapshot; invalid
 * or unresolvable fields are dropped leniently. The session's MODE — its
 * current agent preset (Standard, Creator, …), read from the `agentPreset`
 * Session projection exactly like the controller's `presetForSession` —
 * is captured the same way and inherited by the worker.
 */
/**
 * Validate and normalize one selection-shaped value.
 * @param {unknown} raw
 * @returns {{provider: string, model: string, reasoningEffort?: string} | null}
 *   the normalized selection, or null when invalid.
 */
export function normalizeSelection(raw) {
	if (typeof raw !== 'object' || raw === null) return null;
	const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
	const model = typeof raw.model === 'string' ? raw.model.trim() : '';
	if (provider === '' || model === '') return null;
	const reasoningEffort = typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort.trim() : '';
	return {
		provider,
		model,
		...(reasoningEffort === '' ? {} : { reasoningEffort }),
	};
}

/**
 * Read the global default selection — the same source every shipped
 * agent-creation site uses — INCLUDING its reasoning effort.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @returns {{provider: string, model: string, reasoningEffort?: string} | null}
 */
export function defaultSelection(ctx) {
	const defaultModel = ctx.get('agentDefaultModel');
	if (defaultModel === undefined) return null;
	return normalizeSelection(defaultModel.currentSelection?.());
}

/**
 * Read one session's effective model selection host-side, mirroring the
 * session controller's own `selectionFor` getter exactly:
 * 1. a pending `model/selection` event (the modelSelection projection's
 *    `pending` — selected by the user but not yet consumed by a request),
 * 2. else the session's last `request/header` (`session.requestHeader()`),
 *    keeping its reasoning effort only when the header does not mark the
 *    effort as an adapter default (`adapterDefaults.reasoningEffort`),
 * 3. else the global default selection (effort included).
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {object} session the start session (the `session/event` subject).
 * @returns {{provider: string, model: string, reasoningEffort?: string} | null}
 */
export function captureSessionSelection(ctx, session) {
	const projections = ctx.get('sessionProjections');
	let pending = null;
	try {
		pending = projections?.stateOf?.(session, 'modelSelection')?.pending ?? null;
	} catch {
		pending = null;
	}
	const fromPending = normalizeSelection(pending);
	if (fromPending !== null) return fromPending;
	const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined;
	const config = header?.config;
	if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
		// Skip an adapter-defaulted effort: the header marks which fields the
		// adapter filled in, and an adapter default is not the user's choice.
		const adapterDefaulted = header.adapterDefaults?.reasoningEffort === true;
		return normalizeSelection({
			provider: config.provider,
			model: config.model,
			...(config.reasoningEffort === undefined || adapterDefaulted ? {} : { reasoningEffort: config.reasoningEffort }),
		});
	}
	return defaultSelection(ctx);
}

/**
 * Read one session's current MODE — its agent preset id (Standard,
 * Creator, …) — from the `agentPreset` Session projection, exactly like
 * the session controller's `presetForSession`. The projection starts from
 * the creation header and advances on `agent-preset/selected` events, so
 * a mode switched mid-session is picked up. Null when no preset is
 * recorded (the worker then runs the default preset, as before).
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {object} session the start session (the `session/event` subject).
 * @returns {string | null} the preset id, or null.
 */
export function captureSessionPreset(ctx, session) {
	const projections = ctx.get('sessionProjections');
	try {
		const preset = projections?.stateOf?.(session, 'agentPreset');
		return typeof preset === 'string' && preset.trim() !== '' ? preset : null;
	} catch {
		return null;
	}
}

/**
 * Apply the enqueue JSON's optional `provider` / `model` /
 * `reasoningEffort` fields onto a captured selection, per-field (each field
 * the JSON names replaces that field; a name the JSON omits keeps the
 * captured value). Invalid values (wrong type, blank) are dropped
 * leniently, keeping the captured field instead.
 * @param {{provider: string, model: string, reasoningEffort?: string} | null} captured
 * @param {unknown} payload the parsed enqueue JSON line.
 * @returns {{provider: string, model: string, reasoningEffort?: string} | null}
 *   the merged selection, or null when neither side supplies provider+model.
 */
export function applySelectionOverrides(captured, payload) {
	const base = captured ?? { provider: '', model: '' };
	if (typeof payload !== 'object' || payload === null) return captured;
	const field = (key) => (typeof payload[key] === 'string' && payload[key].trim() !== ''
		? payload[key].trim()
		: undefined);
	return normalizeSelection({
		provider: field('provider') ?? base.provider,
		model: field('model') ?? base.model,
		reasoningEffort: field('reasoningEffort') ?? base.reasoningEffort,
	});
}

/**
 * Whether a selection's provider and model are currently advertised by the
 * host `llm` registry (the controller's own availability check). Without
 * an llm service the selection is assumed available — the worker start
 * itself will surface any real problem.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {{provider: string, model: string}} selection
 * @returns {Promise<boolean>}
 */
export async function modelAvailable(ctx, selection) {
	const llm = ctx.get('llm');
	if (llm === undefined || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
		return true;
	}
	try {
		if (!llm.listProviders().some((provider) => provider?.id === selection.provider)) return false;
		const models = await llm.listModels(selection.provider);
		return models.some((model) => model?.id === selection.model);
	} catch {
		return false;
	}
}

/**
 * Resolve the selection snapshot to store on a NEW queue item: the start
 * session's captured selection, refined by the enqueue JSON's optional
 * per-field model overrides (invalid fields dropped, an unresolvable
 * merged result falling back to the captured selection, then the global
 * default). Returns null only when nothing valid exists at all.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {object} session the start session.
 * @param {unknown} payload the parsed enqueue JSON line.
 * @returns {Promise<{provider: string, model: string, reasoningEffort?: string} | null>}
 */
export async function resolveEnqueueSelection(ctx, session, payload) {
	const captured = captureSessionSelection(ctx, session);
	const merged = applySelectionOverrides(captured, payload);
	// Only a JSON-named provider/model can make the merged result
	// unresolvable (an effort-only change swaps no route); a captured model
	// that later goes missing is a worker-START fallback, not an enqueue one.
	const routeChanged = merged !== null && captured !== null
		&& (merged.provider !== captured.provider || merged.model !== captured.model);
	if (routeChanged && !(await modelAvailable(ctx, merged))) {
		// Lenient: the JSON-named fields produced something unresolvable —
		// drop them and keep the valid remainder (captured, then default).
		if (captured !== null && await modelAvailable(ctx, captured)) return captured;
		return defaultSelection(ctx);
	}
	return merged ?? defaultSelection(ctx);
}
