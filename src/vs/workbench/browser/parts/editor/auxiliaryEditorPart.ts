/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onDidChangeFullscreen } from '../../../../base/browser/browser.js';
import { hide, show } from '../../../../base/browser/dom.js';
import { timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { isNative } from '../../../../base/common/platform.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { hasCustomTitlebar } from '../../../../platform/window/common/window.js';
import { IEditorGroupView, IEditorPartsView } from './editor.js';
import { EditorPart, IEditorPartUIState } from './editorPart.js';
import { IAuxiliaryTitlebarPart } from '../titlebar/titlebarPart.js';
import { WindowTitle } from '../titlebar/windowTitle.js';
import { IAuxiliaryWindow, IAuxiliaryWindowOpenOptions, IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { GroupDirection, GroupsOrder, IAuxiliaryEditorPart } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ViewEditorInput, restoreViewEditorInputToOriginalLocation } from '../../../contrib/viewInEditor/browser/viewEditorInput.js';
import { IWorkbenchLayoutService, shouldShowCustomTitleBar } from '../../../services/layout/browser/layoutService.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import { ITitleService } from '../../../services/title/browser/titleService.js';

export interface IAuxiliaryEditorPartOpenOptions extends IAuxiliaryWindowOpenOptions {
	readonly state?: IEditorPartUIState;
}

export interface ICreateAuxiliaryEditorPartResult {
	readonly part: AuxiliaryEditorPartImpl;
	readonly instantiationService: IInstantiationService;
	readonly disposables: DisposableStore;
}

export class AuxiliaryEditorPart {

	private static STATUS_BAR_VISIBILITY = 'workbench.statusBar.visible';

	constructor(
		private readonly editorPartsView: IEditorPartsView,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAuxiliaryWindowService private readonly auxiliaryWindowService: IAuxiliaryWindowService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ITitleService private readonly titleService: ITitleService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService
	) {
	}

	async create(label: string, options?: IAuxiliaryEditorPartOpenOptions): Promise<ICreateAuxiliaryEditorPartResult> {

		function computeEditorPartHeightOffset(): number {
			let editorPartHeightOffset = 0;

			if (statusbarVisible) {
				editorPartHeightOffset += statusbarPart.height;
			}

			if (titlebarPart && titlebarVisible) {
				editorPartHeightOffset += titlebarPart.height;
			}

			return editorPartHeightOffset;
		}

		function updateStatusbarVisibility(fromEvent: boolean): void {
			if (statusbarVisible) {
				show(statusbarPart.container);
			} else {
				hide(statusbarPart.container);
			}

			if (fromEvent) {
				auxiliaryWindow.layout();
			}
		}

		function updateTitlebarVisibility(fromEvent: boolean): void {
			if (!titlebarPart) {
				return;
			}

			if (titlebarVisible) {
				show(titlebarPart.container);
			} else {
				hide(titlebarPart.container);
			}

			if (fromEvent) {
				auxiliaryWindow.layout();
			}
		}

		const disposables = new DisposableStore();

		// Auxiliary Window
		const auxiliaryWindow = disposables.add(await this.auxiliaryWindowService.open(options));

		// Editor Part
		const editorPartContainer = document.createElement('div');
		editorPartContainer.classList.add('part', 'editor');
		editorPartContainer.setAttribute('role', 'main');
		editorPartContainer.style.position = 'relative';
		auxiliaryWindow.container.appendChild(editorPartContainer);

		const editorPart = disposables.add(this.instantiationService.createInstance(AuxiliaryEditorPartImpl, auxiliaryWindow.window.vscodeWindowId, this.editorPartsView, options?.state, label));
		disposables.add(this.editorPartsView.registerPart(editorPart));
		editorPart.create(editorPartContainer);

		// Titlebar
		let titlebarPart: IAuxiliaryTitlebarPart | undefined = undefined;
		let titlebarVisible = false;
		const useCustomTitle = isNative && hasCustomTitlebar(this.configurationService); // custom title in aux windows only enabled in native
		if (useCustomTitle) {
			titlebarPart = disposables.add(this.titleService.createAuxiliaryTitlebarPart(auxiliaryWindow.container, editorPart));
			titlebarVisible = shouldShowCustomTitleBar(this.configurationService, auxiliaryWindow.window, undefined);

			const handleTitleBarVisibilityEvent = () => {
				const oldTitlebarPartVisible = titlebarVisible;
				titlebarVisible = shouldShowCustomTitleBar(this.configurationService, auxiliaryWindow.window, undefined);
				if (oldTitlebarPartVisible !== titlebarVisible) {
					updateTitlebarVisibility(true);
				}
			};

			disposables.add(titlebarPart.onDidChange(() => auxiliaryWindow.layout()));
			disposables.add(this.layoutService.onDidChangePartVisibility(() => handleTitleBarVisibilityEvent()));
			disposables.add(onDidChangeFullscreen(windowId => {
				if (windowId !== auxiliaryWindow.window.vscodeWindowId) {
					return; // ignore all but our window
				}

				handleTitleBarVisibilityEvent();
			}));

			updateTitlebarVisibility(false);
		} else {
			disposables.add(this.instantiationService.createInstance(WindowTitle, auxiliaryWindow.window, editorPart));
		}

		// Statusbar
		const statusbarPart = disposables.add(this.statusbarService.createAuxiliaryStatusbarPart(auxiliaryWindow.container));
		let statusbarVisible = this.configurationService.getValue<boolean>(AuxiliaryEditorPart.STATUS_BAR_VISIBILITY) !== false;
		disposables.add(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AuxiliaryEditorPart.STATUS_BAR_VISIBILITY)) {
				statusbarVisible = this.configurationService.getValue<boolean>(AuxiliaryEditorPart.STATUS_BAR_VISIBILITY) !== false;

				updateStatusbarVisibility(true);
			}
		}));

		updateStatusbarVisibility(false);

		// Lifecycle
		const editorCloseListener = disposables.add(Event.once(editorPart.onWillClose)(() => auxiliaryWindow.window.close()));
		disposables.add(Event.once(auxiliaryWindow.onUnload)(() => {
			if (disposables.isDisposed) {
				return; // the close happened as part of an earlier dispose call
			}

			editorCloseListener.dispose();
			editorPart.close();
			disposables.dispose();
		}));
		disposables.add(Event.once(this.lifecycleService.onDidShutdown)(() => disposables.dispose()));
		disposables.add(auxiliaryWindow.onBeforeUnload(event => {
			for (const group of editorPart.groups) {
				for (const editor of group.editors) {
					// Closing an auxiliary window with opened editors
					// will move the editors to the main window. As such,
					// we need to validate that we can move and otherwise
					// prevent the window from closing.
					const canMoveVeto = editor.canMove(group.id, this.editorPartsView.mainPart.activeGroup.id);
					if (typeof canMoveVeto === 'string') {
						group.openEditor(editor);
						event.veto(canMoveVeto);
						break;
					}
				}
			}
		}));

		// Layout: specifically `onWillLayout` to have a chance
		// to build the aux editor part before other components
		// have a chance to react.
		disposables.add(auxiliaryWindow.onWillLayout(dimension => {
			const titlebarPartHeight = titlebarPart?.height ?? 0;
			titlebarPart?.layout(dimension.width, titlebarPartHeight, 0, 0);

			const editorPartHeight = dimension.height - computeEditorPartHeightOffset();
			editorPart.layout(dimension.width, editorPartHeight, titlebarPartHeight, 0);

			statusbarPart.layout(dimension.width, statusbarPart.height, dimension.height - statusbarPart.height, 0);
		}));
		await Promise.race([auxiliaryWindow.whenStylesHaveLoaded, timeout(1000)]);
		await this.waitForWindowSize(auxiliaryWindow);
		auxiliaryWindow.layout();

		// Have a InstantiationService that is scoped to the auxiliary window
		const instantiationService = disposables.add(this.instantiationService.createChild(new ServiceCollection(
			[IStatusbarService, this.statusbarService.createScoped(statusbarPart, disposables)],
			[IEditorService, this.editorService.createScoped(editorPart, disposables)]
		)));

		return {
			part: editorPart,
			instantiationService,
			disposables
		};
	}

	private async waitForWindowSize(auxiliaryWindow: IAuxiliaryWindow): Promise<void> {
		const targetWindow = auxiliaryWindow.window;

		let lastWidth = 0;
		let lastHeight = 0;
		let stableRounds = 0;

		for (let i = 0; i < 80; i++) {
			const width = targetWindow.innerWidth;
			const height = targetWindow.innerHeight;

			if (width > 0 && height > 0 && width === lastWidth && height === lastHeight) {
				stableRounds++;
				if (stableRounds >= 3) {
					console.log('ws', i, width, height);
					return;
				}
			} else {
				stableRounds = 0;
			}

			lastWidth = width;
			lastHeight = height;
			await timeout(25);
		}
	}
}

