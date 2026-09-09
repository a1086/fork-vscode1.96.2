/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, Dimension, EventType, findParentWithClass, getWindow } from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProgressService } from '../../../../platform/progress/common/progress.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane, ViewPaneShowActions } from '../../../browser/parts/views/viewPane.js';
import { IViewletViewOptions } from '../../../browser/parts/views/viewsViewlet.js';
import { Memento, MementoObject } from '../../../common/memento.js';
import { IViewBadge, IViewDescriptorService } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ExtensionKeyedWebviewOriginStore, IOverlayWebview, IWebviewService, WebviewContentPurpose } from '../../webview/browser/webview.js';
import { WebviewWindowDragMonitor } from '../../webview/browser/webviewWindowDragMonitor.js';
import { IWebviewViewService, WebviewView } from './webviewViewService.js';
import { IActivityService, NumberBadge } from '../../../services/activity/common/activity.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';

declare const ResizeObserver: any;

const storageKeys = {
	webviewState: 'webviewState',
} as const;

export class WebviewViewPane extends ViewPane {

	private static _originStore?: ExtensionKeyedWebviewOriginStore;

	private static getOriginStore(storageService: IStorageService): ExtensionKeyedWebviewOriginStore {
		this._originStore ??= new ExtensionKeyedWebviewOriginStore('webviewViews.origins', storageService);
		return this._originStore;
	}

	private static readonly _recycledWebviews = new Map<string, IOverlayWebview>();
	private static readonly _handoffWebviews = new Map<string, IOverlayWebview>();

	private static readonly _livePanes = new Set<WebviewViewPane>();
	private static readonly _viewStates = new Map<string, string | undefined>();
	private static readonly _recycleTTL = 30000;
	private static readonly _lastMoveAt = new Map<string, number>();

	private static _recycle(id: string, webview: IOverlayWebview): void {
		if (webview.state !== undefined) {
			WebviewViewPane._viewStates.set(id, webview.state);
		}
		const displaced = WebviewViewPane._recycledWebviews.get(id);
		if (displaced && displaced !== webview) {
			displaced.dispose();
		}
		WebviewViewPane._recycledWebviews.set(id, webview);
		setTimeout(() => {
			if (WebviewViewPane._recycledWebviews.get(id) === webview) {
				WebviewViewPane._recycledWebviews.delete(id);
				webview.dispose();
			}
		}, WebviewViewPane._recycleTTL);
	}

	static markMove(viewIds: string[]): void {
		const now = Date.now();
		const ids = viewIds.filter(id => {
			const last = WebviewViewPane._lastMoveAt.get(id);
			if (last !== undefined && now - last < 1000) {
				return false;
			}
			WebviewViewPane._lastMoveAt.set(id, now);
			return true;
		});

		for (const id of ids) {
			for (const pane of WebviewViewPane._livePanes) {
				if (pane.id === id && pane._webview.value) {
					const webview = pane._webview.clearAndLeak();
					if (webview) {
						webview.release(pane);
						if (webview.state !== undefined) {
							WebviewViewPane._viewStates.set(id, webview.state);
						}
						WebviewViewPane._handoffWebviews.set(id, webview);
						pane._activated = false;
						pane._webviewDisposables.clear();
					}
					break;
				}
			}
		}

		setTimeout(() => {
			for (const id of ids) {
				const wv = WebviewViewPane._handoffWebviews.get(id);
				if (wv) {
					WebviewViewPane._handoffWebviews.delete(id);
					WebviewViewPane._recycle(id, wv);
				}
			}
		}, 1000);
	}

	private readonly _webview = this._register(new MutableDisposable<IOverlayWebview>());
	private readonly _webviewDisposables = this._register(new DisposableStore());
	private _activated = false;

	private _container?: HTMLElement;
	private _rootContainer?: HTMLElement;
	private _resizeObserver?: any;
	private _observedContainer?: HTMLElement;

	private readonly defaultTitle: string;
	private setTitle: string | undefined;

	private badge: IViewBadge | undefined;
	private readonly activity = this._register(new MutableDisposable<IDisposable>());

	private readonly memento: Memento;
	private readonly viewState: MementoObject;
	private readonly extensionId?: ExtensionIdentifier;

	private _repositionTimeout?: any;
	private _layoutTimeout?: any;

