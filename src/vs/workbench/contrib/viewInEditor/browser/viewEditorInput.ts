/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { URI } from '../../../../base/common/uri.js';
import { IViewDescriptor, IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';

export const VIEW_EDITOR_INPUT_TYPE_ID = 'workbench.editors.viewEditorInput';

const restartRecoveryViewIds = new Set<string>();

export function markViewEditorInputForRestartRecovery(viewId: string): void {
	restartRecoveryViewIds.add(viewId);
}

export function isViewEditorInputMarkedForRestartRecovery(viewId: string): boolean {
	return restartRecoveryViewIds.delete(viewId);
}

/**
 * Editor input that hosts a workbench view (ViewPane) inside the editor area.
 * This is the P0 spike implementation for "drag a view (OUTLINE/PROBLEMS/PORTS) into the editor".
 */
export class ViewEditorInput extends EditorInput {

	static readonly ID = VIEW_EDITOR_INPUT_TYPE_ID;

	private readonly _resource: URI;

	constructor(
		public readonly viewId: string,
		public readonly originalLocation: ViewContainerLocation | undefined,
		public readonly originalContainerId: string | undefined,
		public readonly originalIndex: number | undefined,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService
	) {
		super();
		this._resource = URI.from({ scheme: 'vscode-view', path: `/${viewId}` });
	}

	override get typeId(): string {
		return ViewEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return this.typeId;
	}

	override get resource(): URI | undefined {
		return this._resource;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton | super.capabilities;
	}

	override getName(): string {
		const descriptor = this.viewDescriptorService.getViewDescriptorById(this.viewId);
		return descriptor?.name.value ?? this.viewId;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}

		return other instanceof ViewEditorInput && other.viewId === this.viewId;
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this._resource,
			options: {
				override: ViewEditorInput.ID
			}
		};
	}
}

/**
 * Restore a view hosted in the Editor area back to its original bar (Panel / Aux Bar), and after restoring
 * close the editor tab that hosts it.
 *
 * Key scenario (root cause of "appears in both panel and editor after closing a dragged-out floating window"):
 * when an auxiliary window is closed, VS Code's native `AuxiliaryEditorPartImpl.close()` calls
 * `mergeGroupsToMainPart()`, which moves the `ViewEditorInput`s in the auxiliary window as a whole to
 * the main window's editor area, and the main window then re-hosts the view via `setInput` -- so a copy of the Terminal
 * lingers in the editor area. If we do not restore first and then close the tab, the copy in the Panel (moved back by this function)
 * and the copy in the editor area (merged over) would exist at the same time.
 *
 * So the auxiliary window close flow must call this function before `mergeGroupsToMainPart`: first move
 * the view back to its original bar so it leaves the Editor area, then close the editor tab in the auxiliary window,
 * so that during merge there is no editor to move and the main window shows no Terminal duplicate.
 *
 * `moveViewToLocation` is idempotent: if the view is no longer in the Editor area (e.g. already restored early by
 * a reverse-drag), it will not be moved again incorrectly.
 */
