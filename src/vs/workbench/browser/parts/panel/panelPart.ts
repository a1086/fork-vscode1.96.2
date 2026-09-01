/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/panelpart.css';
import { ActivePanelContext, PanelFocusContext, PanelLeftFocusContext, PanelLeftMaximizedContext, PanelRightFocusContext, PanelRightMaximizedContext } from '../../../common/contextkeys.js';
import { IWorkbenchLayoutService, Parts, Position, positionToString } from '../../../services/layout/browser/layoutService.js';
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
import { Direction, ISerializableView } from '../../../../base/browser/ui/grid/grid.js';
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
	private readonly lastDismissedContainerBySide = new Map<PanelSide, string>();

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
	/**
	 * Safety net for the case where `CompositeDragAndDropObserver.onDragEnd`
	 * never fires (e.g. a view is dragged from one Panel side onto the other
	 * side, or dropped outside any VS Code drop target). In those flows the
	 * observer swallows the dragend, so `isDragInProgress` would stay `true`
	 * forever and `autoHidePanelIfEmpty` would keep bailing — leaving an empty
	 * Panel visible. This scheduler resets the flag a little after the close
	 * that emptied a side, so the empty-Panel auto-hide can finally run. It is
	 * guarded by `isDragInProgress` so a normal drag (whose `onDragEnd` already
	 * cleared the flag) is a no-op and never interferes with drag hit-testing.
	 */
	private readonly dragEndFallbackScheduler = new RunOnceScheduler(() => {
		if (!this.isDragInProgress) {
			return;
		}
		this.isDragInProgress = false;
		this.updatePanelVisibility();
	}, 250);
	/**
	 * 初始化的"确保首视图工作状态"收口点。详见 `scheduleInitialEnsureWorking`
	 * 的注释：它把散落在 `restore().then()` 与 `whenInstalledExtensionsRegistered
	 * ().then()` 中的两处竞态裸调用，合并到"布局就绪 + 扩展就绪"两者都完成后的
	 * 唯一确定时点，根除 Panel 初始化"时好时坏、偶尔停在 'Drag a view here'"。
	 */
	private readonly initialEnsureScheduler = this._register(new RunOnceScheduler(() => {
		this.runInitialEnsureWorking();
	}, 0));
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
	 * Sides currently "height-maximized": each has left the horizontal Panel
	 * split and lives in its own full-height workbench grid column (same
	 * width, height fills the main area). The other side(s) stay in the bottom
	 * Panel strip completely unchanged. Both sides can be maximized at the
	 * same time, independently of each other.
	 */
	private readonly fullHeightSides = new Set<PanelSide>();
	/** Width each lifted-out side had inside the split; restored on exit. */
	private readonly fullHeightSideWidths = new Map<PanelSide, number>();
	/**
	 * Last width each side really had while BOTH sides were still in the split.
	 * Once one side is lifted out the SplitView stretches the remaining single
	 * view to the whole Panel width (view sizes always sum to the container),
	 * so `getViewSize` no longer reports the ratio width - the stretched one is
	 * what made a side "grow" when it was maximized second.
	 */
	private readonly splitSideWidths = new Map<PanelSide, number>();
	/** The grid adapter views handed to the layout service, keyed by side. */
	private readonly fullHeightGridViews = new Map<PanelSide, ISerializableView>();
	private panelStripCollapsed = false;
	private collapsedPanelStripHeight = 0;
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
		// 兜底：当某一侧的 active 在内存里暂为空（例如 Terminal 所在的动态合并容器
		// `workbench.views.service.panel.<uuid>` 因视图状态变化被瞬间清空、或一次
		// 过渡性的 close 事件触发了本保存），但存储里仍记录着该侧上一个有效容器，
		// 且这一侧并未被用户显式关闭（不在 `hiddenSides`、右栏也仍在 split 中），
		// 则沿用存储里的有效值，而**不要**把 active 写成 `undefined` 污染快照。
		//
		// 否则一次"过渡性 close"就会把 `leftActive` 抹成 undefined 落盘，下一次
		// Toggle Panel 的 `capturingLayout` 兜底读到的是已被污染的 undefined，
		// 含 Terminal 的栏因此永久丢失。
		//
		// 注意：`hideSide` / 用户主动关闭会先把该侧加入 `hiddenSides`，此时我们
		// 尊重用户意图，允许把 active 写成空，不做此兜底。
		if (!leftActive && prior?.leftActive && !this.hiddenSides.has('left')) {
			leftActive = prior.leftActive;
		}
		if (!rightActive && prior?.rightActive && this.rightViewInSplit && !this.hiddenSides.has('right')) {
			rightActive = prior.rightActive;
		}
		if (this.capturingLayout) {
			// 隐藏前快照：即便上面已在普通保存中兜底，这里仍再补一层，确保
			// `rightViewInSplit` 与 prior 一致时右栏容器不丢（原有逻辑保留）。
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
		// Height-maximized sides live outside the Panel (their own grid
		// columns). Exit those states first so the pre-hide snapshot and the
		// hide mutation below see the plain split layout (the maximized state
		// itself is deliberately not persisted across a Toggle Panel).
		for (const side of [...this.fullHeightSides]) {
			this.exitSideFullHeight(side);
		}
		this.updateSideMaximizedContextKeys();
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
			// During the initial startup window (`pendingInitialOpen`) the default
			// view (TERMINAL) may be closed by initialization churn (e.g.
			// `hideOtherPanelViews` / visibility restore close+reopen). The normal
			// fallback excludes `closedContainerId` to avoid re-opening a container
			// the user *explicitly* closed, but during startup the close is not
			// user-driven — it is a side effect of init. Including the just-closed
			// container in the candidate set lets the fallback re-open TERMINAL so
			// the Panel does not stay empty on first load.
			const excludeClosed = !this.pendingInitialOpen;
			const fallback = this.panelViewDescriptorService
				.getViewContainersByLocation(ViewContainerLocation.Panel)
				.filter(c => (!excludeClosed || c.id !== closedContainerId) &&
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
			console.log('po' + side + ':' + e.getId());
			// A composite has just become active on this side, so any scheduled
			// "this side is empty" fallback is no longer needed.
			fallbackScheduler.cancel();
			this.lastClosedContainerBySide.delete(side);

			// A view was opened on this side by some path (drag-in, View menu,
			// API). The Panel is no longer in the "empty auto-hide" state, so
			// clear that flag: otherwise the next Toggle Panel would wrongly
			// skip reopening this view and show an empty Panel instead.
			if (this.lastAutoHideWasEmpty) {
			}
			this.lastAutoHideWasEmpty = false;

			const openedId = e.getId();
			this.activeContainerBySide.set(side, openedId);
			// Once startup has fully settled (`runInitialEnsureWorking` done) a real
			// open event proves the default view is genuinely active — drop the
			// `pendingInitialOpen` guard so a *genuinely* empty Panel can later be
			// auto-hidden. We gate on `initialEnsureDone` so that an open event fired
			// *during* the startup churn does NOT prematurely clear the guard (which
			// would let a transient empty map hide the Panel on first load).
			if (this.initialEnsureDone) {
				this.pendingInitialOpen = false;
			}
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
			const otherPart = this.getOtherSidePart(side);
			const otherActiveId = otherPart.getActivePaneComposite()?.getId();
			const otherVisibleIds = otherPart.getVisiblePaneCompositeIds();
			if (openedId && otherActiveId === openedId) {
				// 同一 container 同时 active 在左右两侧：保留本侧（用户拖入的目标侧），
				// 清空另一侧的副本。
				this.clearAndUnpinSide(otherSide);
			} else if (openedId && otherVisibleIds.includes(openedId)) {
				// 另一侧只是把同一 container 作为 pinned tab 显示（未激活），而本侧
				// 刚刚 active 了它（典型场景：左栏初始 pin 了 DEBUG CONSOLE，用户把它
				// 拖到右栏 active）。单一容器归属要求它不能同时出现在两侧，因此只 unpin
				// 掉另一侧的那个 tab，而不是清空整侧（避免误伤另一侧其它视图）。
				otherPart.unpinPaneComposite(openedId);
				otherPart.refreshCompositeBar();
			} else if (openedId && otherVisibleIds.some(id => this.containersShareView(openedId, id))) {
				// 另一侧的 pinned tab 与本侧刚激活的容器"共享 view"（例如本侧激活的是
				// debug 容器里的 VARIABLES，而左栏还 pin 着同一个 debug 容器
				// `workbench.panel.repl` 的 tab）。单一容器归属要求它不能同时出现在两侧，
				// 因此把另一侧所有与之共享 view 的 pinned tab 逐个 unpin 掉。
				for (const id of otherVisibleIds) {
					if (this.containersShareView(openedId, id)) {
						otherPart.unpinPaneComposite(id);
					}
				}
				otherPart.refreshCompositeBar();
			} else if (openedId && otherActiveId && this.containersShareView(openedId, otherActiveId)) {
				this.clearAndUnpinSide(otherSide);
			} else {
				// 无冲突时仅刷新 bar 的禁用/启用视觉反馈（与 `isCompositeEnabled` 对齐）。
				otherPart.updateCompositeEnabledStates();
			}
			this.updatePanelMinimumHeight();

			// 双栏分区后，本 side 的容器刚打开/切换：确保容器内"从左往右第一个视图"
			// 处于工作状态（展开可见）。详见 PanelSidePart.ensureFirstViewWorking。
			sidePart.ensureFirstViewWorking();
		}));
		this._register(sidePart.onDidPaneCompositeClose(e => {
			if (this.activeContainerBySide.get(side) === e.getId()) {
				// BUG FIX: 拖出独立窗口 / 跨位置移动时，close 事件触发的其实是
				// "容器里少了一个视图"，但**整个容器可能仍然活著**（Panel 里还有其它
				// 残留视图）。此时若直接 delete 会把仍含视图的容器误判为已空，使
				// activeContainerBySide 变空 → autoHidePanelIfEmpty 把整个 Panel 隐藏。
				// 因此删除前先确认容器是否真的没有可见视图：有残留就保留登记、不排
				// 兜底，容器继续正常显示，Panel 不会被误隐藏。
				const closingContainer = this.panelViewDescriptorService.getViewContainerById(e.getId());
				const closingModel = closingContainer ? this.panelViewDescriptorService.getViewContainerModel(closingContainer) : undefined;
				const containerStillHasViews = !!closingModel
					&& closingModel.activeViewDescriptors.length > 0;
				const containerStillVisibleViews = !!closingModel
					&& closingModel.visibleViewDescriptors.length > 0;
				if (containerStillHasViews) {
					// 容器明明还有可见视图却收到了 close（典型：拖走另一容器后本侧
					// 被切到该容器，但其视图描述符的增删事件竞态触发了一次误 close，
					// 导致内容区短暂消失）。这里不 delete 登记，并且若容器当前已无
					// active 则重新激活它，把内容拉回来，避免 Panel 显示空占位符。
					// 仅在拖出窗口收尾期间（suppress 为 true）才 re-open：此时本侧正
					// 在从"拖走一个容器"切到下一个容器，re-open 能把误 close 的容器
					// 拉回。归位（关闭独立窗口把视图 move 回原栏）时 suppress 为 false，
					// 不走此分支，避免与正常的 open 流程竞争导致两个容器同时高亮。
					if (containerStillVisibleViews && isSuppressPanelRelayoutOnDragOut()
						&& sidePart.getActivePaneComposite()?.getId() !== e.getId()) {
						sidePart.openPaneComposite(e.getId(), false, true, false);
					}
					return;
				}
				this.activeContainerBySide.delete(side);
				this.sideContainerViewSubscriptions.get(side)?.clear();
				const otherPart = this.getOtherSidePart(side);
				otherPart.updateCompositeEnabledStates();
				// The container that just closed here is now free to be opened on
				// this side again (it is no longer active in the other side), so
				// re-enable it in this side's bar.
				sidePart.updateCompositeEnabledStates();
				this.updatePanelMinimumHeight();

				// BUG FIX: 单栏（或某侧）Panel 里存在多个容器（如 DEBUG CONSOLE +
				// Terminal）。拖走当前 active 容器（整容器被移到独立窗口）后，本侧
				// active 被删除、activeContainerBySide 变空，但 Panel 里**还有其它可见
				// 容器**。此时不应让 Panel 落到空态进而被 autoHide 隐藏，而应立即把另一个
				// 容器激活为本侧新 active，保证 Panel 始终显示仍存在的视图。
				// 注意：fallback 的候选集被 `openedContainersBySide` 过滤，可能排除掉
				// DEBUG CONSOLE 这类"未显式记过"的默认容器，导致 fallback 落空、Panel 被
				// 误隐藏。因此这里直接选中 Panel 里仍"有可见视图"的其它容器，优先级高于
				// fallback。
				// 必须用 `activeViewDescriptors.length > 0` 过滤，而不能只用
				// `getVisiblePaneCompositeIds()` —— 后者包含空容器 tab（例如没有 debug
				// session 时的 DEBUG CONSOLE 容器 workbench.panel.repl），open 这种空容器
				// 后它会因无可见视图而再次 close，内容区只剩 "Drag a view here"。
				const openedOnSide = this.openedContainersBySide.get(side);
				const fallback = this.panelViewDescriptorService
					.getViewContainersByLocation(ViewContainerLocation.Panel)
					.filter(c => c.id !== e.getId() &&
						(openedOnSide?.has(c.id) ?? false) &&
						this.panelViewDescriptorService.getViewContainerModel(c).activeViewDescriptors.length > 0 &&
						!this.containersShareViewOnSide(c.id, side))
					.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
				if (fallback) {
					sidePart.openPaneComposite(fallback.id, false, true, false);
				}

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
			this.lastDismissedContainerBySide.set(side, e.getId());
			fallbackScheduler.schedule();

				// 拖拽把视图拖走（跨侧 / 拖出窗口）时 observer 可能不派发 dragend，
				// 导致 isDragInProgress 卡在 true，使 autoHidePanelIfEmpty 一直 bail。
				// 排一个稍长的兜底，若届时标志仍未被正常 dragend 复位，则在此复位并
				// 触发整 Panel 空判定（autoHidePanelIfEmpty）。正常拖拽 dragend 已先复位，
				// 这里会因守卫跳过，不干扰拖拽命中。
				if (this.isDragInProgress) {
					this.dragEndFallbackScheduler.schedule();
				}
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
				// 空侧（没有激活的视图容器）应该隐藏，而不是显示 "Drag a view here"
				// 占位。把最小宽度设为 0，让 SplitView 能把它完全收起。
				const part = side === 'left' ? that.leftPart : that.rightPart;
				if (!part.getActivePaneComposite()) {
					return 0;
				}
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
		if (!this.splitView) {
			return false;
		}
		// A lifted-out (full-height) side is REMOVED from the split, so the raw
		// view count drops below 2 even while the other side is still in the
		// split. Comparing against a plain `> 1` therefore reports "right not in
		// split" as soon as the left side is maximized, which silently breaks
		// maximizing the right side (`splitIndexOf` returns -1), skips its
		// relayout and persists `rightInSplit: false`. Compare against how many
		// sides the split is expected to hold instead.
		if (this.fullHeightSides.has('right')) {
			return false;
		}
		return this.splitView.length > (this.fullHeightSides.has('left') ? 0 : 1);
	}

	/**
	 * Whether the Panel is currently in the dual (left/right) layout, i.e. the
	 * right side is part of the split. Used to decide whether per-side
	 * maximization (`toggleSideMaximized`) applies or we fall back to whole-panel
	 * maximization.
	 *
	 * A side that is currently lifted out as a full-height column still counts
	 * as dual layout: the split temporarily holds only one view in that state,
	 * but the dual feature is active and the per-side actions — in particular
	 * the "Restore <side> Panel Size" button on the lifted side — must keep
	 * routing to `toggleSideMaximized` instead of falling back to whole-panel
	 * maximization (`toggleMaximizedPanel`), which would otherwise resize the
	 * remaining side in the strip. `rightViewInSplit` intentionally keeps its
	 * pure split-structure semantics; the lifted state is accounted for here.
	 */
	isDualLayout(): boolean {
		return this.rightViewInSplit || this.fullHeightSides.size > 0;
	}

	private addRightToSplit(): void {
		if (!this.splitView || this.fullHeightSides.has('right')) {
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
		// The split holds only the sides that are not lifted out, so index 1 is
		// not valid while the left side is a full-height column (the split is
		// empty then).
		this.splitView.addView(this.getSideView(this.rightPart, 'right'), initialSize, Math.min(1, this.splitView.length));
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
		// Not a hard-coded `1`: while the left side is a full-height column the
		// split holds only the right side, which then lives at index 0.
		this.splitView.removeView(this.splitIndexOf('right'), Sizing.Distribute);
		this.rightPart.sideElement.remove();
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

		// Install the drag-to-split drop targets. The listeners are bound to
		// `splitContainer` plus every height-maximized side element (see
		// `refreshSplitDropTargets`), so the left/right drop hot zone also works
		// while a side is maximized - a maximized side is re-parented out of
		// `splitContainer` and would otherwise no longer receive the drag.
		this.registerSplitDropTarget();

		// Track drag source side so the two sides can drop composites onto
		// each other even though they share the same ViewContainerLocation.
		this._register(CompositeDragAndDropObserver.INSTANCE.onDragStart(e => {
			// 若上一轮拖出（拖到 Editor/窗口/侧栏）未派发 dragend，isDragInProgress
			// 可能卡在 true，会干扰本轮拖拽判定，先复位再开始新一轮拖拽。
			if (this.isDragInProgress) {
				this.isDragInProgress = false;
			}
			this.isDragInProgress = true;
			// 拖拽开始时若整块 Panel 因被拖空而隐藏，临时重新显示为空热区，
			// 否则容器无布局尺寸，getSplitTargetSide 永远返回 undefined，热区唤不起。
			if (!this.layoutService.isVisible(Parts.PANEL_PART) && this.lastAutoHideWasEmpty) {
				this.layoutService.setPartHidden(false, Parts.PANEL_PART);
			}
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
			this.sideFallbackSchedulers.forEach(scheduler => scheduler.cancel());
			setTimeout(() => {
				this.isDragInProgress = false;
				this.endDragState();
				if (!this.layoutService.isVisible(Parts.PANEL_PART)) {
					return;
				}
				if (this.activeContainerBySide.size === 0) {
					this.autoHidePanelIfEmpty();
				}
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

				// Defensive: on hide paths that bypass `captureLayoutBeforeHide`
				// height-maximized sides could still live in their own grid
				// columns. Put them back so the Panel always comes back in its
				// plain split layout.
				for (const side of [...this.fullHeightSides]) {
					this.exitSideFullHeight(side);
				}
				this.updateSideMaximizedContextKeys();

				// If the Panel was hidden while *both* sides were empty (no active
				// view container on either side), remember this so the NEXT Toggle
				// Panel restores an *empty* Panel (drop target) instead of letting
				// `layout.ts#setPanelHidden(false)` reopen a random view
				// (getLastActivePaneCompositeId / first container with views).
				//
				// This must be decided on the hide side (not only in
				// `autoHidePanelIfEmpty`) because a Panel that was shown empty by a
				// previous Toggle, then hidden again by another Toggle, takes the
				// plain `setPanelHidden(true)` path — `autoHidePanelIfEmpty` is not
				// re-entered, so its flag would have been consumed already and the
				// next show would wrongly open a view.
				//
				// GUARD: only after `initialized` is true AND the startup async-open
				// window is over. During startup the Panel may momentarily report
				// zero active containers (the async default view restore has not
				// resolved yet); without this guard we would wrongly flag the Panel
				// as empty and suppress the default view, leaving TERMINAL / DEBUG
				// CONSOLE as dead tabs.
				if (this.initialized && !this.pendingInitialOpen && this.activeContainerBySide.size === 0) {
					this.lastAutoHideWasEmpty = true;
				}
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
					// 右栏不可被永久隐藏：历史上若某次 `hideSide('right')` 把它写进了
					// `hiddenSides`（旧逻辑的 bug），这里主动剔除 `right`，避免它永远
					// 挡住右栏重建。左栏的永久隐藏意图（`hiddenSides` 含 `left`）仍保留。
					const restoredHidden = new Set(savedLayout.hiddenSides);
					restoredHidden.delete('right');
					this.hiddenSides = restoredHidden;
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
			// 注意：这里**不要**直接裸调 `ensureFirstViewWorking` / `relayoutSides`。
			// `restore()` 仅在 `layoutService.whenRestored` 之后打开容器，它既不保证
			// 扩展视图已注册（`whenInstalledExtensionsRegistered`），也不保证 Panel
			// 已被 `layout()` 量过尺寸（`sideWidth/sideHeight` 可能仍是 0）。而
			// `ensureFirstViewWorking` 依赖"容器已可见且侧尺寸非 0"才会真正展开首视图
			// （否则 `openFirst()` 因不可见直接 return，`relayoutSides` 因尺寸为 0
			// 直接 SKIP）。这两者在 `restore().then()` 这一竞态窗口里是否就绪，完全
			// 取决于 `whenRestored` 与 `whenInstalledExtensionsRegistered` 谁先谁后、
			// 以及 `layout()` 是否已在之前跑过 —— 正是"Panel 时好时坏、偶尔停在
			// 'Drag a view here'"的根因。真正的收口统一交给下方的
			// `scheduleInitialEnsureWorking()`，它在两个 Promise 都完成后才执行。
		});

		// 初始"确保首视图工作状态"的**统一收口点**。
		//
		// 把原来散落在 `restore().then()` 与 `whenInstalledExtensionsRegistered().then()`
		// 中的两处竞态裸调用合并到"布局就绪（whenRestored）+ 扩展就绪
		// （whenInstalledExtensionsRegistered）两者都完成"之后的唯一确定时点：
		//   - 到此时点，Panel 必然已被 `layout()` 量过尺寸，所以 `sideWidth/sideHeight`
		//     一定 > 0，`relayoutSides()` 不会再 SKIP；
		//   - 动态注册的视图 descriptor（Ports 等）也已全部就绪，`allViewDescriptors`
		//     不会再为空，首视图能稳定展开并渲染 body，而不是停在 "Drag a view here"。
		// 由于 Frame 是 `RunOnceScheduler(0)`，即使两处 Promise 在 `create()` 早已
		// resolve（热路径），也只会在下一个微任务合并执行一次，杜绝重复展开/闪烁。
		this.scheduleInitialEnsureWorking();

		// NOTE: `this.initialized` is intentionally NOT set here. It must only be
		// set once the default view(s) have actually been restored and the Panel
		// laid out — i.e. inside `runInitialEnsureWorking()`. `restore()` /
		// `whenInstalledExtensionsRegistered()` are asynchronous, so at this
		// synchronous point of `create()` the `activeContainerBySide` map is
		// still empty (TERMINAL has not been opened yet). Setting `initialized =
		// true` now would defeat the guard in `autoHidePanelIfEmpty` /
		// `onDidChangePartVisibility`'s hide branch: a stray `autoHidePanelIfEmpty`
		// call during init (or the very first Toggle Panel / Ctrl+R after a
		// startup flicker) would see `activeContainerBySide.size === 0` +
		// `initialized === true` and wrongly flag the Panel as "empty-auto-hidden",
		// hiding it on first load and then suppressing the default TERMINAL /
		// DEBUG CONSOLE view forever (because `layout.ts#setPanelHidden(false)`
		// sees `isShowingEmptyPanel() === true` and opens nothing). See the
		// assignment in `runInitialEnsureWorking()`.

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
		// Height-maximized sides live OUTSIDE the split (their own full-height
		// grid columns, sized by the workbench grid): skip them here and shift
		// the remaining sides' split indexes accordingly.
		let splitIndex = 0;
		if (!this.fullHeightSides.has('left')) {
			this.leftPart.layout(this.splitView.getViewSize(splitIndex), this.sideHeight, 0, 0);
			splitIndex++;
		}
		if (this.rightInSplit && !this.fullHeightSides.has('right')) {
			this.rightPart.layout(this.splitView.getViewSize(splitIndex), this.sideHeight, 0, 0);
		}
	}

	getDragSourceSide(): PanelSide | undefined {
		return this.dragSourceSide;
	}

	getSidePart(side: PanelSide): PanelSidePart {
		return side === 'left' ? this.leftPart : this.rightPart;
	}

	getOtherSidePart(side: PanelSide): PanelSidePart {
		return side === 'left' ? this.rightPart : this.leftPart;
	}

	/**
	 * 安排在"布局就绪 + 扩展就绪"两者都完成后的唯一确定时点，统一执行初始化收口
	 * （重布局 + 确保首视图工作状态 + 不变式兜底）。详见 `runInitialEnsureWorking`。
	 *
	 * 必须在 `create()` 末尾调用一次以触发。用 `RunOnceScheduler(0)` 把真正的执行
	 * 推到下一微任务：即使 `whenRestored` 与 `whenInstalledExtensionsRegistered` 在
	 * `create()` 期间早已 resolve，也只会在下一帧合并执行一次，避免重复展开/闪烁。
	 */
	private scheduleInitialEnsureWorking(): void {
		// `restore()` 内部已 `await whenRestored` 并打开了 Terminal 容器；这里再
		// 等 `whenInstalledExtensionsRegistered`，到此时点 Panel 必然已被 `layout()`
		// 量过尺寸（sideWidth/sideHeight > 0），且动态注册视图（Ports 等）descriptor
		// 全部就绪——这正是之前两处裸调用各自竞态、谁先谁后不确定所缺失的保证。
		Promise.all([
			this.layoutService.whenRestored,
			this.panelExtensionService.whenInstalledExtensionsRegistered(),
		]).then(() => {
			this.initialEnsureScheduler.schedule();
		});
	}

	/**
	 * 初始化收口的实际执行体。所有"确保 Panel 初始有工作视图"的逻辑集中在此：
	 *   1) `relayoutSides()` —— 此时 sideWidth/sideHeight 必然 > 0，不会再因尺寸为 0
	 *      而 SKIP，让已打开的 composite body 真正获得尺寸。
	 *   2) 左/右两侧各 `ensureFirstViewWorking()` —— 此时容器已可见、descriptor 已就绪，
	 *      首视图能稳定展开并渲染，而不是停在 "Drag a view here to display"。
	 *   3) `hideOtherPanelViews()` —— 扩展就绪后非固定视图的 descriptor 才存在，隐藏
	 *      才真正生效（修复"编译后 Panel 仍显示其他视图"）。
	 *   4) `enforceViewUniquenessAfterRestore()` —— 兜底不变式，两侧不显示共享视图。
	 *
	 * 注意：步骤 1-4 是同步的，但它们可能触发异步的 close/open/fallback（例如
	 * visibility restore 的 close+reopen、`onDidPaneCompositeClose` 的 fallback 重开）。
	 * 这些异步操作在后续微任务/帧里才 settle，所以步骤 2 的 `ensureFirstViewWorking`
	 * 可能在 terminal 被 fallback 重开**之前**就执行了——导致 terminal 有 tab 但 body
	 * 未展开（"Drag a view here to display"）。因此真正的"最终确保"被推迟到
	 * `finalizeInitialEnsureWorking` 里，在所有异步 churn settle 之后再跑一次。
	 */
	private runInitialEnsureWorking(): void {
		this.relayoutSides();
		this.hideOtherPanelViews();
		this.leftPart.ensureFirstViewWorking();
		if (this.rightInSplit) {
			this.rightPart.ensureFirstViewWorking();
		}
		this.enforceViewUniquenessAfterRestore();

		// Mark the initialization closure as done so `onDidPaneCompositeOpen` may
		// start clearing `pendingInitialOpen`. But do NOT clear `pendingInitialOpen`
		// or set `initialized = true` yet — those are deferred to
		// `finalizeInitialEnsureWorking` which runs one tick later, after all
		// async close/open/fallback from the steps above have settled.
		this.initialEnsureDone = true;

		// Defer the final "ensure view is actually working + clear guards" pass by
		// one tick so that any async fallout from the synchronous steps above
		// (fallback re-open, visibility restore close+reopen, etc.) has settled.
		// Without this deferral, `ensureFirstViewWorking` runs before the fallback
		// has re-opened TERMINAL, leaving a tab with no rendered body.
		this.finalizeInitialEnsureScheduler.schedule();
	}

	/**
	 * Final pass of the startup closure, deferred by one tick after
	 * `runInitialEnsureWorking` so all async close/open/fallback churn has settled.
	 * At this point the default view (TERMINAL) is in its final state — either it
	 * survived the churn or it was re-opened by fallback — and one last
	 * `ensureFirstViewWorking` guarantees its body is expanded and rendering.
	 */
	private readonly finalizeInitialEnsureScheduler = this._register(new RunOnceScheduler(() => {
		this.leftPart.ensureFirstViewWorking();
		if (this.rightInSplit) {
			this.rightPart.ensureFirstViewWorking();
		}

		// Now safe to consider the part initialized: the default view(s) have
		// settled through all async churn and their bodies are guaranteed expanded.
		this.initialized = true;
		this.lastAutoHideWasEmpty = false;

		// If the default view is active, drop the startup guard; otherwise keep
		// it until a real open event fires (it will clear the guard because
		// `initialEnsureDone === true`).
		if (this.activeContainerBySide.size > 0) {
			this.pendingInitialOpen = false;
		}
	}, 0));

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
		const viewsB = this.getContainerViewIds(b);
		if (viewsA.size === 0) {
			return false;
		}
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
			console.log('sc' + side + ':' + containerId + (e.added.length ? '+'+e.added.length : '') + (e.removed.length ? '-'+e.removed.length : ''));
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
		// Closing a side that is height-maximized: only pull THAT side back into
		// the plain split. Previously this exited *every* full-height side, which
		// silently dropped the OTHER side's maximization too (so closing an empty
		// left side while the right side was still maximized would un-maximize the
		// right side as well). Exiting only the target side keeps the other
		// maximized side untouched in its own grid column.
		if (this.fullHeightSides.has(side)) {
			this.exitSideFullHeight(side);
		}
		this.updateSideMaximizedContextKeys();
		if (this.hiddenSides.has(side)) {
			return;
		}

		const part = side === 'left' ? this.leftPart : this.rightPart;
		part.clearActivePaneComposite();
		this.activeContainerBySide.delete(side);

		if (side === 'right') {
			// 关闭右栏：只是把它从 split 移除，Panel 回到单栏（左侧填充）。
			// **关键点**：右栏不可永久隐藏——它只是双栏布局里的一个分栏，用户关掉
			// 它只是"当前不要右栏"，不应像左栏那样被钉死在 `hiddenSides` 里。一旦
			// 把 `right` 写进 `hiddenSides`，restore 的 `!this.isSideHidden('right')`
			// 检查就会永远挡住右栏重建，导致右栏（连同其 Problems 视图）在每次
			// Toggle Panel 后都恢复不了、永久消失。
			//
			// 因此右栏关闭**不**加入 `hiddenSides`，只移出 split。这样之后 Toggle /
			// 再次拖入视图时右栏能正常重新出现。
			this.removeRightFromSplit();
		} else {
			// 关闭左栏（基线单栏 Panel）= 关闭整个 Panel 区，属于"用户永久意图"，
			// 才加入 `hiddenSides`，restore 时据此跳过左栏重建。
			this.hiddenSides.add(side);
			// The left side can never be removed (it is the baseline single-area
			// Panel), so we just collapse it via `updateSideVisibility`.
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
	 * Whether the given side is currently "maximized".
	 *
	 * In the dual (split) layout maximizing is per side: the clicked side
	 * leaves the bottom Panel strip and takes a full-height workbench grid
	 * column of unchanged width ("width stays, height is maximized") while
	 * the other side stays in the bottom strip completely unchanged. In that
	 * state only the lifted-out side reports `true`.
	 *
	 * Otherwise (single-area layout, or the classic whole-panel vertical
	 * maximization where the Panel takes over the editor display) both sides
	 * share the single Panel height, so the whole-panel maximized state is
	 * reported for both sides.
	 */
	isSideMaximized(side: PanelSide): boolean {
		// Per-side full-height maximization: the side lives in its own
		// full-height grid column outside the bottom Panel strip.
		if (this.fullHeightSides.size > 0) {
			return this.fullHeightSides.has(side);
		}
		// Fall back to the classic whole-panel vertical maximization.
		return this.layoutService.isPanelMaximized();
	}

	/**
	 * Toggle maximization of a single side of the dual-panel layout.
	 *
	 * In the dual (split) layout with the Panel at the bottom, "maximizing" a
	 * side means HEIGHT-maximizing that side only: the side leaves the
	 * horizontal Panel split and takes a full-height workbench grid column at
	 * the same width, so it fills the entire column height while the other
	 * side stays in the bottom Panel strip completely unchanged (same height,
	 * same width, same views). Each side toggles independently; both sides
	 * can be height-maximized at the same time.
	 *
	 * In any other arrangement (single-area layout, or the Panel moved away
	 * from the bottom) this falls back to the classic whole-panel vertical
	 * maximization. While the WHOLE panel is maximized the button shows the
	 * restore glyph and clicking it simply un-maximizes the panel.
	 */
	toggleSideMaximized(side: PanelSide): void {
		// Make sure the side the user clicked is actually visible before we
		// maximize it (e.g. it could have been closed on its own).
		this.showSide(side);

		if (this.isDualLayout() && this.layoutService.getPanelPosition() === Position.BOTTOM) {
			if (this.fullHeightSides.has(side)) {
				// Restore: put the side back into the split at its old width.
				this.exitSideFullHeight(side);
			} else if (this.layoutService.isPanelMaximized()) {
				this.layoutService.toggleMaximizedPanel();
				const other: PanelSide = side === 'left' ? 'right' : 'left';
				const otherPart = other === 'left' ? this.leftPart : this.rightPart;
				if (!this.isSideHidden(other) && otherPart.getActivePaneComposite()) {
					this.enterSideFullHeight(other);
				}
			} else if (this.fullHeightSides.size > 0) {
				for (const lifted of [...this.fullHeightSides]) {
					this.exitSideFullHeight(lifted);
				}
				this.layoutService.toggleMaximizedPanel();
			} else {
				// Independent: do not touch the other side's full-height state.
				this.enterSideFullHeight(side);
			}
		} else {
			// Single-area layout (or the Panel is not at the bottom): fall
			// back to the classic whole-panel vertical maximization.
			this.layoutService.toggleMaximizedPanel();
		}
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
	 * Lifts the given side out of the horizontal Panel split and hands it to
	 * the workbench grid as a full-height column (unchanged width). The other
	 * side stays in the bottom strip untouched (it simply fills the strip).
	 */
	private enterSideFullHeight(side: PanelSide): void {
		if (!this.splitView) {
			return;
		}
		const index = this.splitIndexOf(side);
		if (index < 0) {
			return;
		}
		const other: PanelSide = side === 'left' ? 'right' : 'left';
		const otherIndex = this.splitIndexOf(other);
		if (otherIndex >= 0) {
			this.splitSideWidths.set(other, this.splitView.getViewSize(otherIndex));
		}
		const otherStillInSplit = otherIndex >= 0;
		const sideWidth = otherStillInSplit
			? Math.max(this.splitView.getViewSize(index), 150)
			: Math.max(this.splitSideWidths.get(side) ?? this.splitView.getViewSize(index), 150);
		this.fullHeightSideWidths.set(side, sideWidth);

		// Removing the view from the horizontal split also detaches its
		// element from the Panel DOM (`SplitView.removeView` disposes the view
		// wrapper); the workbench grid re-parents the element right after.
		this.splitView.removeView(index, Sizing.Distribute);

		const sidePart = side === 'left' ? this.leftPart : this.rightPart;
		sidePart.sideElement.classList.add('panel-side-full-height', `panel-side-full-height-${side}`);
		// Mirror the Panel's docked position on the lifted-out side: the stock
		// maximize/restore icon rotation rules (`.part.basepanel.left/right/top`)
		// no longer match once the side lives outside the `.part.panel`
		// subtree, and the compensation depends on the position (none at the
		// bottom). See `media/panelpart.css`.
		sidePart.sideElement.classList.add(`panel-side-full-height-pos-${positionToString(this.layoutService.getPanelPosition())}`);
		const gridView = this.getMaximizedSideGridView(side);
		this.fullHeightGridViews.set(side, gridView);
		this.layoutService.addPanelSideFullHeightView(
			side === 'left' ? Direction.Left : Direction.Right,
			gridView,
			sideWidth
		);

		this.fullHeightSides.add(side);
		this.relayoutAfterFullHeightChange();
		this.updatePanelStripForFullHeight();
	}

	/**
	 * Puts a height-maximized side back into the horizontal Panel split at its
	 * original index and with its original width.
	 */
	private exitSideFullHeight(side: PanelSide): void {
		const gridView = this.fullHeightGridViews.get(side);
		if (!gridView || !this.splitView) {
			return;
		}
		this.layoutService.removePanelSideFullHeightView(gridView);
		this.fullHeightGridViews.delete(side);
		this.fullHeightSides.delete(side);

		const sidePart = side === 'left' ? this.leftPart : this.rightPart;
		sidePart.sideElement.classList.remove(
			'panel-side-full-height', 'panel-side-full-height-left', 'panel-side-full-height-right',
			'panel-side-full-height-pos-left', 'panel-side-full-height-pos-right',
			'panel-side-full-height-pos-top', 'panel-side-full-height-pos-bottom'
		);

		// Put the side back into the horizontal split at its original index
		// with the width it had before being maximized.
		const sideWidth = this.fullHeightSideWidths.get(side) ?? 150;
		this.fullHeightSideWidths.delete(side);
		const insertIndex = side === 'left' ? 0 : (this.fullHeightSides.has('left') ? 0 : 1);
		this.splitView.addView(this.getSideView(sidePart, side), sideWidth, insertIndex);
		this.relayoutAfterFullHeightChange();
		this.updatePanelStripForFullHeight();
		this.saveSplitRatio();
	}

	private updatePanelStripForFullHeight(): void {
		const splitEmpty = !!this.splitView && this.splitView.length === 0;
		this.minimumHeight = splitEmpty ? 0 : 77;
		this.applyPanelStripHeight(splitEmpty);
	}

	private applyPanelStripHeight(splitEmpty: boolean): void {
		if (!this.layoutService.isVisible(Parts.PANEL_PART)) {
			console.log('s0');
			return;
		}
		if (splitEmpty === this.panelStripCollapsed) {
			return;
		}
		const size = this.layoutService.getSize(Parts.PANEL_PART);
		if (splitEmpty) {
			console.log('s1');
			this.collapsedPanelStripHeight = size.height;
			this.layoutService.setSize(Parts.PANEL_PART, { width: size.width, height: 0 });
			this.panelStripCollapsed = true;
		} else {
			console.log('s2');
			this.layoutService.setSize(Parts.PANEL_PART, { width: size.width, height: this.collapsedPanelStripHeight || this.preferredHeight || 350 });
			this.panelStripCollapsed = false;
		}
	}

	/**
	 * Builds the grid adapter for a lifted-out side: a fixed-width (unchanged
	 * from the split) view that fills the whole column height. The layout
	 * callback forwards to the side part exactly like the split `IView`s do.
	 */
	private getMaximizedSideGridView(side: PanelSide): ISerializableView {
		const sidePart = side === 'left' ? this.leftPart : this.rightPart;
		const fixedWidth = this.fullHeightSideWidths.get(side) ?? 150;
		return {
			element: sidePart.sideElement,
			// Prefer the width the side had in the split, but let the grid
			// shrink it when the window is too narrow: both lifted-out sides
			// together claim the whole editor/panel column width, so a hard
			// fixed width would leave the editor at zero and force the grid to
			// steal the missing space from the auxiliary bar (it collapses).
			minimumWidth: Math.min(fixedWidth, 150),
			maximumWidth: fixedWidth,
			minimumHeight: 200,
			maximumHeight: Number.POSITIVE_INFINITY,
			// Not `High`: a high priority view keeps its own size and pushes the
			// loss onto the normal-priority auxiliary bar, which is what made
			// the auxiliary bar disappear when both sides were maximized.
			priority: LayoutPriority.Normal,
			proportionalLayout: false,
			onDidChange: Event.None,
			layout: (width: number, height: number) => {
				sidePart.layout(width, height, 0, 0);
				// The element was just detached from the Panel split and
				// re-parented into the grid, so the browser has not reflowed it
				// yet when this first callback runs. Views that measure their
				// own container (xterm and friends) then read a stale box and
				// keep rendering at the wrong size - which is why dragging a
				// sash "fixes" it. Re-apply once the layout has settled.
				requestAnimationFrame(() => sidePart.layout(width, height, 0, 0));
			},
			// Required by `ISerializableView`. The workbench grid state is
			// persisted via `createGridDescriptor()` (state keys only), never
			// via `SerializableGrid.serialize`, so this is purely nominal: the
			// maximized state is intentionally not restored across reloads.
			toJSON: () => ({ type: 'panel.side.fullHeight', side })
		};
	}

	/**
	 * Relayouts the Panel internals after a side entered/left the full-height
	 * state: the split (holding only the remaining side) and that remaining
	 * side itself. Mind the shifted split indexes while a side is lifted out
	 * (the remaining side becomes index 0).
	 */
	private relayoutAfterFullHeightChange(): void {
		if (!this.splitView) {
			return;
		}
		this.splitView.layout(this.sideWidth);
		// Only lay out the side(s) still living inside the split; any
		// maximized sides are sized by the workbench grid instead (see
		// `getMaximizedSideGridView`).
		let splitIndex = 0;
		if (!this.fullHeightSides.has('left')) {
			this.leftPart.layout(this.splitView.getViewSize(splitIndex), this.sideHeight, 0, 0);
			splitIndex++;
		}
		if (this.rightViewInSplit && !this.fullHeightSides.has('right')) {
			this.rightPart.layout(this.splitView.getViewSize(splitIndex), this.sideHeight, 0, 0);
		}
		// A side that became (or stopped being) height-maximized was
		// re-parented into / out of its own workbench grid column, so the set
		// of elements that must carry the drag-to-split listeners changed.
		// Re-bind them so the left/right drop hot zone keeps working in the
		// maximized state (a maximized side is no longer inside `splitContainer`,
		// so the container listener alone can no longer see drags over it).
		this.refreshSplitDropTargets();
	}

	/**
	 * Index of the given side inside the horizontal Panel split, accounting
	 * for lifted-out (height-maximized) sides. The split only contains sides
	 * that are not full-height, so the indexes shift as sides are lifted out.
	 * Returns -1 for a side that currently lives in its own grid column.
	 */
	private splitIndexOf(side: PanelSide): number {
		if (!this.splitView) {
			return -1;
		}
		if (this.fullHeightSides.has(side)) {
			return -1;
		}
		if (side === 'left') {
			return 0;
		}
		if (!this.rightViewInSplit) {
			return -1;
		}
		return this.fullHeightSides.has('left') ? 0 : 1;
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
	 * 跨 location 拖拽（Sidebar / Auxiliary Bar / Activity Bar / Editor 的视图
	 * 拖到某侧 Panel）在打开目标容器之前，主动清掉**另一侧**所有与之"同 id 或共享
	 * view"的 pinned tab。这样无论拖入的是容器本身还是容器内某个 view（例如把
	 * VARIABLES 拖到右栏会连同 DEBUG CONSOLE 一起激活 debug 容器
	 * `workbench.panel.repl`，而左栏默认就 pin 着该容器），另一侧都不会残留同一
	 * 容器的副本。只 unpin 冲突 tab、不清整侧，避免误伤另一侧其它视图。
	 */
	unpinConflictingContainersOnOtherSide(side: PanelSide, containerId: string): void {
		const otherPart = this.getOtherSidePart(side);
		for (const id of otherPart.getVisiblePaneCompositeIds()) {
			if (id === containerId || this.containersShareView(containerId, id)) {
				otherPart.unpinPaneComposite(id);
			}
		}
		otherPart.refreshCompositeBar();
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

		// (0) 两侧激活的是同一个 container id（例如 DEBUG CONSOLE /
		// `workbench.panel.repl` 左右各一份）。必须显式用严格相等判断，不能依赖
		// 下面的 `containersShareView`：
		//   - `containersShareView` 对 `a === b` 故意返回 false（见其实现注释，
		//     用于让还原路径允许"两个 Terminal 并排"），因此 check (2)/(3) 天然
		//     发现不了"同一容器在两侧同时激活"这一重复；
		//   - 上面的可见集是 composite bar 的 pinned 集合
		//     （`getVisiblePaneCompositeIds`），未 pin 的激活容器不在其中，所以
		//     check (1) 也会漏掉。
		// 三者叠加导致同一视图（DEBUG CONSOLE）能在左右两侧长期共存，而本方法
		// 声明的不变式是"视图必须单一归属，不能同时出现在两个 Panel 中"。
		if (leftActiveId && leftActiveId === rightActiveId) {
			// 与 check (1) 的同 id 分支保持一致：保留右侧，释放左侧的副本。
			this.clearAndUnpinSide('left');
			this.storageService.remove(PanelSidePart.activePanelSettingsKeyFor('left'), StorageScope.WORKSPACE);
			return;
		}

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
				// 两侧都激活同一个 container id：视图必须单一归属，不能同时出现在
				// 两个 Panel 中。右侧是主 Panel 区域（也是用户把视图拖回的目标侧），
				// 所以保留右侧、强制释放左侧的副本（而非旧实现的清右侧）。
				this.clearAndUnpinSide('left');
				this.storageService.remove(PanelSidePart.activePanelSettingsKeyFor('left'), StorageScope.WORKSPACE);
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
		console.log('mx');
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
		// While one or more sides are height-maximized the split holds only the
		// remaining side(s), so the (left,right) sizes below would be wrong.
		// Keep the last ratio saved while the plain split layout was active.
		if (!this.splitView || this.fullHeightSides.size > 0) {
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
		// Legacy / API callers (commands, View menu, `paneCompositeService.openPaneComposite`)
		// address the Panel by its single `Panel` location and therefore cannot name a
		// side. By default every such open landed on `leftPart`, so two views opened by
		// two commands both piled into the left side — the user saw "one Panel with
		// several working views" instead of the intended "two views split across the
		// left and right panels".
		//
		// Smart side dispatch: if the left side already hosts an *active* container whose
		// views do NOT overlap with the one being opened, and the right side is currently
		// empty (no active container / not yet in the split), route the new open to the
		// right side so the two different views show side-by-side. Otherwise fall back to
		// the left side (original behaviour). Drag-and-drop never reaches this method — it
		// calls `PanelSidePart.openPaneComposite` directly — so this dispatch only affects
		// command/API opens and cannot disturb the drag split logic.
		if (typeof id === 'string') {
			const leftActiveId = this.leftPart.getActivePaneComposite()?.getId();
			const rightActiveId = this.rightPart.getActivePaneComposite()?.getId();
			console.log('OP ' + id + ' L=' + leftActiveId + ' R=' + rightActiveId);
			if (this.lastDismissedContainerBySide.get('right') === id) {
				this.lastDismissedContainerBySide.delete('right');
				console.log('OPdR');
				return this.rightPart.openPaneComposite(id, focus);
			}
			if (this.lastDismissedContainerBySide.get('left') === id) {
				this.lastDismissedContainerBySide.delete('left');
				console.log('OPdL');
				return this.leftPart.openPaneComposite(id, focus);
			}
			if (rightActiveId === id) {
				console.log('OPR');
				return this.rightPart.openPaneComposite(id, focus);
			}
			if (leftActiveId === id) {
				console.log('OPL');
				return this.leftPart.openPaneComposite(id, focus);
			}
			const leftOccupied = !!leftActiveId;
			const rightEmpty = !rightActiveId;
			const noViewOverlap = !leftActiveId || !this.containersShareView(leftActiveId, id);
			console.log('OP? lo=' + leftOccupied + ' re=' + rightEmpty + ' nvo=' + noViewOverlap + ' ris=' + this.rightViewInSplit);
			if (leftOccupied && rightEmpty && noViewOverlap && this.rightViewInSplit) {
				// The right side is not in the split yet -> create it, then open there.
				if (!this.rightViewInSplit) {
					this.addRightToSplit();
				}
				console.log('OPr');
				return this.rightPart.openPaneComposite(id, focus);
			}
		}
		console.log('OPl');
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
			//
			// While a side is height-maximized it lives OUTSIDE the split (its
			// own full-height grid column, sized by the workbench grid), so it
			// must not be touched here. Mind the shifted split indexes when one
			// or both sides are lifted out.
			let splitIndex = 0;
			if (!this.fullHeightSides.has('left')) {
				this.leftPart.layout(this.splitView.getViewSize(splitIndex), this.sideHeight, 0, 0);
				splitIndex++;
			}
			if (this.rightInSplit && !this.fullHeightSides.has('right')) {
				this.rightPart.layout(this.splitView.getViewSize(splitIndex), this.sideHeight, 0, 0);
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
		const splitEmpty = !!this.splitView && this.splitView.length === 0;
		const targetMinimum = splitEmpty ? 0 : (isEmpty ? (this.preferredHeight ?? 350) : 77);
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

		const leftActive = this.leftPart.hasActiveView();
		const rightActive = this.rightPart.hasActiveView();
		console.log('ac' + (leftActive ? 'L' : 'l') + (rightActive ? 'R' : 'r'));

		if (!rightActive && this.rightViewInSplit) {
			if (!this.isDragInProgress && this.splitPreviewSide !== undefined) {
				this.splitView.layout(this.sideWidth);
			} else {
				console.log('a1');
				this.removeRightFromSplit();
				this.updatePanelStripForFullHeight();
			}
		}
		if (!leftActive && rightActive && !this.isSideHidden('left') && this.splitPreviewSide === undefined) {
			if (!this.isDragInProgress) {
				console.log('lh');
				this.hideSide('left');
			}
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
	/**
	 * Whether the most recent "hide the whole Panel" action was triggered by
	 * `autoHidePanelIfEmpty()` because BOTH sides had become empty (no active
	 * view container on either side). This is distinct from a user-driven
	 * Toggle Panel / Ctrl+J hide, where the Panel still held one or more views
	 * that should be restored on the next show.
	 *
	 * When the empty-auto-hide flag is set, the next `setPanelHidden(false)`
	 * must NOT reopen any view — the user expects an *empty* Panel showing the
	 * "Drag a view to display here" drop target, not a random view pulled from
	 * `getLastActivePaneCompositeId` / `getViewContainersByLocation` (which is
	 * what `layout.ts#setPanelHidden` does for a Panel with no dual snapshot).
	 * See the consumer in `layout.ts` and `consumeEmptyAutoHide()`.
	 */
	private lastAutoHideWasEmpty = false;

	/**
	 * Set to `true` once `create()` has finished the initial restore of the
	 * default view(s) (TERMINAL / DEBUG CONSOLE). The empty-auto-hide flag
	 * (`lastAutoHideWasEmpty`) must NOT be touched before this point: during
	 * startup the Panel can briefly report "no active container" (the async
	 * `restore()` of the default view has not resolved yet) and the
	 * `onDidChangePartVisibility` hide branch would otherwise wrongly mark the
	 * Panel as empty, which then makes `layout.ts#setPanelHidden(false)` skip
	 * opening the default view — leaving TERMINAL / DEBUG CONSOLE as dead,
	 * non-working tabs. See `isShowingEmptyPanel()` consumer.
	 */
	private initialized = false;

	/**
	 * `true` while the initial default-view open is still in flight — i.e. from
	 * the moment `create()` schedules the startup restore until `runInitialEnsureWorking`
	 * has actually opened the default view(s) AND the asynchronous
	 * `openPaneComposite` (kicked off by `layout.ts#setPanelHidden(false)` /
	 * `restore()`) has resolved and written the container back into
	 * `activeContainerBySide`.
	 *
	 * This guards `autoHidePanelIfEmpty`: the deferred `emptyPanelCheckScheduler`
	 * fires one tick after `openPaneComposite` is *called* but (because the open
	 * is async) *before* the container is recorded as active, so
	 * `activeContainerBySide.size === 0` temporarily even though a view is being
	 * opened. Without this guard, `autoHidePanelIfEmpty` would see
	 * `initialized === true` + empty map and wrongly `setPartHidden(true)` the
	 * Panel the very first time it is shown — which is exactly the
	 * "first load hides the Panel / Ctrl+R shows nothing" bug. While this flag
	 * is set, `autoHidePanelIfEmpty` must NOT hide the Panel nor flag it empty.
	 *
	 * The flag is cleared ONLY once BOTH of the following hold:
	 *   1. `runInitialEnsureWorking()` has finished its entire startup closure
	 *      (all `ensureFirstViewWorking` / `hideOtherPanelViews` calls that may
	 *      cause close/open churn have settled) — tracked by `initialEnsureDone`;
	 *   2. a real `onDidPaneCompositeOpen` has fired, proving the default view is
	 *      genuinely active (not just *called* to open).
	 * This two-gate design prevents clearing the guard mid-churn (which would let
	 * a transient empty map hide the Panel) while still allowing a *genuinely*
	 * empty Panel to be auto-hidden after startup.
	 */
	private pendingInitialOpen = true;

	/**
	 * `true` only after `runInitialEnsureWorking()` has run to completion — i.e.
	 * the startup closure (relayout + ensure-first-view + hide-other-views +
	 * uniqueness enforcement) is done and no further initialization-driven
	 * close/open churn is expected. Until then, `onDidPaneCompositeOpen` must NOT
	 * clear `pendingInitialOpen`, because an open event during the churn is not
	 * proof that startup is over.
	 */
	private initialEnsureDone = false;

	/**
	 * Returns whether the Panel should be (re)shown as an *empty* Panel (drop
	 * target, no view opened). This is true whenever the Panel was last hidden
	 * while BOTH sides were empty, and stays true across repeated Toggle Panel
	 * cycles until a view is actually opened on either side.
	 *
	 * IMPORTANT: this is a pure *query* — it does NOT clear the flag. The flag is
	 * only cleared in `onDidPaneCompositeOpen` when a real view is opened. This
	 * is deliberate: `layout.ts#setPanelHidden(false)` can fire the show branch
	 * more than once per Toggle (the hide→show sequence triggers the visibility
	 * handler twice), and a read-and-clear would return `true` on the first fire
	 * and `false` on the second, letting the second fire wrongly open a random
	 * view. A stable query avoids that race entirely.
	 */
	isShowingEmptyPanel(): boolean {
		return this.lastAutoHideWasEmpty;
	}

	isPanelCollapsedForFullHeight(): boolean {
		return this.panelStripCollapsed;
	}

	private autoHidePanelIfEmpty(): void {
		// GUARD (startup): while the initial default-view open is still async-in-flight,
		// `activeContainerBySide` transiently reports zero containers even though a view
		// is being opened (the `emptyPanelCheckScheduler` ticks before the async
		// `openPaneComposite` writes the active container back). Hiding now would kill the
		// Panel on first load and set `lastAutoHideWasEmpty`, permanently suppressing the
		// default TERMINAL / DEBUG CONSOLE view. Never hide or flag-empty during this window.
		if (this.pendingInitialOpen) {
			return;
		}
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

		// The Panel is being hidden solely because it became empty. Remember this
		// so the next Toggle Panel restores an *empty* Panel (drop target) rather
		// than letting `layout.ts` reopen a random view.
		// GUARD: never during startup — the default view restore is async and the
		// Panel briefly looks empty; flagging it then would suppress the default
		// TERMINAL / DEBUG CONSOLE view and leave them dead.
		if (this.initialized) {
			this.lastAutoHideWasEmpty = true;
		}

		this.layoutService.setPartHidden(true, Parts.PANEL_PART);
		// 清除空的 dual-layout 快照，避免下次 Toggle Panel 恢复空布局后再次触发隐藏。
		this.storageService.remove(PanelPart.layoutSettingsKey, StorageScope.WORKSPACE);
	}

	private collapseEmptySideInSplit(): boolean {
		if (!this.splitView || this.fullHeightSides.size === 0) {
			return false;
		}
		if (this.hidingEntirePanel || isSuppressPanelRelayoutOnDragOut() || this.isDragInProgress || this.splitPreviewSide !== undefined) {
			console.log('c0');
			return false;
		}
		if (this.rightViewInSplit && !this.rightPart.getActivePaneComposite()) {
			console.log('c1');
			this.removeRightFromSplit();
			this.updatePanelStripForFullHeight();
			return true;
		}
		if (this.rightViewInSplit && !this.fullHeightSides.has('left') && !this.isSideHidden('left') && !this.leftPart.getActivePaneComposite()) {
			console.log('c2');
			this.splitView.resizeView(0, 0);
			this.splitView.resizeView(1, this.sideWidth);
			this.leftPart.layout(0, this.sideHeight, 0, 0);
			this.rightPart.layout(this.sideWidth, this.sideHeight, 0, 0);
			return true;
		}
		return false;
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

		if (this.fullHeightSides.size > 0) {
			if (this.collapseEmptySideInSplit()) {
				return;
			}
			// 当任一最大化（full-height）侧没有激活的视图时，直接隐藏该侧，
			// 而不是显示 "Drag a view here" 的空占位：
			//   - 左侧最大化侧变空：记入 `hiddenSides`，Panel 区回退为单栏；
			//   - 右侧最大化侧变空：从 split 移除，Panel 回退为单栏；
			// 剩余的另一最大化侧继续以 full-height 显示。若所有侧都变空，则
			// 隐藏整个 Panel。跳过拖拽中 / 拖出窗口的过渡期，避免误隐藏。
			if (!this.isDragInProgress && !isSuppressPanelRelayoutOnDragOut() && !this.hidingEntirePanel) {
				const emptyFullHeightSides = [...this.fullHeightSides].filter(side =>
					!(side === 'left' ? this.leftPart : this.rightPart).hasActiveView());
				if (emptyFullHeightSides.length > 0) {
					// 仍有可能存在的活跃侧：剩余的 full-height 侧 + 仍在 split 里
					// 且未隐藏的其他侧。
					const remainingFullHeightActive = this.fullHeightSides.size - emptyFullHeightSides.length > 0;
					const otherSideActive = [...this.fullHeightSides]
						.filter(side => !emptyFullHeightSides.includes(side))
						.some(side => (side === 'left' ? this.leftPart : this.rightPart).hasActiveView());
					const splitActive = (!this.fullHeightSides.has('left') && !this.isSideHidden('left') && this.leftPart.hasActiveView())
						|| (this.rightViewInSplit && this.rightPart.hasActiveView());
					if (!remainingFullHeightActive && !otherSideActive && !splitActive) {
						// 全部变空：隐藏整个 Panel。
						this.autoHidePanelIfEmpty();
						return;
					}
					// 只隐藏变空的最大化侧，保留其余侧（其它仍最大化的一侧继续
					// 在各自的 grid 列里显示；hideSide 只把目标侧退出 full-height，
					// 不再像旧逻辑那样把所有最大化侧都退掉）。
					for (const side of emptyFullHeightSides) {
						this.hideSide(side);
					}
					// 隐藏后可能已无 full-height 侧，此时走下方 split 分支重新布局；
					// 否则对剩余 full-height 侧做常规 full-height 布局。
					if (this.fullHeightSides.size > 0) {
						this.relayoutAfterFullHeightChange();
						this.updatePanelStripForFullHeight();
						return;
					}
				}
			}
			// 若隐藏空侧后已无 full-height 侧，重新走下方 split 分支统一布局
			// （此时 Panel 应回退为单栏并折叠空侧，避免出现 "Drag a view" 占位）。
			if (this.fullHeightSides.size === 0) {
				this.updateSideVisibility();
				return;
			}
			this.relayoutAfterFullHeightChange();
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
			const leftActive = this.activeContainerBySide.has('left') || !!this.leftPart.getActivePaneComposite();
			const rightActive = this.activeContainerBySide.has('right') || !!this.rightPart.getActivePaneComposite();

			// An empty side only needs a visible drop target while the user is
			// actively dragging a view. When no drag is in progress, collapse the
			// empty side to zero so it does not leave a "Drag a view here"
			// placeholder after a view has been dragged out or closed.
			// During a drag we keep a minimum width so the empty half is still
			// a valid drop target.
			//
			// NOTE: `CompositeDragAndDropObserver` does not always set
			// `isDragInProgress` for every kind of view drag (e.g. a view dragged
			// out of the Panel itself, or certain internal drags, fire
			// `dragenter`/`dragover` without the observer having marked the
			// drag as "in progress" on this part). When the split preview is
			// currently showing a side (the user is hovering its empty half),
			// that side MUST keep a minimum width regardless of `isDragInProgress`
			// - otherwise `updateSideVisibility` collapses it to zero the instant
			// `ensureSideInSplit` adds it, leaving only a 1px sash as a drop
			// target (the "right side has almost no hot zone" bug).
			const emptyDropWidth = this.splitPreviewSide !== undefined ? 150 : 0;

			if (leftActive && !rightActive) {
				// Left shows a view, right is empty: give the right side a minimum
				// drop width (while dragging / previewing it) and let the left fill.
				this.splitView.resizeView(1, emptyDropWidth);
				this.splitView.resizeView(0, this.sideWidth - emptyDropWidth);
			} else if (rightActive && !leftActive) {
				// Only the right side has a view. Keep the empty left side at the
				// same minimum drop width unless it was explicitly closed, in which
				// case collapse it to zero so the right side fills the panel.
				if (this.isSideHidden('left')) {
					this.splitView.resizeView(0, 0);
					this.splitView.resizeView(1, this.sideWidth);
				} else {
					this.splitView.resizeView(0, emptyDropWidth);
					this.splitView.resizeView(1, this.sideWidth - emptyDropWidth);
				}
			} else if (!leftActive && !rightActive) {
				if (this.isDragInProgress || this.splitPreviewSide !== undefined) {
					this.splitView.layout(this.sideWidth);
				} else {
					this.removeRightFromSplit();
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
		if (this.splitView.length > 1) {
			this.rightPart.layout(this.splitView.getViewSize(1), this.sideHeight, 0, 0);
		}

		if (!this.leftPart.hasActiveView() && !!this.leftPart.getActivePaneComposite()) {
			console.log('uL');
		}
		if (!this.rightPart.hasActiveView() && !!this.rightPart.getActivePaneComposite()) {
			console.log('uR');
		}
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
	 * DOM listeners backing the drag-to-split drop target. They are re-created
	 * whenever a side enters/leaves the height-maximized state (see
	 * `refreshSplitDropTargets`) because a maximized side is re-parented out of
	 * `splitContainer` into its own workbench grid column, where the container
	 * listeners can no longer see drags over it.
	 */
	private readonly splitDropTargetSubscriptions = this._register(new DisposableStore());

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
		// The side is resolved by `resolveSideByPosition` (real on-screen
		// geometry, class method below) and narrowed down to the EMPTY side by
		// `getSplitTargetSide`. Both are class methods so the listeners installed
		// by `refreshSplitDropTargets` - which are re-bound whenever a side is
		// maximized - can reuse them.
		this.refreshSplitDropTargets();
	}

	/**
	 * (Re-)installs the drag-to-split listeners on every element that must act
	 * as a Panel drop *root*:
	 *
	 *  - `splitContainer`, always: it spans the whole bottom Panel strip,
	 *    including the empty half that has no side element of its own yet -
	 *    that empty half is what lets a drag split a single-area Panel in two.
	 *  - every *height-maximized* side element: a maximized side is handed to
	 *    the workbench grid as its own full-height column and is therefore
	 *    RE-PARENTED out of `splitContainer`. A capture listener on
	 *    `splitContainer` never sees drags over it, so without registering on
	 *    the side element itself the left/right drop hot zone would disappear
	 *    completely while a side is maximized.
	 *
	 * Re-run from `relayoutAfterFullHeightChange()` (the common tail of
	 * `enterSideFullHeight` / `exitSideFullHeight`) so the set of roots always
	 * matches the current layout. A side that still lives inside
	 * `splitContainer` is deliberately NOT registered on its own: it is already
	 * covered by the container listener, and registering both would run every
	 * handler twice for the same event.
	 */
	private refreshSplitDropTargets(): void {
		this.splitDropTargetSubscriptions.clear();
		if (!this.splitContainer || !this.leftPart || !this.rightPart) {
			return;
		}
		const roots: HTMLElement[] = [this.splitContainer];
		if (this.fullHeightSides.has('left')) {
			roots.push(this.leftPart.sideElement);
		}
		if (this.fullHeightSides.has('right')) {
			roots.push(this.rightPart.sideElement);
		}
		for (const root of roots) {
			this.splitDropTargetSubscriptions.add(addDisposableListener(root, EventType.DRAG_ENTER, (e: DragEvent) => this.onSplitDragEnter(e), true));
			this.splitDropTargetSubscriptions.add(addDisposableListener(root, EventType.DRAG_OVER, (e: DragEvent) => this.onSplitDragOver(e), true));
			this.splitDropTargetSubscriptions.add(addDisposableListener(root, EventType.DRAG_LEAVE, (e: DragEvent) => this.onSplitDragLeave(e), true));
			this.splitDropTargetSubscriptions.add(addDisposableListener(root, EventType.DROP, (e: DragEvent) => this.onSplitDrop(e), true));
			this.splitDropTargetSubscriptions.add(addDisposableListener(root, EventType.DRAG_END, () => this.endDragState(), true));
		}
	}

	/**
	 * Resolve which Panel side the cursor is currently over, based on the REAL
	 * ON-SCREEN geometry. This is the single source of truth for both the
	 * empty-half split preview and the cross-side drop interception, and it
	 * must keep working while one or both sides are height-maximized.
	 *
	 * Why the maximized state needs its own branch: a maximized side is lifted
	 * out of the horizontal Panel split and re-parented into its own
	 * full-height workbench grid column. There it owns NO split index, so
	 * `splitView.getViewSize(...)` cannot describe it (and the split may even be
	 * empty) - which is why the split-geometry calculations below must never run
	 * for a lifted-out side. Hit-testing the side's own element instead works in
	 * both arrangements and is the only way a drag over a maximized side can
	 * resolve to that side at all.
	 */
	private resolveSideByPosition(e: DragEvent): PanelSide | undefined {
		if (!this.leftPart || !this.rightPart) {
			return undefined;
		}

		// 1) Height-maximized sides live OUTSIDE the bottom Panel strip (they
		//    sit next to the editor), so hit-test their own columns first.
		for (const side of this.fullHeightSides) {
			const sideRect = this.getSidePart(side).sideElement.getBoundingClientRect();
			if (sideRect.width > 0 && sideRect.height > 0
				&& e.clientX >= sideRect.left && e.clientX <= sideRect.right
				&& e.clientY >= sideRect.top && e.clientY <= sideRect.bottom) {
				return side;
			}
		}

		if (!this.splitContainer || !this.splitView) {
			return undefined;
		}
		const rect = this.splitContainer.getBoundingClientRect();
		if (rect.width <= 0) {
			return undefined;
		}

		// 2) The bottom Panel strip. Which sides does the split still lay out?
		//    `rightViewInSplit` is already false while the right side is lifted
		//    out, so only the left side needs the explicit check.
		const leftInSplit = !this.fullHeightSides.has('left');
		const rightInSplit = this.rightViewInSplit;

		if (!leftInSplit && !rightInSplit) {
			// Both sides are maximized: nothing is left in the strip.
			return undefined;
		}

		if (leftInSplit && rightInSplit) {
			// Both sides share the strip: the boundary is the real width of the
			// left view, with a MIDPOINT fallback while one of the two is still
			// collapsed to zero width. Without that fallback the boundary gets
			// pinned to a container edge and the collapsed half ends up with no
			// drop zone at all (only the sash line reacts).
			const leftSize = this.splitView.getViewSize(0);
			const rightSize = this.splitView.length > 1 ? this.splitView.getViewSize(1) : 0;
			const splitX = (leftSize > 0 && rightSize > 0)
				? rect.left + leftSize
				: rect.left + rect.width / 2;
			return e.clientX < splitX ? 'left' : 'right';
		}

		// Exactly one side is laid out by the split.
		if (this.fullHeightSides.size > 0) {
			// The other side is maximized: the remaining side fills the whole
			// strip, so the ENTIRE strip is its drop area. Halving it would hand
			// one half to the maximized side, which is not there.
			return leftInSplit ? 'left' : 'right';
		}
		// Plain single-area Panel (the second side was never opened): the
		// "empty" half the user wants to re-activate is the opposite half of the
		// container, so the boundary must be the container MIDPOINT.
		return e.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
	}

	/**
	 * Same as `resolveSideByPosition`, but only reports a side while that side
	 * is EMPTY - i.e. while hovering it must reveal a drop hot zone instead of
	 * letting the side's own (already populated) drop handler deal with the
	 * drag. Returns `undefined` for a side that already hosts a view.
	 */
	private getSplitTargetSide(e: DragEvent): PanelSide | undefined {
		const targetSide = this.resolveSideByPosition(e);
		if (targetSide === undefined) {
			return undefined;
		}
		// 只有当目标侧"真实持有可见视图"才算被占据。activeContainerBySide /
		// isSideHidden 在视图被拖走后经常残留旧记录，不能据此拒绝接管，否则
		// 空出的那一半永远唤不起 drop 热区。getActivePaneComposite() 才是该侧
		// 是否真有可见内容的权威来源。
		const occupied = targetSide === 'right'
			? !!this.rightPart.getActivePaneComposite()
			: !!this.leftPart.getActivePaneComposite();
		return occupied ? undefined : targetSide;
	}

	/**
	 * Whether `node` is (or is inside) one of the elements the drag-to-split
	 * listeners are installed on - the Panel strip or a height-maximized side
	 * column. Used to tell a real "the pointer left the Panel" `dragleave` apart
	 * from an internal move between those elements.
	 */
	private isInsidePanelDropArea(node: Node): boolean {
		if (this.splitContainer && isAncestor(node as HTMLElement, this.splitContainer)) {
			return true;
		}
		if (!this.leftPart || !this.rightPart) {
			return false;
		}
		for (const side of this.fullHeightSides) {
			if (isAncestor(node as HTMLElement, this.getSidePart(side).sideElement)) {
				return true;
			}
		}
		return false;
	}

	private onSplitDragEnter(e: DragEvent): void {
		const side = this.getSplitTargetSide(e);
		if (side === undefined) {
			return;
		}
		EventHelper.stop(e, true);
		// Only (re-)activate the preview when the targeted side actually
		// CHANGES. Comparing against the resolved `side` (instead of merely
		// `undefined`) is what stops the flicker: while the pointer hovers the
		// same empty half, `getSplitTargetSide` keeps returning that side, so we
		// must NOT re-run `ensureSideInSplit` (and thus `updateSideVisibility` ->
		// `resizeView`) on every `dragenter`/`dragover`. Re-running it every
		// frame combined with `clearSplitPreview` -> the opposite
		// `removeRightFromSplit` created a geometry feedback loop: resizing the
		// split moved the boundary under the pointer, which flipped the next
		// resolution to `undefined`, which tore the side back out of the split,
		// which moved the boundary again, which re-added it ... an endless
		// add/remove of the side view that made both Panel areas flash until the
		// drop ended.
		if (this.splitPreviewSide !== side) {
			this.setSplitPreviewSide(side);
			// Re-activate the previously closed / empty side so the drop has a
			// real target to land on. `ensureSideInSplit` is a no-op when the
			// side is already in the split - and while the side is
			// height-maximized it is already on screen in its own grid column.
			this.ensureSideInSplit(side);
		}
	}

	private onSplitDragOver(e: DragEvent): void {
		const side = this.getSplitTargetSide(e);
		if (side === undefined) {
			// IMPORTANT: do NOT clear the split preview here when the pointer is
			// over the *filled* sibling side. Clearing on every `dragover` that
			// lands on the filled half made the empty half add/remove from the
			// SplitView as the pointer crossed the boundary, which flashed both
			// Panel areas continuously while dragging a view over the dual-panel
			// layout. The preview stays sticky until the pointer genuinely leaves
			// the Panel (`dragleave`) or a real drop occurs, which collapses it
			// cleanly.
			return;
		}
		// Stop propagation so the side's own empty-pane handler (which would
		// otherwise move the view into the single Panel) does not also run.
		// `preventDefault` is required for the drop to fire.
		EventHelper.stop(e, true);
		// Same stability guard as `onSplitDragEnter`.
		if (this.splitPreviewSide !== side) {
			this.setSplitPreviewSide(side);
			this.ensureSideInSplit(side);
		}
	}

	private onSplitDragLeave(e: DragEvent): void {
		// A dragleave fires when leaving the whole Panel area. Only clear the
		// preview if we are actually leaving it, not when moving between the
		// Panel strip and a height-maximized side column (or between two sides).
		//
		// IMPORTANT: `e.relatedTarget` is `null` in many browsers while the
		// pointer is still *inside* the Panel (e.g. when it moves over a child
		// element the browser does not report, or over the `panel-split-preview`
		// overlay / empty-pane hint). Treating `null` as "left the Panel" made
		// every internal `dragleave` cancel the split preview ->
		// `clearSplitPreview()` -> `removeRightFromSplit()`, and the very next
		// `dragenter` re-added the side - an add/remove ping-pong that made both
		// Panel areas flash until the drop ended. So we only clear when
		// `relatedTarget` is a real element that lives OUTSIDE every Panel drop
		// root. A `null` target means "still inside" and leaves the preview (and
		// the split) intact. Leaving the window / dropping is cleaned up by the
		// `dragend` / `drop` handlers, which always run.
		if (e.relatedTarget && !this.isInsidePanelDropArea(e.relatedTarget as Node)) {
			this.endDragState();
		}
	}

	private onSplitDrop(e: DragEvent): void {
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
		// whose dnd pipeline routes the move through `movePaneCompositeToSide`
		// -> `clearActivePaneComposite` + `unpinPaneComposite` on the source,
		// guaranteeing the source is cleared. This covers BOTH the empty-target
		// and the non-empty-target cases.
		const sourceSide = this.dragSourceSide;
		const dropSide = this.resolveSideByPosition(e);
		if (sourceSide && dropSide && sourceSide !== dropSide) {
			EventHelper.stop(e, true);
			const targetPart = this.getSidePart(dropSide);
			targetPart.handleEmptyAreaDrop(e, this.buildSplitDragData(e));
			// The drop ended either way: reset the drag state now (the observer's
			// dragend is unreliable for cross-side drags and would otherwise
			// leave `isDragInProgress` stuck true).
			this.endDragState();
			// Clean up any stale ViewPaneDropOverlay that the target side's
			// ViewPaneContainer created during onDragEnter
			// (isSinglePaneContainer branch). Because we stopped propagation in
			// the capture phase, the target's onDrop never fires and the overlay
			// is never disposed - leaving a visible
			// PANEL_SECTION_DRAG_AND_DROP_BACKGROUND rectangle that looks like a
			// "dark patch" over the content area. Remove it by ID and class.
			targetPart.sideElement.querySelectorAll('#monaco-pane-drop-overlay').forEach(el => el.remove());
			targetPart.sideElement.querySelectorAll('.dragged-over').forEach(el => el.classList.remove('dragged-over'));
			return;
		}

		// Resolve the *actual* target side from the cursor position rather than
		// the stale `splitPreviewSide`. This is what makes the sticky preview
		// (see `onSplitDragOver`) safe: while the pointer was hovering the empty
		// half the preview was active, but the user may have moved onto the
		// filled sibling before releasing - in that case the drop must be
		// handled by that side, not forced onto the empty half.
		const side = this.getSplitTargetSide(e);
		if (side === undefined) {
			// The drop landed on the filled sibling side (or outside the empty
			// half). We do NOT stop propagation, so the side's own handler (the
			// ViewPaneContainer for a side that already hosts a view) processes
			// the drop normally. We only collapse the sticky empty-side preview
			// we may have been showing so it does not linger as a permanent
			// empty panel after the drop.
			if (this.splitPreviewSide !== undefined) {
				this.clearSplitPreview();
			}
			return;
		}
		// Delegate the actual drop to the targeted side's own dnd handler,
		// which understands drags from every Panel-internal source (the dragged
		// view/composite id is carried on the shared `LocalSelectionTransfer`,
		// so `buildSplitDragData` always resolves it for VS Code-internal
		// drags). `handleEmptyAreaDrop` already calls `EventHelper.stop`
		// internally before performing the move, so the other side will not also
		// handle this drop.
		EventHelper.stop(e, true);
		const targetPart = this.getSidePart(side);
		targetPart.handleEmptyAreaDrop(e, this.buildSplitDragData(e));
		// The drop ended. The async move (`movePaneCompositeToSide` ->
		// `openPaneComposite`) will apply the real layout via
		// `onDidPaneCompositeOpen -> updateSideVisibility`. Reset the drag state
		// here so `isDragInProgress` does not stay stuck true and no empty 150px
		// placeholder panel is left behind.
		this.endDragState();
	}

	/**
	 * Keep the drop-preview classes in sync with `splitPreviewSide`.
	 *
	 * The marker is set on the *side element* (not only on the split container)
	 * because a height-maximized side is re-parented out of `.part.panel` into
	 * its own workbench grid column, where the container-anchored
	 * `.panel-split.panel-split-preview` CSS rule can no longer match it.
	 */
	private setSplitPreviewSide(side: PanelSide | undefined): void {
		this.splitPreviewSide = side;
		this.applySplitPreviewClasses();
	}

	private applySplitPreviewClasses(): void {
		if (!this.splitContainer || !this.leftPart || !this.rightPart) {
			return;
		}
		this.splitContainer.classList.toggle('panel-split-preview', this.splitPreviewSide !== undefined);
		this.leftPart.sideElement.classList.toggle('panel-side-drop-preview', this.splitPreviewSide === 'left');
		this.rightPart.sideElement.classList.toggle('panel-side-drop-preview', this.splitPreviewSide === 'right');
	}

	/**
	 * Re-activate the given side so it becomes a drop target inside the split.
	 * The left side is always present in the split (collapsed to zero width when
	 * hidden), so we only need to clear its hidden state and re-layout. The right
	 * side is added to the split lazily, so we also call `addRightToSplit`.
	 */
	private ensureSideInSplit(side: PanelSide): void {
		if (this.fullHeightSides.has(side)) {
			return;
		}
		this.showSide(side);
		if (side === 'right') {
			this.addRightToSplit();
		} else {
			// Left is always in the split (index 0); just re-apply its layout.
			this.updateSideVisibility();
		}
		if (this.panelStripCollapsed) {
			this.updatePanelStripForFullHeight();
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
	private buildSplitDragData(_e: DragEvent): CompositeDragAndDropData {
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

	private endDragState(): void {
		this.isDragInProgress = false;
		this.splitPreviewSide = undefined;
		this.splitContainer.classList.remove('panel-split-preview');
		this.dragEndFallbackScheduler.cancel();
		this.updateSideVisibility();
		this.emptyPanelCheckScheduler.schedule();
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