	constructor(
		options: IViewletViewOptions,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IOpenerService openerService: IOpenerService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IActivityService private readonly activityService: IActivityService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IProgressService private readonly progressService: IProgressService,
		@IStorageService private readonly storageService: IStorageService,
		@IViewsService private readonly viewService: IViewsService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IWebviewViewService private readonly webviewViewService: IWebviewViewService,
	) {
		super({ ...options, titleMenuId: MenuId.ViewTitle, showActions: ViewPaneShowActions.WhenExpanded }, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService, hoverService);
		this.extensionId = options.fromExtensionId;
		this.defaultTitle = this.title;

		this.memento = new Memento(`webviewView.${this.id}`, storageService);
		this.viewState = this.memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE);

		this._register(this.onDidChangeBodyVisibility(() => this.updateTreeVisibility()));

		this._register(this.webviewViewService.onNewResolverRegistered(e => {
			if (e.viewType === this.id) {
				// Potentially re-activate if we have a new resolver
				this.updateTreeVisibility();
			}
		}));

		WebviewViewPane._livePanes.add(this);
		this.updateTreeVisibility();
	}

	private readonly _onDidChangeVisibility = this._register(new Emitter<boolean>());
	readonly onDidChangeVisibility = this._onDidChangeVisibility.event;

	private readonly _onDispose = this._register(new Emitter<void>());
	readonly onDispose = this._onDispose.event;

	override dispose() {
		WebviewViewPane._livePanes.delete(this);

		const webview = this._webview.clearAndLeak();
		if (webview) {
			webview.release(this);
			WebviewViewPane._recycle(this.id, webview);
		}

		this._onDispose.fire();

		clearTimeout(this._repositionTimeout);
		clearTimeout(this._layoutTimeout);

		super.dispose();
	}

	override focus(): void {
		super.focus();
		this._webview.value?.focus();
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		if (this._observedContainer && this._observedContainer !== container) {
			this._resizeObserver?.unobserve(this._observedContainer);
			this._observedContainer = undefined;
		}

		this._container = container;
		this._rootContainer = undefined;

		if (!this._resizeObserver) {
			this._resizeObserver = new ResizeObserver(() => {
				this.scheduleLayoutWebview();
			});

			this._register(toDisposable(() => {
				this._resizeObserver.disconnect();
			}));
		}

		if (!this._observedContainer) {
			this._observedContainer = container;
			this._resizeObserver.observe(container);
		}
	}

	public override saveState() {
		if (this._webview.value) {
			this.viewState[storageKeys.webviewState] = this._webview.value.state;
		} else {
			const cachedState = WebviewViewPane._viewStates.get(this.id);
			if (cachedState !== undefined) {
				this.viewState[storageKeys.webviewState] = cachedState;
			}
		}

		this.memento.saveMemento();
		super.saveState();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		this.layoutWebview(new Dimension(width, height));
	}

		private updateTreeVisibility() {
		if (this.isBodyVisible()) {
			this.activate();
			this._webview.value?.claim(this, getWindow(this.element), undefined);
			this._rootContainer = undefined;
			this.scheduleLayoutWebview();
		} else {
			this._webview.value?.release(this);
		}
	}

	private activate() {
		if (this._activated) {
			return;
		}

		this._activated = true;

		const handoff = WebviewViewPane._handoffWebviews.get(this.id);
		if (handoff) {
			WebviewViewPane._handoffWebviews.delete(this.id);
			this.attachWebview(handoff);
			return;
		}

		if (this.takeRecycled()) {
			return;
		}

		this.createNewWebview();
	}

	private takeRecycled(): boolean {
		const webview = WebviewViewPane._recycledWebviews.get(this.id);
		if (!webview) {
			return false;
		}
		WebviewViewPane._recycledWebviews.delete(this.id);
		this.attachWebview(webview);
		return true;
	}

	private createNewWebview(): void {
		const origin = this.extensionId ? WebviewViewPane.getOriginStore(this.storageService).getOrigin(this.id, this.extensionId) : undefined;
		const webview = this.webviewService.createWebviewOverlay({
			origin,
			providedViewType: this.id,
			title: this.title,
			options: { purpose: WebviewContentPurpose.WebviewView, retainContextWhenHidden: true },
			contentOptions: {},
			extension: this.extensionId ? { id: this.extensionId } : undefined
		});
		this.attachWebview(webview);
		this.resolveWebviewView(webview);
	}

	private claimWhenConnected(webview: IOverlayWebview): void {
		let attempts = 0;
		const tryClaim = (): void => {
			if (this._webview.value !== webview) {
				return;
			}
		if (this._container && this.element?.isConnected) {
			webview.claim(this, getWindow(this.element), undefined);
				this.layoutWebview();
				return;
			}
			if (attempts++ < 40) {
				setTimeout(tryClaim, 25);
		} else {
		}
		};

		tryClaim();
	}

	private attachWebview(webview: IOverlayWebview): void {
		if (webview.state === undefined) {
			const cachedState = WebviewViewPane._viewStates.get(this.id);
			const savedState = this.viewState[storageKeys.webviewState];
			const restore = cachedState !== undefined ? cachedState : savedState;
			if (restore !== undefined) {
				webview.state = restore;
			}
		}
		this._webview.value = webview;

		if (this._container) {
			this.layoutWebview();
		}

		this.claimWhenConnected(webview);

		this._webviewDisposables.add(toDisposable(() => {
			this._webview.value?.release(this);
		}));

		this._webviewDisposables.add(webview.onDidUpdateState(() => {
			this.viewState[storageKeys.webviewState] = webview.state;
			WebviewViewPane._viewStates.set(this.id, webview.state);
		}));

		// Re-dispatch all drag events back to the drop target to support view drag drop
		for (const event of [EventType.DRAG, EventType.DRAG_END, EventType.DRAG_ENTER, EventType.DRAG_LEAVE, EventType.DRAG_START]) {
			this._webviewDisposables.add(addDisposableListener(this._webview.value.container, event, e => {
				e.preventDefault();
				e.stopImmediatePropagation();
				this.dropTargetElement.dispatchEvent(new DragEvent(e.type, e));
			}));
		}

		this._webviewDisposables.add(new WebviewWindowDragMonitor(getWindow(this.element), () => this._webview.value));
	}

	private resolveWebviewView(webview: IOverlayWebview): void {
		const source = this._webviewDisposables.add(new CancellationTokenSource());

		this.withProgress(async () => {
			await this.extensionService.activateByEvent(`onView:${this.id}`);

			const self = this;
			const webviewView: WebviewView = {
				webview,
				onDidChangeVisibility: this.onDidChangeBodyVisibility,
				onDispose: this.onDispose,

				get title(): string | undefined { return self.setTitle; },
				set title(value: string | undefined) { self.updateTitle(value); },

				get description(): string | undefined { return self.titleDescription; },
				set description(value: string | undefined) { self.updateTitleDescription(value); },

				get badge(): IViewBadge | undefined { return self.badge; },
				set badge(badge: IViewBadge | undefined) { self.updateBadge(badge); },

				dispose: () => {
					// Only reset and clear the webview itself. Don't dispose of the view container
					this._activated = false;
					this._webview.clear();
					this._webviewDisposables.clear();
				},

				show: (preserveFocus) => {
					this.viewService.openView(this.id, !preserveFocus);
				}
			};

			await this.webviewViewService.resolve(this.id, webviewView, source.token);
		});
	}

	protected override updateTitle(value: string | undefined) {
		this.setTitle = value;
		super.updateTitle(typeof value === 'string' ? value : this.defaultTitle);
	}

	protected updateBadge(badge: IViewBadge | undefined) {

		if (this.badge?.value === badge?.value &&
			this.badge?.tooltip === badge?.tooltip) {
			return;
		}

		this.badge = badge;
		if (badge) {
			const activity = {
				badge: new NumberBadge(badge.value, () => badge.tooltip),
				priority: 150
			};
			this.activity.value = this.activityService.showViewActivity(this.id, activity);
		}
	}

	private async withProgress(task: () => Promise<void>): Promise<void> {
		return this.progressService.withProgress({ location: this.id, delay: 500 }, task);
	}

	override onDidScrollRoot() {
		this.layoutWebview();
	}

	private doLayoutWebview(dimension?: Dimension) {
		const webviewEntry = this._webview.value;
		if (!this._container || !webviewEntry) {
			return;
		}

		if (!this._rootContainer || !this._rootContainer.isConnected || this._rootContainer.ownerDocument !== this._container.ownerDocument || !this._rootContainer.contains(this._container)) {
			this._rootContainer = this.findRootContainer(this._container);
		}

		webviewEntry.layoutWebviewOverElement(this._container, dimension, this._rootContainer);
	}

	private layoutWebview(dimension?: Dimension) {
		this.doLayoutWebview(dimension);
		clearTimeout(this._repositionTimeout);
		this._repositionTimeout = setTimeout(() => this.doLayoutWebview(), 200);
	}

	private scheduleLayoutWebview(): void {
		clearTimeout(this._layoutTimeout);
		const delays = [0, 50, 200];
		let index = 0;
		const run = () => {
			this.doLayoutWebview();
			if (index < delays.length) {
				this._layoutTimeout = setTimeout(run, delays[index++]);
			}
		};
		run();
	}

	private findRootContainer(container: HTMLElement): HTMLElement | undefined {
		if (findParentWithClass(container, 'view-editor-pane')) {
			return undefined;
		}

		return findParentWithClass(container, 'monaco-scrollable-element') ?? undefined;
	}
}
