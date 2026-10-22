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
eq('client: exports.inject', clientExports.inject, ['sidebarRightTabs', 'sidebarRight', 'uiWorkspace', 'slots', 'locale', 'sessions']);
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
const openedSessions = [];
const mountedListeners = new Set();
let mountedSessionId;
const fakeCtx = {
	effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
	locale: {
		register(ns, dicts) { localeRegisterCalls += 1; Object.assign(dictionary, dicts); return () => {}; },
		bind: () => (key) => `t:${key}`,
	},
	uiWorkspace: {
		openSession(target) { openedSessions.push(target); },
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

eq('client: four seat registrations (tab body + title + queue panel + rail icon)',
	slotRegisters.map((r) => r.options.name), [
		'sidebar.right.pane.tab',
		'sidebar.right.pane.tab.title',
		'main',
		'sidebar.panellist',
	]);
const bodyRegister = slotRegisters[0];
const titleRegister = slotRegisters[1];
const panelRegister = slotRegisters[2];
const railRegister = slotRegisters[3];
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

// Queue panel (the left-sidebar global panel): the rail entry + main-slot
// page registrations, then the page itself — it polls the Host's read-only
// route (fetch stubbed) while mounted and renders the stats strip, items,
// halt banner, and action chips. The tab body has no queue nav any more.
let queueSnapshot = { halted: false, stats: { queued: 0, running: 1, succeeded: 1, failed: 1, runningVsCap: '1/3' }, items: [
	{ id: 'q1', status: 'succeeded', summary: 'Retention pipeline', scopes: ['src/retention/'], workerSessionId: 'ws-1' },
	{ id: 'q2', status: 'running', summary: 'Sidebar bug', scopes: [], workerSessionId: 'ws-2',
		agentPreset: 'creator',
		selection: { provider: 'p-sess', model: 'm-sess', reasoningEffort: 'high' } },
	{ id: 'q3', status: 'failed', summary: 'Broken thing', scopes: ['src/x/'], failureReason: 'phase 5/9 guardrails failed: lint exit 1 (last: [factory] phase 5/9 guardrails: entering)', workerSessionId: 'ws-3',
		selection: { provider: 'p-gone', model: 'm-gone' },
		modelNote: 'captured model p-gone/m-gone is unavailable — running on the default selection' },
] };
const fetchCalls = [];
globalThis.fetch = (url, options) => {
	fetchCalls.push({ url, options });
	return Promise.resolve({ status: 200, json: () => Promise.resolve(queueSnapshot) });
};
const listTree2 = flatten(renderBody(faces['session-1']));
check('client: tab body carries no queue nav button (the queue moved to the panel)',
	!listTree2.some((node) => typeof node === 'object' && node.props.className === 'dsf-navButton'));
eq('client: queue panel page keyed under main by the panel id', [
	panelRegister.options.name, panelRegister.options.key, panelRegister.options.locale,
], ['main', '@local/dsh-software-factory/queue-panel', 'softwareFactory']);
eq('client: rail entry lists the panel id (first plugin-contributed icon)', [
	railRegister.options.name, railRegister.options.id, railRegister.options.order, railRegister.options.label(),
], ['sidebar.panellist', '@local/dsh-software-factory/queue-panel', -10, 't:panel.title']);
const railTree = flatten(railRegister.component({ size: 18, active: false }));
check('client: rail icon is the factory glyph at the rail size',
	railTree.some((node) => typeof node === 'object' && node.type === 'svg' && node.props.width === 18));
const renderPanel = () => {
	resetHooks();
	return flatten(panelRegister.component({ t: (key) => `t:${key}` }));
};
renderPanel(); // the panel's mount effect fires (and fetches)
await new Promise((resolve) => { setTimeout(resolve, 20); }); // data lands in the hook cell
const queueTree = renderPanel();
const itemLegs = ['t:queue.title', 'Retention pipeline', 'Sidebar bug', 'Broken thing'];
check('client: queue panel lists every item with status',
	itemLegs.every((leg) => queueTree.includes(leg))
	&& queueTree.some((node) => typeof node === 'string' && node.includes('phase 5/9 guardrails failed')));
check('client: stats strip renders running-vs-cap and counts from the read model',
	queueTree.some((node) => typeof node === 'string'
		&& node.includes('1/3 t:queue.item.running')
		&& node.includes('0 t:queue.item.queued')
		&& node.includes('1 t:queue.item.failed')),
	{ strip: queueTree.filter((node) => typeof node === 'string' && node.includes('t:queue.item.running')) });
check('client: running queue item highlighted',
	queueTree.some((node) => typeof node === 'object' && node.props.className === 'dsf-queueRow dsf-planRowActive'));
check('client: queue items render as a semantic ul of li rows',
	queueTree.some((node) => typeof node === 'object' && node.type === 'ul' && node.props.className === 'dsf-queueList')
	&& queueTree.filter((node) => typeof node === 'object' && node.type === 'li'
		&& typeof node.props.className === 'string' && node.props.className.startsWith('dsf-queueRow')).length === 3);
check('client: queue rows drop the item-number prefix',
	!queueTree.some((node) => typeof node === 'string' && /^\[q\d+\]$/.test(node)));
check('client: model·effort chip renders per selection-bearing item (effort appended when set)',
	queueTree.some((node) => typeof node === 'string' && node.includes('p-sess/m-sess · high')));
check('client: the chip leads with the inherited MODE when one was captured',
	queueTree.some((node) => typeof node === 'string' && node.includes('creator · p-sess/m-sess · high')));
check('client: model chip omits the effort when none was captured, and the fallback note shows',
	queueTree.some((node) => typeof node === 'string' && node.includes('p-gone/m-gone'))
	&& !queueTree.some((node) => typeof node === 'string' && /p-gone\/m-gone ·/.test(node))
	&& queueTree.some((node) => typeof node === 'string'
		&& node.includes('captured model p-gone/m-gone is unavailable')));
check('client: panel has no back control (it is a top-level page, not a subpage)',
	!queueTree.some((node) => typeof node === 'object' && typeof node.props.className === 'string'
		&& node.props.className.includes('dsf-back')));
queueSnapshot = { halted: true, haltedBy: 'q3', stats: queueSnapshot.stats, items: queueSnapshot.items };
await new Promise((resolve) => { setTimeout(resolve, 20); });
const haltedTree = renderPanel();
check('client: halt banner and ack hint render',
	haltedTree.includes('t:queue.halted') && haltedTree.includes('t:queue.ackHint'));
// Open button jumps to the worker session; Retry posts the action then refreshes.
const openButtons = haltedTree.filter((node) => typeof node === 'object'
	&& node.props.className === 'dsf-queueAction');
eq('client: queue rows carry one Open button per session-bearing item', openButtons.length, 3);
openButtons[2].props.onClick();
eq('client: Open jumps to the worker session (plain session id)', openedSessions, ['ws-3']);
const retryButtons = haltedTree.filter((node) => typeof node === 'object'
	&& node.props.className === 'dsf-queueAction dsf-queueActionRetry');
eq('client: exactly the failed item has a Retry button', retryButtons.length, 1);
fetchCalls.length = 0;
retryButtons[0].props.onClick();
await new Promise((resolve) => { setTimeout(resolve, 20); });
const retryPost = fetchCalls.find((call) => call.options?.method === 'POST');
check('client: Retry posts the action with the CSRF header',
	retryPost?.url === '/plugins/@local/dsh-software-factory/queue.json'
	&& retryPost?.options?.headers?.['x-dsh-factory-action'] === 'queue'
	&& retryPost?.options?.body === '{"action":"retry","id":"q3"}', { retryPost });
const removeButtons = haltedTree.filter((node) => typeof node === 'object'
	&& node.props.className === 'dsf-queueAction dsf-queueActionRemove');
eq('client: every queue row has a Remove button', removeButtons.length, 3);
fetchCalls.length = 0;
removeButtons[0].props.onClick();
await new Promise((resolve) => { setTimeout(resolve, 20); });
const removePost = fetchCalls.find((call) => call.options?.method === 'POST');
check('client: Remove posts the action for that item',
	removePost?.options?.body === '{"action":"remove","id":"q1"}'
	&& removePost?.options?.headers?.['x-dsh-factory-action'] === 'queue', { removePost });
// Clean button: inline two-step confirm sweeping EXACTLY the finished rows
// (succeeded AND failed) through the per-item remove action, then
// auto-resetting.
queueSnapshot = { halted: false, stats: { queued: 1, running: 1, succeeded: 2, failed: 1, runningVsCap: '1/3' }, items: [
	{ id: 'q1', status: 'succeeded', summary: 'Retention pipeline', scopes: ['src/retention/'], workerSessionId: 'ws-1' },
	{ id: 'q2', status: 'running', summary: 'Sidebar bug', scopes: [], workerSessionId: 'ws-2' },
	{ id: 'q3', status: 'failed', summary: 'Broken thing', scopes: ['src/x/'], workerSessionId: 'ws-3' },
	{ id: 'q4', status: 'queued', summary: 'Queued thing', scopes: [] },
	{ id: 'q5', status: 'succeeded', summary: 'Exporter', scopes: ['src/export/'], workerSessionId: 'ws-5' },
] };
renderPanel(); // the panel effect fires (and refetches)
await new Promise((resolve) => { setTimeout(resolve, 20); });
const cleanButton = findByClass(renderPanel(), 'dsf-queueActionClean');
check('client: Clean button present and enabled while finished items exist',
	cleanButton?.type === 'button' && typeof cleanButton?.props.onClick === 'function'
	&& cleanButton?.props.disabled !== true);
eq('client: Clean starts disarmed', cleanButton?.children, ['t:queue.clean']);
fetchCalls.length = 0;
cleanButton.props.onClick(); // first click only arms
const confirmButton = findByClass(renderPanel(), 'dsf-queueActionClean');
eq('client: armed Clean shows the inline Confirm label', confirmButton?.children, ['t:queue.cleanConfirm']);
eq('client: arming posts nothing yet',
	fetchCalls.filter((call) => call.options?.method === 'POST').length, 0);
confirmButton.props.onClick(); // second click executes the sweep
await new Promise((resolve) => { setTimeout(resolve, 20); });
const cleanPosts = fetchCalls.filter((call) => call.options?.method === 'POST');
eq('client: Clean removes exactly the succeeded AND failed rows via the per-item remove action',
	cleanPosts.map((call) => call.options?.body),
	['{"action":"remove","id":"q1"}', '{"action":"remove","id":"q3"}', '{"action":"remove","id":"q5"}']);
check('client: Clean posts reuse the queue action route with the CSRF header',
	cleanPosts.every((call) => call.options?.headers?.['x-dsh-factory-action'] === 'queue'));
eq('client: Clean auto-resets after executing',
	findByClass(renderPanel(), 'dsf-queueActionClean')?.children, ['t:queue.clean']);
// Failed-only board: the sweep covers failed rows too, so Clean stays
// ENABLED with zero succeeded (the old panel hid it here) — the halt cause
// is sweepable, and sweeping it posts exactly its remove.
queueSnapshot = { halted: true, haltedBy: 'q3', stats: { queued: 1, running: 1, succeeded: 0, failed: 1, runningVsCap: '1/3' }, items: [
	{ id: 'q2', status: 'running', summary: 'Sidebar bug', scopes: [], workerSessionId: 'ws-2' },
	{ id: 'q3', status: 'failed', summary: 'Broken thing', scopes: ['src/x/'], workerSessionId: 'ws-3' },
	{ id: 'q4', status: 'queued', summary: 'Queued thing', scopes: [] },
] };
renderPanel(); // the effect refetches the changed board
await new Promise((resolve) => { setTimeout(resolve, 20); });
const failedOnlyClean = findByClass(renderPanel(), 'dsf-queueActionClean');
check('client: Clean stays enabled with only failed rows to sweep (halt cause included)',
	failedOnlyClean?.props?.disabled !== true
	&& failedOnlyClean?.props?.title === 't:queue.cleanAria'
	&& failedOnlyClean?.children?.[0] === 't:queue.clean',
	{ props: failedOnlyClean?.props });
fetchCalls.length = 0;
failedOnlyClean.props.onClick(); // arm
findByClass(renderPanel(), 'dsf-queueActionClean').props.onClick(); // confirm
await new Promise((resolve) => { setTimeout(resolve, 20); });
eq('client: the failed-only sweep posts remove for the failed row (the Host lifts the halt)',
	fetchCalls.filter((call) => call.options?.method === 'POST').map((call) => call.options?.body),
	['{"action":"remove","id":"q3"}']);
// Nothing cleanable (running/queued rows only): the control stays VISIBLE,
// disabled behind the explanatory tooltip (always discoverable).
queueSnapshot = { halted: false, stats: { queued: 1, running: 1, succeeded: 0, failed: 0, runningVsCap: '1/3' }, items: [
	{ id: 'q2', status: 'running', summary: 'Sidebar bug', scopes: [], workerSessionId: 'ws-2' },
	{ id: 'q4', status: 'queued', summary: 'Queued thing', scopes: [] },
] };
renderPanel();
await new Promise((resolve) => { setTimeout(resolve, 20); });
const disabledClean = findByClass(renderPanel(), 'dsf-queueActionClean');
check('client: Clean is always visible — disabled with the explanatory tooltip when nothing is cleanable',
	disabledClean?.type === 'button'
	&& disabledClean?.props?.disabled === true
	&& disabledClean?.props?.title === 't:queue.cleanDisabled'
	&& disabledClean?.props?.['aria-label'] === 't:queue.cleanAria'
	&& disabledClean?.children?.[0] === 't:queue.clean',
	{ props: disabledClean?.props });
// Empty and load-error states render the quiet hints.
queueSnapshot = { halted: false, stats: { queued: 0, running: 0, succeeded: 0, failed: 0, runningVsCap: '0/3' }, items: [] };
renderPanel();
await new Promise((resolve) => { setTimeout(resolve, 20); });
const emptyTree2 = renderPanel();
check('client: empty queue shows the empty-state hint', emptyTree2.includes('t:queue.empty'));
const emptyClean = findByClass(emptyTree2, 'dsf-queueActionClean');
check('client: empty queue keeps Clean visible but disabled (numbering restarts at q1 host-side)',
	emptyClean?.props?.disabled === true && emptyClean?.props?.title === 't:queue.cleanDisabled',
	{ props: emptyClean?.props });
const realFetch = globalThis.fetch;
globalThis.fetch = () => Promise.reject(new Error('offline'));
hookStore.length = 0; // fresh mount: no snapshot yet, so the fetch failure shows
renderPanel(); // the failing fetch marks the error state
await new Promise((resolve) => { setTimeout(resolve, 20); });
check('client: failed fetch shows the quiet load-error message (next poll retries)',
	renderPanel().includes('t:queue.loadError'));
globalThis.fetch = realFetch;
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
let routeHandler = null;
// The queue store must not touch the real DSH home: point the env at a temp
// dir before apply() creates the store.
const queueHome = mkdtempSync(join(tmpdir(), 'factory-queue-home-'));
const previousDshHome = process.env.DSH_HOME;
process.env.DSH_HOME = queueHome;
/** Mutable host services the runtime reads via ctx.get — populated per test. */
const hostServices = {};
const fakeHostCtx = {
	inject(deps, callback) {
		if (deps.includes('sessionProjections')) {
			callback({ sessionProjections: { register(def) { projectionDefs.push(def); projectionDef = projectionDefs[0]; return () => {}; } } });
		} else if (deps.includes('commands')) {
			callback({ commands: { register(def) { commandDef = def; return () => {}; } } });
		} else if (deps.includes('webServer')) {
			callback({ webServer: { register(route) { routeHandler = route.handler; return () => {}; } } });
		}
		return { dispose() {} };
	},
	on(event, handler) {
		if (event === 'session/event') sessionEventHandlers.push(handler);
		return () => {};
	},
	get(name) { return hostServices[name]; },
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
	assistantEvent(9, '[factory] phase 7/9 deploy: skip (no test environment configured)'),
	assistantEvent(10, '[factory] phase 8/9 regression: skip — no suite exists, none found'),
	assistantEvent(11, '[factory] phase 9/9 evaluate: pass — all acceptance criteria met'),
];
for (const event of log) state = projectionDef.apply(state, event);
const view = projectionDef.wire.view(state);
projectionDef.wire.viewSchema.parse(view);
projectionDef.stateSchema.parse(state);
eq('host: folded statuses after a full run', view.phases.map((p) => p.status),
	['done', 'done', 'done', 'done', 'done', 'done', 'skipped', 'skipped', 'done']);
eq('host: run finished', view.running, false);
eq('host: lastLine kept verbatim', view.lastLine, '[factory] phase 9/9 evaluate: pass — all acceptance criteria met');

// Failure + fresh-run semantics.
let state2 = projectionDef.init({}, 0);
for (const event of [
	assistantEvent(1, '[factory] phase 1/9 capture: restated'),
	assistantEvent(2, '[factory] phase 2/9 plan: fail — could not converge, blocked'),
]) state2 = projectionDef.apply(state2, event);
const view2 = projectionDef.wire.view(state2);
eq('host: leading fail verdict marks the phase failed', view2.phases[1].status, 'failed');
eq('host: failed run stays running (until phase 9 or a fresh run)', view2.running, true);
state2 = projectionDef.apply(state2, assistantEvent(3, '[factory] phase 1/9 capture: retry'));
const view3 = projectionDef.wire.view(state2);
eq('host: phase-1 line after a settled run starts a fresh run', [view3.phases[0].status, view3.phases[1].status], ['active', 'pending']);

// v6 verdict-token contract: only the LEAVE line's LEADING verdict word
// decides the icon — honest prose after it can never flip a passing phase,
// and mid-sentence verdict words in an enter line are ignored.
let stateV = projectionDef.init({}, 0);
stateV = projectionDef.apply(stateV, assistantEvent(1, '[factory] phase 1/9 capture: pass — request restated'));
stateV = projectionDef.apply(stateV, assistantEvent(2, '[factory] phase 2/9 plan: pass — 5 tasks, no failure, zero regressions'));
const viewV = projectionDef.wire.view(stateV);
projectionDef.wire.viewSchema.parse(viewV);
eq('host: failure prose after a pass verdict cannot flip the phase',
	[viewV.phases[0].status, viewV.phases[1].status], ['done', 'done']);
stateV = projectionDef.apply(stateV, assistantEvent(3, '[factory] phase 3/9 implement: implementing task 2/5 (recovering from an error)'));
eq('host: enter line without a verdict stays active despite failure words',
	projectionDef.wire.view(stateV).phases[2].status, 'active');
stateV = projectionDef.apply(stateV, assistantEvent(4, '[factory] phase 4/9 review: pass — diff reviewed, 2 findings fixed'));
eq('host: pass verdict on a mid run closes the phase as done',
	projectionDef.wire.view(stateV).phases[2].status, 'done');

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

// Queue store: the durable state machine over a temp dir. (The autoOpenTab
// re-apply runs at the very end — a second apply would register a second
// enqueue listener and route handler over the same queue home and race it.)
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
// Retry: only failed items; worker session retained; its halt lifted.
eq('host: queue: retry refuses non-failed items', await store.retry(itemB.id), false);
eq('host: queue: retry re-queues the failed item and keeps its worker',
	[await store.retry(itemC.id), (await store.find(itemC.id))?.status, (await store.find(itemC.id))?.workerSessionId, (await store.find(itemC.id))?.failureReason],
	[true, 'queued', 'worker-cccc', null]);
eq('host: queue: retry of the halting item cleared the halt', (await store.snapshot()).halted, false);
// Remove: any status, halting items lift the halt, unknown ids refused.
eq('host: queue: remove of an unknown id is refused', await store.remove('q99'), false);
eq('host: queue: remove drops the item',
	[await store.remove(itemD.id), (await store.snapshot()).items.some((candidate) => candidate.id === itemD.id)],
	[true, false]);
await store.markRunning(itemE.id, 'worker-eeee2');
await store.markFailed(itemE.id, 'halt me');
eq('host: queue: remove of the halting item lifts the halt', [
	await store.remove(itemE.id),
	(await store.snapshot()).halted,
], [true, false]);
// Reset-on-empty: the counter resets only the moment zero rows remain —
// removals with survivors keep it monotonic (survivors never renumber),
// and the next enqueue after an emptied queue is q1 again (the Clean sweep
// lands here too: it is repeated removes).
eq('host: queue: remove while rows survive keeps the monotonic counter', [
	await store.remove(itemB.id),
	(await store.snapshot()).nextId,
], [true, 6]);
await store.remove(itemA.id);
await store.remove(itemC.id);
eq('host: queue: emptying the queue resets nextId to 1',
	[(await store.snapshot()).items.length, (await store.snapshot()).nextId], [0, 1]);
eq('host: queue: the next enqueue after an emptied queue is q1 again',
	(await store.enqueue({ request: 'Numbering restart', workspace: '/repo/a', scopes: [] })).id, 'q1');

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

// ---------------------------------------------------------------------------
// Orchestrator end-to-end (isolated runtime over its own store): catches the
// dead-turn bug — create must carry agentOptions, the worker must be
// composed with the default agent PRESET (meta.agentPreset + a setup that
// mounts the preset's tool tree — the tool-less-worker bug) and attached to
// its workspace, a zero-event worker fails loudly, a completing worker
// succeeds, retry resumes the SAME session, and the resume path re-mounts
// the preset the session header recorded.
// ---------------------------------------------------------------------------
const { createQueueRuntime } = await import(pathToFileURL(join(repoRoot, 'lib', 'orchestrator.js')).href);
const orchWorkspace = mkdtempSync(join(tmpdir(), 'factory-orch-ws-'));
const orchHome = mkdtempSync(join(tmpdir(), 'factory-orch-'));
const orchStore = host.createQueueStore({ dir: orchHome });
const agentLog = { created: [], resumed: [], attached: [], followups: [] };
let fakeSeq = 0;
let boardForWorker = () => undefined;
// Fake agentPresets registry: resolve() answers the default ('standard');
// mount() records the agent context it was handed (the tool-tree mount).
const presetLog = { resolved: [], mounted: [] };
const fakePresets = {
	async resolve(id) { presetLog.resolved.push(id); return { id: id ?? 'standard' }; },
	async mount(ctx, id) { presetLog.mounted.push({ ctx, id }); return { id }; },
};
const makeFakeAgent = (log, sessionId, cwd, meta) => ({
  session: {
    id: sessionId,
    header: { cwd, ...(meta?.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset }) },
    get seq() { return fakeSeq; },
  },
  followup(message) { log.followups.push({ sessionId, message }); },
  whenIdle() { return Promise.resolve(); },
});
/** Fake `agents` service: create/resume run the caller's setup callback the
 * way the real AgentLoop does (setupAndPublish, before the turn starts). */
const makeAgentsSurface = (log, { liveCreated = true, resumedPreset } = {}) => ({
  get: (id) => (liveCreated ? log.created.find((entry) => entry.sessionId === id)?.agent : undefined),
  async create(options) {
    const agent = makeFakeAgent(log, options.sessionId, options.meta?.cwd, options.meta);
    log.created.push({ ...options, agent });
    if (typeof options.setup === 'function') await options.setup({ setupOf: options.sessionId }, agent);
    return { agent: log.created.at(-1).agent };
  },
  async resume(options) {
    const agent = makeFakeAgent(log, options.resumeSessionId, orchWorkspace,
      resumedPreset === undefined ? undefined : { agentPreset: resumedPreset });
    log.resumed.push({ ...options, agent });
    if (typeof options.setup === 'function') await options.setup({ setupOf: options.resumeSessionId }, agent);
    return { agent };
  },
});
const orchServices = {
  agents: makeAgentsSurface(agentLog),
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'test-model' }) },
  agentPresets: fakePresets,
  workspaceRegistry: { list: () => [{ path: orchWorkspace, attachSession: (id) => { agentLog.attached.push(id); return Promise.resolve(); } }] },
  sessionProjections: { stateOf: () => boardForWorker() },
};
const orchCtx = { get: (name) => orchServices[name] };
const runtime = createQueueRuntime(orchCtx, defaults, orchStore);
const workerItem = await runtime.enqueueAndPump({
  request: 'Build the retention pipeline',
  summary: 'Retention',
  workspace: orchWorkspace,
  scopes: ['src/'],
  clarifications: [{ question: 'Cap where?', answer: 'At injection.' }],
});
await tick();
await tick();
eq('host: orchestrator: worker created with default model options and cwd',
  [agentLog.created[0]?.agentOptions, agentLog.created[0]?.meta?.cwd],
  [{ provider: 'deepseek', model: 'test-model' }, orchWorkspace]);
