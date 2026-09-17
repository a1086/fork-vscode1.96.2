/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Module-level guard: de-duplicate "the same drag event opening a window multiple times".
 *
 * Background:
 * - `CompositeDragAndDropObserver.INSTANCE` is a singleton; the bar container (`registerTarget`) and
 *   each tab inside the bar (`registerDraggable`) both subscribe to events via `_onDragEnd`.
 *   When dragend bubbles, the tab's and the bar's `DragAndDropObserver` both fire
 *   `_onDragEnd.fire`, so the bar's `CompositeBarDndCallbacks.onDragEnd` is called twice.
 * - Panel and Aux Bar each have their own `CompositeBar`/`CompositeBarDndCallbacks` instance,
 *   and their onDragEnd fires again; moreover the native editor tabs drag-out path may open
 *   yet another window after `moveViewToLocation(Editor)`.
 * - An instance-level boolean alone cannot de-duplicate across instances, so we use a process-wide "in-progress set" guard.
 *
 * Design highlights (v5 - fixing the race condition):
 * - Use a synchronous lock + a "set of viewIds currently being handled" as the de-duplication basis:
 *   multiple onDragEnd callbacks for the same drag (from different CompositeBarDndCallbacks instances,
 *   registerTarget / registerDraggable, Panel / Aux Bar) pass the same viewId;
 *   the first handler adds the viewId to the set and returns true, and later ones see it is already in the set and return false.
 * - Key fix: `add()` and `has()` must complete within the same synchronous execution frame, with no await in between.
 *   Although the v4 version used a Set, the caller had an `await getCursorScreenPoint()` between
 *   `tryClaimViewDragSession()` returning true and actually running `openInAuxiliaryWindow()`;
 *   once that await yielded execution, another onDragEnd callback could pass the `has()`
 *   check before the `add()`, opening two windows at once (this is the root cause of the "two separate Watch windows" in the screenshot).
 * - Solution: move the claim marker into the caller's synchronous code section (before the await), ensuring
 *   the first callback to arrive takes the marker immediately and all others see the taken state after any await point.
 * - After handling finishes, the caller clears the corresponding viewId (in onDragEnd's finally, delayed
 *   until this round's async cleanup is done).
 * - This guarantees: the same drag opens only one window; drags of different views (different viewIds) do not affect each other
 *   and can each be dragged out into their own separate window.
 */

import { Emitter } from '../../../base/common/event.js';

/** Set of viewIds currently being handled (window opening not yet finished) */
const __pendingViews = new Set<string>();

export function nextViewDragSession(): number {
	// no-op: kept for caller compatibility, but no longer relied upon
	return Date.now();
}

/**
 * Returns the current in-progress drag sessionId (kept for compatibility).
 */
export function currentViewDragSession(): number {
	return Date.now();
}

/**
 * Try to claim a view's window-opening right. Returns true if opening may proceed, false if it should be skipped.
 *
 * This function is **synchronous**: `Set.has()` and `Set.add()` complete in the same execution frame,
 * leaving no chance for another coroutine/callback to interleave, thus eliminating the race condition.
 *
 * @param viewId the view ID to open (or composite container ID), formatted as `${type}:${id}`
 */
export function tryClaimViewDragSession(viewId: string): boolean {
	if (__pendingViews.has(viewId)) {
		// This viewId's current round of window opening is still being handled (same-origin multiple onDragEnd callbacks,
		// or a second window from the native editor tabs path), so skip it.
		return false;
	}

	// Mark as in-progress (synchronous, takes effect immediately)
	__pendingViews.add(viewId);
	return true;
}

/**
 * Mark the window-opening operation for the given viewId as finished, allowing it to be claimed again later.
 * Should be called after openInAuxiliaryWindow finishes successfully (including the delayed release).
 */
export function releaseViewDragSession(viewId: string): void {
	__pendingViews.delete(viewId);
}

/**
 * Suppress the Panel area re-render flicker while dragging a view out to a window.
 *
 * Background (root cause of "dragging a view out of Panel / Aux Bar to a standalone window makes the Panel area flash"):
 * the drag-out path uses `setTimeout(() => moveViewToLocation(v, Editor), 0)` at the end of
 * `compositeBar.ts#openInAuxiliaryWindow` to move the view away from the original Panel container.
 * That move triggers a series of re-renders on the Panel side:
 *   1. The container becomes empty -> `PanelPart.updatePanelMinimumHeight()` raises the Panel minimum height from 77 to
 *      350 and fires `_onDidChange` -> the whole Panel area (including the editor area) is re-laid-out: the editor area is
 *      squeezed then released, showing up as a clear "flash / interface re-render".
 *   2. `sideFallbackSchedulers`, delayed one frame inside `PanelPart.createSide`, re-opens the "leftmost first"
 *      other container on this side -> this side goes from blank to showing another view, another flash.
 *
 * Fix: set this flag during the drag-out move, so `PanelPart`
 *   - skips the "empty Panel -> 350" minimum-height raise and re-layout (the Panel keeps its current height and no longer squeezes the editor area);
 *   - skips the fallback that automatically re-opens other containers (the dragged-away side naturally becomes an empty drop target, which is the expected "view dragged away" state).
 * Clear the flag after the move finishes, ensuring normal closing/dragging-away of views still follows the original fallback behavior.
 */
let __suppressPanelRelayoutOnDragOut = false;

const _onSuppressPanelRelayoutOnDragOutChange = new Emitter<boolean>();

export function setSuppressPanelRelayoutOnDragOut(value: boolean): void {
	if (__suppressPanelRelayoutOnDragOut === value) {
		return;
	}
	__suppressPanelRelayoutOnDragOut = value;
	_onSuppressPanelRelayoutOnDragOutChange.fire(value);
}

export function isSuppressPanelRelayoutOnDragOut(): boolean {
	return __suppressPanelRelayoutOnDragOut;
}

/**
 * Fired when the suppress-panel-relayout-on-drag-out flag changes. The owning
 * part (Panel / Auxiliary Bar) uses this to re-run its composite-bar layout
 * once the suppression is lifted, so any composite tab that was unpinned while
 * the part was mid-relayout (e.g. a view dragged out to its own window) gets
 * removed from the DOM instead of lingering as a stale duplicate tab.
 */
export function onSuppressPanelRelayoutOnDragOutChange(handler: (value: boolean) => void): { dispose(): void } {
	return _onSuppressPanelRelayoutOnDragOutChange.event(handler);
}

let __viewDragOutPanelSide: 'left' | 'right' | undefined;

export function setViewDragOutPanelSide(side: 'left' | 'right' | undefined): void {
	__viewDragOutPanelSide = side;
}

export function getViewDragOutPanelSide(): 'left' | 'right' | undefined {
	return __viewDragOutPanelSide;
}

const __viewDragOutViewSides = new Map<string, 'left' | 'right'>();

export function setViewDragOutPanelSideForView(viewId: string, side: 'left' | 'right' | undefined): void {
	if (side) {
		__viewDragOutViewSides.set(viewId, side);
	} else {
		__viewDragOutViewSides.delete(viewId);
	}
}

export function getViewDragOutPanelSideForView(viewId: string): 'left' | 'right' | undefined {
	return __viewDragOutViewSides.get(viewId);
}
