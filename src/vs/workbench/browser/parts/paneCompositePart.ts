/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/paneCompositePart.css';
import { Event } from '../../../base/common/event.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IProgressIndicator } from '../../../platform/progress/common/progress.js';
import { Extensions, PaneComposite, PaneCompositeDescriptor, PaneCompositeRegistry } from '../panecomposite.js';
import { IPaneComposite } from '../../common/panecomposite.js';
import { IViewDescriptorService, IViewPaneContainer, ViewContainer, ViewContainerLocation } from '../../common/views.js';
import { DisposableStore, MutableDisposable } from '../../../base/common/lifecycle.js';
import { IView } from '../../../base/browser/ui/grid/grid.js';
import { IWorkbenchLayoutService, Parts, SINGLE_WINDOW_PARTS } from '../../services/layout/browser/layoutService.js';
import { CompositePart, ICompositeTitleLabel } from './compositePart.js';
import { IPaneCompositeBarOptions, PaneCompositeBar } from './paneCompositeBar.js';
import { Dimension, EventHelper, trackFocus, $, addDisposableListener, EventType, prepend, getWindow } from '../../../base/browser/dom.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IContextKey, IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import { IExtensionService } from '../../services/extensions/common/extensions.js';
import { IComposite } from '../../common/composite.js';
import { localize } from '../../../nls.js';
import { CompositeDragAndDropObserver, toggleDropEffect } from '../dnd.js';
import { EDITOR_DRAG_AND_DROP_BACKGROUND } from '../../common/theme.js';
import { IPartOptions } from '../part.js';
import { CompositeMenuActions } from '../actions.js';
import { IMenuService, MenuId } from '../../../platform/actions/common/actions.js';
import { ActionsOrientation, prepareActions } from '../../../base/browser/ui/actionbar/actionbar.js';
import { Gesture, EventType as GestureEventType } from '../../../base/browser/touch.js';
import { StandardMouseEvent } from '../../../base/browser/mouseEvent.js';
import { IAction, SubmenuAction } from '../../../base/common/actions.js';
import { Composite } from '../composite.js';
import { ViewsSubMenu } from './views/viewPaneContainer.js';
import { getActionBarActions } from '../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IHoverService } from '../../../platform/hover/browser/hover.js';
import { HiddenItemStrategy, WorkbenchToolBar } from '../../../platform/actions/browser/toolbar.js';

export enum CompositeBarPosition {
	TOP,
	TITLE,
	BOTTOM
}

export interface IPaneCompositePart extends IView {

	readonly partId: Parts | string;

	readonly onDidPaneCompositeOpen: Event<IPaneComposite>;
	readonly onDidPaneCompositeClose: Event<IPaneComposite>;

	/**
	 * Opens a viewlet with the given identifier and pass keyboard focus to it if specified.
	 */
	openPaneComposite(id: string | undefined, focus?: boolean): Promise<IPaneComposite | undefined>;

	/**
	 * Returns the current active viewlet if any.
	 */
	getActivePaneComposite(): IPaneComposite | undefined;

	/**
	 * Returns the viewlet by id.
	 */
	getPaneComposite(id: string): PaneCompositeDescriptor | undefined;

	/**
	 * Returns all enabled viewlets
	 */
	getPaneComposites(): PaneCompositeDescriptor[];

	/**
	 * Returns the progress indicator for the side bar.
	 */
	getProgressIndicator(id: string): IProgressIndicator | undefined;

	/**
	 * Hide the active viewlet.
	 */
	hideActivePaneComposite(): void;

	/**
	 * Clears the active composite's content and toolbar without hiding the
	 * surrounding part. Used when the composite bar loses its active item
	 * (e.g. the user closes the last tab on a side of the dual-panel layout)
	 * but the owning part stays visible. Fires the close event so listeners
	 * can react to the now-empty content area.
	 */
	clearActivePaneComposite(): void;

	/**
	 * Whether the whole Panel should be auto-hidden when it becomes empty.
	 * Defaults to `true`; the dual-panel `PanelPart` overrides this to `false`
	 * so an empty side is collapsed to a visible drop target instead of
	 * removing the other (still wanted) side (see `ViewsService`).
	 */
	shouldAutoHidePanelWhenEmpty(): boolean;

	/**
	 * Return the last active viewlet id.
	 */
	getLastActivePaneCompositeId(): string;

	/**
	 * Returns the view container location of this pane composite part.
	 */
	getViewContainerLocation(): ViewContainerLocation;

	/**
	 * Returns id of pinned view containers following the visual order.
	 */
	getPinnedPaneCompositeIds(): string[];

	/**
	 * Returns id of visible view containers following the visual order.
	 */
	getVisiblePaneCompositeIds(): string[];

	/**
	 * Returns id of all view containers following the visual order.
	 */
	getPaneCompositeIds(): string[];
}

