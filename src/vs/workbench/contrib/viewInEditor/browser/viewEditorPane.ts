/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../base/browser/dom.js';
import { Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService, IViewDescriptor, ViewContainerLocation } from '../../../common/views.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { CompositeDragAndDropObserver, IDraggedCompositeData } from '../../../browser/dnd.js';
import { ViewEditorInput } from './viewEditorInput.js';
import './media/viewEditorPane.css';

export class ViewEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.view';

	private _editorView?: ViewPane;
	private readonly container: HTMLElement;

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
		// A `ViewPane` only gets its layout styles inside a `.monaco-pane-view`
		// ancestor (header height, body flex). Since we mount the pane directly
		// into the editor area, add that class so the pane does not collapse.
		this.container.classList.add('monaco-pane-view', 'view-editor-pane');
		this.container.style.position = 'relative';
		this.container.style.width = '100%';
		this.container.style.height = '100%';
		this.container.style.overflow = 'hidden';
	}

	protected override createEditor(parent: HTMLElement): void {
		parent.appendChild(this.container);
	}

	override async setInput(input: ViewEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		if (this._editorView) {
			return;
		}

		const descriptor = this.viewDescriptorService.getViewDescriptorById(input.viewId);
		if (!descriptor) {
			throw new Error('No view descriptor found for view id: ' + input.viewId);
		}

		const viewContainer = this.viewDescriptorService.getViewContainerByViewId(input.viewId);
		if (!viewContainer) {
			throw new Error('No view container found for view id: ' + input.viewId);
		}

		const paneTitle = descriptor.name?.value ?? descriptor.id;
		const pane = this.instantiationService.createInstance(descriptor.ctorDescriptor.ctor, {
			...descriptor,
			id: descriptor.id,
			// `ViewPane` reads its header title from `options.title` (not `options.name`).
			// `descriptor.name` is an `ILocalizedString`; forwarding it directly would put
			// the object into `Pane._title` and the header `<h3>` would render the string
			// `"UNDEFINED"` (or `"[object Object]"`). Pass the localized value, and fall
			// back to the view id so the header never shows `UNDEFINED`.
			title: paneTitle,
			container: viewContainer,
			viewContainerLocation: ViewContainerLocation.Editor,
			canToggleVisibility: false,
			overrideAriaLabel: paneTitle,
			overrideAriaDescription: paneTitle,
		}) as ViewPane;

		// Panel views default to HORIZONTAL orientation; force vertical in the editor area.
		pane.orientation = Orientation.VERTICAL;

		pane.render();
		this.container.appendChild(pane.element);
		this._editorView = pane;
		this.layoutPane(pane);

		this.registerReverseDrag(input, descriptor, pane);

		this._register(pane.onDidFocus(() => this.focus()));
	}

	private registerReverseDrag(input: ViewEditorInput, descriptor: IViewDescriptor, pane: ViewPane): void {
		const draggableProvider = () => ({ type: 'view' as const, id: input.viewId });
		const onDragEnd = (e: IDraggedCompositeData) => {
			if (e.eventData.dataTransfer?.dropEffect === 'none') {
				return; // drag was cancelled, keep the view in the editor area
			}

			// When the view is still hosted in the editor area at drag end, the
			// panel/sidebar/auxiliary bar drop target did not relocate it (its
			// current view container is seen as equal to the target, so the target's
			// `moveViewsToContainer` is a no-op). In that case move it back to its
			// original location explicitly. If the target already relocated it to a
			// different location we leave it there. Either way the editor tab must
			// close because the view has left the editor area.
			const location = this.viewDescriptorService.getViewLocationById(descriptor.id);
			if (location === null || location === ViewContainerLocation.Editor) {
				this.viewDescriptorService.moveViewToLocation(descriptor, input.originalLocation ?? ViewContainerLocation.Panel, 'dnd-editor-to-panel');
			}

			this.group?.closeEditor(input);
		};
		this._register(CompositeDragAndDropObserver.INSTANCE.registerDraggable(pane.draggableElement, draggableProvider, { onDragEnd }));
	}

	override clearInput(): void {
		// Behavior A: closing the editor tab only hides the view inside the editor area.
		// Do NOT move it back to panel/sidebar/auxiliary bar; leave its ViewDescriptorService
		// location as ViewContainerLocation.Editor.
		this.disposePane();
		this.container.replaceChildren();
		super.clearInput();
	}

	private disposePane(): void {
		if (this._editorView) {
			this._editorView.dispose();
			this._editorView = undefined;
		}
	}

	private layoutPane(pane: ViewPane): void {
		const width = this.container.clientWidth;
		const height = this.container.clientHeight;
		pane.setVisible(true);
		// `Pane.layout` takes only the main-axis size; the orthogonal size must
		// be set manually because we mount the pane directly (no PaneView parent).
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
			this.layoutPane(this._editorView);
		}
	}
}