eq('host: orchestrator: creation composes the default agent preset (the tool bundle)',
  [agentLog.created[0]?.meta?.agentPreset, typeof agentLog.created[0]?.setup],
  ['standard', 'function']);
check('host: orchestrator: the default preset was resolved (no explicit id)',
  presetLog.resolved.length >= 1 && presetLog.resolved.every((id) => id === undefined),
  { resolved: presetLog.resolved });
check('host: orchestrator: creation setup mounted the preset tree on the worker\'s agent context',
  presetLog.mounted[0]?.id === 'standard' && presetLog.mounted[0]?.ctx?.setupOf === agentLog.created[0]?.sessionId,
  { mounted: presetLog.mounted.map(({ id, ctx }) => ({ id, ctx })) });
eq('host: orchestrator: worker attached to its workspace', agentLog.attached.length, 1);
const workerPrompt = agentLog.followups[0]?.message?.content?.[0]?.text ?? '';
check('host: orchestrator: steered prompt is the autonomous worker prompt',
  workerPrompt.startsWith('Factory queue q1: Retention')
  && workerPrompt.includes('BINDING acceptance inputs')
  && workerPrompt.includes('Cap where?'));
const failedWorker = await orchStore.find(workerItem.id);
eq('host: orchestrator: zero-event worker fails loudly (the dead-turn bug)',
  [failedWorker?.status, failedWorker?.failureReason],
  ['failed', 'the worker session recorded no events — its turn never started']);
