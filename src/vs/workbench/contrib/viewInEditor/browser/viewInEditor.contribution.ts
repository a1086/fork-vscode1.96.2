/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { IEditorPaneRegistry, EditorPaneDescriptor } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ViewEditorInput } from './viewEditorInput.js';
import { ViewEditorPane } from './viewEditorPane.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';

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

		// Always restore the view to the Editor container on deserialization
		instantiationService.invokeFunction(accessor => {
			const viewDescriptorService = accessor.get(IViewDescriptorService);
			const descriptor = viewDescriptorService.getViewDescriptorById(viewId);
			if (descriptor) {
				viewDescriptorService.moveViewToLocation(descriptor, ViewContainerLocation.Editor, 'restore');
			}
		});

		return instantiationService.createInstance(ViewEditorInput, viewId, originalLocation);
	}
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)
	.registerEditorPane(
		EditorPaneDescriptor.create(ViewEditorPane, ViewEditorPane.ID, 'View'),
		[new SyncDescriptor(ViewEditorInput)]
	);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(ViewEditorInput.ID, ViewEditorInputSerializer);
