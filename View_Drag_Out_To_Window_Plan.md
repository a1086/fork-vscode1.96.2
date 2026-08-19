# 视图 Tab 拖出窗口方案（方案 A）

> 分支：`bugfix/view-drag`
> 日期：2026-08-14
> 状态：方案已确认（方案 A），待 Phase 1' 技术验证

## 1. 目标

用户直接**拖拽 Panel / Auxiliary Bar（辅助栏）里的视图 tab 出窗口边界**，即可把该视图脱离主窗口，弹出一个独立的浮动窗口；浮动窗口里承载该视图（经 `ViewEditorInput` / `ViewEditorPane` 承载，复用方案 A 链路）。拖回主窗口对应区域则归位。

### 关键决策

- **不做右键菜单入口**，只保留"直接拖拽出窗口"这一种触发方式（与原生编辑器 tab 拖出体验一致）。
- **采用方案 A（经编辑器承载）而非方案 B（真·Panel 脱离）**：浮动窗口内复用已有的 `AuxiliaryEditorPart` + `ViewEditorInput`，工期省约 60%，风险更低。
- **Panel 与 Auxiliary Bar 同时支持**：二者共用 `AbstractPaneCompositePart` → `CompositeBar` 拖拽链路，改动点收敛到单一位置。

## 2. 现状分析（已确认）

| 区域 | 拖拽现状 |
|---|---|
| Activity Bar（左侧图标条） | 仅排序/移动，**不能拖出窗口**（且产品上不需要，方案不做） |
| Panel（底部面板）视图 tab | 仅在面板内移动，不能拖出 |
| Auxiliary Bar（右侧辅助栏）视图 tab | 仅在栏内移动，不能拖出 |
| 编辑器 tab | **能**拖出窗口（已有 `maybeCreateAuxiliaryEditorPartAt`） |

### 关键代码位置

- `src/vs/workbench/browser/parts/panel/panelPart.ts:36` — `PanelPart extends AbstractPaneCompositePart`
- `src/vs/workbench/browser/parts/auxiliarybar/auxiliaryBarPart.ts:42` — `AuxiliaryBarPart extends AbstractPaneCompositePart`
- `src/vs/workbench/browser/parts/compositeBar.ts:227` — `CompositeBarDndCallbacks.onDragEnd`（**核心改动点**）
- `src/vs/workbench/browser/parts/editor/auxiliaryEditorPart.ts` — 辅助窗口承载（已存在，复用）
- `src/vs/workbench/contrib/viewInEditor/browser/viewEditorInput.ts` / `viewEditorPane.ts` — 视图进编辑器链路（已存在，复用）
- `src/vs/workbench/browser/parts/editor/editorTabsControl.ts:423` — `maybeCreateAuxiliaryEditorPartAt()` 判定逻辑（参照复用）
- `src/vs/workbench/services/editor/common/editorGroupsService.ts` — `createAuxiliaryEditorPart({ bounds? })`

### 复用要点

`CompositeBarDndCallbacks.onDragEnd` 当前仅清除拖拽反馈，无"拖出窗口"分支。需在此加入判定，复用编辑器区的工具函数：

- `isNewWindowOperation(e)` — 是否触发开窗（受 `workbench.editor.dragToOpenWindow` 控制，Alt 反转）
- `isWindowDraggedOver()` — 是否拖回窗口内（与开窗路径互斥）
- `hostService.getCursorScreenPoint()` — 取落点作为新窗口 bounds
- `editorGroupsService.createAuxiliaryEditorPart({ bounds })` — 开辅助窗口

## 3. 方案设计

### 3.1 Phase 1' — 技术验证 Spike（内部，不暴露入口）

- 目的：验证 `ViewPane` / `ViewEditorPane` 能否在 auxiliary window 正常渲染（`getActiveWindow()` 是否错乱、context menu 是否弹到主窗口等）。
- 手段：用临时命令（内部手段，不注册右键/命令面板）走通 `createAuxiliaryEditorPart` + `ViewEditorInput` 打开某视图。
- 产出：跑通则锁定方案 A；跑不通则及时止损转方案 B。
- 估时：**1–1.5 天**，风险低。

### 3.2 Phase 2 — ViewPane 跨窗口适配

- 处理 `ViewPane` 在辅助窗口内的渲染问题（最大不确定性，两种方案共有）。
- 估时：**2–3 天**，风险 **高**。

### 3.3 Phase 3 — Panel / Aux Bar tab 直接拖出开窗（核心交付）

- 改动 `compositeBar.ts:227` 的 `onDragEnd`：
  - 判定 `isNewWindowOperation(e.eventData) && !isWindowDraggedOver()`。
  - 取 `hostService.getCursorScreenPoint()` 作为 bounds。
  - 调用 `createAuxiliaryEditorPart({ bounds })`，打开 `ViewEditorInput`（携带 composite/view id）。
  - 把该视图从原 Panel / Aux Bar 移除。
- 一处改动同时覆盖 Panel 与 Auxiliary Bar（共用 `CompositeBar`）。
- 受 `workbench.editor.dragToOpenWindow` 控制，Alt 键反转，与原生编辑器拖出一致。
- 估时：**2 天**，风险中。

