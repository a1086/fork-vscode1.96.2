/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/panelpart.css';
import { ActivePanelContext, PanelFocusContext, PanelLeftFocusContext, PanelLeftMaximizedContext, PanelRightFocusContext, PanelRightMaximizedContext, ExtensionLayoutContextKey, PanelMaximizeHiddenLayoutKeys } from '../../../common/contextkeys.js';
import { IWorkbenchLayoutService, Parts, Position, positionToString } from '../../../services/layout/browser/layoutService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { PANEL_BACKGROUND, PANEL_BORDER, PANEL_TITLE_BORDER } from '../../../common/theme.js';
import { contrastBorder } from '../../../../platform/theme/common/colorRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Dimension, $, isAncestor, addDisposableListener, EventType, EventHelper, getWindow } from '../../../../base/browser/dom.js';
import { assertIsDefined } from '../../../../base/common/types.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { TERMINAL_VIEW_ID } from '../../../contrib/terminal/common/terminal.js';
import { DEBUG_PANEL_ID } from '../../../contrib/debug/common/debug.js';
import { WebviewViewPane } from '../../../contrib/webviewView/browser/webviewViewPane.js';
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
import { CompositeDragAndDropObserver, CompositeDragAndDropData, DraggedCompositeIdentifier, DraggedViewIdentifier } from '../../dnd.js';
import { isSuppressPanelRelayoutOnDragOut, onSuppressPanelRelayoutOnDragOutChange, setViewDragOutPanelSide, getViewDragOutPanelSideForView, setViewDragOutPanelSideForView } from '../viewDragSession.js';
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
	 * Hard-coded list of Panel views to always show (in left-to-right order). When packaged and distributed to other users,
	 * the initially opened editor Panel shows only the views listed here as tabs (single column by default).
	 * To add/remove the default views later, just edit this array; no other logic needs changing.
	 * Currently it is the TERMINAL + DEBUG CONSOLE tabs; when the user later drags a view to the other side
	 * it can automatically expand into left/right two columns (drag capability is retained, see `registerSplitDropTarget`).
	 */
	private static readonly PINNED_PANEL_VIEWS: readonly string[] = [TERMINAL_VIEW_ID, DEBUG_PANEL_ID];

	private static readonly ALLOWED_PANEL_EXTENSION_IDS: readonly string[] = ['AccoTEST.ate-tool-ext'];

	/**
	 * Allow by container id prefix (a second safeguard on top of the extensionId allow-list).
	 *
	 * Note: a container id declared by an extension in `viewsContainers` (e.g. `panel-view-container`) is composed by
	 * `viewsExtensionPoint.ts#registerCustomViewContainers` into the real container id
	 * `workbench.view.extension.<descriptor.id>`, so the prefix must include
	 * the `workbench.view.extension.` segment, otherwise it will never match.
	 */
	private static readonly ALLOWED_PANEL_CONTAINER_ID_PREFIXES: readonly string[] = ['workbench.view.extension.panel-'];

	/**
	 * Determine whether a Panel container is an "allowed custom extension container": it matches the extensionId allow-list,
	 * or the container id matches the prefix allow-list; true if either matches.
	 *
	 * An allowed container gets two privileges:
	 *   1) `hideOtherPanelViews()` does not `setVisible(false)` or `unpin` its views;
	 *   2) `pinAllowedPanelContainers()` actively `pin`s it, offsetting the "unpin as soon as registered" caused by
	 *      `panelSidePart`'s `pinNewCompositesOnRegister: false`.
	 */
	public static isAllowedPanelContainer(containerId: string, extensionIdValue?: string): boolean {
		const allowedExtensionIds = PanelPart.ALLOWED_PANEL_EXTENSION_IDS.map(id => id.toLowerCase());
		if (extensionIdValue && allowedExtensionIds.includes(extensionIdValue.toLowerCase())) {
			return true;
		}
		return PanelPart.ALLOWED_PANEL_CONTAINER_ID_PREFIXES.some(prefix => containerId.startsWith(prefix));
	}

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
	 * container from this set - never a container the user has never opened
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
	 * The empty-Panel check (collapse an empty side / hide the whole Panel) is deferred to the next tick. Reason: when switching
	 * views, `onDidPaneCompositeClose` is dispatched synchronously first (at which point `activeContainerBySide`
	 * is briefly cleared), immediately followed by the asynchronous `onDidPaneCompositeOpen`. If we hid the whole Panel at the synchronous
	 * instant of close, the active would be gone before open could write it back -- showing as
	 * "clicking a view makes the whole Panel disappear". After one frame, if open has restored the active, the check
	 * naturally does not trigger; only if it is truly empty after a frame do we collapse/hide.
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
	 * forever and `autoHidePanelIfEmpty` would keep bailing - leaving an empty
	 * Panel visible. This scheduler resets the flag a little after the close
	 * that emptied a side, so the empty-Panel auto-hide can finally run. It is
	 * guarded by `isDragInProgress` so a normal drag (whose `onDragEnd` already
	 * cleared the flag) is a no-op and never interferes with drag hit-testing.
	 */
	private readonly dragEndFallbackScheduler = new RunOnceScheduler(() => {
		if (!this.isDragInProgress) {
			return;
		}
		this.endDragState();
		this.updatePanelVisibility();
	}, 250);
	private lastDragOverTime = 0;
	private readonly dragOverWatchdog = this._register(new RunOnceScheduler(() => {
		if (!this.isDragInProgress) {
			return;
		}
		if (Date.now() - this.lastDragOverTime > 1000) {
			this.endDragState();
			return;
		}
		this.dragOverWatchdog.schedule();
	}, 1000));
	/**
	 * Final convergence point for the initialization "ensure the first view works" step. See the comment on
	 * `scheduleInitialEnsureWorking`: it merges the two racy bare calls scattered across `restore().then()` and
	 * `whenInstalledExtensionsRegistered().then()` into a single deterministic point after both
	 * "layout ready + extensions ready" complete, eradicating the Panel initialization issue of "sometimes works, sometimes stuck at 'Drag a view here'".
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
	private isRestoringFromEditor = false;
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
	 * `leftActive`/`rightActive` from the previous storage entry - only during
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
	 * is what guarantees that toggling the Panel off and on - possibly many
	 * times - always restores the exact same views in the exact same number of
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
		// is appropriate - a normal user-driven save after a cross-side move
		// must NOT bring back the container the user just moved out.
		const prior = this.loadDualPanelLayout();
		let leftActive: string | undefined = this.activeContainerBySide.get('left');
		let rightActive: string | undefined = this.activeContainerBySide.get('right');
		// Fallback: when one side's active is temporarily empty in memory (e.g. the dynamic merged container
		// `workbench.views.service.panel.<uuid>` where Terminal lives was momentarily cleared by a view state change, or a
		// transitional close event triggered this save), but storage still records a valid previous container for that side,
		// and that side was not explicitly closed by the user (not in `hiddenSides`, and the right column is still in the split),
		// then reuse the valid value from storage and do **not** write active as `undefined` and pollute the snapshot.
		//
		// Otherwise a single "transitional close" would wipe `leftActive` to undefined and persist it; the next
		// Toggle Panel's `capturingLayout` fallback would then read the already-polluted undefined, and the
		// column containing Terminal would be permanently lost.
		//
		// Note: `hideSide` / an explicit user close adds the side to `hiddenSides` first; in that case we
		// respect the user's intent and allow active to be written as empty, skipping this fallback.
		if (!leftActive && prior?.leftActive && !this.hiddenSides.has('left')) {
			leftActive = prior.leftActive;
		}
		if (!rightActive && prior?.rightActive && this.rightViewInSplit && !this.hiddenSides.has('right')) {
			rightActive = prior.rightActive;
		}
		if (this.capturingLayout) {
			// Pre-hide snapshot: even if the fallback above already handled normal saves, add one more layer here to ensure
			// the right-column container is not lost when `rightViewInSplit` is consistent with prior (existing logic retained).
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
	 * with no meaningful right container - or with the same container as the left
	 * side - would otherwise make a single-area Panel sprout an empty right half
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
	 * extensions - and thus dynamically-registered views such as Ports - are
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
		this.updateSideMaximizedContextKeys();
		this.registerLayoutMaximizeRestore(contextKeyService);
	}

	private registerLayoutMaximizeRestore(contextKeyService: IContextKeyService): void {
		const watchedKeys = new Set([ExtensionLayoutContextKey]);
		this._register(contextKeyService.onDidChangeContext(e => {
			if (!e.affectsSome(watchedKeys)) {
				return;
			}
			const layout = contextKeyService.getContextKeyValue<string>(ExtensionLayoutContextKey);
			if (typeof layout !== 'string' || !PanelMaximizeHiddenLayoutKeys.includes(layout)) {
				return;
			}
			for (const side of [...this.fullHeightSides]) {
				this.exitSideFullHeight(side);
			}
			if (this.layoutService.isPanelMaximized()) {
				this.layoutService.toggleMaximizedPanel();
			}
			this.updateSideMaximizedContextKeys();
		}));
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

			// After a container leaves this side due to mutual exclusion clearing / dragging, if this side now has no
			// active composite (i.e. it fell into the blank "Drag a view here" placeholder), automatically pick the "leftmost first"
			// available container from the Panel position and re-open it on this side, so this Panel part always has
			// a working view.
			//
			// Two exclusions:
			// 1. The user actively clicked this side's close button (`hideSide`) -- the side was already added to `hiddenSides`;
			// 2. A cross-side whole-container drag (`movePaneCompositeToSide`) is in progress -- it picks the next view for
			//    the source side itself, so we must not compete here.
			// 3. A view is being dragged out to a standalone window (`isSuppressPanelRelayoutOnDragOut`) -- the side
			//    becoming an empty drop target is the expected result of "the view has been dragged away"; a fallback re-opening another
			//    container here would make the Panel flash another view out of blankness, which is exactly the source of the "Panel flashes when dragging out".
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
			// user-driven -- it is a side effect of init. Including the just-closed
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
					// never asked for them -- see `openedContainersBySide`.
					(openedOnSide?.has(c.id) ?? false) &&
					this.panelViewDescriptorService.getViewContainerModel(c).activeViewDescriptors.length > 0 &&
					// Key: the fallback container must not share any view with the other side's currently active container, otherwise opening it
					// would trigger `releaseOtherSideIfViewOverlap` to clear the other side in reverse (the side just dragged into),
					// causing the two Panels to repeatedly clear/reopen in a thrashing loop. Mutual exclusion is guaranteed by the gate inside `openPaneComposite`;
					// here we exclude conflicting containers in advance so the fallback
					// is always safe.
					!this.containersShareViewOnSide(c.id, side))
				.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
			if (fallback) {
				// Do not skip the mutual-exclusion check: the fallback container may share a view with the other side's current container, so it must go through
				// `releaseOtherSideIfViewOverlap` to clear the other side synchronously before opening; otherwise the same view would be shown on both left and right sides,
				// causing the same view to appear twice in the title bar (two highlights) or blank content.
				// `skipMaximizeOnShow=true` because this is automatic compensation inside a side and should not trigger the Panel's
				// auto-maximize; `skipExclusion=false` forces the mutual-exclusion gate.
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
			// open event proves the default view is genuinely active - drop the
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
			// skipped - the right panel is lost. (suppressLayoutSave guards this
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

			// View-level mutual exclusion: the same view must not be shown on both left and right sides at once. All "normal" open paths
			// (user click, drag, fallback after close) clear the other side synchronously via `releaseOtherSideIfViewOverlap` in `openPaneComposite` before opening;
			// after restore, `enforceViewUniquenessAfterRestore` is the fallback. But some drag/view-merge paths may
			// bypass the mutual-exclusion gate (e.g. dropping a view onto a container that already exists on this side, or a side effect of a
			// cross-location move opening it), leaving this side's opened container sharing a view with the other side. As a last line of
			// defense: if sharing is detected, clear the other side, ensuring the "view uniqueness" invariant holds on any path.
			// Clearing the other side triggers its `onDidPaneCompositeClose` -> fallback, and the fallback already
			// excludes conflicting containers via `containersShareViewOnSide`, so it will not clear this side in reverse.
			// Therefore no loop occurs.
			const otherSide: PanelSide = side === 'left' ? 'right' : 'left';
			const otherPart = this.getOtherSidePart(side);
			const otherActiveId = otherPart.getActivePaneComposite()?.getId();
			const otherVisibleIds = otherPart.getVisiblePaneCompositeIds();
			if (openedId && otherActiveId === openedId) {
				// The same container is active on both left and right sides at once: keep this side (the side the user dragged into),
				// and clear the copy on the other side.
				this.clearAndUnpinSide(otherSide);
			} else if (openedId && otherVisibleIds.includes(openedId)) {
				// The other side only shows the same container as a pinned tab (not active), while this side
				// has just activated it (typical scenario: the left column initially pinned DEBUG CONSOLE, and the user dragged it
				// to the right column and activated it). Single-container ownership requires it not to appear on both sides at once, so only unpin
				// that tab on the other side, rather than clearing the whole side (to avoid harming the other side's other views).
				otherPart.unpinPaneComposite(openedId);
				otherPart.refreshCompositeBar();
			} else if (openedId && otherVisibleIds.some(id => this.containersShareView(openedId, id))) {
				// "The other side's pinned tab shares a view with the container this side just activated (e.g. this side activated
				// VARIABLES in the debug container while the left column still pins a tab of the same debug container
				// `workbench.panel.repl`). Single-container ownership requires it not to appear on both sides at once,
				// so unpin every pinned tab on the other side that shares a view with it, one by one.
				for (const id of otherVisibleIds) {
					if (this.containersShareView(openedId, id)) {
						otherPart.unpinPaneComposite(id);
					}
				}
				otherPart.refreshCompositeBar();
			} else if (openedId && otherActiveId && this.containersShareView(openedId, otherActiveId)) {
				this.clearAndUnpinSide(otherSide);
			} else {
				// When there is no conflict, only refresh the bar's disabled/enabled visual feedback (aligned with `isCompositeEnabled`).
				otherPart.updateCompositeEnabledStates();
			}
			this.updatePanelMinimumHeight();

			// After splitting into two columns, this side's container was just opened/switched: ensure the "leftmost first view" inside the container
			// is in a working state (expanded and visible). See PanelSidePart.ensureFirstViewWorking.
			sidePart.ensureFirstViewWorking();
		}));
		this._register(sidePart.onDidPaneCompositeClose(e => {
			if (this.activeContainerBySide.get(side) === e.getId()) {
				this.lastActiveSideByContainer.set(e.getId(), side);
				// BUG FIX: when dragging out to a standalone window / cross-location moving, the close event actually means
				// "a view was removed from the container", but **the whole container may still be alive** (there are still other
				// residual views in the Panel). Deleting here directly would misjudge a container that still has views as empty, making
				// activeContainerBySide empty -> autoHidePanelIfEmpty hides the whole Panel.
				// So before deleting, first confirm whether the container truly has no visible views: if there are residual views, keep the registration and skip the
				// fallback, the container keeps showing normally and the Panel is not wrongly hidden.
				const closingContainer = this.panelViewDescriptorService.getViewContainerById(e.getId());
				const closingModel = closingContainer ? this.panelViewDescriptorService.getViewContainerModel(closingContainer) : undefined;
				const containerStillHasViews = !!closingModel
					&& closingModel.activeViewDescriptors.length > 0;
				const containerStillVisibleViews = !!closingModel
					&& closingModel.visibleViewDescriptors.length > 0;
				if (containerStillHasViews) {
					// The container clearly still has visible views yet received a close (typical: after dragging away another container, this side
					// switched to this container, but a race between its view descriptor add/remove events triggered a spurious close,
					// making the content area briefly disappear). Here we do not delete the registration, and if the container currently has no
					// active view we re-activate it to bring the content back, avoiding the Panel showing an empty placeholder.
					// Re-open only during the drag-out-to-window cleanup (suppress is true): at that point this side is
					// switching from "a container was dragged away" to the next container, and re-open can bring back the wrongly-closed container.
					// On restore (closing a standalone window moves the view back to the original bar) suppress is false, so this branch is not
					// taken, avoiding racing with the normal open flow and causing two containers to be highlighted at once.
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

				// BUG FIX: a single-column (or one side) Panel can contain multiple containers (e.g. DEBUG CONSOLE +
				// Terminal). After dragging away the current active container (the whole container is moved to a standalone window), this side's
				// active is deleted and activeContainerBySide becomes empty, but the Panel **still has other visible
				// containers**. In this case we should not let the Panel fall into the empty state and be hidden by autoHide; instead we should immediately activate another
				// container as this side's new active, ensuring the Panel always shows the views that still exist.
				// Note: the fallback candidate set is filtered by `openedContainersBySide`, which may exclude default containers such as
				// DEBUG CONSOLE that were never explicitly recorded, causing the fallback to find nothing and the Panel to be
				// wrongly hidden. So here we directly select another container in the Panel that still "has visible views", with higher priority than
				// the fallback.
				// We must filter with `activeViewDescriptors.length > 0` rather than only
				// `getVisiblePaneCompositeIds()` -- the latter includes empty container tabs (e.g. the DEBUG CONSOLE container
				// workbench.panel.repl with no debug session), and opening such an empty container
				// will close again because it has no visible views, leaving only "Drag a view here" in the content area.
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

				// When the whole Panel is being hidden (Toggle Panel / Ctrl+J), do not schedule a "fallback re-open" for this close.
				// Otherwise, after the hide completes (setTimeout 0), the fallback would re-open some container back onto the side that was just
				// cleared, polluting activeContainerBySide and triggering a wrong
				// save, causing the right column state to become corrupted or even disappear on the next Toggle.
				if (this.hidingEntirePanel) {
					return;
				}

				// The fallback logic is deferred to the next frame: a synchronous close event may occur during a normal container switch
				// (before the new composite has setActive); opening immediately would cause two containers to contend for
				// the same side, producing anomalies such as "two titles highlighted at once" and "the content area still shows Drag a view here".
				// If an open is triggered later in the same frame, the scheduler above is canceled.
				this.lastClosedContainerBySide.set(side, e.getId());
				this.lastDismissedContainerBySide.set(side, e.getId());
				fallbackScheduler.schedule();

				// When a view is dragged away (cross-side / out to a window) the observer may not dispatch dragend,
				// leaving isDragInProgress stuck at true, so autoHidePanelIfEmpty keeps bailing.
				// Schedule a somewhat longer fallback: if the flag still has not been reset by a normal dragend by then, reset it here and
				// trigger the whole-Panel empty check (autoHidePanelIfEmpty). A normal drag's dragend has already reset it first,
				// so this is skipped by the guard and does not interfere with drag hit-testing.
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
				// An empty side (no active view container) should be hidden rather than showing the "Drag a view here"
				// placeholder. Set the minimum width to 0 so SplitView can fully collapse it.
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
	 * but the dual feature is active and the per-side actions - in particular
	 * the "Restore <side> Panel Size" button on the lifted side - must keep
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
	 * Hard-code Panel content: apart from the views listed in `PINNED_PANEL_VIEWS`, hide all other view containers'
	 * tabs in the Panel area (Output, Problems, Test, Ports, etc.). When packaged and distributed to other
	 * users, the initially opened editor shows only the pinned views' tabs (single column). Do two things:
	 *   1) make every view inside a non-pinned container invisible (via `ViewContainerModel.setVisible`),
	 *      to avoid it being active by default;
	 *   2) `unpin` non-pinned containers from both bars so their tabs no longer appear in the initial composite bar.
	 * Neither affects the view registration system; the user can still drag any view into the current Panel (dragging to the other side
	 * triggers left/right two columns, see `registerSplitDropTarget`).
	 *
	 * Allow rules (matching any one skips):
	 *  - the container id is in `PINNED_PANEL_VIEWS` (Terminal / Debug Console);
	 *  - the container's extensionId is in the allow-list `ALLOWED_PANEL_EXTENSION_IDS`;
	 *  - the container id starts with a prefix in `ALLOWED_PANEL_CONTAINER_ID_PREFIXES` (e.g. panel-view-container).
	 */
	private hideOtherPanelViews(): void {
		const pinnedIds = new Set<string>(PanelPart.PINNED_PANEL_VIEWS);
		const containers = this.panelViewDescriptorService.getViewContainersByLocation(ViewContainerLocation.Panel);
		for (const container of containers) {
			if (pinnedIds.has(container.id)) {
				continue;
			}
			if (PanelPart.isAllowedPanelContainer(container.id, container.extensionId?.value)) {
				// Debug log: confirm the allow rule hit; can be removed once stable.
				console.log('[PanelPart.hideOtherPanelViews] skip allowed container:', container.id, 'extensionId=', container.extensionId?.value);
				continue;
			}
			const model = this.panelViewDescriptorService.getViewContainerModel(container);
			for (const descriptor of model.activeViewDescriptors) {
				if (!pinnedIds.has(descriptor.id) && model.isVisible(descriptor.id)) {
					model.setVisible(descriptor.id, false);
				}
			}
			// Unpin from both bars, hiding their tabs (the initial single column shows only pinned views).
			this.leftPart?.unpinPaneComposite(container.id);
			this.rightPart?.unpinPaneComposite(container.id);
		}
	}

	/**
	 * Explicitly pin an allowed custom extension Panel container to the left bar, restoring its tab.
	 *
	 * [Root cause] `panelSidePart.ts#getCompositeBarOptions` sets
	 * `pinNewCompositesOnRegister: false` (both sides of the two-column layout share the Panel location,
	 * avoiding a container being auto-pinned to the other side). So `paneCompositeBar.ts#onDidRegisterViewContainers`
	 * executes `compositeBar.unpin(id)` for every new container **at registration time**. Once an extension-contributed Panel container
	 * registers successfully, its tab is immediately unpinned -> only Terminal / Debug Console remain in the UI (those two are
	 * explicitly `pinPaneComposite`d in `create()`).
	 *
	 * This is why only adding the `hideOtherPanelViews` allow-list does not work: there we merely "no longer actively unpin",
	 * but the container was already unpinned at the registration stage, making the allow-list a no-op. Pinning once more here is the key.
	 *
	 * Note: pinning only makes a container "eligible to show", it does not force it to show. These containers' descriptors have
	 * `hideIfEmpty: true` (see `viewsExtensionPoint.ts#registerCustomViewContainer`),
	 * so `paneCompositeBar.ts#showOrHideViewContainer` still decides tab visibility by
	 * `isViewContainerActive()` (i.e. whether the view's `when` is satisfied) --
	 * the tab appears only after the button toggles the context key, which is exactly the dynamic effect the extension wants.
	 */
	private pinAllowedPanelContainers(): void {
		const containers = this.panelViewDescriptorService.getViewContainersByLocation(ViewContainerLocation.Panel);
		for (const container of containers) {
			if (!PanelPart.isAllowedPanelContainer(container.id, container.extensionId?.value)) {
				continue;
			}
			console.log('[PanelPart.pinAllowedPanelContainers] pin container:', container.id);
			this.leftPart?.pinPaneComposite(container.id);
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

		this._register(addDisposableListener(getWindow(this.element), EventType.DRAG_OVER, () => {
			this.lastDragOverTime = Date.now();
		}, true));

		// Install the drag-to-split drop targets. The listeners are bound to
		// `splitContainer` plus every height-maximized side element (see
		// `refreshSplitDropTargets`), so the left/right drop hot zone also works
		// while a side is maximized - a maximized side is re-parented out of
		// `splitContainer` and would otherwise no longer receive the drag.
		this.registerSplitDropTarget();

		// Track drag source side so the two sides can drop composites onto
		// each other even though they share the same ViewContainerLocation.
		this._register(CompositeDragAndDropObserver.INSTANCE.onDragStart(e => {
			// If the previous drag-out (to Editor/window/side bar) did not dispatch dragend, isDragInProgress
			// may be stuck at true and interfere with this round's drag decision; reset it before starting a new drag.
			if (this.isDragInProgress) {
				this.isDragInProgress = false;
			}
			this.isDragInProgress = true;
			this.lastDragOverTime = Date.now();
			this.dragOverWatchdog.schedule();
			this.clearStaleDropOverlays();
			// If the whole Panel was hidden because it was dragged empty when a drag starts, temporarily show it again as an empty hot zone,
			// otherwise the container has no layout size, getSplitTargetSide always returns undefined, and the hot zone cannot be summoned.
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
			setViewDragOutPanelSide(this.dragSourceSide);
			if (this.dragSourceSide) {
				const dragSourceActiveId = this.activeContainerBySide.get(this.dragSourceSide);
				if (dragSourceActiveId) {
					this.lastActiveSideByContainer.set(dragSourceActiveId, this.dragSourceSide);
				}
			}
		}));
		this._register(CompositeDragAndDropObserver.INSTANCE.onDragEnd(() => {
			this.dragOverWatchdog.cancel();
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
				// plain `setPanelHidden(true)` path - `autoHidePanelIfEmpty` is not
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
					// The right side must never be permanently hidden: historically, if some `hideSide('right')` call wrote it into
					// `hiddenSides` (a bug in the old logic), we actively remove `right` here to prevent it from forever
					// blocking the rebuild of the right side. The left side's permanent-hide intent (`hiddenSides` contains `left`) is preserved.
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
					// But we must pre-check: if the persisted containers on both sides share the same view (e.g. OUTPUT and
					// DEBUG CONSOLE both contain TERMINAL), we skip opening the right side and clear its persisted key,
					// fixing the "same view shown on both sides after Toggle Panel" bug at the write side.
					let rightToOpen = savedLayout.rightActive;
					const leftToOpen = savedLayout.leftActive;
					if (rightToOpen && leftToOpen && this.containersShareView(leftToOpen, rightToOpen)) {
						// Only a *different* container that shares a view with the left side
						// is a genuine mutual-exclusion conflict (showing the same view twice).
						// A *same-container* split is intentional (e.g. two Terminals) and is
						// now permitted - `containersShareView` returns false for `a === b`,
						// so this branch no longer wipes the right panel for that case.
						this.storageService.remove(PanelSidePart.activePanelSettingsKeyFor('right'), StorageScope.WORKSPACE);
						rightToOpen = undefined;
					}
					// When the persisted right container can't be opened (it was cleared
					// above, or `savedLayout.rightActive` was empty), the dual layout must
					// collapse to a single panel - otherwise the right side would re-appear
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
					// Before reopening the right side, run the mutual-exclusion check again using the left side's *actually* active container,
					// because the left open above may have changed the left side's state (or layout.ts's open
					// may have already set up the left container).
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
						// user action and must NOT be wiped - both sides are independent
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
			console.log('VP');
			this.updateSideMaximizedContextKeys();
			panelWasVisible = isVisibleNow;
		}));

		// Initial single-column layout: the Panel opens as a single column showing only the views listed in `PINNED_PANEL_VIEWS`
		// as tabs (TERMINAL active by default, DEBUG CONSOLE as another tab).
		// The tabs of the remaining Panel views (PROBLEMS/OUTPUT/TEST/PORTS, etc.) are
		// unpinned by `hideOtherPanelViews` on the left bar, so only the pinned views are visible initially.
		//
		// The dual-column layout (left and right Panels) is not forced open initially-only when the user drags a view onto the Panel's
		// other side does `registerSplitDropTarget` lazily create the right column. This satisfies the "initial
		// single column shows only two tabs" requirement while fully preserving the drag-to-split capability.
		//
		// Note: we ignore the persisted left/right active containers and hard-code the initial layout, ensuring that in builds
		// shipped to other users the Panel always opens as a single column with the pinned views. To add a view shown by default later,
		// simply add its id to the `PINNED_PANEL_VIEWS` array.
		this.hideOtherPanelViews();

		// Extensions may register / move a container into the Panel after initialization (e.g. deferred extension activation). For these "late"
		// allowed containers we also pin them once, so their tab does not disappear forever due to "unpin-on-register".
		this._register(this.panelViewDescriptorService.onDidChangeViewContainers(({ added }) => {
			for (const { container, location } of added) {
				if (location === ViewContainerLocation.Panel
					&& PanelPart.isAllowedPanelContainer(container.id, container.extensionId?.value)) {
					this.pinAllowedPanelContainers();
					break;
				}
			}
		}));

		// Sanitize any stale `dualLayout` snapshot from a previous session/older
		// build. A persisted `rightInSplit: true` with no meaningful right-side
		// container (or where left and right point at the *same* container) would
		// otherwise make a fresh "single-area" Panel sprout an empty right half
		// the very first time Toggle Panel is pressed. We only fix obviously-bad
		// data so a legitimate two-panel layout the user actually uses is kept.
		this.sanitizeStoredDualLayout();

		const pinnedViews = PanelPart.PINNED_PANEL_VIEWS;
		this.leftPart.restore(pinnedViews[0]).then(() => {
			// Pin the remaining pinned views onto the left bar as tabs (without forcing them open, just showing the tab).
			// This makes the initial single column show TERMINAL + DEBUG CONSOLE tabs that the user can click to switch.
			for (let i = 1; i < pinnedViews.length; i++) {
				this.leftPart.pinPaneComposite(pinnedViews[i]);
			}
			// Note: do **not** directly call `ensureFirstViewWorking` / `relayoutSides` here.
			// `restore()` only opens the container after `layoutService.whenRestored`, and it guarantees neither
			// that extension views are registered (`whenInstalledExtensionsRegistered`), nor that the Panel
			// has been measured by `layout()` (`sideWidth/sideHeight` may still be 0). And
			// `ensureFirstViewWorking` relies on "the container being visible and the side size being non-zero" to actually expand the first view;
			// otherwise `openFirst()` returns immediately because it is invisible, and `relayoutSides` is skipped
			// because the size is zero. Whether these two are ready in the race window of `restore().then()` depends entirely
			// on the relative order of `whenRestored` and `whenInstalledExtensionsRegistered`,
			// and whether `layout()` has already run-which is exactly the root cause of "Panel working intermittently, occasionally stuck at
			// 'Drag a view here'". That is exactly the root cause; the real convergence is unified in
			// `scheduleInitialEnsureWorking()`, which runs only after both Promises complete.
		});

		// The **unified convergence point** for the initial "ensure first view is working".
		//
		// Merge the two previously scattered race-prone direct calls in `restore().then()` and `whenInstalledExtensionsRegistered().then()`
		// into a single deterministic point after "layout ready (whenRestored) + extensions ready
		// (whenInstalledExtensionsRegistered) both complete":
		//   - By this point the Panel has necessarily been measured by `layout()`, so `sideWidth/sideHeight`
		//     are guaranteed > 0, and `relayoutSides()` will no longer be skipped;
		//   - dynamically registered view descriptors (Ports, etc.) are all ready, so `allViewDescriptors`
		//     is no longer empty, and the first view expands and renders its body stably instead of being stuck at "Drag a view here".
		// Since the Frame is a `RunOnceScheduler(0)`, even if both Promises already resolved during `create()`
		// (the hot path), it only runs merged once in the next microtask, eliminating duplicate expansion / flicker.
		this.scheduleInitialEnsureWorking();

		// NOTE: `this.initialized` is intentionally NOT set here. It must only be
		// set once the default view(s) have actually been restored and the Panel
		// laid out - i.e. inside `runInitialEnsureWorking()`. `restore()` /
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

		this._register(this.panelViewDescriptorService.onDidChangeContainer(e => {
			WebviewViewPane.markMove(e.views.map(v => v.id));
		}));

		// After closing the dragged-out floating window (or closing that tab in the editor area), the view goes through
		// `ViewEditorInput`'s restore logic `moveViewToLocation(view, Panel)` and returns to
		// the `workbench.panel.*` container. But when dragged out, `moveViewToLocation(view, Editor)`
		// makes the container instantly empty, triggering `PanelSidePart.ensureFirstViewWorkingAfterRemoval`
		// which does `unpinPaneComposite` + `clearActivePaneComposite`, so Terminal/Output
		// single-view merged containers have their tab completely removed from the Panel bar. After the view is restored, the bar
		// is still in the unpinned state and the tab does not show → manifesting as "Terminal disappears directly after closing the window".
		//
		// Here we listen to `onDidChangeLocation`: when a view returns from the Editor area to a Panel container,
		// re-pin the container that was unpinned during the drag-out and open it back to the Panel side it originally belonged to
		// (preferring this process's remembered "last active side of that container", falling back to the persisted record when unknown),
		// so the tab reappears.
		// Only handle `from === Editor && to === Panel`, i.e. this workspace's "restore" action, to avoid conflicting with
		// the normal drop path of dragging a view into the Panel from the sidebar / auxiliary bar (already opened by PanelSidePart itself).
		this._register(this.panelViewDescriptorService.onDidChangeLocation(e => {
			if (e.to !== ViewContainerLocation.Panel || e.from !== ViewContainerLocation.Editor) {
				return;
			}

			// A restore action may bring back multiple views at once, and they may belong to the same container.
			// Run open serially per container, avoiding multiple async opens interleaving so that the mutual-exclusion gate
			// (`releaseOtherSideIfViewOverlap`) does not see the other side's latest active composite,
			// which would leave a race window where "the same view is shown on both left and right sides".
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

					// Restore to the original side: prefer the source side recorded at the moment of dragging out to a window (most reliable),
					// then the in-process memory of "the side this container was last active on", and finally fall back to the persisted record.
					// Note: after dragging out, the original generated container is recycled, so on restore it is a new container id;
					// therefore the source side must be recorded by view id (view ids are stable).
					const dragOutSide = getViewDragOutPanelSideForView(view.id)
						?? this.panelViewDescriptorService.getViewContainerModel(container).allViewDescriptors
							.map(d => getViewDragOutPanelSideForView(d.id)).find(s => s);
					const rememberedSide = dragOutSide ?? this.lastActiveSideByContainer.get(containerId);
					let targetSide: PanelSide;
					if (rememberedSide) {
						targetSide = rememberedSide;
					} else {
						// When there is no memory (e.g. first restore after a cross-session restart), fall back to the persisted record.
						const rightLastActive = this.storageService.get(PanelSidePart.activePanelSettingsKeyFor('right'), StorageScope.WORKSPACE, '');
						targetSide = rightLastActive === containerId ? 'right' : 'left';
					}

					// The container now appears on both sides at once: this is a duplicate caused by a persistence/timing anomaly,
					// so release the non-restore side and keep the restore side as the baseline.
					if (leftActiveId === containerId && rightActiveId === containerId) {
						this.clearAndUnpinSide(rememberedSide === 'right' ? 'left' : 'right');
						setViewDragOutPanelSideForView(view.id, undefined);
						continue;
					}

					// If active on only one side, skip the normal open, but still check for and clean up the duplicate on the other side.
					if (leftActiveId === containerId || rightActiveId === containerId) {
						const activeSide: PanelSide = leftActiveId === containerId ? 'left' : 'right';
						if (rememberedSide && activeSide !== rememberedSide) {
							this.ensureSideInSplit(rememberedSide);
							await this.movePaneCompositeToSide(containerId, rememberedSide);
							setViewDragOutPanelSideForView(view.id, undefined);
							continue;
						}
						const otherSide: PanelSide = activeSide === 'left' ? 'right' : 'left';
						const otherActiveId = this.getOtherSidePart(activeSide).getActivePaneComposite()?.getId();
						if (otherActiveId && this.containersShareView(containerId, otherActiveId)) {
							this.clearAndUnpinSide(otherSide);
						}
						setViewDragOutPanelSideForView(view.id, undefined);
						continue;
					}

					const targetPart = targetSide === 'left' ? this.leftPart : this.rightPart;

					// If the target side was previously closed or removed from the split (e.g. the user clicked right-side close after dragging out),
					// first add it back to the split, otherwise open would happen in an invisible side bar.


					// First pin to ensure the tab appears on the composite bar, then open to activate the container.
					// On restore we still go through the mutual-exclusion gate: if a view the container holds is already shown on the other side, we must first
					// clear the other side, otherwise the same view (e.g. Terminal) appears on both left and right sides at once.
					// `releaseOtherSideIfViewOverlap` checks synchronously before open and releases the conflicting side.
					await targetPart.pinPaneComposite(containerId);
					await targetPart.openPaneComposite(containerId, false, true /* skipMaximizeOnShow */, false /* skipExclusion */);
					targetPart.refreshCompositeBar();
					for (const d of this.panelViewDescriptorService.getViewContainerModel(container).allViewDescriptors) {
						setViewDragOutPanelSideForView(d.id, undefined);
					}
					setViewDragOutPanelSideForView(view.id, undefined);

					// Run the uniqueness fallback after each open, ensuring any duplicate produced by
					// concurrent/async paths is cleaned up immediately.
					this.enforceViewUniquenessAfterRestore();
				}
			};

			this.isRestoringFromEditor = true;
			openNext().then(() => {
				this.isRestoringFromEditor = false;
				// Final fallback after all restores complete: force-clear the right side, guaranteeing "the same view is not shown twice".
				this.enforceViewUniquenessAfterRestore();
			});
		}));


		// Register the drag target that turns the single-area Panel into a split
		// when the user drags a Panel view onto the empty right half.
		this.registerSplitDropTarget();

		// While a view is being dragged out to a standalone window, Panel re-layout is suppressed to avoid flicker. After suppression is lifted
		// we need to re-check whether the Panel is now empty and, if so, auto-hide the whole Panel.
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
	 * Scheduled at the single deterministic point after "layout ready + extensions ready" both complete, to uniformly run the initialization convergence
	 * (relayout + ensure first view working + invariant fallback). See `runInitialEnsureWorking` for details.
	 *
	 * Must be called once at the end of `create()` to trigger. Use `RunOnceScheduler(0)` to defer the actual execution
	 * to the next microtask: even if `whenRestored` and `whenInstalledExtensionsRegistered` already resolved
	 * during `create()`, it only runs merged once in the next frame, avoiding duplicate expansion / flicker.
	 */
	private scheduleInitialEnsureWorking(): void {
		// `restore()` already `await`s `whenRestored` internally and opened the Terminal container; here we additionally
		// wait for `whenInstalledExtensionsRegistered`; by this point the Panel has necessarily been `layout()`-measured
		// (sideWidth/sideHeight > 0), and the descriptors of dynamically registered views (Ports, etc.)
		// are all ready-exactly the guarantee missing from the previous two race-prone direct calls whose order was uncertain.
		Promise.all([
			this.layoutService.whenRestored,
			this.panelExtensionService.whenInstalledExtensionsRegistered(),
		]).then(() => {
			this.initialEnsureScheduler.schedule();
		});
	}

	/**
	 * The actual execution body of the initialization convergence. All logic for "ensuring the Panel initially has a working view" is centralized here:
	 *   1) `relayoutSides()` -- by now sideWidth/sideHeight are necessarily > 0, so it will no longer be skipped due to zero size
	 *      and the already-open composite body actually gets its size.
	 *   2) `ensureFirstViewWorking()` on the left/right sides -- by now the container is visible and the descriptor is ready,
	 *      so the first view expands and renders stably instead of being stuck at "Drag a view here to display".
	 *   3) `hideOtherPanelViews()` -- non-pinned view descriptors only exist after extensions are ready, so hiding
	 *      actually takes effect (fixing "other views still shown in the Panel after build").
	 *   4) `enforceViewUniquenessAfterRestore()` -- invariant fallback, the two sides must not show shared views.
	 *
	 * Note: steps 1-4 are synchronous, but they may trigger asynchronous close/open/fallback (e.g.
	 * the close+reopen of visibility restore, or the fallback reopen from `onDidPaneCompositeClose`).
	 * These async operations only settle in subsequent microtasks/frames, so step 2's `ensureFirstViewWorking`
	 * may run **before** the terminal is reopened by the fallback-resulting in a terminal tab whose body
	 * is not expanded ("Drag a view here to display"). Therefore the real "final ensure" is deferred to
	 * `finalizeInitialEnsureWorking`, which runs once more after all the async churn has settled.
	 */
	private runInitialEnsureWorking(): void {
		this.relayoutSides();
		this.hideOtherPanelViews();
		// Must be called after extension registration completes (only then do plugin containers appear in
		// `getViewContainersByLocation(Panel)`), to re-add the allowed containers that were "unpinned on registration" back to the tab.
		this.pinAllowedPanelContainers();
		this.leftPart.ensureFirstViewWorking();
		if (this.rightInSplit) {
			this.rightPart.ensureFirstViewWorking();
		}
		this.enforceViewUniquenessAfterRestore();

		// Mark the initialization closure as done so `onDidPaneCompositeOpen` may
		// start clearing `pendingInitialOpen`. But do NOT clear `pendingInitialOpen`
		// or set `initialized = true` yet - those are deferred to
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
	 * At this point the default view (TERMINAL) is in its final state - either it
	 * survived the churn or it was re-opened by fallback - and one last
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
			// empty container - if the container still has views (just none
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
			// Close the right column: just remove it from the split, and the Panel returns to a single column (left side fills).
			// **Key point**: the right column must not be permanently hidden-it is merely a split in the dual-column layout; when the user closes it
			// it only means "don't want the right column right now", and it should not be nailed into `hiddenSides` like the left column. Once
			// `right` is written into `hiddenSides`, the `!this.isSideHidden('right')` check in restore
			// will forever block the rebuild of the right column, causing the right column (along with its Problems view) to be
			// unrecoverable after every Toggle Panel, disappearing permanently.
			//
			// Therefore closing the right column does **not** add it to `hiddenSides`, only removing it from the split. This way, afterwards Toggle /
			// re-dragging a view in lets the right column reappear normally.
			this.removeRightFromSplit();
		} else {
			// Closing the left column (the baseline single-column Panel) = closing the entire Panel area, which is a "permanent user intent",
			// so it is added to `hiddenSides`, and restore skips rebuilding the left column based on it.
			this.hiddenSides.add(side);
			// The left side can never be removed (it is the baseline single-area
			// Panel), so we just collapse it via `updateSideVisibility`.
			this.updateSideVisibility();
		}
		// Persist so a later Toggle Panel off/on restores this exact layout.
		this.saveDualPanelLayout();
		this.updateSideMaximizedContextKeys();

		// If both sides are closed, automatically hide the entire empty Panel.
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
		// After the mutual-exclusion clear, if the entire Panel is empty, auto-hide it.
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
			return;
		}
		if (splitEmpty === this.panelStripCollapsed) {
			return;
		}
		const size = this.layoutService.getSize(Parts.PANEL_PART);
		if (splitEmpty) {
			this.collapsedPanelStripHeight = size.height;
			this.layoutService.setSize(Parts.PANEL_PART, { width: size.width, height: 0 });
			this.panelStripCollapsed = true;
		} else {
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
				getWindow(this.element).requestAnimationFrame(() => sidePart.layout(width, height, 0, 0));
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
	 * Cross-location dragging (dragging a view from the Sidebar / Auxiliary Bar / Activity Bar / Editor
	 * into a Panel side) proactively clears **the other side**'s all tabs that are "same id or share
	 * view" with it before opening the target container. This way, whether the dragged-in item is the container itself or a view inside it (e.g. dragging
	 * VARIABLES to the right column activates the debug container `workbench.panel.repl` together with DEBUG CONSOLE,
	 * while the left column has that container pinned by default), the other side will not retain a duplicate
	 * copy of the same container. We only unpin the conflicting tab, not clear the whole side, to avoid harming other views on the other side.
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
	 * view, *regardless* of how the persisted layout was produced - e.g. after
	 * upgrading from a build that allowed duplicates, or any future code path
	 * that opens a side while skipping the mutual-exclusion gate. The left side
	 * is the baseline single-area Panel, so when an overlap is detected the
	 * right side is the one released. This makes "views are unique across the
	 * two panels" hold under every circumstance and prevents the bug from
	 * recurring if a duplicate is ever persisted.
	 */
	private enforceViewUniquenessAfterRestore(): void {
		// Check not only the "active" containers on both sides, but also all "visible" containers on both sides (including pinned
		// but not-yet-active tabs). The original implementation only compared `getActivePaneComposite`, causing the source side to retain
		// a dragged-away pinned tab (the typical "after the user drags out DEBUG CONSOLE the left side still
		// shows the DEBUG tab" scenario) where the invariant is broken without being noticed.
		//
		// Here we detect any of the following invariant violations: "same id visible on both sides / shared view":
		//   1) the same id appears in both sides' visible sets (left pinned + right active is the most common);
		//   2) the active containers on both sides share a view;
		//   3) any side's visible set (including pinned but not active) shares a view with the other side's active container.
		// On a hit, release the "non-baseline side" to keep the baseline side's view; which side to release depends on the hit case:
		//   - both sides active the same id: clear the right side (baseline side = left);
		//   - only right active while left pinned the same id: clear the left side's pinned residue;
		//   - only left active while right pinned the same id: clear the right side.
		const leftVisible = new Set(this.leftPart.getVisiblePaneCompositeIds());
		const rightVisible = new Set(this.rightPart.getVisiblePaneCompositeIds());
		const leftActiveId = this.leftPart.getActivePaneComposite()?.getId();
		const rightActiveId = this.rightPart.getActivePaneComposite()?.getId();

		// (0) both sides have the same active container id (e.g. DEBUG CONSOLE /
		// `workbench.panel.repl` one copy on each side). We must use strict equality explicitly and cannot rely on
		// the `containersShareView` below:
		//   - `containersShareView` deliberately returns false for `a === b` (see its implementation comment,
		//     to allow the restore path to permit "two Terminals side by side"), so checks (2)/(3) inherently
		//     cannot detect the duplication of "the same container active on both sides";
		//   - the visible set above is the composite bar's pinned set
		//     (`getVisiblePaneCompositeIds`); an active container that is not pinned is not in it, so
		//     check (1) will also miss it.
		// The combination of these three causes the same view (DEBUG CONSOLE) to persist on both sides, while this method's
		// declared invariant is "a view must have a single owner and cannot appear in two Panels at once".
		if (leftActiveId && leftActiveId === rightActiveId) {
			// Consistent with the same-id branch of check (1): keep the right side, release the left side's copy.
			this.clearAndUnpinSide('left');
			this.storageService.remove(PanelSidePart.activePanelSettingsKeyFor('left'), StorageScope.WORKSPACE);
			return;
		}

		// (1) The same id appears in both sides' visible sets.
		let conflictingId: string | undefined;
		for (const id of leftVisible) {
			if (rightVisible.has(id)) {
				conflictingId = id;
				break;
			}
		}
		if (conflictingId) {
			// Both sides are simultaneously visible for that id. Prefer releasing the "non-active" side's pinned residue (the typical
			// "pinned tab residue on the source side after dragging" scenario). When both sides are active or both inactive,
			// follow the baseline rule and release the right side.
			const leftHasItActive = leftActiveId === conflictingId;
			const rightHasItActive = rightActiveId === conflictingId;
			if (leftHasItActive && !rightHasItActive) {
				// Left active, right only pinned residue: clear the right side's pinned.
				this.rightPart.unpinPaneComposite(conflictingId);
				this.rightPart.refreshCompositeBar();
			} else if (rightHasItActive && !leftHasItActive) {
				// Right active, left only pinned residue: clear the left side's pinned (the typical
				// "pinned residue on the source side after dragging" scenario).
				this.leftPart.unpinPaneComposite(conflictingId);
				this.leftPart.refreshCompositeBar();
			} else {
				// Both sides active the same container id: a view must have a single owner and cannot appear in
				// two Panels. The right side is the main Panel area (and the target side the user drags views back to),
				// so we keep the right side and force-release the left side's copy (instead of clearing the right side as the old implementation did).
				this.clearAndUnpinSide('left');
				this.storageService.remove(PanelSidePart.activePanelSettingsKeyFor('left'), StorageScope.WORKSPACE);
			}
			return;
		}

		// (2) The active containers on both sides share a view (typical "two different containers but overlapping views" scenario).
		if (leftActiveId && rightActiveId && this.containersShareView(leftActiveId, rightActiveId)) {
			this.clearAndUnpinSide('right');
			this.storageService.remove(PanelSidePart.activePanelSettingsKeyFor('right'), StorageScope.WORKSPACE);
			return;
		}

		// (3) One side pinned and the other side active share a view.
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

			// After the user drags the source side's currently active container to the other side, the source side will have
			// empty title/content. Below we set the source side's "next view" as active (without stealing focus
			// -focus stays on the target side the user just dragged into), to avoid the "original panel has no
			// active view at all" empty state.
			//
			// The drag-in target side and the drag-out source side are handled symmetrically: regardless of whether `fromPart` is left or right,
			// the activation compensation below runs for both sides, so dragging from left to right and from right
			// to left both get consistent behavior.
			const sourceActiveId = fromPart.getActivePaneComposite()?.getId();
			if (sourceActiveId === id || !sourceActiveId) {
				// Fallback: in extreme cases the source side's currently active container is still the dragged-away one (e.g. `hide`
				// ran outside the earlier mutual-exclusion path), clear it first to ensure the activation compensation below
				// does not operate on an already-dragged-away container. Again we can only use `clearActivePaneComposite`
				// not `hideActivePaneComposite`, for the same reason (the latter hides the entire Panel).
				if (sourceActiveId === id) {
					fromPart.clearActivePaneComposite();
				}

				const targetActiveId = targetPart.getActivePaneComposite()?.getId();

				// Determine whether a container can serve as the source side's fallback: it must have an active view, must not
				// be the dragged-away container, and must not share a view with the target side's current container (to avoid pushing out
				// the view just dragged in). Containers like Test Results that currently have no content are
				// filtered out, preventing the "opens then immediately closes, source side still empty" state.
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

				// 1) Prefer activating the first available container still pinned on the source side's bar.
				const nextId = fromPart.getPinnedPaneCompositeIds().find(isValidFallback);

				// 2) If the source side has no available pinned container left:
				//    - do **not** go into the entire Panel location and "pick a container that does not conflict with the target side"
				//     to force it in. If we did, sorted by Panel location `order`, the first candidate in the set
				//     is often Problems (which has an active view by default) or Debug Console (which the user
				//     never actively opened during debugging either), resulting in "the user never opened
				//    Problems, but as soon as they drag the only Panel view to the other side or drag it out
				//    of the Panel, the source side gets auto-filled with Problems", which is exactly the root cause of this bug.
				//
				// Correct semantics: the user dragged away all of the source side's pinned content, so the source side should be a blank drag
				// target ("Drag a view here" placeholder). An empty source side is the expected result of drag/drag-out scenarios
				// and should not be "thoughtfully" stuffed with a container the user never asked for by a bypass fallback strategy.
				// Next time the user opens a container from the View menu or Activity Bar, the source side will naturally re-
				// activate.
				if (nextId) {
					await fromPart.pinPaneComposite(nextId);
					await fromPart.openPaneComposite(nextId, false);
					// The `onDidPaneCompositeOpen` triggered by `openPaneComposite` is already responsible for setting this
					// container as active, highlighting it, and expanding its first view (`ensureFirstViewWorking`).
					// But under complex cross-side timing like dragging, the composite bar's `checked`
					// highlight (blue underline) and enabled state may lag behind - here we force a refresh of
					// the bar and enabled state, ensuring the tab stably shows as "active/clickable".
					fromPart.refreshCompositeBar();
					fromPart.updateCompositeEnabledStates();
					// Fallback: immediately and again on the next frame, each run one more "ensure first view is working".
					// Some containers (e.g. OUTPUT) rely on the async `updateViewHeaders` callback after extensions are ready to expand their single-view merge;
					// `updateViewHeaders` async callback; it only relies on the single `ensureFirstViewWorking` inside `onDidPaneCompositeOpen`. However, when that callback fires,
					// the view may not yet be ready, so that single `ensureFirstViewWorking` fails,
					// manifesting as "tab highlighted but content blank / no first view working".
					fromPart.ensureFirstViewWorking();
					setTimeout(() => fromPart.ensureFirstViewWorking(), 0);
				} else {
					// The source side has no activatable pinned container - explicitly clear the source side's active state,
					// so `viewPaneContainer` renders the blank "Drag a view here" placeholder.
					// Note: we must use `clearActivePaneComposite` rather than
					// `hideActivePaneComposite`, the latter would `setPartHidden(true, ...)`
					// hiding the entire Panel (taking the target side down with it).
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
			// Fallback: the `unpin` above is a silent no-op when `setPinned(id, false)` returns false (the model never recorded this
			// container as pinned, e.g. an initial pinned view ended up on the bar through a path other than `hideOtherPanelViews`), but the
			// tab still lingering in the DOM would appear as a duplicate of "source side pinned + target side active". Here we proactively force-remove this
			// "source side pinned + target side active" duplicate. Here we proactively force-remove this
			// id from the source side's visible set, ensuring the source side never leaves a tab for that view after a cross-side drag.
			const fromVisible = fromPart.getVisiblePaneCompositeIds();
			if (fromVisible.includes(id)) {
				fromPart.unpinPaneComposite(id);
				fromPart.refreshCompositeBar();
			}
			this.isInCrossSideMove = false;

			// After a cross-side drag completes, force a check of the "same view not shown twice" invariant.
			// Under some races (both sides in the middle of opening), the source side may not be cleared in time,
			// so here we act as the final fallback and release the conflicting side, preventing views like Terminal from appearing on both left and right at once.
			this.enforceViewUniquenessAfterRestore();

			// After a cross-side drag the source side may become empty; if the entire Panel is empty, auto-hide it (deferred one frame,
			// waiting for the open event to write back the target side's active before judging, to avoid misjudging the whole Panel as empty).
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
		// two commands both piled into the left side - the user saw "one Panel with
		// several working views" instead of the intended "two views split across the
		// left and right panels".
		//
		// Smart side dispatch: if the left side already hosts an *active* container whose
		// views do NOT overlap with the one being opened, and the right side is currently
		// empty (no active container / not yet in the split), route the new open to the
		// right side so the two different views show side-by-side. Otherwise fall back to
		// the left side (original behaviour). Drag-and-drop never reaches this method - it
		// calls `PanelSidePart.openPaneComposite` directly - so this dispatch only affects
		// command/API opens and cannot disturb the drag split logic.
		if (typeof id === 'string') {
			const leftActiveId = this.leftPart.getActivePaneComposite()?.getId();
			const rightActiveId = this.rightPart.getActivePaneComposite()?.getId();
			if (this.lastDismissedContainerBySide.get('right') === id) {
				this.lastDismissedContainerBySide.delete('right');
				return this.rightPart.openPaneComposite(id, focus);
			}
			if (this.lastDismissedContainerBySide.get('left') === id) {
				this.lastDismissedContainerBySide.delete('left');
				return this.leftPart.openPaneComposite(id, focus);
			}
			if (rightActiveId === id) {
				return this.rightPart.openPaneComposite(id, focus);
			}
			if (leftActiveId === id) {
				return this.leftPart.openPaneComposite(id, focus);
			}
			const oc = this.panelViewDescriptorService.getViewContainerById(id);
			const recSide = oc
				? this.panelViewDescriptorService.getViewContainerModel(oc).allViewDescriptors.map(d => getViewDragOutPanelSideForView(d.id)).find(Boolean)
				: undefined;
			if ((recSide ?? this.lastActiveSideByContainer.get(id)) === 'right' && !rightActiveId) {
				if (!this.rightViewInSplit) {
					this.addRightToSplit();
				}
				return this.rightPart.openPaneComposite(id, focus);
			}
			const leftOccupied = !!leftActiveId;
			const rightEmpty = !rightActiveId;
			const noViewOverlap = !leftActiveId || !this.containersShareView(leftActiveId, id);
			if (leftOccupied && rightEmpty && noViewOverlap) {
				if (!this.rightViewInSplit) {
					this.addRightToSplit();
				}
				return this.rightPart.openPaneComposite(id, focus);
			}
		}
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
			// During window drag-out (`isSuppressPanelRelayoutOnDragOut`): the view was just moved to the Editor area,
			// so the source Panel side becomes empty briefly. If we normally raised the min height from 77 to 350 and fired a relayout,
			// the entire Panel area (including the editor area) would be relaid out once-the editor area gets squeezed then released, appearing as
			// "Panel flickers / re-renders the UI when dragging out". Here we keep the current height, changing neither the min height nor
			// triggering a relayout, so the Panel stays as-is at the moment of drag-out (the dragged-away side naturally becomes an empty drag target).
			if (isEmpty && isSuppressPanelRelayoutOnDragOut()) {
				return;
			}
			this.minimumHeight = targetMinimum;
			this._onDidChange.fire(undefined);
		}

		// After splitting, when one side becomes empty / both sides empty: defer the judgment of collapsing the empty side and hiding the whole Panel to the next
		// tick (see `emptyPanelCheckScheduler`), to avoid the synchronous instant of close when switching views
		// misjudging it as empty and hiding the whole Panel. The layout (side visibility) still needs a synchronous refresh.
		this.updateSideVisibility();
		this.emptyPanelCheckScheduler.schedule();
	}

	/**
	 * After splitting, when a side (left or right) has no active view container, proactively collapse that side
	 * instead of leaving an empty placeholder showing "Drag a view here to display":
	 *   - left becomes empty: call `hideSide('left')`, add left to `hiddenSides`, right fills the whole Panel;
	 *   - right becomes empty: call `removeRightFromSplit()`, the Panel returns to a single area (left fills), right disappears.
	 *
	 * The collapsed side is marked by `hiddenSides`, so `createSide`'s fallback scheduler will no longer
	 * auto-reopen other containers, matching the expectation of "empty side is collapsed".
	 *
	 * Skip the following scenarios (to avoid mistakenly collapsing during transitions):
	 *   - the entire Panel is in the process of hiding (Toggle Panel);
	 *   - a view is being dragged out to a standalone window;
	 *   - a view is being dragged.
	 */
	private autoCollapseEmptySides(): void {
		if (this.hidingEntirePanel || this.isRestoringFromEditor || isSuppressPanelRelayoutOnDragOut() || this.isDragInProgress) {
			return;
		}

		// Only when in a dual-column layout (right side in the split) do we need the "collapse one side" judgment; in a single-column layout
		// there is no "right column", so we only rely on `autoHidePanelIfEmpty` to handle the whole Panel being empty.
		if (!this.rightViewInSplit) {
			return;
		}

		const leftActive = this.leftPart.hasActiveView();
		const rightActive = this.rightPart.hasActiveView();

		if (!rightActive && this.rightViewInSplit) {
			if (!this.isDragInProgress && this.splitPreviewSide !== undefined) {
				this.splitView.layout(this.sideWidth);
			} else {
				this.removeRightFromSplit();
				this.updatePanelStripForFullHeight();
			}
		}
		if (!leftActive && rightActive && !this.isSideHidden('left') && this.splitPreviewSide === undefined) {
			if (!this.isDragInProgress) {
				this.hideSide('left');
			}
		}
	}

	/**
	 * When, after splitting, neither the left nor the right side of the Panel has any active view container, directly call the Hide Panel
	 * method to hide the entire Panel, avoiding an empty Panel continuing to show the "Drag a view here to display" placeholder.
	 *
	 * It skips the following scenarios:
	 * - the Panel is currently not visible;
	 * - the entire Panel is in the process of hiding (Toggle Panel);
	 * - a view is being dragged out to a standalone window;
	 * - some side still holds an active container.
	 */
	/**
	 * Whether the most recent "hide the whole Panel" action was triggered by
	 * `autoHidePanelIfEmpty()` because BOTH sides had become empty (no active
	 * view container on either side). This is distinct from a user-driven
	 * Toggle Panel / Ctrl+J hide, where the Panel still held one or more views
	 * that should be restored on the next show.
	 *
	 * When the empty-auto-hide flag is set, the next `setPanelHidden(false)`
	 * must NOT reopen any view - the user expects an *empty* Panel showing the
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
	 * opening the default view - leaving TERMINAL / DEBUG CONSOLE as dead,
	 * non-working tabs. See `isShowingEmptyPanel()` consumer.
	 */
	private initialized = false;

	/**
	 * `true` while the initial default-view open is still in flight - i.e. from
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
	 * Panel the very first time it is shown - which is exactly the
	 * "first load hides the Panel / Ctrl+R shows nothing" bug. While this flag
	 * is set, `autoHidePanelIfEmpty` must NOT hide the Panel nor flag it empty.
	 *
	 * The flag is cleared ONLY once BOTH of the following hold:
	 *   1. `runInitialEnsureWorking()` has finished its entire startup closure
	 *      (all `ensureFirstViewWorking` / `hideOtherPanelViews` calls that may
	 *      cause close/open churn have settled) - tracked by `initialEnsureDone`;
	 *   2. a real `onDidPaneCompositeOpen` has fired, proving the default view is
	 *      genuinely active (not just *called* to open).
	 * This two-gate design prevents clearing the guard mid-churn (which would let
	 * a transient empty map hide the Panel) while still allowing a *genuinely*
	 * empty Panel to be auto-hidden after startup.
	 */
	private pendingInitialOpen = true;

	/**
	 * `true` only after `runInitialEnsureWorking()` has run to completion - i.e.
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
	 * IMPORTANT: this is a pure *query* - it does NOT clear the flag. The flag is
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
		// GUARD: never during startup - the default view restore is async and the
		// Panel briefly looks empty; flagging it then would suppress the default
		// TERMINAL / DEBUG CONSOLE view and leave them dead.
		if (this.initialized) {
			this.lastAutoHideWasEmpty = true;
		}

		this.layoutService.setPartHidden(true, Parts.PANEL_PART);
		// Clear the empty dual-layout snapshot, to avoid re-triggering the hide after the empty layout is restored on the next Toggle Panel.
		this.storageService.remove(PanelPart.layoutSettingsKey, StorageScope.WORKSPACE);
	}

	private collapseEmptySideInSplit(): boolean {
		if (!this.splitView || this.fullHeightSides.size === 0) {
			return false;
		}
		if (this.hidingEntirePanel || isSuppressPanelRelayoutOnDragOut() || this.isDragInProgress || this.splitPreviewSide !== undefined) {
			return false;
		}
		if (this.rightViewInSplit && !this.rightPart.getActivePaneComposite()) {
			this.removeRightFromSplit();
			this.updatePanelStripForFullHeight();
			return true;
		}
		if (this.rightViewInSplit && !this.fullHeightSides.has('left') && !this.isSideHidden('left') && !this.leftPart.getActivePaneComposite()) {
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
			// When any maximized (full-height) side has no active view, directly hide that side,
			// instead of showing the empty "Drag a view here" placeholder:
			//   - left maximized side becomes empty: record in `hiddenSides`, the Panel area falls back to a single column;
			//   - right maximized side becomes empty: remove from the split, the Panel falls back to a single column;
			// the remaining other maximized side continues to display at full-height. If all sides become empty, then
			// hide the entire Panel. Skip the dragging / dragging-out-to-window transition to avoid mis-hiding.
			if (!this.isDragInProgress && !isSuppressPanelRelayoutOnDragOut() && !this.hidingEntirePanel) {
				const emptyFullHeightSides = [...this.fullHeightSides].filter(side =>
					!(side === 'left' ? this.leftPart : this.rightPart).hasActiveView());
				if (emptyFullHeightSides.length > 0) {
					// The still-possibly-active sides: the remaining full-height side + the other sides still in the split
					// that are not hidden.
					const remainingFullHeightActive = this.fullHeightSides.size - emptyFullHeightSides.length > 0;
					const otherSideActive = [...this.fullHeightSides]
						.filter(side => !emptyFullHeightSides.includes(side))
						.some(side => (side === 'left' ? this.leftPart : this.rightPart).hasActiveView());
					const splitActive = (!this.fullHeightSides.has('left') && !this.isSideHidden('left') && this.leftPart.hasActiveView())
						|| (this.rightViewInSplit && this.rightPart.hasActiveView());
					if (!remainingFullHeightActive && !otherSideActive && !splitActive) {
						// All empty: hide the entire Panel.
						this.autoHidePanelIfEmpty();
						return;
					}
					// Only hide the emptied maximized side, keeping the other sides (another still-maximized side continues
					// displaying in its own grid column; hideSide only takes the target side out of full-height,
					// no longer taking all maximized sides out as the old logic did).
					for (const side of emptyFullHeightSides) {
						this.hideSide(side);
					}
					// After hiding there may be no full-height side left, in which case go to the split branch below to re-layout;
					// otherwise do the normal full-height layout for the remaining full-height side.
					if (this.fullHeightSides.size > 0) {
						this.relayoutAfterFullHeightChange();
						this.updatePanelStripForFullHeight();
						return;
					}
				}
			}
			// If after hiding the empty side there is no full-height side left, go through the split branch below to re-layout uniformly
			// (at this point the Panel should fall back to a single column and collapse the empty side, avoiding the "Drag a view" placeholder).
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
		}
		if (!this.rightPart.hasActiveView() && !!this.rightPart.getActivePaneComposite()) {
		}
		this.updateSplitDividerVisibility();
	}

	private updateSplitDividerVisibility(): void {
		if (!this.splitContainer || !this.splitView) {
			return;
		}
		const leftVisible = !this.isSideHidden('left') && !!this.leftPart.getActivePaneComposite();
		const rightVisible = !this.isSideHidden('right') && this.rightViewInSplit && !!this.rightPart.getActivePaneComposite();
		this.splitContainer.classList.toggle('panel-split-no-divider', !(leftVisible && rightVisible));
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
		// A side counts as occupied only if it "truly holds a visible view". activeContainerBySide /
		// isSideHidden often retain stale records after a view is dragged away, and we cannot reject takeover based on them, otherwise
		// the emptied half can never summon the drop hot-zone. getActivePaneComposite() is the authoritative source
		// for whether that side truly has visible content.
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
		console.log('p1');
		e.preventDefault();
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
		console.log('p2');
		e.preventDefault();
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
			console.log('p3');
			EventHelper.stop(e, true);
			const targetPart = this.getSidePart(dropSide);
			targetPart.handleEmptyAreaDrop(e, this.buildSplitDragData(e));
			// The drop ended either way: reset the drag state now (the observer's
			// dragend is unreliable for cross-side drags and would otherwise
			// leave `isDragInProgress` stuck true).
			this.endDragState();
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
		this.leftPart?.sideElement.classList.remove('panel-side-drop-preview');
		this.rightPart?.sideElement.classList.remove('panel-side-drop-preview');
		this.dragEndFallbackScheduler.cancel();
		this.dragOverWatchdog.cancel();
		this.clearStaleDropOverlays();
		this.updateSideVisibility();
		this.emptyPanelCheckScheduler.schedule();
	}

	private clearStaleDropOverlays(): void {
		if (!this.leftPart || !this.rightPart) {
			return;
		}
		for (const side of ['left', 'right'] as const) {
			const element = this.getSidePart(side).sideElement;
			if (!element) {
				continue;
			}
			const stale = element.querySelectorAll('#monaco-pane-drop-overlay');
			stale.forEach(el => el.remove());
			element.querySelectorAll('.dragged-over').forEach(el => el.classList.remove('dragged-over'));
		}
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
		container.style.borderTopColor = borderColor;
	}

	toJSON(): object {
		return {
			type: Parts.PANEL_PART
		};
	}
}