export abstract class AbstractPaneCompositePart extends CompositePart<PaneComposite> implements IPaneCompositePart {

	private static readonly MIN_COMPOSITE_BAR_WIDTH = 50;

	get snap(): boolean {
		// Always allow snapping closed
		// Only allow dragging open if the panel contains view containers
		return this.layoutService.isVisible(this.getGridPartId()) || !!this.paneCompositeBar.value?.getVisiblePaneCompositeIds().length;
	}

	get onDidPaneCompositeOpen(): Event<IPaneComposite> { return Event.map(this.onDidCompositeOpen.event, compositeEvent => <IPaneComposite>compositeEvent.composite); }
	readonly onDidPaneCompositeClose = this.onDidCompositeClose.event as Event<IPaneComposite>;

	protected readonly location: ViewContainerLocation;
	private titleContainer: HTMLElement | undefined;
	private headerFooterCompositeBarContainer: HTMLElement | undefined;
	protected readonly headerFooterCompositeBarDispoables = this._register(new DisposableStore());
	private paneCompositeBarContainer: HTMLElement | undefined;
	protected readonly paneCompositeBar = this._register(new MutableDisposable<PaneCompositeBar>());
	private compositeBarPosition: CompositeBarPosition | undefined = undefined;
	private emptyPaneMessageElement: HTMLElement | undefined;

	private globalToolBar: WorkbenchToolBar | undefined;
	private readonly globalActions: CompositeMenuActions;

	/**
	 * The menu id rendered into the title bar's global action toolbar. Subclasses
	 * (e.g. the dual-panel `PanelSidePart`) override this to scope the actions to
	 * a specific side so each side's "Maximize Panel Size" button only affects
	 * its own side.
	 */
	protected globalActionsMenuId: MenuId;

	/**
	 * Tracks ViewPaneContainer instances whose `onRequestOpenCompositeForView`
	 * event we have already wired up, so single-pane drop switching is handled
	 * exactly once per container (the instances are reused across opens).
	 */
	private readonly registeredViewPaneContainers = new Set<IViewPaneContainer>();

	private blockOpening = false;
	protected contentDimension: Dimension | undefined;

	constructor(
		readonly partId: Parts | string,
		partOptions: IPartOptions,
		activePaneCompositeSettingsKey: string,
		private readonly activePaneContextKey: IContextKey<string>,
		private paneFocusContextKey: IContextKey<boolean>,
		nameForTelemetry: string,
		compositeCSSClass: string,
		titleForegroundColor: string | undefined,
		titleBorderColor: string | undefined,
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService protected readonly viewDescriptorService: IViewDescriptorService,
		@IContextKeyService protected readonly contextKeyService: IContextKeyService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IMenuService protected readonly menuService: IMenuService,
	) {
	let location = ViewContainerLocation.Sidebar;
	let registryId = Extensions.Viewlets;
	let globalActionsMenuId = MenuId.SidebarTitle;
	if (partId === Parts.PANEL_PART) {
		location = ViewContainerLocation.Panel;
		registryId = Extensions.Panels;
		globalActionsMenuId = MenuId.PanelTitle;
	} else if (typeof partId === 'string' && partId.startsWith('workbench.panel.')) {
		// Dual-panel layout: each side (workbench.panel.left / .right) gets its
		// own title-bar action menu so the per-side "Maximize Panel Size" button
		// only controls its own side.
		location = ViewContainerLocation.Panel;
		registryId = Extensions.Panels;
		globalActionsMenuId = partId.endsWith('.left') ? MenuId.PanelTitleLeft : MenuId.PanelTitleRight;
	} else if (partId === Parts.AUXILIARYBAR_PART) {
		location = ViewContainerLocation.AuxiliaryBar;
		registryId = Extensions.Auxiliary;
		globalActionsMenuId = MenuId.AuxiliaryBarTitle;
	}
		super(
			notificationService,
			storageService,
			contextMenuService,
			layoutService,
			keybindingService,
			hoverService,
			instantiationService,
			themeService,
			Registry.as<PaneCompositeRegistry>(registryId),
			activePaneCompositeSettingsKey,
			viewDescriptorService.getDefaultViewContainer(location)?.id || '',
			nameForTelemetry,
			compositeCSSClass,
			titleForegroundColor,
			titleBorderColor,
			partId,
			partOptions
		);

		this.location = location;
		this.globalActionsMenuId = globalActionsMenuId;
		this.globalActions = this._register(this.instantiationService.createInstance(CompositeMenuActions, this.globalActionsMenuId, undefined, undefined));

		this.registerListeners();
	}

	getViewContainerLocation(): ViewContainerLocation {
		return this.location;
	}

	/**
	 * The part id that participates in the workbench grid layout. Sub-parts
	 * (e.g. the left/right sides of the dual-panel layout) are not grid parts
	 * themselves; their grid part is the parent panel part.
	 */
	protected getGridPartId(): SINGLE_WINDOW_PARTS {
		return this.partId as SINGLE_WINDOW_PARTS;
	}

