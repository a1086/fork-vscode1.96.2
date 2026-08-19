/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { IAction, Separator, SubmenuAction, toAction } from '../../../../base/common/actions.js';
import { ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { ActivePanelContext, PanelFocusContext, ActivePanelLeftContext, ActivePanelRightContext, PanelLeftFocusContext, PanelRightFocusContext } from '../../../common/contextkeys.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchLayoutService, Parts, Position, SINGLE_WINDOW_PARTS } from '../../../services/layout/browser/layoutService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { PANEL_BACKGROUND, PANEL_TITLE_BORDER, PANEL_ACTIVE_TITLE_FOREGROUND, PANEL_INACTIVE_TITLE_FOREGROUND, PANEL_ACTIVE_TITLE_BORDER, PANEL_DRAG_AND_DROP_BORDER } from '../../../common/theme.js';
import { badgeBackground, badgeForeground } from '../../../../platform/theme/common/colorRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IViewContainerModel, IViewDescriptorService, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../paneCompositePart.js';
import { getContextMenuActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IPaneCompositeBarOptions } from '../paneCompositeBar.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CompositeDragAndDropObserver, ICompositeDragAndDrop, Before2D, CompositeDragAndDropData } from '../../dnd.js';
import { Composite } from '../../composite.js';
import { trackFocus, addDisposableListener, EventType, Dimension } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IPaneComposite } from '../../../common/panecomposite.js';
import { PaneComposite } from '../../panecomposite.js';
import { PanelPart } from './panelPart.js';

export type PanelSide = 'left' | 'right';

/**
 * A single side of the dual-panel layout. It is a full `AbstractPaneCompositePart`
 * (own title bar, own composite bar, own content area) but:
 *  - is NOT the `Parts.PANEL_PART` itself, so it does not participate in the
 *    workbench layout grid (the parent `PanelPart` does);
 *  - never toggles the visibility of the whole Panel when opening/closing a view;
 *  - persists its own active view container and pin state under a side-specific
 *    storage key, so the two sides can show different views simultaneously.
 *
 * The parent `PanelPart` owns a `SplitView` and wraps each `PanelSidePart` in an
 * `IView` adapter (see panelPart.ts), driving `layout` from the split sashes.
 */
export class PanelSidePart extends AbstractPaneCompositePart {

	readonly minimumWidth: number = 150;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	readonly minimumHeight: number = 0;
	readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	readonly side: PanelSide;

	/**
	 * Last dimension this side was laid out with. Used to re-apply a layout to a
	 * composite that was opened *before* the first `layout()` arrived (which
	 * happens during `create()` -> `restore()`), because `CompositePart.showComposite`
	 * silently skips `composite.layout()` while `contentAreaSize` is undefined.
	 */
	private lastLayoutDimension: { width: number; height: number } | undefined;

	/**
	 * True while a composite/view drag is in progress (anywhere in the workbench,
	 * not just this side). Used by `ensureFirstViewWorkingAfterRemoval` so that a
	 * side does NOT immediately clear to the "Drag a view here" placeholder the
	 * instant the last view starts being dragged out — the dragged view's content
	 * is still in the DOM during the drag, so keeping it visible is correct (and
	 * if the drag is cancelled it simply snaps back). The final empty state is
	 * decided on `onDragEnd` instead.
	 */
	private isDragInProgress = false;

	static readonly activePanelSettingsKeyFor = (side: PanelSide) => `workbench.panel.${side}.activepanelid`;

