/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../base/browser/dom.js';
import { Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { CompositeDragAndDropObserver } from '../../../browser/dnd.js';
import { ViewEditorInput } from './viewEditorInput.js';

/**
 * Editor pane that instantiates and hosts a workbench ViewPane inside the editor area.
 */
export class ViewEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.viewEditor';

	private pane: ViewPane | undefined;
	private dimension: Dimension | undefined;
	private _container: HTMLElement | undefined;
	private _reverseDragDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService
	) {
		super(ViewEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(container: HTMLElement): void {
		this._container = container;

		// A `ViewPane` (`.pane`) only gets its layout styles when it lives inside a
		// `.monaco-pane-view` ancestor (see paneview.css: header height, body flex,
		// pane flex layout). Since we mount the pane directly into the editor area
		// we add that class to the host so those styles apply and the pane no longer
		// "collapses". We also make the host a positioned block filling the editor.
		container.classList.add('monaco-pane-view', 'view-editor-pane-container');
		container.style.position = 'relative';
		container.style.width = '100%';
		container.style.height = '100%';
		container.style.overflow = 'hidden';
	}




	override async setInput(input: ViewEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		this.disposePane();

		const descriptor = this.viewDescriptorService.getViewDescriptorById(input.viewId);
		if (!descriptor || !descriptor.ctorDescriptor) {
			return;
		}

		// Generic factory: any ViewPane can be instantiated from its descriptor's ctor.
		const pane = this.instantiationService.createInstance(
			descriptor.ctorDescriptor.ctor,
			...(descriptor.ctorDescriptor.staticArguments || []),
			{ id: input.viewId, title: descriptor.name.value, expanded: true } as IViewletViewOptions
		);

		// 3.3: Force vertical orientation in editor area (Panel views default to horizontal)
		if ((pane as any).orientation !== undefined) {
			(pane as any).orientation = Orientation.VERTICAL;
		}

		pane.render();
		this._container?.appendChild(pane.element);

		// Make the pane root fill the editor host. A `Pane` normally relies on its
		// `PaneView` parent to absolutely position/size the `.pane` element; since
		// we host it directly we replicate that here so header + body lay out
		// correctly instead of collapsing.
		pane.element.style.position = 'absolute';
		pane.element.style.top = '0';
		pane.element.style.left = '0';
		pane.element.style.width = '100%';
		pane.element.style.height = '100%';
		pane.element.style.display = 'flex';
		pane.element.style.flexDirection = 'column';

		this.pane = pane;


		if (this.dimension) {
			this.layoutPane(this.dimension);
		}
		pane.setVisible(this.isVisible());

		// Register reverse-drag so the view can be dragged back to the sidebar
		// (activity bar), panel bar or auxiliary bar. The actual re-location is
		// performed by the drop target (composite bar / view container), which
		// already understands views coming from the editor area. We only mark the
		// payload as a 'view' so those targets accept it, and close this editor
		// once the view has left the editor area so the now-empty tab does not
		// linger.
		//
		// We register the draggable on both the pane header (`draggableElement`)
		// and the pane title label so the whole header strip initiates a drag,
		// matching the affordance users expect from the sidebar/panel.
		this._reverseDragDisposables.clear();
		const draggableProvider = () => ({ type: 'view' as const, id: input.viewId });
		const onDragEnd = (e: { eventData: DragEvent }) => {
			if (e.eventData.dataTransfer?.dropEffect !== 'move') {
				return; // drop was cancelled or copied elsewhere
			}

			// If the drop target moved the view out of the editor area,
			// close this editor input to remove the empty tab.
			const currentLocation = this.viewDescriptorService.getViewLocationById(input.viewId);
			if (currentLocation !== null && currentLocation !== ViewContainerLocation.Editor) {
				this.group.closeEditor(input);
			}
		};
		this._reverseDragDisposables.add(
			CompositeDragAndDropObserver.INSTANCE.registerDraggable(pane.draggableElement, draggableProvider, { onDragEnd })
		);
	}



	override clearInput(): void {
		// When the editor tab is closed we drop the hosted pane. However, the view
		// itself must NOT stay parked in the (invisible) editor view container –
		// otherwise its `<viewId>.active` context key stays false and the entry in
		// the `View` menu becomes unclickable ("can't open it again").
		//
		// So on close we relocate the view back to its DEFAULT native location
		// (e.g. OUTLINE -> Explorer side bar, TERMINAL -> Panel) but keep it hidden.
		// This does not pop anything open (we don't focus/expand it, and we pass the
		// default `ViewVisibilityState` so the view stays collapsed/hidden); it merely
		// re-registers the view in its home container so the `View` menu command can
		// open it again at its original spot.
		const input = this.input as ViewEditorInput | undefined;
		if (input) {
			const descriptor = this.viewDescriptorService.getViewDescriptorById(input.viewId);
			const currentLocation = this.viewDescriptorService.getViewLocationById(input.viewId);
			// Only relocate if the view is still hosted in the editor area (i.e. it
			// was not already moved out via an explicit reverse-drag).
			if (descriptor && currentLocation === ViewContainerLocation.Editor) {
				const defaultContainer = this.viewDescriptorService.getDefaultContainerById(input.viewId);
				if (defaultContainer) {
					this.viewDescriptorService.moveViewsToContainer([descriptor], defaultContainer, undefined, 'closeEditor');
				}
			}
		}
		this.disposePane();
		super.clearInput();
	}



	override layout(dimension: Dimension): void {
		this.dimension = dimension;
		this.layoutPane(dimension);
	}

	private layoutPane(dimension: Dimension): void {
		if (!this.pane) {
			return;
		}
		// `Pane.layout` 只收主轴尺寸；正交尺寸需手动设置，因为我们是直接挂载
		// 该 pane（没有 PaneView 包装来设置 orthogonalSize）。
		if (this.pane.orientation === Orientation.VERTICAL) {
			this.pane.orthogonalSize = dimension.width;
			this.pane.layout(dimension.height);
		} else {
			this.pane.orthogonalSize = dimension.height;
			this.pane.layout(dimension.width);
		}
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.pane?.setVisible(visible);
	}

	private disposePane(): void {
		if (this.pane) {
			this.pane.dispose();
			this.pane = undefined;
		}
	}
}