// A completing worker succeeds; retry resumes the SAME session with a notice.
fakeSeq = 42;
boardForWorker = () => ({
  running: false,
  runCount: 0,
  plan: null,
  lastLine: '[factory] phase 9/9 evaluate: done',
  phases: Array.from({ length: 9 }, (_, index) => ({ n: index + 1, key: `p${index}`, status: 'done', text: null })),
});
await runtime.retry(workerItem.id);
await tick();
await tick();
eq('host: orchestrator: retry reuses the same worker session (live get, no new create)',
	[agentLog.followups[1]?.sessionId, agentLog.created.length, agentLog.resumed.length],
	[failedWorker?.workerSessionId, 1, 0]);
const retriedPrompt = agentLog.followups[1]?.message?.content?.[0]?.text ?? '';
check('host: orchestrator: resumed worker gets the retry notice and stays autonomous',
  retriedPrompt.startsWith('Factory queue q1: Retention')
  && retriedPrompt.includes('RESUMED after a failed attempt'));
const retriedItem = await orchStore.find(workerItem.id);
eq('host: orchestrator: completing worker settles succeeded', retriedItem?.status, 'succeeded');

// The RESUME path (the worker's live agent is gone — restart or disposal):
// the resume call carries a setup that re-mounts the preset the session
// header RECORDED at creation, exactly like the controller's resume path.
const orchHome2 = mkdtempSync(join(tmpdir(), 'factory-orch-resume-'));
const orchStore2 = host.createQueueStore({ dir: orchHome2 });
const resumeLog = { created: [], resumed: [], attached: [], followups: [] };
const resumeServices = {
  agents: makeAgentsSurface(resumeLog, { liveCreated: false, resumedPreset: 'recorded-preset' }),
  agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'test-model' }) },
  agentPresets: fakePresets,
  workspaceRegistry: { list: () => [] },
  sessionProjections: { stateOf: () => boardForWorker() },
};
const resumeRuntime = createQueueRuntime({ get: (name) => resumeServices[name] }, defaults, orchStore2);
fakeSeq = 0;
boardForWorker = () => undefined;
const resumeItem = await resumeRuntime.enqueueAndPump({
  request: 'Resume me', summary: 'Resume', workspace: orchWorkspace, scopes: [],
});
await tick();
await tick();
const resumeWorker = await orchStore2.find(resumeItem.id);
eq('host: orchestrator: dead worker fails (ready for a resuming retry)', resumeWorker?.status, 'failed');
const mountedBefore = presetLog.mounted.length;
fakeSeq = 42;
boardForWorker = () => ({
  running: false,
  runCount: 0,
  plan: null,
  lastLine: '[factory] phase 9/9 evaluate: done',
  phases: Array.from({ length: 9 }, (_, index) => ({ n: index + 1, key: `p${index}`, status: 'done', text: null })),
});
await resumeRuntime.retry(resumeItem.id);
await tick();
await tick();
check('host: orchestrator: resume mounts the header-recorded preset on the resumed agent context',
  typeof resumeLog.resumed[0]?.setup === 'function'
  && presetLog.mounted[mountedBefore]?.id === 'recorded-preset'
  && presetLog.mounted[mountedBefore]?.ctx?.setupOf === resumeWorker?.workerSessionId,
  { resumedSetups: resumeLog.resumed.map((entry) => typeof entry.setup), mounted: presetLog.mounted.map(({ id, ctx }) => ({ id, ctx })) });