class AuxiliaryEditorPartImpl extends EditorPart implements IAuxiliaryEditorPart {

	private static COUNTER = 1;

	private readonly _onWillClose = this._register(new Emitter<void>());
	readonly onWillClose = this._onWillClose.event;

	constructor(
		windowId: number,
		editorPartsView: IEditorPartsView,
		private readonly state: IEditorPartUIState | undefined,
		groupsLabel: string,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IHostService hostService: IHostService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService
	) {
		const id = AuxiliaryEditorPartImpl.COUNTER++;
		super(editorPartsView, `workbench.parts.auxiliaryEditor.${id}`, groupsLabel, windowId, instantiationService, themeService, configurationService, storageService, layoutService, hostService, contextKeyService);
	}

	override removeGroup(group: number | IEditorGroupView, preserveFocus?: boolean): void {

		// Close aux window when last group removed
		if (this.count <= 1) {
			this.doRemoveLastGroup(preserveFocus);
			return; // do not enter the parent removeGroup, avoiding doRemoveEmptyGroup -> gridWidget.removeView throwing "Can't remove last view"
		}

		// Otherwise delegate to parent implementation
		super.removeGroup(group, preserveFocus);
	}

	private doRemoveLastGroup(preserveFocus?: boolean): void {
		const restoreFocus = !preserveFocus && this.shouldRestoreFocus(this.container);

		// Activate next group
		const mostRecentlyActiveGroups = this.editorPartsView.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE);
		const nextActiveGroup = mostRecentlyActiveGroups[1]; // [0] will be the current group we are about to dispose
		if (nextActiveGroup) {
			nextActiveGroup.groupsView.activateGroup(nextActiveGroup);

			if (restoreFocus) {
				nextActiveGroup.focus();
			}
		}

