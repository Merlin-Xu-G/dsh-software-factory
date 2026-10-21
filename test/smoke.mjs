/**
 * Behavioral smoke for @local/dsh-software-factory (run with the bundled
 * node, or via `npm test`).
 *
 * Client half: mounts the ModuleLoader bundle with a stubbed browser
 * environment and stub React, applies it to a fake client ctx, then checks
 * the tab-type declaration (including the guide entry that makes the tab
 * reachable), the keyed seat registrations, the inject(sessionId) observable
 * face contract, the body's rendering for the three wire-view states, and
 * the plan subpage navigation (plan row button → detail page → back).
 *
 * Host half: captures the projection definition and command definition
 * through a fake cordis ctx, folds a synthetic session log through the
 * projection (including the skip/fail/fresh-run semantics and the plan
 * capture from todo/write events), validates the wire view through the
 * schema facade, and runs the command handler against a fake agent (steer
 * capture, usage error).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

let failures = 0;
function check(label, condition, detail) {
	if (condition) {
		console.log(`ok    ${label}`);
	} else {
		failures += 1;
		console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
	}
}
function eq(label, actual, expected) {
	const equal = JSON.stringify(actual) === JSON.stringify(expected);
	check(label, equal, equal ? undefined : { actual, expected });
}

// ---------------------------------------------------------------------------
// Browser-environment stubs (the CSS-tag guard and ModuleLoader facade).
// ---------------------------------------------------------------------------
let loaderRegistration = null;
globalThis.window = {
	__ModuleLoader__: {
		load(registration) { loaderRegistration = registration; },
	},
};
const styleTags = [];
globalThis.document = {
	querySelector: () => null,
	createElement: () => ({ dataset: {}, textContent: '' }),
	head: { appendChild: (tag) => styleTags.push(tag) },
};

// Stub React: record createElement trees; useState keeps a persistent hook
// store so sequential renders behave like one mounted component. The module
// must need nothing else.
const hookStore = [];
let hookIndex = 0;
const resetHooks = () => { hookIndex = 0; };
const stubReact = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
	Fragment: Symbol.for('react.fragment'),
	useState(initial) {
		const slot = hookIndex++;
		if (hookStore.length <= slot) {
			hookStore[slot] = { value: typeof initial === 'function' ? initial() : initial };
		}
		const cell = hookStore[slot];
		return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
	},
	useEffect(effect) {
		const cleanup = effect();
		return typeof cleanup === 'function' ? cleanup : undefined;
	},
};
const requiredSpecifiers = [];
const stubRequire = (specifier) => {
	requiredSpecifiers.push(specifier);
	if (specifier === 'react') return stubReact;
	throw new Error(`unexpected require("${specifier}")`);
};

await import(pathToFileURL(join(repoRoot, 'client.js')).href);

check('client: ModuleLoader registration captured', loaderRegistration !== null);
eq('client: loader id is the package name', loaderRegistration?.id, '@local/dsh-software-factory');
check('client: factory has no side effects until called', styleTags.length === 0);

const clientExports = loaderRegistration.factory(stubRequire);
eq('client: required specifiers are exactly ["react"]', requiredSpecifiers, ['react']);
check('client: exports.apply is a function', typeof clientExports.apply === 'function');
eq('client: exports.inject', clientExports.inject, ['sidebarRightTabs', 'sidebarRight', 'slots', 'locale', 'sessions']);
check('client: CSS tag injected at materialization', styleTags.length === 1);

// Fake client ctx: cordis effect + the five injected services.
const dictionary = { zh: {}, en: {} };
let localeRegisterCalls = 0;
let tabTypeDef = null;
const slotRegisters = [];
/** Minimal observable snapshot store: set() replaces the value and notifies. */
function makeFace(initial) {
	const listeners = new Set();
	return {
		getSnapshot: () => initial,
		subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
		set(value) { initial = value; for (const listener of [...listeners]) listener(); },
	};
}
const liveView = {
	running: true,
	runCount: 0,
	autoOpen: true,
	phases: [
		{ n: 1, key: 'capture', status: 'done', text: 'request restated' },
		{ n: 2, key: 'plan', status: 'done', text: '5 tasks planned' },
		{ n: 3, key: 'implement', status: 'active', text: 'implementing task 2/5' },
		{ n: 4, key: 'review', status: 'pending', text: null },
		{ n: 5, key: 'guardrails', status: 'pending', text: null },
		{ n: 6, key: 'test', status: 'pending', text: null },
		{ n: 7, key: 'deploy', status: 'pending', text: null },
		{ n: 8, key: 'regression', status: 'pending', text: null },
		{ n: 9, key: 'evaluate', status: 'pending', text: null },
	],
	lastLine: '[factory] phase 3/9 implement: implementing task 2/5',
};
const pendingView = (runCount) => ({
	running: false,
	runCount,
	autoOpen: true,
	phases: Array.from({ length: 9 }, (_, index) => ({ n: index + 1, key: `p${index}`, status: 'pending', text: null })),
	lastLine: null,
});
const faces = {
	'session-1': makeFace(liveView),
	'session-2': makeFace(pendingView(5)),
};
const openedTabs = [];
const mountedListeners = new Set();
let mountedSessionId;
const fakeCtx = {
	effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
	locale: {
		register(ns, dicts) { localeRegisterCalls += 1; Object.assign(dictionary, dicts); return () => {}; },
		bind: () => (key) => `t:${key}`,
	},
	sidebarRightTabs: {
		register(def) { tabTypeDef = def; return () => {}; },
	},
	sidebarRight: {
		mounted: {
			getSnapshot: () => mountedSessionId,
			subscribe(listener) { mountedListeners.add(listener); return () => { mountedListeners.delete(listener); }; },
		},
		openTab(kind) { openedTabs.push(kind); },
	},
	slots: {
		inject(seat, callback) {
			const dispose = callback();
			return typeof dispose === 'function' ? dispose : () => {};
		},
		register(options, component) {
			slotRegisters.push({ options, component });
			return () => {};
		},
	},
	sessions: {
		binding(sessionId) {
			if (!(sessionId in faces)) return undefined;
			return { session: { projections: { faceOf: (key) => (key === 'factory' ? faces[sessionId] : undefined) } } };
		},
	},
};
const setMounted = (sessionId) => {
	mountedSessionId = sessionId;
	for (const listener of [...mountedListeners]) listener();
};
const clientCleanup = clientExports.apply(fakeCtx);
check('client: locale.register called once', localeRegisterCalls === 1);
check('client: tab type registered', tabTypeDef !== null);
eq('client: tab type id', tabTypeDef?.id, '@local/dsh-software-factory/factory-tab');
eq('client: tab type kind', tabTypeDef?.kind, 'factory');
eq('client: tab type priority band', tabTypeDef?.priority, 'extension');
eq('client: tab type title()', tabTypeDef?.title(), 't:tab.title');
check('client: tab type has a guide entry (the only way a patternless page type opens)',
	tabTypeDef?.guide?.length === 1);