eq('host: orchestrator: resumed worker settles succeeded',
  (await orchStore2.find(resumeItem.id))?.status, 'succeeded');

// ---------------------------------------------------------------------------
// Worker model inheritance (q4): the enqueue listener snapshots the START
// session's effective selection (pending model/selection event, else the
// last request header with adapter-defaulted effort skipped, else the
// global default), the enqueue JSON may override provider/model/effort
// per-field leniently, and workers — create AND resume — receive the
// item's snapshot as agentOptions (legacy items and absent selections run
// on the full default selection, effort included; an unavailable captured
// model falls back to the default with a recorded note, never a failure).
// ---------------------------------------------------------------------------
const selHome = mkdtempSync(join(tmpdir(), 'factory-sel-home-'));
const selPreviousHome = process.env.DSH_HOME;
process.env.DSH_HOME = selHome;
const selListeners = [];
const selServices = {};
const selCtx = {
	inject(deps, callback) {
		if (deps.includes('sessionProjections')) callback({ sessionProjections: { register: () => () => {} } });
		else if (deps.includes('commands')) callback({ commands: { register: () => () => {} } });
		else if (deps.includes('webServer')) callback({ webServer: { register: () => () => {} } });
		return { dispose() {} };
	},
	on(event, handler) { if (event === 'session/event') selListeners.push(handler); return () => {}; },
	get: (name) => selServices[name],
	logger: { warn() {} },
};
host.apply(selCtx, {});
const fireSelEvent = (session, seq, payloadLine) => {
	for (const handler of selListeners) handler(session, assistantEvent(seq, payloadLine));
};
// A start session whose effective selection lives in the projection's
// PENDING slot (selected, not yet consumed by a request).
const pendingSession = {
	id: 'sel-pending', header: { cwd: workspace },
	requestHeader: () => ({ config: { provider: 'p-header', model: 'm-header', reasoningEffort: 'high' } }),
};
selServices.sessionProjections = {
	stateOf: (session, key) => {
		if (key === 'agentPreset') return session === pendingSession ? 'creator' : null;
		if (key !== 'modelSelection') return undefined;
		return session === pendingSession
			? { lastUsed: null, pending: { provider: 'p-pending', model: 'm-pending', reasoningEffort: 'low' } }
			: { lastUsed: null, pending: null };
	},
};
selServices.agentDefaultModel = { currentSelection: () => ({ provider: 'p-default', model: 'm-default', reasoningEffort: 'medium' }) };
fireSelEvent(pendingSession, 1, '[factory] enqueue: {"request":"Pending selection","summary":"SelPending","scopes":[],"clarifications":[]}');
await tick();
await tick();
// A session with NO pending selection but a last request header whose
// effort is adapter-defaulted (must be skipped; provider/model kept).
const headerSession = {
	id: 'sel-header', header: { cwd: workspace },
	requestHeader: () => ({ config: { provider: 'p-header', model: 'm-header', reasoningEffort: 'adapterDefault' }, adapterDefaults: { reasoningEffort: true } }),
};
fireSelEvent(headerSession, 2, '[factory] enqueue: {"request":"Header selection","summary":"SelHeader","scopes":[],"clarifications":[]}');
// Per-field JSON override: only the effort is named, the captured route stays.
fireSelEvent(pendingSession, 3, '[factory] enqueue: {"request":"Effort override","summary":"SelEffort","scopes":[],"clarifications":[],"reasoningEffort":"max"}');
// Invalid JSON fields are dropped leniently (wrong types and blanks).
fireSelEvent(pendingSession, 4, '[factory] enqueue: {"request":"Invalid override","summary":"SelInvalid","scopes":[],"clarifications":[],"provider":7,"model":"","reasoningEffort":null}');
await tick();
await tick();
const selStore = host.createQueueStore({ dir: join(selHome, 'factory-queue') });
const selSnap = await selStore.snapshot();
const selBy = (summary) => selSnap.items.find((item) => item.summary === summary)?.selection ?? undefined;
eq('host: listener snapshots the start session\'s PENDING selection (effort included)',
	selBy('SelPending'), { provider: 'p-pending', model: 'm-pending', reasoningEffort: 'low' });