	private registerListeners(): void {
		this._register(this.onDidPaneCompositeOpen(composite => this.onDidOpen(composite)));
		this._register(this.onDidPaneCompositeClose(this.onDidClose, this));
		this._register(this.globalActions.onDidChange(() => this.updateGlobalToolbarActions()));

		this._register(this.registry.onDidDeregister((viewletDescriptor: PaneCompositeDescriptor) => {

			const activeContainers = this.viewDescriptorService.getViewContainersByLocation(this.location)
				.filter(container => this.viewDescriptorService.getViewContainerModel(container).activeViewDescriptors.length > 0);

			if (activeContainers.length) {
				if (this.getActiveComposite()?.getId() === viewletDescriptor.id) {
					const defaultViewletId = this.viewDescriptorService.getDefaultViewContainer(this.location)?.id;
					const containerToOpen = activeContainers.filter(c => c.id === defaultViewletId)[0] || activeContainers[0];
					this.doOpenPaneComposite(containerToOpen.id);
				}
			} else if (this.shouldAutoHidePartWhenEmpty()) {
				// A sub-part (e.g. one side of the dual-panel layout) must NOT
				// hide the whole parent Panel when its last container is
				// deregistered - doing so would take the OTHER (still wanted)
				// side down with it. Only the standalone part hides itself here.
				this.layoutService.setPartHidden(true, this.getGridPartId());
			}

			this.removeComposite(viewletDescriptor.id);
		}));

		this._register(this.extensionService.onDidRegisterExtensions(() => {
			this.layoutCompositeBar();
			this._extensionsRegistered = true;
			this.updatePanelVisibility();
		}));

		// When the last view is dragged out of the Panel (into the editor area,
		// sidebar, auxiliary bar or another container), the Panel part becomes
		// empty. Its default container is *not* generated, so the
		// `onDidDeregister` auto-hide path above never runs. Hide the part here
		// directly so an empty Panel never lingers on screen. Mirrors the
		// `ViewsService.updatePanelVisibility` behaviour but fires synchronously
		// from this part, which is the most reliable trigger for the drag-out case.
		if (this.location === ViewContainerLocation.Panel) {
			// Hide the Panel when its last active view is dragged out (to the
			// editor area, sidebar, auxiliary bar or another container). The default
			// Panel container is not generated, so the `onDidDeregister` auto-hide
			// path above never runs for it - hide here directly instead.
			this._register(this.viewDescriptorService.onDidChangeContainerLocation(({ from }) => {
				if (from === ViewContainerLocation.Panel) {
					this.updatePanelVisibility();
				}
			}));
			const containers = this.viewDescriptorService.getViewContainersByLocation(ViewContainerLocation.Panel);
			for (const container of containers) {
				const model = this.viewDescriptorService.getViewContainerModel(container);
				this._register(model.onDidChangeActiveViewDescriptors(() => this.updatePanelVisibility()));
			}
			this._register(this.viewDescriptorService.onDidChangeViewContainers(({ added }) => {
				for (const { container, location } of added) {
					if (location === ViewContainerLocation.Panel) {
						const model = this.viewDescriptorService.getViewContainerModel(container);
						this._register(model.onDidChangeActiveViewDescriptors(() => this.updatePanelVisibility()));
					}
				}
			}));
		}
	}

	private _extensionsRegistered: boolean = false;

	/**
	 * Hook for split-panel sub-parts. A sub-part emptying out must not hide the
	 * whole parent panel. Defaults to true.
	 */
	protected shouldAutoHidePartWhenEmpty(): boolean {
		return true;
	}

	/**
	 * Hides the Panel part once it no longer hosts any active view, just like
	 * invoking "Hide Panel". Never re-shows the Panel, so an explicit user hide
	 * is not overridden. Only acts on the Panel location.
	 */
	protected updatePanelVisibility(): void {
		if (this.location !== ViewContainerLocation.Panel) {
			return;
		}
		if (!this._extensionsRegistered) {
			return;
		}
		if (!this.shouldAutoHidePartWhenEmpty()) {
			return;
		}
		if (!this.hasActiveViewContainers() && this.layoutService.isVisible(this.getGridPartId())) {
			this.layoutService.setPartHidden(true, this.getGridPartId());
		}
	}

	private onDidOpen(composite: IComposite): void {
		this.activePaneContextKey.set(composite.getId());
	}

	private onDidClose(composite: IComposite): void {
		const id = composite.getId();
		if (this.activePaneContextKey.get() === id) {
			this.activePaneContextKey.reset();
		}
	}

	protected override showComposite(composite: Composite): void {
		super.showComposite(composite);
		this.layoutCompositeBar();
		this.layoutEmptyMessage();
	}

