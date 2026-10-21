/**
 * @local/dsh-software-factory — Client half (Web platform).
 *
 * Registers the "Factory" right-sidebar tab: a compact panel listing the
 * nine pipeline phases with live status, plus the latest narration line.
 * State comes from the Host's `factory` session projection, read through the
 * shipped session binding's projection store
 * (`ctx.sessions.binding(id).session.projections.faceOf('factory')`); no
 * plugin-owned transport.
 *
 * One file on purpose: the client-modules contract makes a plugin bundle a
 * single module node whose imports may only be module-table leaves (`react`)
 * — relative-import chunks are compiler-generated machinery, not safe to
 * hand-author — so this bundle cannot be split like the Host half's `lib/`.
 * Internal order: constants, CSS, dictionaries, glyph + status markers,
 * title/body components, auto-open watcher, plugin body.
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
 * - Plan subpage: the plan phase row is a button that swaps the body to a
 *   detail page listing the run's whole captured plan (the wire view's
 *   `plan`, folded host-side from `todo/write` events while the run is
 *   active — the shipped `todos` projection is turn-scoped and cannot serve
 *   a durable view), with a back control returning to the phase list.
 * - Auto-open: the plugin body subscribes to `ctx.sidebarRight.mounted` (the
 *   on-screen Session observable) and, per mounted session, to its `factory`
 *   projection face; a live `runCount` increment (the Host fold counts
 *   `/factory` command runs into the wire view) calls
 *   `ctx.sidebarRight.openTab('factory')`, which also expands the column.
 *   The open is gated by the wire view's `autoOpen` flag (the plugin row
 *   config `autoOpenTab`, default on; absent means enabled).
 *   Baselines are never treated as starts — connects, replays, and session
 *   switches open nothing — and a run in a session that is not on screen is
 *   ignored, because the tab shows the on-screen session's progress.
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
		const { createElement: h, Fragment, useEffect, useState } = react;

		/** Copy namespace registered with the client locale service. */
		const NS = 'softwareFactory';
		/** The tab type's identity: the key its body and chip register under. */
		const TAB_ID = '@local/dsh-software-factory/factory-tab';
		/** The page kind this type opens by (guide capsules and `openTab` use it). */
		const TAB_KIND = 'factory';
		/** The Host projection key (must equal FACTORY_PROJECTION_KEY in index.js). */
		const PROJECTION_KEY = 'factory';
		/** Status values the Host projection emits. */
		const STATUSES = ['pending', 'active', 'done', 'skipped', 'failed'];
		/** Todo statuses (the captured plan) mapped onto the phase status dots. */
		const TODO_STATUS_TO_DOT = { pending: 'pending', in_progress: 'active', completed: 'done' };
		/** Queue item statuses mapped onto the phase status dots. */
		const QUEUE_STATUS_TO_DOT = { queued: 'pending', running: 'active', succeeded: 'done', failed: 'failed' };
		/** The queue read model served by this plugin's Host half (read-only). */
		const QUEUE_URL = '/plugins/@local/dsh-software-factory/queue.json';
		/** Queue page poll interval. */
		const QUEUE_POLL_MS = 2000;
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
			'.dsf-rowButton{width:100%;text-align:left;background:0 0;border:0;font:inherit;color:inherit;cursor:pointer}',
			'.dsf-rowButton:hover,.dsf-rowButton:focus-visible{background:var(--dsw-alias-fill-l1)}',
			'.dsf-rowChevron{flex:none;color:var(--dsw-alias-label-tertiary)}',
			'.dsf-back{align-self:flex-start;background:0 0;border:0;padding:2px 6px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:18px}',
			'.dsf-back:hover,.dsf-back:focus-visible{background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary)}',
			'.dsf-planTitle{padding:0 6px;color:var(--dsw-alias-label-primary)}',
			'.dsf-planList{display:flex;flex-direction:column;gap:1px}',
			'.dsf-planRow{display:flex;align-items:flex-start;gap:8px;padding:4px 6px;border-radius:var(--dsw-radius-sm)}',
			'.dsf-planRow .dsf-dot{margin-top:3px}',
			'.dsf-planRowActive{background:var(--dsw-alias-fill-l1)}',
			'.dsf-planText{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}',
			'.dsf-nav{display:flex;justify-content:flex-end}',
			'.dsf-navButton{background:0 0;border:0;padding:2px 6px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;line-height:16px}',
			'.dsf-navButton:hover,.dsf-navButton:focus-visible{background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary)}',
			'.dsf-queueRow .dsf-dot{margin-top:3px}',
			'.dsf-queueMain{flex:1;min-width:0}',
			'.dsf-queueTitle{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.dsf-queueId{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;margin-right:6px}',
			'.dsf-queueStatus{color:var(--dsw-alias-label-tertiary);margin-right:6px}',
			'.dsf-queueMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.dsf-queueFailure{color:var(--dsw-alias-state-error-primary);font-size:11px;overflow-wrap:anywhere}',
			'.dsf-queueHalted{padding:6px 8px;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-state-error-primary)}',
			'.dsf-queueHaltedTitle{font-size:12px}',
			'.dsf-queueAckHint{font-size:11px;color:var(--dsw-alias-label-secondary)}',
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
			'guide.description': '在侧栏跟踪 /factory 九阶段交付流水线的实时进度。',
			'empty.none': '当前没有正在运行的工厂流水线',
			'empty.hint': '输入 /factory <需求> 启动 9 阶段交付流水线。',
			'empty.unavailable': '进度不可用（未加载进度投影）。',
			'last.label': '最新状态',
			'plan.title': '本轮计划',
			'plan.back': '‹ 阶段列表',
			'plan.empty': '本轮运行还没有记录计划（阶段 2 会用 todo 工具写入）。',
			'plan.openAria': '查看本轮计划',
			'queue.nav': '队列',
			'queue.back': '‹ 阶段列表',
			'queue.title': '工厂队列',
			'queue.empty': '队列为空 —— 用 /factory -q <需求> 入队。',
			'queue.halted': '队列已因失败暂停',
			'queue.ackHint': '运行 /factory queue ack 恢复调度。',
			'queue.loadError': '队列状态不可用（读取失败）。',
			'queue.wholeWorkspace': '（整个工作区）',
			'queue.item.queued': '待运行',
			'queue.item.running': '运行中',
			'queue.item.succeeded': '已完成',
			'queue.item.failed': '失败',
			'status.pending': '待执行',
			'status.active': '进行中',
			'status.done': '已完成',
			'status.skipped': '已跳过',
			'status.failed': '失败',
		};
		/** English dictionary, key-identical to the Chinese source of truth. */
		const en = {
			'tab.title': 'Factory',
			'guide.description': "Track a /factory run's live 9-phase delivery progress in the sidebar.",
			'empty.none': 'No active factory run',
			'empty.hint': 'Type /factory <request> to start the 9-phase delivery pipeline.',
			'empty.unavailable': 'Progress unavailable (progress projection not loaded).',
			'last.label': 'Latest status',
			'plan.title': 'Plan for this run',
			'plan.back': '‹ Phases',
			'plan.empty': 'No plan recorded for this run yet (phase 2 writes it with the todo tool).',
			'plan.openAria': 'Show the plan for this run',
			'queue.nav': 'Queue',
			'queue.back': '‹ Phases',
			'queue.title': 'Factory queue',
			'queue.empty': 'The queue is empty — enqueue with /factory -q <request>.',
			'queue.halted': 'Queue halted by a failure',
			'queue.ackHint': 'Run /factory queue ack to resume scheduling.',
			'queue.loadError': 'Queue status unavailable (fetch failed).',
			'queue.wholeWorkspace': '(whole workspace)',
			'queue.item.queued': 'queued',
			'queue.item.running': 'running',
			'queue.item.succeeded': 'succeeded',
			'queue.item.failed': 'failed',
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
		 * The plan detail page: the run's whole captured plan (the todo list
		 * phase 2 records), one row per task with its live todo status, and a
		 * back control returning to the phase list.
		 */
		function FactoryPlanPage({ plan, t, onBack }) {
			const items = Array.isArray(plan) ? plan : [];
			return h('div', { className: 'dsf-root' },
				h('button', {
					type: 'button',
					className: 'dsf-back',
					onClick: onBack,
					'aria-label': t('plan.back'),
				}, t('plan.back')),
				h('div', { className: 'dsf-planTitle' }, t('plan.title')),
				items.length === 0
					? h('div', { className: 'dsf-empty' },
						h('div', { className: 'dsf-emptyTitle' }, t('plan.empty')))
					: h('div', { className: 'dsf-planList', role: 'list' }, items.map((item, index) => h('div', {
						className: `dsf-planRow${item.status === 'in_progress' ? ' dsf-planRowActive' : ''}`,
						role: 'listitem',
						key: `${index}:${item.content}`,
					},
					h(StatusDot, { status: TODO_STATUS_TO_DOT[item.status] ?? 'pending' }),
					h('span', { className: 'dsf-planText' }, item.content)))));
		}

		/**
		 * The queue page (pure renderer): the global factory queue read model —
		 * one row per item (id, status, summary, scopes, failure reason), the
		 * halt banner with its ack hint when a failure froze the queue, and a
		 * back control returning to the phase list.
		 */
		function FactoryQueuePage({ queue, error, t, onBack }) {
			const items = Array.isArray(queue?.items) ? queue.items : [];
			return h('div', { className: 'dsf-root' },
				h('button', {
					type: 'button',
					className: 'dsf-back',
					onClick: onBack,
					'aria-label': t('queue.back'),
				}, t('queue.back')),
				h('div', { className: 'dsf-planTitle' }, t('queue.title')),
				queue?.halted === true
					? h('div', { className: 'dsf-queueHalted' },
						h('div', { className: 'dsf-queueHaltedTitle' }, t('queue.halted')),
						h('div', { className: 'dsf-queueAckHint' }, t('queue.ackHint')))
					: null,
				error !== null && queue === null
					? h('div', { className: 'dsf-empty' },
						h('div', { className: 'dsf-emptyTitle' }, t('queue.loadError')))
					: items.length === 0
						? h('div', { className: 'dsf-empty' },
							h('div', { className: 'dsf-emptyTitle' }, t('queue.empty')))
						: h('div', { className: 'dsf-planList', role: 'list' }, items.map((item) => h('div', {
							className: `dsf-queueRow${item.status === 'running' ? ' dsf-planRowActive' : ''}`,
							role: 'listitem',
							key: item.id,
						},
						h(StatusDot, { status: QUEUE_STATUS_TO_DOT[item.status] ?? 'pending' }),
						h('div', { className: 'dsf-queueMain' },
							h('div', { className: 'dsf-queueTitle' },
								h('span', { className: 'dsf-queueId' }, `[${item.id}]`),
								h('span', { className: 'dsf-queueStatus' }, t(`queue.item.${QUEUE_STATUS_TO_DOT[item.status] === 'failed' ? 'failed' : item.status}`)),
								typeof item.summary === 'string' && item.summary !== '' ? item.summary : ''),
							h('div', { className: 'dsf-queueMeta' },
								Array.isArray(item.scopes) && item.scopes.length > 0
									? item.scopes.join(', ')
									: t('queue.wholeWorkspace')),
							typeof item.failureReason === 'string' && item.failureReason !== ''
								? h('div', { className: 'dsf-queueFailure' }, item.failureReason)
								: null)))));
		}

		/**
		 * The queue page's live wrapper: polls the Host's read-only queue.json
		 * route while mounted (same-origin fetch; this bundle runs as a real
		 * browser script) and renders the pure page from the latest snapshot.
		 */
		function FactoryQueuePageLive({ t, onBack }) {
			const [queue, setQueue] = useState(null);
			const [error, setError] = useState(null);
			useEffect(() => {
				let alive = true;
				const load = () => {
					fetch(QUEUE_URL)
						.then((response) => response.json())
						.then((data) => {
							if (alive) {
								setQueue(data);
								setError(null);
							}
						})
						.catch(() => {
							if (alive) setError('fetch failed');
						});
				};
				load();
				const timer = setInterval(load, QUEUE_POLL_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);
			return h(FactoryQueuePage, { queue, error, t, onBack });
		}

		/**
		 * The tab body: nine phase rows with live status, the latest narration
		 * line verbatim, and a quiet empty state when nothing runs. The plan
		 * phase row is a button that opens the plan detail page, and the nav
		 * row's Queue button opens the global queue page (both in-tab
		 * subpages); the framework binds `hooks.factoryState` (this occupant's
		 * inject face) into the `useFactoryState(selector)` selector hook, and
		 * `t` comes from the registration's `locale` seat.
		 */
		function FactoryTabBody({ useFactoryState, t }) {
			const view = useFactoryState(identity);
			const [page, setPage] = useState('phases');
			if (page === 'queue') {
				return h(FactoryQueuePageLive, { t, onBack: () => setPage('phases') });
			}
			/** The Queue nav entry: opens the global queue page from any state. */
			const queueNav = h('div', { className: 'dsf-nav' },
				h('button', {
					type: 'button',
					className: 'dsf-navButton',
					onClick: () => setPage('queue'),
					title: t('queue.nav'),
				}, t('queue.nav')));
			if (view === undefined || view === null) {
				return h('div', { className: 'dsf-root' },
					queueNav,
					h('div', { className: 'dsf-empty' },
						h('div', { className: 'dsf-emptyTitle' }, t('empty.unavailable'))));
			}
			if (page === 'plan') {
				return h(FactoryPlanPage, { plan: view.plan, t, onBack: () => setPage('phases') });
			}
			const phases = Array.isArray(view.phases) ? view.phases : [];
			const started = view.running === true || phases.some((phase) => phase.status !== 'pending');
			if (!started) {
				return h('div', { className: 'dsf-root' },
					queueNav,
					h('div', { className: 'dsf-empty' },
						h(FactoryGlyph, { size: 28 }),
						h('div', { className: 'dsf-emptyTitle' }, t('empty.none')),
						h('div', { className: 'dsf-emptyHint' }, t('empty.hint'))));
			}
			return h('div', { className: 'dsf-root' },
				queueNav,
				h('div', { className: 'dsf-list', role: 'list' }, phases.map((phase) => {
					const status = STATUSES.includes(phase.status) ? phase.status : 'pending';
					const cells = [
						h(StatusDot, { status }),
						h('span', { className: 'dsf-num' }, `${phase.n}/9`),
						h('span', { className: 'dsf-key' }, phase.key),
						h('span', {
							className: 'dsf-text',
							title: phase.text ?? t(`status.${status}`),
						}, phase.text ?? t(`status.${status}`))];
					// The plan row opens the plan detail page.
					if (phase.key === 'plan') {
						cells.push(h('span', { className: 'dsf-rowChevron', 'aria-hidden': 'true' }, '›'));
						return h('button', {
							type: 'button',
							className: `dsf-row dsf-rowButton${status === 'active' ? ' dsf-rowActive' : ''}`,
							role: 'listitem',
							key: phase.key,
							onClick: () => setPage('plan'),
							title: t('plan.openAria'),
						}, ...cells);
					}
					return h('div', {
						className: `dsf-row${status === 'active' ? ' dsf-rowActive' : ''}`,
						role: 'listitem',
						key: phase.key,
					}, ...cells);
				})),
				typeof view.lastLine === 'string' && view.lastLine !== ''
					? h('div', { className: 'dsf-last' },
						h('span', { className: 'dsf-lastLabel' }, t('last.label')),
						view.lastLine)
					: null);
		}

		/** Required client services: the tab-type registry, the navigation
		 * controller (auto-open), slots, copy, sessions. */
		const inject = ['sidebarRightTabs', 'sidebarRight', 'slots', 'locale', 'sessions'];

		/**
		 * Auto-open watcher: subscribe to the on-screen Session observable and,
		 * per mounted session, to its `factory` projection face. A live
		 * `runCount` increment against a numeric baseline means a `/factory`
		 * command just ran in the session the user is looking at — open the
		 * tab (which also expands the column), unless the wire view's
		 * `autoOpen` is explicitly `false` (the plugin row config's
		 * `autoOpenTab` switch, default on; an absent field — an older Host —
		 * means enabled). A baseline read or a session
		 * switch only (re-)baselines, so connects, replays, and history never
		 * open anything; a run in a session that is not on screen is ignored
		 * because the tab shows the on-screen session's progress.
		 * @param {import('@deepseek-ai/cordis').Context} ctx client root context.
		 * @returns {() => void} cleanup.
		 */
		function watchFactoryStarts(ctx) {
			const mounted = ctx.sidebarRight.mounted;
			let stopFace = () => {};
			const runCountOf = (view) => (typeof view?.runCount === 'number' ? view.runCount : undefined);
			const rebaseline = () => {
				stopFace();
				stopFace = () => {};
				const sessionId = mounted.getSnapshot();
				if (sessionId === undefined) return;
				const face = ctx.sessions.binding(sessionId)?.session?.projections?.faceOf(PROJECTION_KEY);
				if (face === undefined) return;
				let baseline = runCountOf(face.getSnapshot());
				stopFace = face.subscribe(() => {
					const view = face.getSnapshot();
					const current = runCountOf(view);
					if (baseline !== undefined && current !== undefined && current > baseline
						&& view.autoOpen !== false) {
						try {
							ctx.sidebarRight.openTab(TAB_KIND);
						} catch (error) {
							console.error('software-factory: auto-open failed:', error);
						}
					}
					baseline = current;
				});
			};
			const stopMounted = mounted.subscribe(rebaseline);
			rebaseline();
			return () => {
				stopMounted();
				stopFace();
			};
		}

		/**
		 * Client plugin body: register the dictionaries, the tab type with its
		 * guide entry, the tab body + title occupants, and the auto-open
		 * watcher; return their disposal.
		 * @param {import('@deepseek-ai/cordis').Context} ctx client root context.
		 * @returns {() => void} cleanup.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'software-factory: dictionaries');
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: TAB_KIND,
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
			ctx.effect(() => watchFactoryStarts(ctx), 'software-factory: auto-open on run start');
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