eq('host: listener snapshots the start session\'s MODE (agent preset)',
	selSnap.items.find((item) => item.summary === 'SelPending')?.agentPreset, 'creator');
eq('host: listener leaves the preset null when the session records none',
	selSnap.items.find((item) => item.summary === 'SelHeader')?.agentPreset, null);
eq('host: listener falls back to the last request header, skipping adapter-defaulted effort',
	selBy('SelHeader'), { provider: 'p-header', model: 'm-header' });
eq('host: JSON per-field override wins (effort only, captured route kept)',
	selBy('SelEffort'), { provider: 'p-pending', model: 'm-pending', reasoningEffort: 'max' });
eq('host: invalid JSON-named fields are dropped, captured selection kept',
	selBy('SelInvalid'), { provider: 'p-pending', model: 'm-pending', reasoningEffort: 'low' });

// Orchestrator: workers receive the snapshot; legacy and absent selections
// run on the full default (effort included); an unavailable captured model
// falls back to the default with a note; retry/resume reuses the snapshot.
const selOrchHome = mkdtempSync(join(tmpdir(), 'factory-sel-orch-'));
const selOrchStore = host.createQueueStore({ dir: selOrchHome });
const selLog = { created: [], resumed: [], attached: [], followups: [] };
const selOrchServices = {
	agents: makeAgentsSurface(selLog, { liveCreated: false }),
	agentDefaultModel: { currentSelection: () => ({ provider: 'p-default', model: 'm-default', reasoningEffort: 'medium' }) },
	agentPresets: fakePresets,
	workspaceRegistry: { list: () => [] },
	sessionProjections: { stateOf: () => boardForWorker() },
};
const selOrchCtx = { get: (name) => selOrchServices[name] };
const selRuntime = createQueueRuntime(selOrchCtx, defaults, selOrchStore);
fakeSeq = 42;
boardForWorker = () => ({
	running: false, runCount: 0, plan: null,
	lastLine: '[factory] phase 9/9 evaluate: done',
	phases: Array.from({ length: 9 }, (_, index) => ({ n: index + 1, key: `p${index}`, status: 'done', text: null })),
});
const inheritItem = await selRuntime.enqueueAndPump({
	request: 'Inherit my model', summary: 'Inherit', workspace: orchWorkspace, scopes: ['inherit/'],
	selection: { provider: 'p-session', model: 'm-session', reasoningEffort: 'high' },
	agentPreset: 'creator',
});
const legacyItem = await selRuntime.enqueueAndPump({
	request: 'Legacy item', summary: 'Legacy', workspace: orchWorkspace, scopes: ['legacy/'],
});
await tick();
await tick();
eq('host: orchestrator: worker created with the item\'s snapshot selection (model AND effort)',
	selLog.created[0]?.agentOptions, { provider: 'p-session', model: 'm-session', reasoningEffort: 'high' });
