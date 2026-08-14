/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/panelpart.css';
import { ActivePanelContext, PanelFocusContext, PanelLeftFocusContext, PanelLeftMaximizedContext, PanelRightFocusContext, PanelRightMaximizedContext } from '../../../common/contextkeys.js';
import { IWorkbenchLayoutService, Parts, Position } from '../../../services/layout/browser/layoutService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { PANEL_BACKGROUND, PANEL_BORDER, PANEL_TITLE_BORDER } from '../../../common/theme.js';
import { contrastBorder } from '../../../../platform/theme/common/colorRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Dimension, $, isAncestor, addDisposableListener, EventType, EventHelper } from '../../../../base/browser/dom.js';
import { assertIsDefined } from '../../../../base/common/types.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../paneCompositePart.js';
import { IPaneCompositeBarOptions } from '../paneCompositeBar.js';
import { IPaneComposite } from '../../../common/panecomposite.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { SplitView, Orientation, IView, LayoutPriority, Sizing } from '../../../../base/browser/ui/splitview/splitview.js';
import { PanelSidePart, PanelSide } from './panelSidePart.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { CompositeDragAndDropObserver, CompositeDragAndDropData } from '../../dnd.js';
import { DraggedCompositeIdentifier, DraggedViewIdentifier } from '../../dnd.js';
import { LocalSelectionTransfer } from '../../../../platform/dnd/browser/dnd.js';

export class PanelPart extends AbstractPaneCompositePart {

	//#region IView

	readonly minimumWidth: number = 300;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	/**
	 * Effective minimum height of the Panel used by the layout engine.
	 *
	 * We deliberately keep this value *mutable* instead of a constant `77`,
	 * because the workbench splitview's `relayout` pass silently clamps the
	 * Panel back to its minimum when the sibling views (e.g. status bar) are
	 * already sitting at their own minimums. During the "ensure panel size"
	 * flow (`layout.ts#ensurePanelSize`) we temporarily raise this to the
	 * desired `preferredHeight` so the resize is honoured, then lower it back
	 * to `77` so the user can still drag the Panel sash down to a small size.
	 *
	 * Additionally, when the Panel is empty (no active composites on either
	 * side) we keep it visible and raise the minimum to the preferred height
	 * so the empty pane drop target does not collapse to an unusable size.
	 */
	minimumHeight: number = 77;
	readonly maximumHeight: number = Number.POSITIVE_INFINITY;

	get preferredHeight(): number | undefined {
		// Use ~40% of the available height with a 350 floor so that opening
		// any Panel view via the View menu reveals a usable Panel without being too tall.
		return Math.max(Math.round(this.layoutService.mainContainerDimension.height * 0.4), 350);
	}

	get preferredWidth(): number | undefined {
		const left = this.leftPart.getActivePaneComposite()?.getOptimalWidth();
		const right = this.rightPart.getActivePaneComposite()?.getOptimalWidth();
		return Math.max(left ?? 0, right ?? 0, 300);
	}

	//#endregion

	static readonly activePanelSettingsKey = 'workbench.panel.activepanelid';
	private static readonly splitRatioSettingsKey = 'workbench.panel.splitRatio';
	/**
	 * Persists the dual-panel layout (whether the right side is in the split
	 * and which sides the user explicitly closed) so that toggling the whole
	 * Panel off and on - possibly many times across sessions - always restores
	 * the exact same number of visible panels. A single in-memory snapshot is
	 * not enough: it is consumed on show and would drift after repeated Toggle
	 * Panel clicks. Storage keeps the *last actually-shown* layout authoritative.
	 */
	private static readonly layoutSettingsKey = 'workbench.panel.dualLayout';

	private splitView!: SplitView;
	private splitContainer!: HTMLElement;
	private leftPart!: PanelSidePart;
	private rightPart!: PanelSidePart;
	private sideHeight = 0;
	private sideWidth = 0;

	private readonly activeContainerBySide = new Map<PanelSide, string>();
	/**
	 * Per-side subscriptions to the currently active container's view model
	 * events. We re-subscribe whenever the side opens a different container so
	 * we can react to views being added/removed *after* the container is already
	 * open (e.g. dropping a view into an existing container).
	 */
	private readonly sideContainerViewSubscriptions = new Map<PanelSide, DisposableStore>();
	/**
	 * Schedulers used to defer the "side became empty, open the leftmost fallback"
	 * decision until the next event-loop frame. If a normal composite open happens
	 * in the meantime (close old -> open new), the scheduler is cancelled and the
	 * fallback is skipped. This prevents the fallback from firing in the middle
	 * of a container switch, which caused two composites to fight for the same
	 * side and produced the "two titles selected" / empty-body state.
	 */
	private readonly sideFallbackSchedulers = new Map<PanelSide, RunOnceScheduler>();
	/**
	 * The id of the most recently closed composite per side, captured so the
	 * deferred fallback scheduler knows which container to exclude when picking
	 * the next fallback candidate.
	 */
	private readonly lastClosedContainerBySide = new Map<PanelSide, string>();
	/**
	 * Sides the user has explicitly closed (via the side's own close button).
	 * A hidden side is collapsed to zero width so the other side fills the
	 * entire Panel. The side is re-shown automatically when the user opens a
	 * view on it again (e.g. from the View menu or Activity Bar).
	 */
	private hiddenSides = new Set<PanelSide>();
	private dragSourceSide: PanelSide | undefined;

	/**
	 * Tracks per-side maximization so each side's "Maximize Panel Size" button
	 * can reflect its own toggled state independently.
	 */
	private readonly panelLeftMaximizedContext: IContextKey<boolean>;
	private readonly panelRightMaximizedContext: IContextKey<boolean>;
	/**
	 * Whether the whole Panel was already maximized (Editor hidden) *before* a
	 * per-side "maximize" gesture started. When a side's button is toggled off
	 * we only release the Panel's vertical maximization if it was not
	 * maximized to begin with, so we never undo a maximization the user made
	 * through some other path.
	 */
	/**
	 * Set while `movePaneCompositeToSide` is running. Prevents the generic
	 * `onDidPaneCompositeClose` fallback from re-opening a view on the source
	 * side while the cross-side move is already responsible for selecting the
	 * next view itself.
	 */
	private isInCrossSideMove = false;
	/**
	 * Set while the workbench is hiding the whole Panel. `captureLayoutBeforeHide`
	 * persists the pre-hide layout and flips this on; the side-collapse mutation
	 * that `setPanelHidden` triggers synchronously afterwards (`hideActivePaneComposite`
	 * -> `hideSide`/`removeRightFromSplit`) must NOT overwrite that snapshot. We
	 * clear the flag when the hide visibility event fires (after the mutation).
	 */
	private suppressLayoutSave = false;
	/**
	 * Persist the current dual-panel layout to storage. Called whenever the
	 * split membership or `hiddenSides` changes (and right before the whole
	 * Panel is hidden) so the *last actually-shown* state is always saved and
	 * can be restored verbatim on the next show.
	 */
	private saveDualPanelLayout(): void {
		// While the whole Panel is being hidden we must keep the pre-hide
		// snapshot intact: the side-collapse mutation triggered by
		// `hideActivePaneComposite` would otherwise overwrite it with the
		// post-mutation (wrong) state.
		if (this.suppressLayoutSave) {
			return;
		}
		const layout = {
			rightInSplit: this.rightViewInSplit,
			hiddenSides: [...this.hiddenSides]
		};
		this.storageService.store(PanelPart.layoutSettingsKey, JSON.stringify(layout), StorageScope.WORKSPACE, StorageTarget.USER);
	}

