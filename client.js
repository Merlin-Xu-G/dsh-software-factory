/**
 * @local/dsh-software-factory — Client half (Web platform).
 *
 * Registers the "Factory" right-sidebar tab: a compact panel listing the
 * eight pipeline phases with live status, plus the latest narration line.
 * State comes from the Host's `factory` session projection, read through the
 * shipped session binding's projection store
 * (`ctx.sessions.binding(id).session.projections.faceOf('factory')`); no
 * plugin-owned transport.
 *
 * Contracts coded against (verified against the shipped client sources
 * extracted from the installed Harness: @deepseek-ai/dsh-client-ui-sidebar-right,
 * -jobs, -plan, -goal, dsh-client-ui-renderer, dsh-api-session-controller):
 * - `window.__ModuleLoader__.load({ id, factory(require) })` — id equals the
 *   package name; the factory must be side-effect free; exports `apply` +
 *   `inject` (required client service keys) exactly like jobs/plan/goal do.
 * - A tab type registers in two stages (ui-sidebar-right's public path):
 *   1. `ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })` —
 *      a static page-type declaration. Each `guide` entry becomes one capsule
 *      on the guide page (and the strip's add control), and picking it calls
 *      `openTab(entry.kind)` — the only way a page type without `patterns` is
 *      ever opened, so a factory tab without a guide entry is unreachable.
 *   2. The body and chip occupants under the keyed seats
 *      `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title`, keyed by
 *      the type id, installed through
 *      `ctx.slots.inject(seat, () => ctx.slots.register({ name, key, locale,
 *      inject }, Component))`.
 * - An occupant's own `inject(dispatchKey)` receives the scope binding key —
 *   the sessionId for a session-scoped seat — and its returned face's
 *   `hooks.<name>` values MUST be observable snapshot sources
 *   (`{ getSnapshot, subscribe }`): the renderer binds each into a
 *   `use<Name>(selector, equal?)` selector hook backed by
 *   useSyncExternalStoreWithSelector. The component must call that hook WITH
 *   a selector (undefined selectors crash inside uSES). Function-valued hook
 *   factories exist only on parent-declared dispatcher faces (the framework
 *   `useTabInfo` this tab's occupants receive from ui-sidebar-right).
 * - `binding.session.projections.faceOf(key)` is always defined for a live
 *   binding and absence reads as an `undefined` snapshot (capability
 *   absent), so the projection face itself is a valid hook source; the body
 *   distinguishes "progress projection not loaded" from "no run yet".
 * - Styling: one injected `<style data-plugin-css>` tag, theme tokens only
 *   (`--dsw-alias-*`, `--dsw-radius-*`, `--dsw-font-mono`); React comes from
 *   the browser module table; no Harness client package is imported.
 */