eq('host: orchestrator: worker composed under the item\'s captured MODE, recorded in its header',
	selLog.created[0]?.meta?.agentPreset, 'creator');
eq('host: orchestrator: legacy item without a snapshot runs on the full default (effort kept)',
	selLog.created[1]?.agentOptions, { provider: 'p-default', model: 'm-default', reasoningEffort: 'medium' });
eq('host: orchestrator: legacy item without a captured mode composes the DEFAULT preset',
	selLog.created[1]?.meta?.agentPreset, 'standard');
check('host: orchestrator: the captured mode\'s tool tree was mounted',
	presetLog.mounted.some(({ id }) => id === 'creator'),
	{ mounted: presetLog.mounted.map(({ id }) => id) });
eq('host: orchestrator: both model-inheritance workers settle succeeded', [
	(await selOrchStore.find(inheritItem.id))?.status,
	(await selOrchStore.find(legacyItem.id))?.status,
], ['succeeded', 'succeeded']);
// A snapshot worker that fails keeps its snapshot; retry RESUMES the same
// session under that same enqueue-time selection.
fakeSeq = 0;
boardForWorker = () => undefined;
const retryItem = await selRuntime.enqueueAndPump({
	request: 'Fail then retry', summary: 'FailRetry', workspace: orchWorkspace, scopes: ['retry/'],
	selection: { provider: 'p-session', model: 'm-session', reasoningEffort: 'high' },
});
await tick();
await tick();
const retryFailed = await selOrchStore.find(retryItem.id);
eq('host: orchestrator: snapshot item fails on a dead worker (snapshot untouched)',
	[retryFailed?.status, retryFailed?.selection],
	['failed', { provider: 'p-session', model: 'm-session', reasoningEffort: 'high' }]);
fakeSeq = 42;
boardForWorker = () => ({
	running: false, runCount: 0, plan: null,
	lastLine: '[factory] phase 9/9 evaluate: done',
	phases: Array.from({ length: 9 }, (_, index) => ({ n: index + 1, key: `p${index}`, status: 'done', text: null })),
});
await selRuntime.retry(retryItem.id);
await tick();
await tick();
eq('host: orchestrator: retry RESUMES the worker under the same enqueue-time snapshot',
	selLog.resumed[0]?.agentOptions, { provider: 'p-session', model: 'm-session', reasoningEffort: 'high' });