eq('client: guide entry kind is derived (id/order/title/description present)', [
	tabTypeDef?.guide?.[0]?.id,
	typeof tabTypeDef?.guide?.[0]?.title,
	typeof tabTypeDef?.guide?.[0]?.description,
	typeof tabTypeDef?.guide?.[0]?.icon,
], ['factory', 'function', 'function', 'function']);
eq('client: guide entry title()', tabTypeDef?.guide?.[0]?.title(), 't:tab.title');

eq('client: three seat registrations (body + title)', slotRegisters.map((r) => r.options.name), [
	'sidebar.right.pane.tab',
	'sidebar.right.pane.tab.title',
]);
const bodyRegister = slotRegisters[0];
const titleRegister = slotRegisters[1];
eq('client: body keyed by the tab type id', bodyRegister.options.key, tabTypeDef.id);
eq('client: body locale namespace', bodyRegister.options.locale, 'softwareFactory');
eq('client: title keyed by the tab type id', titleRegister.options.key, tabTypeDef.id);

// The inject(sessionId) face: hooks values must be observable snapshot sources.
const face = bodyRegister.options.inject('session-1');
const hookSource = face?.hooks?.factoryState;
check('client: hooks.factoryState is the projection face (observable, not a function)',
	hookSource === faces['session-1']
	&& typeof hookSource?.getSnapshot === 'function'
	&& typeof hookSource?.subscribe === 'function',
	{ actualType: typeof hookSource });
const absentFace = bodyRegister.options.inject('unknown-session')?.hooks?.factoryState;
check('client: absent binding falls back to an absent observable (undefined snapshot)',
	absentFace !== undefined
	&& typeof absentFace?.getSnapshot === 'function'
	&& typeof absentFace?.subscribe === 'function'
	&& absentFace.getSnapshot() === undefined);