	protected override hideActiveComposite(): Composite | undefined {
		const composite = super.hideActiveComposite();
		this.layoutCompositeBar();
		this.layoutEmptyMessage();
		return composite;
	}

	override create(parent: HTMLElement): void {
		this.element = parent;
		this.element.classList.add('pane-composite-part');

		super.create(parent);

		const contentArea = this.getContentArea();
		if (contentArea) {
			this.createEmptyPaneMessage(contentArea);
		}

		this.updateCompositeBar();

		const focusTracker = this._register(trackFocus(parent));
		this._register(focusTracker.onDidFocus(() => this.paneFocusContextKey.set(true)));
		this._register(focusTracker.onDidBlur(() => this.paneFocusContextKey.set(false)));
	}

	private createEmptyPaneMessage(parent: HTMLElement): void {
		this.emptyPaneMessageElement = document.createElement('div');
		this.emptyPaneMessageElement.classList.add('empty-pane-message-area');

		const messageElement = document.createElement('div');
		messageElement.classList.add('empty-pane-message');
		messageElement.innerText = localize('pane.emptyMessage', "Drag a view here to display.");

		this.emptyPaneMessageElement.appendChild(messageElement);
		parent.appendChild(this.emptyPaneMessageElement);

		this._register(CompositeDragAndDropObserver.INSTANCE.registerTarget(this.element, {
			onDragOver: (e) => {
				// When this part already hosts an active composite (single-view mode in the
				// AuxiliaryBar / Panel), the drop is fully handled by that composite's
				// ViewPaneContainer (which switches the whole content to the dropped view's
				// container). Leave the event alone so it reaches the ViewPaneContainer's own
				// target (registered on a descendant) instead of being intercepted here.
				if (this.getActiveComposite()) {
					return;
				}
				EventHelper.stop(e.eventData, true);
				if (this.paneCompositeBar.value) {
					const validDropTarget = this.paneCompositeBar.value.dndHandler.onDragEnter(e.dragAndDropData, undefined, e.eventData);
					toggleDropEffect(e.eventData.dataTransfer, 'move', validDropTarget);
				}
			},
			onDragEnter: (e) => {
				if (this.getActiveComposite()) {
					return;
				}
				EventHelper.stop(e.eventData, true);
				if (this.paneCompositeBar.value) {
					const validDropTarget = this.paneCompositeBar.value.dndHandler.onDragEnter(e.dragAndDropData, undefined, e.eventData);
					this.emptyPaneMessageElement!.style.backgroundColor = validDropTarget ? this.theme.getColor(EDITOR_DRAG_AND_DROP_BACKGROUND)?.toString() || '' : '';
				}
			},
			onDragLeave: (e) => {
				EventHelper.stop(e.eventData, true);
				this.emptyPaneMessageElement!.style.backgroundColor = '';
			},
			onDragEnd: (e) => {
				EventHelper.stop(e.eventData, true);
				this.emptyPaneMessageElement!.style.backgroundColor = '';
			},
			onDrop: (e) => {
				// Same guard as onDragOver: when the part already shows a composite, the
				// ViewPaneContainer handles the drop (single-pane switch). Do not double-handle
				// here - the two handlers would race and cancel each other out.
				if (this.getActiveComposite()) {
					return;
				}
				EventHelper.stop(e.eventData, true);
				this.emptyPaneMessageElement!.style.backgroundColor = '';
				if (this.paneCompositeBar.value) {
					this.paneCompositeBar.value.dndHandler.drop(e.dragAndDropData, undefined, e.eventData);
				} else {
					// Allow opening views/composites if the composite bar is hidden
					const dragData = e.dragAndDropData.getData();

					if (dragData.type === 'composite') {
						const currentContainer = this.viewDescriptorService.getViewContainerById(dragData.id)!;
						this.viewDescriptorService.moveViewContainerToLocation(currentContainer, this.location, undefined, 'dnd');
						this.openPaneComposite(currentContainer.id, true);
					}

					else if (dragData.type === 'view') {
						const viewToMove = this.viewDescriptorService.getViewDescriptorById(dragData.id)!;
						if (viewToMove && viewToMove.canMoveView) {
							this.viewDescriptorService.moveViewToLocation(viewToMove, this.location, 'dnd');

							const newContainer = this.viewDescriptorService.getViewContainerByViewId(viewToMove.id)!;

							this.openPaneComposite(newContainer.id, true).then(composite => {
								composite?.openView(viewToMove.id, true);
							});
						}
					}
				}
			},
		}));
	}