eq('host: orchestrator: resumed snapshot worker settles succeeded',
	(await selOrchStore.find(retryItem.id))?.status, 'succeeded');
eq('host: orchestrator: no model fallback note while the snapshot runs',
	(await selOrchStore.find(retryItem.id))?.modelNote, null);

// Unavailable captured model: the llm registry does not list it → default
// fallback + note, and the item is NEVER failed for the missing model.
const unavailableHome = mkdtempSync(join(tmpdir(), 'factory-sel-unavail-'));
const unavailableStore = host.createQueueStore({ dir: unavailableHome });
const unavailLog = { created: [], resumed: [], attached: [], followups: [] };
const unavailServices = {
	agents: makeAgentsSurface(unavailLog),
	agentDefaultModel: { currentSelection: () => ({ provider: 'p-default', model: 'm-default', reasoningEffort: 'medium' }) },
	agentPresets: fakePresets,
	workspaceRegistry: { list: () => [] },
	sessionProjections: { stateOf: () => boardForWorker() },
	llm: {
		listProviders: () => [{ id: 'p-default' }],
		listModels: async (provider) => (provider === 'p-default' ? [{ id: 'm-default' }] : []),
	},
};
const unavailRuntime = createQueueRuntime({ get: (name) => unavailServices[name] }, defaults, unavailableStore);
const unavailItem = await unavailRuntime.enqueueAndPump({
	request: 'Ghost model', summary: 'Ghost', workspace: orchWorkspace, scopes: [],
	selection: { provider: 'p-gone', model: 'm-gone', reasoningEffort: 'high' },
});
await tick();
await tick();
eq('host: orchestrator: unavailable captured model falls back to the default selection',
	unavailLog.created[0]?.agentOptions, { provider: 'p-default', model: 'm-default', reasoningEffort: 'medium' });
const unavailSnap = await unavailableStore.find(unavailItem.id);
check('host: orchestrator: fallback recorded as a note, never a failure',
	unavailSnap?.status !== 'failed'
	&& typeof unavailSnap?.modelNote === 'string'
	&& unavailSnap.modelNote.includes('p-gone/m-gone'),
	{ unavailSnap });

// Unavailable captured MODE: the preset registry cannot resolve it →
// default-preset fallback + note, and the item is NEVER failed for it.
const gonePresetHome = mkdtempSync(join(tmpdir(), 'factory-sel-preset-'));
const gonePresetStore = host.createQueueStore({ dir: gonePresetHome });
const gonePresetLog = { created: [], resumed: [], attached: [], followups: [] };
const gonePresetServices = {
	agents: makeAgentsSurface(gonePresetLog),
	agentDefaultModel: { currentSelection: () => ({ provider: 'p-default', model: 'm-default' }) },
	agentPresets: {
		async resolve(id) { if (id !== undefined && id !== 'standard') throw new Error(`Unknown agent preset: ${id}`); return { id: id ?? 'standard' }; },
		async mount(ctxArg, id) { presetLog.mounted.push({ ctx: ctxArg, id }); return { id }; },
	},
	workspaceRegistry: { list: () => [] },
	sessionProjections: { stateOf: () => boardForWorker() },
};
const gonePresetRuntime = createQueueRuntime({ get: (name) => gonePresetServices[name] }, defaults, gonePresetStore);
const gonePresetItem = await gonePresetRuntime.enqueueAndPump({
	request: 'Ghost mode', summary: 'GhostMode', workspace: orchWorkspace, scopes: [],
	agentPreset: 'removed-mode',
});
await tick();
await tick();
eq('host: orchestrator: unresolvable captured mode falls back to the DEFAULT preset',
	gonePresetLog.created[0]?.meta?.agentPreset, 'standard');
const gonePresetSnap = await gonePresetStore.find(gonePresetItem.id);
check('host: orchestrator: mode fallback recorded as a note, never a failure',
	gonePresetSnap?.status !== 'failed'
		&& typeof gonePresetSnap?.modelNote === 'string'
		&& gonePresetSnap.modelNote.includes('captured mode removed-mode'),
	{ gonePresetSnap });
// The queue list output stays model-free (only the queue page shows chips).
const selStatusText = await selRuntime.statusText();
check('host: /factory queue list output carries no model chip',
	!selStatusText.includes('p-session') && !selStatusText.includes('m-session'), { selStatusText });
process.env.DSH_HOME = selPreviousHome;

// Route POST actions: drive a REAL failure through the apply()-wired
// runtime (a second store instance's writes are invisible to its cached
// state). The fake agents surface's first worker completes (the listener
// item queued earlier); workers #2 and #3 are dead (zero events) and fail,
// halting the queue — then the POST actions run against that live state.
let routeCreatedCount = 0;
hostServices.agents = {
  get: () => undefined,
  async create(options) {
    routeCreatedCount += 1;
    // Workers #2 and #3 are dead (zero events): one failure exercises the
    // retry action, the other the Clean sweep's halt lift.
    const healthy = routeCreatedCount !== 2 && routeCreatedCount !== 3;
    return {
      agent: {
        session: { id: options.sessionId, header: { cwd: options.meta?.cwd }, get seq() { return healthy ? 42 : 0; } },
        followup() {},
        whenIdle() { return Promise.resolve(); },
      },
    };
  },
  async resume(options) {
    return { agent: { session: { id: options.resumeSessionId, header: {}, get seq() { return 42; } }, followup() {}, whenIdle() { return Promise.resolve(); } } };
  },
};
hostServices.agentDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'test-model' }) };
hostServices.workspaceRegistry = { list: () => [] };
hostServices.sessionProjections = {
  stateOf: (session) => (session.seq > 0
    ? {
      running: false,
      runCount: 0,
      plan: null,
      lastLine: '[factory] phase 9/9 evaluate: done',
      phases: Array.from({ length: 9 }, (_, index) => ({ n: index + 1, key: `p${index}`, status: 'done', text: null })),
    }
    : undefined),
};
fireSessionEvent(assistantEvent(9, '[factory] enqueue: {"request":"Route retry target","summary":"Route retry","scopes":["route/"],"clarifications":[]}'));
const makeRes = () => ({
  status: 0,
  body: '',
  writeHead(status) { this.status = status; return this; },
  end(payload) { this.body = payload ?? ''; return this; },
});
const makeReq = (method, headers, body) => {
  const listeners = {};
  const req = {
    method,
    headers,
    destroy() {},
    on(event, cb) { listeners[event] = cb; return this; },
  };
  if (body !== undefined) {
    queueMicrotask(() => {
      listeners.data?.(body);
      listeners.end?.();
    });
  }
  return req;
};
// All fixture reads go through the route's GET (the queue UI's read model,
// served from the runtime's own store): minting extra store instances per
// read would let their crash-recovery persist race the runtime's atomic
// writes whenever an item is momentarily `running` on disk.
async function routeSnapshot() {
  const res = makeRes();
  await routeHandler(makeReq('GET', {}), res);
  return JSON.parse(res.body);
}
// Poll until the dead worker settles (the pump's serialized writes make
// fixed ticks racy).
	let routeItemSnap = null;
