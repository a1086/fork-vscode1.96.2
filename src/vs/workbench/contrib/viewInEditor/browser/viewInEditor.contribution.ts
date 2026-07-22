/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../../../common/editor.js';
import { IEditorPaneRegistry } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IEditorSerializer } from '../../../common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorPaneDescriptor } from '../../../browser/editor.js';
import { ViewEditorInput } from './viewEditorInput.js';
import { ViewEditorPane } from './viewEditorPane.js';

class ViewEditorInputSerializer implements IEditorSerializer {

	canSerialize(): boolean {
		return true;
	}

	serialize(input: ViewEditorInput): string {
		return input.viewId;
	}

	deserialize(instantiationService: IInstantiationService, serialized: string): ViewEditorInput {
		return instantiationService.createInstance(ViewEditorInput, serialized);
	}
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)
	.registerEditorPane(
		EditorPaneDescriptor.create(ViewEditorPane, ViewEditorPane.ID, 'View'),
		[new SyncDescriptor(ViewEditorInput)]
	);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(ViewEditorInput.ID, ViewEditorInputSerializer);