	constructor(
		side: PanelSide,
		private readonly panelPart: PanelPart,
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IExtensionService extensionService: IExtensionService,
		@IMenuService menuService: IMenuService,
		@IConfigurationService private configurationService: IConfigurationService
	) {
		super(
			// Unique, non-grid id so registerPart() does not conflict with Parts.PANEL_PART
			`workbench.panel.${side}`,
			{ hasTitle: true },
			PanelSidePart.activePanelSettingsKeyFor(side),
			(side === 'left' ? ActivePanelLeftContext : ActivePanelRightContext).bindTo(contextKeyService),
			(side === 'left' ? PanelLeftFocusContext : PanelRightFocusContext).bindTo(contextKeyService),
			'panel',
			`panel-${side}`,
			undefined,
			PANEL_TITLE_BORDER,
			notificationService,
			storageService,
			contextMenuService,
			layoutService,
			keybindingService,
			hoverService,
			instantiationService,
			themeService,
			viewDescriptorService,
			contextKeyService,
			extensionService,
			menuService,
		);

		this.side = side;

		// Track workbench-wide drag start/end so `ensureFirstViewWorkingAfterRemoval`
		// can defer clearing an emptied side until the drag actually finishes.
		this._register(CompositeDragAndDropObserver.INSTANCE.onDragStart(() => {
			this.isDragInProgress = true;
		}));
		this._register(CompositeDragAndDropObserver.INSTANCE.onDragEnd(() => {
			this.isDragInProgress = false;
			// The drag finished. If the side's container really is empty now
			// (the view was dropped outside the Panel), fall back to the empty
			// placeholder. If the drag was cancelled the view is back, so this
			// is a no-op.
			const composite = this.getActivePaneComposite() as PaneComposite | undefined;
			const container = composite ? this.viewDescriptorService.getViewContainerById(composite.getId()) : undefined;
			if (container) {
				const model = this.viewDescriptorService.getViewContainerModel(container);
				if (model.allViewDescriptors.length === 0) {
					this.clearActivePaneComposite();
					this.unpinPaneComposite(container.id);
					this.refreshCompositeBar();
				}
			}
		}));

		// Mirror this side's active panel id and focus into the shared global
		// context keys for backward compatibility (commands/extensions that
		// still read `activePanel`/`panelFocus` get the most recently active
		// side). The side-specific keys (`activePanelLeft`/`activePanelRight`,
		// `panelLeftFocus`/`panelRightFocus`) are tracked independently by the
		// parent so the two sides never overwrite each other.
		const globalActivePanelKey = ActivePanelContext.bindTo(contextKeyService);

		this._register(this.onDidPaneCompositeOpen(composite => {
			globalActivePanelKey.set(composite.getId());
		}));
		this._register(this.onDidPaneCompositeClose(composite => {
			const id = composite.getId();
			if (globalActivePanelKey.get() === id) {
				globalActivePanelKey.reset();
			}
		}));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('workbench.panel.showLabels')) {
				this.updateCompositeBar(true);
			}
		}));
	}

	override create(parent: HTMLElement): void {
		super.create(parent);

		// Mirror this side's focus into the shared global `panelFocus` key for
		// backward compatibility. This must run after `create()` so the
		// container element exists (a `trackFocus` in the constructor would
		// dereference `undefined` because the part is not yet created).
		const globalPanelFocusKey = PanelFocusContext.bindTo(this.contextKeyService);
		this._register(trackFocus(this.getContainer()!).onDidFocus(() => globalPanelFocusKey.set(true)));
		this._register(trackFocus(this.getContainer()!).onDidBlur(() => globalPanelFocusKey.set(false)));

		// Mirror this side's focus into the side-specific `panelLeftFocus` /
		// `panelRightFocus` context keys. `PanelPart.getActivePaneComposite()`
		// relies on these to report the composite of the *actually focused*
		// side; without them the keys stay `false` and the Panel always falls
		// back to the right side, so a view hosted in the left panel (e.g. the
		// Terminal) is reported as inactive and becomes non-functional.
		const sideFocusKey = (this.side === 'left' ? PanelLeftFocusContext : PanelRightFocusContext).bindTo(this.contextKeyService);
		const otherSideFocusKey = (this.side === 'left' ? PanelRightFocusContext : PanelLeftFocusContext).bindTo(this.contextKeyService);
		this._register(trackFocus(this.getContainer()!).onDidFocus(() => {
			sideFocusKey.set(true);
			// Remember which side the user last interacted with so that a
			// focus-less "Hide Panel" gesture (clicking the side's title-bar
			// close button blurs the side container) still collapses the side
			// the user was looking at, instead of always the right side.
			this.panelPart.setLastFocusedSide(this.side);
			// Clear the other side's focus so the two sides never claim focus
			// at once; trackFocus fires the blur of the old side before the
			// focus of the new side, so this is effectively a no-op when moving
			// between the two panels but correctly clears it when focus leaves
			// the panel entirely.
			otherSideFocusKey.set(false);
		}));
		this._register(trackFocus(this.getContainer()!).onDidBlur(() => {
			// Clear *this* side's focus when it loses DOM focus. We do NOT
			// clear the other side's key here on purpose: blur fires for the
			// old side *before* focus fires for the new side, so clearing the
			// other side in `onDidFocus` (above) is the correct place. Leaving
			// the other side untouched on blur means that if focus leaves the
			// whole panel, this side correctly reports `false` while the other
			// side's stale `true` (if any) is reset by its own blur. This keeps
			// the two nested side containers from simultaneously claiming focus
			// and avoids the "Hide Panel on the left closes the right" bug.
			sideFocusKey.set(false);
		}));

		// Record which side the user is interacting with on *any* mouse press
		// inside this side (content, title bar, composite bar or the title-bar
		// "Hide Panel" button). This is more reliable than the focus-based
		// `trackFocus` path above: clicking the title-bar close button does not
		// move DOM focus into the side's content, so `onDidFocus` never fires
		// for that gesture and `lastFocusedSide` would otherwise stay stale.
		// `PanelPart.getSideToHide()` reads `lastFocusedSide` so that a
		// focus-less "Hide Panel" click collapses the side the user actually
		// pressed the button on (and not always the right side).
		const container = this.getContainer()!;
		this._register(addDisposableListener(container, EventType.MOUSE_DOWN, () => {
			this.panelPart.setLastFocusedSide(this.side);
		}, true));
	}

	/**
	 * Re-open this side's last-active (or preferred) view container. Called by
	 * the parent `PanelPart` after the split is built so each side restores its
	 * own persisted active view independently.
	 *
	 * Unlike the base class we do NOT fall back to the global default panel id:
	 * that id is shared by both sides, so falling back would make the two sides
	 * open the very same view. When `preferredId` is undefined we simply open
	 * nothing and let the parent decide which container this side should show.
	 */
	async restore(preferredId?: string): Promise<void> {
		if (typeof preferredId !== 'string') {
			return;
		}
		// Defer the actual open until the workbench layout grid is built and
		// built-in / extension-provided views have been registered with the
		// view descriptor service. During `PanelPart.create` (which fires very
		// early in `Workbench.renderWorkbench`) `Workbench.panelPartView` is
		// still `undefined` and `ViewContainerModel` for some contribs has not
		// been constructed yet, so opening containers synchronously here would
		// crash `Workbench.ensurePaneSize` (preferredHeight of undefined) and
		// `MarkersView.calculateTitle` (view->container mapping not ready).
		//
		// `whenRestored` resolves only after the layout grid is fully built (and
		// `panelPartView` is assigned), which is exactly the point at which we
		// may safely open a container without hitting those early-startup bugs.
		await this.layoutService.whenRestored;
		// Restore the persisted layout faithfully: skip the view-level mutual
		// exclusion gate so both sides' previously-saved containers are opened
		// exactly as they were (without the second restore clearing the first).
		// Mutual exclusion still applies to all user-driven opens and drops.
		await this.openPaneComposite(preferredId, undefined, undefined, true);
	}

	/**
	 * 双栏分区后，让本 side 容器内"从左往右第一个视图"处于工作状态：可见 + 展开 +
	 * tab 选中，单视图模式下容器仅含一个视图时本方法无副作用。
	 *
	 * 重要：用 `allViewDescriptors[0]` 而不是 `visibleViewDescriptors[0]`。后者只
	 * 包含当前已可见的视图——而 Panel 分区刷新或视图上次被用户隐藏（如 OUTPUT）时，
	 * `allViewDescriptors` 顺序中的"第一个"（OUTPUT container 即 OUTPUT）并不在
	 * `visibleViewDescriptors` 里。
	 *
	 * 为什么"闪一下又消失"以及如何根除：
	 *   `ViewPaneContainer` 在 `create()` 末尾用
	 *   `extensionService.whenInstalledExtensionsRegistered().then(() => updateViewHeaders())`
	 *   异步地、在扩展就绪后才重算视图头部。对"曾在单视图合并模式下被折叠"的视图，
	 *   `updateViewHeaders()`（多视图分支）会把 `lastMergedCollapsedPane` 重新
	 *   `setExpanded(false)` —— 也正因如此，仅在本方法里的"立即展开"之后，那次异步
	 *   `updateViewHeaders` 又把它折回去，表现为"内容闪一下又变回空占位"。
	 *
	 *   因此本方法除了"立即展开一次"之外，还监听 `viewContainerModel` 的
	 *   `onDidChangeActiveViewDescriptors`：只要视图列表（含扩展就绪触发的那次
	 *   `updateViewHeaders`）发生任何变化，就用 `RunOnceScheduler(0)` 合并后在"最终态"
	 *   再 `openView` 一次，把首视图重新展开。这样既覆盖了刷新时的竞态，又不会因
	 *   连续多次变化而反复展开（scheduler 只跑最终一次）。
	 */
	// Listeners created by the most recent `ensureFirstViewWorking` call for this
	// side. Re-created (cleared + re-registered) on every call so they never leak
	// or accumulate across the many call sites (open, restore, relayoutSides, drag
	// move). Accumulated listeners were a key cause of the Terminal "duplicate
	// powershell" recurrence: stale body-visibility listeners kept re-triggering
	// `openView` -> `_initializeTerminal` long after the view had settled.
	private readonly ensureFirstViewWorkingSubscriptions = this._register(new DisposableStore());

	ensureFirstViewWorking(): void {
		const composite = this.getActivePaneComposite() as PaneComposite | undefined;
		const viewPaneContainer = composite?.getViewPaneContainer();
		if (!viewPaneContainer || !composite) {
			return;
		}
		// `viewContainerModel` 是 ViewPaneContainer 的 protected 字段，外部不可直接
		// 访问；这里改用公开的 IViewDescriptorService.getViewContainerModel 拿到同一
		// 个 model 实例（按 container id 查）。
		const container = this.viewDescriptorService.getViewContainerById(composite.getId());
		if (!container) {
			return;
		}
		const viewContainerModel = this.viewDescriptorService.getViewContainerModel(container);
		const firstDescriptor = viewContainerModel.allViewDescriptors[0];

		// Reset subscriptions so repeated calls (open / restore / relayoutSides /
		// drag move) never stack listeners on top of each other. Each entry below
		// is re-registered against this fresh store.
		this.ensureFirstViewWorkingSubscriptions.clear();

		if (!firstDescriptor) {
			// The container exists but its view descriptor is not registered yet.
			// This is the case for *dynamically registered* Panel views such as
			// Ports (TUNNEL_VIEW_CONTAINER_ID): the `ForwardedPortsView` workbench
			// contribution only registers the Ports view once the
			// `forwardedPortsFeaturesEnabled` / `forwardedPortsViewEnabled` context
			// keys are set, which happens asynchronously (it `await`s
			// `getViewContainer()`). During `PanelPart.create` -> `restore()` the
			// restore opens the container and `ensureFirstViewWorking` runs *before*
			// that registration completes, so `allViewDescriptors` is empty here.
			//
			// Bailing out at this point (as the old code did) left the Panel side
			// showing the "Drag a view here to display" placeholder forever after a
			// reload: the view registered later, but nothing re-triggered
			// `ensureFirstViewWorking` to expand it. Fix: subscribe (once) to the
			// container model's descriptor-change event and re-run this method as
			// soon as the first descriptor appears. The subscription lives in
			// `ensureFirstViewWorkingSubscriptions`, so the next call (when the
			// descriptor is present) clears it cleanly and no listener leaks.
			const retryWhenDescriptorAvailable = new RunOnceScheduler(() => {
				// The container may have been cleared/switched in the meantime.
				if (this.getActivePaneComposite() === composite) {
					this.ensureFirstViewWorking();
				}
			}, 0);
			this.ensureFirstViewWorkingSubscriptions.add(retryWhenDescriptorAvailable);
			this.ensureFirstViewWorkingSubscriptions.add(viewContainerModel.onDidChangeActiveViewDescriptors(() => {
				// Only re-run once a descriptor is actually available; the
				// RunOnceScheduler guarantees we do not spin on every change.
				if (viewContainerModel.allViewDescriptors.length > 0) {
					retryWhenDescriptorAvailable.schedule();
				}
			}));
			return;
		}

		// 1) 取消折叠（持久化）—— 否则 `updateViewHeaders` 多视图分支会把首视图当作
		//    `lastMergedCollapsedPane` 再折叠一次（"闪一下消失"的直接原因）。
		if (viewContainerModel.isCollapsed(firstDescriptor.id)) {
			viewContainerModel.setCollapsed(firstDescriptor.id, false);
		}
		// 2) 确保可见——如果上次被隐藏，`setVisible(true)` 会触发
		//    `onDidAddVisibleViewDescriptors` 创建 pane 并加入 tab 列表。
		if (!viewContainerModel.isVisible(firstDescriptor.id)) {
			viewContainerModel.setVisible(firstDescriptor.id, true);
		}

		// 3) 用官方入口 `openView` 把首视图真正展开并渲染 body。`ViewPaneContainer.openView`
		//    在视图已存在时只 `setExpanded(true)`（容器 `setVisible(true)` 已由
		//    showComposite 同步置位，故 body 立即渲染）；不存在时则 toggle 可见后再展开。
		//    用 `composite.openView`（而非手动 setVisible/setExpanded）可同时兼容单视图
		//    合并模式与多视图模式，是最稳的"确保视图工作状态"入口。
		// 对已经展开/收起的 pane 挂一次 body 可见性监听（去重），捕获
		// `updateViewHeaders` 在合并模式下把唯一视图 `setExpanded(false)` 折回的
		// 那一拍。它不 fire 容器级可见性/活动视图事件，所以必须直接盯 pane 的 body。
		const registeredBodyListeners = new Set<string>();
		const watchPaneBody = (pane: { id: string; onDidChangeBodyVisibility: (cb: (visible: boolean) => void) => { dispose(): void } }) => {
			if (registeredBodyListeners.has(pane.id)) {
				return;
			}
			registeredBodyListeners.add(pane.id);
			this.ensureFirstViewWorkingSubscriptions.add(pane.onDidChangeBodyVisibility(visible => {
				// 仅当本 side 仍激活该 composite 时才补展开，避免关闭侧时误触发。
				if (!visible && this.getActivePaneComposite() === composite) {
					openFirstScheduler.schedule();
				}
			}));
		};

		// 4) 覆盖竞态的关键：视图列表在扩展就绪 / 视图被创建后会再变，对应那次
		//    `updateViewHeaders` 可能把首视图折回。用一次性 scheduler 合并连续变化，
		//    在"最终态"再补一次 `openView`，确保首视图最终稳定在工作状态。
		const openFirstScheduler = new RunOnceScheduler(() => openFirst(), 0);
		this.ensureFirstViewWorkingSubscriptions.add(openFirstScheduler);

		const openFirst = () => {
			// 容器尚未可见时展开无意义（body 不会渲染），等它可见再补。
			if (!viewPaneContainer.isVisible()) {
				return;
			}
			const pane = viewPaneContainer.getView(firstDescriptor.id);
			if (!pane) {
				return;
			}
			// 对当前已存在的 pane 挂一次监听，覆盖"启动时 OUTPUT 已存在但一直折叠"的情况。
			watchPaneBody(pane);
			// 已是工作状态则无需任何操作，避免无谓的 body 重渲染/闪烁。
			if (pane.isVisible() && pane.isExpanded()) {
				return;
			}
			composite.openView(firstDescriptor.id, false);
		};

		// 先立即尝试一次（容器此刻已可见时直接展开）。
		openFirst();

		this.ensureFirstViewWorkingSubscriptions.add(viewContainerModel.onDidChangeActiveViewDescriptors(() => {
			openFirstScheduler.schedule();
		}));
		// `setVisible(true)` 触发的是 `onDidAddVisibleViewDescriptors` 而不是
		// `onDidChangeActiveViewDescriptors`。首视图之前被隐藏时，上面的立即
		// `openFirst()` 会因为 pane 尚未创建而直接返回；必须在这里补一次展开，
		// 否则容器标签已高亮但内容区仍显示 "Drag a view here"。
		this.ensureFirstViewWorkingSubscriptions.add(viewContainerModel.onDidAddVisibleViewDescriptors(refs => {
			if (refs.some(ref => ref.viewDescriptor.id === firstDescriptor.id)) {
				openFirstScheduler.schedule();
				// 视图被加入后，pane 已存在：挂一个 body 可见性监听，捕获
				// `updateViewHeaders` 把合并模式唯一视图 `setExpanded(false)` 折回
				// 的那一拍（它不 fire 容器级事件），发现被折回就再补一次展开。
				const pane = viewPaneContainer.getView(firstDescriptor.id);
				if (pane) {
					this.ensureFirstViewWorkingSubscriptions.add(pane.onDidChangeBodyVisibility(visible => {
						// 仅当本 side 仍激活该 composite 时才补，避免关闭侧时误触发。
						if (!visible && this.getActivePaneComposite() === composite) {
							openFirstScheduler.schedule();
						}
					}));
				}
			}
		}));

		// 5) 兜底：若容器此刻尚未可见（罕见，例如 Panel 整体还没 laid out），等它变
		//    可见的那一拍补齐，保证 body 真正渲染出来。
		if (!viewPaneContainer.isVisible()) {
			this.ensureFirstViewWorkingSubscriptions.add(viewPaneContainer.onDidChangeVisibility(visible => {
				if (visible) {
					openFirst();
					openFirstScheduler.schedule();
				}
			}));
		}
	}

	override async openPaneComposite(id?: string, focus?: boolean, skipMaximizeOnShow?: boolean, skipExclusion?: boolean): Promise<IPaneComposite | undefined> {
		if (typeof id === 'string') {
			// 视图级互斥（统一入口）：同一 view 绝不能同时在左右两侧显示。
			//
			// 之前只有 `!skipExclusion` 路径（用户操作）会检查另一侧，而
			// `skipExclusion=true`（系统还原：create() 的 restore / Toggle Panel
			// 的 savedLayout 还原）会**完全跳过**这一检查，导致两侧共享同一 view
			// 的容器被同时打开并各自写入 storage，刷新/Toggle 后复现"两栏相同视图"。
			//
			// 现在统一：无论是否 skipExclusion，只要本侧要开的容器与**另一侧已激活**
			// 的容器共享 view：
			//   - 非 skipExclusion（用户操作）：照旧释放另一侧后本侧打开；
			//   - skipExclusion（系统还原）：另一侧也已/将要被还原，本侧**禁止打开**
			//     这个冲突容器（基线侧保留），返回 undefined 使基类 `showComposite`
			//     不会被触发、冲突值不会写回 storage。这是从写入侧彻底根治重复。
		const otherActiveId = this.panelPart.getOtherSidePart(this.side).getActivePaneComposite()?.getId();
			if (otherActiveId && this.panelPart.containersShareView(otherActiveId, id)) {
				if (!skipExclusion) {
					this.panelPart.releaseOtherSideIfViewOverlap(this.side, id);
					// fall through to open on this side below
				} else {
					// 系统还原期间：另一侧已激活且冲突，本侧不打开冲突容器。
					// 同步清除本侧持久化的 active id，切断"记忆→还原→再出现"循环。
					this.storageService.remove(PanelSidePart.activePanelSettingsKeyFor(this.side), StorageScope.WORKSPACE);
					return undefined;
				}
			}
		}

		// This side intentionally overrides `shouldAutoRevealPart()` to return
		// false so that opening a view in a side never toggles the visibility of
		// the whole Panel (the parent `PanelPart` owns visibility). But when the
		// parent Panel is *hidden* (e.g. the user opens a Panel view for the first
		// time from the View menu, or after the Panel was auto-hidden), we must
		// still reveal the parent Panel - otherwise the open appears to do nothing.
		//
		// When this open is the *side effect of a drag-and-drop* gesture
		// (`skipMaximizeOnShow`), reveal the Panel with `skipLayout` so the
		// `workbench.panel.opensMaximized` auto-maximize-on-show path is bypassed.
		// Otherwise dropping a view onto the panel would unexpectedly blow the
		// panel up to its maximized width/height (the "drag a panel view and the
		// panel suddenly becomes widest" bug).
		if (typeof id === 'string' && !this.layoutService.isVisible(Parts.PANEL_PART)) {
			this.layoutService.setPartHidden(false, Parts.PANEL_PART, mainWindow, skipMaximizeOnShow);
		}

		// Opening a view on this side must re-show it if the user had closed it
		// (the close button collapses the whole side to zero width).
		if (typeof id === 'string' && this.panelPart.isSideHidden(this.side)) {
			this.panelPart.showSide(this.side);
		}

		const composite = await super.openPaneComposite(id, focus);

		// Subscribe to the active composite's ViewPaneContainer so that dropping a
		// view onto this side activates that view's container instead of merging it
		// into the current container (which would break the current view's content).
		this.subscribeViewPaneContainer();

		// A composite opened before this side ever received a layout (the
		// `create()` -> `restore()` path) is never laid out by
		// `CompositePart.showComposite`, leaving its ViewPaneContainer at zero
		// size: the views render but stay non-functional. Re-apply the last known
		// dimension so the freshly opened composite is always sized.
		this.ensureActiveCompositeLayout();

		return composite;
	}

	/**
	 * Wire up the currently active composite's ViewPaneContainer to react to
	 * "drop a view here" requests: instead of merging the dropped view into the
	 * current container (which would wipe the current view's content), switch this
	 * side's whole content to the dropped view's owning container.
	 */
	private activeViewPaneContainerSubscriptions = this._register(new DisposableStore());

	private subscribeViewPaneContainer(): void {
		this.activeViewPaneContainerSubscriptions.clear();

		const viewPaneContainer = (this.getActivePaneComposite() as PaneComposite | undefined)?.getViewPaneContainer();
		if (!viewPaneContainer) {
			return;
		}

		const composite = this.getActivePaneComposite() as PaneComposite | undefined;
		const container = composite ? this.viewDescriptorService.getViewContainerById(composite.getId()) : undefined;
		const viewContainerModel = container ? this.viewDescriptorService.getViewContainerModel(container) : undefined;
		if (!viewContainerModel) {
			return;
		}

		this.activeViewPaneContainerSubscriptions.add(
			viewPaneContainer.onRequestOpenCompositeForView((containerId: string) => {
				// Forward to openPaneComposite, which already handles cross-side
				// exclusivity and focus. The request originates from a *drag-and-drop*
				// gesture (dropping a view onto this side), so skip the panel's
				// auto-maximize-on-show to avoid blowing the panel up to its widest.
				this.openPaneComposite(containerId, true, true);
			})
		);

		// When a view is dragged out of this side to another part (Sidebar /
		// Auxiliary Bar / Editor), this side's view container must re-select
		// the left-most remaining view, otherwise the Panel would land in an
		// empty state and show the "Drag a view here" placeholder while this
		// side still has views to show.
		//
		// We listen to *two* events because the view descriptor service uses
		// different code paths:
		//   1. `onDidRemoveVisibleViewDescriptors` - fires when a view that is
		//      *visible* in this container is dragged out.
		//   2. `onDidChangeActiveViewDescriptors` - fires for any active-view
		//      list change (including when the last visible + active view is
		//      removed). In `mergeViewWithContainerWhenSingleView` mode the
		//      single visible view is also the active one, so this is the
		//      event that matters most when dragging the only visible view out
		//      of a single-view container (e.g. dragging Terminal out of an
		//      OUTPUT container that had both views, or dragging the last view
		//      out of a single-view merged container).
		const reSelectFirstView = (reason: string) => {
			this.ensureFirstViewWorkingAfterRemoval(viewContainerModel, container ?? undefined);
		};
		this.activeViewPaneContainerSubscriptions.add(
			viewContainerModel.onDidRemoveVisibleViewDescriptors(() => reSelectFirstView('onDidRemoveVisibleViewDescriptors'))
		);
		this.activeViewPaneContainerSubscriptions.add(
			viewContainerModel.onDidChangeActiveViewDescriptors(e => {
				// Only react when the removed list is non-empty, i.e. an
				// active view really did go away. Otherwise the event is just
				// a benign re-emit and we must not waste cycles.
				if (e.removed.length > 0) {
					reSelectFirstView('onDidChangeActiveViewDescriptors');
				}
			})
		);
	}

	/**
	 * After a view is dragged out of this side (Sidebar / Auxiliary Bar /
	 * Editor), make sure a view is still selected on this side.
	 *
	 * Strategy:
	 *   - If this side's container still has at least one remaining view
	 *     (e.g. OUTPUT container still has OUTPUT after Terminal was dragged
	 *     out), delegate to `ensureFirstViewWorking()`. That method already
	 *     handles every required sub-step for the
	 *     `mergeViewWithContainerWhenSingleView` case (cancel-collapsed +
	 *     setVisible + openView + RunOnceScheduler to defeat the async
	 *     `updateViewHeaders` race). Re-implementing those steps here was
	 *     fragile and is what caused "label is highlighted but body still
	 *     shows 'Drag a view here'" - because in single-view merged mode the
	 *     body only re-renders when `openView` is called on the *active*
	 *     composite, with the right collapsed-state guard set.
	 *   - If this side's container became empty, switch this side to the first
	 *     available Panel view container so the Panel never shows an empty
	 *     placeholder while it still hosts views.
	 */
	private ensureFirstViewWorkingAfterRemoval(
		currentViewContainerModel?: IViewContainerModel,
		currentContainer?: ViewContainer,
	): void {
		const composite = this.getActivePaneComposite() as PaneComposite | undefined;
		const viewPaneContainer = composite?.getViewPaneContainer();
		const viewContainerModel = currentViewContainerModel
			?? (composite
				? this.viewDescriptorService.getViewContainerModel(
					currentContainer ?? this.viewDescriptorService.getViewContainerById(composite.getId())!
				)
				: undefined);
		if (!composite || !viewContainerModel || !viewPaneContainer) {
			return;
		}
		const firstRemaining = viewContainerModel.allViewDescriptors[0];

		if (firstRemaining) {
			// The container still has views. Two sub-cases matter:
			//
			// A) `mergeViewWithContainerWhenSingleView` is true for this
			//    container (e.g. the OUTPUT container). After a view was dragged
			//    out, the remaining single view's pane may still be marked as
			//    collapsed, which makes `isViewMergedWithContainer()` return
			//    false in the next `updateViewHeaders()` pass and the body of
			//    the container ends up empty ("Drag a view here to display.").
			//    Forcing the pane to `setExpanded(true)` AND making sure the
			//    container model considers it not-collapsed both are required.
			//
			// B) Standard multi-view container. Just calling `openView` is
			//    enough because `openView` calls `setVisible(true)` (creating
			//    the pane if needed) and `setExpanded(true)`.
			//
			// In both cases `composite.openView(id)` is the safe common entry,
			// but for case A we *also* need to explicitly clear the
			// `state.collapsed` flag on the model so the next
			// `updateViewHeaders()` doesn't re-collapse it (the
			// `mergeViewWithContainerWhenSingleView` branch sets
			// `lastMergedCollapsedPane` to undefined once expanded, but only
			// after the body has already had a chance to render with the
			// collapsed pane - so the first frame still shows the empty
			// placeholder if the persisted state had `collapsed: true`).
			if (viewContainerModel.isCollapsed(firstRemaining.id)) {
				viewContainerModel.setCollapsed(firstRemaining.id, false);
			}
			composite.openView(firstRemaining.id, false);

			// Belt-and-suspenders: directly force-expand the pane we just
			// activated, in case the model's collapsed flag was the only thing
			// keeping `isViewMergedWithContainer()` from returning true on the
			// very next layout pass.
			const pane = viewPaneContainer.getView(firstRemaining.id);
			if (pane && !pane.isExpanded()) {
				pane.setExpanded(true);
			}
			return;
		}

		// The container itself became empty. This happens when a view is dragged
		// OUT of this side to *another part* (Auxiliary Bar / Sidebar / Editor)
		// rather than to the other side of the Panel. In that cross-part case the
		// view is gone from the Panel entirely, so there is nothing meaningful to
		// keep selected here — unpin the now-empty container so its stale tab does
		// not linger in the composite bar (the "view still shows in the Panel"
		// bug). We only fall back to switching to another Panel container when the
		// container still has views that were simply not active.
		const currentContainerId = composite.getId();
		if (viewContainerModel.allViewDescriptors.length === 0) {
			// While a drag is in progress the dragged view's content is still in
			// the DOM, so keep it visible instead of dropping to the "Drag a view
			// here" placeholder mid-drag. The final empty/kept state is resolved
			// on drag end (see the `onDragEnd` handler registered in the
			// constructor): if the view was really dropped outside the Panel the
			// container stays empty and we clear then; if the drag was cancelled
			// the view is back and nothing needs to change.
			if (this.isDragInProgress) {
				return;
			}
			if (this.getActivePaneComposite()?.getId() === currentContainerId) {
				this.clearActivePaneComposite();
			}
			this.unpinPaneComposite(currentContainerId);
			this.refreshCompositeBar();
			return;
		}

		const panelContainers = this.viewDescriptorService
			.getViewContainersByLocation(ViewContainerLocation.Panel)
			.filter(c => c.id !== currentContainerId &&
				this.viewDescriptorService.getViewContainerModel(c).activeViewDescriptors.length > 0);
		if (panelContainers.length > 0) {
			this.openPaneComposite(panelContainers[0].id, true, true);
		}
	}

	/**
	 * Push the last known dimension through `layout()` again so the currently
	 * active composite is guaranteed to have been laid out at least once.
	 */
	private ensureActiveCompositeLayout(): void {
		const dimension = this.lastLayoutDimension;
		if (dimension && dimension.width > 0 && dimension.height > 0) {
			super.layout(dimension.width, dimension.height, 0, 0);
		}
	}

	override layout(width: number, height: number, top: number, left: number): void {
		this.lastLayoutDimension = { width, height };

		super.layout(width, height, top, left);
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = this.getContainer();
		if (container) {
			container.style.backgroundColor = this.getColor(PANEL_BACKGROUND) || '';
		}
	}

	/**
	 * `CompositePart.showComposite` only lays the composite body out when
	 * `this.contentAreaSize` is already set. For a grid part that size is set by
	 * the workbench layout grid *before* any composite opens, so it is always
	 * present. This side (`PanelSidePart`) is NOT a grid part: it lives inside the
	 * parent `PanelPart`'s SplitView, and the SplitView may open/add this side
	 * (and thus trigger `showComposite` via a drag-and-drop) *before* a `layout()`
	 * resize has ever reached it. In that window `contentAreaSize` is undefined and
	 * `showComposite` skips `composite.layout(...)`, leaving the body rendered but
	 * zero-sized -> the title/tab shows but the view body ("functionality") is
	 * blank. Re-apply the last known dimension here so the body is always sized,
	 * regardless of which code path opened the composite.
	 */
	protected override showComposite(composite: Composite): void {
		super.showComposite(composite);
		// `CompositePart.showComposite` only lays the body out when
		// `contentAreaSize` is already set. For a *grid* part that size is
		// established by the workbench layout grid before any composite opens,
		// so it is always present. This side is NOT a grid part: it lives inside
		// the parent `PanelPart`'s SplitView, which may open/add this side (e.g.
		// on a drag-and-drop that splits the Panel) *before* a `layout()` resize
		// has reached it. In that window `contentAreaSize` is undefined and
		// `showComposite` skips `composite.layout(...)`, leaving the body rendered
		// but zero-sized -> the title/tab shows but the view body ("functionality")
		// is blank. Re-apply the last known dimension so the body is always sized,
		// regardless of which code path opened the composite.
		const dimension = this.lastLayoutDimension;
		if (dimension && dimension.width > 0 && dimension.height > 0) {
			composite.layout(new Dimension(dimension.width, dimension.height));
		}
	}

	protected override createTitleArea(parent: HTMLElement): HTMLElement {
		// Keep the original Panel title style: title label, composite bar,
		// global actions and title actions are all visible, just like the
		// single-panel layout.
		const titleArea = super.createTitleArea(parent);

		return titleArea;
	}

	protected override shouldAutoRevealPart(): boolean {
		// The parent PanelPart owns visibility; opening a view in a side must not
		// toggle the whole panel.
		return false;
	}

	protected override shouldHidePartOnClose(): boolean {
		return false;
	}

	protected override shouldAutoHidePartWhenEmpty(): boolean {
		return false;
	}

	/**
	 * A sub-part (one side of the dual-panel layout) must NEVER hide the whole
	 * parent Panel when its active composite is closed. The parent PanelPart
	 * owns visibility; hiding it would take the OTHER side down too.
	 *
	 * This is a defensive override: the close-button path already goes through
	 * `clearActivePaneComposite` (which only clears this side), but any other
	 * code that calls `hideActivePaneComposite()` on a side (e.g. via the
	 * pane composite service) must also be prevented from hiding the entire
	 * Panel. We simply clear this side's content instead.
	 */
	override hideActivePaneComposite(): void {
		this.clearActivePaneComposite();
	}

	protected override isPartVisibleForLayout(): boolean {
		// The parent PanelPart controls overall visibility; this side is always
		// laid out while the parent is shown.
		return true;
	}

	protected override getGridPartId(): SINGLE_WINDOW_PARTS {
		// This side is not a grid part; the parent PanelPart is.
		return Parts.PANEL_PART;
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		return {
			partContainerClass: `panel-${this.side}`,
			pinnedViewContainersKey: `workbench.panel.${this.side}.pinnedPanels`,
			placeholderViewContainersKey: `workbench.panel.${this.side}.placeholderPanels`,
			viewContainersWorkspaceStateKey: `workbench.panel.${this.side}.viewContainersWorkspaceState`,
			icon: this.configurationService.getValue('workbench.panel.showLabels') === false,
			orientation: ActionsOrientation.HORIZONTAL,
			recomputeSizes: true,
			showCloseButton: true,
			// IMPORTANT: closing a composite on this sub-part must only clear
			// the sub-part's own content, never hide the whole parent Panel.
			// `hideActivePaneComposite()` (inherited from AbstractPaneCompositePart)
			// calls `setPartHidden(true, getGridPartId())`, and this side's
			// getGridPartId() returns Parts.PANEL_PART - so it would hide the
			// entire dual-panel layout, taking the OTHER side down with it. We
			// must use `clearActivePaneComposite()` instead, which only clears
			// this side's content and lets the parent collapse the now-empty
			// side (see PanelPart.updateSideVisibility).
			closeActiveComposite: () => this.clearActivePaneComposite(),
			hidePartOnLastPinnedClose: false,
			// The side's own close button closes the entire side (so the other
			// side fills the Panel), not just the active view tab.
			hideSide: () => this.panelPart.hideSide(this.side),
			disableOverflow: true,
			// View-level mutual exclusion: a composite tab is disabled on this
			// side when it shares at least one view with the composite currently
			// active on the OTHER side, so the same view can never be shown in
			// both Panel sides at once. The actual release of the other side is
			// performed in `PanelPart.releaseOtherSideIfViewOverlap`.
			isCompositeEnabled: (id: string) => !this.panelPart.containersShareViewOnSide(id, this.side),
			activityHoverOptions: {
				position: () => this.layoutService.getPanelPosition() === Position.BOTTOM && !this.layoutService.isPanelMaximized() ? HoverPosition.ABOVE : HoverPosition.BELOW,
			},
			fillExtraContextMenuActions: actions => this.fillExtraContextMenuActions(actions),
			compositeSize: 0,
			iconSize: 16,
			compact: true,
			overflowActionSize: 44,
			// The two sides of the dual-panel layout share the Panel view container
			// location. Do not automatically claim composites that move to the Panel
			// location; only pin them when they are explicitly opened on this side.
			autoRegisterOnLocationChange: false,
			pinNewCompositesOnRegister: false,
			colors: theme => ({
				activeBackgroundColor: theme.getColor(PANEL_BACKGROUND),
				inactiveBackgroundColor: theme.getColor(PANEL_BACKGROUND),
				activeBorderBottomColor: theme.getColor(PANEL_ACTIVE_TITLE_BORDER),
				activeForegroundColor: theme.getColor(PANEL_ACTIVE_TITLE_FOREGROUND),
				inactiveForegroundColor: theme.getColor(PANEL_INACTIVE_TITLE_FOREGROUND),
				badgeBackground: theme.getColor(badgeBackground),
				badgeForeground: theme.getColor(badgeForeground),
				dragAndDropBorder: theme.getColor(PANEL_DRAG_AND_DROP_BORDER)
			}),
			dndHandlerFactory: {
				create: (defaultHandler) => this.createCrossSideDndHandler(defaultHandler)
			}
		};
	}

	private createCrossSideDndHandler(defaultHandler: ICompositeDragAndDrop): ICompositeDragAndDrop {
		// Dragging a Panel view whose title is merged with its single container
		// (e.g. PROBLEMS, DEBUG CONSOLE, OUTPUT, TERMINAL) reports a `view` drag
		// with the *view* id, not the *composite (container)* id. The cross-side
		// move machinery below (`movePaneCompositeToSide`, pin/unpin/open) all
		// operate on composite ids, so a bare view id would never match and the
		// drop would silently no-op. Resolve a `view` drag to its container id
		// first so the move actually takes effect.
		const resolveToCompositeId = (data: CompositeDragAndDropData): string => {
			const dragData = data.getData();
			if (dragData.type === 'view') {
				return this.viewDescriptorService.getViewContainerByViewId(dragData.id)?.id ?? dragData.id;
			}
			return dragData.id;
		};

		// Reject the drop when it would put a view in BOTH Panel sides at once.
		// The default `CompositeDragAndDrop` accepts any drop and the bar's
		// `isCompositeEnabled` only gates *clicking* a tab - it does NOT stop
		// a drop, so without this check dragging a view/composite from outside
		// (Activity Bar, Sidebar, Auxiliary Bar, Editor) or from another
		// location into this side's tab bar would silently bypass the mutual
		// exclusion gate, leaving the same view visible on both sides.
		const isDropEnabled = (data: CompositeDragAndDropData): boolean => {
			return !this.panelPart.containersShareViewOnSide(resolveToCompositeId(data), this.side);
		};

		return {
			drop: (data: CompositeDragAndDropData, targetCompositeId: string | undefined, originalEvent: DragEvent, before?: Before2D) => {
				const sourceSide = this.panelPart.getDragSourceSide();

				if (sourceSide && sourceSide !== this.side) {
					// Dropping a composite from the other side of the same panel.
					// `movePaneCompositeToSide` already hides/unpins on the source
					// side before opening on the target, so the mutual exclusion
					// invariant holds.
					this.panelPart.movePaneCompositeToSide(resolveToCompositeId(data), this.side);
					return;
				}

				// External drop (Activity Bar / Sidebar / Auxiliary Bar / Editor
				// -> this side's tab bar). The default handler does not know
				// about Panel-side mutual exclusion, so release the other side
				// first if it currently shows a container that shares a view
				// with what we are about to open here.
				if (!isDropEnabled(data)) {
					this.panelPart.releaseOtherSideIfViewOverlap(this.side, resolveToCompositeId(data));
				}
				defaultHandler.drop(data, targetCompositeId, originalEvent, before);
			},
			onDragEnter: (data: CompositeDragAndDropData, targetCompositeId: string | undefined, originalEvent: DragEvent) => {
				const sourceSide = this.panelPart.getDragSourceSide();
				if (sourceSide && sourceSide !== this.side) {
					return true;
				}
				if (!isDropEnabled(data)) {
					// Reject the drag so the cursor shows the "no drop" indicator
					// for duplicates. The release happens in `drop` above so the
					// side visual still looks interactive during dragover, but
					// the actual drop cannot create a duplicate.
					return false;
				}
				return defaultHandler.onDragEnter(data, targetCompositeId, originalEvent);
			},
			onDragOver: (data: CompositeDragAndDropData, targetCompositeId: string | undefined, originalEvent: DragEvent) => {
				const sourceSide = this.panelPart.getDragSourceSide();
				if (sourceSide && sourceSide !== this.side) {
					return true;
				}
				if (!isDropEnabled(data)) {
					return false;
				}
				return defaultHandler.onDragOver(data, targetCompositeId, originalEvent);
			}
		};
	}

	private fillExtraContextMenuActions(actions: IAction[]): void {
		if (this.getCompositeBarPosition() === CompositeBarPosition.TITLE) {
			const viewsSubmenuAction = this.getViewsSubmenuAction();
			if (viewsSubmenuAction) {
				actions.push(new Separator());
				actions.push(viewsSubmenuAction);
			}
		}

		const panelPositionMenu = this.menuService.getMenuActions(MenuId.PanelPositionMenu, this.contextKeyService, { shouldForwardArgs: true });
		const panelAlignMenu = this.menuService.getMenuActions(MenuId.PanelAlignmentMenu, this.contextKeyService, { shouldForwardArgs: true });
		const positionActions = getContextMenuActions(panelPositionMenu).secondary;
		const alignActions = getContextMenuActions(panelAlignMenu).secondary;

		const panelShowLabels = this.configurationService.getValue<boolean | undefined>('workbench.panel.showLabels');
		const toggleShowLabelsAction = toAction({
			id: `workbench.action.panel.${this.side}.toggleShowLabels`,
			label: panelShowLabels ? localize('showIcons', "Show Icons") : localize('showLabels', "Show Labels"),
			run: () => this.configurationService.updateValue('workbench.panel.showLabels', !panelShowLabels)
		});

		actions.push(...[
			new Separator(),
			new SubmenuAction(`workbench.action.panel.${this.side}.position`, localize('panel position', "Panel Position"), positionActions),
			new SubmenuAction(`workbench.action.panel.${this.side}.align`, localize('align panel', "Align Panel"), alignActions),
			toggleShowLabelsAction,
		]);
	}

	/**
	 * Handle a drop that targets this side's empty area. Mirrors the logic in
	 * `AbstractPaneCompositePart.createEmptyPaneMessage` (which only fires on
	 * the bubble phase and is skipped for cross-location drags) but is driven
	 * by the parent `PanelPart`'s capture-phase split listener so that views
	 * dragged from *any* source (Activity Bar, Sidebar, Auxiliary Bar, Editor)
	 * can be dropped onto the right side to split the Panel.
	 *
	 * Returns `true` when the drop was accepted (a valid view/composite was
	 * moved onto this side), `false` otherwise.
	 */
	handleEmptyAreaDrop(e: DragEvent, dragAndDropData: CompositeDragAndDropData): boolean {
		const dragData = dragAndDropData.getData();

		if (this.paneCompositeBar.value && dragData.id) {
			// A bare `view` drag (e.g. dragging the PROBLEMS tab, whose title is
			// merged with its single container) carries the *view* id, not the
			// *container* id. Resolve it to the container id so the cross-side
			// move / exclusion checks below operate on the right identifier.
			const containerId = dragData.type === 'view'
				? this.viewDescriptorService.getViewContainerByViewId(dragData.id)?.id ?? dragData.id
				: dragData.id;

			// In-location Panel drag (the data id is known). If the dragged
			// container is already active in the OTHER side of the dual-panel
			// layout, the bar's own dnd handler rejects it (the bar disables
			// composites that are active on the other side, see
			// `isCompositeEnabled`). That would make dropping a view from the
			// visible side onto the empty/closed side a silent no-op - exactly
			// the "closed a panel, can't trigger the other" bug. Route those
			// drags through the cross-side move instead, which is what the side
			// title-bar drag already does via `createCrossSideDndHandler`.
			if (this.panelPart.releaseOtherSideIfViewOverlap(this.side, containerId)) {
				// The dragged container shares a view with the one currently
				// shown on the other side. We already released the other side
				// above, so fall through to the normal drop so this side opens it.
			}

			// Otherwise let the bar's own dnd handler validate and perform the
			// move (e.g. moving a view from the Sidebar/Activity Bar, or a
			// composite that is not yet active anywhere).
			const validDropTarget = this.paneCompositeBar.value.dndHandler.onDragEnter(dragAndDropData, undefined, e);
			if (!validDropTarget) {
				return false;
			}
			this.paneCompositeBar.value.dndHandler.drop(dragAndDropData, undefined, e);
			return true;
		}

		// Cross-location drag (Activity Bar / Sidebar / Auxiliary Bar / Editor):
		// the shared transfer does not carry the id, so resolve it from the
		// original dataTransfer and move the view/composite onto this side via
		// the view descriptor service - exactly like `createEmptyPaneMessage`
		// does when the composite bar is hidden.
		if (dragData.type === 'composite' && dragData.id) {
			const currentContainer = this.viewDescriptorService.getViewContainerById(dragData.id)!;
			this.viewDescriptorService.moveViewContainerToLocation(currentContainer, this.location, undefined, 'dnd');
			// This open is the side effect of a drag-and-drop, so skip the panel's
			// auto-maximize-on-show (dropping a view must not blow the panel to widest).
			this.openPaneComposite(currentContainer.id, true, true);
			return true;
		}

		if (dragData.type === 'view') {
			const viewToMove = this.viewDescriptorService.getViewDescriptorById(dragData.id);
			if (viewToMove && viewToMove.canMoveView) {
				this.viewDescriptorService.moveViewToLocation(viewToMove, this.location, 'dnd');
				const newContainer = this.viewDescriptorService.getViewContainerByViewId(viewToMove.id)!;
				// This open is the side effect of a drag-and-drop, so skip the panel's
				// auto-maximize-on-show (dropping a view must not blow the panel to widest).
				this.openPaneComposite(newContainer.id, true, true).then(composite => {
					composite?.openView(viewToMove.id, true);
				});
				return true;
			}
		}

		return false;
	}

	protected override shouldShowCompositeBar(): boolean {
		return true;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		return CompositeBarPosition.TITLE;
	}

	/**
	 * The DOM element hosting this side's entire UI (title + content). The parent
	 * `PanelPart` appends it as a `SplitView` view element.
	 */
	get sideElement(): HTMLElement {
		return this.getContainer()!;
	}

	toJSON(): object {
		return {
			type: `panel-${this.side}`
		};
	}
}
