/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/modulepart.css';
import { $ } from '../../../../base/browser/dom.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Part } from '../../part.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';

export class ModulePart extends Part {

	readonly height: number = 35;
	readonly minimumWidth: number = 0;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;

	get minimumHeight(): number {
		return this.height;
	}

	get maximumHeight(): number {
		return this.height;
	}

	constructor(
		@IThemeService themeService: IThemeService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IStorageService storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super(Parts.MODULE_PART, { hasTitle: false }, themeService, storageService, layoutService);

		this.logService.trace('mp: ');
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		const content = $('.module-content');
		parent.appendChild(content);
		return this.element;
	}

	toJSON(): object {
		return {
			type: Parts.MODULE_PART
		};
	}
}