	protected override createTitleArea(parent: HTMLElement): HTMLElement {
		const titleArea = super.createTitleArea(parent);

		this._register(addDisposableListener(titleArea, EventType.CONTEXT_MENU, e => {
			this.onTitleAreaContextMenu(new StandardMouseEvent(getWindow(titleArea), e));
		}));
		this._register(Gesture.addTarget(titleArea));
		this._register(addDisposableListener(titleArea, GestureEventType.Contextmenu, e => {
			this.onTitleAreaContextMenu(new StandardMouseEvent(getWindow(titleArea), e));
		}));

		const globalTitleActionsContainer = titleArea.appendChild($('.global-actions'));

		// Global Actions Toolbar
		this.globalToolBar = this._register(this.instantiationService.createInstance(WorkbenchToolBar, globalTitleActionsContainer, {
			actionViewItemProvider: (action, options) => this.actionViewItemProvider(action, options),
			orientation: ActionsOrientation.HORIZONTAL,
			getKeyBinding: action => this.keybindingService.lookupKeybinding(action.id),
			anchorAlignmentProvider: () => this.getTitleAreaDropDownAnchorAlignment(),
			toggleMenuTitle: localize('moreActions', "More Actions..."),
			hoverDelegate: this.toolbarHoverDelegate,
			hiddenItemStrategy: HiddenItemStrategy.NoHide
		}));

		this.updateGlobalToolbarActions();

		return titleArea;
	}

	protected override createTitleLabel(parent: HTMLElement): ICompositeTitleLabel {
		this.titleContainer = parent;

		const titleLabel = super.createTitleLabel(parent);
		this.titleLabelElement!.draggable = true;
		const draggedItemProvider = (): { type: 'view' | 'composite'; id: string } => {
			const activeViewlet = this.getActivePaneComposite()!;

			// When the composite hosts a single view merged with its container
			// (e.g. Panel views like Output/Problems), the title bar acts as the
			// drag handle for that single view. Report it as a 'view' so it can be
			// dropped into the editor area just like sidebar views.
			const viewPaneContainer = (activeViewlet as PaneComposite | undefined)?.getViewPaneContainer();
			if (viewPaneContainer && viewPaneContainer.isViewMergedWithContainer() && viewPaneContainer.panes.length === 1) {
				return { type: 'view', id: viewPaneContainer.panes[0].id };
			}


			return { type: 'composite', id: activeViewlet.getId() };
		};

		this._register(CompositeDragAndDropObserver.INSTANCE.registerDraggable(this.titleLabelElement!, draggedItemProvider, {}));

		return titleLabel;
	}

	protected updateCompositeBar(updateCompositeBarOption: boolean = false): void {
		const wasCompositeBarVisible = this.compositeBarPosition !== undefined;
		const isCompositeBarVisible = this.shouldShowCompositeBar();
		const previousPosition = this.compositeBarPosition;
		const newPosition = isCompositeBarVisible ? this.getCompositeBarPosition() : undefined;

		// Only update if the visibility or position has changed or if the composite bar options should be updated
		if (!updateCompositeBarOption && previousPosition === newPosition) {
			return;
		}

		// Remove old composite bar
		if (wasCompositeBarVisible) {
			const previousCompositeBarContainer = previousPosition === CompositeBarPosition.TITLE ? this.titleContainer : this.headerFooterCompositeBarContainer;
			if (!this.paneCompositeBarContainer || !this.paneCompositeBar.value || !previousCompositeBarContainer) {
				throw new Error('Composite bar containers should exist when removing the previous composite bar');
			}

			this.paneCompositeBarContainer.remove();
			this.paneCompositeBarContainer = undefined;
			this.paneCompositeBar.value = undefined;

			previousCompositeBarContainer.classList.remove('has-composite-bar');

			if (previousPosition === CompositeBarPosition.TOP) {
				this.removeFooterHeaderArea(true);
			} else if (previousPosition === CompositeBarPosition.BOTTOM) {
				this.removeFooterHeaderArea(false);
			}
		}

		// Create new composite bar
		let newCompositeBarContainer;
		switch (newPosition) {
			case CompositeBarPosition.TOP: newCompositeBarContainer = this.createHeaderArea(); break;
			case CompositeBarPosition.TITLE: newCompositeBarContainer = this.titleContainer; break;
			case CompositeBarPosition.BOTTOM: newCompositeBarContainer = this.createFooterArea(); break;
		}
		if (isCompositeBarVisible) {

			if (this.paneCompositeBarContainer || this.paneCompositeBar.value || !newCompositeBarContainer) {
				throw new Error('Invalid composite bar state when creating the new composite bar');
			}

			newCompositeBarContainer.classList.add('has-composite-bar');
			this.paneCompositeBarContainer = prepend(newCompositeBarContainer, $('.composite-bar-container'));
			this.paneCompositeBar.value = this.createCompositeBar();
			this.paneCompositeBar.value.create(this.paneCompositeBarContainer);

			if (newPosition === CompositeBarPosition.TOP) {
				this.setHeaderArea(newCompositeBarContainer);
			} else if (newPosition === CompositeBarPosition.BOTTOM) {
				this.setFooterArea(newCompositeBarContainer);
			}
		}

		this.compositeBarPosition = newPosition;

		if (updateCompositeBarOption) {
			this.layoutCompositeBar();
		}
	}