export function restoreViewEditorInputToOriginalLocation(
	input: ViewEditorInput,
	viewDescriptorService: IViewDescriptorService,
	closeEditor?: () => void
): void {
	const descriptor: IViewDescriptor | null = viewDescriptorService.getViewDescriptorById(input.viewId);
	if (!descriptor) {
		return;
	}

	const currentLocation = viewDescriptorService.getViewLocationById(input.viewId);
	// Restore semantics: "whichever area a view was dragged out of into a standalone window, closing the window returns it to that area".
	//
	// Distinguish the two drag-out paths:
	// 1) Dragged directly out of Panel/Aux into a window (compositeBar.ts): input keeps
	//    `originalContainerId` / `originalLocation` (pointing at the original bar). On close, even though the view has been
	//    moved into the Editor area, it should still be restored to the original bar -> use `originalLocation`.
	// 2) Dragged into the Editor area first, then out of the Editor into a window: when the auxiliary window closes, VS Code uses a
	//    **rebuilt** ViewEditorInput (`originalContainerId` is undefined, because that field
	//    is a runtime constructor argument and is not carried across serialization). The view was indeed dragged out of the Editor, so it should
	//    stay in the Editor area -> the restore target is `currentLocation`.
	//
	// Decision: when input has no valid originalContainerId (i.e. it is a path-2 rebuilt instance)
	// the restore target falls back to currentLocation (stay in the current Editor area); otherwise use
	// originalLocation (back to the original bar).
	const hasOriginalContainer = !!input.originalContainerId;
	const targetLocation = hasOriginalContainer
		? (input.originalLocation ?? ViewContainerLocation.Panel)
		: (currentLocation ?? input.originalLocation ?? ViewContainerLocation.Panel);
	let movedOutOfEditor = false;
	if (currentLocation === null || currentLocation !== targetLocation) {
		// Prefer moving the view back to the container it originally belonged to (preserving the original bar and container grouping),
		// rather than using moveViewToLocation (which would create a new container and place it at the very top).
		const originalContainer = input.originalContainerId
			? viewDescriptorService.getViewContainerById(input.originalContainerId)
			: null;
		if (originalContainer) {
			viewDescriptorService.moveViewsToContainer([descriptor], originalContainer, undefined, 'restore-view-editor');
		} else {
			viewDescriptorService.moveViewToLocation(descriptor, targetLocation, 'restore-view-editor');
		}
		movedOutOfEditor = true;
	}

	// Restore the view's original ordinal position within the container. moveViewsToContainer appends the view to
	// the end of the container by default, so when the dragged-out view is a child such as WATCH/Call Stack in the middle of the Debug container,
	// after closing the window and restoring it jumps to the top of the container. Here we use originalIndex to insert the view back into place.
	restoreViewIndex(input, viewDescriptorService);

	// Close the editor tab hosting the view only when the view was actually moved out of the Editor area (back to the original bar),
	// to avoid a lingering copy in the main window's editor area.
	// If the view just stays in the Editor area (e.g. the "dragged out of Editor into a window, so on close it should return to Editor"
	// path: targetLocation === currentLocation === Editor, which did not trigger the move above),
	// then we must **not** close the editor tab -- otherwise no editor hosts the view and it would simply "disappear".
	// In that case, mergeGroupsToMainPart on auxiliary window close moves the editor back to the main window to keep hosting it.
	if (movedOutOfEditor) {
		closeEditor?.();
	}
}

/**
 * Insert a view that has been restored to its original container back into its original ordinal position within the container.
 *
 * Root cause: `moveViewsToContainer` appends the view to the end of the container when restoring on floating-window close,
 * so child views in the middle of the Debug container such as WATCH / Call Stack get placed at the top,
 * showing up as "the view did not return to its original position after closing".
 *
 * Fix: compute the target position with `originalIndex` -- take the neighboring view at `originalIndex` in the original container
 * as an anchor, and call `viewContainerModel.move` to insert the current view before/after the anchor,
 * precisely restoring the ordering from before the drag-out. `move` internally updates `state.order` and broadcasts the change.
 */
export function restoreViewIndex(
	input: ViewEditorInput,
	viewDescriptorService: IViewDescriptorService
): void {
	const originalIndex = input.originalIndex;
	if (originalIndex === undefined || originalIndex < 0) {
		return;
	}

	const container = input.originalContainerId
		? viewDescriptorService.getViewContainerById(input.originalContainerId)
		: null;
	if (!container) {
		return;
	}

	const model = viewDescriptorService.getViewContainerModel(container);
	if (!model) {
		return;
	}

	// The current view's actual index within the container (it should be among them after restoring).
	const currentIndex = model.allViewDescriptors.findIndex(v => v.id === input.viewId);
	if (currentIndex === -1) {
		return;
	}

	// Already at the target position, no move needed.
	if (currentIndex === originalIndex) {
		return;
	}

	// Take the view id adjacent to the target position as the anchor:
	// - If originalIndex falls within the container length, use the view currently at that position as the anchor and move before it.
	// - If originalIndex is out of range (should not happen in theory), fall back to inserting at the end (after the last view).
	const all = model.allViewDescriptors;
	const anchorIndex = Math.min(originalIndex, all.length - 1);
	const anchor = all[anchorIndex];
	if (!anchor || anchor.id === input.viewId) {
		return;
	}

	// move(from, to): move the view from currentIndex to anchorIndex.
	// When currentIndex < anchorIndex, moving before the anchor lands exactly back at originalIndex;
	// when currentIndex > anchorIndex, moving before the anchor also lands exactly at originalIndex.
	model.move(input.viewId, anchor.id);
}