window.__ModuleLoader__.load({
	id: '@local/dsh-software-factory',
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		const react = require('react');
		const { createElement: h, Fragment } = react;

		/** Copy namespace registered with the client locale service. */
		const NS = 'softwareFactory';
		/** The tab type's identity: the key its body and chip register under. */
		const TAB_ID = '@local/dsh-software-factory/factory-tab';
		/** The Host projection key (must equal FACTORY_PROJECTION_KEY in index.js). */
		const PROJECTION_KEY = 'factory';
		/** Status values the Host projection emits. */
		const STATUSES = ['pending', 'active', 'done', 'skipped', 'failed'];
		/** Selector for the framework-bound projection hook (uSES requires one). */
		const identity = (value) => value;
		/** Absence source used when the session binding has no projection store. */
		const ABSENT_FACE = { getSnapshot: () => undefined, subscribe: () => () => {} };

		const css = [
			'.dsf-root{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;padding:12px;height:100%;overflow:auto;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}',
			'.dsf-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;flex:1;text-align:center;color:var(--dsw-alias-label-tertiary)}',
			'.dsf-emptyTitle{font-size:12px;color:var(--dsw-alias-label-secondary)}',
			'.dsf-emptyHint{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			'.dsf-list{display:flex;flex-direction:column;gap:1px}',
			'.dsf-row{display:flex;align-items:flex-start;gap:8px;padding:4px 6px;border-radius:var(--dsw-radius-sm)}',
			'.dsf-rowActive{background:var(--dsw-alias-fill-l1)}',
			'.dsf-dot{flex:none;margin-top:3px}',
			'.dsf-dotPending{color:var(--dsw-alias-label-tertiary)}',
			'.dsf-dotActive{color:var(--dsw-alias-label-primary)}',
			'.dsf-dotDone{color:var(--dsw-alias-label-secondary)}',
			'.dsf-dotSkipped{color:var(--dsw-alias-label-tertiary)}',
			'.dsf-dotFailed{color:var(--dsw-alias-state-error-primary)}',
			'.dsf-num{flex:none;width:22px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
			'.dsf-key{flex:none;width:64px;color:var(--dsw-alias-label-secondary)}',
			'.dsf-text{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.dsf-rowActive .dsf-text{color:var(--dsw-alias-label-primary)}',
			'.dsf-last{margin-top:4px;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-fill-l1);font-family:var(--dsw-font-mono);font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-word}',
			'.dsf-lastLabel{display:block;margin-bottom:2px;font-size:10px;color:var(--dsw-alias-label-tertiary)}',
			'.dsf-titleIcon{flex:none}',
		].join('\n');
		const cssTagId = '@local/dsh-software-factory/styles';
		if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(cssTagId)}]`) === null) {
			const tag = document.createElement('style');
			tag.dataset.plugin = '@local/dsh-software-factory';
			tag.dataset.pluginCss = cssTagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/** Chinese dictionary (source of truth). */
		const zh = {
			'tab.title': '工厂',
			'guide.description': '在侧栏跟踪 /factory 八阶段交付流水线的实时进度。',
			'empty.none': '当前没有正在运行的工厂流水线',
			'empty.hint': '输入 /factory <需求> 启动 8 阶段交付流水线。',
			'empty.unavailable': '进度不可用（未加载进度投影）。',
			'last.label': '最新状态',
			'status.pending': '待执行',
			'status.active': '进行中',
			'status.done': '已完成',
			'status.skipped': '已跳过',
			'status.failed': '失败',
		};
		/** English dictionary, key-identical to the Chinese source of truth. */
		const en = {
			'tab.title': 'Factory',
			'guide.description': "Track a /factory run's live 8-phase delivery progress in the sidebar.",
			'empty.none': 'No active factory run',
			'empty.hint': 'Type /factory <request> to start the 8-phase delivery pipeline.',
			'empty.unavailable': 'Progress unavailable (progress projection not loaded).',
			'last.label': 'Latest status',
			'status.pending': 'pending',
			'status.active': 'active',
			'status.done': 'done',
			'status.skipped': 'skipped',
			'status.failed': 'failed',
		};

		/** The tab glyph: three pipeline stages feeding a checkmark. */
		function FactoryGlyph({ size = 16, className }) {
			return h('svg', {
				width: size,
				height: size,
				viewBox: '0 0 64 64',
				fill: 'none',
				stroke: 'currentColor',
				'stroke-width': 5,
				'stroke-linecap': 'round',
				'stroke-linejoin': 'round',
				'aria-hidden': 'true',
				className,
			},
			h('rect', { x: 4, y: 24, width: 12, height: 16, rx: 2 }),
			h('rect', { x: 26, y: 24, width: 12, height: 16, rx: 2 }),
			h('path', { d: 'M16 32h8' }),
			h('path', { d: 'M38 32h4' }),
			h('path', { d: 'M42 24l10 8-10 8' }));
		}

		/** One 12px status marker; color rides currentColor per status class. */
		function StatusDot({ status }) {
			const cls = `dsf-dot dsf-dot${status[0].toUpperCase()}${status.slice(1)}`;
			if (status === 'done') {
				return h('svg', { className: cls, width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' },
					h('path', { d: 'M2.5 6.5l2.5 2.5 4.5-5.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
			}
			if (status === 'failed') {
				return h('svg', { className: cls, width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' },
					h('path', { d: 'M3 3l6 6M9 3l-6 6', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' }));
			}
			if (status === 'skipped') {
				return h('svg', { className: cls, width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' },
					h('path', { d: 'M3 6h6', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' }));
			}
			if (status === 'active') {
				return h('svg', { className: cls, width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' },
					h('circle', { cx: 6, cy: 6, r: 3.2, fill: 'currentColor' }),
					h('circle', { cx: 6, cy: 6, r: 5.2, fill: 'none', stroke: 'currentColor', 'stroke-width': 1, opacity: 0.4 }));
			}
			return h('svg', { className: cls, width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' },
				h('circle', { cx: 6, cy: 6, r: 3.2, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, opacity: 0.6 }));
		}

		/** The tab chip: the factory glyph followed by the tab's captured title. */
		function FactoryTabTitle({ useTabInfo }) {
			const { tab } = useTabInfo();
			return h(Fragment, null,
				h(FactoryGlyph, { size: 14, className: 'dsf-titleIcon' }),
				tab.title);
		}

		/**
		 * The tab body: eight phase rows with live status, the latest narration
		 * line verbatim, and a quiet empty state when nothing runs. The
		 * framework binds `hooks.factoryState` (this occupant's inject face)
		 * into the `useFactoryState(selector)` selector hook; `t` comes from the
		 * registration's `locale` seat.
		 */
		function FactoryTabBody({ useFactoryState, t }) {
			const view = useFactoryState(identity);
			if (view === undefined || view === null) {
				return h('div', { className: 'dsf-root' },
					h('div', { className: 'dsf-empty' },
						h('div', { className: 'dsf-emptyTitle' }, t('empty.unavailable'))));
			}
			const phases = Array.isArray(view.phases) ? view.phases : [];
			const started = view.running === true || phases.some((phase) => phase.status !== 'pending');
			if (!started) {
				return h('div', { className: 'dsf-root' },
					h('div', { className: 'dsf-empty' },
						h(FactoryGlyph, { size: 28 }),
						h('div', { className: 'dsf-emptyTitle' }, t('empty.none')),
						h('div', { className: 'dsf-emptyHint' }, t('empty.hint'))));
			}
			return h('div', { className: 'dsf-root' },
				h('div', { className: 'dsf-list', role: 'list' }, phases.map((phase) => {
					const status = STATUSES.includes(phase.status) ? phase.status : 'pending';
					return h('div', {
						className: `dsf-row${status === 'active' ? ' dsf-rowActive' : ''}`,
						role: 'listitem',
						key: phase.key,
					},
					h(StatusDot, { status }),
					h('span', { className: 'dsf-num' }, `${phase.n}/8`),
					h('span', { className: 'dsf-key' }, phase.key),
					h('span', {
						className: 'dsf-text',
						title: phase.text ?? t(`status.${status}`),
					}, phase.text ?? t(`status.${status}`)));
				})),
				typeof view.lastLine === 'string' && view.lastLine !== ''
					? h('div', { className: 'dsf-last' },
						h('span', { className: 'dsf-lastLabel' }, t('last.label')),
						view.lastLine)
					: null);
		}

		/** Required client services: the tab-type registry, slots, copy, sessions. */
		const inject = ['sidebarRightTabs', 'slots', 'locale', 'sessions'];

		/**
		 * Client plugin body: register the dictionaries, the tab type with its
		 * guide entry, and the tab body + title occupants; return their disposal.
		 * @param {import('@deepseek-ai/cordis').Context} ctx client root context.
		 * @returns {() => void} cleanup.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'software-factory: dictionaries');
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: 'factory',
				priority: 'extension',
				title: () => t('tab.title'),
				guide: [{
					id: 'factory',
					order: 40,
					title: () => t('tab.title'),
					description: () => t('guide.description'),
					icon: FactoryGlyph,
				}],
			}), 'software-factory: tab type');
			const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
				name: 'sidebar.right.pane.tab',
				key: TAB_ID,
				locale: NS,
				inject: (sessionId) => ({
					hooks: {
						factoryState: ctx.sessions.binding(sessionId)?.session?.projections?.faceOf(PROJECTION_KEY) ?? ABSENT_FACE,
					},
				}),
			}, FactoryTabBody));
			const disposeTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
				name: 'sidebar.right.pane.tab.title',
				key: TAB_ID,
			}, FactoryTabTitle));
			return () => {
				disposeTitle();
				disposeBody();
			};
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