for (let attempt = 0; attempt < 100 && routeItemSnap === null; attempt += 1) {
	await tick();
	const snap = await routeSnapshot();
	routeItemSnap = snap.items.find((item) => item.summary === 'Route retry'
		&& (item.status === 'failed' || item.status === 'succeeded')) ?? null;
}
check('host: route fixture: the earlier queued item completed and the dead worker failed',
	routeItemSnap?.status === 'failed' && routeItemSnap?.failureReason?.includes('turn never started'),
	{ routeItemSnap });
const guardRes = makeRes();
await routeHandler(makeReq('POST', {}), guardRes);
eq('host: route: POST without the action header is forbidden', guardRes.status, 403);
const retryRes = makeRes();
await routeHandler(makeReq('POST', { 'x-dsh-factory-action': 'queue' }, JSON.stringify({ action: 'retry', id: routeItemSnap?.id })), retryRes);
await tick();
await tick();
const routeAfterSnap = await routeSnapshot();
eq('host: route: POST retry re-queues, the worker reruns, and the halt lifts', [
	retryRes.status,
	routeAfterSnap.items.find((item) => item.id === routeItemSnap?.id)?.status,
	routeAfterSnap.halted,
], [200, 'succeeded', false]);
eq('host: route: GET stats count every item and carry running-vs-cap', [
	routeAfterSnap.stats?.queued + routeAfterSnap.stats?.running
		+ routeAfterSnap.stats?.succeeded + routeAfterSnap.stats?.failed,
	routeAfterSnap.stats?.runningVsCap,
], [
	routeAfterSnap.items.length,
	`${routeAfterSnap.stats?.running}/${routeAfterSnap.concurrency}`,
]);
const badActionRes = makeRes();
await routeHandler(makeReq('POST', { 'x-dsh-factory-action': 'queue' }, JSON.stringify({ action: 'nope' })), badActionRes);
eq('host: route: unknown action rejected', badActionRes.status, 400);
const removeRes = makeRes();
await routeHandler(makeReq('POST', { 'x-dsh-factory-action': 'queue' }, JSON.stringify({ action: 'remove', id: routeItemSnap?.id })), removeRes);
await tick();
eq('host: route: POST remove drops the item', [
	removeRes.status,
	(await routeSnapshot()).items.some((item) => item.id === routeItemSnap?.id),
], [200, false]);
// Clean through the route (the sweep is repeated per-item removes): a dead
// worker fails and HALTS the queue; removing the failed row lifts the halt
// while a succeeded row survives; removing the last row then empties the
// queue, and the persisted counter restarts at 1 (the next enqueue is q1 —
// proven on the store above; the route exposes no enqueue endpoint).
fireSessionEvent(assistantEvent(11, '[factory] enqueue: {"request":"Route clean target","summary":"Route clean","scopes":["route2/"],"clarifications":[]}'));
let routeCleanSnap = null;
let routeCleanHalted = false;
// 250×20ms (5s) ceiling: the settle chain is fast, but a loaded machine
// (suites running back-to-back) can stretch it past a tighter budget.
for (let attempt = 0; attempt < 250 && routeCleanSnap === null; attempt += 1) {
	await tick();
	const snap = await routeSnapshot();
	routeCleanHalted = snap.halted === true;
	routeCleanSnap = snap.items.find((item) => item.summary === 'Route clean' && item.status === 'failed') ?? null;
}
eq('host: route: the clean fixture dead worker failed and halted the queue', [
	routeCleanSnap !== null,
	routeCleanHalted,
], [true, true]);
const sweepRemoveRes = makeRes();
await routeHandler(makeReq('POST', { 'x-dsh-factory-action': 'queue' }, JSON.stringify({ action: 'remove', id: routeCleanSnap?.id })), sweepRemoveRes);
await tick();
const afterSweepRemove = await routeSnapshot();
eq('host: route: the sweep removing the halt-causing failure lifts the halt', [
	sweepRemoveRes.status,
	afterSweepRemove.halted,
	afterSweepRemove.items.some((item) => item.id === routeCleanSnap?.id),
], [200, false, false]);
const lastRowRes = makeRes();
await routeHandler(makeReq('POST', { 'x-dsh-factory-action': 'queue' }, JSON.stringify({ action: 'remove', id: afterSweepRemove.items[0]?.id })), lastRowRes);
await tick();
eq('host: route: removing the last row empties the queue', [
	lastRowRes.status,
	(await routeSnapshot()).items.length,
], [200, 0]);
const routeStoreFresh = host.createQueueStore({ dir: join(queueHome, 'factory-queue') });
eq('host: route: the emptied route queue persists the numbering reset at q1',
	[(await routeStoreFresh.snapshot()).items.length, (await routeStoreFresh.snapshot()).nextId], [0, 1]);
const retryUnknown = await commandDef.handler({ agent: fakeAgent, rawInput: 'queue retry q99', attachments: [], signal: undefined });
eq('host: /factory queue retry of an unknown item is an error', retryUnknown.kind, 'error');
hostServices.agents = undefined;

// autoOpenTab: false builds a projection whose wire view suppresses the open.
// Runs LAST: a second apply registers a second listener and route handler,
// and only the queue sections above need the first apply's single wiring.
host.apply(fakeHostCtx, { autoOpenTab: false });
eq('host: two projection registrations captured', projectionDefs.length, 2);
const defOff = projectionDefs[1];
const viewOff = defOff.wire.view(defOff.init({}, 0));
defOff.wire.viewSchema.parse(viewOff);
defOff.stateSchema.parse(defOff.init({}, 0));
eq('host: autoOpenTab=false flows into the wire view as autoOpen false', viewOff.autoOpen, false);

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures} failing checks)`);
process.exit(failures === 0 ? 0 : 1);