// Render the body the way the shipped renderer would: a selector hook bound
// from the observable source (uSES requires a selector argument).
function renderBody(source) {
	resetHooks();
	const useFactoryState = (selector) => selector(source.getSnapshot());
	return bodyRegister.component({ useFactoryState, t: (key) => `t:${key}` });
}
function flatten(node, out = []) {
	if (Array.isArray(node)) { for (const child of node) flatten(child, out); return out; }
	if (node && typeof node === 'object' && 'type' in node) {
		// Execute function components the way the real renderer would.
		if (typeof node.type === 'function') {
			flatten(node.type(node.props), out);
			return out;
		}
		out.push(node);
		flatten(node.children, out);
	} else if (node !== null && node !== undefined && node !== false && node !== true) {
		out.push(String(node));
	}
	return out;
}
/** First element node whose className contains the given fragment. */
function findByClass(tree, fragment) {
	return tree.find((node) => typeof node === 'object' && typeof node.props.className === 'string'
		&& node.props.className.includes(fragment));
}
const liveTree = flatten(renderBody(faces['session-1']));
const liveClasses = liveTree.filter((n) => typeof n === 'object').map((n) => n.props.className).filter(Boolean);
const isRowClass = (c) => c === 'dsf-row' || c.startsWith('dsf-row ');
check('client: live run renders 9 phase rows', liveClasses.filter(isRowClass).length === 9, { liveClasses });
check('client: active phase row highlighted', liveClasses.includes('dsf-row dsf-rowActive'));
check('client: last narration line rendered verbatim',
	liveTree.includes('[factory] phase 3/9 implement: implementing task 2/5'));
check('client: review phase row present', liveTree.includes('review'));

// Plan subpage: the plan phase row is a button that swaps the body to the
// plan detail page and back (liveView carries no plan yet — empty detail).
const planButton = findByClass(liveTree, 'dsf-rowButton');
check('client: plan phase row is a clickable button', planButton?.type === 'button' && typeof planButton?.props.onClick === 'function');
planButton.props.onClick();
const planEmptyTree = flatten(renderBody(faces['session-1']));
check('client: plan detail page opens with the empty state (no plan recorded)',
	planEmptyTree.includes('t:plan.title') && planEmptyTree.includes('t:plan.empty'));
const backButton = findByClass(planEmptyTree, 'dsf-back');
check('client: plan detail page has a back control', backButton?.type === 'button' && typeof backButton?.props.onClick === 'function');
backButton.props.onClick();
check('client: back returns to the phase list',
	flatten(renderBody(faces['session-1'])).filter((n) => typeof n === 'object'
		&& typeof n.props.className === 'string'
		&& isRowClass(n.props.className)).length === 9);
const PLAN_ITEMS = [
	{ content: 'verify todo projection contract', status: 'completed' },
	{ content: 'implement the plan detail page', status: 'in_progress' },
	{ content: 'extend the smoke suite', status: 'pending' },
];
faces['session-1'].set({ ...liveView, plan: PLAN_ITEMS });
const planListTree = flatten(renderBody(faces['session-1']));
findByClass(planListTree, 'dsf-rowButton').props.onClick();
const planDetailTree = flatten(renderBody(faces['session-1']));
check('client: plan detail page lists every todo with live status',
	planDetailTree.includes('verify todo projection contract')
	&& planDetailTree.includes('implement the plan detail page')
	&& planDetailTree.includes('extend the smoke suite')
	&& planDetailTree.some((node) => typeof node === 'object'
		&& node.props.className === 'dsf-planRow dsf-planRowActive'));
faces['session-1'].set(liveView);
resetHooks();
hookStore.length = 0;