	protected override createHeaderArea(): HTMLElement {
		const headerArea = super.createHeaderArea();
		return this.createHeaderFooterCompositeBarArea(headerArea);
	}

	protected override createFooterArea(): HTMLElement {
		const footerArea = super.createFooterArea();
		return this.createHeaderFooterCompositeBarArea(footerArea);
	}

	protected createHeaderFooterCompositeBarArea(area: HTMLElement): HTMLElement {
		if (this.headerFooterCompositeBarContainer) {
			// A pane composite part has either a header or a footer, but not both
			throw new Error('Header or Footer composite bar already exists');
		}
		this.headerFooterCompositeBarContainer = area;

		this.headerFooterCompositeBarDispoables.add(addDisposableListener(area, EventType.CONTEXT_MENU, e => {
			this.onCompositeBarAreaContextMenu(new StandardMouseEvent(getWindow(area), e));
		}));
		this.headerFooterCompositeBarDispoables.add(Gesture.addTarget(area));
		this.headerFooterCompositeBarDispoables.add(addDisposableListener(area, GestureEventType.Contextmenu, e => {
			this.onCompositeBarAreaContextMenu(new StandardMouseEvent(getWindow(area), e));
		}));

		return area;
	}

	private removeFooterHeaderArea(header: boolean): void {
		this.headerFooterCompositeBarContainer = undefined;
		this.headerFooterCompositeBarDispoables.clear();
		if (header) {
			this.removeHeaderArea();
		} else {
			this.removeFooterArea();
		}
	}

	protected createCompositeBar(): PaneCompositeBar {
		const part = this.location === ViewContainerLocation.Panel ? Parts.PANEL_PART
			: this.location === ViewContainerLocation.AuxiliaryBar ? Parts.AUXILIARYBAR_PART
				: Parts.SIDEBAR_PART;
		return this.instantiationService.createInstance(PaneCompositeBar, this.getCompositeBarOptions(), part, this);
	}

	protected override onTitleAreaUpdate(compositeId: string): void {
		super.onTitleAreaUpdate(compositeId);

		// If title actions change, relayout the composite bar
		this.layoutCompositeBar();
	}

	async openPaneComposite(id?: string, focus?: boolean): Promise<IPaneComposite | undefined> {
		if (typeof id === 'string' && this.getPaneComposite(id)) {
			return this.doOpenPaneComposite(id, focus);
		}

		await this.extensionService.whenInstalledExtensionsRegistered();

		if (typeof id === 'string' && this.getPaneComposite(id)) {
			return this.doOpenPaneComposite(id, focus);
		}

		return undefined;
	}

	private hasActiveViewContainers(): boolean {
		return this.viewDescriptorService
			.getViewContainersByLocation(this.location)
			.filter(container => !this.isBuiltinAlwaysActiveContainer(container))
			.some(container => this.viewDescriptorService.getViewContainerModel(container).activeViewDescriptors.length > 0);
	}

	/**
	 * Containers whose views are built-in and always active (e.g. the Debug
	 * panel's callStack/variables views) should not count as "the part still has
	 * content".  If only such containers remain after the user dragged away all
	 * movable views, the part is effectively empty and should stay hidden.
	 *
	 * This only applies to the Panel: when the same container lives in the
	 * Auxiliary Bar (Debug's default location in this fork) it must still be
	 * considered active so that opening it will reveal the Auxiliary Bar.
	 */
	private isBuiltinAlwaysActiveContainer(container: ViewContainer): boolean {
		return this.location === ViewContainerLocation.Panel && container.id === 'workbench.view.debug';
	}

	/**
	 * Hook for split-panel sub-parts. When the pane composite part is hosted
	 * inside another part (e.g. one half of the dual-panel layout), opening a
	 * view must NOT toggle the visibility of the parent part. Defaults to true.
	 */
	protected shouldAutoRevealPart(): boolean {
		return true;
	}

