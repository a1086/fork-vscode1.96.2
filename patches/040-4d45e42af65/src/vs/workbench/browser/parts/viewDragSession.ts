/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 模块级守卫：去重"同一 drag 事件触发多次开窗"。
 *
 * 背景：
 * - `CompositeDragAndDropObserver.INSTANCE` 是单例；bar 容器（`registerTarget`）与
 *   bar 内的每个 tab（`registerDraggable`）都通过 `_onDragEnd` 订阅事件。
 *   dragend 冒泡时，tab 与 bar 的 `DragAndDropObserver` 都会触发一次
 *   `_onDragEnd.fire`，bar 的 `CompositeBarDndCallbacks.onDragEnd` 被调用两次。
 * - Panel 与 Aux Bar 各有独立 `CompositeBar`/`CompositeBarDndCallbacks` 实例，
 *   它们的 onDragEnd 又会再次触发；且原生 editor tabs 拖出链路在 `moveViewToLocation(Editor)`
 *   后还可能再开一个窗口。
 * - 单靠实例级布尔无法跨多个实例去重，因此采用整进程级"进行中集合"守卫。
 *
 * 设计要点（v5 — 修复竞态条件）：
 * - 使用同步锁 + "正在处理中的 viewId 集合"作为去重依据：
 *   同一拖拽的多个 onDragEnd 回调（来自不同 CompositeBarDndCallbacks 实例、
 *   registerTarget / registerDraggable、Panel / Aux Bar）会传入相同的 viewId，
 *   第一个处理时将 viewId 加入集合并返回 true，后续看到已在集合中的直接返回 false。
 * - 关键修复：`add()` 与 `has()` 必须在同一同步执行帧内完成，不能有中间的 await。
 *   v4 版本虽然用了 Set，但调用方在 `tryClaimViewDragSession()` 返回 true 后、
 *   实际执行 `openInAuxiliaryWindow()` 前有一个 `await getCursorScreenPoint()`，
 *   这个 await 让出执行权后，另一个 onDragEnd 回调可以在 `add()` 之前也通过
 *   `has()` 检查，导致两个窗口同时打开（这就是截图中的"两个独立 Watch 窗口"的根因）。
 * - 解决方案：把 claim 标记提前到调用方的同步代码段内（await 之前），确保
 *   第一个到达的回调立即占有标记，其余在任意 await 点之后看到的都是已被占有的状态。
 * - 处理完成后由调用方（onDragEnd 的 finally，且延迟到本轮回填的异步收尾之后）
 *   清除对应 viewId。
 * - 这确保：同一次拖拽只开一个窗口；不同视图（不同 viewId）的拖拽互不影响，
 *   可分别拖出各自独立的窗口。
 */

import { Emitter } from '../../../base/common/event.js';

/** 正在处理中的 viewId 集合（开窗尚未结束） */
const __pendingViews = new Set<string>();

export function nextViewDragSession(): number {
	// no-op: 保留此函数以兼容调用方，但不再依赖它
	return Date.now();
}

/**
 * 返回当前进行中的拖拽 sessionId（兼容保留）。
 */
export function currentViewDragSession(): number {
	return Date.now();
}

/**
 * 尝试 claim 一个视图的开窗权。返回 true 表示可以继续开窗，false 表示应跳过。
 *
 * 此函数是**同步**的：`Set.has()` 和 `Set.add()` 在同一执行帧内完成，
 * 不给其他协程/回调插入的机会，从而消除竞态条件。
 *
 * @param viewId 要打开的视图 ID（或 composite 容器 ID），格式为 `${type}:${id}`
 */
export function tryClaimViewDragSession(viewId: string): boolean {
	if (__pendingViews.has(viewId)) {
		// 该 viewId 的本轮回填窗口仍在处理中（同源的多次 onDragEnd 回调、
		// 或原生 editor tabs 链路的二次开窗），直接跳过。
		console.log(`[viewDragSession] skip duplicate claim: ${viewId}`);
		return false;
	}

	// 标记为处理中（同步，立即生效）
	__pendingViews.add(viewId);
	return true;
}

/**
 * 标记指定 viewId 的开窗操作已完成，允许后续重新 claim。
 * 应在 openInAuxiliaryWindow 成功结束后调用（含延迟释放）。
 */
export function releaseViewDragSession(viewId: string): void {
	__pendingViews.delete(viewId);
}

/**
 * 拖出窗口时抑制 Panel 区域的重新渲染闪烁。
 *
 * 背景（"从 Panel / Aux Bar 拖出视图到独立窗口，Panel 区域都会闪一下"的根因）：
 * 拖出窗口的链路在 `compositeBar.ts#openInAuxiliaryWindow` 末尾用
 * `setTimeout(() => moveViewToLocation(v, Editor), 0)` 把视图从原 Panel 容器移走。
 * 该 move 会触发 Panel 侧的一系列重渲染：
 *   1. 容器变空 → `PanelPart.updatePanelMinimumHeight()` 把 Panel 最小高度从 77 抬到
 *      350 并 `fire(_onDidChange)` → 整个 Panel 区域（含编辑区）被重新布局：编辑区被
 *      挤压再释放，表现为一次明显的"闪一下 / 重新渲染界面"。
 *   2. `PanelPart.createSide` 里延迟一帧的 `sideFallbackSchedulers` 又会把"最左边第一个"
 *      其它容器重新打开在本侧 → 本侧从空白变成显示另一个视图，又是一次闪烁。
 *
 * 修复：拖出 move 期间置位本开关，`PanelPart` 据此
 *   - 跳过"空 Panel → 350"的最小高度抬升与重布局（Panel 维持当前高度，不再挤压编辑区）；
 *   - 跳过 fallback 自动重开其它容器（被拖走的侧自然变成空拖拽目标，正是"视图被拖走"的预期状态）。
 * move 收尾后再清除开关，保证常规关闭/拖走视图仍走原有 fallback 行为。
 */
let __suppressPanelRelayoutOnDragOut = false;

const _onSuppressPanelRelayoutOnDragOutChange = new Emitter<boolean>();

export function setSuppressPanelRelayoutOnDragOut(value: boolean): void {
	if (__suppressPanelRelayoutOnDragOut === value) {
		return;
	}
	__suppressPanelRelayoutOnDragOut = value;
	_onSuppressPanelRelayoutOnDragOutChange.fire(value);
}

export function isSuppressPanelRelayoutOnDragOut(): boolean {
	return __suppressPanelRelayoutOnDragOut;
}

/**
 * Fired when the suppress-panel-relayout-on-drag-out flag changes. The owning
 * part (Panel / Auxiliary Bar) uses this to re-run its composite-bar layout
 * once the suppression is lifted, so any composite tab that was unpinned while
 * the part was mid-relayout (e.g. a view dragged out to its own window) gets
 * removed from the DOM instead of lingering as a stale duplicate tab.
 */
export function onSuppressPanelRelayoutOnDragOutChange(handler: (value: boolean) => void): { dispose(): void } {
	return _onSuppressPanelRelayoutOnDragOutChange.event(handler);
}