// Queue page: nav button opens it from any body state; it polls the Host's
// read-only route (fetch stubbed) and renders items, halt banner, and back.
let queueSnapshot = { halted: false, items: [
	{ id: 'q1', status: 'succeeded', summary: 'Retention pipeline', scopes: ['src/retention/'] },
	{ id: 'q2', status: 'running', summary: 'Sidebar bug', scopes: [] },
	{ id: 'q3', status: 'failed', summary: 'Broken thing', scopes: ['src/x/'], failureReason: 'phase 5/9 guardrails failed' },
] };
globalThis.fetch = (url) => {
	eq('client: queue page polls the plugin route', url, '/plugins/@local/dsh-software-factory/queue.json');
	return Promise.resolve({ json: () => Promise.resolve(queueSnapshot) });
};
const listTree2 = flatten(renderBody(faces['session-1']));
const queueNav = listTree2.find((node) => typeof node === 'object' && node.props.className === 'dsf-navButton');
check('client: queue nav button present in the phase list', queueNav?.type === 'button' && typeof queueNav?.props.onClick === 'function');
queueNav.props.onClick();
flatten(renderBody(faces['session-1'])); // the effect fires (and fetches) during this render
await new Promise((resolve) => { setTimeout(resolve, 20); }); // data lands in the hook cell
const queueTree = flatten(renderBody(faces['session-1']));
check('client: queue page lists every item with status',
	queueTree.includes('t:queue.title') && queueTree.includes('Retention pipeline')
	&& queueTree.includes('Sidebar bug') && queueTree.includes('Broken thing')
	&& queueTree.includes('phase 5/9 guardrails failed'));
check('client: running queue item highlighted',
	queueTree.some((node) => typeof node === 'object' && node.props.className === 'dsf-queueRow dsf-planRowActive'));
queueSnapshot = { halted: true, haltedBy: 'q3', items: queueSnapshot.items };
await new Promise((resolve) => { setTimeout(resolve, 20); });
const haltedTree = flatten(renderBody(faces['session-1']));
check('client: halt banner and ack hint render',
	haltedTree.includes('t:queue.halted') && haltedTree.includes('t:queue.ackHint'));
const queueBack = haltedTree.find((node) => typeof node === 'object' && node.props.className === 'dsf-back');
check('client: queue page has a back control', queueBack?.type === 'button' && typeof queueBack?.props.onClick === 'function');
queueBack.props.onClick();
check('client: back returns to the phase list',
	flatten(renderBody(faces['session-1'])).some((node) => typeof node === 'object'
		&& typeof node.props.className === 'string' && node.props.className.startsWith('dsf-list')));
faces['session-1'].set(liveView);
resetHooks();
hookStore.length = 0;

const initialFace = { getSnapshot: () => ({ running: false, phases: Array.from({ length: 9 }, (_, i) => ({ n: i + 1, key: `p${i}`, status: 'pending', text: null })), lastLine: null }), subscribe: () => () => {} };
const emptyTree = flatten(renderBody(initialFace));
check('client: pristine session renders the empty state', emptyTree.includes('t:empty.none'));

const unavailableTree = flatten(renderBody({ getSnapshot: () => undefined, subscribe: () => () => {} }));
check('client: absent projection renders the unavailable state', unavailableTree.includes('t:empty.unavailable'));

const titleTree = flatten(titleRegister.component({ useTabInfo: () => ({ tab: { title: 'Factory' } }) }));
check('client: title chip renders glyph + captured title', titleTree.includes('Factory'));

// Auto-open watcher: only a live runCount increment in the mounted session opens.
eq('client: auto-open idle at baseline', openedTabs, []);
setMounted('session-1');
faces['session-1'].set({ ...liveView, lastLine: '[factory] phase 3/9 implement: task 3/5' });
eq('client: phase-line update (no new run) does not open', openedTabs, []);
faces['session-1'].set({ ...liveView, runCount: 1 });
eq('client: live /factory run opens the tab', openedTabs, ['factory']);
setMounted('session-2');
faces['session-1'].set({ ...liveView, runCount: 2 });
eq('client: run in a session that is no longer on screen does not open', openedTabs, ['factory']);
faces['session-2'].set(pendingView(6));
eq('client: live run in the newly mounted session opens again', openedTabs, ['factory', 'factory']);
setMounted(undefined);
faces['session-2'].set(pendingView(7));
eq('client: no on-screen session means no open', openedTabs, ['factory', 'factory']);
faces['session-2'].set({ running: false, phases: pendingView(0).phases, lastLine: null });
setMounted('session-2');
faces['session-2'].set(pendingView(8));
eq('client: version-skewed view (runCount missing) never opens', openedTabs, ['factory', 'factory']);
faces['session-2'].set({ ...pendingView(9), autoOpen: false });
eq('client: autoOpen false suppresses the open', openedTabs, ['factory', 'factory']);
faces['session-2'].set(pendingView(10));
eq('client: re-enabling autoOpen opens on the next live run', openedTabs, ['factory', 'factory', 'factory']);