		this.doClose(false /* do not merge any groups to main part */);
	}

	protected override loadState(): IEditorPartUIState | undefined {
		return this.state;
	}

	protected override saveState(): void {
		return; // disabled, auxiliary editor part state is tracked outside
	}

	close(): Promise<boolean> {
		return this.doClose(true /* merge all groups to main part */);
	}

	private async doClose(mergeGroupsToMainPart: boolean): Promise<boolean> {
		let result = true;
		if (mergeGroupsToMainPart) {
			result = await this.mergeGroupsToMainPart();
		}

		// onWillClose must be fired only after the restore has completed -- onWillClose actually closes
		// the floating window. If fired before the restore completes, the window would be destroyed while the
		// ViewEditorInput has not yet been removed from this window's group, so merge would still move the view to the main window's editor area.
		this._onWillClose.fire();

		return result;
	}

	private async mergeGroupsToMainPart(): Promise<boolean> {
		if (!this.groups.some(group => group.count > 0)) {
			return true; // skip if we have no editors opened
		}

		// Fix "after closing a dragged-out floating window the view appears in both panel and editor":
		// when the auxiliary window is closed, the native merge moves the editors in this window (including the view
		// hosted by ViewEditorInput) as a whole to the main window's editor area, and the main window
		// then re-hosts them via setInput, so a copy of the view lingers in the editor area.
		// Before merge, restore all ViewEditorInputs back to their original bar (Panel / Aux Bar)
		// and close this window's editor tabs so that the following merge has no editor to move,
		// and the main window no longer shows view duplicates. Restore semantics keep "close back to where it was dragged out from".
		// Collect first then close, avoiding iteration issues from modifying the collection while iterating group.editors.
		// Note: group.closeEditor is async, so we must await all of them before mergeAllGroups,
		// otherwise the editor is still in the group and gets moved to the main window again.
		const viewEditorInputs: { group: IEditorGroupView; editor: ViewEditorInput }[] = [];
		for (const group of this.groups) {
			for (const editor of group.editors) {
				if (editor instanceof ViewEditorInput) {
					viewEditorInputs.push({ group, editor });
				}
			}
		}
		// Collect views on the "stay in Editor" path (dragged out of the Editor into a window, so closing the window should return them to the Editor).
		// These views must not go through restore+closeEditor, nor rely solely on the mergeAllGroups
		// below (a Singleton such as terminal may be deduplicated and dropped by the main window during merge and thus "disappear").
		// Instead, before closing the auxiliary window, actively re-open them into the main window's editor group.
		const stayInEditorEditors: ViewEditorInput[] = [];
		await Promise.all(viewEditorInputs.map(async ({ group, editor }) => {
			// A view "returns to the area it was dragged out of into a standalone window when the window is closed".
			// - originalContainerId has a value (dragged directly out of Panel/Aux into a window): restore to the original bar
			//   and close this window's editor tab so the following merge has no editor to move.
			// - originalContainerId is undefined (dragged into the Editor first then out of the Editor into
			//   a window; on close this instance is rebuilt and loses its original bar info): the view should stay in
			//   the Editor area, so collect it and open it into the main window later.
			if (editor.originalContainerId === undefined) {
				stayInEditorEditors.push(editor);
				return;
			}
			// First move the view back to its original bar (Panel / Aux Bar), then await closeEditor
			// to actually remove the editor from this window's group. Both steps must complete, otherwise the subsequent
			// mergeAllGroups still moves the editor to the main window's editor area, leaving a duplicate.
			restoreViewEditorInputToOriginalLocation(
				editor,
				this.viewDescriptorService,
				undefined
			);
			await group.closeEditor(editor);
		}));

		// Re-open the "stay in Editor" views into the main window's editor area, ensuring they do not disappear after the window closes.
		// This must complete before merge and before the window is destroyed, so the main window holds a visible editor tab.
		if (stayInEditorEditors.length > 0) {
			const mainPart = this.editorPartsView.mainPart;
			const target = mainPart.activeGroup ?? mainPart.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)[0];
			for (const editor of stayInEditorEditors) {
				// First remove it from the auxiliary window's group (avoiding duplication/dropping during merge), then open it into the main window.
				for (const group of this.groups) {
					if (group.contains(editor)) {
						await group.closeEditor(editor);
					}
				}
				if (target) {
					await target.openEditor(editor, { pinned: true });
				}
			}
		}

		// If all ViewEditorInputs in this window have been restored and closed in this step, the remaining (if any)
		// non-view editors continue through the native merge flow.
		if (!this.groups.some(group => group.count > 0)) {
			return true; // all editors are ViewEditorInput and after restore there is nothing left
		}

		// Find the most recent group that is not locked
		let targetGroup: IEditorGroupView | undefined = undefined;
		for (const group of this.editorPartsView.mainPart.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)) {
			if (!group.isLocked) {
				targetGroup = group;
				break;
			}
		}

		if (!targetGroup) {
			targetGroup = this.editorPartsView.mainPart.addGroup(this.editorPartsView.mainPart.activeGroup, this.partOptions.openSideBySideDirection === 'right' ? GroupDirection.RIGHT : GroupDirection.DOWN);
		}

		const result = this.mergeAllGroups(targetGroup);
		targetGroup.focus();

		return result;
	}
}
