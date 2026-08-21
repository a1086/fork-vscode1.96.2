/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { IAction, toAction } from '../../../base/common/actions.js';
import { IActivity } from '../../services/activity/common/activity.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ActionBar, ActionsOrientation } from '../../../base/browser/ui/actionbar/actionbar.js';
import { CompositeActionViewItem, CompositeOverflowActivityAction, CompositeOverflowActivityActionViewItem, CompositeBarAction, ICompositeBar, ICompositeBarColors, IActivityHoverOptions } from './compositeBarActions.js';
import { tryClaimViewDragSession, nextViewDragSession, releaseViewDragSession, setSuppressPanelRelayoutOnDragOut } from './viewDragSession.js';
import { Dimension, $, addDisposableListener, EventType, EventHelper, isAncestor, getWindow } from '../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../base/browser/mouseEvent.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { Widget } from '../../../base/browser/ui/widget.js';
import { isUndefinedOrNull } from '../../../base/common/types.js';
import { IColorTheme } from '../../../platform/theme/common/themeService.js';
import { Emitter } from '../../../base/common/event.js';
import { ViewContainerLocation, ViewVisibilityState, IViewDescriptor, IViewDescriptorService } from '../../common/views.js';
import { IPaneComposite } from '../../common/panecomposite.js';
import { IComposite } from '../../common/composite.js';
import { CompositeDragAndDropData, CompositeDragAndDropObserver, IDraggedCompositeData, ICompositeDragAndDrop, Before2D, toggleDropEffect, ICompositeDragAndDropObserverCallbacks } from '../dnd.js';
import { IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import { IHostService } from '../../services/host/browser/host.js';
import { ViewEditorInput } from '../../contrib/viewInEditor/browser/viewEditorInput.js';
import { Gesture, EventType as TouchEventType, GestureEvent } from '../../../base/browser/touch.js';

export interface ICompositeBarItem {

	readonly id: string;

	name?: string;
	pinned: boolean;
	order?: number;
	visible: boolean;
}



export class CompositeDragAndDrop implements ICompositeDragAndDrop {

	constructor(
		private viewDescriptorService: IViewDescriptorService,
		private targetContainerLocation: ViewContainerLocation,
		private orientation: ActionsOrientation,
		private openComposite: (id: string, focus?: boolean) => Promise<IPaneComposite | null>,
		private moveComposite: (from: string, to: string, before?: Before2D) => void,
		private getItems: () => ICompositeBarItem[]
	) { }

	drop(data: CompositeDragAndDropData, targetCompositeId: string | undefined, originalEvent: DragEvent, before?: Before2D): void {
		const dragData = data.getData();

		if (dragData.type === 'composite') {
			const currentContainer = this.viewDescriptorService.getViewContainerById(dragData.id)!;
			const currentLocation = this.viewDescriptorService.getViewContainerLocation(currentContainer);
			let moved = false;

			// ... on the same composite bar
			if (currentLocation === this.targetContainerLocation) {
				if (targetCompositeId) {
					this.moveComposite(dragData.id, targetCompositeId, before);
					moved = true;
				}
			}
			// ... on a different composite bar
			else {
				this.viewDescriptorService.moveViewContainerToLocation(currentContainer, this.targetContainerLocation, this.getTargetIndex(targetCompositeId, before), 'dnd');
				moved = true;
			}

			if (moved) {
				this.openComposite(currentContainer.id, true);
			}
		}

		if (dragData.type === 'view') {
			const viewToMove = this.viewDescriptorService.getViewDescriptorById(dragData.id)!;
			if (viewToMove && viewToMove.canMoveView) {
				// When dropping onto the bar (no specific target tab), reuse an existing
				// container at the target location instead of letting moveViewToLocation
				// generate a fresh random container. A generated container can be cleaned up
				// immediately by the generated-containers cleanup logic, making the view vanish.
				const existingContainers = this.viewDescriptorService.getViewContainersByLocation(this.targetContainerLocation);
				const targetContainer = existingContainers.find(c => this.viewDescriptorService.getViewContainerModel(c).allViewDescriptors.length === 0)
					?? existingContainers[0];

				if (targetContainer) {
					this.viewDescriptorService.moveViewsToContainer([viewToMove], targetContainer, ViewVisibilityState.Default, 'dnd');
				} else {
					this.viewDescriptorService.moveViewToLocation(viewToMove, this.targetContainerLocation, 'dnd');
				}

				const newContainer = this.viewDescriptorService.getViewContainerByViewId(viewToMove.id)!;

				if (targetCompositeId) {
					this.moveComposite(newContainer.id, targetCompositeId, before);
				}

				this.openComposite(newContainer.id, true).then(composite => {
					composite?.openView(viewToMove.id, true);
				});
			}
		}
	}

	onDragEnter(data: CompositeDragAndDropData, targetCompositeId: string | undefined, originalEvent: DragEvent): boolean {
		return this.canDrop(data, targetCompositeId);
	}

	onDragOver(data: CompositeDragAndDropData, targetCompositeId: string | undefined, originalEvent: DragEvent): boolean {
		return this.canDrop(data, targetCompositeId);
	}

	private getTargetIndex(targetId: string | undefined, before2d: Before2D | undefined): number | undefined {
		if (!targetId) {
			return undefined;
		}

		const items = this.getItems();
		const before = this.orientation === ActionsOrientation.HORIZONTAL ? before2d?.horizontallyBefore : before2d?.verticallyBefore;
		return items.filter(item => item.visible).findIndex(item => item.id === targetId) + (before ? 0 : 1);
	}

	private canDrop(data: CompositeDragAndDropData, targetCompositeId: string | undefined): boolean {
		const dragData = data.getData();

		if (dragData.type === 'composite') {

			// Dragging a composite
			const currentContainer = this.viewDescriptorService.getViewContainerById(dragData.id)!;
			const currentLocation = this.viewDescriptorService.getViewContainerLocation(currentContainer);

			// ... to the same composite location
			if (currentLocation === this.targetContainerLocation) {
				return dragData.id !== targetCompositeId;
			}

			return true;
		} else {

			// Dragging an individual view
			const viewDescriptor = this.viewDescriptorService.getViewDescriptorById(dragData.id);

			// ... that cannot move
			if (!viewDescriptor || !viewDescriptor.canMoveView) {
				return false;
			}

			// ... to create a view container
			return true;
		}
	}
}

export interface ICompositeBarOptions {

	readonly icon: boolean;
	readonly orientation: ActionsOrientation;
	readonly colors: (theme: IColorTheme) => ICompositeBarColors;
	readonly compact?: boolean;
	readonly compositeSize: number;
	readonly overflowActionSize: number;
	readonly dndHandler: ICompositeDragAndDrop;
	readonly activityHoverOptions: IActivityHoverOptions;
	readonly preventLoopNavigation?: boolean;
	readonly showCloseButton?: boolean;
	readonly closeActiveComposite?: () => void;
	/**
	 * Fired when the bar loses its active composite (e.g. after unpinning the
	 * active tab) and finds no replacement to auto-open (no default composite is
	 * pinned, no other visible composite exists). The owning part can use this
	 * to also clear its own active composite content - otherwise, in the
	 * dual-panel layout, the side's title-actions would keep rendering the
	 * closed tab's toolbar (e.g. the Terminal profile dropdown) with no tab in
	 * the bar to back it.
	 */
	readonly onDidCloseActiveComposite?: () => void;
	/**
	 * When true (default), clicking the close button on the last remaining
	 * pinned composite hides the entire part via `workbench.action.togglePanel`.
	 * Set to false for sub-parts (e.g. one side of the dual-panel layout) where
	 * closing the last composite should only clear that sub-part and let the
	 * owning layout collapse it.
	 */
	readonly hidePartOnLastPinnedClose?: boolean;
	/**
	 * When provided, clicking the close button hides the entire sub-part (e.g.
	 * one side of the dual-panel layout) instead of just unpinning the active
	 * composite. The owning layout then collapses that sub-part so the other
	 * side fills the area. Takes precedence over `hidePartOnLastPinnedClose`.
	 */
	readonly hideSide?: () => void;
	/**
	 * When set to true, the overflow action ("...") will not be shown and
	 * all composites will be displayed in the bar regardless of available space.
	 */
	readonly disableOverflow?: boolean;

	readonly getActivityAction: (compositeId: string) => CompositeBarAction;
	readonly getCompositePinnedAction: (compositeId: string) => IAction;
	readonly getCompositeBadgeAction: (compositeId: string) => IAction;
	readonly getOnCompositeClickAction: (compositeId: string) => IAction;
	readonly fillExtraContextMenuActions: (actions: IAction[], e?: MouseEvent | GestureEvent) => void;
	readonly getContextMenuActionsForComposite: (compositeId: string) => IAction[];

	readonly openComposite: (compositeId: string, preserveFocus?: boolean) => Promise<IComposite | null>;
	readonly getDefaultCompositeId: () => string | undefined;
	readonly isCompositeDraggable?: (compositeId: string) => boolean;
}

class CompositeBarDndCallbacks implements ICompositeDragAndDropObserverCallbacks {

	private insertDropBefore: Before2D | undefined = undefined;

	/**
	 * 防止同一拖拽事件触发多次开窗：
	 * - `registerTarget(parent, ...)` 给整个 bar 容器注册了一次 dnd 回调；
	 * - 每个 `CompositeActionViewItem` 自身的 `pane.draggableElement` 也注册了 `registerDraggable`，
	 *   它的 `onDragEnd` 在 `dnd.ts:577` 内部也会 `_onDragEnd.fire(...)`；
	 * - Panel 与 Aux Bar 各有独立 `CompositeBar`/`CompositeBarDndCallbacks` 实例，
	 *   它们的 `onDragEnd` 都会触发；
	 * - 把视图 `moveViewToLocation(Editor)` 后，原生 `editorTabsControl` 的拖出链路
	 *   还会再开一个窗口。
	 * 单靠实例级布尔无法跨多个实例去重，因此改为：在 dragstart 写入全局 sessionId
	 * 到 dataTransfer，onDragEnd 用 `tryClaimViewDragSession` 整进程级去重（见下方
	 * 模块级守卫 `nextViewDragSession` / `tryClaimViewDragSession`），并把 `move`
	 * 延迟到本次 dragend 事件循环结束之后，彻底切断原生链路的二次开窗。
	 */

	constructor(
		private readonly compositeBarContainer: HTMLElement,
		private readonly actionBarContainer: HTMLElement,
		private readonly compositeBarModel: CompositeBarModel,
		private readonly dndHandler: ICompositeDragAndDrop,
		private readonly orientation: ActionsOrientation,
		private readonly editorGroupsService: IEditorGroupsService,
		private readonly hostService: IHostService,
		private readonly viewDescriptorService: IViewDescriptorService,
		private readonly instantiationService: IInstantiationService,
	) { }

	onDragOver(e: IDraggedCompositeData) {

		// don't add feedback if this is over the composite bar actions or there are no actions
		const visibleItems = this.compositeBarModel.visibleItems;
		if (!visibleItems.length || (e.eventData.target && isAncestor(e.eventData.target as HTMLElement, this.actionBarContainer))) {
			this.insertDropBefore = this.updateFromDragging(this.compositeBarContainer, false, false, true);
			return;
		}

		const insertAtFront = this.insertAtFront(this.actionBarContainer, e.eventData);
		const target = insertAtFront ? visibleItems[0] : visibleItems[visibleItems.length - 1];
		const validDropTarget = this.dndHandler.onDragOver(e.dragAndDropData, target.id, e.eventData);
		toggleDropEffect(e.eventData.dataTransfer, 'move', validDropTarget);
		this.insertDropBefore = this.updateFromDragging(this.compositeBarContainer, validDropTarget, insertAtFront, true);
	}

	onDragLeave(e: IDraggedCompositeData) {
		this.insertDropBefore = this.updateFromDragging(this.compositeBarContainer, false, false, false);
	}

	onDragStart(e: IDraggedCompositeData) {
		// 每次拖拽开始时递增 sessionId，确保 onDragEnd 的 claim 去重能正确区分
		// 不同轮次的拖拽。如果不调用 nextViewDragSession()，sessionId 永远是 -1，
		// 导致第一次拖拽后 __lastViewDragSessionHandled 被置为 true，后续所有拖拽
		// 的 tryClaimViewDragSession 都返回 false → "再拖其他视图就拖不出来"。
		nextViewDragSession();
	}

	async onDragEnd(e: IDraggedCompositeData) {
		this.insertDropBefore = this.updateFromDragging(this.compositeBarContainer, false, false, false);

		// Phase 3: 拖出窗口（方案 A）
		// 判定：受 `workbench.editor.dragToOpenWindow` 控制，Alt 键反转。
		// 注意：不依赖 `isWindowDraggedOver()` 来否决开窗——该 tracker 依赖窗口内
		// DRAG_OVER 事件把 draggedOver 置 true，但把 tab 拖出窗口边界释放时原窗口
		// 收不到可靠的 DRAG_LEAVE，导致 draggedOver 一直为 true，从而把"拖出窗口"
		// 误判为"仍在窗口内"而拒绝开窗（这正是 Panel / Aux Bar 拖不出来的根因）。
		// "是否拖出窗口"改由 `openInAuxiliaryWindow` 内部用光标几何判定（与
		// editorTabsControl#maybeCreateAuxiliaryEditorPartAt 一致）。
		const isNewWindowOperation = this.editorGroupsService.partOptions.dragToOpenWindow ? !e.eventData.altKey : e.eventData.altKey;
		if (isNewWindowOperation) {
			// 全局去重：基于 viewId 的"进行中集合"守卫（见 viewDragSession.ts）。
			// 同一拖拽的多个 onDragEnd 回调（bar 容器 registerTarget、
			// tab registerDraggable、原生 editor tabs 拖出链路）会传入相同的 viewId，
			// 只有首个处理者 claim 成功，其余直接跳过。
			// 不同 viewId（如先拖 Watch 再拖 Call Stack）互不影响，可分别拖出
			// 各自独立的窗口。
			//
			// 关键修复（v5 — 消除竞态条件）：
			// tryClaimViewDragSession 是**同步**调用，必须在任何 await 之前执行。
			// v4 版本虽然也用了 Set 去重，但在 claim 之后、实际开窗之前有
			// `await getCursorScreenPoint()` 等异步操作。当 await 让出执行权后，
			// 另一个 CompositeBarDndCallbacks 实例（如 Aux Bar 的 onDragEnd）
			// 可以在同一事件循环微任务中执行到 tryClaimViewDragSession，
			// 此时 __pendingViews 尚未被第一个回调 add（因为第一个回调还停在 await 上），
			// 导致两个回调都通过 has() 检查 → 都返回 true → 各自打开一个独立窗口。
			// 这就是"拖出一个 Watch 视图却出现两个独立 Watch 窗口"的根因。
			//
			// 修复：claim 在此同步段立即执行，Set.add() 在返回前已完成。
			// 后续所有 await 都在 claim 之后，其他回调看到的已是已被占有的状态。
			const { type: dragType, id: dragId } = e.dragAndDropData.getData();
			const claimViewId = `${dragType}:${dragId}`; // 用 type:id 组合作为唯一键
const claimResult = tryClaimViewDragSession(claimViewId);
		if (!claimResult) {
			return;
		}
		try {
				await this.openInAuxiliaryWindow(e);
			} finally {
				// 关键修复（拖一个视图却开出多个窗口）：
				// 不能在本回合开窗一结束就立即释放 claim。因为 openInAuxiliaryWindow
				// 内部最后用 `setTimeout(moveViewToLocation, 0)` 把视图 move 到
				// Editor 区，原生 editorTabsControl 的拖出链路（或其它同源的
				// onDragEnd 回调）可能在 move 之后、本次拖拽真正收尾之前再触发一次
				// 开窗（这就是"拖出一个，却冒出 3 个独立窗口"的来源）。
				// 因此把 claim 的释放延迟到本回合所有异步收尾（含上面的 setTimeout
				// move 及其后续）完成之后，确保那些二次开窗请求在锁释放前被挡掉。
				// 延迟时长需大于 openInAuxiliaryWindow 内部的 setTimeout(0) 及原生
				// 链路的可能异步耗时，这里取 300ms。
				setTimeout(() => releaseViewDragSession(claimViewId), 300);
			}
		}
	}

	private async openInAuxiliaryWindow(e: IDraggedCompositeData): Promise<void> {
		try {
			const { type, id } = e.dragAndDropData.getData();

			// 解析出要承载的视图 id：
		// - 拖 'view' 类型：id 直接就是 view id，`getViewDescriptorById` 能解析。
		// - 拖 'composite' 类型：id 是 container id（如 Aux Bar 的 `workbench.view.debug`、
		//   Panel 的 `workbench.panel.terminal`）。`getViewDescriptorById(containerId)`
		//   必然返回 undefined，因此必须先用 `getViewContainerById` 取出容器，再取它的
		//   第一个（也是唯一可承载拖出窗口的）视图描述符。
		// 旧实现对 composite 类型只做了 `getViewDescriptorById(id) ?? id`，等于拿
		// container id 当 view id 去查，结果永远 undefined → 直接 return 不开窗。
		// 这正是"从 Aux Bar 拖不出视图"的根因：Aux Bar 上的面板几乎都是多视图容器，
		// 拖出来的类型一律是 'composite'，于是永远解析失败。Panel 上能拖出来是因为
		// Problems/Output 等是单视图容器，走了 `type: 'view'` 分支。
		let descriptor: IViewDescriptor | undefined;
		if (type === 'view') {
			descriptor = this.viewDescriptorService.getViewDescriptorById(id) ?? undefined;
		} else if (type === 'composite') {
			const container = this.viewDescriptorService.getViewContainerById(id);
			if (container) {
				const model = this.viewDescriptorService.getViewContainerModel(container);
				descriptor = model?.activeViewDescriptors[0] ?? model?.allViewDescriptors[0];
			}
		}

		if (!descriptor) {
			return;
		}

		// 只对来源于 Panel / Auxiliary Bar 的视图开窗。Side Bar（如 Explorer 资源
		// 管理器）和 Editor 区的视图走各自的原生链路（Side Bar 视图由
		// `editorPart.ts` 的拖入 editor 区逻辑承载，Editor 区视图已在编辑器内）。
		// 关键：Explorer 等 Side Bar 视图强耦合其侧边栏容器与 `ExplorerService`，
		// 一旦被 `moveViewToLocation(Editor)` 并塞进 `ViewEditorPane`，
		// `ExplorerService.refresh()` 会在 `findProvider` 尚未初始化时访问它，
		// 抛出 "Cannot read properties of undefined (reading 'isShowingFilterResults')"
		// （即截图中的报错），导致浮动窗口白屏。因此这里直接跳过非
		// Panel / AuxiliaryBar 的视图，避免崩溃。
		const sourceLocation = this.viewDescriptorService.getViewLocationById(descriptor.id);
		if (sourceLocation !== ViewContainerLocation.Panel && sourceLocation !== ViewContainerLocation.AuxiliaryBar) {
			return;
		}

		// 取当前光标屏幕坐标作为新窗口 bounds（参照 editorTabsControl#maybeCreateAuxiliaryEditorPartAt）。
		const screenPoint = await this.hostService.getCursorScreenPoint();

		const targetWindow = getWindow(this.compositeBarContainer);

		// 几何否决判定（"鼠标仍在本窗口内 → 不开窗"）。
		// 注意（Aux Bar 拖不出来的根因之一）：
		// Chromium 在 `dragend` 事件里 `event.screenX/screenY` **不反映释放时的
		// 光标位置**（多数平台回退到拖拽开始时的坐标，甚至 0）。Aux Bar 标签本来就
		// 贴着窗口边缘，拖拽开始的 screenX/Y 一定落在窗口矩形内；一旦
		// `getCursorScreenPoint()` 在该环境下拿不到值而用 `screenX/Y` 兜底，就会
		// 把"已拖出窗口"误判为"仍在窗口内"而直接 return，表现为 Aux Bar 永远拖不出。
		// 因此：只有当 `getCursorScreenPoint()` 真的返回了坐标时才用该坐标做精确几何否决。
		//
		// 关键修复（栏内跨侧拖拽产生重复视图）：
		// 当 `getCursorScreenPoint()` 返回 undefined（Chromium dragend 常见）时，旧实现
		// 直接跳过否决并无条件开窗，于是 Panel 栏内"从一侧拖到另一侧"这种纯栏内移动
		// 也会被开出一个浮动窗口、并把视图 move 到 Editor 区，结果原视图在新窗口/Editor
		// 区与新窗口里各出现一份 → 表现为"视图重复"（截图里的 WATCH/TERMINAL 多副本）。
		// 对齐 editorTabsControl#maybeCreateAuxiliaryEditorPartAt 的做法：当拿不到真实
		// 光标坐标、但源窗口仍可见且有焦点时（即释放点必然还在本窗口内，是一次栏内
		// 移动或拖回窗口），直接拒绝开窗；只有当窗口已失去焦点（真正拖出窗口）才开窗。
		const windowStillFocused = targetWindow.document.visibilityState === 'visible' && targetWindow.document.hasFocus();
		if (screenPoint) {
			const point = screenPoint.point;
			if (point.x >= targetWindow.screenX && point.x <= targetWindow.screenX + targetWindow.outerWidth
				&& point.y >= targetWindow.screenY && point.y <= targetWindow.screenY + targetWindow.outerHeight) {
				return; // 鼠标仍在本窗口内，不开窗（视为栏内移动 / 拖回窗口）
			}
		} else if (windowStillFocused) {
			return; // 拿不到光标坐标且源窗口仍聚焦 → 视为栏内移动，拒绝开窗（消除重复视图）
		}

		let bounds: { x: number; y: number } | undefined;
		if (screenPoint) {
			bounds = { x: screenPoint.point.x, y: screenPoint.point.y };
			// 跨多显示器保护：防止窗口溢出到屏幕/显示器左上与上方之外。
			const display = screenPoint.display;
			if (display) {
				if (bounds.x < display.x) {
					bounds.x = display.x;
				}
				if (bounds.y < display.y) {
					bounds.y = display.y;
				}
			}
		}

		// 关键修复：先开辅助窗口 + openEditor，最后才把视图 move 到 Editor 区。
		// 旧实现先 move 再 create 会让视图短暂出现在主窗口 editor 区，
		// 触发原生 `editorTabsControl` 的拖出链路（onDragEnd 二次回调），结果多开窗口。
		// 新顺序：view 还在原栏 → 不会出现在主窗口 editor → 原生链路不会介入 → 干净单窗口。
		const auxiliaryEditorPart = await this.editorGroupsService.createAuxiliaryEditorPart({ bounds });
		const targetGroup = auxiliaryEditorPart.activeGroup;

		// 对于 composite 类型（多视图容器如 Debug），将所有活跃视图都打开到
		// 浮动窗口中。单一视图类型则只打开那一个。
		// 这确保用户拖出 Debug 容器时能看到完整的调试面板（Breakpoints、
		// Call Stack、Watch、Variables），而不是只有一个空的子视图。
		//
		// 重要：viewsToOpen 决定了哪些视图会被 moveViewToLocation(Editor)。
		// 如果把容器中所有视图都 move 走，后续再拖该容器的其他子视图时，
		// getViewLocationById 会返回 Editor → 被 location check 拦截 → 无法再次开窗。
		// 因此只有 type === 'composite'（拖的是容器 tab 本身）时才全量 move；
		// type === 'view'（拖的是具体子视图）时只 move 那一个。
		const viewsToOpen = type === 'composite'
			? (() => {
					const container = this.viewDescriptorService.getViewContainerById(id);
					const model = container ? this.viewDescriptorService.getViewContainerModel(container) : null;
					return model?.activeViewDescriptors.length
						? model.activeViewDescriptors
						: (model?.allViewDescriptors ?? []);
			  })()
			: [descriptor];

		for (const v of viewsToOpen) {
			const vOriginalLocation = this.viewDescriptorService.getViewLocationById(v.id) ?? undefined;
			const vOriginalContainer = this.viewDescriptorService.getViewContainerByViewId(v.id);
			const vOriginalContainerId = vOriginalContainer?.id ?? undefined;
			// 记录该视图在原容器内的顺序位置，关闭浮动窗口归位时用来还原排序，
			// 否则 WATCH 等中间位置的子视图会跑到 Debug 容器顶部。
			const vOriginalIndex = vOriginalContainer
				? this.viewDescriptorService.getViewContainerModel(vOriginalContainer).allViewDescriptors.findIndex(d => d.id === v.id)
				: -1;
			const input = this.instantiationService.createInstance(
				ViewEditorInput,
				v.id,
				vOriginalLocation,
				vOriginalContainerId,
				vOriginalIndex >= 0 ? vOriginalIndex : undefined
			);
			await targetGroup.openEditor(input, { pinned: true });
		}
		targetGroup.focus();

		// 此时再把视图从原栏移除（视图已经承载在新窗口的 ViewEditorPane 里，
		// 原栏不再需要它）。这一步会让原 composite bar 隐藏对应 tab，
		// 但因为 ViewEditorInput 是 Singleton，原窗口不会再现。
		//
		// 关键：延迟到当前 dragend 事件循环完全结束之后再 move。
		// 若立即 move，ViewEditorPane 的 tab 会立刻出现在本窗口 editor 区，
		// 而此时原生 `editorTabsControl.onDragEnd` 拖出链路仍在运行、会捕获到该 tab
		// 并再开一个浮动窗口（这就是"拖出三个窗口"的第三个来源）。
		// 用一个 microtask/timeout 让原生链路先跑完（此时视图尚未进入 editor 区、
		// 拿不到该 tab），再执行 move，即不会再触发二次开窗。
		//
		// 重要：只 move viewsToOpen 中的视图。对于 type === 'view'（拖的是子视图），
		// viewsToOpen 只包含那一个视图，不会影响同容器的其他子视图。
		// 这样用户可以逐个把 Debug 容器的 Watch、Call Stack 等分别拖到独立窗口。
		const viewDescriptorService = this.viewDescriptorService;
		setTimeout(() => {
			// 拖出窗口期间抑制 Panel 区域重新渲染闪烁（见 viewDragSession.ts 的
			// `isSuppressPanelRelayoutOnDragOut` 说明）：置位开关，move 把视图从
			// 原 Panel 容器移走时，Panel 侧不会把最小高度从 77 抬到 350 触发整区
			// 重布局、也不会 fallback 重开其它容器，避免"拖出时 Panel 闪一下"。
			setSuppressPanelRelayoutOnDragOut(true);
			for (const v of viewsToOpen) {
				viewDescriptorService.moveViewToLocation(v, ViewContainerLocation.Editor, 'dnd-composite-to-window');
			}
			// 必须在 fallback 调度器（RunOnceScheduler(0)）之后清除开关：fallback 在
			// 上面的 move 触发 close 事件时已排队到下一帧，这里再排一个 0 延时确保
			// 它先于本清除执行，使本次拖出收尾干净、且不影响后续常规关闭行为。
			setTimeout(() => setSuppressPanelRelayoutOnDragOut(false), 0);
		}, 0);
		} catch (error) {
			// swallow: opening an auxiliary window for a view is best-effort
		}
	}

	onDrop(e: IDraggedCompositeData) {
		const visibleItems = this.compositeBarModel.visibleItems;
		let targetId = undefined;
		if (visibleItems.length) {
			targetId = this.insertAtFront(this.actionBarContainer, e.eventData) ? visibleItems[0].id : visibleItems[visibleItems.length - 1].id;
		}
		this.dndHandler.drop(e.dragAndDropData, targetId, e.eventData, this.insertDropBefore);
		this.insertDropBefore = this.updateFromDragging(this.compositeBarContainer, false, false, false);
	}

	private insertAtFront(element: HTMLElement, event: DragEvent): boolean {
		const rect = element.getBoundingClientRect();
		const posX = event.clientX;
		const posY = event.clientY;

		switch (this.orientation) {
			case ActionsOrientation.HORIZONTAL:
				return posX < rect.left;
			case ActionsOrientation.VERTICAL:
				return posY < rect.top;
		}
	}

	private updateFromDragging(element: HTMLElement, showFeedback: boolean, front: boolean, isDragging: boolean): Before2D | undefined {
		element.classList.toggle('dragged-over', isDragging);
		element.classList.toggle('dragged-over-head', showFeedback && front);
		element.classList.toggle('dragged-over-tail', showFeedback && !front);

		if (!showFeedback) {
			return undefined;
		}

		return { verticallyBefore: front, horizontallyBefore: front };
	}
}

export class CompositeBar extends Widget implements ICompositeBar {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private dimension: Dimension | undefined;

	private compositeSwitcherBar: ActionBar | undefined;
	private compositeOverflowAction: CompositeOverflowActivityAction | undefined;
	private compositeOverflowActionViewItem: CompositeOverflowActivityActionViewItem | undefined;

	// When `updateCompositeSwitcher` is skipped because the bar has no dimension
	// yet (e.g. during a view-drag-out where the owning part is mid-relayout /
	// suppressed), remember that a refresh is pending so the next `layout()` with
	// a real dimension replays it. Otherwise an unpinned tab (e.g. a view dragged
	// out to its own window) lingers in the DOM as a stale duplicate tab.
	private compositeSwitcherBarNeedsUpdate = false;

	private readonly model: CompositeBarModel;
	private readonly visibleComposites: string[];
	private readonly compositeSizeInBar: Map<string, number>;

	constructor(
		items: ICompositeBarItem[],
		private readonly options: ICompositeBarOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IHostService private readonly hostService: IHostService,
	) {
		super();

		this.model = new CompositeBarModel(items, options);
		this.visibleComposites = [];
		this.compositeSizeInBar = new Map<string, number>();
		this.computeSizes(this.model.visibleItems);
	}

	getCompositeBarItems(): ICompositeBarItem[] {
		return [...this.model.items];
	}

	setCompositeBarItems(items: ICompositeBarItem[]): void {
		this.model.setItems(items);
		this.updateCompositeSwitcher(true);
	}

	getPinnedComposites(): ICompositeBarItem[] {
		return this.model.pinnedItems;
	}

	getPinnedCompositeIds(): string[] {
		return this.getPinnedComposites().map(c => c.id);
	}

	getVisibleComposites(): ICompositeBarItem[] {
		return this.model.visibleItems;
	}

	create(parent: HTMLElement): HTMLElement {
		const actionBarDiv = parent.appendChild($('.composite-bar'));
		this.compositeSwitcherBar = this._register(new ActionBar(actionBarDiv, {
			actionViewItemProvider: (action, options) => {
				if (action instanceof CompositeOverflowActivityAction) {
					return this.compositeOverflowActionViewItem;
				}
				const item = this.model.findItem(action.id);
				return item && this.instantiationService.createInstance(
					CompositeActionViewItem,
					{ ...options, draggable: this.options.isCompositeDraggable ? this.options.isCompositeDraggable(action.id) : true, colors: this.options.colors, icon: this.options.icon, hoverOptions: this.options.activityHoverOptions, compact: this.options.compact, showCloseButton: this.options.showCloseButton, closeActiveComposite: this.options.closeActiveComposite, hidePartOnLastPinnedClose: this.options.hidePartOnLastPinnedClose, hideSide: this.options.hideSide },
					action as CompositeBarAction,
					item.pinnedAction,
					item.toggleBadgeAction,
					compositeId => this.options.getContextMenuActionsForComposite(compositeId),
					() => this.getContextMenuActions(),
					this.options.dndHandler,
					this
				);
			},
			orientation: this.options.orientation,
			ariaLabel: localize('activityBarAriaLabel', "Active View Switcher"),
			ariaRole: 'tablist',
			preventLoopNavigation: this.options.preventLoopNavigation,
			triggerKeys: { keyDown: true }
		}));

		// Contextmenu for composites
		this._register(addDisposableListener(parent, EventType.CONTEXT_MENU, e => this.showContextMenu(getWindow(parent), e)));
		this._register(Gesture.addTarget(parent));
		this._register(addDisposableListener(parent, TouchEventType.Contextmenu, e => this.showContextMenu(getWindow(parent), e)));

		// Register a drop target on the whole bar to prevent forbidden feedback
		const dndCallback = new CompositeBarDndCallbacks(parent, actionBarDiv, this.model, this.options.dndHandler, this.options.orientation, this.editorGroupsService, this.hostService, this.viewDescriptorService, this.instantiationService);
		this._register(CompositeDragAndDropObserver.INSTANCE.registerTarget(parent, dndCallback));

		return actionBarDiv;
	}

	focus(index?: number): void {
		this.compositeSwitcherBar?.focus(index);
	}

	recomputeSizes(): void {
		this.computeSizes(this.model.visibleItems);
		this.updateCompositeSwitcher();
	}

	layout(dimension: Dimension): void {
		this.dimension = dimension;

		if (dimension.height === 0 || dimension.width === 0) {
			// Do not layout if not visible. Otherwise the size measurment would be computed wrongly
			return;
		}

		if (this.compositeSizeInBar.size === 0) {
			// Compute size of each composite by getting the size from the css renderer
			// Size is later used for overflow computation
			this.computeSizes(this.model.visibleItems);
		}

		this.updateCompositeSwitcher();

		// Replay a refresh that was skipped earlier because the bar had no
		// dimension (see `updateCompositeSwitcher`). This guarantees a tab that
		// was unpinned while the part was mid-relayout (e.g. a view dragged out
		// to its own window) gets removed from the DOM on the next real layout.
		if (this.compositeSwitcherBarNeedsUpdate) {
			this.compositeSwitcherBarNeedsUpdate = false;
			this.updateCompositeSwitcher();
		}
	}

	addComposite({ id, name, order, requestedIndex }: { id: string; name: string; order?: number; requestedIndex?: number }): void {
		if (this.model.add(id, name, order, requestedIndex)) {
			this.computeSizes([this.model.findItem(id)]);
			this.updateCompositeSwitcher();
		}
	}

	removeComposite(id: string): void {

		// If it pinned, unpin it first
		if (this.isPinned(id)) {
			this.unpin(id);
		}

		// Remove from the model
		if (this.model.remove(id)) {
			this.updateCompositeSwitcher();
		}
	}

	hideCompositeInternal(id: string): void {
		if (this.model.hide(id)) {
			this.resetActiveComposite(id);
			this.updateCompositeSwitcher();
		}
	}

	hideComposite(compositeId: string): void {
		this.hideCompositeInternal(compositeId);
	}

	activateComposite(id: string): void {
		const previousActiveItem = this.model.activeItem;
		if (this.model.activate(id)) {
			// Update if current composite is neither visible nor pinned
			// or previous active composite is not pinned
			if (this.visibleComposites.indexOf(id) === - 1 || (!!this.model.activeItem && !this.model.activeItem.pinned) || (previousActiveItem && !previousActiveItem.pinned)) {
				this.updateCompositeSwitcher();
			}
		}
	}

	deactivateComposite(id: string): void {
		if (this.model.deactivate()) {
			// Always refresh the switcher when the active composite is cleared.
			//
			// `model.deactivate()` unconditionally clears `activeItem` and calls
			// `activityAction.deactivate()` (which flips the `checked` *flag*), but
			// the rendered tab's `.checked` CSS class is only updated inside
			// `updateCompositeSwitcher()`. The previous guard
			// (!previousActiveItem.pinned) skipped that refresh for *pinned*
			// composites, so a closed pinned tab kept its highlighted "selected"
			// look even though the owning part had already cleared its active
			// composite. In the dual-panel layout this surfaces as the exact
			// "tab is selected but the body shows 'Drag a view here to display'"
			// bug: the side's `getActiveComposite()` is `undefined` (placeholder
			// visible) while the (pinned) Problems tab stays visually checked.
			// Refresh unconditionally to keep the tab and the content in sync.
			this.updateCompositeSwitcher();
		}
	}

	async pin(compositeId: string, open?: boolean): Promise<void> {
		if (this.model.setPinned(compositeId, true)) {
			this.updateCompositeSwitcher();

			if (open) {
				await this.options.openComposite(compositeId);
				this.activateComposite(compositeId); // Activate after opening
			}
		}
	}

	unpin(compositeId: string): void {
		if (this.model.setPinned(compositeId, false)) {

			this.updateCompositeSwitcher();

			// The bar may not have been laid out yet (e.g. it was just created
			// while its parent part is still hidden), in which case
			// `updateCompositeSwitcher` bails out early and the tab stays in the
			// DOM even though the model no longer pins it. Re-run on the next
			// tick so that once layout settles the stale tab is guaranteed to
			// be removed. This mirrors the deferred refresh used by `move`.
			setTimeout(() => this.updateCompositeSwitcher(), 0);

			this.resetActiveComposite(compositeId);
		}
	}

	areBadgesEnabled(compositeId: string): boolean {
		return this.viewDescriptorService.getViewContainerBadgeEnablementState(compositeId);
	}

	toggleBadgeEnablement(compositeId: string): void {
		this.viewDescriptorService.setViewContainerBadgeEnablementState(compositeId, !this.areBadgesEnabled(compositeId));
		this.updateCompositeSwitcher();
		const item = this.model.findItem(compositeId);
		if (item) {
			// TODO @lramos15 how do we tell the activity to re-render the badge? This triggers an onDidChange but isn't the right way to do it.
			// I could add another specific function like `activity.updateBadgeEnablement` would then the activity store the sate?
			item.activityAction.activity = item.activityAction.activity;
		}
	}

	private resetActiveComposite(compositeId: string) {
		const defaultCompositeId = this.options.getDefaultCompositeId();

		// Case: composite is not the active one or the active one is a different one
		// Solv: we do nothing
		if (!this.model.activeItem || this.model.activeItem.id !== compositeId) {
			return;
		}

		// Deactivate itself
		this.deactivateComposite(compositeId);

		// For sub-parts (e.g. one side of the dual-panel layout) closing the
		// last composite must clear the sub-part rather than auto-open the
		// *default* (the parent part's default) composite, which would
		// re-populate the side we just closed.
		//
		// However, when the side still has OTHER visible composites we must
		// switch to one of them instead of leaving the side empty: otherwise the
		// owning part's deferred "side became empty" fallback scheduler would
		// fire on the next tick and re-open a (possibly different) container,
		// producing the brief "flash" where the closed view's body is replaced
		// and then the side is re-populated. Switching here keeps the previously
		// shown sibling view active (no empty frame, no flicker). Only when there
		// is genuinely no other visible composite do we clear the sub-part and
		// let the owner collapse it (the side's own close button has already
		// marked the side hidden via `hideSide`, so the fallback is suppressed).
		if (this.options.hidePartOnLastPinnedClose === false) {
			const otherVisible = this.visibleComposites.find(cid => cid !== compositeId);
			if (otherVisible) {
				this.options.openComposite(otherVisible);
			} else if (!this.model.activeItem) {
				this.options.onDidCloseActiveComposite?.();
			}
			return;
		}

		// Case: composite is not the default composite and default composite is still showing
		// Solv: we open the default composite
		if (defaultCompositeId && defaultCompositeId !== compositeId && this.isPinned(defaultCompositeId)) {
			this.options.openComposite(defaultCompositeId, true);
		}

		// Case: we closed the default composite
		// Solv: we open the next visible composite from top
		else {
			const visibleComposite = this.visibleComposites.find(cid => cid !== compositeId);
			if (visibleComposite) {
				this.options.openComposite(visibleComposite);
			}
		}

		// If the bar still has no active composite after the attempts above, the
		// owning part's active composite content (toolbar, body) would otherwise
		// stay rendered even though no tab backs it. Notify the owner so it can
		// clear its own active composite. The owner is the only one who knows
		// whether to also hide the whole part - the bar never should.
		if (!this.model.activeItem) {
			this.options.onDidCloseActiveComposite?.();
		}
	}

	isPinned(compositeId: string): boolean {
		const item = this.model.findItem(compositeId);
		return item?.pinned;
	}

	move(compositeId: string, toCompositeId: string, before?: boolean): void {
		if (before !== undefined) {
			const fromIndex = this.model.items.findIndex(c => c.id === compositeId);
			let toIndex = this.model.items.findIndex(c => c.id === toCompositeId);

			if (fromIndex >= 0 && toIndex >= 0) {
				if (!before && fromIndex > toIndex) {
					toIndex++;
				}

				if (before && fromIndex < toIndex) {
					toIndex--;
				}

				if (toIndex < this.model.items.length && toIndex >= 0 && toIndex !== fromIndex) {
					if (this.model.move(this.model.items[fromIndex].id, this.model.items[toIndex].id)) {
						// timeout helps to prevent artifacts from showing up
						setTimeout(() => this.updateCompositeSwitcher(), 0);
					}
				}
			}
		} else {
			if (this.model.move(compositeId, toCompositeId)) {
				// timeout helps to prevent artifacts from showing up
				setTimeout(() => this.updateCompositeSwitcher(), 0);
			}
		}
	}

	getAction(compositeId: string): CompositeBarAction {
		const item = this.model.findItem(compositeId);

		return item?.activityAction;
	}

	private computeSizes(items: ICompositeBarModelItem[]): void {
		const size = this.options.compositeSize;
		if (size) {
			items.forEach(composite => this.compositeSizeInBar.set(composite.id, size));
		} else {
			const compositeSwitcherBar = this.compositeSwitcherBar;
			if (compositeSwitcherBar && this.dimension && this.dimension.height !== 0 && this.dimension.width !== 0) {

				// Compute sizes only if visible. Otherwise the size measurment would be computed wrongly.
				const currentItemsLength = compositeSwitcherBar.viewItems.length;
				compositeSwitcherBar.push(items.map(composite => composite.activityAction));
				items.map((composite, index) => this.compositeSizeInBar.set(composite.id, this.options.orientation === ActionsOrientation.VERTICAL
					? compositeSwitcherBar.getHeight(currentItemsLength + index)
					: compositeSwitcherBar.getWidth(currentItemsLength + index)
				));
				items.forEach(() => compositeSwitcherBar.pull(compositeSwitcherBar.viewItems.length - 1));
			}
		}
	}

	private updateCompositeSwitcher(donotTrigger?: boolean): void {
		const compositeSwitcherBar = this.compositeSwitcherBar;
		if (!compositeSwitcherBar) {
			return; // We have not been created yet so there is nothing to update.
		}

		if (!this.dimension) {
			// The bar has no dimension yet (it may still be hidden or mid-relayout,
			// e.g. while a view is being dragged out to its own window and the owning
			// part's relayout is suppressed). Do not drop the request — remember it
			// so the next `layout()` with a real dimension replays the refresh and
			// removes any stale (unpinned) tab instead of letting it linger.
			this.compositeSwitcherBarNeedsUpdate = true;
			return;
		}

		let compositesToShow = this.model.visibleItems.filter(item =>
			item.pinned
			|| (this.model.activeItem && this.model.activeItem.id === item.id) /* Show the active composite even if it is not pinned */
		).map(item => item.id);

		// When overflow is disabled, show all composites without size constraints
		if (this.options.disableOverflow) {
			// Remove any existing overflow action
			if (this.compositeOverflowAction) {
				const overflowIndex = this.visibleComposites.indexOf(this.compositeOverflowAction.id);
				if (overflowIndex !== -1) {
					compositeSwitcherBar.pull(overflowIndex);
					this.visibleComposites.splice(overflowIndex, 1);
				}

				this.compositeOverflowAction.dispose();
				this.compositeOverflowAction = undefined;

				this.compositeOverflowActionViewItem?.dispose();
				this.compositeOverflowActionViewItem = undefined;
			}

			// Pull out composites that got hidden
			const compositesToRemove: number[] = [];
			this.visibleComposites.forEach((compositeId, index) => {
				if (!compositesToShow.includes(compositeId)) {
					compositesToRemove.push(index);
				}
			});
			compositesToRemove.reverse().forEach(index => {
				compositeSwitcherBar.pull(index);
				this.visibleComposites.splice(index, 1);
			});

			// Update the positions of the composites - show all of them
			compositesToShow.forEach((compositeId, newIndex) => {
				const currentIndex = this.visibleComposites.indexOf(compositeId);
				if (newIndex !== currentIndex) {
					if (currentIndex !== -1) {
						compositeSwitcherBar.pull(currentIndex);
						this.visibleComposites.splice(currentIndex, 1);
					}

					compositeSwitcherBar.push(this.model.findItem(compositeId).activityAction, { label: true, icon: this.options.icon, index: newIndex });
					this.visibleComposites.splice(newIndex, 0, compositeId);
				}
			});

			if (!donotTrigger) {
				this._onDidChange.fire();
			}
			return;
		}

		// Ensure we are not showing more composites than we have height for
		let maxVisible = compositesToShow.length;
		const totalComposites = compositesToShow.length;
		let size = 0;
		const limit = this.options.orientation === ActionsOrientation.VERTICAL ? this.dimension.height : this.dimension.width;

		// Add composites while they fit
		for (let i = 0; i < compositesToShow.length; i++) {
			const compositeSize = this.compositeSizeInBar.get(compositesToShow[i])!;
			// Adding this composite will overflow available size, so don't
			if (size + compositeSize > limit) {
				maxVisible = i;
				break;
			}

			size += compositeSize;
		}

		// Remove the tail of composites that did not fit
		if (totalComposites > maxVisible) {
			compositesToShow = compositesToShow.slice(0, maxVisible);
		}

		// We always try show the active composite, so re-add it if it was sliced out
		if (this.model.activeItem && compositesToShow.every(compositeId => !!this.model.activeItem && compositeId !== this.model.activeItem.id)) {
			size += this.compositeSizeInBar.get(this.model.activeItem.id)!;
			compositesToShow.push(this.model.activeItem.id);
		}

		// The active composite might have pushed us over the limit
		// Keep popping the composite before the active one until it fits
		// If even the active one doesn't fit, we will resort to overflow
		while (size > limit && compositesToShow.length) {
			const removedComposite = compositesToShow.length > 1 ? compositesToShow.splice(compositesToShow.length - 2, 1)[0] : compositesToShow.pop();
			size -= this.compositeSizeInBar.get(removedComposite!)!;
		}

		// We are overflowing, add the overflow size
		if (totalComposites > compositesToShow.length) {
			size += this.options.overflowActionSize;
		}

		// Check if we need to make extra room for the overflow action
		while (size > limit && compositesToShow.length) {
			const removedComposite = compositesToShow.length > 1 && compositesToShow[compositesToShow.length - 1] === this.model.activeItem?.id ?
				compositesToShow.splice(compositesToShow.length - 2, 1)[0] : compositesToShow.pop();
			size -= this.compositeSizeInBar.get(removedComposite!)!;
		}

		// Remove the overflow action if there are no overflows
		if (totalComposites === compositesToShow.length && this.compositeOverflowAction) {
			compositeSwitcherBar.pull(compositeSwitcherBar.length() - 1);

			this.compositeOverflowAction.dispose();
			this.compositeOverflowAction = undefined;

			this.compositeOverflowActionViewItem?.dispose();
			this.compositeOverflowActionViewItem = undefined;
		}

		// Pull out composites that overflow or got hidden
		const compositesToRemove: number[] = [];
		this.visibleComposites.forEach((compositeId, index) => {
			if (!compositesToShow.includes(compositeId)) {
				compositesToRemove.push(index);
			}
		});
		compositesToRemove.reverse().forEach(index => {
			compositeSwitcherBar.pull(index);
			this.visibleComposites.splice(index, 1);
		});

		// Update the positions of the composites
		compositesToShow.forEach((compositeId, newIndex) => {
			const currentIndex = this.visibleComposites.indexOf(compositeId);
			if (newIndex !== currentIndex) {
				if (currentIndex !== -1) {
					compositeSwitcherBar.pull(currentIndex);
					this.visibleComposites.splice(currentIndex, 1);
				}

				compositeSwitcherBar.push(this.model.findItem(compositeId).activityAction, { label: true, icon: this.options.icon, index: newIndex });
				this.visibleComposites.splice(newIndex, 0, compositeId);
			}
		});

		// Add overflow action as needed
		if (totalComposites > compositesToShow.length && !this.compositeOverflowAction) {
			this.compositeOverflowAction = this._register(this.instantiationService.createInstance(CompositeOverflowActivityAction, () => {
				this.compositeOverflowActionViewItem?.showMenu();
			}));
			this.compositeOverflowActionViewItem = this._register(this.instantiationService.createInstance(
				CompositeOverflowActivityActionViewItem,
				this.compositeOverflowAction,
				() => this.getOverflowingComposites(),
				() => this.model.activeItem ? this.model.activeItem.id : undefined,
				compositeId => {
					const item = this.model.findItem(compositeId);
					return item?.activity[0]?.badge;
				},
				this.options.getOnCompositeClickAction,
				this.options.colors,
				this.options.activityHoverOptions
			));

			compositeSwitcherBar.push(this.compositeOverflowAction, { label: false, icon: true });
		}

		if (!donotTrigger) {
			this._onDidChange.fire();
		}
	}

	private getOverflowingComposites(): { id: string; name?: string }[] {
		let overflowingIds = this.model.visibleItems.filter(item => item.pinned).map(item => item.id);

		// Show the active composite even if it is not pinned
		if (this.model.activeItem && !this.model.activeItem.pinned) {
			overflowingIds.push(this.model.activeItem.id);
		}

		overflowingIds = overflowingIds.filter(compositeId => !this.visibleComposites.includes(compositeId));
		return this.model.visibleItems.filter(c => overflowingIds.includes(c.id)).map(item => { return { id: item.id, name: this.getAction(item.id)?.label || item.name }; });
	}

	private showContextMenu(targetWindow: Window, e: MouseEvent | GestureEvent): void {
		EventHelper.stop(e, true);

		const event = new StandardMouseEvent(targetWindow, e);
		this.contextMenuService.showContextMenu({
			getAnchor: () => event,
			getActions: () => this.getContextMenuActions(e)
		});
	}

	getContextMenuActions(e?: MouseEvent | GestureEvent): IAction[] {
		const actions: IAction[] = this.model.visibleItems
			.map(({ id, name, activityAction }) => {
				const isPinned = this.isPinned(id);
				return toAction({
					id,
					label: this.getAction(id).label || name || id,
					checked: isPinned,
					enabled: activityAction.enabled && (!isPinned || this.getPinnedCompositeIds().length > 1),
					run: () => {
						if (this.isPinned(id)) {
							this.unpin(id);
						} else {
							this.pin(id, true);
						}
					}
				});
			});

		this.options.fillExtraContextMenuActions(actions, e);

		return actions;
	}
}

interface ICompositeBarModelItem extends ICompositeBarItem {
	readonly activityAction: CompositeBarAction;
	readonly pinnedAction: IAction;
	readonly toggleBadgeAction: IAction;
	readonly activity: IActivity[];
}

class CompositeBarModel {

	private _items: ICompositeBarModelItem[] = [];
	get items(): ICompositeBarModelItem[] { return this._items; }

	private readonly options: ICompositeBarOptions;

	activeItem?: ICompositeBarModelItem;

	constructor(
		items: ICompositeBarItem[],
		options: ICompositeBarOptions
	) {
		this.options = options;
		this.setItems(items);
	}

	setItems(items: ICompositeBarItem[]): void {
		this._items = [];
		this._items = items
			.map(i => this.createCompositeBarItem(i.id, i.name, i.order, i.pinned, i.visible));
	}

	get visibleItems(): ICompositeBarModelItem[] {
		return this.items.filter(item => item.visible);
	}

	get pinnedItems(): ICompositeBarModelItem[] {
		return this.items.filter(item => item.visible && item.pinned);
	}

	private createCompositeBarItem(id: string, name: string | undefined, order: number | undefined, pinned: boolean, visible: boolean): ICompositeBarModelItem {
		const options = this.options;
		return {
			id, name, pinned, order, visible,
			activity: [],
			get activityAction() {
				return options.getActivityAction(id);
			},
			get pinnedAction() {
				return options.getCompositePinnedAction(id);
			},
			get toggleBadgeAction() {
				return options.getCompositeBadgeAction(id);
			}
		};
	}

	add(id: string, name: string, order: number | undefined, requestedIndex: number | undefined): boolean {
		const item = this.findItem(id);
		if (item) {
			let changed = false;
			item.name = name;
			if (!isUndefinedOrNull(order)) {
				changed = item.order !== order;
				item.order = order;
			}
			if (!item.visible) {
				item.visible = true;
				changed = true;
			}

			return changed;
		} else {
			const item = this.createCompositeBarItem(id, name, order, true, true);
			if (!isUndefinedOrNull(requestedIndex)) {
				let index = 0;
				let rIndex = requestedIndex;
				while (rIndex > 0 && index < this.items.length) {
					if (this.items[index++].visible) {
						rIndex--;
					}
				}

				this.items.splice(index, 0, item);
			} else if (isUndefinedOrNull(order)) {
				this.items.push(item);
			} else {
				let index = 0;
				while (index < this.items.length && typeof this.items[index].order === 'number' && this.items[index].order! < order) {
					index++;
				}
				this.items.splice(index, 0, item);
			}

			return true;
		}
	}

	remove(id: string): boolean {
		for (let index = 0; index < this.items.length; index++) {
			if (this.items[index].id === id) {
				this.items.splice(index, 1);
				return true;
			}
		}
		return false;
	}

	hide(id: string): boolean {
		for (const item of this.items) {
			if (item.id === id) {
				if (item.visible) {
					item.visible = false;
					return true;
				}
				return false;
			}
		}
		return false;
	}

	move(compositeId: string, toCompositeId: string): boolean {

		const fromIndex = this.findIndex(compositeId);
		const toIndex = this.findIndex(toCompositeId);

		// Make sure both items are known to the model
		if (fromIndex === -1 || toIndex === -1) {
			return false;
		}

		const sourceItem = this.items.splice(fromIndex, 1)[0];
		this.items.splice(toIndex, 0, sourceItem);

		// Make sure a moved composite gets pinned
		sourceItem.pinned = true;

		return true;
	}

	setPinned(id: string, pinned: boolean): boolean {
		for (const item of this.items) {
			if (item.id === id) {
				if (item.pinned !== pinned) {
					item.pinned = pinned;
					return true;
				}
				return false;
			}
		}
		return false;
	}

	activate(id: string): boolean {
		if (!this.activeItem || this.activeItem.id !== id) {
			if (this.activeItem) {
				this.deactivate();
			}
			for (const item of this.items) {
				if (item.id === id) {
					this.activeItem = item;
					this.activeItem.activityAction.activate();
					return true;
				}
			}
		}
		return false;
	}

	deactivate(): boolean {
		if (this.activeItem) {
			this.activeItem.activityAction.deactivate();
			this.activeItem = undefined;
			return true;
		}
		return false;
	}

	findItem(id: string): ICompositeBarModelItem {
		return this.items.filter(item => item.id === id)[0];
	}

	private findIndex(id: string): number {
		for (let index = 0; index < this.items.length; index++) {
			if (this.items[index].id === id) {
				return index;
			}
		}

		return -1;
	}
}