check('client: apply returns a cleanup function', typeof clientCleanup === 'function');
clientCleanup();

// ---------------------------------------------------------------------------
// Host half: projection + command through a fake cordis ctx.
// ---------------------------------------------------------------------------
const host = await import(pathToFileURL(join(repoRoot, 'index.js')).href);

const defaults = host.Config['~standard'].validate(undefined).value;
eq('host: config defaults (phases on, deploy off, auto-open and grill on, queue 3)', [
	defaults.plan, defaults.implement, defaults.review, defaults.guardrails, defaults.test, defaults.regression, defaults.evaluate,
	defaults.deploy.enabled, defaults.deploy.command.length, defaults.autoOpenTab, defaults.grill, defaults.queueConcurrency,
], [true, true, true, true, true, true, true, false, 0, true, true, 3]);
const badGrill = host.Config['~standard'].validate({ queueConcurrency: 0 });
check('host: queueConcurrency must be a positive integer', badGrill.issues?.[0]?.message?.includes('queueConcurrency') === true);
const badConfig = host.Config['~standard'].validate({ planing: true });
check('host: unknown config key reported as an issue', badConfig.issues?.[0]?.message?.includes('planing') === true);

eq('host: parseFactoryYml block scalar + toggles', host.parseFactoryYml([
	'phases:',
	'  regression: false',
	'  review: false',
	'phasePrompts:',
	'  plan: |',
	'    line one',
	'    line two',
].join('\n')), { phases: { regression: false, review: false }, phasePrompts: { plan: 'line one\nline two\n' } });

const merged = host.applyProjectOverrides(
	{ plan: true, implement: true, review: true, guardrails: true, test: true, regression: true, evaluate: true, subagentImplementation: true, deploy: { enabled: false, command: [] }, guardrailCommand: [], testCommand: [], regressionCommand: [] },
	{ phases: { test: false, review: false }, phasePrompts: { test: 'use vitest' } },
);
eq('host: project overrides win for toggles and attach prompts', [merged.test, merged.regression, merged.review, merged.phasePrompts], [false, true, false, { test: 'use vitest' }]);

let projectionDef = null;
let commandDef = null;
const projectionDefs = [];
const sessionEventHandlers = [];
// The queue store must not touch the real DSH home: point the env at a temp
// dir before apply() creates the store.
const queueHome = mkdtempSync(join(tmpdir(), 'factory-queue-home-'));
const previousDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = queueHome;
const fakeHostCtx = {
	inject(deps, callback) {
		if (deps.includes('sessionProjections')) {
			callback({ sessionProjections: { register(def) { projectionDefs.push(def); projectionDef = projectionDefs[0]; return () => {}; } } });
		} else if (deps.includes('commands')) {
			callback({ commands: { register(def) { commandDef = def; return () => {}; } } });
		}
		return { dispose() {} };
	},
	on(event, handler) {
		if (event === 'session/event') sessionEventHandlers.push(handler);
		return () => {};
	},
	get() { return undefined; },
	logger: { warn() {} },
};
host.apply(fakeHostCtx, {});
check('host: projection registered through optional sessionProjections', projectionDef !== null);
check('host: command registered through optional commands', commandDef !== null);
eq('host: command definition', [
	commandDef?.name, commandDef?.description, commandDef?.input, commandDef?.recordInput,
], [
	'factory', 'Run the 9-phase software-factory delivery pipeline on a request',
	{ hint: '[-q|--queue] <request> | queue [ack [id]]', attachments: true }, false,
]);

const assistantEvent = (seq, text) => ({
	seq, time: seq, type: 'assistant/message',
	data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
});
const otherEvent = (seq) => ({ seq, time: seq, type: 'tool/result', data: { message: { role: 'tool', content: [] } } });