	/**
	 * Read the persisted dual-panel layout. Returns `undefined` when nothing
	 * has been persisted yet (first show / fresh session with no prior split).
	 */
	private loadDualPanelLayout(): { rightInSplit: boolean; hiddenSides: Set<PanelSide> } | undefined {
		const raw = this.storageService.get(PanelPart.layoutSettingsKey, StorageScope.WORKSPACE, '');
		if (!raw) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(raw) as { rightInSplit?: boolean; hiddenSides?: string[] };
			return {
				rightInSplit: !!parsed.rightInSplit,
				hiddenSides: new Set((parsed.hiddenSides ?? []).filter(s => s === 'left' || s === 'right') as PanelSide[])
			};
		} catch {
			return undefined;
		}
	}

	/**
	 * Snapshot the current dual-panel layout so it can be restored verbatim
	 * when the whole Panel is shown again via the "Toggle Panel" button.
	 *
	 * This MUST be called *before* the workbench hides the active panel
	 * composite: `layout.ts#setPanelHidden` calls
	 * `paneCompositeService.hideActivePaneComposite` which collapses a side and
	 * (for the right side) removes it from the SplitView. If we captured the
	 * snapshot *after* that mutation we would record `rightInSplit: false` even
	 * though two panels were visible, and restoring would wrongly collapse the
	 * Panel to a single area. The `WorkbenchLayoutService` invokes this hook at
	 * the very start of the hide flow, before any side is mutated. The snapshot
	 * is persisted to storage immediately so repeated toggles never lose it.
	 */
	captureLayoutBeforeHide(): void {
		// Persist the current (pre-hide) layout NOW, and suppress the saves
		// that the subsequent hide mutation would otherwise trigger, so the
		// snapshot stays faithful until the hide visibility event clears the flag.
		this.suppressLayoutSave = true;
		this.saveDualPanelLayout();
	}

	/**
	 * The side the user most recently interacted with (focused). Used by
	 * `getSideToHide()` to decide which side to collapse when a "Hide Panel"
	 * gesture carries no focus information - e.g. clicking the close button on
	 * a side's title bar blurs the side's content (the button is not a focusable
	 * descendant of the side container) so neither `panelLeftFocus` nor
	 * `panelRightFocus` is set. Without this memory we always fell back to the
	 * right side, so clicking "Hide Panel" on the *left* side closed the right
	 * side instead of the left one.
	 *
	 * Defaults to `'left'` because the Panel opens as a single left area.
	 */
	private lastFocusedSide: PanelSide = 'left';

	setLastFocusedSide(side: PanelSide): void {
		this.lastFocusedSide = side;
	}
	/**
	 * Whether the right side's view is currently part of the SplitView. The
	 * Panel opens with only the left side in the split (`false`); the right
	 * view is added lazily when the user splits (drag) or restores a persisted
	 * right container. Keeping it out of the split is what makes the Panel a
	 * single area by default.
	 */
	private rightInSplit = false;

	private panelViewDescriptorService!: IViewDescriptorService;

	constructor(
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
		@IMenuService menuService: IMenuService
	) {
		super(
			Parts.PANEL_PART,
			{ hasTitle: false },
			PanelPart.activePanelSettingsKey,
			ActivePanelContext.bindTo(contextKeyService),
			PanelFocusContext.bindTo(contextKeyService),
			'panel',
			'panel',
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

		this.panelViewDescriptorService = viewDescriptorService;
		this.panelLeftMaximizedContext = PanelLeftMaximizedContext.bindTo(contextKeyService);
		this.panelRightMaximizedContext = PanelRightMaximizedContext.bindTo(contextKeyService);
	}

	// ----- Dual-panel side creation & wiring ---------------------------------

	private createSide(side: PanelSide): PanelSidePart {
		const sidePart = this._register(this.instantiationService.createInstance(PanelSidePart, side, this));
		const sideElement = $('.panel-side');
		sideElement.classList.add(`panel-side-${side}`);
		sidePart.create(sideElement);

		// Defer the "side became empty" fallback so it does not fire while the
		// side is in the middle of a normal open/close cycle (the close event of
		// the old composite fires before the new one is set active). If an open
		// happens in the same tick it cancels this scheduler and the fallback is
		// skipped.
		const fallbackScheduler = this._register(new RunOnceScheduler(() => {
			const closedContainerId = this.lastClosedContainerBySide.get(side);
			this.lastClosedContainerBySide.delete(side);

			// 当一个容器因为互斥清空/拖拽等原因离开本侧后，如果本侧现在没有任何
			// active composite（即陷入空白的 "Drag a view here" 占位），自动从 Panel
			// 位置里挑"最左边的第一个"可用容器重新打开在本侧，使该 Panel 分区始终
			// 有视图工作。
			//
			// 排除两种情况：
			// 1. 用户主动点击本侧关闭按钮（`hideSide`）——已先把该侧加入 `hiddenSides`；
			// 2. 正在进行跨 side 整容器拖拽（`movePaneCompositeToSide`）——它自己会负责
			//    给源侧挑选下一个视图，这里不能再抢。
			if (this.isSideHidden(side) || this.isInCrossSideMove) {
				return;
			}

			if (sidePart.getActivePaneComposite()) {
				return;
			}

		const fallback = this.panelViewDescriptorService
			.getViewContainersByLocation(ViewContainerLocation.Panel)
			.filter(c => c.id !== closedContainerId &&
				this.panelViewDescriptorService.getViewContainerModel(c).activeViewDescriptors.length > 0 &&
				// 关键：兜底容器不得与另一侧当前激活容器共享任何 view，否则打开它
				// 会触发 `releaseOtherSideIfViewOverlap` 反过来清空另一侧（刚拖入的
				// 那一侧），造成两个 Panel 来回清空/重开的循环抖动。互斥由 `openPaneComposite`
				// 内部的门保证，这里提前排除冲突容器，使兜底永远安全。
				!this.containersShareViewOnSide(c.id, side))
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
			if (fallback) {
				// 不跳过互斥检查：兜底容器可能与另一侧当前容器共享 view，必须走
				// `releaseOtherSideIfViewOverlap` 在打开前同步清空另一侧，否则会出现
				// 同一 view 在左右两侧同时显示，导致标题栏出现两个高亮/内容区空白等异常。
				// `skipMaximizeOnShow=true` 因这是 side 内部自动补偿，不应触发 Panel
				// 的 auto-maximize；`skipExclusion=false` 则强制走互斥门。
				sidePart.openPaneComposite(fallback.id, false, true, false);
			}
		}, 0));
		this.sideFallbackSchedulers.set(side, fallbackScheduler);

		// Track which container is active on each side so we can prevent the
		// same view from being shown in both sides at once.
		this._register(sidePart.onDidPaneCompositeOpen(e => {
			// A composite has just become active on this side, so any scheduled
			// "this side is empty" fallback is no longer needed.
			fallbackScheduler.cancel();
			this.lastClosedContainerBySide.delete(side);

			const openedId = e.getId();
			this.activeContainerBySide.set(side, openedId);
			this.subscribeToSideContainerViews(side, sidePart, openedId);

		// 视图级互斥：同一 view 不能在左右两侧同时显示。所有"正常"打开路径
		// （用户点击、拖拽、close 后的 fallback）都通过 `openPaneComposite` 中的
		// `releaseOtherSideIfViewOverlap` 在打开前同步清空另一侧；restore 后由
		// `enforceViewUniquenessAfterRestore` 兜底。但某些拖拽/视图合并路径可能
		// 绕过互斥门（例如拖拽一个 view 落到本侧已存在的容器、或跨位置移动的
		// 副作用打开），导致本侧打开的容器与另一侧共享 view。这里作为最后一道
		// 安全网：检测到共享就清空另一侧，保证"视图唯一"不变量在任意路径下成立。
		// 清空另一侧会触发它的 `onDidPaneCompositeClose` → fallback，而 fallback 已
		// 用 `containersShareViewOnSide` 排除冲突容器，不会反过来清空本侧，故不会循环。
		const otherSide: PanelSide = side === 'left' ? 'right' : 'left';
		const otherActiveId = this.getOtherSidePart(side).getActivePaneComposite()?.getId();
		if (openedId && otherActiveId && this.containersShareView(openedId, otherActiveId)) {
			console.error(`[PanelPart] invariant violated: view shown in both Panel sides (opened=${openedId} on ${side}, other=${otherActiveId})`);
			this.clearAndUnpinSide(otherSide);
		} else {
			// 无冲突时仅刷新 bar 的禁用/启用视觉反馈（与 `isCompositeEnabled` 对齐）。
			this.getOtherSidePart(side).updateCompositeEnabledStates();
		}
		this.updatePanelMinimumHeight();

		// 双栏分区后，本 side 的容器刚打开/切换：确保容器内"从左往右第一个视图"
		// 处于工作状态（展开可见）。详见 PanelSidePart.ensureFirstViewWorking。
		sidePart.ensureFirstViewWorking();
		}));
		this._register(sidePart.onDidPaneCompositeClose(e => {
			if (this.activeContainerBySide.get(side) === e.getId()) {
				this.activeContainerBySide.delete(side);
				this.sideContainerViewSubscriptions.get(side)?.clear();
				const otherPart = this.getOtherSidePart(side);
				otherPart.updateCompositeEnabledStates();
				// The container that just closed here is now free to be opened on
				// this side again (it is no longer active in the other side), so
				// re-enable it in this side's bar.
				sidePart.updateCompositeEnabledStates();
				this.updatePanelMinimumHeight();

				// 兜底逻辑延迟到下一帧：同步的 close 事件可能发生在普通容器切换的
				// 过程中（新 composite 尚未 setActive），立即打开会造成两个容器争用
				// 同一 side，出现"两个 title 同时高亮"、"内容区仍显示 Drag a view here"
				// 等异常。如果同一帧内随后触发了 open，上面的 scheduler 会被 cancel。
				this.lastClosedContainerBySide.set(side, e.getId());
				fallbackScheduler.schedule();
			}
		}));

		return sidePart;
	}

	private getSideView(sidePart: PanelSidePart, side: PanelSide): IView {
		const that = this;
		return {
			element: sidePart.sideElement,
		get minimumSize(): number {
			// When this side has been explicitly closed (close button), force it
			// to 0 so the other side fills the entire panel width.
			if (that.isSideHidden(side)) {
				return 0;
			}
			// A side without an active composite still keeps a minimum visible
			// width. Otherwise, once the only view on a side is dragged away
			// (e.g. from the left side onto the right side), the now-empty side
			// collapses to zero width and *disappears* entirely - the user can
			// no longer drop another view into it, breaking the dual-panel
			// workflow. Keeping it at 150px leaves a usable drop target, exactly
			// like the empty right side during the split-preview.
			return 150;
		},
			get maximumSize(): number {
				// A closed side cannot grow at all.
				return that.isSideHidden(side) ? 0 : Number.POSITIVE_INFINITY;
			},
			priority: LayoutPriority.Normal,
			proportionalLayout: true,
			onDidChange: Event.None,
			layout: (size: number) => {
				// Horizontal split: `size` is the width of this side.
				sidePart.layout(size, that.sideHeight, 0, 0);
			}
		};
	}

	/**
	 * Dynamically insert the right side's view into the SplitView. No-op if it
	 * is already in the split. Used to turn the single-area Panel into a split
	 * on demand (drag-to-split, or restoring a persisted right container).
	 */
	/**
	 * The right side is normally view index 1 in the SplitView. We treat this
	 * as the source of truth for whether the right side is "in the split",
	 * rather than trusting the `rightInSplit` boolean alone: toggling the whole
	 * Panel visibility repeatedly (the title-bar "Toggle Panel" button) can
	 * otherwise leave `rightInSplit` out of sync with the actual view count,
	 * which made dragging a view onto the empty half a silent no-op.
	 */
	private get rightViewInSplit(): boolean {
		return !!this.splitView && this.splitView.length > 1;
	}

	/**
	 * Whether the Panel is currently in the dual (left/right) layout, i.e. the
	 * right side is part of the split. Used to decide whether per-side
	 * maximization (`toggleSideMaximized`) applies or we fall back to whole-panel
	 * maximization.
	 */
	isDualLayout(): boolean {
		return this.rightViewInSplit;
	}

	private addRightToSplit(): void {
		if (!this.splitView) {
			return;
		}
		// Reconcile the boolean with reality first: if a prior Toggle Panel left
		// the boolean stale, correct it so the rest of the state machine agrees.
		if (this.rightViewInSplit) {
			this.rightInSplit = true;
			return;
		}
		this.rightInSplit = true;
		const initialSize = Math.max(150, Math.round((this.sideWidth || 800) / 2));
		this.splitView.addView(this.getSideView(this.rightPart, 'right'), initialSize, 1);
		this.updateSideVisibility();
		// Persist so a later Toggle Panel off/on restores this exact layout.
		this.saveDualPanelLayout();
	}

	/**
	 * Remove the right side's view from the SplitView so the Panel returns to a
	 * single area (the left side fills it). No-op if it is not in the split.
	 */
	private removeRightFromSplit(): void {
		if (!this.splitView) {
			return;
		}
		if (!this.rightViewInSplit) {
			this.rightInSplit = false;
			return;
		}
		this.rightInSplit = false;
		this.splitView.removeView(1, Sizing.Distribute);
		this.updateSideVisibility();
		// Persist so a later Toggle Panel off/on restores this exact layout.
		this.saveDualPanelLayout();
	}

	override create(parent: HTMLElement): void {
		// Build the parent Panel container (title + content) the usual way.
		super.create(parent);

		const contentArea = assertIsDefined(this.getContentArea());

		// The base class created an empty-pane drag hint in the content area;
		// remove it because the content area only hosts the split of two sides.
		contentArea.querySelector('.empty-pane-message-area')?.remove();

		// The parent Panel owns no title of its own (each side renders its own
		// title bar). Hide the empty title the base `AbstractPaneCompositePart`
		// created so we don't end up with a double / broken title row.
		const parentTitle = this.getTitleArea();
		if (parentTitle) {
			parentTitle.style.display = 'none';
		}

		// Horizontal split container holding the two sides.
		this.splitContainer = $('.panel-split');
		contentArea.appendChild(this.splitContainer);

		this.leftPart = this.createSide('left');
		this.rightPart = this.createSide('right');

		// The Panel opens as a SINGLE area by default: the SplitView contains
		// only the left side. The right side's view is added dynamically the
		// first time the user needs it - either by dragging a view onto the
		// empty right half (editor-like split-on-drag) or by restoring a
		// persisted right-side container. This guarantees we never show two
		// areas unless the user actually opened a second one.
		this.splitView = this._register(new SplitView(this.splitContainer, {
			orientation: Orientation.HORIZONTAL,
			proportionalLayout: true,
			descriptor: {
				size: this.sideWidth || 800,
				views: [
					{ size: this.sideWidth || 800, view: this.getSideView(this.leftPart, 'left') },
				]
			}
		}));

		// Persist split ratio whenever the user drags the sash.
		this._register(this.splitView.onDidSashChange(() => this.saveSplitRatio()));

		// Track drag source side so the two sides can drop composites onto
		// each other even though they share the same ViewContainerLocation.
		this._register(CompositeDragAndDropObserver.INSTANCE.onDragStart(e => {
			const target = e.eventData.target as HTMLElement;
			if (isAncestor(target, this.leftPart.sideElement)) {
				this.dragSourceSide = 'left';
			} else if (isAncestor(target, this.rightPart.sideElement)) {
				this.dragSourceSide = 'right';
			} else {
				this.dragSourceSide = undefined;
			}
		}));
		this._register(CompositeDragAndDropObserver.INSTANCE.onDragEnd(() => {
			this.dragSourceSide = undefined;
		}));

		// The side-specific "close" button collapses a single side to zero width
		// so the other side fills the Panel. When the user uses Toggle Panel to
		// hide and then re-show the whole Panel we restore the exact dual-panel
		// layout that was visible before hiding: if one panel was shown, only one
		// panel is restored; if two panels were shown, both are restored.
		//
		// The snapshot is taken by `captureLayoutBeforeHide()`, which the
		// `WorkbenchLayoutService` calls at the very start of the hide flow
		// *before* it collapses a side (hiding the active composite removes the
		// right side from the SplitView). Capturing there - rather than in this
		// visibility listener - is what keeps the restored panel count correct:
		// a post-mutation snapshot would record `rightInSplit: false` for a
		// two-panel layout and collapse it to a single area on re-show.
		let panelWasVisible = this.layoutService.isVisible(Parts.PANEL_PART);
		this._register(this.layoutService.onDidChangePartVisibility(() => {
			const isVisibleNow = this.layoutService.isVisible(Parts.PANEL_PART);
			if (panelWasVisible && !isVisibleNow) {
				// The hide mutation has completed; stop suppressing layout saves so
				// future user-driven changes persist normally again.
				this.suppressLayoutSave = false;
			} else if (!panelWasVisible && isVisibleNow) {
				// Restore the persisted dual-panel layout so the same number of
				// panels (one or two) re-appears, no matter how many times the
				// Panel was toggled. We read from storage (not a single volatile
				// snapshot) so the state is never lost across repeated toggles.
				const savedLayout = this.loadDualPanelLayout();

				if (savedLayout) {
					this.hiddenSides = new Set(savedLayout.hiddenSides);
					// Reconcile the actual SplitView views with the saved layout
					// instead of trusting the `rightInSplit` boolean. After many
					// Toggle Panel cycles the boolean can disagree with the real
					// view count, which is what made the empty-half drop a no-op.
					if (savedLayout.rightInSplit && !this.rightViewInSplit) {
						this.addRightToSplit();
					} else if (!savedLayout.rightInSplit && this.rightViewInSplit) {
						this.removeRightFromSplit();
					}
				} else {
					// No persisted state (first show or restored session): fall
					// back to the persisted right-side active container.
					this.hiddenSides.clear();
					const rightLastActive = this.storageService.get(PanelSidePart.activePanelSettingsKeyFor('right'), StorageScope.WORKSPACE, '');
					if (rightLastActive && !this.rightViewInSplit) {
						this.addRightToSplit();
					}
				}
			this.updateSideVisibility();
			// Re-persist the restored layout so later hides stay in sync
			// with what is now on screen.
			this.saveDualPanelLayout();
			this.updateSideMaximizedContextKeys();
			}
			panelWasVisible = isVisibleNow;
		}));

		// Restore each side's independently persisted active view container.
		// The Panel opens as a SINGLE area: only the left side is populated by
		// default. The right area is only brought into the split when the user
		// drags a view onto it, or when a right-side container was explicitly
		// persisted from a previous session (so a real two-area layout is
		// restored as two areas, not forced on every fresh open).
		const leftLastActive = this.storageService.get(PanelSidePart.activePanelSettingsKeyFor('left'), StorageScope.WORKSPACE, '');
		const rightLastActive = this.storageService.get(PanelSidePart.activePanelSettingsKeyFor('right'), StorageScope.WORKSPACE, '');

		const leftRestoreId = leftLastActive || this.getRestoreContainerId('left') || undefined;
		this.leftPart.restore(leftRestoreId).then(() => {
			// Only restore a right-side container if one was explicitly persisted.
			// We deliberately do NOT fall back to a default container here: an
			// un-persisted right side must stay empty (out of the split) so the
			// Panel opens as a single area.
			const rightRestoreId = rightLastActive || undefined;
			if (rightRestoreId) {
				// A persisted right container means we should open as two areas:
				// insert the right view into the split before restoring it.
				this.addRightToSplit();
			}
			return this.rightPart.restore(rightRestoreId);
		}).then(() => {
			// `restore()` opens the composites asynchronously, typically before the
			// workbench has laid the Panel out. Re-run our layout once the side(s)
			// have their composite so those composites are actually sized instead
			// of staying at zero (which renders them non-functional).
			this.relayoutSides();
			// 兜底：relayoutSides() 之后 Panel 已真正可见/布局完成。此时再确保两侧
			// 容器内"从左往右第一个视图"处于工作状态（可见 + 展开 + body 已渲染）。
			// 见 PanelSidePart.ensureFirstViewWorking——那里对齐到容器可见时机，但
			// 若 `onDidPaneCompositeOpen` 触发时容器尚未可见，需在这里补一次。
			this.leftPart.ensureFirstViewWorking();
			this.rightPart.ensureFirstViewWorking();

			// 兜底不变式：无论持久化状态如何（例如从"允许两侧重复"的旧版本升级、
			// 或任何绕过互斥的代码路径），还原完成后两侧绝不能显示共享同一 view
			// 的 container。左侧是单栏 Panel 的基线，故当发现重复时释放右侧，保证
			// "视图唯一"这一不变量在任何情况下都成立，杜绝复发。
			this.enforceViewUniquenessAfterRestore();
		});

		// Register the drag target that turns the single-area Panel into a split
		// when the user drags a Panel view onto the empty right half.
		this.registerSplitDropTarget();
	}

	/**
	 * Re-apply the last known dimensions to both sides. Safe to call at any
	 * time; a no-op until the Panel has been laid out once.
	 */
	private relayoutSides(): void {
		if (!this.splitView || this.sideWidth <= 0 || this.sideHeight <= 0) {
			return;
		}

		this.splitView.layout(this.sideWidth);
		this.leftPart.layout(this.splitView.getViewSize(0), this.sideHeight, 0, 0);
		// The right side only exists in the split after a split has happened
		// (drag, or restoring a persisted right container). Guard the index so
		// relayout before that point does not throw.
		if (this.rightInSplit) {
			this.rightPart.layout(this.splitView.getViewSize(1), this.sideHeight, 0, 0);
		}
	}

	getDragSourceSide(): PanelSide | undefined {
		return this.dragSourceSide;
	}

	getOtherSidePart(side: PanelSide): PanelSidePart {
		return side === 'left' ? this.rightPart : this.leftPart;
	}

	/**
	 * The set of view ids currently contributed by a panel container.
	 */
	private getContainerViewIds(containerId: string): Set<string> {
		const container = this.panelViewDescriptorService.getViewContainerById(containerId);
		if (!container) {
			return new Set();
		}
		return new Set(
			this.panelViewDescriptorService
				.getViewContainerModel(container)
				.activeViewDescriptors.map(view => view.id)
		);
	}

	/**
	 * Whether two panel containers share at least one view. Used by the
	 * view-level mutual exclusion: if two sides would show a common view, they
	 * are not allowed to be visible at the same time.
	 */
	private containersShareView(a: string, b: string): boolean {
		if (a === b) {
			return true;
		}
		const viewsA = this.getContainerViewIds(a);
		if (viewsA.size === 0) {
			return false;
		}
		const viewsB = this.getContainerViewIds(b);
		for (const view of viewsB) {
			if (viewsA.has(view)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Whether `containerId` shares at least one view with the container
	 * currently active on `side`. Exposed for the composite bar's
	 * `isCompositeEnabled` so a tab that would duplicate a view already shown
	 * on the other side is greyed out there.
	 */
	containersShareViewOnSide(containerId: string, side: PanelSide): boolean {
		const activeId = this.getOtherSidePart(side).getActivePaneComposite()?.getId();
		if (!activeId) {
			return false;
		}
		return this.containersShareView(activeId, containerId);
	}

	/**
	 * Subscribe to the active container's view model so we can enforce mutual
	 * exclusion even when views are added/removed *after* the container is
	 * already open. This covers the case where a view is dropped into an
	 * existing container on one side while the same view is still visible on
	 * the other side.
	 */
	private subscribeToSideContainerViews(side: PanelSide, sidePart: PanelSidePart, containerId: string): void {
		let store = this.sideContainerViewSubscriptions.get(side);
		if (!store) {
			store = this._register(new DisposableStore());
			this.sideContainerViewSubscriptions.set(side, store);
		} else {
			store.clear();
		}

		const container = this.panelViewDescriptorService.getViewContainerById(containerId);
		if (!container) {
			return;
		}

		const model = this.panelViewDescriptorService.getViewContainerModel(container);
		store.add(model.onDidChangeActiveViewDescriptors(e => {
			// If a view was just added to this side and the other side already
			// shows the same view, the other side must be released - the view
			// cannot be visible in both places at once.
			const otherSide: PanelSide = side === 'left' ? 'right' : 'left';
			const otherPart = this.getOtherSidePart(side);
			const otherContainerId = otherPart.getActivePaneComposite()?.getId();
			if (otherContainerId) {
				for (const added of e.added) {
					if (this.viewIsActiveInContainer(added.id, otherContainerId)) {
						this.clearAndUnpinSide(otherSide);
						break;
					}
				}
			}

			// If this container no longer has any active views, do not leave an
			// empty shell behind. When the container has *no views at all* (i.e.
			// its last view was dragged out to another part such as the Auxiliary
			// Bar), unpin it so the stale tab does not linger in the composite bar
			// (the "view still shows in the Panel" bug). We only unpin on a truly
			// empty container — if the container still has views (just none
			// active, e.g. context keys hiding them) we keep it pinned so the tab
			// can reappear automatically, and merely clear the active composite.
			if (model.activeViewDescriptors.length === 0) {
				if (model.allViewDescriptors.length === 0 && sidePart.getActivePaneComposite()?.getId() === containerId) {
					sidePart.unpinPaneComposite(containerId);
					sidePart.refreshCompositeBar();
				}
				sidePart.clearActivePaneComposite();
			}
		}));
	}

	/**
	 * Whether a view is currently active in a given panel container.
	 */
	private viewIsActiveInContainer(viewId: string, containerId: string): boolean {
		return this.getContainerViewIds(containerId).has(viewId);
	}

	/**
	 * Close (hide) an entire side of the dual-panel layout. The side collapses
	 * to zero width and the other side fills the whole Panel area. The side's
	 * active composite is cleared so re-opening a view on it starts fresh.
	 */
	hideSide(side: PanelSide): void {
		if (this.hiddenSides.has(side)) {
			return;
		}
		this.hiddenSides.add(side);

		const part = side === 'left' ? this.leftPart : this.rightPart;
		part.clearActivePaneComposite();
		this.activeContainerBySide.delete(side);

		// Closing the right side removes it from the split entirely so the Panel
		// returns to a single area (the left side fills it). The left side can
		// never be removed (it is the baseline single-area Panel), so we just
		// collapse it via `updateSideVisibility`.
		if (side === 'right') {
			this.removeRightFromSplit();
		} else {
			this.updateSideVisibility();
		}
		// Persist so a later Toggle Panel off/on restores this exact layout.
		this.saveDualPanelLayout();
		this.updateSideMaximizedContextKeys();
	}

	/**
	 * Clear the active composite on a side and also unpin it so its tab does
	 * not linger in the composite bar after the side has been released. Used by
	 * the view-level mutual exclusion paths.
	 */
	private clearAndUnpinSide(side: PanelSide): void {
		const part = side === 'left' ? this.leftPart : this.rightPart;
		const activeId = part.getActivePaneComposite()?.getId();
		part.clearActivePaneComposite();
		if (activeId) {
			part.unpinPaneComposite(activeId);
		}
	}

	/**
	 * Re-show a previously closed side. Called automatically when a view is
	 * opened on that side (e.g. from the View menu), so the user can always
	 * bring a closed side back.
	 */
	showSide(side: PanelSide): void {
		if (!this.hiddenSides.has(side)) {
			return;
		}
		this.hiddenSides.delete(side);

		// Re-showing the right side re-inserts it into the split (as an empty
		// drop area that the user can then drop a view onto, or that the
		// subsequent open will populate).
		if (side === 'right') {
			this.addRightToSplit();
		} else {
			this.updateSideVisibility();
		}
		// Persist so a later Toggle Panel off/on restores this exact layout.
		this.saveDualPanelLayout();
		this.updateSideMaximizedContextKeys();
	}

	isSideHidden(side: PanelSide): boolean {
		return this.hiddenSides.has(side);
	}

	/**
	 * Whether the given side is currently "maximized" in the *vertical* sense:
	 * the whole Panel is maximized so the Panel occupies the full vertical height
	 * and squeezes the Editor area. In the dual layout both sides share that one
	 * Panel height, so maximizing the clicked side grows the Panel (occupying the
	 * Editor display) and both sides grow with it - the other side is left
	 * visible and untouched. This matches the requested behaviour: "the current
	 * Panel grows vertically and takes over the editor display".
	 */
	isSideMaximized(side: PanelSide): boolean {
		return this.layoutService.isPanelMaximized();
	}

	/**
	 * Toggle maximization of a single side of the dual-panel layout.
	 *
	 * In the dual layout the two sides share one Panel height, so "maximizing"
	 * the side the user clicked simply vertically maximizes the whole Panel - the
	 * Panel grows to fill the vertical space (occupying the Editor display) and
	 * both sides grow with it. Crucially we do NOT hide / collapse the other side,
	 * so the other Panel is never removed. Clicking the button again restores the
	 * Panel to its previous height. When the Panel is not in dual mode this falls
	 * back to the same classic whole-panel maximization.
	 */
	toggleSideMaximized(side: PanelSide): void {
		// Make sure the side the user clicked is actually visible before we
		// maximize it (e.g. it could have been closed on its own).
		this.showSide(side);

		// Vertically maximize (or restore) the whole Panel. This occupies the
		// Editor display and grows the clicked side; the other side stays put.
		this.layoutService.toggleMaximizedPanel();
		this.updateSideMaximizedContextKeys();
	}

	/**
	 * Reflect each side's maximized state into its context key so the
	 * corresponding title-bar "Maximize Panel Size" button shows the correct
	 * toggled (restore) appearance.
	 */
	private updateSideMaximizedContextKeys(): void {
		this.panelLeftMaximizedContext.set(this.isSideMaximized('left'));
		this.panelRightMaximizedContext.set(this.isSideMaximized('right'));
	}

	/**
	 * The dual-panel layout must NOT auto-hide the whole Panel when it becomes
	 * empty. `ViewsService.updatePanelVisibility` calls this to decide whether
	 * to `setPartHidden(true)` on the entire Panel - we return `false` because
	 * an empty side is collapsed to a visible drop target by `updateSideVisibility`
	 * and the other side stays usable. Returning `true` here would make closing
	 * a single view in one side disappear the entire (still-wanted) Panel.
	 */
	override shouldAutoHidePanelWhenEmpty(): boolean {
		return false;
	}

	/**
	 * Collapse the side that currently hosts the given view container. Used by
	 * the View-menu "Close" action so closing a Panel container in the
	 * dual-panel layout only takes down that side (the other side fills the
	 * Panel) instead of hiding the whole Panel (which would also remove the
	 * other, still-wanted side).
	 */
	hidePaneComposite(id: string): void {
		if (this.leftPart.getActivePaneComposite()?.getId() === id) {
			this.hideSide('left');
		} else if (this.rightPart.getActivePaneComposite()?.getId() === id) {
			this.hideSide('right');
		}
	}

	/**
	 * Close the side of the dual-panel layout that should respond to a global
	 * "hide" gesture. The decision mirrors `getFocusedSide()` so it agrees with
	 * what the rest of the workbench considers "the active side":
	 *   1. The side that currently has keyboard focus (user explicitly clicked
	 *      inside that side).
	 *   2. The side that still has an active composite (the user is looking at
	 *      its tab/title and clicking "Hide Panel" next to it). Without this
	 *      fallback the action degenerated to hiding the entire Panel whenever
	 *      neither side had focus - e.g. when the user clicked the close
	 *      button on a side's title bar, which does not transfer keyboard
	 *      focus into that side's content area, or when the action is run from
	 *      the Command Palette.
	 *   3. Fall back to the left side if nothing else qualifies (preserves the
	 *      single-area default for an empty Panel).
	 *
	 * Returns `true` when a side was closed.
	 */
	closeActiveSide(): boolean {
		const side = this.getSideToHide();
		if (side) {
			// Close ONLY the side whose close button the user pressed. The other
			// side (or an empty drop target) stays on screen. We must NOT hide the
			// whole Panel here: doing so would make a single close button take
			// both sides down at once (especially when the other side was already
			// collapsed and persisted in `hiddenSides`, so pressing the only
			// visible side's button would wipe out the entire Panel area). Hiding
			// the whole Panel is a separate, explicit gesture (the single-area
			// "Hide Panel" path below, or Ctrl+J / togglePanel).
			this.hideSide(side);
		}

		return true;
	}

	/**
	 * Decide which side of the dual-panel layout `closeActiveSide()` should
	 * collapse. Returns `'left'`, `'right'`, or `undefined` if no side is
	 * hidden as a result (currently always returns a side; `undefined` is
	 * reserved for a future case where neither side can be closed).
	 *
	 * The side the user most recently interacted with (`lastFocusedSide`, set
	 * on focus and on every MOUSE_DOWN inside a side) takes priority: it is the
	 * most reliable signal of *which* close button the user pressed. A title
	 * bar close (X) button is not a focusable descendant of the side's content,
	 * so clicking it does NOT move keyboard focus - yet the MOUSE_DOWN on that
	 * side's container records `lastFocusedSide` *before* the Hide action runs.
	 * Trusting the (stale) focus key here would close the side that still has
	 * focus instead of the side whose button was pressed (e.g. clicking "Hide
	 * Panel" on the LEFT would close the RIGHT). The explicit click intent wins.
	 */
	private getSideToHide(): PanelSide | undefined {
		const leftFocus = PanelLeftFocusContext.getValue(this.contextKeyService);
		const rightFocus = PanelRightFocusContext.getValue(this.contextKeyService);

		// Prefer the side that genuinely holds DOM focus. Clicking a side's
		// "Hide Panel" button keeps that side's container subtree focused right
		// up until the action runs, so this is the most direct signal of *which*
		// close button the user pressed.
		if (leftFocus && !rightFocus) {
			return 'left';
		}
		if (rightFocus && !leftFocus) {
			return 'right';
		}

		// Otherwise fall back to the side the user most recently interacted with
		// (recorded on every MOUSE_DOWN inside a side, including a click on its
		// title-bar close button). The explicit click intent wins, so the side
		// whose button was pressed is the side we collapse - regardless of
		// whether that side currently hosts a view. Previously we fell through to
		// the *other* side whenever the clicked side was empty, which made
		// "Hide Panel" on the left close the right (and vice versa).
		const remembered = this.lastFocusedSide;

		// If the remembered side is already hidden (e.g. the user clicks the
		// same side's button twice, or runs the command from the palette), defer
		// to the other side so the gesture still does something useful.
		if (this.hiddenSides.has(remembered)) {
			const other: PanelSide = remembered === 'left' ? 'right' : 'left';
			return other;
		}

		return remembered;
	}

	/**
	 * View-level mutual exclusion gate used by `PanelSidePart.openPaneComposite`
	 * and the cross-side drop handlers.
	 *
	 * The two Panel sides MUST NOT show the same view at the same time. If
	 * opening `containerId` on `side` would share at least one view with the
	 * container currently active on the other side, release (clear + unpin) the
	 * other side first so the open on `side` can proceed without ever showing a
	 * duplicate view. Returns `true` when the other side was released (the caller
	 * should then continue the normal open on `side`).
	 *
	 * The previous "always return false" implementation let views exist in both
	 * sides simultaneously, which is exactly the "view stays in the original
	 * panel after you drag it to the other side" bug. We restore mutual
	 * exclusion here. The refresh race that the `false` workaround was guarding
	 * against (both sides restoring a shared container and clearing each other)
	 * is avoided because `restore()` opens each side with `skipExclusion`, and a
	 * final `enforceViewUniquenessAfterRestore()` pass guarantees the invariant
	 * even if the persisted layout was ever produced in a duplicated state.
	 */
	releaseOtherSideIfViewOverlap(side: PanelSide, containerId: string): boolean {
		const otherSide: PanelSide = side === 'left' ? 'right' : 'left';
		const otherPart = this.getOtherSidePart(side);
		const otherActiveId = otherPart.getActivePaneComposite()?.getId();
		if (!otherActiveId) {
			return false;
		}
		if (this.containersShareView(otherActiveId, containerId)) {
			this.clearAndUnpinSide(otherSide);
			return true;
		}
		return false;
	}

	/**
	 * Defensive invariant net run once after both sides have been restored.
	 *
	 * Guarantees that the two Panel sides never show a container that shares a
	 * view, *regardless* of how the persisted layout was produced — e.g. after
	 * upgrading from a build that allowed duplicates, or any future code path
	 * that opens a side while skipping the mutual-exclusion gate. The left side
	 * is the baseline single-area Panel, so when an overlap is detected the
	 * right side is the one released. This makes "views are unique across the
	 * two panels" hold under every circumstance and prevents the bug from
	 * recurring if a duplicate is ever persisted.
	 */
	private enforceViewUniquenessAfterRestore(): void {
		const leftId = this.leftPart.getActivePaneComposite()?.getId();
		const rightId = this.rightPart.getActivePaneComposite()?.getId();
		if (leftId && rightId && this.containersShareView(leftId, rightId)) {
			// Release the right side (the later, non-baseline area) so the left
			// keeps its view. If the right side was empty, `rightId` is falsy and
			// nothing happens.
			this.clearAndUnpinSide('right');
		}
	}

	/**
	 * Move a pane composite from one side to the other. This is used by the
	 * cross-side drag and drop handler and by the mutual-exclusion path in
	 * `PanelSidePart.openPaneComposite`.
	 */
	async movePaneCompositeToSide(id: string, toSide: PanelSide): Promise<IPaneComposite | undefined> {
		this.isInCrossSideMove = true;
		const fromPart = toSide === 'left' ? this.rightPart : this.leftPart;
		const targetPart = toSide === 'left' ? this.leftPart : this.rightPart;
		try {
		// If the view is currently active in the source side, clear it there
		// first so the mutual-exclusion check allows it to open on the target.
		// MUST use `clearActivePaneComposite` (not `hideActivePaneComposite`):
		// the latter calls `setPartHidden(true, PANEL_PART)` and would hide the
		// ENTIRE dual-panel layout - including the target side we are about to
		// open on - and the subsequent re-show leaves the dragged container's
		// content/tab stale on the source side ("leftover after drag"). Clearing
		// only the source side keeps the Panel visible and removes the leftover.
		if (fromPart.getActivePaneComposite()?.getId() === id) {
			fromPart.clearActivePaneComposite();
		}

			// Move the tab from the source side to the target side so the view does
			// not remain visible in the side it was dragged from.
			fromPart.unpinPaneComposite(id);
			await targetPart.pinPaneComposite(id);

			const result = await targetPart.openPaneComposite(id, true);

			// Force the source side's composite bar to re-sync with the model. The
			// `unpin` above may have run before the bar was laid out, in which case
			// its `updateCompositeSwitcher` bails out early and the tab stays in the
			// DOM. Re-laying out now guarantees the stale tab is removed regardless
			// of timing.
			fromPart.refreshCompositeBar();

			// 当用户把源侧当前激活的容器拖到另一侧后，源侧会因为没有激活视图而
			// 标题/内容一片空白。下面把源侧的"下一个视图"设为激活状态（不抢焦点
			// ——焦点仍留在用户刚拖入的目标侧），避免出现"视图被拖走后原面板没有
			// 任何激活视图"的空状态。
			//
			// 拖入目标侧与从目标侧拖出两侧对称处理：无论 `fromPart` 是左还是右，
			// 下面的激活补偿对两侧都会执行，因此从左侧拖到右侧、以及从右侧拖到
			// 左侧都能得到一致的行为。
			const sourceActiveId = fromPart.getActivePaneComposite()?.getId();
			if (sourceActiveId === id || !sourceActiveId) {
			// 兜底：极端情况下源侧当前激活的仍是被拖走的容器（例如 `hide`
			// 因互斥在更早的路径之外执行），先清空它，确保下面的激活补偿
			// 不会在一个已被拖走的容器上操作。同样只能用 `clearActivePaneComposite`
			// 而非 `hideActivePaneComposite`，原因同上（后者会隐藏整个 Panel）。
			if (sourceActiveId === id) {
				fromPart.clearActivePaneComposite();
			}

				const targetActiveId = targetPart.getActivePaneComposite()?.getId();

				// 判断一个容器是否能作为源侧的 fallback：必须有 active view、不能
				// 是被拖走的容器，且不能与目标侧当前容器共享 view（避免把目标侧
				// 刚拖过来的视图又挤掉）。Test Results 这类当前没有内容的容器会被
				// 过滤掉，防止出现"打开后立刻关闭、源侧仍空白"的状态。
				const isValidFallback = (cid: string): boolean => {
					if (cid === id) {
						return false;
					}
					const container = this.panelViewDescriptorService.getViewContainerById(cid);
					if (!container) {
						return false;
					}
					const model = this.panelViewDescriptorService.getViewContainerModel(container);
					if (model.activeViewDescriptors.length === 0) {
						return false;
					}
					return !targetActiveId || !this.containersShareView(targetActiveId, cid);
				};

				// 1) 优先激活源侧仍 pin 在 bar 上的第一个可用容器。
				let nextId = fromPart.getPinnedPaneCompositeIds().find(isValidFallback);

				// 2) 若源侧已没有任何可用的 pinned 容器，则从整个 Panel 位置里挑
				//    一个不与目标侧当前视图冲突且有 active view 的容器作为候选。
				if (!nextId) {
					nextId = this.panelViewDescriptorService
						.getViewContainersByLocation(ViewContainerLocation.Panel)
						.map(c => c.id)
						.find(isValidFallback);
				}

				if (nextId) {
					await fromPart.pinPaneComposite(nextId);
					await fromPart.openPaneComposite(nextId, false);
					// `openPaneComposite` 触发的 `onDidPaneCompositeOpen` 已负责把
					// 该容器设为激活、高亮并展开其首视图（`ensureFirstViewWorking`）。
					// 但拖拽这种跨 side 的复杂时序下，composite bar 的 `checked`
					// 高亮（蓝色下划线）与启用态可能没跟上 —— 这里强制刷新一次
					// bar 与启用态，确保标签稳定显示为"激活/可点击"。
					fromPart.refreshCompositeBar();
					fromPart.updateCompositeEnabledStates();
					// 兜底：立即 + 下一帧各补一次"确保首视图处于工作状态"。
					// 某些容器（如 OUTPUT）的单视图合并展开依赖扩展就绪后的
					// `updateViewHeaders` 异步回调，仅依赖 `onDidPaneCompositeOpen`
					// 里的那一次 `ensureFirstViewWorking` 可能在该回调触发时视图
					// 尚未就绪而失效，表现为"标签高亮但内容空白/无首视图工作"。
					fromPart.ensureFirstViewWorking();
					setTimeout(() => fromPart.ensureFirstViewWorking(), 0);
				} else {
					// 兜底：如果手动挑选的 fallback 一个都不可用（例如所有其他
					// Panel 容器都与目标侧共享 view），让延迟调度器在 cross-side
					// move 结束后再尝试一次，避免源侧长期空白。
					const sourceSide: PanelSide = toSide === 'left' ? 'right' : 'left';
					this.lastClosedContainerBySide.set(sourceSide, id);
					this.sideFallbackSchedulers.get(sourceSide)?.schedule();
				}
			}

		return result;
	} finally {
		// Final safety net: regardless of which code path executed above, the
		// dragged container must NOT remain visible/pinned on the source side.
		// Some timing (e.g. `onDidViewContainerVisible` re-pinning the container,
		// or the fallback opening it back) can leave a stale tab behind. Force it
		// gone here so the source side never shows the view we just moved out.
		if (fromPart.getActivePaneComposite()?.getId() === id) {
			fromPart.clearActivePaneComposite();
		}
		fromPart.unpinPaneComposite(id);
		fromPart.refreshCompositeBar();
		this.isInCrossSideMove = false;
	}
	}

	private getRestoreContainerId(side: PanelSide, excludeId?: string): string | undefined {
		const lastActive = this.storageService.get(PanelSidePart.activePanelSettingsKeyFor(side), StorageScope.WORKSPACE, '');

		const candidates = this.panelViewDescriptorService.getViewContainersByLocation(ViewContainerLocation.Panel)
			.filter(container => container.id !== excludeId &&
				this.panelViewDescriptorService.getViewContainerModel(container).activeViewDescriptors.length > 0);

		if (lastActive && lastActive !== excludeId && candidates.some(c => c.id === lastActive)) {
			return lastActive;
		}

		return candidates[0]?.id;
	}

	private loadSplitRatio(): number {
		const raw = this.storageService.get(PanelPart.splitRatioSettingsKey, StorageScope.PROFILE, '');
		const value = raw ? Number.parseFloat(raw) : 0.5;
		return Number.isFinite(value) ? Math.min(Math.max(value, 0.1), 0.9) : 0.5;
	}

	private saveSplitRatio(): void {
		if (!this.splitView) {
			return;
		}
		const left = this.splitView.getViewSize(0);
		const right = this.splitView.getViewSize(1);
		const total = left + right;
		if (total <= 0) {
			return;
		}
		this.storageService.store(PanelPart.splitRatioSettingsKey, String(left / total), StorageScope.PROFILE, StorageTarget.USER);
	}

	// ----- Composite (active view) accessors ---------------------------------

	override openPaneComposite(id?: string, focus?: boolean) {
		// Default to the left side for legacy/API callers.
		return this.leftPart.openPaneComposite(id, focus);
	}

	override getActivePaneComposite() {
		// In the dual-panel layout two sides can each host an active view
		// container simultaneously, but the rest of the workbench resolves
		// "the active panel composite" through the single `Panel` location. We
		// therefore must return the composite of the side that *actually* owns
		// focus, not just the first non-null one. Otherwise services such as
		// `ViewsService.getActiveViewPaneContainer` query the wrong side (or none
		// at all) and the views become clickable but non-functional.
		const leftFocus = this.contextKeyService.getContextKeyValue<boolean>(PanelLeftFocusContext.key);
		const rightFocus = this.contextKeyService.getContextKeyValue<boolean>(PanelRightFocusContext.key);

		if (leftFocus && !rightFocus) {
			return this.leftPart.getActivePaneComposite() ?? this.rightPart.getActivePaneComposite();
		}
		if (rightFocus && !leftFocus) {
			return this.rightPart.getActivePaneComposite() ?? this.leftPart.getActivePaneComposite();
		}

		// Neither or both sides claim focus: fall back to the side that has an
		// active composite, preferring the last one the user interacted with.
		return this.rightPart.getActivePaneComposite() ?? this.leftPart.getActivePaneComposite();
	}

	/**
	 * Returns the active composite for the given view container id, regardless of
	 * which side of the dual-panel layout currently holds focus. Used by
	 * `PaneCompositePartService.getActivePaneCompositeForContainer` so that
	 * services such as `ViewsService` can resolve the `ViewPaneContainer` of a
	 * view that is visible on the non-focused side (otherwise it would be
	 * reported as "not active" and become non-functional).
	 */
	getActivePaneCompositeForContainer(id: string): IPaneComposite | undefined {
		if (this.leftPart.getActivePaneComposite()?.getId() === id) {
			return this.leftPart.getActivePaneComposite();
		}
		if (this.rightPart.getActivePaneComposite()?.getId() === id) {
			return this.rightPart.getActivePaneComposite();
		}
		return undefined;
	}

	override getPaneComposite(id: string) {
		return this.leftPart.getPaneComposite(id) ?? this.rightPart.getPaneComposite(id);
	}

	override getPaneComposites() {
		// Both sides can each host an active view container in the dual-panel
		// layout. Return the union so callers (View menu, command palette,
		// extension API) see every Panel view, not just the left side.
		const left = this.leftPart.getPaneComposites();
		const right = this.rightPart.getPaneComposites();
		return [...left, ...right.filter(c => !left.includes(c))];
	}

	override getProgressIndicator(id: string) {
		return this.leftPart.getProgressIndicator(id) ?? this.rightPart.getProgressIndicator(id);
	}

	override hideActivePaneComposite(): void {
		// In the dual-panel layout, "hide the active panel composite" must NOT
		// hide the whole Panel. Closing a single view (or the only view of a
		// container) in one side must only collapse THAT side so the other side
		// fills the Panel - it must never take the other side down with it.
		//
		// The previous implementation cleared the focused side and then, when
		// both sides happened to be empty, called `setPartHidden(true)` on the
		// whole Panel. That made closing one view in a dual-panel layout
		// disappear the entire Panel (including the still-wanted other side).
		//
		// An empty Panel is instead kept visible as a drop target (see
		// `shouldAutoHidePartWhenEmpty` and `updatePanelMinimumHeight`), so we
		// only ever collapse the side that currently owns focus here.
		const focusSide = this.getFocusedSide();
		if (focusSide) {
			const side: PanelSide = focusSide === this.leftPart ? 'left' : 'right';
			this.hideSide(side);
		}
	}

	/**
	 * The side that currently owns focus, or the side that still has an active
	 * composite (so a "hide active" request has something to act on).
	 */
	private getFocusedSide(): PanelSidePart | undefined {
		const leftFocus = this.contextKeyService.getContextKeyValue<boolean>(PanelLeftFocusContext.key);
		const rightFocus = this.contextKeyService.getContextKeyValue<boolean>(PanelRightFocusContext.key);
		if (leftFocus && !rightFocus) {
			return this.leftPart;
		}
		if (rightFocus && !leftFocus) {
			return this.rightPart;
		}
		return this.leftPart.getActivePaneComposite() ? this.leftPart
			: this.rightPart.getActivePaneComposite() ? this.rightPart : undefined;
	}

	// ----- Layout ------------------------------------------------------------

	override layout(width: number, height: number, top: number, left: number): void {
		let dimensions: Dimension;
		// Account for the 1px separator border that the CSS paints on the inner
		// edge of the Panel so the inner content never leaks past the grid cell.
		// Every observable Panel position is listed *explicitly* here: relying on
		// a `default` branch previously let `Position.LEFT` fall through unhandled
		// (it has a `border-right: 1px` just like RIGHT has `border-left`), which
		// left the content one pixel too wide and clipped interaction at the
		// trailing edge -- exactly the "Terminal body is non-functional in the
		// left Panel" regression that kept re-appearing. Listing each case makes
		// it impossible for a newly added position to silently regress again.
		switch (this.layoutService.getPanelPosition()) {
			case Position.RIGHT:
				dimensions = new Dimension(width - 1, height);
				break;
			case Position.LEFT:
				dimensions = new Dimension(width - 1, height);
				break;
			case Position.TOP:
				dimensions = new Dimension(width, height - 1);
				break;
			case Position.BOTTOM:
				dimensions = new Dimension(width, height);
				break;
			default:
				// Defensive: an unknown/transient position must not leak content.
				dimensions = new Dimension(Math.max(width - 1, 0), height);
				break;
		}

		super.layout(dimensions.width, dimensions.height, top, left);

		// Derive the side dimensions from the *computed* layout instead of
		// reading `clientWidth`/`clientHeight` off the content area.
		//
		// `super.layout()` only writes inline styles; the browser has not
		// reflowed yet at this point, so `clientWidth`/`clientHeight` still
		// report the pre-layout values (0 on the very first layout and right
		// after the Panel is re-shown). The old code bailed out on `0` and
		// therefore never called `splitView.layout()`, so `PanelSidePart.layout()`
		// never ran, `CompositePart.contentAreaSize` stayed `undefined` and the
		// active composite was never laid out -- making every Panel view render
		// but stay non-functional.
		//
		// The parent Panel has no title of its own (`hasTitle: false` and the
		// base title element is hidden in `create()`), so the content area
		// spans the full part dimensions.
		//
		// Hardening: never skip laying out the sides even when a transient layout
		// reports a zero/negative size (e.g. the Panel is mid-show or the grid
		// handed us a collapse frame). We floor the sizes at 0 and *always* push
		// them to both sides so the active composite is guaranteed to be sized
		// (PanelSidePart.showComposite re-applies `lastLayoutDimension` on open,
		// so a 0-size frame here is harmless and corrected on the next real
		// layout rather than leaving the body permanently blank).
		this.sideWidth = Math.max(dimensions.width, 0);
		this.sideHeight = Math.max(dimensions.height, 0);

		if (this.splitView) {
			this.splitView.layout(this.sideWidth);

			// `SplitView.layout()` only re-invokes `IView.layout` for views whose
			// size actually changed. On a pure height change (the common case when
			// the user drags the Panel sash up/down) the widths stay identical, so
			// the sides would keep their stale height. Push the current height to
			// both sides explicitly. The right side only exists in the split once
			// a split has happened, so guard its index.
			this.leftPart.layout(this.splitView.getViewSize(0), this.sideHeight, 0, 0);
			if (this.rightInSplit) {
				this.rightPart.layout(this.splitView.getViewSize(1), this.sideHeight, 0, 0);
			}
		}
	}

	protected override updateCompositeBar(): void {
		// Composite bars live on the two side parts; nothing to do at the parent.
	}

	protected override shouldShowCompositeBar(): boolean {
		return false;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		return CompositeBarPosition.TITLE;
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		// The parent Panel owns no composite bar; each side part owns its own.
		throw new Error('PanelPart does not own a composite bar; sides do.');
	}

	// ----- Empty-panel height ------------------------------------------------

	/**
	 * Keep the Panel visible even when it no longer hosts any active composites
	 * so the empty pane drop target remains usable. Its minimum height is then
	 * raised to the preferred height below.
	 */
	protected override shouldAutoHidePartWhenEmpty(): boolean {
		return false;
	}

	/**
	 * When the Panel becomes empty, raise its effective minimum height to the
	 * same preferred height used when opening a view. This prevents the empty
	 * Panel from collapsing to a tiny strip and gives the drop target a usable
	 * default size. When views are present the minimum is lowered back to 77 so
	 * the sash remains draggable to a small size.
	 */
	protected override updatePanelVisibility(): void {
		super.updatePanelVisibility();
		this.updatePanelMinimumHeight();
	}

	private updatePanelMinimumHeight(): void {
		const isEmpty = this.activeContainerBySide.size === 0;
		const targetMinimum = isEmpty ? (this.preferredHeight ?? 350) : 77;
		if (this.minimumHeight !== targetMinimum) {
			this.minimumHeight = targetMinimum;
			this._onDidChange.fire(undefined);
		}

		// Update side visibility: when one side is empty, collapse it so the
		// other side fills the entire panel width (like the single-panel layout).
		this.updateSideVisibility();
	}

	/**
	 * Decide how the split shares the Panel width.
	 *
	 * The Panel opens as a SINGLE area: when the right side is not in the split
	 * (`rightInSplit === false`) the left side simply fills the whole Panel.
	 * When the right side IS in the split we divide the width: if only the left
	 * side hosts a view, the (empty) right side collapses to a minimum drop
	 * width; if both sides host a view we split by the persisted ratio. This
	 * gives the dual-panel view only once the user actually opened a second area.
	 */
	private updateSideVisibility(): void {
		if (!this.splitView || this.sideWidth <= 0 || this.sideHeight <= 0) {
			return;
		}

		if (!this.rightInSplit) {
			// Single-area Panel: left side fills the entire width.
			this.splitView.layout(this.sideWidth);
			this.leftPart.layout(this.splitView.getViewSize(0), this.sideHeight, 0, 0);
			return;
		}

		const leftHidden = this.isSideHidden('left');
		const rightHidden = this.isSideHidden('right');

		if (leftHidden && !rightHidden) {
			// Left collapsed, right fills the panel.
			this.splitView.resizeView(0, 0);
			this.splitView.resizeView(1, this.sideWidth);
		} else if (rightHidden && !leftHidden) {
			// Right collapsed, left fills the panel.
			this.splitView.resizeView(1, 0);
			this.splitView.resizeView(0, this.sideWidth);
		} else if (leftHidden && rightHidden) {
			// Both sides explicitly closed: keep the panel visible as a drop
			// target (minimum height handled elsewhere).
			this.splitView.layout(this.sideWidth);
		} else {
			const leftActive = this.activeContainerBySide.has('left');
			const rightActive = this.activeContainerBySide.has('right');

			if (leftActive && !rightActive) {
				// Left shows a view, right is empty (e.g. mid drag-preview): give
				// the right side a minimum drop width and let the left fill the rest.
				this.splitView.resizeView(1, 150);
				this.splitView.resizeView(0, this.sideWidth - 150);
			} else if (rightActive && !leftActive) {
				// Only the right side has a view. Keep the empty left side at a
				// minimum visible width (a drop target) unless it was explicitly
				// closed, in which case collapse it so the right side fills the
				// panel. Mirrors the `leftActive && !rightActive` branch above so
				// the two areas behave symmetrically - otherwise dragging the only
				// view off the left side would make the left area disappear
				// entirely (zero width) and it could never receive another view.
				if (this.isSideHidden('left')) {
					this.splitView.resizeView(0, 0);
					this.splitView.resizeView(1, this.sideWidth);
				} else {
					this.splitView.resizeView(0, 150);
					this.splitView.resizeView(1, this.sideWidth - 150);
				}
			} else {
				// Both sides host a view: split by the persisted ratio.
				const ratio = this.loadSplitRatio();
				const left = Math.max(150, Math.round(this.sideWidth * ratio));
				const right = Math.max(150, this.sideWidth - left);
				this.splitView.resizeView(0, left);
				this.splitView.resizeView(1, right);
			}
		}

		// Laying out the sides explicitly so their composites get re-sized to
		// the new widths (the now-filling side must repaint at full width).
		this.leftPart.layout(this.splitView.getViewSize(0), this.sideHeight, 0, 0);
		this.rightPart.layout(this.splitView.getViewSize(1), this.sideHeight, 0, 0);
	}

	// ----- Drag-to-split (editor-like) --------------------------------------

	/**
	 * The side the split-preview hot-zone is currently targeting. `undefined`
	 * when no preview is active. Unlike the old `splitPreviewActive` boolean
	 * this remembers *which* side the preview belongs to, so the drop can be
	 * delegated to the correct side and the preview can be symmetrically
	 * torn down for either the left or the right side (previously the logic
	 * was hard-coded to the right side, so dragging a view over the empty
	 * half left by a *closed left* panel never re-activated it).
	 */
	private splitPreviewSide: PanelSide | undefined;

	/**
	 * Register a drag target over the whole Panel so that dragging a view/composite
	 * (from the Activity Bar, Sidebar, Auxiliary Bar, Editor, or another Panel
	 * side) onto the empty right half of a single-area Panel dynamically reveals
	 * the second area as a drop target - and the drop actually moves the view
	 * there, splitting the Panel into two areas. This mirrors how the editor area
	 * splits when a tab is dragged to its edge.
	 *
	 * IMPORTANT: this must run in the *capture* phase. Each side part
	 * (`PanelSidePart`) registers its own empty-pane drop target on its element
	 * (see `AbstractPaneCompositePart.createEmptyPaneMessage`). That handler
	 * calls `EventHelper.stop(e.eventData, true)` which stops *propagation*, so a
	 * bubble-phase listener on the parent `splitContainer` would never see the
	 * event and the split would never trigger - the drop would be handled by the
	 * side and the view would just land in the single Panel. Capturing on the
	 * container lets us decide first: when the drag targets the right half we
	 * stop propagation so the side does not also handle it, and we drive the
	 * split ourselves. When it targets the left half we leave the event alone so
	 * the side handles it normally.
	 *
	 * The drop itself is delegated to the right side's own `dndHandler` (via
	 * `PanelSidePart.handleEmptyAreaDrop`), which correctly recognises drags from
	 * *any* source - not just Panel-internal drags that happen to write into the
	 * shared `LocalSelectionTransfer`. The earlier implementation only took over
	 * the drag when it found Panel drag data in that transfer, so views dragged
	 * from the Activity Bar / Sidebar / Auxiliary Bar / Editor (which use a
	 * different data channel) never triggered the split.
	 */
	private registerSplitDropTarget(): void {
		// Take over the drag when it targets the empty half of the Panel - i.e.
		// the half whose side is NOT currently showing a view. The side the user
		// previously *closed* (via its own close button) is in `hiddenSides` and
		// has either been removed from the split (right) or collapsed to zero
		// width (left), so it has no DOM drop target of its own. We MUST still
		// take over the drag in that case and re-activate that side (see the
		// DRAG_ENTER/DRAG_OVER handlers), otherwise a view can never be dropped
		// onto the second panel after it was closed, leaving the user stuck with
		// a single area they cannot split again.
		//
		// This is exactly what makes "drag a view from the visible panel onto the
		// empty panel" work in the dual-panel layout: when only one of the two
		// areas is showing a view, hovering the empty half lights up a dashed
		// drop border and the drop lands in the second panel, turning the single
		// area into a two-area layout.
		//
		// IMPORTANT: the logic is symmetric for BOTH sides. The previous
		// implementation hard-coded the right side, so dragging a view over the
		// empty half left by a *closed left* panel never re-activated it - the
		// preview only ever looked at the right half. Now `getSplitTargetSide`
		// resolves the side from whichever half the pointer is over.
		// Resolve which side of the split the cursor is currently over, based on
		// the *visible* geometry. Unlike `getSplitTargetSide` this does NOT bail
		// out when the resolved side already shows a view - it is used to decide
		// cross-side drags where the target side is non-empty.
		// (Defined as a class method `resolveSideByPosition` below; call it
		// directly rather than re-wrapping it in a shadowing local closure.)
		const getSplitTargetSide = (e: DragEvent): PanelSide | undefined => {
			const rect = this.splitContainer.getBoundingClientRect();
			if (rect.width <= 0) {
				return undefined;
			}
			// The boundary between the two halves depends on the *visible*
			// geometry, not just whether the right side is in the split:
			//  - When BOTH sides are visible (right in split and the left view
			//    actually has a non-zero width) the boundary is the real width
			//    of the left view, so dragging onto the left area targets left
			//    and onto the right area targets right.
			//  - When ONE side is collapsed/hidden (e.g. the user closed the left
			//    panel and the right fills the whole Panel), the Panel visually
			//    behaves like a single area. The "empty" half the user wants to
			//    re-activate is the *opposite* half of the container, so the
			//    boundary must be the container MIDPOINT. Using the (zero) left
			//    width here would pin the boundary to the container's left edge
			//    and the drag would always resolve to the wrong (right) side,
			//    which is exactly why a closed-left panel could never be
			//    re-triggered by a drag.
			const leftCollapsed = this.isSideHidden('left')
				|| (this.rightViewInSplit && this.splitView.getViewSize(0) <= 0);
			let splitX: number;
			if (this.rightViewInSplit && !leftCollapsed) {
				splitX = rect.left + this.splitView.getViewSize(0);
			} else {
				splitX = rect.left + rect.width / 2;
			}
			const targetSide: PanelSide = e.clientX < splitX ? 'left' : 'right';
			// Only take over when the targeted side is not already showing a
			// view - if it already has a container the side's own handler should
			// deal with the drop (e.g. re-ordering / focusing), and we must not
			// steal it.
			if (this.activeContainerBySide.has(targetSide)) {
				return undefined;
			}
			return targetSide;
		};

		this._register(addDisposableListener(this.splitContainer, EventType.DRAG_ENTER, (e: DragEvent) => {
			const side = getSplitTargetSide(e);
			if (side) {
				EventHelper.stop(e, true);
				// Only (re-)activate the preview when the targeted side actually
				// CHANGES. Comparing against the resolved `side` (instead of
				// merely `undefined`) is what stops the flicker: while the pointer
				// hovers the same empty half, `getSplitTargetSide` keeps returning
				// that side, so we must NOT re-run `ensureSideInSplit` (and thus
				// `updateSideVisibility` -> `resizeView`) on every `dragenter`/`dragover`.
				// Re-running it every frame combined with `clearSplitPreview` -> the
				// opposite `removeRightFromSplit` created a geometry feedback loop:
				// resizing the split moved the `splitX` boundary under the pointer,
				// which flipped the next `getSplitTargetSide` to `undefined`, which
				// tore the side back out of the split, which moved `splitX` again,
				// which re-added it ... an endless add/remove of the side view that
				// made both Panel areas flash until the drop ended.
				if (this.splitPreviewSide !== side) {
					this.splitPreviewSide = side;
					this.splitContainer.classList.add('panel-split-preview');
					// Re-activate the previously closed / empty side so the drop
					// has a real target to land on. `ensureSideInSplit` is a
					// no-op when the side is already in the split.
					this.ensureSideInSplit(side);
				}
			}
		}, true));

		this._register(addDisposableListener(this.splitContainer, EventType.DRAG_OVER, (e: DragEvent) => {
			const side = getSplitTargetSide(e);
			if (side) {
				// Stop propagation so the side's own empty-pane handler (which
				// would otherwise move the view into the single Panel) does not
				// also run. `preventDefault` is required for the drop to fire.
				EventHelper.stop(e, true);
				// Same stability guard as DRAG_ENTER: keep the preview for the
				// current side instead of re-activating it on every high-frequency
				// `dragover`, which would otherwise re-trigger the add/remove flicker
				// loop described there.
				if (this.splitPreviewSide !== side) {
					this.splitPreviewSide = side;
					this.splitContainer.classList.add('panel-split-preview');
					this.ensureSideInSplit(side);
				}
			}
			// IMPORTANT: do NOT clear the split preview here when the pointer is
			// over the *filled* sibling side (the `getSplitTargetSide` `else`
			// branch). Clearing on every `dragover` that lands on the filled half
			// made the empty half add/remove from the SplitView as the pointer
			// crossed the left(filled)/right(empty) boundary, which flashed both
			// Panel areas continuously while dragging a view from the Auxiliary
			// Bar / Editor / Activity Bar over the dual-panel layout. The preview
			// now stays sticky until the pointer genuinely leaves the Panel
			// (`dragleave`, guarded against internal `null` relatedTargets) or a
			// real drop occurs (DROP handler below), which collapses it cleanly.
		}, true));

		this._register(addDisposableListener(this.splitContainer, EventType.DRAG_LEAVE, (e: DragEvent) => {
			// A dragleave on the container fires when leaving the whole Panel.
			// Only clear the preview if we are actually leaving the container,
			// not when moving between its child sides.
			//
			// IMPORTANT: `e.relatedTarget` is `null` in many browsers while the
			// pointer is still *inside* the container (e.g. when it moves over a
			// child element that the browser does not report, or over the
			// `panel-split-preview` overlay / empty-pane hint that covers the
			// side). Treating `null` as "left the container" made every internal
			// `dragleave` cancel the split preview -> `clearSplitPreview()` ->
			// `removeRightFromSplit()` (the right side is dropped from the
			// SplitView). The very next `dragenter` then re-ran `ensureSideInSplit`
			// -> `addRightToSplit`, re-adding the right side. That add/remove
			// ping-pong on every internal move made both Panel areas flash until
			// the drop ended - exactly the "two panels keep flickering" bug when
			// dragging a view from the Auxiliary Bar onto the right (empty) side.
			// So we only clear when `relatedTarget` is a real element that lives
			// OUTSIDE the split container. A `null` target means "still inside"
			// and we must leave the preview (and the split) intact. Leaving the
			// whole window / dropping is cleaned up by the `dragend` / `drop`
			// handlers, which always run.
			if (e.relatedTarget && !isAncestor(e.relatedTarget as HTMLElement, this.splitContainer)) {
				this.clearSplitPreview();
			}
		}, true));

		this._register(addDisposableListener(this.splitContainer, EventType.DROP, (e: DragEvent) => {
			// Cross-side drag interception:
			//
			// When a view/composite is dragged from one Panel side (`dragSourceSide`)
			// and released over the *other* side (whether that side is currently
			// empty or already shows a *different* view), the drop must MOVE the
			// view off the source side. Without this, the drop bubbles down to the
			// target side's `ViewPaneContainer.onDrop` (`isSinglePaneContainer`
			// branch), which only *opens* the view on the target side and never
			// removes it from the source - so the view appears duplicated (lingers
			// in the original Panel), which is exactly the reported bug.
			//
			// We take over the drop here (capture phase, before the side handler
			// sees it) and delegate to the target side's `handleEmptyAreaDrop`,
			// whose dnd pipeline routes the move through
			// `movePaneCompositeToSide` -> `clearActivePaneComposite` +
			// `unpinPaneComposite` on the source, guaranteeing the source is
			// cleared. This covers BOTH the empty-target and the non-empty-target
			// cases (the latter is what the empty-half `getSplitTargetSide` branch
			// used to skip, leaving the source view behind).
			const sourceSide = this.dragSourceSide;
			const dropSide = this.resolveSideByPosition(e);
			if (sourceSide && dropSide && sourceSide !== dropSide) {
				EventHelper.stop(e, true);
				const targetPart = dropSide === 'left' ? this.leftPart : this.rightPart;
				const accepted = targetPart.handleEmptyAreaDrop(e, this.buildSplitDragData(e));
				if (accepted) {
					// Mirror the success branch below: drop the dashed preview
					// border but keep the layout until the async move resolves.
					this.splitPreviewSide = undefined;
					this.splitContainer.classList.remove('panel-split-preview');
				} else {
					// No valid view dropped: cancel any preview so we don't leave a
					// broken half-occupied split behind.
					this.clearSplitPreview();
				}
				// Clean up any stale ViewPaneDropOverlay that the target side's
				// ViewPaneContainer created during onDragEnter (isSinglePaneContainer
				// branch). Because we stopped propagation in the capture phase,
				// the target's onDrop never fires and the overlay is never disposed
				// — leaving a visible PANEL_SECTION_DRAG_AND_DROP_BACKGROUND rectangle
				// that looks like a "dark patch" over the content area (the bug
				// reported with the screenshot). Remove it by ID and class.
				targetPart.sideElement.querySelectorAll('#monaco-pane-drop-overlay').forEach(el => el.remove());
				targetPart.sideElement.querySelectorAll('.dragged-over').forEach(el => el.classList.remove('dragged-over'));
				return;
			}

			// Resolve the *actual* target side from the cursor position rather
			// than the stale `splitPreviewSide`. This is what makes the sticky
			// preview (see the DRAG_OVER handler) safe: while the pointer was
			// hovering the empty half the preview was active, but the user may
			// have moved onto the filled sibling before releasing - in that case
			// the drop must be handled by that side, not forced onto the empty
			// half.
			const side = getSplitTargetSide(e);
			if (side === undefined) {
				// The drop landed on the filled sibling side (or outside the
				// empty half). We do NOT stop propagation, so the side's own
				// handler (the ViewPaneContainer for a side that already hosts a
				// view) processes the drop normally. We only collapse the sticky
				// empty-side preview we may have been showing so it does not
				// linger as a permanent empty panel after the drop.
				if (this.splitPreviewSide !== undefined) {
					this.clearSplitPreview();
				}
				return;
			}
			// Delegate the actual drop to the targeted side's own dnd handler,
			// which understands drags from every Panel-internal source (the
			// dragged view/composite id is carried on the shared
			// `LocalSelectionTransfer`, so `buildSplitDragData` always resolves
			// it for VS Code-internal drags). `handleEmptyAreaDrop` already calls
			// `EventHelper.stop` internally before performing the move, so the
			// other side will not also handle this drop.
			EventHelper.stop(e, true);
			const targetPart = side === 'left' ? this.leftPart : this.rightPart;
			const accepted = targetPart.handleEmptyAreaDrop(e, this.buildSplitDragData(e));
			if (accepted) {
				// IMPORTANT: do NOT call `clearSplitPreview()` here. The move onto
				// the target side (`movePaneCompositeToSide` -> `openPaneComposite`)
				// resolves asynchronously, *after* this synchronous drop handler
				// returns - `activeContainerBySide` is not yet updated, so
				// `clearSplitPreview` would wrongly conclude the target side is
				// still empty and tear it back out of the split, making the
				// dropped view vanish. We only drop the dashed preview border;
				// the real layout is applied once the composite finishes opening
				// (onDidPaneCompositeOpen -> updateSideVisibility). The later
				// `dragend` is a no-op because the preview side is already cleared.
				this.splitPreviewSide = undefined;
				this.splitContainer.classList.remove('panel-split-preview');
			} else {
				// No valid view was dropped (e.g. an unrecognised data type):
				// cancel the preview and collapse the target side back out of the
				// split, since it has nothing to show.
				this.clearSplitPreview();
			}
		}, true));

		this._register(addDisposableListener(this.splitContainer, EventType.DRAG_END, () => {
			this.clearSplitPreview();
		}, true));
	}

	/**
	 * Re-activate the given side so it becomes a drop target inside the split.
	 * The left side is always present in the split (collapsed to zero width when
	 * hidden), so we only need to clear its hidden state and re-layout. The right
	 * side is added to the split lazily, so we also call `addRightToSplit`.
	 */
	private ensureSideInSplit(side: PanelSide): void {
		this.showSide(side);
		if (side === 'right') {
			this.addRightToSplit();
		} else {
			// Left is always in the split (index 0); just re-apply its layout.
			this.updateSideVisibility();
		}
	}

	/**
	 * Build the `CompositeDragAndDropData` for a split drop from the drag event.
	 * VS Code carries every internal drag (Panel title bar, composite bar,
	 * Activity Bar, Sidebar, Auxiliary Bar, Editor, ...) on the shared
	 * `LocalSelectionTransfer` instance, so reading it here resolves the
	 * view/composite id for *all* Panel-internal drags. When the transfer has
	 * no data (an external / unknown drag), we return an empty composite id:
	 * `handleEmptyAreaDrop` will then reject the drop and the preview is
	 * cancelled, which is the safe behaviour.
	 */
	private buildSplitDragData(e: DragEvent): CompositeDragAndDropData {
		const transfer = LocalSelectionTransfer.getInstance<DraggedCompositeIdentifier | DraggedViewIdentifier>();
		const composite = transfer.getData(DraggedCompositeIdentifier.prototype);
		if (composite && composite[0]) {
			return new CompositeDragAndDropData('composite', composite[0].id);
		}
		const view = transfer.getData(DraggedViewIdentifier.prototype);
		if (view && view[0]) {
			return new CompositeDragAndDropData('view', view[0].id);
		}
		// Unknown / external drag with no resolvable id: the drop is rejected by
		// `handleEmptyAreaDrop` (see its `return false`), so the target side is
		// not left in a broken half-occupied state.
		return new CompositeDragAndDropData('composite', '');
	}

	private clearSplitPreview(): void {
		if (this.splitPreviewSide === undefined) {
			return;
		}
		this.splitPreviewSide = undefined;
		this.splitContainer.classList.remove('panel-split-preview');
		// Re-apply the real layout. If the right side is still empty (no view was
		// dropped on it) collapse it back out of the split so the left side fills
		// the Panel again. If the user actually dropped a view,
		// `handleEmptyAreaDrop` has already populated the side and this is a
		// no-op for the split state. `updateSideVisibility` independently collapses
		// an empty left side to a minimum drop width (or keeps it hidden), which
		// is symmetric with the "single area by default" behaviour.
		if (!this.activeContainerBySide.has('right')) {
			this.removeRightFromSplit();
		} else {
			this.updateSideVisibility();
		}
	}

	/**
	 * Resolve which side of the split the cursor is currently over, based purely
	 * on the *visible* geometry. Unlike `getSplitTargetSide` (the empty-half
	 * split-preview logic) this does NOT bail out when the resolved side already
	 * hosts a view - it is used to detect cross-side drags that land on a
	 * *non-empty* target side, where the drop must still be intercepted and
	 * delegated to `movePaneCompositeToSide` so the view is genuinely MOVED off
	 * the source side (and not merely copied/opened on the target while lingering
	 * on the source - the bug this handler fixes).
	 */
	private resolveSideByPosition(e: DragEvent): PanelSide | undefined {
		const rect = this.splitContainer.getBoundingClientRect();
		if (rect.width <= 0) {
			return undefined;
		}
		const leftCollapsed = this.isSideHidden('left')
			|| (this.rightViewInSplit && this.splitView.getViewSize(0) <= 0);
		let splitX: number;
		if (this.rightViewInSplit && !leftCollapsed) {
			splitX = rect.left + this.splitView.getViewSize(0);
		} else {
			splitX = rect.left + rect.width / 2;
		}
		return e.clientX < splitX ? 'left' : 'right';
	}

	// ----- Theming -----------------------------------------------------------

	override updateStyles(): void {
		super.updateStyles();

		const container = assertIsDefined(this.getContainer());
		container.style.backgroundColor = this.getColor(PANEL_BACKGROUND) || '';
		const borderColor = this.getColor(PANEL_BORDER) || this.getColor(contrastBorder) || '';
		container.style.borderLeftColor = borderColor;
		container.style.borderRightColor = borderColor;
		container.style.borderBottomColor = borderColor;
	}

	toJSON(): object {
		return {
			type: Parts.PANEL_PART
		};
	}
}
