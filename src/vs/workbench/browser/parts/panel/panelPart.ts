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
import { TERMINAL_VIEW_ID } from '../../../contrib/terminal/common/terminal.js';
import { DEBUG_PANEL_ID } from '../../../contrib/debug/common/debug.js';
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
import { isSuppressPanelRelayoutOnDragOut, onSuppressPanelRelayoutOnDragOutChange } from '../viewDragSession.js';
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

	/**
	 * 写死后固定显示的 Panel 视图清单（从左到右的顺序）。打包分发给其他用户时，
	 * 初始打开编辑器 Panel 只显示这里列出的视图作为标签页（默认单栏）。
	 * 以后要增加/减少默认显示的视图，只需修改这个数组即可，无需改动其它逻辑。
	 * 当前为 TERMINAL + DEBUG CONSOLE 两个标签页；用户后续把某个视图拖到另一侧
	 * 时可自动展开为左右双栏（拖拽能力保留，见 `registerSplitDropTarget`）。
	 */
	private static readonly PINNED_PANEL_VIEWS: readonly string[] = [TERMINAL_VIEW_ID, DEBUG_PANEL_ID];

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
	 * Containers the user has actually opened on each side at least once.
	 * The empty-side fallback (`sideFallbackSchedulers`) must only reopen a
	 * container from this set — never a container the user has never opened
	 * (e.g. Problems, which is registered with an active view by default and
	 * sorts first by `order`, so it would otherwise be auto-opened on the
	 * first drag that empties a side even though the user never asked for it).
	 */
	private readonly openedContainersBySide = new Map<PanelSide, Set<string>>();
	/**
	 * Sides the user has explicitly closed (via the side's own close button).
	 * A hidden side is collapsed to zero width so the other side fills the
	 * entire Panel. The side is re-shown automatically when the user opens a
	 * view on it again (e.g. from the View menu or Activity Bar).
	 */
	private hiddenSides = new Set<PanelSide>();

	/**
	 * 空 Panel 判定（收起空侧 / 隐藏整 Panel）延迟到下个 tick 执行。原因：切换
	 * 视图时先同步派发 `onDidPaneCompositeClose`（此时 `activeContainerBySide`
	 * 短暂清空），紧接着才是异步的 `onDidPaneCompositeOpen`。若在 close 的同步
	 * 瞬间立即隐藏整个 Panel，open 还没来得及把 active 写回就已消失——表现为
	 * "点一下视图整个 Panel 就没了"。延迟一帧后若 open 已恢复 active，则判定
	 * 自然不触发；若一帧后确实为空，才收起/隐藏。
	 */
	private readonly emptyPanelCheckScheduler = new RunOnceScheduler(() => {
		this.autoCollapseEmptySides();
		this.autoHidePanelIfEmpty();
	}, 0);
	private dragSourceSide: PanelSide | undefined;
	/**
	 * Whether a Panel-originated drag is currently in progress. The empty-side
	 * fallback must NOT run while a drag is happening (or is settling), because
	 * the source side is *expected* to become empty as the view is dragged out.
	 * A drag can dispatch its `onDidPaneCompositeClose` (and thus schedule the
	 * fallback) either before or after `dragend`, so we both cancel pending
	 * schedulers on `dragend` AND keep this flag true until the next tick, as a
	 * belt-and-suspenders guard against the fallback reopening a container the
	 * user never asked for (e.g. Problems / Debug Console) mid-drag.
	 */
	private isDragInProgress = false;
	/**
	 * Tracks the most recent Panel side (left/right) on which each view
	 * container was active. This is authoritative for restoring a view back to
	 * its original side after it has been dragged out to an editor window and
	 * closed: the persisted per-side "last active container" storage can already
	 * point to a fallback container that opened after the drag-out, so relying
	 * on it would send the returning view to the wrong side.
	 */
	private readonly lastActiveSideByContainer = new Map<string, PanelSide>();

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
	 * Whether the workbench is hiding the *whole* Panel (e.g. Ctrl+J / "Toggle
	 * Panel"), as opposed to a user collapsing a single side. Set by
	 * `captureLayoutBeforeHide` right before the hide mutation runs, and read
	 * by `hideActivePaneComposite` so it knows to clear the focused side's
	 * active composite WITHOUT pushing it into `hiddenSides` (which would
	 * collapse the side and make the next Toggle Panel restore a blank panel).
	 */
	private hidingEntirePanel = false;
	/**
	 * Whether `captureLayoutBeforeHide` is currently writing the pre-hide
	 * snapshot. Used by `saveDualPanelLayout` to recover missing
	 * `leftActive`/`rightActive` from the previous storage entry — only during
	 * a hide capture, never during normal saves (a normal save after a
	 * cross-side move MUST persist the user's new choice, even if the move
	 * briefly left one side empty in memory).
	 */
	private capturingLayout = false;
	/**
	 * Persist the current dual-panel layout to storage. Called whenever the
	 * split membership or `hiddenSides` changes (and right before the whole
	 * Panel is hidden) so the *last actually-shown* state is always saved and
	 * can be restored verbatim on the next show.
	 *
	 * The snapshot also records the active view container on *each* side. This
	 * is what guarantees that toggling the Panel off and on — possibly many
	 * times — always restores the exact same views in the exact same number of
	 * panels. Relying solely on the per-side `activepanelid` storage key is not
	 * enough: that key is overwritten by whatever composite happens to open
	 * last, and a cross-side move / drag-out can leave it pointing at a
	 * container that no longer belongs to that side, so a plain re-show would
	 * collapse two areas into one (or open the wrong view).
	 */
	private saveDualPanelLayout(): void {
		// While the whole Panel is being hidden we must keep the pre-hide
		// snapshot intact: the side-collapse mutation triggered by
		// `hideActivePaneComposite` would otherwise overwrite it with the
		// post-mutation (wrong) state.
		if (this.suppressLayoutSave) {
			return;
		}
		// Defensive (gated to pre-hide capture only, see `capturingLayout`):
		// if the in-memory map lost a side (e.g. a stale close event deleted
		// it before the user-driven open refreshed it, or a partially-resolved
		// restore wrote one side but not the other), fall back to the
		// *last-known-good* value we still have in storage. Otherwise a
		// single in-flight save would wipe the persisted `rightActive` to
		// `undefined` and the next Toggle Panel would drop the right panel
		// entirely. The pre-hide capture is the only flow where this fallback
		// is appropriate — a normal user-driven save after a cross-side move
		// must NOT bring back the container the user just moved out.
		const prior = this.loadDualPanelLayout();
		let leftActive: string | undefined = this.activeContainerBySide.get('left');
		let rightActive: string | undefined = this.activeContainerBySide.get('right');
		if (this.capturingLayout) {
			if (!rightActive && prior?.rightActive && this.rightViewInSplit) {
				rightActive = prior.rightActive;
			}
			if (!leftActive && prior?.leftActive) {
				leftActive = prior.leftActive;
			}
		}
		const layout = {
			rightInSplit: this.rightViewInSplit,
			hiddenSides: [...this.hiddenSides],
			leftActive,
			rightActive
		};
		this.storageService.store(PanelPart.layoutSettingsKey, JSON.stringify(layout), StorageScope.WORKSPACE, StorageTarget.USER);
	}

	/**
	 * Whether a faithful dual-panel layout snapshot exists in storage that the
	 * `onDidChangePartVisibility` show branch should restore. When this returns
	 * `true`, `WorkbenchLayoutService.setPanelHidden(false)` MUST NOT also call
	 * `paneCompositeService.openPaneComposite` for the (single) Panel location:
	 * that legacy open uses the *last active single* container and fires an
	 * async `leftPart.openPaneComposite` whose completion runs through the
	 * `onDidPaneCompositeOpen` mutual-exclusion safety-net. If that left-side
	 * container shares a view with the restored right-side container, the safety
	 * net calls `clearAndUnpinSide('right')` and the right panel vanishes again
	 * on every Toggle Panel. Handing the whole restore to `PanelPart` alone
	 * avoids that race.
	 */
	hasDualPanelSnapshot(): boolean {
		const saved = this.loadDualPanelLayout();
		const result = !!saved && saved.rightInSplit && !!saved.rightActive && !!saved.leftActive;
		return result;
	}

	/**
	 * Read the persisted dual-panel layout. Returns `undefined` when nothing
	 * has been persisted yet (first show / fresh session with no prior split).
	 */
	private loadDualPanelLayout(): { rightInSplit: boolean; hiddenSides: Set<PanelSide>; leftActive?: string; rightActive?: string } | undefined {
		const raw = this.storageService.get(PanelPart.layoutSettingsKey, StorageScope.WORKSPACE, '');
		if (!raw) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(raw) as { rightInSplit?: boolean; hiddenSides?: string[]; leftActive?: string; rightActive?: string };
			return {
				rightInSplit: !!parsed.rightInSplit,
				hiddenSides: new Set((parsed.hiddenSides ?? []).filter(s => s === 'left' || s === 'right') as PanelSide[]),
				leftActive: parsed.leftActive,
				rightActive: parsed.rightActive
			};
		} catch {
			return undefined;
		}
	}

	/**
	 * Fix obviously-bad `dualLayout` snapshots left behind by older builds or by
	 * the earlier (buggy) Toggle Panel persistence. A stored `rightInSplit: true`
	 * with no meaningful right container — or with the same container as the left
	 * side — would otherwise make a single-area Panel sprout an empty right half
	 * the first time Toggle Panel is pressed. We only correct clearly-invalid
	 * data so a layout the user genuinely uses is left untouched.
	 */
	private sanitizeStoredDualLayout(): void {
		const saved = this.loadDualPanelLayout();
		if (!saved) {
			return;
		}
		const isInvalid =
			(saved.rightInSplit && !saved.rightActive) ||
			(!!saved.rightActive && !!saved.leftActive && saved.rightActive === saved.leftActive);
		if (isInvalid) {
			this.storageService.remove(PanelPart.layoutSettingsKey, StorageScope.WORKSPACE);
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
		// Persist the current (pre-hide) layout NOW. We must save *before*
		// flipping `suppressLayoutSave`, otherwise the `saveDualPanelLayout()`
		// below would return immediately (its first line bails out when
		// `suppressLayoutSave` is true) and the faithful pre-hide dual-panel
		// snapshot would never reach storage. The next Toggle Panel would then
		// read a stale/empty `rightActive` and silently drop the right panel.
		this.suppressLayoutSave = false;
		// Mark this save as the pre-hide capture so `saveDualPanelLayout`
		// knows it's allowed to recover `rightActive`/`leftActive` from the
		// previous storage entry if the in-memory map was momentarily cleared
		// (e.g. a close event from an interrupted drag fired just before the
		// user pressed Toggle Panel). Without this flag the normal
		// post-cross-side-move save would *also* recover the old container and
		// re-introduce the ghost it just moved out.
		this.capturingLayout = true;
		this.saveDualPanelLayout();
		this.capturingLayout = false;
		// Now suppress the saves that the subsequent hide mutation would
		// otherwise trigger, so the snapshot stays faithful until the hide
		// visibility event clears the flag.
		this.suppressLayoutSave = true;
		// Mark that the whole Panel (not a single side) is being hidden, so
		// `hideActivePaneComposite` keeps the focused side in the split and out
		// of `hiddenSides`.
		this.hidingEntirePanel = true;
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
	/**
	 * Local copy of the `IExtensionService` (the base class keeps it private).
	 * Used by `create()` to defer a `ensureFirstViewWorking` pass until all
	 * extensions — and thus dynamically-registered views such as Ports — are
	 * registered, so a reloaded Panel always restores its view to a working state.
	 */
	private panelExtensionService!: IExtensionService;
	/**
	 * Mirrors the base class `_extensionsRegistered` flag so that
	 * `autoHidePanelIfEmpty` does not hide the Panel before extensions have
	 * finished registering and the initial restore has had a chance to open
	 * the default views.
	 */
	private panelExtensionsRegistered = false;

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

		// Keep a local reference so we can wait for extensions to be registered
		// (see the deferred `ensureFirstViewWorking` in `create()`), since the
		// base class stores `extensionService` as a private field.
		this.panelExtensionService = extensionService;
		this._register(this.panelExtensionService.onDidRegisterExtensions(() => {
			this.panelExtensionsRegistered = true;
			this.updatePanelVisibility();
		}));

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
			// 3. 正在把视图拖出到独立窗口（`isSuppressPanelRelayoutOnDragOut`）——该侧
			//    变成空拖拽目标是"视图已被拖走"的预期结果，若在这里 fallback 重开其它
			//    容器会让 Panel 从空白闪现另一个视图，正是拖出时"Panel 闪一下"的来源。
			if (this.isSideHidden(side) || this.isInCrossSideMove || isSuppressPanelRelayoutOnDragOut() || this.isDragInProgress) {
				return;
			}

			if (sidePart.getActivePaneComposite()) {
				return;
			}

		const openedOnSide = this.openedContainersBySide.get(side);
		const fallback = this.panelViewDescriptorService
			.getViewContainersByLocation(ViewContainerLocation.Panel)
			.filter(c => c.id !== closedContainerId &&
				// Only reopen a container the user has actually opened on this side
				// before. Containers registered with an active view by default (e.g.
				// Problems, which sorts first by `order`) would otherwise be
				// auto-opened the moment a drag empties a side, even though the user
				// never asked for them — see `openedContainersBySide`.
				(openedOnSide?.has(c.id) ?? false) &&
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
		// Persist the freshly-opened side immediately. `addRightToSplit` /
		// `openPaneComposite` is asynchronous, so the `saveDualPanelLayout` it
		// triggers still sees `activeContainerBySide.get(side) === undefined` and
		// would write `rightActive: undefined` to storage. Without this save the
		// persisted `rightActive` is never filled in, so on the next Toggle Panel
		// `hasDualPanelSnapshot()` returns false and the whole restore path is
		// skipped — the right panel is lost. (suppressLayoutSave guards this
		// during hide/restore so the faithful snapshot is not clobbered.)
		this.saveDualPanelLayout();
		// Record that the user has now opened this container on this side, so the
		// empty-side fallback may later reopen it (and only it / other user-opened
		// containers) instead of auto-opening a container the user never opened.
		let opened = this.openedContainersBySide.get(side);
		if (!opened) {
			opened = new Set<string>();
			this.openedContainersBySide.set(side, opened);
		}
		opened.add(openedId);
			// Remember which side this container last lived on so drag-out-to-window
			// close can restore it back to the correct side even if a fallback
			// container has since opened on that side.
			this.lastActiveSideByContainer.set(openedId, side);
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

			// 整个 Panel 正在隐藏（Toggle Panel / Ctrl+J）时，不要为这个 close
			// 安排"兜底重开"。否则隐藏完成后（setTimeout 0）fallback 会把某个容器
			// 重新 open 回刚被清空的侧，污染 activeContainerBySide 并触发一次错误
			// 的 save，导致下一次 Toggle 时右栏状态错乱甚至直接消失。
			if (this.hidingEntirePanel) {
				return;
			}

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

	/**
	 * 写死 Panel 内容：除 `PINNED_PANEL_VIEWS` 中列出的视图外，隐藏 Panel 区域内的
	 * 所有其他视图容器的标签页（Output、Problems、Test、Ports 等）。打包分发给其他
	 * 用户时，初始打开编辑器只显示固定视图的标签页（单栏）。做两件事：
	 *  1) 把非固定容器内部的每个视图设为不可见（通过 `ViewContainerModel.setVisible`），
	 *     避免其默认激活；
	 *  2) 把非固定容器从两侧 bar 上 `unpin`，使其标签页不再出现于初始 composite bar。
	 * 都不影响视图注册体系，用户后续仍可通过拖拽把任意视图拖入当前 Panel（拖到另一侧
	 * 会触发左右双栏，见 `registerSplitDropTarget`）。
	 */
	private hideOtherPanelViews(): void {
		const pinnedIds = new Set<string>(PanelPart.PINNED_PANEL_VIEWS);
		const containers = this.panelViewDescriptorService.getViewContainersByLocation(ViewContainerLocation.Panel);
		for (const container of containers) {
			if (pinnedIds.has(container.id)) {
				continue;
			}
			const model = this.panelViewDescriptorService.getViewContainerModel(container);
			for (const descriptor of model.activeViewDescriptors) {
				if (!pinnedIds.has(descriptor.id) && model.isVisible(descriptor.id)) {
					model.setVisible(descriptor.id, false);
				}
			}
			// 从两侧 bar 上 unpin，隐藏其标签页（初始单栏只显示固定视图）。
			this.leftPart?.unpinPaneComposite(container.id);
			this.rightPart?.unpinPaneComposite(container.id);
		}
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
			this.isDragInProgress = true;
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
			// 当一次拖拽结束时，任何因拖拽导致侧变空而排队的 "兜底重开" 调度器都应
			// 被取消。否则拖动视图到 Editor / 辅助栏 / 侧栏 / 独立窗口等"拖出"场景会
			// 让源侧在拖拽过程中短暂变空，下一帧的 fallback 就会把一个带默认 active
			// 视图、且此前被记录过的容器（如 Problems、Debug Console）重新打开，表现
			// 为"明明没打开过、拖拽时却自己冒出来"。
			//
			// 拖出后源侧保持为空拖拽目标是预期结果；只有用户用关闭按钮"非拖拽"关闭
			// 时，才需要保留 fallback 给该侧补一个视图（那种情况不会触发 dragend，
			// 故不受影响）。
			this.sideFallbackSchedulers.forEach(scheduler => scheduler.cancel());
			// 拖拽收尾可能晚于一帧：close 事件（及 fallback 调度）有时在 dragend
			// 之后才派发。先清掉已排队的调度器（上面），再把标志延迟到下一 tick
			// 才复位，作为第二道保险，确保这段窗口内的 fallback 同样被拦下。
			setTimeout(() => {
				this.isDragInProgress = false;
				// drag 完全结束后重新检查 Panel 是否已空，若已空则自动隐藏。
				this.updatePanelVisibility();
			}, 0);
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
				// The whole-Panel hide is done; the next hide could be a per-side
				// collapse, so reset the flag.
				this.hidingEntirePanel = false;
			} else if (!panelWasVisible && isVisibleNow) {
				// Restore the persisted dual-panel layout so the same number of
				// panels (one or two) re-appears, no matter how many times the
				// Panel was toggled. We read from storage (not a single volatile
				// snapshot) so the state is never lost across repeated toggles.
				//
				// IMPORTANT: suppress layout saves during restore because
				// `layout.ts#setPanelHidden(false)` fires `openPaneComposite`
				// *without await* (line 1987). That async open resolves *after*
				// this synchronous visibility handler, and its
				// `onDidPaneCompositeOpen` → `saveDualPanelLayout()` would
				// overwrite the faithful snapshot we just restored with whatever
				// container `layout.ts` happened to open (usually just the left
				// side's default). Without this guard, repeated Toggle Panel
				// cycles corrupt the persisted `leftActive`/`rightActive` until
				// both sides converge to the same view.
			this.suppressLayoutSave = true;
			const savedLayout = this.loadDualPanelLayout();

			if (savedLayout) {
				this.hiddenSides = new Set(savedLayout.hiddenSides);
				// Reconcile the actual SplitView views with the saved layout
				// instead of trusting the `rightInSplit` boolean. After many
				// Toggle Panel cycles the boolean can disagree with the real
				// view count, which is what made the empty-half drop a no-op.
				//
				// IMPORTANT: only re-add the right side to the split when we
				// have a meaningful container to restore (or the user had
				// explicitly opened the right side before). A stale
				// `rightInSplit: true` from a previous session where the
				// right side was never actually populated must NOT cause an
				// empty right half to appear on every Toggle Panel.
				const shouldHaveRightSplit = savedLayout.rightInSplit && !!savedLayout.rightActive;
				if (shouldHaveRightSplit && !this.rightViewInSplit) {
					this.addRightToSplit();
				} else if (!shouldHaveRightSplit && this.rightViewInSplit) {
					this.removeRightFromSplit();
				}

				// Re-open each side's previously-active view container so the
				// same views come back verbatim. The left side is normally
				// re-opened by `paneCompositeService.openPaneComposite` (the
				// default `panelToOpen` path in `layout.ts#setPanelHidden`), but
				// we still re-apply it here if the restored container differs or
				// the left side was the one hidden. The right side is NOT opened
				// by that path, so without this explicit restore the second panel
				// would re-appear as an empty drop area and its view would be
				// lost across every Toggle Panel cycle.
				//
				// We open with `skipExclusion=true` (system restore) so the two
				// restored containers are not treated as a mutual-exclusion
				// violation even if they legitimately share a view, mirroring the
				// `restore()`/`enforceViewUniquenessAfterRestore` contract.
				//
				// 但必须前置检查：若两侧持久化的容器共享同一 view（如 OUTPUT 与
				// DEBUG CONSOLE 都含 TERMINAL），则跳过右侧打开并清除其持久化 key，
				// 从写入侧根治"Toggle Panel 后两栏显示相同视图"的 bug。
				let rightToOpen = savedLayout.rightActive;
				const leftToOpen = savedLayout.leftActive;
		if (rightToOpen && leftToOpen && this.containersShareView(leftToOpen, rightToOpen)) {
			// Only a *different* container that shares a view with the left side
			// is a genuine mutual-exclusion conflict (showing the same view twice).
			// A *same-container* split is intentional (e.g. two Terminals) and is
			// now permitted — `containersShareView` returns false for `a === b`,
			// so this branch no longer wipes the right panel for that case.
				this.storageService.remove(PanelSidePart.activePanelSettingsKeyFor('right'), StorageScope.WORKSPACE);
			rightToOpen = undefined;
		}
		// When the persisted right container can't be opened (it was cleared
		// above, or `savedLayout.rightActive` was empty), the dual layout must
		// collapse to a single panel — otherwise the right side would re-appear
		// as an empty drop area and every Toggle Panel would toggle between
		// "two halves, right empty" and "hidden", which looks like the right
		// panel "disappeared".
		if (!rightToOpen && this.rightViewInSplit) {
			this.removeRightFromSplit();
		}
		// NOTE: a "same id on both sides" (rightToOpen === leftToOpen) is no
		// longer treated as an error. The user can legitimately split a single
		// container across the two panels, and both sides render it independently.

				// Synchronously seed `activeContainerBySide` BEFORE any
				// `openPaneComposite` call. The open events are asynchronous: when
				// the *first* one fires (typically the left side), it would run
				// `saveDualPanelLayout()` with the other side still `undefined`,
				// overwriting the persisted `rightActive` with `undefined`. On
				// the next Toggle Panel cycle `hasDualPanelSnapshot()` then
				// returns false, the dual-layout restore branch is skipped, and
				// the right panel is permanently lost. Pre-seeding both sides
				// eliminates the unfilled window so the eventual save writes the
				// correct two-container state.
				if (leftToOpen && !this.isSideHidden('left')) {
					this.activeContainerBySide.set('left', leftToOpen);
				}
				if (rightToOpen && savedLayout.rightInSplit && !this.isSideHidden('right')) {
					this.activeContainerBySide.set('right', rightToOpen);
				}

				if (leftToOpen && !this.isSideHidden('left') && this.leftPart.getActivePaneComposite()?.getId() !== leftToOpen) {
					this.leftPart.openPaneComposite(leftToOpen, false, true, true);
				}
				// 在 reopen 右侧之前，再次用左侧*当前实际*激活的容器做互斥检查，
				// 因为上面的 left open 可能改变了左侧状态（或 layout.ts 的 open
				// 已经设好了左侧容器）。
			const actualLeftId = this.leftPart.getActivePaneComposite()?.getId();
		// NOTE: Do NOT skip when `rightPart.getActivePaneComposite()?.getId() === rightToOpen`.
		// Hiding the panel via Toggle Panel only calls `hideActiveComposite()`
		// (which hides the content but keeps the active reference), so on the
		// next show `getActivePaneComposite()` still returns `rightToOpen`. The
		// `!== rightToOpen` guard therefore evaluated to false and silently
		// skipped re-opening the right side on every Toggle Panel cycle after
		// the first, making the right panel "disappear". `openPaneComposite` is
		// idempotent for an already-active container, so re-opening is safe.
		if (rightToOpen && savedLayout.rightInSplit && !this.isSideHidden('right')) {
				// Only block the right side when it would show a *different*
				// container that nonetheless shares a view with the left side.
				// A *same-container* split (e.g. dragging the Terminal onto the
				// other half so two Terminals sit side-by-side) is a legitimate
				// user action and must NOT be wiped — both sides are independent
				// AbstractPaneCompositePart instances, so no double-highlight /
				// empty-body corruption occurs. (Previously `rightToOpen ===
				// actualLeftId` also blocked this case, which is what made
				// `Toggle Panel` drop the right panel on every cycle.)
				if (actualLeftId && this.containersShareView(actualLeftId, rightToOpen)) {
					this.storageService.remove(PanelSidePart.activePanelSettingsKeyFor('right'), StorageScope.WORKSPACE);
					// The two sides cannot co-exist with this container, so the
					// right side must collapse to keep the invariant "never show a
					// view in two places at once". Without this collapse the
					// `rightToOpen` value lingers in `workbench.panel.dualLayout`
					// and the next Toggle Panel re-evaluates the same share
					// check, silently dropping the right panel forever.
					if (this.rightViewInSplit) {
						this.removeRightFromSplit();
					}
				} else {
					// `addRightToSplit` above already inserted the right view into
					// the split; now populate it with its saved container.
					this.rightPart.openPaneComposite(rightToOpen, false, true, true);
				}
			} else {
				// (no right container to open / right side configured hidden)
			}
			} else {
				// No persisted state (first show or restored session): do NOT
				// blindly add a right split from a stale `activepanelid` key.
				// The right side is only added when the user explicitly drags
				// a view there (via `registerSplitDropTarget`).
				this.hiddenSides.clear();
			}
		this.updateSideVisibility();
		// Do NOT re-persist the layout here with the current (still-incomplete)
		// `activeContainerBySide`. The left/right `openPaneComposite` calls above
		// are asynchronous: their `onDidPaneCompositeOpen` has not fired yet, so
		// `activeContainerBySide` still holds `undefined` for both sides. A
		// `saveDualPanelLayout()` at this point would overwrite the faithful
		// pre-hide snapshot (written by `captureLayoutBeforeHide`) with
		// `rightActive: undefined`, and the very next Toggle Panel would then
		// evaluate `shouldHaveRightSplit = rightInSplit && !!rightActive` as
		// false and silently drop the right panel, leaving only the left one.
		//
		// The hide-time `captureLayoutBeforeHide()` already persisted the correct
		// two-panel layout, so here we only need to clear the suppress flag;
		// later user actions (open/hide side, split changes) each trigger their
		// own correct save. We still defer un-suppressing to the next tick so any
		// fire-and-forget open from `layout.ts#setPanelHidden(false)` cannot
		// clobber anything in the meantime.
		this.suppressLayoutSave = false;
		this.updateSideMaximizedContextKeys();
		}
			panelWasVisible = isVisibleNow;
		}));

		// 初始单栏布局：Panel 以单一栏打开，只显示 `PINNED_PANEL_VIEWS` 列出的
		// 视图作为标签页（默认 TERMINAL 激活、DEBUG CONSOLE 作为另一标签页）。
		// 其余 Panel 视图（PROBLEMS/OUTPUT/TEST/PORTS 等）的标签页在左侧 bar 上
		// 被 `hideOtherPanelViews` unpin 掉，所以初始只看到固定视图。
		//
		// 双栏（左右两个 Panel）不在初始时强制展开——只有当用户把某个视图拖到 Panel
		// 的另一侧时，才由 `registerSplitDropTarget` 懒加载出右栏。这样既满足"初始
		// 单栏只显示两个标签页"的诉求，又完整保留了拖拽分栏能力。
		//
		// 注意：忽略持久化的 left/right active container，强制写死初始布局，确保发给
		// 其他用户的构建里 Panel 永远以固定视图的单栏打开。以后要增加默认显示的
		// 视图，只需在 `PINNED_PANEL_VIEWS` 数组中添加对应 id。
		this.hideOtherPanelViews();

		// Sanitize any stale `dualLayout` snapshot from a previous session/older
		// build. A persisted `rightInSplit: true` with no meaningful right-side
		// container (or where left and right point at the *same* container) would
		// otherwise make a fresh "single-area" Panel sprout an empty right half
		// the very first time Toggle Panel is pressed. We only fix obviously-bad
		// data so a legitimate two-panel layout the user actually uses is kept.
		this.sanitizeStoredDualLayout();

		const pinnedViews = PanelPart.PINNED_PANEL_VIEWS;
		this.leftPart.restore(pinnedViews[0]).then(() => {
			// 把其余固定视图 pin 到左侧 bar 上作为标签页（不强制打开，仅显示 tab）。
			// 这样初始单栏里就出现 TERMINAL + DEBUG CONSOLE 两个标签页，用户点击切换。
			for (let i = 1; i < pinnedViews.length; i++) {
				this.leftPart.pinPaneComposite(pinnedViews[i]);
			}
			// `restore()` opens the composite asynchronously, typically before the
			// workbench has laid the Panel out. Re-run our layout once the side
			// has its composite so it is actually sized instead of staying at zero.
			this.relayoutSides();
			// 确保左侧容器内"第一个视图"处于工作状态（可见 + 展开 + body 已渲染）。
			this.leftPart.ensureFirstViewWorking();
			// 兜底不变式：初始 restore 后两侧绝不能出现共享同一 view 的可见项。
			this.enforceViewUniquenessAfterRestore();
		});

		// 二次兜底：等所有扩展（含 `ForwardedPortsView` 这类动态注册视图的贡献点）
		// 注册完成后再补一次 `ensureFirstViewWorking`。
		//
		// 像 Ports（TUNNEL_VIEW_CONTAINER_ID）这种视图，其 descriptor 由
		// `ForwardedPortsView.enableForwardedPortsFeatures()` 在扩展/贡献点就绪后
		// *异步* `registerViews` 进容器 model；而上面的 `restore()` + `relayoutSides`
		// 链路在 descriptor 还没注册时就已经跑完，`ensureFirstViewWorking` 当时读到
		// `allViewDescriptors` 为空而提前 return（见 PanelSidePart 内的"descriptor 未
		// 就绪"分支）。虽然那里挂了监听等 descriptor 到达，但为防止任何时序竞态
		// （例如 descriptor 在监听注册前的那一拍就变好、或 `onDidChangeActiveView
		// Descriptors` 未触发），这里在扩展全就绪这一确定时点再补一次，确保刷新后
		// Ports 这类视图稳定处于工作状态，而不是停在 "Drag a view here to display"。
		this.panelExtensionService.whenInstalledExtensionsRegistered().then(() => {
			// 扩展全部注册完成后，视图容器的 descriptor 才真正就绪。此时再隐藏
			// 非固定视图才有效——`create()` 同步阶段调用时动态注册的容器
			// （Output/Problems/Test/Ports 等）的 descriptor 尚未到达，`activeView
			// Descriptors` 为空导致隐藏空转、未生效，正是"重新编译后 Panel 仍显示
			// 其他视图"的根因。
			this.hideOtherPanelViews();
			this.leftPart.ensureFirstViewWorking();
			// 动态注册视图（Ports 等）就绪后，若用户已把视图拖成双栏，再补一次不变式
			// 兜底，确保两侧不显示共享同一 view 的容器。
			this.enforceViewUniquenessAfterRestore();
		});

		// 关闭拖出的浮动窗口（或关掉编辑器区里的该 tab）后，视图经
		// `ViewEditorInput` 的归位逻辑 `moveViewToLocation(view, Panel)` 回到
		// `workbench.panel.*` 容器。但拖出时 `moveViewToLocation(view, Editor)`
		// 让容器瞬间变空，触发 `PanelSidePart.ensureFirstViewWorkingAfterRemoval`
		// 把它 `unpinPaneComposite` + `clearActivePaneComposite`，Terminal/Output
		// 这类单视图合并容器的 tab 被彻底从 Panel bar 移除。视图归位回来后 bar
		// 仍处在 unpin 状态，tab 不显示 → 表现为"关闭窗口后 Terminal 直接消失"。
		//
		// 这里监听 `onDidChangeLocation`：当某视图从 Editor 区回到 Panel 容器时，
		// 把被拖出时 unpin 的 container 重新 pin 并 open 回它原本所在的 Panel side
		// （优先使用本进程记忆的"该容器最后活跃的 side"，无记忆时回退到持久化记录），
		// 使 tab 重新出现。
		// 只处理 `from === Editor && to === Panel`，即本工作区"归位"动作，避免与
		// 侧栏/辅助栏拖入 Panel 的常规 drop 路径（已由 PanelSidePart 自己 open）冲突。
		this._register(this.panelViewDescriptorService.onDidChangeLocation(e => {
			if (e.to !== ViewContainerLocation.Panel || e.from !== ViewContainerLocation.Editor) {
				return;
			}

			// 归位动作可能一次性带回多个 view，它们可能属于同一个 container。
			// 对每个 container 串行执行 open，避免多个异步 open 交错导致互斥门
			// (`releaseOtherSideIfViewOverlap`) 看不到另一侧的最新 active composite，
			// 从而留下"同一 view 在左右两侧同时显示"的竞态窗口。
			const restored = new Set<string>();
			const openNext = async (): Promise<void> => {
				for (const view of e.views) {
					const container = this.panelViewDescriptorService.getViewContainerByViewId(view.id);
					if (!container || restored.has(container.id)) {
						continue;
					}
					restored.add(container.id);
					const containerId = container.id;

					const leftActiveId = this.leftPart.getActivePaneComposite()?.getId();
					const rightActiveId = this.rightPart.getActivePaneComposite()?.getId();

					// 两侧已经同时出现该 container：这是持久化/时序异常导致的重复，
					// 立即释放右侧，保留左侧作为基线。
					if (leftActiveId === containerId && rightActiveId === containerId) {
						this.clearAndUnpinSide('right');
						continue;
					}

					// 仅单侧激活则跳过正常 open，但同样要检查并清理另一侧的重复。
					if (leftActiveId === containerId || rightActiveId === containerId) {
						const activeSide: PanelSide = leftActiveId === containerId ? 'left' : 'right';
						const otherSide: PanelSide = activeSide === 'left' ? 'right' : 'left';
						const otherActiveId = this.getOtherSidePart(activeSide).getActivePaneComposite()?.getId();
						if (otherActiveId && this.containersShareView(containerId, otherActiveId)) {
							this.clearAndUnpinSide(otherSide);
						}
						continue;
					}

					// 归位回原 side：优先使用本进程记录的"该 container 最后活跃的 side"，
					// 这比读取各 side 持久化的 active container id 更可靠——拖出后源侧
					// 容器被清空，fallback 可能已经在该侧打开了另一个容器，导致存储里
					// 的 right last active 变成别的 container，归位时错判为左侧。
					const rememberedSide = this.lastActiveSideByContainer.get(containerId);
					let targetSide: PanelSide;
					if (rememberedSide) {
						targetSide = rememberedSide;
					} else {
						// 没有记忆（例如跨会话重启后首次归位）时，回退到持久化记录。
						const rightLastActive = this.storageService.get(PanelSidePart.activePanelSettingsKeyFor('right'), StorageScope.WORKSPACE, '');
						targetSide = rightLastActive === containerId ? 'right' : 'left';
					}
					const targetPart = targetSide === 'left' ? this.leftPart : this.rightPart;

					// 若目标 side 之前被关闭或移出了 split（例如拖出后用户点了右侧关闭），
					// 先把它重新加入 split，否则 open 会发生在不可见的侧栏里。
					this.ensureSideInSplit(targetSide);

					// 先 pin 确保 tab 出现在 composite bar 上，再 open 激活容器。
					// 归位时仍然要走互斥门：若该容器包含的视图已经在另一侧显示，必须先
					// 清空另一侧，否则同一 view（如 Terminal）会同时在左右两侧出现。
					// `releaseOtherSideIfViewOverlap` 在 open 前同步检查并释放冲突侧。
					await targetPart.pinPaneComposite(containerId);
					await targetPart.openPaneComposite(containerId, false, true /* skipMaximizeOnShow */, false /* skipExclusion */);
					targetPart.refreshCompositeBar();

					// 每完成一次 open 就补一次唯一性兜底，确保并发/异步路径产生的
					// 任何重复都被立即清理。
					this.enforceViewUniquenessAfterRestore();
				}
			};

			openNext().then(() => {
				// 全部归位完成后最终兜底：强制清空右侧，保证"同一 view 不重复显示"。
				this.enforceViewUniquenessAfterRestore();
			});
		}));


		// Register the drag target that turns the single-area Panel into a split
		// when the user drags a Panel view onto the empty right half.
		this.registerSplitDropTarget();

		// 视图拖出到独立窗口期间会抑制 Panel 重布局，避免闪烁。 suppression 解除后
		// 需要重新检查 Panel 是否已空，如果已空则自动隐藏整个 Panel。
		this._register(onSuppressPanelRelayoutOnDragOutChange(value => {
			if (!value) {
				this.updatePanelVisibility();
			}
		}));
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
	containersShareView(a: string, b: string): boolean {
		// IMPORTANT: a container is allowed to be shown on *both* Panel sides at
		// once. This is the user-intended "split the same view into two panels"
		// (e.g. drag the Terminal onto the other half so two Terminals show
		// side-by-side). Each side is a fully independent AbstractPaneCompositePart
		// with its own title bar, composite bar and storage key, so showing the
		// same container id on the left and right causes no double-highlight /
		// empty-body corruption. Treating `a === b` as "shared" here previously
		// made `Toggle Panel` (which restores via `containersShareView`) wipe the
		// right panel every time, because the restore path saw the two sides as a
		// mutual-exclusion conflict and cleared `rightToOpen`.
		if (a === b) {
			return false;
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

		// 如果两侧都已关闭，自动隐藏整个空 Panel。
		this.autoHidePanelIfEmpty();
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
		// 互斥清空后若整个 Panel 已空，自动隐藏。
		this.autoHidePanelIfEmpty();
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
		// 不仅检查两侧的"激活"容器，还要检查两侧"可见"的全部容器（含 pinned
		// 但未激活的标签页）。原实现只比 `getActivePaneComposite`，导致源侧残留
		// 一个被拖走的 pinned 标签页时（典型的"用户拖出 DEBUG CONSOLE 后左侧仍
		// 显示 DEBUG 标签"场景）不变量被破坏却不被察觉。
		//
		// 这里检测任意一种"两侧同时可见同一 id / 共享 view"的不变式破坏：
		//   1) 同一 id 同时出现在两侧可见集（左侧 pinned + 右侧 active 是最常见的）；
		//   2) 两侧激活容器相互共享 view；
		//   3) 任意一侧可见集（含 pinned 但未激活）与另一侧激活容器共享 view。
		// 命中后释放"非基线侧"以保留基线侧的视图；按不同命中区分释放哪一侧：
		//   - 两侧同时 active 同一 id：清空右侧（基线侧 = 左侧）；
		//   - 仅右侧 active 而左侧 pinned 同一 id：清空左侧的 pinned 残留；
		//   - 仅左侧 active 而右侧 pinned 同一 id：清空右侧。
		const leftVisible = new Set(this.leftPart.getVisiblePaneCompositeIds());
		const rightVisible = new Set(this.rightPart.getVisiblePaneCompositeIds());
		const leftActiveId = this.leftPart.getActivePaneComposite()?.getId();
		const rightActiveId = this.rightPart.getActivePaneComposite()?.getId();

		// (1) 同一 id 同时出现在两侧可见集。
		let conflictingId: string | undefined;
		for (const id of leftVisible) {
			if (rightVisible.has(id)) {
				conflictingId = id;
				break;
			}
		}
		if (conflictingId) {
			// 两侧都同时可见该 id。优先释放"非激活"侧的 pinned 残留（典型的
			// 拖拽后源侧残留 pinned 标签页场景）。两侧都激活或都没激活时，
			// 按基线规则释放右侧。
			const leftHasItActive = leftActiveId === conflictingId;
			const rightHasItActive = rightActiveId === conflictingId;
			if (leftHasItActive && !rightHasItActive) {
				// 左侧激活、右侧只是 pinned 残留：清空右侧的 pinned。
				this.rightPart.unpinPaneComposite(conflictingId);
				this.rightPart.refreshCompositeBar();
			} else if (rightHasItActive && !leftHasItActive) {
				// 右侧激活、左侧只是 pinned 残留：清空左侧的 pinned（典型
				// 的"拖拽后源侧残留 pinned"场景）。
				this.leftPart.unpinPaneComposite(conflictingId);
				this.leftPart.refreshCompositeBar();
			} else {
				// 两侧都激活或都没激活：按基线规则强制释放右侧。
				this.clearAndUnpinSide('right');
				this.storageService.remove(PanelSidePart.activePanelSettingsKeyFor('right'), StorageScope.WORKSPACE);
			}
			return;
		}

		// (2) 两侧激活容器相互共享 view（典型"两个不同 container 但 view 重叠"场景）。
		if (leftActiveId && rightActiveId && this.containersShareView(leftActiveId, rightActiveId)) {
			this.clearAndUnpinSide('right');
			this.storageService.remove(PanelSidePart.activePanelSettingsKeyFor('right'), StorageScope.WORKSPACE);
			return;
		}

		// (3) 一侧 pinned 与另一侧 active 共享 view。
		if (rightActiveId) {
			for (const id of leftVisible) {
				if (this.containersShareView(rightActiveId, id)) {
					this.leftPart.unpinPaneComposite(id);
					this.leftPart.refreshCompositeBar();
					return;
				}
			}
		}
		if (leftActiveId) {
			for (const id of rightVisible) {
				if (this.containersShareView(leftActiveId, id)) {
					this.rightPart.unpinPaneComposite(id);
					this.rightPart.refreshCompositeBar();
					return;
				}
			}
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

				// 2) 若源侧已没有任何可用的 pinned 容器：
				//    —— **不要**再去整个 Panel 位置里"挑一个不与目标侧冲突的容器"
				//    强行顶上。如果这样做，按 Panel 位置 `order` 排序，候选集的第一
				//    个往往是 Problems（默认带 active view）或 Debug Console（用户
				//    在 Debug 阶段也从未主动开启过它），结果就是"用户从没打开过
				//    Problems，但只要把唯一的一个 Panel 视图拖到另一侧或拖出
				//    Panel，源侧就会被自动顶上 Problems"，正是这个 bug 的根因。
				//
				// 正确语义：用户把源侧所有 pin 的内容都拖走了，源侧就该是空白拖拽
				// 目标（"Drag a view here" 占位）。源侧为空是拖拽/拖出场景的预期
				// 结果，不该被旁路补位策略"贴心地"塞一个用户没要过的容器进去。
				// 下次用户从 View 菜单或 Activity Bar 打开容器时，源侧自然会重新
				// 激活。
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
					// 源侧没有任何可激活的 pinned 容器 —— 显式清空源侧激活态，
					// 让 `viewPaneContainer` 渲染"Drag a view here"空白占位。
					// 注意：必须用 `clearActivePaneComposite` 而非
					// `hideActivePaneComposite`，后者会 `setPartHidden(true, ...)`
					// 把整个 Panel 隐藏（连目标侧一起没掉）。
					if (fromPart.getActivePaneComposite()) {
						fromPart.clearActivePaneComposite();
					}
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
		// 兜底：上述 `unpin` 在 `setPinned(id, false)` 返回 false（模型从未把该
		// 容器记为 pinned，例如初始固定视图经过 `hideOtherPanelViews` 之外的其它
		// 路径粘在了 bar 上）时会静默 no-op，但 DOM 里残留的标签页仍会出现为
		// "源侧 pinned + 目标侧 active"的重复。这里主动从源侧可见集合里把该
		// id 强行清出，确保跨 side 拖拽后源侧绝不留该视图的标签。
		const fromVisible = fromPart.getVisiblePaneCompositeIds();
		if (fromVisible.includes(id)) {
			fromPart.unpinPaneComposite(id);
			fromPart.refreshCompositeBar();
		}
		this.isInCrossSideMove = false;

		// 跨 side 拖拽完成后强制检查一次"同一 view 不重复显示"不变量。
		// 某些竞态下（两侧同时处于打开中的中间态）源侧可能没有被及时清空，
		// 这里作为最终兜底释放冲突侧，避免 Terminal 等视图在左右两侧同时出现。
		this.enforceViewUniquenessAfterRestore();

		// 跨 side 拖拽后源侧可能变空；若整个 Panel 已空则自动隐藏（延迟一帧，
		// 等待 open 事件把目标侧 active 写回后再判定，避免误判整 Panel 为空）。
		this.emptyPanelCheckScheduler.schedule();
	}
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
		// This method is reached from TWO very different callers:
		//
		//   1. The "Hide Panel" / close-side flow: where collapsing the focused
		//      side (and remembering it in `hiddenSides`) is the desired outcome.
		//   2. `WorkbenchLayoutService.setPanelHidden(true)` when the user hits
		//      Ctrl+J / "Toggle Panel": the *whole* Panel is being hidden, NOT a
		//      single side. Here we must NOT push the focused side into
		//      `hiddenSides` - otherwise the pre-hide `captureLayoutBeforeHide`
		//      snapshot records that side as hidden and the next Toggle Panel
		//      re-show restores it as permanently collapsed. Repeated toggles
		//      then alternate the two sides into `hiddenSides`, eventually
		//      leaving the entire Panel blank. (This was the root cause of the
		//      "repeated Toggle Panel loses the previous Panel state" bug.)
		//
		// We distinguish the two via a flag set by `setPanelHidden`-style callers
		// (`layoutService.setPanelHidden` -> `captureLayoutBeforeHide` is the only
		// whole-Panel-hide entry point; it marks `this.hidingEntirePanel`). When
		// the whole Panel is being hidden we just clear the active composite of
		// the focused side so it can be re-shown verbatim later, without ever
		// collapsing the side or dropping it from the split.
		const focusSide = this.getFocusedSide();
		if (focusSide) {
			const side: PanelSide = focusSide === this.leftPart ? 'left' : 'right';
			if (this.hidingEntirePanel) {
				// Whole-Panel hide (Toggle Panel): clear the active composite so
				// the side is clean, but keep it in the split and OUT of
				// `hiddenSides` so it comes back exactly as it was. `suppressLayoutSave`
				// is already `true` (set by `captureLayoutBeforeHide`) so the
				// implicit saves below don't clobber the faithful snapshot.
				const part = side === 'left' ? this.leftPart : this.rightPart;
				part.clearActivePaneComposite();
				this.activeContainerBySide.delete(side);
				this.updateSideVisibility();
			} else {
				// User gesture (close a side / Hide Panel button): collapse the
				// side and remember it in `hiddenSides`.
				this.hideSide(side);
			}
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
		if (!this.panelExtensionsRegistered) {
			return;
		}
		super.updatePanelVisibility();
		this.updatePanelMinimumHeight();
	}

	private updatePanelMinimumHeight(): void {
		const isEmpty = this.activeContainerBySide.size === 0;
		const targetMinimum = isEmpty ? (this.preferredHeight ?? 350) : 77;
		if (this.minimumHeight !== targetMinimum) {
			// 拖出窗口期间（`isSuppressPanelRelayoutOnDragOut`）：视图刚被 move 到 Editor
			// 区，源 Panel 侧会短暂变空。若按常规把最小高度从 77 抬到 350 并 fire 重布局，
			// 整个 Panel 区域（连同编辑区）会被重新布局一次——编辑区被挤压再释放，表现为
			// "拖出时 Panel 闪一下 / 重新渲染界面"。此处维持当前高度、既不改最小高度也不
			// 触发重布局，让 Panel 在拖出瞬间保持原样（被拖走的侧自然成为空拖拽目标）。
			if (isEmpty && isSuppressPanelRelayoutOnDragOut()) {
				return;
			}
			this.minimumHeight = targetMinimum;
			this._onDidChange.fire(undefined);
		}

		// 分区后某侧变空 / 两侧都空：收起空侧、隐藏整 Panel 的判定延迟到下个
		// tick（见 `emptyPanelCheckScheduler`），避免切换视图时 close 的同步瞬间
		// 误判为空而把整个 Panel 隐藏。布局（side visibility）仍需同步刷新。
		this.updateSideVisibility();
		this.emptyPanelCheckScheduler.schedule();
	}

	/**
	 * 分区后，当某一侧（左或右）没有任何激活的视图容器时，主动把那一侧收起，
	 * 而不是留一个显示 "Drag a view here to display" 的空占位：
	 *   - 左侧变空：调用 `hideSide('left')`，左侧加入 `hiddenSides`，右侧填充整个 Panel；
	 *   - 右侧变空：调用 `removeRightFromSplit()`，Panel 回到单区（左侧填充），右侧消失。
	 *
	 * 收起后的侧会被 `hiddenSides` 标记，因此 `createSide` 的兜底 scheduler 不会再
	 * 自动重开其它容器，符合"空侧即收起"的预期。
	 *
	 * 跳过以下场景（避免过渡期误收起）：
	 *   - 整个 Panel 正在隐藏（Toggle Panel）的流程中；
	 *   - 视图正在拖出到独立窗口的过渡期间；
	 *   - 视图正在拖拽中。
	 */
	private autoCollapseEmptySides(): void {
		if (this.hidingEntirePanel || isSuppressPanelRelayoutOnDragOut() || this.isDragInProgress) {
			return;
		}

		// 仅当处于双栏布局（右侧在 split 中）才需要做"单侧收起"判定；单栏布局下
		// 没有"右栏"，只需依赖 `autoHidePanelIfEmpty` 处理整 Panel 为空。
		if (!this.rightViewInSplit) {
			return;
		}

		const leftActive = this.activeContainerBySide.has('left');
		const rightActive = this.activeContainerBySide.has('right');

		if (!leftActive && !this.isSideHidden('left')) {
			// 左侧变空：收起左侧，右侧自动填充整个 Panel。
			this.hideSide('left');
		}
		if (!rightActive && this.rightViewInSplit) {
			// 右侧变空：把右栏从 split 移除，Panel 回到单栏（左侧填充）。
			this.removeRightFromSplit();
		}
	}

	/**
	 * 当 Panel 分区后左、右两侧都没有任何激活的视图容器时，直接调用 Hide Panel 的
	 * 方法隐藏整个 Panel，避免空 Panel 继续显示 "Drag a view here to display" 占位。
	 *
	 * 会跳过以下场景：
	 * - Panel 当前不可见；
	 * - 整个 Panel 正在隐藏（Toggle Panel）的流程中；
	 * - 视图正在拖出到独立窗口的过渡期间；
	 * - 仍有某侧持有激活容器。
	 */
	private autoHidePanelIfEmpty(): void {
		if (this.activeContainerBySide.size !== 0) {
			return;
		}
		if (!this.layoutService.isVisible(Parts.PANEL_PART)) {
			return;
		}
		if (this.hidingEntirePanel) {
			return;
		}
		if (isSuppressPanelRelayoutOnDragOut()) {
			return;
		}
		if (this.isDragInProgress) {
			return;
		}

		this.layoutService.setPartHidden(true, Parts.PANEL_PART);
		// 清除空的 dual-layout 快照，避免下次 Toggle Panel 恢复空布局后再次触发隐藏。
		this.storageService.remove(PanelPart.layoutSettingsKey, StorageScope.WORKSPACE);
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