let state = projectionDef.init({}, 0);
const log = [
	assistantEvent(1, 'Before anything.'),
	otherEvent(2),
	assistantEvent(3, '[factory] phase 1/9 capture: request restated\nworking…'),
	assistantEvent(4, '[factory] phase 2/9 plan: 5 tasks planned'),
	assistantEvent(5, '[factory] phase 3/9 implement: entering'),
	assistantEvent(6, '[factory] phase 4/9 review: diff reviewed, 2 findings fixed'),
	assistantEvent(7, '[factory] phase 5/9 guardrails: lint+typecheck clean'),
	assistantEvent(8, '[factory] phase 6/9 test: 42 passed'),
	assistantEvent(9, '[factory] phase 7/9 deploy: skipped (no test environment configured)'),
	assistantEvent(10, '[factory] phase 8/9 regression: no suite exists, skipped'),
	assistantEvent(11, '[factory] phase 9/9 evaluate: verdict — all acceptance criteria met'),
];
for (const event of log) state = projectionDef.apply(state, event);
const view = projectionDef.wire.view(state);
projectionDef.wire.viewSchema.parse(view);
projectionDef.stateSchema.parse(state);
eq('host: folded statuses after a full run', view.phases.map((p) => p.status),
	['done', 'done', 'done', 'done', 'done', 'done', 'skipped', 'skipped', 'done']);
eq('host: run finished', view.running, false);
eq('host: lastLine kept verbatim', view.lastLine, '[factory] phase 9/9 evaluate: verdict — all acceptance criteria met');

// Failure + fresh-run semantics.
let state2 = projectionDef.init({}, 0);
for (const event of [
	assistantEvent(1, '[factory] phase 1/9 capture: restated'),
	assistantEvent(2, '[factory] phase 2/9 plan: failed to converge, blocked'),
]) state2 = projectionDef.apply(state2, event);
const view2 = projectionDef.wire.view(state2);
eq('host: blocked text marks the phase failed', view2.phases[1].status, 'failed');
eq('host: failed run stays running (until phase 9 or a fresh run)', view2.running, true);
state2 = projectionDef.apply(state2, assistantEvent(3, '[factory] phase 1/9 capture: retry'));
const view3 = projectionDef.wire.view(state2);
eq('host: phase-1 line after a settled run starts a fresh run', [view3.phases[0].status, view3.phases[1].status], ['active', 'pending']);

// The nine-phase identity rejects legacy eight-phase states (the v4 bump).
let legacyRejected = false;
try {
	projectionDef.stateSchema.parse({
		running: false, runCount: 0, lastLine: null,
		phases: Array.from({ length: 8 }, (_, i) => ({ n: i + 1, key: `p${i}`, status: 'pending', text: null })),
	});
} catch {
	legacyRejected = true;
}
check('host: legacy eight-phase state rejected (stateVersion 4 refolds it)', legacyRejected);

// /factory command runs fold into runCount (the client auto-open signal).
const commandRun = (seq, name) => ({
	seq, time: seq, type: 'command/run',
	data: { commandId: `c${seq}`, name, source: { kind: 'user' } },
});
let stateRuns = projectionDef.init({}, 0);
for (const event of [
	commandRun(1, 'plan'),
	commandRun(2, 'factory'),
	assistantEvent(3, '[factory] phase 1/9 capture: restated'),
	commandRun(4, 'factory'),
	assistantEvent(5, '[factory] phase 9/9 evaluate: done'),
]) stateRuns = projectionDef.apply(stateRuns, event);
const viewRuns = projectionDef.wire.view(stateRuns);
projectionDef.wire.viewSchema.parse(viewRuns);
eq('host: runCount counts only /factory command runs', viewRuns.runCount, 2);
eq('host: default wire view carries autoOpen on', viewRuns.autoOpen, true);
eq('host: entering the final phase closes the earlier phases as done', [viewRuns.phases[0].status, viewRuns.phases[7].status], ['done', 'done']);
stateRuns = projectionDef.apply(stateRuns, assistantEvent(6, '[factory] phase 1/9 capture: second run'));
const viewRuns2 = projectionDef.wire.view(stateRuns);
projectionDef.wire.viewSchema.parse(viewRuns2);
eq('host: a phase-1 line resets the board and runCount survives it',
	[viewRuns2.phases[0].status, viewRuns2.phases[1].status, viewRuns2.runCount],
	['active', 'pending', 2]);

// The run's plan: todo/write lists fold into a durable `plan` while the run
// is active; writes outside a run never touch it, and a fresh run clears it.
const todoWrite = (seq, todos) => ({ seq, time: seq, type: 'todo/write', data: { todos } });
let statePlan = projectionDef.init({}, 0);
statePlan = projectionDef.apply(statePlan, todoWrite(1, [{ content: 'pre-run todo', status: 'pending' }]));
eq('host: todo writes outside a run are ignored', projectionDef.wire.view(statePlan).plan, null);
statePlan = projectionDef.apply(statePlan, assistantEvent(2, '[factory] phase 1/9 capture: restated'));
statePlan = projectionDef.apply(statePlan, todoWrite(3, [
	{ content: 'verify contract', status: 'completed' },
	{ content: 'implement page', status: 'in_progress' },
]));
const viewPlan = projectionDef.wire.view(statePlan);
projectionDef.wire.viewSchema.parse(viewPlan);
eq('host: todo writes during an active run fold into the plan',
	viewPlan.plan,
	[{ content: 'verify contract', status: 'completed' }, { content: 'implement page', status: 'in_progress' }]);
