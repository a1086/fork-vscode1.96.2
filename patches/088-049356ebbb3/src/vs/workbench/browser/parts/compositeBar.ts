/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { IAction, toAction } from '../../../base/common/actions.js';
import { IActivity } from '../../services/activity/common/activity.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ActionBar, ActionsOrientation } from '../../../base/browser/ui/actionbar/actionbar.js';
import { CompositeActionViewItem, CompositeOverflowActivityAction, CompositeOverflowActivityActionViewItem, CompositeBarAction, ICompositeBar, ICompositeBarColors, IActivityHoverOptions } from './compositeBarActions.js';
import { tryClaimViewDragSession, nextViewDragSession, releaseViewDragSession, setSuppressPanelRelayoutOnDragOut, getViewDragOutPanelSide, setViewDragOutPanelSideForView } from './viewDragSession.js';
import { Dimension, $, addDisposableListener, EventType, EventHelper, isAncestor, getWindow } from '../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../base/browser/mouseEvent.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { Widget } from '../../../base/browser/ui/widget.js';
import { isUndefinedOrNull } from '../../../base/common/types.js';
import { IColorTheme } from '../../../platform/theme/common/themeService.js';
import { Emitter } from '../../../base/common/event.js';
import { ViewContainerLocation, ViewVisibilityState, IViewDescriptor, IViewDescriptorService } from '../../common/views.js';
import { IPaneComposite } from '../../common/panecomposite.js';
import { IComposite } from '../../common/composite.js';
import { CompositeDragAndDropData, CompositeDragAndDropObserver, IDraggedCompositeData, ICompositeDragAndDrop, Before2D, toggleDropEffect, ICompositeDragAndDropObserverCallbacks } from '../dnd.js';
import { IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import { IHostService } from '../../services/host/browser/host.js';
import { ViewEditorInput } from '../../contrib/viewInEditor/browser/viewEditorInput.js';
import { WebviewViewPane } from '../../contrib/webviewView/browser/webviewViewPane.js';
import { Gesture, EventType as TouchEventType, GestureEvent } from '../../../base/browser/touch.js';

export interface ICompositeBarItem {

	readonly id: string;

	name?: string;
	pinned: boolean;
	order?: number;
	visible: boolean;
}



export class CompositeDragAndDrop implements ICompositeDragAndDrop {

	constructor(
		private viewDescriptorService: IViewDescriptorService,
		private targetContainerLocation: ViewContainerLocation,
		private orientation: ActionsOrientation,
		private openComposite: (id: string, focus?: boolean) => Promise<IPaneComposite | null>,
		private moveComposite: (from: string, to: string, before?: Before2D) => void,
		private getItems: () => ICompositeBarItem[]
	) { }

	drop(data: CompositeDragAndDropData, targetCompositeId: string | undefined, originalEvent: DragEvent, before?: Before2D): void {
		const dragData = data.getData();

		if (dragData.type === 'composite') {
			const currentContainer = this.viewDescriptorService.getViewContainerById(dragData.id)!;
			const currentLocation = this.viewDescriptorService.getViewContainerLocation(currentContainer);
			let moved = false;

			// ... on the same composite bar
			if (currentLocation === this.targetContainerLocation) {
				if (targetCompositeId) {
					this.moveComposite(dragData.id, targetCompositeId, before);
					moved = true;
				}
			}
			// ... on a different composite bar
			else {
				this.viewDescriptorService.moveViewContainerToLocation(currentContainer, this.targetContainerLocation, this.getTargetIndex(targetCompositeId, before), 'dnd');
				moved = true;
			}

			if (moved) {
				this.openComposite(currentContainer.id, true);
			}
		}

		if (dragData.type === 'view') {
			const viewToMove = this.viewDescriptorService.getViewDescriptorById(dragData.id)!;
			if (viewToMove && viewToMove.canMoveView) {
				const currentContainer = this.viewDescriptorService.getViewContainerByViewId(viewToMove.id);
				const alreadyOwnTab = !!currentContainer
					&& this.viewDescriptorService.getViewContainerLocation(currentContainer) === this.targetContainerLocation
					&& this.viewDescriptorService.getViewContainerModel(currentContainer).allViewDescriptors.length === 1;

				// When dropping onto the bar (no specific target tab), reuse an existing
				// container at the target location instead of letting moveViewToLocation
				// generate a fresh random container. A generated container can be cleaned up
				// immediately by the generated-containers cleanup logic, making the view vanish.
				const existingContainers = this.viewDescriptorService.getViewContainersByLocation(this.targetContainerLocation);
				const targetContainer = existingContainers.find(c => this.viewDescriptorService.getViewContainerModel(c).allViewDescriptors.length === 0);

				if (targetContainer) {
					this.viewDescriptorService.moveViewsToContainer([viewToMove], targetContainer, ViewVisibilityState.Default, 'dnd');
				} else if (!alreadyOwnTab) {
					this.viewDescriptorService.moveViewToLocation(viewToMove, this.targetContainerLocation, 'dnd');
				}

				const newContainer = this.viewDescriptorService.getViewContainerByViewId(viewToMove.id)!;

				if (targetCompositeId) {
					this.moveComposite(newContainer.id, targetCompositeId, before);
				}

				this.openComposite(newContainer.id, true).then(composite => {
					composite?.openView(viewToMove.id, true);
				});
			}
		}
	}

	onDragEnter(data: CompositeDragAndDropData, targetCompositeId: string | undefined, originalEvent: DragEvent): boolean {
		return this.canDrop(data, targetCompositeId);
	}

	onDragOver(data: CompositeDragAndDropData, targetCompositeId: string | undefined, originalEvent: DragEvent): boolean {
		return this.canDrop(data, targetCompositeId);
	}

	private getTargetIndex(targetId: string | undefined, before2d: Before2D | undefined): number | undefined {
		if (!targetId) {
			return undefined;
		}

		const items = this.getItems();
		const before = this.orientation === ActionsOrientation.HORIZONTAL ? before2d?.horizontallyBefore : before2d?.verticallyBefore;
		return items.filter(item => item.visible).findIndex(item => item.id === targetId) + (before ? 0 : 1);
	}

	private canDrop(data: CompositeDragAndDropData, targetCompositeId: string | undefined): boolean {
		const dragData = data.getData();

		if (dragData.type === 'composite') {

			// Dragging a composite
			const currentContainer = this.viewDescriptorService.getViewContainerById(dragData.id)!;
			const currentLocation = this.viewDescriptorService.getViewContainerLocation(currentContainer);

			// ... to the same composite location
			if (currentLocation === this.targetContainerLocation) {
				return dragData.id !== targetCompositeId;
			}

			return true;
		} else {

			// Dragging an individual view
			const viewDescriptor = this.viewDescriptorService.getViewDescriptorById(dragData.id);

			// ... that cannot move
			if (!viewDescriptor || !viewDescriptor.canMoveView) {
				return false;
			}

			// ... to create a view container
			return true;
		}
	}
}

export interface ICompositeBarOptions {

	readonly icon: boolean;
	readonly orientation: ActionsOrientation;
	readonly colors: (theme: IColorTheme) => ICompositeBarColors;
	readonly compact?: boolean;
	readonly compositeSize: number;
	readonly overflowActionSize: number;
	readonly dndHandler: ICompositeDragAndDrop;
	readonly activityHoverOptions: IActivityHoverOptions;
	readonly preventLoopNavigation?: boolean;
	readonly showCloseButton?: boolean;
	readonly closeActiveComposite?: () => void;
	/**
	 * Fired when the bar loses its active composite (e.g. after unpinning the
	 * active tab) and finds no replacement to auto-open (no default composite is
	 * pinned, no other visible composite exists). The owning part can use this
	 * to also clear its own active composite content - otherwise, in the
	 * dual-panel layout, the side's title-actions would keep rendering the
	 * closed tab's toolbar (e.g. the Terminal profile dropdown) with no tab in
	 * the bar to back it.
	 */
	readonly onDidCloseActiveComposite?: () => void;
	/**
	 * When true (default), clicking the close button on the last remaining
	 * pinned composite hides the entire part via `workbench.action.togglePanel`.
	 * Set to false for sub-parts (e.g. one side of the dual-panel layout) where
	 * closing the last composite should only clear that sub-part and let the
	 * owning layout collapse it.
	 */
	readonly hidePartOnLastPinnedClose?: boolean;
	/**
	 * When provided, clicking the close button hides the entire sub-part (e.g.
	 * one side of the dual-panel layout) instead of just unpinning the active
	 * composite. The owning layout then collapses that sub-part so the other
	 * side fills the area. Takes precedence over `hidePartOnLastPinnedClose`.
	 */
	readonly hideSide?: () => void;
	/**
	 * When set to true, the overflow action ("...") will not be shown and
	 * all composites will be displayed in the bar regardless of available space.
	 */
	readonly disableOverflow?: boolean;

	readonly getActivityAction: (compositeId: string) => CompositeBarAction;
	readonly getCompositePinnedAction: (compositeId: string) => IAction;
	readonly getCompositeBadgeAction: (compositeId: string) => IAction;
	readonly getOnCompositeClickAction: (compositeId: string) => IAction;
	readonly fillExtraContextMenuActions: (actions: IAction[], e?: MouseEvent | GestureEvent) => void;
	readonly getContextMenuActionsForComposite: (compositeId: string) => IAction[];

	readonly openComposite: (compositeId: string, preserveFocus?: boolean) => Promise<IComposite | null>;
	readonly getDefaultCompositeId: () => string | undefined;
	readonly isCompositeDraggable?: (compositeId: string) => boolean;
}

class CompositeBarDndCallbacks implements ICompositeDragAndDropObserverCallbacks {

	private insertDropBefore: Before2D | undefined = undefined;

	/**
	 * Prevent a single drag from opening a window multiple times:
	 * - `registerTarget(parent, ...)` registers one dnd callback for the whole bar container;
	 * - each `CompositeActionViewItem`'s own `pane.draggableElement` also registers `registerDraggable`,
	 *   and its `onDragEnd` internally fires `_onDragEnd.fire(...)` as well (at `dnd.ts:577`);
	 * - Panel and Aux Bar each have their own `CompositeBar`/`CompositeBarDndCallbacks` instance,
	 *   and their `onDragEnd` all fire;
	 * - after moving a view with `moveViewToLocation(Editor)`, the native `editorTabsControl` drag-out path
	 *   opens yet another window.
	 * An instance-level boolean alone cannot de-duplicate across instances, so instead: write a global sessionId at dragstart
	 * into dataTransfer, use `tryClaimViewDragSession` in onDragEnd for process-wide de-duplication (see the
	 * module-level guards `nextViewDragSession` / `tryClaimViewDragSession` below), and delay the `move`
	 * until after the current dragend event loop ends, fully cutting off the second window from the native path.
	 */

	constructor(
		private readonly compositeBarContainer: HTMLElement,
		private readonly actionBarContainer: HTMLElement,
		private readonly compositeBarModel: CompositeBarModel,
		private readonly dndHandler: ICompositeDragAndDrop,
		private readonly orientation: ActionsOrientation,
		private readonly editorGroupsService: IEditorGroupsService,
		private readonly hostService: IHostService,
		private readonly viewDescriptorService: IViewDescriptorService,
		private readonly instantiationService: IInstantiationService,
	) { }

	onDragOver(e: IDraggedCompositeData) {

		// don't add feedback if this is over the composite bar actions or there are no actions
		const visibleItems = this.compositeBarModel.visibleItems;
		if (!visibleItems.length || (e.eventData.target && isAncestor(e.eventData.target as HTMLElement, this.actionBarContainer))) {
			this.insertDropBefore = this.updateFromDragging(this.compositeBarContainer, false, false, true);
			return;
		}

		const insertAtFront = this.insertAtFront(this.actionBarContainer, e.eventData);
		const target = insertAtFront ? visibleItems[0] : visibleItems[visibleItems.length - 1];
		const validDropTarget = this.dndHandler.onDragOver(e.dragAndDropData, target.id, e.eventData);
		toggleDropEffect(e.eventData.dataTransfer, 'move', validDropTarget);
		this.insertDropBefore = this.updateFromDragging(this.compositeBarContainer, validDropTarget, insertAtFront, true);
	}

	onDragLeave(e: IDraggedCompositeData) {
		this.insertDropBefore = this.updateFromDragging(this.compositeBarContainer, false, false, false);
	}

	onDragStart(e: IDraggedCompositeData) {
		// Increment sessionId at the start of every drag so the claim de-duplication in onDragEnd can correctly distinguish
		// different drag rounds. If nextViewDragSession() is not called, sessionId stays -1 and
		// after the first drag __lastViewDragSessionHandled becomes true, so every later drag's
		// tryClaimViewDragSession returns false -> "dragging another view then cannot drag any out".
		nextViewDragSession();
	}

	async onDragEnd(e: IDraggedCompositeData) {
		this.insertDropBefore = this.updateFromDragging(this.compositeBarContainer, false, false, false);

		// Phase 3: drag out of the window (option A)
		// Decision: controlled by `workbench.editor.dragToOpenWindow`, inverted by Alt.
		// Note: do not rely on `isWindowDraggedOver()` to veto opening a window -- that tracker relies on
		// DRAG_OVER events to set draggedOver to true, but when a tab is dragged past the window boundary and
		// released, the original window receives no reliable DRAG_LEAVE, so draggedOver stays true and "drag out of window" is
		// misjudged as "still inside the window", rejecting the open (this is the root cause of Panel / Aux Bar failing to drag out).
		// "Whether it was dragged out of the window" is instead decided inside `openInAuxiliaryWindow` using the cursor geometry (consistent with
		// editorTabsControl#maybeCreateAuxiliaryEditorPartAt).
		const isNewWindowOperation = this.editorGroupsService.partOptions.dragToOpenWindow ? !e.eventData.altKey : e.eventData.altKey;
		if (isNewWindowOperation) {
			// Global de-duplication: a viewId-based "in-progress set" guard (see viewDragSession.ts).
			// Multiple onDragEnd callbacks for the same drag (bar container registerTarget,
			// tab registerDraggable, native editor tabs drag-out path) all pass the same viewId,
			// and only the first handler claims it successfully while the rest skip.
			// Different viewIds (e.g. dragging Watch then Call Stack) do not affect each other and can each be dragged out
			// into their own separate window.
			//
			// Key fix (v5 - eliminating the race condition):
			// tryClaimViewDragSession is a **synchronous** call and must run before any await.
			// The v4 version also used a Set for de-duplication, but between claim and the actual window opening
			// there were async operations such as `await getCursorScreenPoint()`. Once the await yields execution,
			// another CompositeBarDndCallbacks instance (e.g. the Aux Bar's onDragEnd) can
			// reach tryClaimViewDragSession in the same event-loop microtask,
			// at which point __pendingViews has not yet been added by the first callback (because the first callback is still parked on the await),
			// so both callbacks pass the has() check -> both return true -> each opens a separate window.
			// This is the root cause of "dragging out one Watch view produces two separate Watch windows".
			//
			// Fix: the claim runs immediately in this synchronous section, and Set.add() completes before it returns.
			// All later awaits happen after the claim, so other callbacks already see the owned state.
			const { type: dragType, id: dragId } = e.dragAndDropData.getData();
			const claimViewId = `${dragType}:${dragId}`; // use the type:id combination as the unique key
			const claimResult = tryClaimViewDragSession(claimViewId);
			if (!claimResult) {
				return;
			}
			try {
				await this.openInAuxiliaryWindow(e);
			} finally {
				// Key fix (dragging one view opens multiple windows):
				// we must not release the claim immediately when this round's window opening finishes, because openInAuxiliaryWindow
				// internally uses `setTimeout(moveViewToLocation, 0)` at the end to move the view to the
				// Editor area, and the native editorTabsControl drag-out path (or another same-origin
				// onDragEnd callback) may trigger another window opening after the move but before this drag truly
				// finishes (this is the source of "dragging one out but 3 separate windows pop up").
				// So we delay releasing the claim until all async cleanup of this round (including the setTimeout
				// move above and its follow-ups) has completed, ensuring those second window requests are blocked before the lock is released.
				// The delay must be longer than the internal setTimeout(0) of openInAuxiliaryWindow and the possible
				// async duration of the native path; we use 300ms here.
				setTimeout(() => releaseViewDragSession(claimViewId), 300);
			}
		}
	}

	private async openInAuxiliaryWindow(e: IDraggedCompositeData): Promise<void> {
		try {
			const { type, id } = e.dragAndDropData.getData();

			// Resolve the view id to host:
			// - dragging a 'view' type: the id is the view id directly, so `getViewDescriptorById` can resolve it.
			// - dragging a 'composite' type: the id is a container id (e.g. the Aux Bar's `workbench.view.debug`,
			//   or the Panel's `workbench.panel.terminal`). `getViewDescriptorById(containerId)`
			//   always returns undefined, so we must first fetch the container with `getViewContainerById` and then take its
			//   first (and only draggable-to-window) view descriptor.
			// The old implementation did only `getViewDescriptorById(id) ?? id` for the composite type, i.e. it looked up the
			// container id as if it were a view id, so the result was always undefined -> an early return and no window.
			// This is the root cause of "cannot drag a view out of the Aux Bar": almost all folders on the Aux Bar are multi-view containers,
			// so a dragged-out item is always of type 'composite' and resolution always fails. Items on the Panel could be dragged out because
			// Problems/Output etc. are single-view containers and went through the `type: 'view'` branch.
			let descriptor: IViewDescriptor | undefined;
			if (type === 'view') {
				descriptor = this.viewDescriptorService.getViewDescriptorById(id) ?? undefined;
			} else if (type === 'composite') {
				const container = this.viewDescriptorService.getViewContainerById(id);
				if (container) {
					const model = this.viewDescriptorService.getViewContainerModel(container);
					descriptor = model?.activeViewDescriptors[0] ?? model?.allViewDescriptors[0];
				}
			}

			if (!descriptor) {
				return;
			}

			// Use the current cursor screen position as the new window bounds (cf. editorTabsControl#maybeCreateAuxiliaryEditorPartAt).
			const screenPoint = await this.hostService.getCursorScreenPoint();

			const targetWindow = getWindow(this.compositeBarContainer);

			// Geometric veto ("mouse is still inside this window -> do not open a window").
			// Note (one of the root causes of the Aux Bar failing to drag out):
			// in the `dragend` event, Chromium's `event.screenX/screenY` does **not reflect the cursor
			// position on release** (on most platforms it falls back to the coordinates at drag start, or even 0). An Aux Bar tab is
			// flush with the window edge, so screenX/Y at drag start always lies inside the window rect; if
			// `getCursorScreenPoint()` returns nothing in that environment and we fall back to `screenX/Y`, we
			// misjudge "already dragged out of the window" as "still inside the window" and return, which looks like the Aux Bar can never be dragged out.
			// Therefore: only use the coordinates for a precise geometric veto when `getCursorScreenPoint()` actually returns them.
			//
			// Key fix (duplicate views when dragging across sides within a bar):
			// when `getCursorScreenPoint()` returns undefined (common for Chromium dragend), the old implementation
			// skipped the veto and opened a window unconditionally, so a pure in-bar move like dragging from one side of the Panel bar to the other
			// also opened a floating window and moved the view to the Editor area; as a result the original view appeared both in the Editor
			// area and in the new window -> "duplicate views" (the multiple WATCH/TERMINAL copies in the screenshot).
			// Aligned with editorTabsControl#maybeCreateAuxiliaryEditorPartAt: when the real
			// cursor position is unavailable but the source window is still visible and focused (i.e. the release point must still be inside this window, an in-bar
			// move or a drag back into the window), reject opening a window; only open a window when the window has lost focus (a real drag out).
			const windowStillFocused = targetWindow.document.visibilityState === 'visible' && targetWindow.document.hasFocus();
			if (screenPoint) {
				const point = screenPoint.point;
				if (point.x >= targetWindow.screenX && point.x <= targetWindow.screenX + targetWindow.outerWidth
					&& point.y >= targetWindow.screenY && point.y <= targetWindow.screenY + targetWindow.outerHeight) {
					return; // mouse still inside this window, do not open (treated as an in-bar move / drag back into the window)
				}
			} else if (windowStillFocused) {
				return; // cursor position unavailable and source window still focused -> treated as an in-bar move, reject opening (removes duplicate views)
			}

			let bounds: { x: number; y: number } | undefined;
			if (screenPoint) {
				bounds = { x: screenPoint.point.x, y: screenPoint.point.y };
				// Multi-monitor protection: prevent the window from overflowing past the top/left edge of the screen/display.
				const display = screenPoint.display;
				if (display) {
					if (bounds.x < display.x) {
						bounds.x = display.x;
					}
					if (bounds.y < display.y) {
						bounds.y = display.y;
					}
				}
			}

			// Key fix: open the auxiliary window + openEditor first, and only move the view into the Editor area last.
			// The old implementation moved first and created after, which made the view briefly appear in the main window's editor area and
			// triggered the native `editorTabsControl` drag-out path (a second onDragEnd callback), opening extra windows.
			// New order: the view is still in its original bar -> never appears in the main window editor -> the native path never kicks in -> a clean single window.
			const auxiliaryEditorPart = await this.editorGroupsService.createAuxiliaryEditorPart({ bounds });
			const targetGroup = auxiliaryEditorPart.activeGroup;

			// For the composite type (a multi-view container like Debug), open all active views into the
			// floating window. For the single-view type, open only that one.
			// This ensures that dragging out the Debug container shows the full debug panel (Breakpoints,
			// Call Stack, Watch, Variables) rather than just one empty child view.
			//
			// Important: viewsToOpen decides which views get moveViewToLocation(Editor).
			// If we move away all views in a container, then later dragging another child view of that container makes
			// getViewLocationById return Editor -> blocked by the location check -> no window can be opened again.
			// So move all views only when type === 'composite' (dragging the container tab itself);
			// when type === 'view' (dragging a specific child view) move only that one.
			const viewsToOpen = type === 'composite'
				? (() => {
					const container = this.viewDescriptorService.getViewContainerById(id);
					const model = container ? this.viewDescriptorService.getViewContainerModel(container) : null;
					return model?.activeViewDescriptors.length
						? model.activeViewDescriptors
						: (model?.allViewDescriptors ?? []);
				})()
				: [descriptor];

			WebviewViewPane.markMove(viewsToOpen.map(v => v.id));
			for (const v of viewsToOpen) {
				const vOriginalLocation = this.viewDescriptorService.getViewLocationById(v.id) ?? undefined;
				const vOriginalContainer = this.viewDescriptorService.getViewContainerByViewId(v.id);
				const vOriginalContainerId = vOriginalContainer?.id ?? undefined;
				// Record the view's ordinal position within its original container, used to restore ordering when a floating window closes,
				// otherwise a child view in a middle position such as WATCH jumps to the top of the Debug container.
				const vOriginalIndex = vOriginalContainer
					? this.viewDescriptorService.getViewContainerModel(vOriginalContainer).allViewDescriptors.findIndex(d => d.id === v.id)
					: -1;
				const dragOutSide = getViewDragOutPanelSide();
				setViewDragOutPanelSideForView(v.id, dragOutSide);
				const input = this.instantiationService.createInstance(
					ViewEditorInput,
					v.id,
					vOriginalLocation,
					vOriginalContainerId,
					vOriginalIndex >= 0 ? vOriginalIndex : undefined
				);
				// Record the "drag-out origin" as the original bar (Panel/Aux), so that closing the standalone window restores it to the original bar
				// (rather than being moved into the Editor area by the later moveViewToLocation).
				await targetGroup.openEditor(input, { pinned: true });
			}
			targetGroup.focus();

			// Now remove the view from its original bar (it is already hosted by the new window's ViewEditorPane,
			// so the original bar no longer needs it). This step hides the corresponding tab on the original composite bar,
			// but because ViewEditorInput is a Singleton, the original window never reappears.
			//
			// Key: delay the move until the current dragend event loop has fully finished.
			// If we moved immediately, the ViewEditorPane tab would appear in this window's editor area right away,
			// while the native `editorTabsControl.onDragEnd` drag-out path is still running, would capture that tab
			// and open yet another floating window (this is the third source of "three windows dragged out").
			// Using a microtask/timeout lets the native path run first (at which point the view is not yet in the editor area and
			// the tab cannot be found), then we move, so no second window is triggered.
			//
			// Important: only move the views in viewsToOpen. For type === 'view' (dragging a child view),
			// viewsToOpen contains only that one view and does not affect other child views of the same container.
			// This lets users drag each of the Debug container's Watch, Call Stack, etc. into separate windows one by one.
			const viewDescriptorService = this.viewDescriptorService;
			setTimeout(() => {
				// Suppress the Panel area re-render flicker while a window is being dragged out (see `isSuppressPanelRelayoutOnDragOut`
				// in viewDragSession.ts): set the flag so that when move removes the view from
				// the original Panel container, the Panel side neither raises the minimum height from 77 to 350 to trigger a full-area
				// re-layout nor falls back to re-opening other containers, avoiding "the Panel flashes when dragging out".
				setSuppressPanelRelayoutOnDragOut(true);
				for (const v of viewsToOpen) {
					viewDescriptorService.moveViewToLocation(v, ViewContainerLocation.Editor, 'dnd-composite-to-window');
				}
				// The flag must be cleared only after all of the Panel's finalization decisions (close->emptyPanelCheckScheduler->autoHide/
				// autoCollapse, which all rely on suppress being true to skip) have fired.
				// The close event triggered by the move above schedules `emptyPanelCheckScheduler` for the next frame
				// (RunOnceScheduler(0)); if we used only setTimeout(0) here it would race with that in the same zero-delay queue and
				// might clear first, causing autoHide to misjudge the Panel as empty when suppress=false and
				// hide a Panel that still contains other views (such as Problems). Changed to 300ms (same lifecycle as the drag-out claim
				// release) to ensure suppress stays true throughout the finalization window and the Panel is not wrongly hidden.
				setTimeout(() => {
					setSuppressPanelRelayoutOnDragOut(false);
				}, 300);
			}, 0);
		} catch (error) {
			// swallow: opening an auxiliary window for a view is best-effort
		}
	}

	onDrop(e: IDraggedCompositeData) {
		const visibleItems = this.compositeBarModel.visibleItems;
		let targetId = undefined;
		if (visibleItems.length) {
			targetId = this.insertAtFront(this.actionBarContainer, e.eventData) ? visibleItems[0].id : visibleItems[visibleItems.length - 1].id;
		}
		this.dndHandler.drop(e.dragAndDropData, targetId, e.eventData, this.insertDropBefore);
		this.insertDropBefore = this.updateFromDragging(this.compositeBarContainer, false, false, false);
	}

	private insertAtFront(element: HTMLElement, event: DragEvent): boolean {
		const rect = element.getBoundingClientRect();
		const posX = event.clientX;
		const posY = event.clientY;

		switch (this.orientation) {
			case ActionsOrientation.HORIZONTAL:
				return posX < rect.left;
			case ActionsOrientation.VERTICAL:
				return posY < rect.top;
		}
	}

	private updateFromDragging(element: HTMLElement, showFeedback: boolean, front: boolean, isDragging: boolean): Before2D | undefined {
		element.classList.toggle('dragged-over', isDragging);
		element.classList.toggle('dragged-over-head', showFeedback && front);
		element.classList.toggle('dragged-over-tail', showFeedback && !front);

		if (!showFeedback) {
			return undefined;
		}

		return { verticallyBefore: front, horizontallyBefore: front };
	}
}

export class CompositeBar extends Widget implements ICompositeBar {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private dimension: Dimension | undefined;

	private compositeSwitcherBar: ActionBar | undefined;
	private compositeOverflowAction: CompositeOverflowActivityAction | undefined;
	private compositeOverflowActionViewItem: CompositeOverflowActivityActionViewItem | undefined;

	// When `updateCompositeSwitcher` is skipped because the bar has no dimension
	// yet (e.g. during a view-drag-out where the owning part is mid-relayout /
	// suppressed), remember that a refresh is pending so the next `layout()` with
	// a real dimension replays it. Otherwise an unpinned tab (e.g. a view dragged
	// out to its own window) lingers in the DOM as a stale duplicate tab.
	private compositeSwitcherBarNeedsUpdate = false;

	private readonly model: CompositeBarModel;
	private readonly visibleComposites: string[];
	private readonly compositeSizeInBar: Map<string, number>;

	constructor(
		items: ICompositeBarItem[],
		private readonly options: ICompositeBarOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IHostService private readonly hostService: IHostService,
	) {
		super();

		this.model = new CompositeBarModel(items, options);
		this.visibleComposites = [];
		this.compositeSizeInBar = new Map<string, number>();
		this.computeSizes(this.model.visibleItems);
	}

	getCompositeBarItems(): ICompositeBarItem[] {
		return [...this.model.items];
	}

	setCompositeBarItems(items: ICompositeBarItem[]): void {
		this.model.setItems(items);
		this.updateCompositeSwitcher(true);
	}

	getPinnedComposites(): ICompositeBarItem[] {
		return this.model.pinnedItems;
	}

	getPinnedCompositeIds(): string[] {
		return this.getPinnedComposites().map(c => c.id);
	}

	getVisibleComposites(): ICompositeBarItem[] {
		return this.model.visibleItems;
	}

	create(parent: HTMLElement): HTMLElement {
		const actionBarDiv = parent.appendChild($('.composite-bar'));
		this.compositeSwitcherBar = this._register(new ActionBar(actionBarDiv, {
			actionViewItemProvider: (action, options) => {
				if (action instanceof CompositeOverflowActivityAction) {
					return this.compositeOverflowActionViewItem;
				}
				const item = this.model.findItem(action.id);
				return item && this.instantiationService.createInstance(
					CompositeActionViewItem,
					{ ...options, draggable: this.options.isCompositeDraggable ? this.options.isCompositeDraggable(action.id) : true, colors: this.options.colors, icon: this.options.icon, hoverOptions: this.options.activityHoverOptions, compact: this.options.compact, showCloseButton: this.options.showCloseButton, closeActiveComposite: this.options.closeActiveComposite, hidePartOnLastPinnedClose: this.options.hidePartOnLastPinnedClose, hideSide: this.options.hideSide },
					action as CompositeBarAction,
					item.pinnedAction,
					item.toggleBadgeAction,
					compositeId => this.options.getContextMenuActionsForComposite(compositeId),
					() => this.getContextMenuActions(),
					this.options.dndHandler,
					this
				);
			},
			orientation: this.options.orientation,
			ariaLabel: localize('activityBarAriaLabel', "Active View Switcher"),
			ariaRole: 'tablist',
			preventLoopNavigation: this.options.preventLoopNavigation,
			triggerKeys: { keyDown: true }
		}));

		// Contextmenu for composites
		this._register(addDisposableListener(parent, EventType.CONTEXT_MENU, e => this.showContextMenu(getWindow(parent), e)));
		this._register(Gesture.addTarget(parent));
		this._register(addDisposableListener(parent, TouchEventType.Contextmenu, e => this.showContextMenu(getWindow(parent), e)));

		// Register a drop target on the whole bar to prevent forbidden feedback
		const dndCallback = new CompositeBarDndCallbacks(parent, actionBarDiv, this.model, this.options.dndHandler, this.options.orientation, this.editorGroupsService, this.hostService, this.viewDescriptorService, this.instantiationService);
		this._register(CompositeDragAndDropObserver.INSTANCE.registerTarget(parent, dndCallback));

		return actionBarDiv;
	}

	focus(index?: number): void {
		this.compositeSwitcherBar?.focus(index);
	}

	recomputeSizes(): void {
		this.computeSizes(this.model.visibleItems);
		this.updateCompositeSwitcher();
	}

	layout(dimension: Dimension): void {
		this.dimension = dimension;

		if (dimension.height === 0 || dimension.width === 0) {
			// Do not layout if not visible. Otherwise the size measurment would be computed wrongly
			return;
		}

		if (this.compositeSizeInBar.size === 0) {
			// Compute size of each composite by getting the size from the css renderer
			// Size is later used for overflow computation
			this.computeSizes(this.model.visibleItems);
		}

		this.updateCompositeSwitcher();

		// Replay a refresh that was skipped earlier because the bar had no
		// dimension (see `updateCompositeSwitcher`). This guarantees a tab that
		// was unpinned while the part was mid-relayout (e.g. a view dragged out
		// to its own window) gets removed from the DOM on the next real layout.
		if (this.compositeSwitcherBarNeedsUpdate) {
			this.compositeSwitcherBarNeedsUpdate = false;
			this.updateCompositeSwitcher();
		}
	}

	addComposite({ id, name, order, requestedIndex }: { id: string; name: string; order?: number; requestedIndex?: number }): void {
		if (this.model.add(id, name, order, requestedIndex)) {
			this.computeSizes([this.model.findItem(id)]);
			this.updateCompositeSwitcher();
		}
	}

	removeComposite(id: string): void {

		// If it pinned, unpin it first
		if (this.isPinned(id)) {
			this.unpin(id);
		}

		// Remove from the model
		if (this.model.remove(id)) {
			this.updateCompositeSwitcher();
		}
	}

	hideCompositeInternal(id: string): void {
		if (this.model.hide(id)) {
			this.resetActiveComposite(id);
			this.updateCompositeSwitcher();
		}
	}

	hideComposite(compositeId: string): void {
		this.hideCompositeInternal(compositeId);
	}

	activateComposite(id: string): void {
		const previousActiveItem = this.model.activeItem;
		if (this.model.activate(id)) {
			// Update if current composite is neither visible nor pinned
			// or previous active composite is not pinned
			if (this.visibleComposites.indexOf(id) === - 1 || (!!this.model.activeItem && !this.model.activeItem.pinned) || (previousActiveItem && !previousActiveItem.pinned)) {
				this.updateCompositeSwitcher();
			}
		}
	}

	deactivateComposite(id: string): void {
		if (this.model.deactivate()) {
			// Always refresh the switcher when the active composite is cleared.
			//
			// `model.deactivate()` unconditionally clears `activeItem` and calls
			// `activityAction.deactivate()` (which flips the `checked` *flag*), but
			// the rendered tab's `.checked` CSS class is only updated inside
			// `updateCompositeSwitcher()`. The previous guard
			// (!previousActiveItem.pinned) skipped that refresh for *pinned*
			// composites, so a closed pinned tab kept its highlighted "selected"
			// look even though the owning part had already cleared its active
			// composite. In the dual-panel layout this surfaces as the exact
			// "tab is selected but the body shows 'Drag a view here to display'"
			// bug: the side's `getActiveComposite()` is `undefined` (placeholder
			// visible) while the (pinned) Problems tab stays visually checked.
			// Refresh unconditionally to keep the tab and the content in sync.
			this.updateCompositeSwitcher();
		}
	}

	async pin(compositeId: string, open?: boolean): Promise<void> {
		if (this.model.setPinned(compositeId, true)) {
			this.updateCompositeSwitcher();

			if (open) {
				await this.options.openComposite(compositeId);
				this.activateComposite(compositeId); // Activate after opening
			}
		}
	}

	unpin(compositeId: string): void {
		if (this.model.setPinned(compositeId, false)) {

			this.updateCompositeSwitcher();

			// The bar may not have been laid out yet (e.g. it was just created
			// while its parent part is still hidden), in which case
			// `updateCompositeSwitcher` bails out early and the tab stays in the
			// DOM even though the model no longer pins it. Re-run on the next
			// tick so that once layout settles the stale tab is guaranteed to
			// be removed. This mirrors the deferred refresh used by `move`.
			setTimeout(() => this.updateCompositeSwitcher(), 0);

			this.resetActiveComposite(compositeId);
		}
	}

	areBadgesEnabled(compositeId: string): boolean {
		return this.viewDescriptorService.getViewContainerBadgeEnablementState(compositeId);
	}

	toggleBadgeEnablement(compositeId: string): void {
		this.viewDescriptorService.setViewContainerBadgeEnablementState(compositeId, !this.areBadgesEnabled(compositeId));
		this.updateCompositeSwitcher();
		const item = this.model.findItem(compositeId);
		if (item) {
			// TODO @lramos15 how do we tell the activity to re-render the badge? This triggers an onDidChange but isn't the right way to do it.
			// I could add another specific function like `activity.updateBadgeEnablement` would then the activity store the sate?
			item.activityAction.activity = item.activityAction.activity;
		}
	}

	private resetActiveComposite(compositeId: string) {
		const defaultCompositeId = this.options.getDefaultCompositeId();

		// Case: composite is not the active one or the active one is a different one
		// Solv: we do nothing
		if (!this.model.activeItem || this.model.activeItem.id !== compositeId) {
			return;
		}

		// Deactivate itself
		this.deactivateComposite(compositeId);

		// For sub-parts (e.g. one side of the dual-panel layout) closing the
		// last composite must clear the sub-part rather than auto-open the
		// *default* (the parent part's default) composite, which would
		// re-populate the side we just closed.
		//
		// However, when the side still has OTHER visible composites we must
		// switch to one of them instead of leaving the side empty: otherwise the
		// owning part's deferred "side became empty" fallback scheduler would
		// fire on the next tick and re-open a (possibly different) container,
		// producing the brief "flash" where the closed view's body is replaced
		// and then the side is re-populated. Switching here keeps the previously
		// shown sibling view active (no empty frame, no flicker). Only when there
		// is genuinely no other visible composite do we clear the sub-part and
		// let the owner collapse it (the side's own close button has already
		// marked the side hidden via `hideSide`, so the fallback is suppressed).
		if (this.options.hidePartOnLastPinnedClose === false) {
			const otherVisible = this.visibleComposites.find(cid => cid !== compositeId);
			if (otherVisible) {
				this.options.openComposite(otherVisible);
			} else if (!this.model.activeItem) {
				this.options.onDidCloseActiveComposite?.();
			}
			return;
		}

		// Case: composite is not the default composite and default composite is still showing
		// Solv: we open the default composite
		if (defaultCompositeId && defaultCompositeId !== compositeId && this.isPinned(defaultCompositeId)) {
			this.options.openComposite(defaultCompositeId, true);
		}

		// Case: we closed the default composite
		// Solv: we open the next visible composite from top
		else {
			const visibleComposite = this.visibleComposites.find(cid => cid !== compositeId);
			if (visibleComposite) {
				this.options.openComposite(visibleComposite);
			}
		}

		// If the bar still has no active composite after the attempts above, the
		// owning part's active composite content (toolbar, body) would otherwise
		// stay rendered even though no tab backs it. Notify the owner so it can
		// clear its own active composite. The owner is the only one who knows
		// whether to also hide the whole part - the bar never should.
		if (!this.model.activeItem) {
			this.options.onDidCloseActiveComposite?.();
		}
	}

	isPinned(compositeId: string): boolean {
		const item = this.model.findItem(compositeId);
		return item?.pinned;
	}

	move(compositeId: string, toCompositeId: string, before?: boolean): void {
		if (before !== undefined) {
			const fromIndex = this.model.items.findIndex(c => c.id === compositeId);
			let toIndex = this.model.items.findIndex(c => c.id === toCompositeId);

			if (fromIndex >= 0 && toIndex >= 0) {
				if (!before && fromIndex > toIndex) {
					toIndex++;
				}

				if (before && fromIndex < toIndex) {
					toIndex--;
				}

				if (toIndex < this.model.items.length && toIndex >= 0 && toIndex !== fromIndex) {
					if (this.model.move(this.model.items[fromIndex].id, this.model.items[toIndex].id)) {
						// timeout helps to prevent artifacts from showing up
						setTimeout(() => this.updateCompositeSwitcher(), 0);
					}
				}
			}
		} else {
			if (this.model.move(compositeId, toCompositeId)) {
				// timeout helps to prevent artifacts from showing up
				setTimeout(() => this.updateCompositeSwitcher(), 0);
			}
		}
	}

	getAction(compositeId: string): CompositeBarAction {
		const item = this.model.findItem(compositeId);

		return item?.activityAction;
	}

	private computeSizes(items: ICompositeBarModelItem[]): void {
		const size = this.options.compositeSize;
		if (size) {
			items.forEach(composite => this.compositeSizeInBar.set(composite.id, size));
		} else {
			const compositeSwitcherBar = this.compositeSwitcherBar;
			if (compositeSwitcherBar && this.dimension && this.dimension.height !== 0 && this.dimension.width !== 0) {

				// Compute sizes only if visible. Otherwise the size measurment would be computed wrongly.
				const currentItemsLength = compositeSwitcherBar.viewItems.length;
				compositeSwitcherBar.push(items.map(composite => composite.activityAction));
				items.map((composite, index) => this.compositeSizeInBar.set(composite.id, this.options.orientation === ActionsOrientation.VERTICAL
					? compositeSwitcherBar.getHeight(currentItemsLength + index)
					: compositeSwitcherBar.getWidth(currentItemsLength + index)
				));
				items.forEach(() => compositeSwitcherBar.pull(compositeSwitcherBar.viewItems.length - 1));
			}
		}
	}

	private updateCompositeSwitcher(donotTrigger?: boolean): void {
		const compositeSwitcherBar = this.compositeSwitcherBar;
		if (!compositeSwitcherBar) {
			return; // We have not been created yet so there is nothing to update.
		}

		if (!this.dimension) {
			// The bar has no dimension yet (it may still be hidden or mid-relayout,
			// e.g. while a view is being dragged out to its own window and the owning
			// part's relayout is suppressed). Do not drop the request -- remember it
			// so the next `layout()` with a real dimension replays the refresh and
			// removes any stale (unpinned) tab instead of letting it linger.
			this.compositeSwitcherBarNeedsUpdate = true;
			return;
		}

		let compositesToShow = this.model.visibleItems.filter(item =>
			item.pinned
			|| (this.model.activeItem && this.model.activeItem.id === item.id) /* Show the active composite even if it is not pinned */
		).map(item => item.id);

		// When overflow is disabled, show all composites without size constraints
		if (this.options.disableOverflow) {
			// Remove any existing overflow action
			if (this.compositeOverflowAction) {
				const overflowIndex = this.visibleComposites.indexOf(this.compositeOverflowAction.id);
				if (overflowIndex !== -1) {
					compositeSwitcherBar.pull(overflowIndex);
					this.visibleComposites.splice(overflowIndex, 1);
				}

				this.compositeOverflowAction.dispose();
				this.compositeOverflowAction = undefined;

				this.compositeOverflowActionViewItem?.dispose();
				this.compositeOverflowActionViewItem = undefined;
			}

			// Pull out composites that got hidden
			const compositesToRemove: number[] = [];
			this.visibleComposites.forEach((compositeId, index) => {
				if (!compositesToShow.includes(compositeId)) {
					compositesToRemove.push(index);
				}
			});
			compositesToRemove.reverse().forEach(index => {
				compositeSwitcherBar.pull(index);
				this.visibleComposites.splice(index, 1);
			});

			// Update the positions of the composites - show all of them
			compositesToShow.forEach((compositeId, newIndex) => {
				const currentIndex = this.visibleComposites.indexOf(compositeId);
				if (newIndex !== currentIndex) {
					if (currentIndex !== -1) {
						compositeSwitcherBar.pull(currentIndex);
						this.visibleComposites.splice(currentIndex, 1);
					}

					compositeSwitcherBar.push(this.model.findItem(compositeId).activityAction, { label: true, icon: this.options.icon, index: newIndex });
					this.visibleComposites.splice(newIndex, 0, compositeId);
				}
			});

			if (!donotTrigger) {
				this._onDidChange.fire();
			}
			return;
		}

		// Ensure we are not showing more composites than we have height for
		let maxVisible = compositesToShow.length;
		const totalComposites = compositesToShow.length;
		let size = 0;
		const limit = this.options.orientation === ActionsOrientation.VERTICAL ? this.dimension.height : this.dimension.width;

		// Add composites while they fit
		for (let i = 0; i < compositesToShow.length; i++) {
			const compositeSize = this.compositeSizeInBar.get(compositesToShow[i])!;
			// Adding this composite will overflow available size, so don't
			if (size + compositeSize > limit) {
				maxVisible = i;
				break;
			}

			size += compositeSize;
		}

		// Remove the tail of composites that did not fit
		if (totalComposites > maxVisible) {
			compositesToShow = compositesToShow.slice(0, maxVisible);
		}

		// We are overflowing, add the overflow size
		if (totalComposites > compositesToShow.length) {
			size += this.options.overflowActionSize;
		}

		// Check if we need to make extra room for the overflow action
		while (size > limit && compositesToShow.length) {
			const removedComposite = compositesToShow.length > 1 && compositesToShow[compositesToShow.length - 1] === this.model.activeItem?.id ?
				compositesToShow.splice(compositesToShow.length - 2, 1)[0] : compositesToShow.pop();
			size -= this.compositeSizeInBar.get(removedComposite!)!;
		}

		// Remove the overflow action if there are no overflows
		if (totalComposites === compositesToShow.length && this.compositeOverflowAction) {
			compositeSwitcherBar.pull(compositeSwitcherBar.length() - 1);

			this.compositeOverflowAction.dispose();
			this.compositeOverflowAction = undefined;

			this.compositeOverflowActionViewItem?.dispose();
			this.compositeOverflowActionViewItem = undefined;
		}

		// Pull out composites that overflow or got hidden
		const compositesToRemove: number[] = [];
		this.visibleComposites.forEach((compositeId, index) => {
			if (!compositesToShow.includes(compositeId)) {
				compositesToRemove.push(index);
			}
		});
		compositesToRemove.reverse().forEach(index => {
			compositeSwitcherBar.pull(index);
			this.visibleComposites.splice(index, 1);
		});

		// Update the positions of the composites
		compositesToShow.forEach((compositeId, newIndex) => {
			const currentIndex = this.visibleComposites.indexOf(compositeId);
			if (newIndex !== currentIndex) {
				if (currentIndex !== -1) {
					compositeSwitcherBar.pull(currentIndex);
					this.visibleComposites.splice(currentIndex, 1);
				}

				compositeSwitcherBar.push(this.model.findItem(compositeId).activityAction, { label: true, icon: this.options.icon, index: newIndex });
				this.visibleComposites.splice(newIndex, 0, compositeId);
			}
		});

		// Add overflow action as needed
		if (totalComposites > compositesToShow.length && !this.compositeOverflowAction) {
			this.compositeOverflowAction = this._register(this.instantiationService.createInstance(CompositeOverflowActivityAction, () => {
				this.compositeOverflowActionViewItem?.showMenu();
			}));
			this.compositeOverflowActionViewItem = this._register(this.instantiationService.createInstance(
				CompositeOverflowActivityActionViewItem,
				this.compositeOverflowAction,
				() => this.getOverflowingComposites(),
				() => this.model.activeItem ? this.model.activeItem.id : undefined,
				compositeId => {
					const item = this.model.findItem(compositeId);
					return item?.activity[0]?.badge;
				},
				this.options.getOnCompositeClickAction,
				this.options.colors,
				this.options.activityHoverOptions
			));

			compositeSwitcherBar.push(this.compositeOverflowAction, { label: false, icon: true });
		}

		if (!donotTrigger) {
			this._onDidChange.fire();
		}
	}

	private getOverflowingComposites(): { id: string; name?: string }[] {
		let overflowingIds = this.model.visibleItems.filter(item => item.pinned).map(item => item.id);

		// Show the active composite even if it is not pinned
		if (this.model.activeItem && !this.model.activeItem.pinned) {
			overflowingIds.push(this.model.activeItem.id);
		}

		overflowingIds = overflowingIds.filter(compositeId => !this.visibleComposites.includes(compositeId));
		return this.model.visibleItems.filter(c => overflowingIds.includes(c.id)).map(item => { return { id: item.id, name: this.getAction(item.id)?.label || item.name }; });
	}

	private showContextMenu(targetWindow: Window, e: MouseEvent | GestureEvent): void {
		EventHelper.stop(e, true);

		const event = new StandardMouseEvent(targetWindow, e);
		this.contextMenuService.showContextMenu({
			getAnchor: () => event,
			getActions: () => this.getContextMenuActions(e)
		});
	}

	getContextMenuActions(e?: MouseEvent | GestureEvent): IAction[] {
		const actions: IAction[] = this.model.visibleItems
			.map(({ id, name, activityAction }) => {
				const isPinned = this.isPinned(id);
				return toAction({
					id,
					label: this.getAction(id).label || name || id,
					checked: isPinned,
					enabled: activityAction.enabled && (!isPinned || this.getPinnedCompositeIds().length > 1),
					run: () => {
						if (this.isPinned(id)) {
							this.unpin(id);
						} else {
							this.pin(id, true);
						}
					}
				});
			});

		this.options.fillExtraContextMenuActions(actions, e);

		return actions;
	}
}

interface ICompositeBarModelItem extends ICompositeBarItem {
	readonly activityAction: CompositeBarAction;
	readonly pinnedAction: IAction;
	readonly toggleBadgeAction: IAction;
	readonly activity: IActivity[];
}

class CompositeBarModel {

	private _items: ICompositeBarModelItem[] = [];
	get items(): ICompositeBarModelItem[] { return this._items; }

	private readonly options: ICompositeBarOptions;

	activeItem?: ICompositeBarModelItem;

	constructor(
		items: ICompositeBarItem[],
		options: ICompositeBarOptions
	) {
		this.options = options;
		this.setItems(items);
	}

	setItems(items: ICompositeBarItem[]): void {
		this._items = [];
		this._items = items
			.map(i => this.createCompositeBarItem(i.id, i.name, i.order, i.pinned, i.visible));
	}

	get visibleItems(): ICompositeBarModelItem[] {
		return this.items.filter(item => item.visible);
	}

	get pinnedItems(): ICompositeBarModelItem[] {
		return this.items.filter(item => item.visible && item.pinned);
	}

	private createCompositeBarItem(id: string, name: string | undefined, order: number | undefined, pinned: boolean, visible: boolean): ICompositeBarModelItem {
		const options = this.options;
		return {
			id, name, pinned, order, visible,
			activity: [],
			get activityAction() {
				return options.getActivityAction(id);
			},
			get pinnedAction() {
				return options.getCompositePinnedAction(id);
			},
			get toggleBadgeAction() {
				return options.getCompositeBadgeAction(id);
			}
		};
	}

	add(id: string, name: string, order: number | undefined, requestedIndex: number | undefined): boolean {
		const item = this.findItem(id);
		if (item) {
			let changed = false;
			item.name = name;
			if (!isUndefinedOrNull(order)) {
				changed = item.order !== order;
				item.order = order;
			}
			if (!item.visible) {
				item.visible = true;
				changed = true;
			}

			return changed;
		} else {
			const item = this.createCompositeBarItem(id, name, order, true, true);
			if (!isUndefinedOrNull(requestedIndex)) {
				let index = 0;
				let rIndex = requestedIndex;
				while (rIndex > 0 && index < this.items.length) {
					if (this.items[index++].visible) {
						rIndex--;
					}
				}

				this.items.splice(index, 0, item);
			} else if (isUndefinedOrNull(order)) {
				this.items.push(item);
			} else {
				let index = 0;
				while (index < this.items.length && typeof this.items[index].order === 'number' && this.items[index].order! < order) {
					index++;
				}
				this.items.splice(index, 0, item);
			}

			return true;
		}
	}

	remove(id: string): boolean {
		for (let index = 0; index < this.items.length; index++) {
			if (this.items[index].id === id) {
				this.items.splice(index, 1);
				return true;
			}
		}
		return false;
	}

	hide(id: string): boolean {
		for (const item of this.items) {
			if (item.id === id) {
				if (item.visible) {
					item.visible = false;
					return true;
				}
				return false;
			}
		}
		return false;
	}

	move(compositeId: string, toCompositeId: string): boolean {

		const fromIndex = this.findIndex(compositeId);
		const toIndex = this.findIndex(toCompositeId);

		// Make sure both items are known to the model
		if (fromIndex === -1 || toIndex === -1) {
			return false;
		}

		const sourceItem = this.items.splice(fromIndex, 1)[0];
		this.items.splice(toIndex, 0, sourceItem);

		// Make sure a moved composite gets pinned
		sourceItem.pinned = true;

		return true;
	}

	setPinned(id: string, pinned: boolean): boolean {
		for (const item of this.items) {
			if (item.id === id) {
				if (item.pinned !== pinned) {
					item.pinned = pinned;
					return true;
				}
				return false;
			}
		}
		return false;
	}

	activate(id: string): boolean {
		if (!this.activeItem || this.activeItem.id !== id) {
			if (this.activeItem) {
				this.deactivate();
			}
			for (const item of this.items) {
				if (item.id === id) {
					this.activeItem = item;
					this.activeItem.activityAction.activate();
					return true;
				}
			}
		}
		return false;
	}

	deactivate(): boolean {
		if (this.activeItem) {
			this.activeItem.activityAction.deactivate();
			this.activeItem = undefined;
			return true;
		}
		return false;
	}

	findItem(id: string): ICompositeBarModelItem {
		return this.items.filter(item => item.id === id)[0];
	}

	private findIndex(id: string): number {
		for (let index = 0; index < this.items.length; index++) {
			if (this.items[index].id === id) {
				return index;
			}
		}

		return -1;
	}
}