	private doOpenPaneComposite(id: string, focus?: boolean): IPaneComposite | undefined {
		if (this.blockOpening) {
			return undefined; // Workaround against a potential race condition
		}

		if (this.shouldAutoRevealPart() && !this.layoutService.isVisible(this.getGridPartId())) {
			const hasActive = this.hasActiveViewContainers();
			// Do not force the part back into view when it no longer hosts any
			// view. This happens when the last view was dragged out (e.g. into the
			// editor area): the container stays registered as an empty shell, so the
			// `onDidDeregister` auto-hide path never runs. If we re-show the part here,
			// the empty Panel would flicker back instead of staying hidden.
			if (hasActive) {
				try {
					this.blockOpening = true;
					this.layoutService.setPartHidden(false, this.getGridPartId());
				} finally {
					this.blockOpening = false;
				}
			}
		}

		// Repair an abnormally small panel size when (re)opening a view, e.g.
		// when the panel was already visible but persisted a too-small size.
		if (this.location === ViewContainerLocation.Panel && this.layoutService.isVisible(this.getGridPartId())) {
			this.layoutService.ensurePanelSize();
		}

		const composite = this.openComposite(id, focus) as unknown as IPaneComposite | undefined;

		// Single-pane mode (e.g. a Panel sub-part) reports the dropped view's
		// container through `onRequestOpenCompositeForView` on its
		// ViewPaneContainer. Wire that up once per ViewPaneContainer instance so a
		// subsequent drop replaces the whole content with the dropped view's
		// container instead of being silently ignored.
		const viewPaneContainer = (composite as PaneComposite | undefined)?.getViewPaneContainer?.();
		if (viewPaneContainer && !this.registeredViewPaneContainers.has(viewPaneContainer)) {
			this.registeredViewPaneContainers.add(viewPaneContainer);
			this._register(viewPaneContainer.onRequestOpenCompositeForView(id => this.openPaneComposite(id, true)));
		}

		return composite;
	}

	getPaneComposite(id: string): PaneCompositeDescriptor | undefined {
		return (this.registry as PaneCompositeRegistry).getPaneComposite(id);
	}

	getPaneComposites(): PaneCompositeDescriptor[] {
		return (this.registry as PaneCompositeRegistry).getPaneComposites()
			.sort((v1, v2) => {
				if (typeof v1.order !== 'number') {
					return 1;
				}

				if (typeof v2.order !== 'number') {
					return -1;
				}

				return v1.order - v2.order;
			});
	}

	getPinnedPaneCompositeIds(): string[] {
		return this.paneCompositeBar.value?.getPinnedPaneCompositeIds() ?? [];
	}

	getVisiblePaneCompositeIds(): string[] {
		return this.paneCompositeBar.value?.getVisiblePaneCompositeIds() ?? [];
	}

	getPaneCompositeIds(): string[] {
		return this.paneCompositeBar.value?.getPaneCompositeIds() ?? [];
	}

	getActivePaneComposite(): IPaneComposite | undefined {
		return <IPaneComposite>this.getActiveComposite();
	}

	getLastActivePaneCompositeId(): string {
		return this.getLastActiveCompositeId();
	}

	/**
	 * Hook for split-panel sub-parts. Closing the active view of a sub-part
	 * should only clear that sub-part, not hide the whole parent panel.
	 * Defaults to true.
	 */
	protected shouldHidePartOnClose(): boolean {
		return true;
	}

	hideActivePaneComposite(): void {
		if (this.shouldHidePartOnClose() && this.layoutService.isVisible(this.getGridPartId())) {
			this.layoutService.setPartHidden(true, this.getGridPartId());
		}

		this.hideActiveComposite();
	}

	clearActivePaneComposite(): void {
		// Hide the active composite's content and toolbar but keep the
		// surrounding part visible. The bar lost its active tab (e.g. the user
		// closed the only pinned view on this side of the dual-panel layout
		// and no replacement was auto-opened), so the part should show an empty
		// content area instead of an orphan toolbar.
		// `hideActiveComposite()` already no-ops when there is no active
		// composite, so the guard below is not required.
		this.hideActiveComposite();
	}

	shouldAutoHidePanelWhenEmpty(): boolean {
		// Default behaviour for every part except the dual-panel `PanelPart`,
		// which overrides this to `false` so an empty side does not take the
		// other side down with it.
		return true;
	}

	protected focusCompositeBar(): void {
		this.paneCompositeBar.value?.focus();
	}

