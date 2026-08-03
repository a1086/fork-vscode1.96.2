/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { URI } from '../../../../base/common/uri.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';

export const VIEW_EDITOR_INPUT_TYPE_ID = 'workbench.editors.viewEditorInput';

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
