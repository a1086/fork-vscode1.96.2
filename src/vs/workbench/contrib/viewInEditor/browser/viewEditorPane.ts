/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../base/browser/dom.js';
import { Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { timeout } from '../../../../base/common/async.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService, IViewDescriptor, ICustomViewDescriptor, ViewContainerLocation } from '../../../common/views.js';
import { TerminalViewPane } from '../../../contrib/terminal/browser/terminalView.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { CompositeDragAndDropObserver, IDraggedCompositeData } from '../../../browser/dnd.js';
import { ViewEditorInput, restoreViewEditorInputToOriginalLocation, isViewEditorInputMarkedForRestartRecovery } from './viewEditorInput.js';
import './media/viewEditorPane.css';

interface CachedPane {
	pane: ViewPane;
	owned: boolean;
	descriptor: IViewDescriptor;
	input: ViewEditorInput;
	headerHidden: boolean;
}

const paneCache = new Map<string, CachedPane>();

export class ViewEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.view';

	private _editorView?: ViewPane;
	private readonly container: HTMLElement;
	private _currentViewId?: string;
	private readonly _restored = new Set<string>();
	private _parking?: HTMLElement;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
	) {
		super(ViewEditorPane.ID, group, telemetryService, themeService, storageService);
		this.container = document.createElement('div');
		this.container.classList.add('monaco-pane-view', 'view-editor-pane');
		this.container.style.position = 'relative';
		this.container.style.width = '100%';
		this.container.style.height = '100%';
		this.container.style.overflow = 'hidden';
	}

	protected override createEditor(parent: HTMLElement): void {
		parent.appendChild(this.container);
	}

	private getParking(): HTMLElement {
		if (!this._parking) {
			this._parking = document.createElement('div');
			this._parking.style.position = 'fixed';
			this._parking.style.left = '-10000px';
			this._parking.style.top = '0px';
			this._parking.style.width = '100%';
			this._parking.style.height = '100%';
			this._parking.style.overflow = 'hidden';
			this._parking.style.pointerEvents = 'none';
			document.body.appendChild(this._parking);
		}
		return this._parking;
	}

	private recoverRestartedViewEditor(input: ViewEditorInput): boolean {
		if (!isViewEditorInputMarkedForRestartRecovery(input.viewId)) {
			return false;
		}
		const viewId = input.viewId;
		const homeId = viewId.endsWith('.view') ? viewId.slice(0, viewId.length - '.view'.length) : viewId;
		const home = this.viewDescriptorService.getViewContainerById(homeId);
		if (!home || this.viewDescriptorService.getViewContainerLocation(home) !== ViewContainerLocation.Panel) {
			return false;
		}
		const homeModel = this.viewDescriptorService.getViewContainerModel(home);
		if (homeModel.allViewDescriptors.length > 0) {
			return false;
		}
		const descriptor = this.viewDescriptorService.getViewDescriptorById(viewId);
		if (!descriptor) {
			return false;
		}
		if (this.viewDescriptorService.getViewLocationById(viewId) !== ViewContainerLocation.Editor) {
			return false;
		}
		this.viewDescriptorService.moveViewsToContainer([descriptor], home, undefined, 'view-editor-restart');
		console.log('rv');
		return true;
	}

	override async setInput(input: ViewEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		if (this.recoverRestartedViewEditor(input)) {
			await super.setInput(input, options, context, token);
			timeout(0).then(() => {
				this.group?.closeEditor(input);
			});
			return;
		}
		const viewId = input.viewId;
		let entry = paneCache.get(viewId);

		if (entry) {
			entry.pane.orientation = Orientation.VERTICAL;
			entry.pane.setExpanded(true);
			this._editorView = entry.pane;
			this._currentViewId = viewId;
			this.applyPaneHeaderVisibility(entry);
			this.container.appendChild(entry.pane.element);
			this.layoutPane(entry.pane);
		}

		await super.setInput(input, options, context, token);

		if (!entry) {
			const descriptor = this.viewDescriptorService.getViewDescriptorById(viewId);
			if (!descriptor) {
				throw new Error('No view descriptor found for view id: ' + viewId);
			}

			await timeout(50);
			const viewContainer = this.viewDescriptorService.getViewContainerByViewId(viewId);
			if (!viewContainer) {
				throw new Error('No view container found for view id: ' + viewId);
			}

			const paneTitle = descriptor.name?.value ?? descriptor.id;

			let pane: ViewPane;
			try {
				pane = this.instantiationService.createInstance(
					descriptor.ctorDescriptor.ctor,
					...(descriptor.ctorDescriptor.staticArguments || []),
					{
						...descriptor,
						id: descriptor.id,
						title: paneTitle,
						container: viewContainer,
						viewContainerLocation: ViewContainerLocation.Editor,
						canToggleVisibility: false,
						overrideAriaLabel: paneTitle,
						overrideAriaDescription: paneTitle,
					}
				) as ViewPane;
			} catch (error) {
				throw new Error(`View "${viewId}" cannot be opened in a floating window: ${error}`);
			}

			try {
				pane.render();
			} catch (error) {
				throw new Error(`View "${viewId}" failed to render in floating window: ${error}`);
			}

			pane.orientation = Orientation.VERTICAL;
			pane.setExpanded(true);

			entry = { pane, owned: true, descriptor, input, headerHidden: false };
			paneCache.set(viewId, entry);

			this.registerReverseDrag(input, descriptor, pane);
			this._register(pane.onDidFocus(() => this.focus()));

			if (pane instanceof TerminalViewPane) {
				pane.forceRelocateTerminalContainer();
			}

			this._editorView = pane;
			this._currentViewId = viewId;
			this.applyPaneHeaderVisibility(entry);
			this.container.appendChild(pane.element);
			this.layoutPane(pane);
		}
	}

	private restore(input: ViewEditorInput): void {
		if (this._restored.has(input.viewId)) {
			return;
		}
		this._restored.add(input.viewId);
		restoreViewEditorInputToOriginalLocation(input, this.viewDescriptorService, undefined);
	}

	private applyPaneHeaderVisibility(entry: CachedPane): void {
		const pane = entry.pane;
		entry.headerHidden = false;
		if (!(entry.descriptor as ICustomViewDescriptor).extensionId) {
			return;
		}
		if (pane.headerVisible) {
			pane.headerVisible = false;
			entry.headerHidden = true;
		}
	}

	private restorePaneHeaderVisibility(entry: CachedPane): void {
		if (entry.headerHidden) {
			entry.pane.headerVisible = true;
			entry.headerHidden = false;
		}
	}

	private registerReverseDrag(input: ViewEditorInput, descriptor: IViewDescriptor, pane: ViewPane): void {
		const draggableProvider = () => ({ type: 'view' as const, id: input.viewId });
		const onDragEnd = (e: IDraggedCompositeData) => {
			if (e.eventData.dataTransfer?.dropEffect === 'none') {
				return;
			}

			const location = this.viewDescriptorService.getViewLocationById(descriptor.id);
			if (location === null || location === ViewContainerLocation.Editor) {
				this.viewDescriptorService.moveViewToLocation(descriptor, input.originalLocation ?? ViewContainerLocation.Panel, 'dnd-editor-to-panel');
			}

			this.restore(input);
			this.group?.closeEditor(input);
		};
		this._register(CompositeDragAndDropObserver.INSTANCE.registerDraggable(pane.draggableElement, draggableProvider, { onDragEnd }));
	}

	override setEditorVisible(visible: boolean): void {
		if (visible && this._editorView) {
			this._editorView.setVisible(true);
		}
	}

	override clearInput(): void {
		if (this._currentViewId) {
			const entry = paneCache.get(this._currentViewId);
			if (entry) {
				this.restorePaneHeaderVisibility(entry);
				entry.pane.setVisible(false);
				if (entry.pane.element.parentElement === this.container) {
					this.getParking().appendChild(entry.pane.element);
				}
			}
		}

		this._currentViewId = undefined;
		this._editorView = undefined;
		super.clearInput();
	}

	override dispose(): void {
		for (const entry of paneCache.values()) {
			this.restorePaneHeaderVisibility(entry);
			this.restore(entry.input);
			if (entry.owned) {
				entry.pane.dispose();
			}
		}
		paneCache.clear();
		super.dispose();
	}

	private layoutPane(pane: ViewPane, dimension?: Dimension): void {
		const width = dimension?.width ?? this.container.clientWidth;
		const height = dimension?.height ?? this.container.clientHeight;

		if (width <= 0 || height <= 0) {
			return;
		}

		pane.setVisible(true);
		if (pane.orientation === Orientation.VERTICAL) {
			pane.orthogonalSize = width;
			pane.layout(height);
		} else {
			pane.orthogonalSize = height;
			pane.layout(width);
		}
	}

	override layout(dimension: Dimension): void {
		if (this._editorView) {
			this.layoutPane(this._editorView, dimension);
		}
	}
}
