/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { PaneCompositeDescriptor } from '../../../browser/panecomposite.js';
import { IProgressIndicator } from '../../../../platform/progress/common/progress.js';
import { IPaneComposite } from '../../../common/panecomposite.js';
import { ViewContainerLocation } from '../../../common/views.js';

export const IPaneCompositePartService = createDecorator<IPaneCompositePartService>('paneCompositePartService');

export interface IPaneCompositePartService {

	readonly _serviceBrand: undefined;

	readonly onDidPaneCompositeOpen: Event<{ composite: IPaneComposite; viewContainerLocation: ViewContainerLocation }>;
	readonly onDidPaneCompositeClose: Event<{ composite: IPaneComposite; viewContainerLocation: ViewContainerLocation }>;

	/**
	 * Opens a viewlet with the given identifier and pass keyboard focus to it if specified.
	 */
	openPaneComposite(id: string | undefined, viewContainerLocation: ViewContainerLocation, focus?: boolean): Promise<IPaneComposite | undefined>;

	/**
	 * Returns the current active viewlet if any.
	 */
	getActivePaneComposite(viewContainerLocation: ViewContainerLocation): IPaneComposite | undefined;

	/**
	 * Returns the active pane composite for the given view container id in the
	 * given location, if that container is currently active in *any* of the
	 * pane composite parts that back that location.
	 *
	 * This is required for the dual-panel layout where a single
	 * `ViewContainerLocation.Panel` is backed by two independent side parts that
	 * can each host an active view container simultaneously. A plain
	 * `getActivePaneComposite(location)` call can only report one of them (the
	 * focused side), so queries such as "give me the ViewPaneContainer for this
	 * container id" would otherwise miss the view shown on the non-focused side
	 * and the view would become clickable but non-functional.
	 */
	getActivePaneCompositeForContainer(id: string, viewContainerLocation: ViewContainerLocation): IPaneComposite | undefined;

	/**
	 * Returns the viewlet by id.
	 */
	getPaneComposite(id: string, viewContainerLocation: ViewContainerLocation): PaneCompositeDescriptor | undefined;

	/**
	 * Returns all enabled viewlets
	 */
	getPaneComposites(viewContainerLocation: ViewContainerLocation): PaneCompositeDescriptor[];

	/**
	 * Returns id of pinned view containers following the visual order.
	 */
	getPinnedPaneCompositeIds(viewContainerLocation: ViewContainerLocation): string[];

	/**
	 * Returns id of visible view containers following the visual order.
	 */
	getVisiblePaneCompositeIds(viewContainerLocation: ViewContainerLocation): string[];

	/**
	 * Returns id of all view containers following visual order.
	 */
	getPaneCompositeIds(viewContainerLocation: ViewContainerLocation): string[];

	/**
	 * Returns the progress indicator for the side bar.
	 */
	getProgressIndicator(id: string, viewContainerLocation: ViewContainerLocation): IProgressIndicator | undefined;

	/**
	 * Hide the active viewlet.
	 */
	hideActivePaneComposite(viewContainerLocation: ViewContainerLocation): void;

	/**
	 * Collapse the side of a dual-panel layout that hosts the given view
	 * container. Only relevant for the dual-panel layout; for other parts it
	 * is a no-op. Used so closing a Panel container only hides that side
	 * instead of the whole Panel.
	 */
	hidePaneComposite(id: string, viewContainerLocation: ViewContainerLocation): void;

	/**
	 * Collapse the side of a dual-panel layout that currently has focus.
	 * Returns `true` when a side was closed. Only relevant for the dual-panel
	 * layout; for other parts it is a no-op that returns `false`.
	 */
	hideActivePaneCompositeSide(viewContainerLocation: ViewContainerLocation): boolean;

	/**
	 * Whether the whole Panel should be auto-hidden when it becomes empty.
	 * The dual-panel layout returns `false`: an empty side is collapsed to a
	 * visible drop target by `PanelPart` instead of taking the other side
	 * down with it, so `ViewsService` must not hide the entire Panel.
	 */
	shouldAutoHidePanelWhenEmpty(): boolean;

	/**
	 * Return the last active viewlet id.
	 */
	getLastActivePaneCompositeId(viewContainerLocation: ViewContainerLocation): string;

	/**
	 * Toggle maximization of a single side of the dual-panel layout. The given
	 * side is expanded to fill the whole Panel by collapsing the other side;
	 * toggling again restores the other side. For non-dual layouts this falls
	 * back to whole-panel maximization.
	 */
	toggleSideMaximized(side: 'left' | 'right'): void;

	/**
	 * Whether the given side of the dual-panel layout is currently maximized
	 * (i.e. it fills the Panel because the other side is collapsed).
	 */
	isSideMaximized(side: 'left' | 'right'): boolean;

	/**
	 * Whether the Panel is currently in the dual-panel (split) layout, i.e. the
	 * right side is part of the split. Used by the "Hide Panel" action to decide
	 * whether closing should collapse only the active side (dual layout) or hide
	 * the whole Panel (single-area layout).
	 */
	isDualLayout(): boolean;
}
