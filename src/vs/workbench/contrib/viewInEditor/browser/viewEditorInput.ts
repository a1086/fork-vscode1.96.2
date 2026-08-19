/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { URI } from '../../../../base/common/uri.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IViewDescriptor } from '../../../common/views.js';

export const VIEW_EDITOR_INPUT_TYPE_ID = 'workbench.editors.viewEditorInput';

/**
 * Editor input that hosts a workbench view (ViewPane) inside the editor area.
 * This is the P0 spike implementation for "drag a view (OUTLINE/PROBLEMS/PORTS) into the editor".
 */
export class ViewEditorInput extends EditorInput {

	static readonly ID = VIEW_EDITOR_INPUT_TYPE_ID;

	private readonly _resource: URI;

	constructor(
		public readonly viewId: string,
		public readonly originalLocation: ViewContainerLocation | undefined,
		public readonly originalContainerId: string | undefined,
		public readonly originalIndex: number | undefined,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService
	) {
		super();
		this._resource = URI.from({ scheme: 'vscode-view', path: `/${viewId}` });
	}

	override get typeId(): string {
		return ViewEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return this.typeId;
	}

	override get resource(): URI | undefined {
		return this._resource;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton | super.capabilities;
	}

	override getName(): string {
		const descriptor = this.viewDescriptorService.getViewDescriptorById(this.viewId);
		return descriptor?.name.value ?? this.viewId;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}

		return other instanceof ViewEditorInput && other.viewId === this.viewId;
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this._resource,
			options: {
				override: ViewEditorInput.ID
			}
		};
	}
}

/**
 * 把承载在 Editor 区的视图归位回其原始栏（Panel / Aux Bar），并在归位后
 * 关闭承载它的 editor tab。
 *
 * 关键场景（关闭拖出的浮动窗口后"同时出现在 panel 和 editor"的根因）：
 * 关闭辅助窗口时，VS Code 原生 `AuxiliaryEditorPartImpl.close()` 会
 * `mergeGroupsToMainPart()`，把辅助窗口里的 `ViewEditorInput` 整体 move 到
 * 主窗口 editor 区，主窗口随后 `setInput` 重新承载该视图——于是 editor 区
 * 残留一份 Terminal。如果不先归位再关 tab，Panel 里（被本函数移回去的那份）
 * 和 editor 区（被 merge 过去的那份）就会同时存在。
 *
 * 因此辅助窗口关闭流程必须在 `mergeGroupsToMainPart` 之前调用本函数：先把
 * 视图 move 回原栏，使其脱离 Editor 区，再关闭辅助窗口里的 editor tab，
 * 这样 merge 时无 editor 可搬，主窗口不会出现 Terminal 副本。
 *
 * `moveViewToLocation` 幂等：若视图已不在 Editor 区（例如被 reverse-drag
 * 提前归位）则不会错误地再移动一次。
 */
export function restoreViewEditorInputToOriginalLocation(
	input: ViewEditorInput,
	viewDescriptorService: IViewDescriptorService,
	closeEditor?: () => void
): void {
	const descriptor: IViewDescriptor | null = viewDescriptorService.getViewDescriptorById(input.viewId);
	if (!descriptor) {
		return;
	}

	const targetLocation = input.originalLocation ?? ViewContainerLocation.Panel;
	const currentLocation = viewDescriptorService.getViewLocationById(input.viewId);
	if (currentLocation === null || currentLocation !== targetLocation) {
		// 优先把视图移回它原本所属的容器（保持原栏、原容器分组），
		// 而不是用 moveViewToLocation（会生成一个新容器并放到最顶部）。
		const originalContainer = input.originalContainerId
			? viewDescriptorService.getViewContainerById(input.originalContainerId)
			: null;
		if (originalContainer) {
			viewDescriptorService.moveViewsToContainer([descriptor], originalContainer, undefined, 'restore-view-editor');
		} else {
			viewDescriptorService.moveViewToLocation(descriptor, targetLocation, 'restore-view-editor');
		}
	}

	// 恢复容器内的原始顺序位置。moveViewsToContainer 默认把视图 Append 到
	// 容器末尾，所以拖出的是 Debug 容器里中间位置的 WATCH/Call Stack 等子视图时，
	// 关闭窗口归位后会跑到容器顶部。这里用 originalIndex 把视图插回原位。
	restoreViewIndex(input, viewDescriptorService);

	// 关闭承载该视图的 editor tab，避免主窗口 editor 区残留副本。
	closeEditor?.();
}

/**
 * 把已归位到原容器的视图插回到它原本在容器内的顺序位置。
 *
 * 根因：关闭浮动窗口归位时 `moveViewsToContainer` 会把视图 append 到容器末尾，
 * 于是 Debug 容器里中间位置的 WATCH / Call Stack 等子视图会被放到顶部，
 * 表现为"关闭后视图没回到原来的位置"。
 *
 * 修复：用 `originalIndex` 计算目标位置——取原容器中 `originalIndex` 处的相邻
 * 视图作为锚点，调用 `viewContainerModel.move` 把当前视图插到锚点之前/之后，
 * 从而精确还原拖出前的排序。`move` 内部会更新 `state.order` 并广播变更。
 */
export function restoreViewIndex(
	input: ViewEditorInput,
	viewDescriptorService: IViewDescriptorService
): void {
	const originalIndex = input.originalIndex;
	if (originalIndex === undefined || originalIndex < 0) {
		return;
	}

	const container = input.originalContainerId
		? viewDescriptorService.getViewContainerById(input.originalContainerId)
		: null;
	if (!container) {
		return;
	}

	const model = viewDescriptorService.getViewContainerModel(container);
	if (!model) {
		return;
	}

	// 当前视图在容器内的实际 index（归位后应在其中）。
	const currentIndex = model.allViewDescriptors.findIndex(v => v.id === input.viewId);
	if (currentIndex === -1) {
		return;
	}

	// 已经在目标位置，无需移动。
	if (currentIndex === originalIndex) {
		return;
	}

	// 取目标位置相邻的视图 id 作为锚点：
	// - 若 originalIndex 落在容器长度范围内，以该位置现有的视图为锚点，move 到它之前。
	// - 若 originalIndex 超出范围（理论上不会），回退到插到末尾（最后一个视图之后）。
	const all = model.allViewDescriptors;
	const anchorIndex = Math.min(originalIndex, all.length - 1);
	const anchor = all[anchorIndex];
	if (!anchor || anchor.id === input.viewId) {
		return;
	}

	// move(from, to)：把视图从 currentIndex 移到 anchorIndex。
	// 当 currentIndex < anchorIndex 时，move 到 anchor 之前正好落回 originalIndex；
	// 当 currentIndex > anchorIndex 时，move 到 anchor 之前也恰好落到 originalIndex。
	model.move(input.viewId, anchor.id);
}