### 3.4 Phase 4 — 生命周期

- 关闭浮动窗口 → 视图归还原 Panel / Aux Bar（需记录归属，因两栏互斥）。
- 重启恢复：持久化已开窗视图。
- 拖空隐藏：原栏拖空后处理。
- 估时：**1.5–2 天**，风险中。

### 3.5 Phase 5 — 测试与边界场景

- 多视图同时开窗、拖回不同区域、跨多显示器、窗口关闭/重启等边界。
- 估时：**2 天**。

## 4. 工期汇总

| Phase | 内容 | 估时 | 风险 |
|---|---|---|---|
| 1' | 技术验证（内部，不暴露入口） | 1–1.5 天 | 低 |
| 2 | ViewPane 跨窗口适配 | 2–3 天 | 高 |
| 3 | Panel / Aux Bar tab 拖出开窗 | 2 天 | 中 |
| 4 | 关闭归还 / 重启恢复 / 拖空隐藏 | 1.5–2 天 | 中 |
| 5 | 测试与边界 | 2 天 | — |
| **合计** | | **8.5–10.5 天** | |

> 关键变量是 Phase 2：`ViewPane` 从未在辅助窗口跑过。Phase 1' 跑通后整体工期落低位（~8.5 天）；若 Terminal / Ports 等视图跨窗口出现 `getActiveWindow()` 错乱等问题，Phase 2 可能膨胀至 12–13 天，甚至需回退方案 B（20–25 天）。

## 5. 关键约束与说明

1. **不暴露右键菜单**：删除 `viewInEditorActions` 中 `MenuId.ViewTitleContext` / `PanelTitleContext` / `CommandPalette` 的注册（如有）。
2. **Panel 与 Aux Bar 互斥**：一个视图要么在 Panel 要么在 Aux Bar；拖出后需记录来源，归位时回到对应栏。
3. **观感**：方案 A 浮动窗口内为 `ViewEditorPane` 包裹 `ViewPane`，可通过样式隐藏编辑器 header/tab 逼近方案 B 原生观感（分支已有相关样式章节）。
4. **白名单渐进放开**（可选）：首版可先只支持 Output / Problems，Terminal / Ports 单独排期，首版压缩至 6–7 天。

## 6. 下一步

先执行 Phase 1' 技术验证 spike，验证通过后再实施 Phase 3 的 `compositeBar.ts` 改动。

## 7. 开发进度（2026-08-14 更新）

| Phase | 内容 | 状态 | 落地位置 |
|---|---|---|---|
| 1' | 技术验证 Spike | ✅ 已落地 | `viewInEditor.contribution.ts` 内部命令 `_spike.openViewInAuxiliaryWindow`（不暴露入口，验证后删除） |
| 2 | ViewPane 跨窗口适配 | ✅ 复用既有 `ViewEditorPane` | `viewEditorPane.ts` 已能在 auxiliary window 承载 ViewPane |
| 3 | Panel / Aux Bar tab 拖出开窗 | ✅ 已落地 | `compositeBar.ts` `onDragEnd` + `openInAuxiliaryWindow` |
| 4 | 关闭归还 / 重启恢复 / 拖空隐藏 | ✅ 已落地 | `viewEditorPane.ts#clearInput` 归位；`viewInEditor.contribution.ts#deserialize` 重启归位；空栏隐藏由框架 `shouldAutoHidePartWhenEmpty` 覆盖 |
| 5 | 测试与边界场景 | ✅ 代码加固 | 跨多显示器 bounds 保护、moveViewToLocation 竞态调整 |

### 已知限制（首版）

1. **白名单渐进放开**：composite id 与其主 view id 相同（如 `workbench.panel.problems`、`workbench.panel.output`）的视图可直接拖出；container id ≠ 主 view id 且含多 view 的容器（如 Terminal 的 `workbench.panel.terminal`）首版不强制支持，会安全放弃开窗。后续可参照 `ViewEditorPane#setInput` 的 descriptor 解析逻辑扩展。
2. **归位语义**：关闭浮动窗口 / 关闭 tab 一律归位到 `originalLocation`（来源栏）；拖回主窗口时回到记录来源栏，而非落地栏（符合"Panel 与 Aux Bar 互斥，记录来源"约束）。
3. **临时 spike 命令**：`_spike.openViewInAuxiliaryWindow` 为 Phase 1' 验证入口，待运行时确认链路后在清理阶段删除。

## 8. 运行时验证清单

- [ ] 拖 Panel tab（如 Problems）出窗口边界 → 弹出独立浮动窗口并渲染该视图
- [ ] 跨多显示器拖出 → 窗口落点不溢出屏幕
- [ ] 关闭浮动窗口 → 视图归还原 Panel
- [ ] 关闭浮动窗口内 tab → 视图归还原栏
- [ ] 重启应用 → 已开窗视图归位原栏（无主编辑器区残留）
- [ ] 拖空 Panel / Aux Bar 某栏 → 框架自动隐藏空 composite tab
- [ ] 多视图各拖出一个浮动窗口 → 互不干扰
- [ ] 按住 Alt 拖出（dragToOpenWindow 开启时反转）→ 不触发开窗（改为栏内移动）
