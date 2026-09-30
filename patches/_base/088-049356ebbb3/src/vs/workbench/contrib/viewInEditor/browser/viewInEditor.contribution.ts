/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { IEditorPaneRegistry, EditorPaneDescriptor } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ViewEditorInput, markViewEditorInputForRestartRecovery } from './viewEditorInput.js';
import { ViewEditorPane } from './viewEditorPane.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IHostService } from '../../../services/host/browser/host.js';

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

		// 重启恢复：Editor tab 会被重新打开并调用 `ViewEditorPane.setInput` 继续承载该
		// 视图，因此这里**绝不能**主动把视图从 Editor 移走归位。
		//
		// 旧实现曾在此调用 `moveViewToLocation(..., originalLocation)`，意图"刷新后归还原栏"。
		// 但该调用是异步的：它先移除视图当前归属再挂到目标 location，而 `deserialize`
		// 紧接着返回 `ViewEditorInput`，Editor tab 立刻 `setInput`，此时视图正处于"无 container"
		// 的中间态，`getViewContainerByViewId` 返回 undefined → 抛
		// "No view container found for view id"。这正是刷新编辑器报错的根因。
		//
		// 正确语义：视图的 location 在上次保存 workbench 状态时已是 Editor（拖入时
		// `moveViewToLocation(..., Editor)` 已写入），reload 后直接由 Editor tab 承载即可。
		// 归位回原栏只在视图真正脱离 Editor（关 tab / 关浮动窗口 / 反向拖出）时发生，
		// 那由 `ViewEditorPane.clearInput` / `dispose` / `registerReverseDrag.onDragEnd` 负责。
		//
		// 唯一兜底：若视图当前确实不属于任何 container（异常态），则把它挂回 Editor，
		// 保证 `setInput` 能找到 container，而不是归位到 Panel（那样仍会与 Editor tab 冲突）。
		instantiationService.invokeFunction(accessor => {
			const viewDescriptorService = accessor.get(IViewDescriptorService);
			const descriptor = viewDescriptorService.getViewDescriptorById(viewId);
			if (descriptor && !viewDescriptorService.getViewContainerByViewId(viewId)) {
				viewDescriptorService.moveViewToLocation(descriptor, ViewContainerLocation.Editor, 'restore-editor');
			}
		});

		markViewEditorInputForRestartRecovery(viewId);

		return instantiationService.createInstance(ViewEditorInput, viewId, originalLocation, undefined, undefined);
	}
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)
	.registerEditorPane(
		EditorPaneDescriptor.create(ViewEditorPane, ViewEditorPane.ID, 'View'),
		[new SyncDescriptor(ViewEditorInput)]
	);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(ViewEditorInput.ID, ViewEditorInputSerializer);

//#region Phase 1' 技术验证 Spike（内部命令，不暴露入口）
//
// 目的：验证 `ViewPane` / `ViewEditorPane` 能否在 auxiliary window 正常渲染
// （`getActiveWindow()` 是否错乱、context menu 是否弹到主窗口等）。
// 该命令仅用于验证，不注册到命令面板 / 右键菜单 / 标题菜单，不会暴露给最终用户。
// 验证通过后由 Phase 3 的 `compositeBar.ts` 拖拽链路接替，此命令可删除。
//
// 触发方式（开发者）：从开发者控制台执行
//   await require('vs/platform/commands/common/commands').CommandsRegistry.executeCommand('_spike.openViewInAuxiliaryWindow', 'workbench.panel.problems')

interface IOpenViewInAuxiliaryWindowArgs {
	readonly viewId: string;
}

CommandsRegistry.registerCommand('_spike.openViewInAuxiliaryWindow', async (accessor: ServicesAccessor, args: IOpenViewInAuxiliaryWindowArgs) => {
	const editorGroupsService = accessor.get(IEditorGroupsService);
	const hostService = accessor.get(IHostService);
	const viewDescriptorService = accessor.get(IViewDescriptorService);

	const viewId = args?.viewId;
	if (!viewId) {
		throw new Error('[spike] missing viewId argument');
	}

	const descriptor = viewDescriptorService.getViewDescriptorById(viewId);
	if (!descriptor) {
		throw new Error('[spike] no view descriptor for: ' + viewId);
	}

	// 取当前光标屏幕坐标作为新窗口 bounds（参照 editorTabsControl#maybeCreateAuxiliaryEditorPartAt）。
	const screenPoint = await hostService.getCursorScreenPoint();
	const bounds = screenPoint
		? { x: screenPoint.point.x, y: screenPoint.point.y }
		: undefined;

	const auxiliaryEditorPart = await editorGroupsService.createAuxiliaryEditorPart({ bounds });
	const targetGroup = auxiliaryEditorPart.activeGroup;

	// 记录视图来源位置，便于后续 Phase 4 归位。
	const originalLocation = viewDescriptorService.getViewLocationById(viewId) ?? undefined;

	const input = accessor.get(IInstantiationService).createInstance(ViewEditorInput, viewId, originalLocation, undefined, undefined);
	await targetGroup.openEditor(input, { pinned: true });
	targetGroup.focus();

	// 把视图从原 Panel / Aux Bar 移除（方案 A：浮动窗口内承载，原栏不再显示）。
	viewDescriptorService.moveViewToLocation(descriptor, ViewContainerLocation.Editor, 'spike-drag-out');

	return auxiliaryEditorPart;
});
//#endregion
