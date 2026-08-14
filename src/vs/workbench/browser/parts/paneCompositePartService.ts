/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { assertIsDefined } from '../../../base/common/types.js';
import { InstantiationType, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IProgressIndicator } from '../../../platform/progress/common/progress.js';
import { PaneCompositeDescriptor } from '../panecomposite.js';
import { AuxiliaryBarPart } from './auxiliarybar/auxiliaryBarPart.js';
import { PanelPart } from './panel/panelPart.js';
import { SidebarPart } from './sidebar/sidebarPart.js';
import { IPaneComposite } from '../../common/panecomposite.js';
import { ViewContainerLocation, ViewContainerLocations } from '../../common/views.js';
import { IPaneCompositePartService } from '../../services/panecomposite/browser/panecomposite.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { IPaneCompositePart } from './paneCompositePart.js';

export class PaneCompositePartService extends Disposable implements IPaneCompositePartService {

	declare readonly _serviceBrand: undefined;

	readonly onDidPaneCompositeOpen: Event<{ composite: IPaneComposite; viewContainerLocation: ViewContainerLocation }>;
	readonly onDidPaneCompositeClose: Event<{ composite: IPaneComposite; viewContainerLocation: ViewContainerLocation }>;

	private readonly paneCompositeParts = new Map<ViewContainerLocation, IPaneCompositePart>();

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		const panelPart = instantiationService.createInstance(PanelPart);
		const sideBarPart = instantiationService.createInstance(SidebarPart);
		const auxiliaryBarPart = instantiationService.createInstance(AuxiliaryBarPart);

		this.paneCompositeParts.set(ViewContainerLocation.Panel, panelPart);
		this.paneCompositeParts.set(ViewContainerLocation.Sidebar, sideBarPart);
		this.paneCompositeParts.set(ViewContainerLocation.AuxiliaryBar, auxiliaryBarPart);

		const eventDisposables = this._register(new DisposableStore());
		const partLocations = ViewContainerLocations.filter(loc => this.paneCompositeParts.has(loc));
		this.onDidPaneCompositeOpen = Event.any(...partLocations.map(loc => Event.map(this.paneCompositeParts.get(loc)!.onDidPaneCompositeOpen, composite => { return { composite, viewContainerLocation: loc }; }, eventDisposables)));
		this.onDidPaneCompositeClose = Event.any(...partLocations.map(loc => Event.map(this.paneCompositeParts.get(loc)!.onDidPaneCompositeClose, composite => { return { composite, viewContainerLocation: loc }; }, eventDisposables)));
	}

	openPaneComposite(id: string | undefined, viewContainerLocation: ViewContainerLocation, focus?: boolean): Promise<IPaneComposite | undefined> {
		return this.getPartByLocation(viewContainerLocation).openPaneComposite(id, focus);
	}

	getActivePaneComposite(viewContainerLocation: ViewContainerLocation): IPaneComposite | undefined {
		return this.getPartByLocation(viewContainerLocation).getActivePaneComposite();
	}

	getActivePaneCompositeForContainer(id: string, viewContainerLocation: ViewContainerLocation): IPaneComposite | undefined {
		const part = this.getPartByLocation(viewContainerLocation);
		// The dual-panel layout backs `Panel` with two independent side parts.
		// Ask the concrete part (which knows about its sides) to resolve the id
		// so a view shown on the non-focused side is still found.
		const partWithSides = part as IPaneCompositePart & { getActivePaneCompositeForContainer?: (id: string) => IPaneComposite | undefined };
		if (typeof partWithSides.getActivePaneCompositeForContainer === 'function') {
			return partWithSides.getActivePaneCompositeForContainer(id);
		}
		const active = part.getActivePaneComposite();
		return active?.getId() === id ? active : undefined;
	}

	getPaneComposite(id: string, viewContainerLocation: ViewContainerLocation): PaneCompositeDescriptor | undefined {
		return this.getPartByLocation(viewContainerLocation).getPaneComposite(id);
	}

	getPaneComposites(viewContainerLocation: ViewContainerLocation): PaneCompositeDescriptor[] {
		return this.getPartByLocation(viewContainerLocation).getPaneComposites();
	}

	getPinnedPaneCompositeIds(viewContainerLocation: ViewContainerLocation): string[] {
		return this.getPartByLocation(viewContainerLocation).getPinnedPaneCompositeIds();
	}

	getVisiblePaneCompositeIds(viewContainerLocation: ViewContainerLocation): string[] {
		return this.getPartByLocation(viewContainerLocation).getVisiblePaneCompositeIds();
	}

	getPaneCompositeIds(viewContainerLocation: ViewContainerLocation): string[] {
		return this.getPartByLocation(viewContainerLocation).getPaneCompositeIds();
	}

	getProgressIndicator(id: string, viewContainerLocation: ViewContainerLocation): IProgressIndicator | undefined {
		return this.getPartByLocation(viewContainerLocation).getProgressIndicator(id);
	}

	hideActivePaneComposite(viewContainerLocation: ViewContainerLocation): void {
		this.getPartByLocation(viewContainerLocation).hideActivePaneComposite();
	}

	hidePaneComposite(id: string, viewContainerLocation: ViewContainerLocation): void {
		const part = this.getPartByLocation(viewContainerLocation) as IPaneCompositePart & { hidePaneComposite?: (id: string) => void };
		if (typeof part.hidePaneComposite === 'function') {
			part.hidePaneComposite(id);
		}
	}

	hideActivePaneCompositeSide(viewContainerLocation: ViewContainerLocation): boolean {
		if (viewContainerLocation !== ViewContainerLocation.Panel) {
			return false;
		}
		const panelPart = this.paneCompositeParts.get(ViewContainerLocation.Panel) as PanelPart | undefined;
		return panelPart?.closeActiveSide() ?? false;
	}

	shouldAutoHidePanelWhenEmpty(): boolean {
		// Only the Panel location can opt out of the auto-hide; other parts
		// keep their default behaviour.
		const panelPart = this.paneCompositeParts.get(ViewContainerLocation.Panel) as IPaneCompositePart & { shouldAutoHidePanelWhenEmpty?: () => boolean } | undefined;
		return panelPart?.shouldAutoHidePanelWhenEmpty?.() ?? true;
	}

	toggleSideMaximized(side: 'left' | 'right'): void {
		const panelPart = this.paneCompositeParts.get(ViewContainerLocation.Panel) as PanelPart | undefined;
		panelPart?.toggleSideMaximized(side);
	}

	isSideMaximized(side: 'left' | 'right'): boolean {
		const panelPart = this.paneCompositeParts.get(ViewContainerLocation.Panel) as PanelPart | undefined;
		return panelPart?.isSideMaximized(side) ?? false;
	}

	isDualLayout(): boolean {
		const panelPart = this.paneCompositeParts.get(ViewContainerLocation.Panel) as PanelPart | undefined;
		return panelPart?.isDualLayout() ?? false;
	}


	getLastActivePaneCompositeId(viewContainerLocation: ViewContainerLocation): string {
		return this.getPartByLocation(viewContainerLocation).getLastActivePaneCompositeId();
	}

	private getPartByLocation(viewContainerLocation: ViewContainerLocation): IPaneCompositePart {
		return assertIsDefined(this.paneCompositeParts.get(viewContainerLocation));
	}

}

registerSingleton(IPaneCompositePartService, PaneCompositePartService, InstantiationType.Delayed);
