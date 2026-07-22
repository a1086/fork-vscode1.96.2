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
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { ViewEditorInput } from './viewEditorInput.js';

/**
 * Editor pane that instantiates and hosts a workbench ViewPane inside the editor area.
 * P0 spike: proves a ViewPane can be rendered in an arbitrary DOM node (the editor pane element).
 */
export class ViewEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.viewEditor';

	private pane: ViewPane | undefined;
	private dimension: Dimension | undefined;
	private _container: HTMLElement | undefined;

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

		pane.render();
		this._container?.appendChild(pane.element);
		this.pane = pane;

		if (this.dimension) {
			this.layoutPane(this.dimension);
		}
		pane.setVisible(this.isVisible());
	}

	override clearInput(): void {
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