	/**
	 * Hook for split-panel sub-parts. A sub-part is laid out whenever its parent
	 * part is visible, regardless of the sub-part's own (non-grid) part id.
	 * Defaults to the standard check.
	 */
	protected isPartVisibleForLayout(): boolean {
		return this.layoutService.isVisible(this.getGridPartId());
	}

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.isPartVisibleForLayout()) {
			return;
		}

		this.contentDimension = new Dimension(width, height);

		// Layout contents
		super.layout(this.contentDimension.width, this.contentDimension.height, top, left);

		// Layout composite bar
		this.layoutCompositeBar();

		// Add empty pane message
		this.layoutEmptyMessage();
	}

	private layoutCompositeBar(): void {
		if (this.contentDimension && this.dimension && this.paneCompositeBar.value) {
			const padding = this.compositeBarPosition === CompositeBarPosition.TITLE ? 16 : 8;
			const borderWidth = this.partId === Parts.PANEL_PART ? 0 : 1;
			let availableWidth = this.contentDimension.width - padding - borderWidth;
			availableWidth = Math.max(AbstractPaneCompositePart.MIN_COMPOSITE_BAR_WIDTH, availableWidth - this.getToolbarWidth());
			this.paneCompositeBar.value.layout(availableWidth, this.dimension.height);
		}
	}

	/**
	 * Refresh the enabled state of every composite tab based on the options
	 * supplied to the composite bar. Used by dual-panel sub-parts to disable
	 * tabs that are already active in the other side.
	 */
	updateCompositeEnabledStates(): void {
		this.paneCompositeBar.value?.updateCompositeEnabledStates();
	}

	pinPaneComposite(id: string): Promise<void> {
		return this.paneCompositeBar.value?.pin(id) ?? Promise.resolve();
	}

	unpinPaneComposite(id: string): void {
		this.paneCompositeBar.value?.unpin(id);
	}

	/**
	 * Force a re-layout of the composite bar so its rendered tabs match the
	 * model. Used after moving a composite off this part (see
	 * `PanelPart.movePaneCompositeToSide`) to guarantee a stale tab is removed
	 * even if an earlier `updateCompositeSwitcher` ran before the bar was laid
	 * out and therefore bailed out early.
	 */
	refreshCompositeBar(): void {
		this.layoutCompositeBar();
	}


	private layoutEmptyMessage(): void {
		const visible = !this.getActiveComposite();
		this.emptyPaneMessageElement?.classList.toggle('visible', visible);
		if (visible) {
			this.titleLabel?.updateTitle('', '');
		}
	}

	private updateGlobalToolbarActions(): void {
		const primaryActions = this.globalActions.getPrimaryActions();
		const secondaryActions = this.globalActions.getSecondaryActions();
		this.globalToolBar?.setActions(prepareActions(primaryActions), prepareActions(secondaryActions));
	}

	protected getToolbarWidth(): number {
		if (!this.toolBar || this.compositeBarPosition !== CompositeBarPosition.TITLE) {
			return 0;
		}

		const activePane = this.getActivePaneComposite();
		if (!activePane) {
			return 0;
		}

		// Each toolbar item has 4px margin
		const toolBarWidth = this.toolBar.getItemsWidth() + this.toolBar.getItemsLength() * 4;
		const globalToolBarWidth = this.globalToolBar ? this.globalToolBar.getItemsWidth() + this.globalToolBar.getItemsLength() * 4 : 0;
		return toolBarWidth + globalToolBarWidth + 5; // 5px padding left
	}

	private onTitleAreaContextMenu(event: StandardMouseEvent): void {
		if (this.shouldShowCompositeBar() && this.getCompositeBarPosition() === CompositeBarPosition.TITLE) {
			return this.onCompositeBarContextMenu(event);
		} else {
			const activePaneComposite = this.getActivePaneComposite() as PaneComposite;
			const activePaneCompositeActions = activePaneComposite ? activePaneComposite.getContextMenuActions() : [];
			if (activePaneCompositeActions.length) {
				this.contextMenuService.showContextMenu({
					getAnchor: () => event,
					getActions: () => activePaneCompositeActions,
					getActionViewItem: (action, options) => this.actionViewItemProvider(action, options),
					actionRunner: activePaneComposite.getActionRunner(),
					skipTelemetry: true
				});
			}
		}
	}

	private onCompositeBarAreaContextMenu(event: StandardMouseEvent): void {
		return this.onCompositeBarContextMenu(event);
	}

	private onCompositeBarContextMenu(event: StandardMouseEvent): void {
		if (this.paneCompositeBar.value) {
			const actions: IAction[] = [...this.paneCompositeBar.value.getContextMenuActions()];
			if (actions.length) {
				this.contextMenuService.showContextMenu({
					getAnchor: () => event,
					getActions: () => actions,
					skipTelemetry: true
				});
			}
		}
	}

	protected getViewsSubmenuAction(): SubmenuAction | undefined {
		const viewPaneContainer = (this.getActivePaneComposite() as PaneComposite)?.getViewPaneContainer();
		if (viewPaneContainer) {
			const disposables = new DisposableStore();
			const scopedContextKeyService = disposables.add(this.contextKeyService.createScoped(this.element));
			scopedContextKeyService.createKey('viewContainer', viewPaneContainer.viewContainer.id);
			const menu = this.menuService.getMenuActions(ViewsSubMenu, scopedContextKeyService, { shouldForwardArgs: true, renderShortTitle: true });
			const viewsActions = getActionBarActions(menu, () => true).primary;
			disposables.dispose();
			return viewsActions.length > 1 && viewsActions.some(a => a.enabled) ? new SubmenuAction('views', localize('views', "Views"), viewsActions) : undefined;
		}
		return undefined;
	}

	protected abstract shouldShowCompositeBar(): boolean;
	protected abstract getCompositeBarOptions(): IPaneCompositeBarOptions;
	protected abstract getCompositeBarPosition(): CompositeBarPosition;
}
