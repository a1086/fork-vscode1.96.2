/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Dimension } from '../../../../base/browser/dom.js';
import { Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService, IViewDescriptor, ViewContainerLocation } from '../../../common/views.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { CompositeDragAndDropObserver, IDraggedCompositeData } from '../../../browser/dnd.js';
import { ViewEditorInput, restoreViewEditorInputToOriginalLocation } from './viewEditorInput.js';
import './media/viewEditorPane.css';

export class ViewEditorPane extends EditorPane {
	static readonly ID = 'workbench.editor.view';

	private _editorView?: ViewPane;
	private readonly container: HTMLElement;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
	) {
		super(ViewEditorPane.ID, group, telemetryService, themeService, storageService);
		this.container = document.createElement('div');
		// A `ViewPane` only gets its layout styles inside a `.monaco-pane-view`
		// ancestor (header height, body flex). Since we mount the pane directly
		// into the editor area, add that class so the pane does not collapse.
		this.container.classList.add('monaco-pane-view', 'view-editor-pane');
		this.container.style.position = 'relative';
		this.container.style.width = '100%';
		this.container.style.height = '100%';
		this.container.style.overflow = 'hidden';
	}

	protected override createEditor(parent: HTMLElement): void {
		parent.appendChild(this.container);
	}

	override async setInput(input: ViewEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		if (this._editorView) {
			return;
		}

		const descriptor = this.viewDescriptorService.getViewDescriptorById(input.viewId);
		if (!descriptor) {
			throw new Error('No view descriptor found for view id: ' + input.viewId);
		}

		const viewContainer = this.viewDescriptorService.getViewContainerByViewId(input.viewId);
		if (!viewContainer) {
			throw new Error('No view container found for view id: ' + input.viewId);
		}

		const paneTitle = descriptor.name?.value ?? descriptor.id;
		let pane: ViewPane;
		try {
			pane = this.instantiationService.createInstance(
				descriptor.ctorDescriptor.ctor,
				...(descriptor.ctorDescriptor.staticArguments || []),
				{
					...descriptor,
					id: descriptor.id,
					// `ViewPane` reads its header title from `options.title` (not `options.name`).
					// `descriptor.name` is an `ILocalizedString`; forwarding it directly would put
					// the object into `Pane._title` and the header `<h3>` would render the string
					// `"UNDEFINED"` (or `"[object Object]"`). Pass the localized value, and fall
					// back to the view id so the header never shows `UNDEFINED`.
					title: paneTitle,
					container: viewContainer,
					viewContainerLocation: ViewContainerLocation.Editor,
					canToggleVisibility: false,
					overrideAriaLabel: paneTitle,
					overrideAriaDescription: paneTitle,
				}
			) as ViewPane;
		} catch (error) {
			// Some views (e.g. the Explorer) are tightly coupled to their side-bar
			// container and cannot be hosted inside the editor area / an auxiliary
			// window. Fail soft: do not let a single unsupported view crash the
			// whole floating window.
			throw new Error(`View "${input.viewId}" cannot be opened in a floating window: ${error}`);
		}

		// Panel views default to HORIZONTAL orientation; force vertical in the editor area.
		pane.orientation = Orientation.VERTICAL;

		try {
			pane.render();
		} catch (error) {
			throw new Error(`View "${input.viewId}" failed to render in floating window: ${error}`);
		}
		this.container.appendChild(pane.element);
		this._editorView = pane;
		this.layoutPane(pane);

		this.registerReverseDrag(input, descriptor, pane);

		this._register(pane.onDidFocus(() => this.focus()));
	}

	/**
	 * Guard so that `restoreViewToOriginalLocation` is only ever run once per
	 * pane lifetime. Closing the floating window makes VS Code move the editor
	 * back to the main part, which re-opens this pane in the main window and
	 * disposes the old one. Without the guard we would restore twice (once from
	 * the auxiliary window's dispose, once from the main window's clearInput)
	 * and - critically - the main-window pane would never get its tab closed,
	 * leaving the view both in the panel and in the editor area.
	 */
	private _restored = false;

	private registerReverseDrag(input: ViewEditorInput, descriptor: IViewDescriptor, pane: ViewPane): void {
		const draggableProvider = () => ({ type: 'view' as const, id: input.viewId });
		const onDragEnd = (e: IDraggedCompositeData) => {
			if (e.eventData.dataTransfer?.dropEffect === 'none') {
				return; // drag was cancelled, keep the view in the editor area
			}

			// When the view is still hosted in the editor area at drag end, the
			// panel/sidebar/auxiliary bar drop target did not relocate it (its
			// current view container is seen as equal to the target, so the target's
			// `moveViewsToContainer` is a no-op). In that case move it back to its
			// original location explicitly. If the target already relocated it to a
			// different location we leave it there. Either way the editor tab must
			// close because the view has left the editor area.
			const location = this.viewDescriptorService.getViewLocationById(descriptor.id);
			if (location === null || location === ViewContainerLocation.Editor) {
				this.viewDescriptorService.moveViewToLocation(descriptor, input.originalLocation ?? ViewContainerLocation.Panel, 'dnd-editor-to-panel');
			}

			this.group?.closeEditor(input);
		};
		this._register(CompositeDragAndDropObserver.INSTANCE.registerDraggable(pane.draggableElement, draggableProvider, { onDragEnd }));
	}

	override clearInput(): void {
		// Phase 4: 视图脱离编辑器（关 tab / 关浮动窗口）时归还原栏。
		// 记录来源 originalLocation，归位时回到对应栏（Panel 与 Aux Bar 互斥）。
		// 若 originalLocation 缺失则回退到 Panel，避免视图"丢失"。
		this.restoreViewToOriginalLocation();

		this.disposePane();
		this.container.replaceChildren();
		super.clearInput();
	}

	override dispose(): void {
		// 兜底归位：关闭浮动窗口时 VS Code 默认会把编辑器"移动"到主窗口
		// editor 区（见 editorParts.ts 的 `close()`："will move remaining
		// editors to main part"），此时并不会走 clearInput，而是直接 dispose
		// 这个 pane。如果不在此处兜底归位，视图就会停留在 Editor 区（用户
		// 看到的就是"关闭后视图回不去，留在 edit 里"）。
		// super.dispose() 会清空 this.input，因此必须在它之前归位。
		this.restoreViewToOriginalLocation();

		super.dispose();
	}

	/**
	 * 将当前承载在 Editor 区的视图移回其原始栏（Panel / Aux Bar）。
	 *
	 * 关键修复（关闭窗口"需要点多次才关得掉"）：
	 * 此函数**只做归位（move）**，**绝不**再调用 `group.closeEditor(input)`。
	 *
	 * 曾在此处传入 `() => group.closeEditor(input)` 作为回调，意图
	 * "关闭承载视图的 editor tab"。但这会造成**重入 / 递归关闭**：
	 * 关闭浮动窗口时 `mergeGroupsToMainPart()` 已经 `await group.closeEditor(editor)`，
	 * 该 closeEditor 内部会触发本 pane 的 `clearInput()` → 又进入
	 * `restoreViewToOriginalLocation()` → 再次 `group.closeEditor(input)`。
	 * 在同一关闭事件循环内重入同一个 editor 的 closeEditor，会让首次关闭的
	 * `await` 无法正常 resolve（或使窗口关闭时序被打乱），表现为"点一次
	 * 关不掉、要点好几次"。
	 *
	 * 正确的分工：
	 * - 归位（move 回原栏）由本函数负责，在 `clearInput` / `dispose` 时执行，
	 *   保证视图回到 Panel / Aux Bar。
	 * - 真正关闭 editor tab 由调用方（`mergeGroupsToMainPart` 的
	 *   `await group.closeEditor(editor)`，或用户直接关 tab）负责，
	 *   本函数不再插手，从而彻底消除重入。
	 *
	 * `_restored` 守卫仍保留：防止 `clearInput` 与 `dispose` 在同一生命周期
	 * 内对同一个 input 重复归位（move 本身幂等，但避免重复日志与多余操作）。
	 */
	private restoreViewToOriginalLocation(): void {
		if (this._restored) {
			return;
		}
		this._restored = true;

		const input = this.input as ViewEditorInput | undefined;
		if (!input) {
			return;
		}

		// 仅归位，不关闭 editor（关闭由调用方负责，避免重入）。
		restoreViewEditorInputToOriginalLocation(
			input,
			this.viewDescriptorService,
			undefined
		);
	}

	private disposePane(): void {
		if (this._editorView) {
			this._editorView.dispose();
			this._editorView = undefined;
		}
	}

	private layoutPane(pane: ViewPane, dimension?: Dimension): void {
		const width = dimension?.width ?? this.container.clientWidth;
		const height = dimension?.height ?? this.container.clientHeight;

		// Avoid laying out the pane with zero/invalid dimensions. When a view is
		// first opened inside the editor area (e.g. Debug Console dragged into an
		// editor group) the container may not have a size yet. Laying out child
		// editors/widgets at 0x0 causes their content widgets (such as the REPL
		// input placeholder) to be initialized with no visible area, which then
		// renders truncated even after a subsequent real layout. Wait until the
		// editor pane receives a concrete dimension.
		if (width <= 0 || height <= 0) {
			return;
		}

		pane.setVisible(true);
		// `Pane.layout` takes only the main-axis size; the orthogonal size must
		// be set manually because we mount the pane directly (no PaneView parent).
		if (pane.orientation === Orientation.VERTICAL) {
			pane.orthogonalSize = width;
			pane.layout(height);
		} else {
			pane.orthogonalSize = height;
			pane.layout(width);
		}
	}

	override layout(dimension: Dimension): void {
		if (this._editorView) {
			this.layoutPane(this._editorView, dimension);
		}
	}
}
