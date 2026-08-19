/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { onDidChangeFullscreen } from '../../../../base/browser/browser.js';
import { hide, show } from '../../../../base/browser/dom.js';
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
import { IAuxiliaryWindowOpenOptions, IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
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
			return; // 不进入父类 removeGroup，避免 doRemoveEmptyGroup → gridWidget.removeView 抛出 "Can't remove last view"
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

		// 必须在归位完成后再触发 onWillClose —— onWillClose 会真正关闭
		// 浮动窗口。若不等归位就触发，窗口会在 ViewEditorInput 还没从本
		// 窗口 group 移除时被销毁，导致 merge 仍把视图搬到主窗口 editor 区。
		this._onWillClose.fire();

		return result;
	}

	private async mergeGroupsToMainPart(): Promise<boolean> {
		if (!this.groups.some(group => group.count > 0)) {
			return true; // skip if we have no editors opened
		}

		// 修复"关闭拖出的浮动窗口后视图同时出现在 panel 和 editor"：
		// 关闭辅助窗口时，原生的 merge 会把本窗口里的 editor（包括
		// ViewEditorInput 承载的视图）整体 move 到主窗口 editor 区，主窗口
		// 随后 setInput 重新承载，于是 editor 区残留一份视图。
		// 在 merge 之前先把所有 ViewEditorInput 归位回其原栏（Panel / Aux Bar）
		// 并关闭本窗口的 editor tab，使接下来 merge 时无 editor 可搬，
		// 主窗口便不会再出现视图副本。归位语义保持"从哪拖出，关窗回哪"。
		// 先收集再关闭，避免在遍历 group.editors 时修改集合引发的迭代问题。
		// 注意：group.closeEditor 是异步的，必须 await 全部完成后才能
		// mergeAllGroups，否则 editor 还在 group 里，会被再次搬到主窗口。
		const viewEditorInputs: { group: IEditorGroupView; editor: ViewEditorInput }[] = [];
		for (const group of this.groups) {
			for (const editor of group.editors) {
				if (editor instanceof ViewEditorInput) {
					viewEditorInputs.push({ group, editor });
				}
			}
		}
		await Promise.all(viewEditorInputs.map(async ({ group, editor }) => {
			// 先把视图 move 回原栏（Panel / Aux Bar），再 await closeEditor
			// 把 editor 从本窗口 group 真正移除。两步都必须完成，否则其后的
			// mergeAllGroups 仍会把 editor 搬到主窗口 editor 区，造成残留。
			// 注意：closeEditor 是异步的，这里必须 await；归位（move）在
			// close 之前调用，确保视图先脱离 Editor 区再关 tab。
			restoreViewEditorInputToOriginalLocation(
				editor,
				this.viewDescriptorService,
				undefined
			);
			await group.closeEditor(editor);
		}));

		// 若本窗口里的 ViewEditorInput 已在本步全部归位关闭，剩下的（若有）
		// 非视图 editor 继续走原生 merge 流程。
		if (!this.groups.some(group => group.count > 0)) {
			return true; // 所有 editor 都是 ViewEditorInput，归位后已无残留
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
