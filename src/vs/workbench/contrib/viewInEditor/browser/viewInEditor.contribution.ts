/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { IEditorPaneRegistry, EditorPaneDescriptor } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ViewEditorInput, markViewEditorInputForRestartRecovery } from './viewEditorInput.js';
import { ViewEditorPane } from './viewEditorPane.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IHostService } from '../../../services/host/browser/host.js';

interface ISerializedViewEditorInput {
	readonly viewId: string;
	readonly originalLocation: number | undefined;
}

class ViewEditorInputSerializer implements IEditorSerializer {

	canSerialize(): boolean {
		return true;
	}

	serialize(input: ViewEditorInput): string {
		const state: ISerializedViewEditorInput = {
			viewId: input.viewId,
			originalLocation: input.originalLocation
		};
		return JSON.stringify(state);
	}

	deserialize(instantiationService: IInstantiationService, serialized: string): ViewEditorInput {
		let viewId: string;
		let originalLocation: ViewContainerLocation | undefined;
		try {
			const state: ISerializedViewEditorInput = JSON.parse(serialized);
			viewId = state.viewId;
			originalLocation = state.originalLocation;
		} catch {
			viewId = serialized;
			originalLocation = undefined;
		}

		// Restart recovery: the Editor tab is re-opened and calls `ViewEditorPane.setInput` to keep hosting the
		// view, so here we must **never** proactively move the view out of the Editor to restore it.
		//
		// The old implementation called `moveViewToLocation(..., originalLocation)` here, intending to "restore the original bar after refresh".
		// But that call is asynchronous: it first removes the view's current ownership and then attaches it to the target location, while `deserialize`
		// returns `ViewEditorInput` right after, and the Editor tab calls `setInput` immediately; at that moment the view is in the "no container"
		// intermediate state, so `getViewContainerByViewId` returns undefined -> throwing
		// "No view container found for view id". This is the root cause of the editor error on refresh.
		//
		// Correct semantics: the view's location was already Editor when the workbench state was last saved (written by
		// `moveViewToLocation(..., Editor)` on drag-in), so after reload it can simply be hosted by the Editor tab.
		// Restoring to the original bar only happens when the view truly leaves the Editor (closing the tab / closing the floating window / reverse drag-out),
		// which is handled by `ViewEditorPane.clearInput` / `dispose` / `registerReverseDrag.onDragEnd`.
		//
		// The only fallback: if the view currently does not belong to any container (an abnormal state), attach it back to the Editor
		// so that `setInput` can find a container, rather than restoring it to the Panel (which would still conflict with the Editor tab).
		instantiationService.invokeFunction(accessor => {
			const viewDescriptorService = accessor.get(IViewDescriptorService);
			const descriptor = viewDescriptorService.getViewDescriptorById(viewId);
			if (descriptor && !viewDescriptorService.getViewContainerByViewId(viewId)) {
				viewDescriptorService.moveViewToLocation(descriptor, ViewContainerLocation.Editor, 'restore-editor');
			}
		});

		markViewEditorInputForRestartRecovery(viewId);

		return instantiationService.createInstance(ViewEditorInput, viewId, originalLocation, undefined, undefined);
	}
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)
	.registerEditorPane(
		EditorPaneDescriptor.create(ViewEditorPane, ViewEditorPane.ID, 'View'),
		[new SyncDescriptor(ViewEditorInput)]
	);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(ViewEditorInput.ID, ViewEditorInputSerializer);

//#region Phase 1' technical validation spike (internal command, not exposed)
//
// Purpose: verify whether `ViewPane` / `ViewEditorPane` can render correctly in an auxiliary window
// (whether `getActiveWindow()` gets confused, whether the context menu pops up in the main window, etc.).
// This command is only for validation and is not registered to the command palette / context menu / title menu, so it is not exposed to end users.
// Once validated, the Phase 3 `compositeBar.ts` drag path takes over and this command can be removed.
//
// How to trigger (for developers): run from the developer console
//   await require('vs/platform/commands/common/commands').CommandsRegistry.executeCommand('_spike.openViewInAuxiliaryWindow', 'workbench.panel.problems')

interface IOpenViewInAuxiliaryWindowArgs {
	readonly viewId: string;
}

CommandsRegistry.registerCommand('_spike.openViewInAuxiliaryWindow', async (accessor: ServicesAccessor, args: IOpenViewInAuxiliaryWindowArgs) => {
	const editorGroupsService = accessor.get(IEditorGroupsService);
	const hostService = accessor.get(IHostService);
	const viewDescriptorService = accessor.get(IViewDescriptorService);

	const viewId = args?.viewId;
	if (!viewId) {
		throw new Error('[spike] missing viewId argument');
	}

	const descriptor = viewDescriptorService.getViewDescriptorById(viewId);
	if (!descriptor) {
		throw new Error('[spike] no view descriptor for: ' + viewId);
	}

	// Use the current cursor screen position as the new window bounds (cf. editorTabsControl#maybeCreateAuxiliaryEditorPartAt).
	const screenPoint = await hostService.getCursorScreenPoint();
	const bounds = screenPoint
		? { x: screenPoint.point.x, y: screenPoint.point.y }
		: undefined;

	const auxiliaryEditorPart = await editorGroupsService.createAuxiliaryEditorPart({ bounds });
	const targetGroup = auxiliaryEditorPart.activeGroup;

	// Record the view's origin location to allow later Phase 4 restore.
	const originalLocation = viewDescriptorService.getViewLocationById(viewId) ?? undefined;

	const input = accessor.get(IInstantiationService).createInstance(ViewEditorInput, viewId, originalLocation, undefined, undefined);
	await targetGroup.openEditor(input, { pinned: true });
	targetGroup.focus();

	// Remove the view from its original Panel / Aux Bar (option A: hosted inside the floating window, no longer shown in the original bar).
	viewDescriptorService.moveViewToLocation(descriptor, ViewContainerLocation.Editor, 'spike-drag-out');

	return auxiliaryEditorPart;
});
//#endregion