statePlan = projectionDef.apply(statePlan, assistantEvent(4, '[factory] phase 9/9 evaluate: done'));
statePlan = projectionDef.apply(statePlan, todoWrite(5, [{ content: 'unrelated later todo', status: 'pending' }]));
const viewPlanDone = projectionDef.wire.view(statePlan);
projectionDef.wire.viewSchema.parse(viewPlanDone);
eq('host: the settled run keeps its plan against later todo writes', viewPlanDone.plan?.length, 2);
statePlan = projectionDef.apply(statePlan, assistantEvent(6, '[factory] phase 1/9 capture: fresh run'));
const viewPlanFresh = projectionDef.wire.view(statePlan);
projectionDef.wire.viewSchema.parse(viewPlanFresh);
eq('host: a fresh run clears the plan until phase 2 writes one', viewPlanFresh.plan, null);

// Command handler against a fake agent.
const steered = [];
const workspace = mkdtempSync(join(tmpdir(), 'factory-smoke-'));
const fakeAgent = {
	session: { header: { cwd: workspace } },
	steer: (message) => steered.push(message),
};
const usageError = await commandDef.handler({ agent: fakeAgent, rawInput: '   ', attachments: [], signal: undefined });
eq('host: empty request is a usage error', usageError.kind, 'error');
const run = await commandDef.handler({ agent: fakeAgent, rawInput: 'Add CSV export', attachments: [], signal: undefined });
eq('host: valid request succeeds', run.kind, 'success');
eq('host: exactly one steered message', steered.length, 1);
const steeredText = steered[0]?.content?.find((block) => block?.type === 'text')?.text ?? '';
check('host: steered message carries the pipeline prompt and the request',
	steeredText.includes('# Software factory — 9-phase delivery pipeline') && steeredText.includes('Add CSV export'));
eq('host: steered message shape matches createUserMessage', [
	steered[0]?.role, steered[0]?.source, typeof steered[0]?.id, Object.isFrozen(steered[0]),
], ['user', { kind: 'user' }, 'string', true]);

// autoOpenTab: false builds a projection whose wire view suppresses the open.
host.apply(fakeHostCtx, { autoOpenTab: false });
eq('host: two projection registrations captured', projectionDefs.length, 2);
const defOff = projectionDefs[1];
const viewOff = defOff.wire.view(defOff.init({}, 0));
defOff.wire.viewSchema.parse(viewOff);
defOff.stateSchema.parse(defOff.init({}, 0));
eq('host: autoOpenTab=false flows into the wire view as autoOpen false', viewOff.autoOpen, false);

// ---------------------------------------------------------------------------
// Queue store: the durable state machine over a temp dir.
// ---------------------------------------------------------------------------
const storeDir = mkdtempSync(join(tmpdir(), 'factory-queue-store-'));
const store = host.createQueueStore({ dir: storeDir });
const itemA = await store.enqueue({ request: 'Build the retention pipeline', workspace: '/repo/a', scopes: ['src/retention/'] });
const itemB = await store.enqueue({ request: 'Fix the sidebar bug', workspace: '/repo/a', scopes: ['src/sidebar/'] });
const itemC = await store.enqueue({ request: 'Same-area change', workspace: '/repo/a', scopes: ['src/retention/deep/'] });
const itemD = await store.enqueue({ request: 'Other repo change', workspace: '/repo/b', scopes: ['src/'] });
eq('host: queue: enqueue assigns FIFO ids', [itemA.id, itemB.id, itemC.id, itemD.id], ['q1', 'q2', 'q3', 'q4']);
await store.markRunning(itemA.id, 'worker-aaaa');
eq('host: queue: overlapping scope blocks, other workspace passes', [
	(await store.pickNext(3))?.id, (await store.markRunning(itemB.id, 'worker-bbbb'), await store.pickNext(3))?.id,
], [itemB.id, itemD.id]);
eq('host: queue: concurrency cap respected', (await store.pickNext(2)) === null, true);
await store.markSucceeded(itemA.id);
eq('host: queue: freed scope unblocks the queued item', (await store.pickNext(3))?.id, itemC.id);
await store.markRunning(itemC.id, 'worker-cccc');
await store.markFailed(itemC.id, 'phase 5/9 guardrails failed: lint exit 1');
const halted = await store.snapshot();
eq('host: queue: failure halts the queue', [halted.halted, halted.haltedBy], [true, itemC.id]);
eq('host: queue: halt blocks new starts', (await store.pickNext(3)) === null, true);
eq('host: queue: ack with the wrong id is refused', await store.ack('q1'), false);
eq('host: queue: ack resumes the queue', await store.ack(itemC.id), true);
eq('host: queue: ack leaves the failed item failed',
	(await store.find(itemC.id))?.status, 'failed');
// Crash recovery: a fresh store over the same dir re-queues running items.
const itemE = await store.enqueue({ request: 'Crash victim', workspace: '/repo/a', scopes: ['docs/'] });
await store.markRunning(itemE.id, 'worker-eeee');
const recovered = host.createQueueStore({ dir: storeDir });
eq('host: queue: crash recovery re-queues running items', (await recovered.find(itemE.id))?.status, 'queued');

// ---------------------------------------------------------------------------
// Enqueue listener + queue command grammar (against the temp DSH home).
// ---------------------------------------------------------------------------
const tick = () => new Promise((resolve) => { setTimeout(resolve, 20); });
const fireSessionEvent = (event) => {
	for (const handler of sessionEventHandlers) handler({ id: 'session-x', header: { cwd: workspace } }, event);
};
fireSessionEvent(assistantEvent(7, 'All settled.\n[factory] enqueue: {"request":"Build the retention pipeline","summary":"Retention","scopes":["src/"],"clarifications":[{"question":"Cap where?","answer":"At injection."}]}'));
await tick();
await tick();
const liveStore = host.createQueueStore({ dir: join(queueHome, 'factory-queue') });
const queueAfterLine = await liveStore.snapshot();
const enqueued = queueAfterLine.items.find((item) => item.summary === 'Retention');
check('host: enqueue line creates a queue item with payload and answers',
	enqueued !== undefined && enqueued.status === 'queued'
	&& enqueued.request === 'Build the retention pipeline'
	&& enqueued.scopes.join(',') === 'src/'
	&& enqueued.clarifications[0]?.answer === 'At injection.'
	&& enqueued.sourceEvent === 'session-x:7',
	{ items: queueAfterLine.items.map((item) => item.summary) });
fireSessionEvent(assistantEvent(7, '[factory] enqueue: {"request":"Build the retention pipeline","summary":"Retention","scopes":["src/"],"clarifications":[]}'));
await tick();
eq('host: enqueue listener is idempotent per event seq',
	(await liveStore.snapshot()).items.filter((item) => item.summary === 'Retention').length, 1);

const queueStatus = await commandDef.handler({ agent: fakeAgent, rawInput: 'queue', attachments: [], signal: undefined });
eq('host: /factory queue returns status text', [queueStatus.kind, queueStatus.text?.startsWith('Factory queue (concurrency 3):')], ['success', true]);
const ackNothing = await commandDef.handler({ agent: fakeAgent, rawInput: 'queue ack', attachments: [], signal: undefined });
eq('host: /factory queue ack with no halt is an error', ackNothing.kind, 'error');
steered.length = 0;
const enqueueRun = await commandDef.handler({ agent: fakeAgent, rawInput: '--queue Build the exporter', attachments: [], signal: undefined });
eq('host: /factory --queue succeeds and steers the interview', enqueueRun.kind, 'success');
const directive = steered[0]?.content?.find((block) => block?.type === 'text')?.text ?? '';
check('host: enqueue directive carries the interview contract and request',
	directive.includes('Factory queue enqueue interview')
	&& directive.includes('Build the exporter')
	&& directive.includes('NO batch limit')
	&& directive.includes('[factory] enqueue:'));
const enqueueQ = await commandDef.handler({ agent: fakeAgent, rawInput: '-q Another task', attachments: [], signal: undefined });
check('host: -q short flag also enqueues', enqueueQ.kind === 'success' && steered.length === 2);

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures} failing checks)`);
process.exit(failures === 0 ? 0 : 1);
