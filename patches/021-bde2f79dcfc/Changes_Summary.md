# VS Code 工作区改动总结

> 改动日期：2026-07-16 ~ 2026-07-20
> 本文档汇总当前工作区（未提交）的全部代码改动，按功能模块分类说明。

---

## 1. 活动栏（Activity Bar）在 top / bottom / right 时始终显示 Debug 图标（2026-07-16）

**需求**：让 Run and Debug 图标在活动栏处于顶部、底部、右侧（`default` 且侧栏在右）时都常驻。

### 1.1 核心支撑：`PaneCompositeBar` 支持注入额外条目
`src/vs/workbench/browser/parts/paneCompositeBar.ts`
- 新增选项类型 `extraCompositeItems: { id, name, order?, icon, targetViewContainerId? }[]`（第 87 行）。
- 新增 `addExtraCompositeItems()` 方法（第 140–145 行），在构造时为每个 CompositeBar 注入这些固定条目并 `pin`。
- 在多处用 `extraCompositeItems` 过滤，使这些条目：不可被隐藏（第 580、705 行）、不可被移动/重置（第 295、351、623、650 行）。
- 新增 `OpenViewContainerActivityAction`：点击图标时 `openViewContainer(targetViewContainerId, true)`，从而支持"活动栏上的图标打开另一位置（如 Auxiliary Bar）的容器"。

### 1.2 三个渲染活动栏的 Part 接入
- `src/vs/workbench/browser/parts/activitybar/activitybarPart.ts`
  `createCompositeBar()` 增加 `extraCompositeItems`，id 为 `workbench.view.debug.launcher`，图标 `runViewIcon`，目标容器 `workbench.view.debug`（左侧/右侧主活动栏）。
- `src/vs/workbench/browser/parts/sidebar/sidebarPart.ts`
  `getCompositeBarOptions()` 增加同样的 `extraCompositeItems`（顶部/底部主活动栏）。
- `src/vs/workbench/browser/parts/auxiliarybar/auxiliaryBarPart.ts`
  原已加入但按要求**已移除**右侧（Secondary Side Bar）的该图标。

### 1.3 配套修改
- `src/vs/workbench/browser/parts/compositeBar.ts`
  - `ICompositeBarOptions` 新增 `isCompositeDraggable?: (compositeId) => boolean`。
  - 创建 `CompositeActionViewItem` 时，`draggable` 改为由 `isCompositeDraggable` 决定（extra 条目返回 `false`，不可拖拽）。
- `src/vs/workbench/browser/parts/compositeBarActions.ts`
  `CompositeBarAction` 新增 `updateCompositeBarActionItem()` 方法，支持动态更新 action 项。
- `src/vs/base/browser/ui/splitview/paneview.css`
  - `.pane-header` 增加 `padding-right: 8px`。
  - `.action-item` 间距选择器改为 `:not(:last-child)`，避免最后一个图标多余间距。

---

## 2. Debug 视图默认位置改为 Auxiliary Bar（右侧）（2026-07-16）

`src/vs/workbench/contrib/debug/browser/debug.contribution.ts`
- 注册 Run and Debug 视图容器时，位置由 `ViewContainerLocation.Sidebar` 改为 `ViewContainerLocation.AuxiliaryBar`。
- Debug Console（REPL 视图）的 `canToggleVisibility` 由 `false` 改为 `true`，即允许从 Views 菜单隐藏调试控制台。

---

## 3. Activity Bar 默认位置改为 top（2026-07-16）

`src/vs/workbench/browser/workbench.contribution.ts`
- 设置 `workbench.activityBar.location` 的默认值由 `'default'` 改为 `'top'`。

---

## 4. 编辑器区域（Editor Area）显隐与空组关闭优化（2026-07-16）

### 4.1 新增 "Toggle Editor Area Visibility" 命令
`src/vs/workbench/browser/actions/layoutActions.ts`
- 注册 `Action2`：`id = workbench.action.toggleEditorPartVisibility`，标题 "Toggle Editor Area Visibility"，分类 `View`，图标 `Codicon.close`，`toggled = MainEditorAreaVisibleContext`。
- 菜单：`EditorTitle` 的 `navigation` 组，`order` 置为最大值（最右侧），`when = MainEditorAreaVisibleContext && !IsAuxiliaryEditorPartContext`（仅主编辑器区可见且非辅助窗口时显示）。
- `run()`：根据 `IWorkbenchLayoutService.isVisible(Parts.EDITOR_PART)` 调用 `setPartHidden` 切换。

### 4.2 隐藏编辑器后的恢复逻辑修复
`src/vs/workbench/browser/layout.ts`
- `showEditorIfHidden()` 中：若编辑器被隐藏，原来直接 `toggleMaximizedPanel()`；现改为：若 Panel 上次是最大化（`PANEL_WAS_LAST_MAXIMIZED`）则恢复最大化，否则 `setEditorHidden(false)` 恢复编辑器。

### 4.3 空编辑器组关闭按钮（UI）
- `src/vs/workbench/browser/parts/editor/editorGroupWatermark.ts`
  在编辑器组容器右上角新增 `editor-group-close-button`（关闭图标 `Codicon.close`），注入 `ICommandService`，点击执行 `workbench.action.closeGroup`；含 `role/tabindex/aria-label` 无障碍属性。
- `src/vs/workbench/browser/parts/editor/media/editorgroupview.css`
  新增 `.editor-group-close-button` 样式（默认 `display:none`，仅空组 `.empty` 时 `display:block`，hover 高亮）。

### 4.4 关闭命令与菜单调整
- `src/vs/workbench/browser/parts/editor/editorCommands.ts`
  - `CLOSE_EDITOR_COMMAND_ID` 增加 `when: ActiveEditorGroupEmptyContext.toNegated()`（空组时不触发关闭）。
  - `CLOSE_EDITOR_GROUP_COMMAND_ID` 的 `when` 由 `Empty && MultipleGroups` 放宽为仅 `Empty`。
  - 关闭处理器：当关闭的是主编辑器区最后一个空组时，改为 `setPartHidden(true, Parts.EDITOR_PART)` 隐藏整个编辑器区（便于恢复），否则 `removeGroup`。
- `src/vs/workbench/browser/parts/editor/editor.contribution.ts`
  - 引入 `ActiveEditorGroupEmptyContext`。
  - 从 `EmptyEditorGroup` 菜单移除 `CLOSE_EDITOR_GROUP_COMMAND_ID` 项（改由右上角关闭按钮承担）。
- `src/vs/workbench/browser/parts/editor/singleEditorTabsControl.ts`
  单页签模式下，非激活编辑器的 primary actions 过滤中移除 `CLOSE_EDITOR_COMMAND_ID`（仅保留 `UNLOCK_GROUP_COMMAND_ID`），即非激活单页签不再显示关闭按钮。
- `src/vs/workbench/browser/parts/editor/media/multieditortabscontrol.css`
  `.editor-actions .action-item` 间距选择器改为 `:not(:last-child)`。

---

## 5. 视图（View）标题栏：移除折叠箭头 + 悬停显示关闭按钮（2026-07-20）

**需求**：视图分组标题栏去掉左侧折叠三角，改为在右侧提供一个悬停出现的关闭按钮（等价于"隐藏视图"）。

- `src/vs/workbench/browser/parts/views/viewPane.ts`
  - `renderHeader()` 不再创建 `twisty-container`（折叠箭头）。
  - 对"可隐藏"的视图（`canToggleVisibility` 为真）：在标题后插入一个 `.pane-header-spacer`（flex 占位，把 actions 与关闭按钮推到最右），并新增 `.pane-close-action` 关闭按钮（`Codicon.close`）。
  - 关闭按钮：含 `role=button` / `tabindex=0` / `aria-label`，悬停 tooltip；点击或键盘 Enter/Space 执行 `${this.id}.removeView`。
- `src/vs/workbench/browser/parts/views/media/paneviewlet.css`
  - `.pane-header` 增加 `margin-bottom: 4px`。
  - 隐藏 `.twisty-container`（`display:none !important`，作为兜底）。
  - `.title` 增加 `margin-left: 8px`，补上折叠箭头原先占的左内边距。
  - `.pane-header-spacer { flex: 1 }`。
  - `.pane-close-action` 默认隐藏，`pane:hover` / `focus-within` / `header.focused` 时显示，hover 时不透明度加深。
- `src/vs/workbench/browser/media/part.css`
  末尾新增两行空行（无实际样式影响）。

---

## 6. Explorer "Folders"（资源管理器文件夹）视图可隐藏开关（2026-07-20）

`src/vs/workbench/contrib/files/browser/explorerViewlet.ts`
- 新增配置项 `explorer.enableFoldersViewHiding`（boolean，默认 `true`）：控制资源管理器中的 Folders 视图能否从 Views 菜单隐藏；关闭时该视图始终显示。
- `ExplorerViewletViewsContribution` 注入 `IConfigurationService`，监听该配置变化并 `registerViews()` 重新注册。
- Folders 视图的 `canToggleVisibility` 由固定 `false` 改为读取该配置值。

---

## 7. Problems（问题）视图可隐藏开关（2026-07-20）

`src/vs/workbench/contrib/markers/browser/markers.contribution.ts`
- 新增配置项 `problems.enableProblemsViewHiding`（boolean，默认 `true`）：控制 Problems 视图能否从 Views 菜单隐藏。
- 重构视图注册：抽出 `createMarkersViewDescriptor(canToggleVisibility)`；默认以 `false` 注册。
- 新增 `MarkersViewVisibilityContribution`（`LifecyclePhase.Restored`）：根据配置动态 `deregisterViews` + `registerViews` 切换 `canToggleVisibility`，并监听配置变化实时生效。

---

## 8. 侧边栏 / 面板分组标题（Section Header）配色调整（2026-07-20）

**目的**：让侧边栏与面板的分组标题栏有更明显的背景色与边框，视觉分区更清晰。

- `src/vs/workbench/common/theme.ts`
  - `panelSectionHeader.background`：由 `#808080` 透明度 0.2（dark/light 相同）改为 dark `#3c3c3c` / light `#C0C0C0`。
  - `panelSectionHeader.border`：由 `contrastBorder` 改为 dark `#4e4e4e` / light `#B0B0B0`（高对比度 hcDark/hcLight 仍用 `contrastBorder`）。
- 内置主题 `sideBarSectionHeader` 背景/边框：
  - `extensions/theme-defaults/themes/dark_modern.json`：`#181818/#2B2B2B` → `#3c3c3c/#4e4e4e`。
  - `extensions/theme-defaults/themes/dark_vs.json`：`#0000/#ccc3` → `#3c3c3c/#4e4e4e`。
  - `extensions/theme-defaults/themes/light_modern.json`：`#F8F8F8/#E5E5E5` → `#CCCCCC/#B0B0B0`。
  - `extensions/theme-defaults/themes/light_vs.json`：`#0000/#61616130` → `#C0C0C0/#A0A0A0`。
- `.vscode/settings.json`
  新增 `workbench.colorCustomizations`，为多个主题（`[Light+]`、`[Light Modern]`、`[Light (Visual Studio)]`、`[Light High Contrast]`、`[Dark+]`、`[Dark Modern]`、`[Dark (Visual Studio)]`）分别覆盖 `sideBarSectionHeader` 与 `panelSectionHeader` 的 `background`/`border`（仅本工作区生效）。

---

## 9. 其他（配置）（2026-07-16）

`.npmrc`
- 仅新增两行**被注释掉**的镜像配置（`electron_mirror`、`registry` 指向 npmmirror），未生效，不影响功能。

---

## 10. 配置扩展市场为 Open VSX + C++ 调试调研（2026-07-20）

### 10.1 实际改动（唯一一处代码改动）

`product.json` 新增 `extensionsGallery` 配置，将扩展市场指向 Open VSX，共 5 行：

```json
"extensionsGallery": {
    "serviceUrl": "https://open-vsx.org/vscode/gallery",
    "itemUrl": "https://open-vsx.org/vscode/item",
    "resourceUrlTemplate": "https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}"
}
```

结果：开发版（`scripts/code.bat` 启动）的扩展面板现在能搜索并安装 Open VSX 上的外部插件，已实测可用（Python、Java、JavaScript Debugger 等均可搜到并安装）。

### 10.2 关键结论（未改代码，供参考）

1. **配置生效原理**：
   - 开发模式下 `src/bootstrap-meta.ts` 直接 `require('../product.json')`，故改 `product.json` 即生效。
   - `src/bootstrap-esm.ts` 在 `VSCODE_DEV` 下还会读取可选的 `product.overrides.json`（已在 `.gitignore`），适合本地覆盖不污染 git。本次选择直接改 `product.json`（排查中曾建后删除 `product.overrides.json`，未保留）。
2. **之前"配了不生效/搜不到"的原因**：product 配置在进程启动时读取，仅 Reload 窗口无效，需完全重启开发实例；重启后即生效。用 curl 验证 Open VSX 的 `/extensionquery` 返回 200 且有数据，服务端正常（此前 400 为 PowerShell 转义假象）。
3. **签名校验**：仅打包版（`isBuilt === true`）才校验；开发源码运行不校验，故 Open VSX 未签名扩展在 dev 下可正常安装。
4. **内置调试器 vs 市场版**：`builtInExtensions` 里的 `ms-vscode.js-debug` 就是微软官方 JS 调试器，构建时按钉死的 version+sha256 从 GitHub 下载、不随市场更新；与市场版是同一份代码，仅分发方式不同。

### 10.3 C++ 调试（结论，未配置）

- **CodeLLDB**（`vadimcn.vscode-lldb`，Open VSX 上有，下载量约 117 万）基于 LLDB / DWARF，**读不了 MSVC 的 PDB**，无法稳定调试 MSVC 程序。
- 用户场景：MSVC 主进程/DLL + 一个 clang 编的 DLL 混合运行。
  - **能否一起运行**：只要 clang DLL 是 MSVC 目标（`clang-cl` 或 `clang++ --target=x86_64-pc-windows-msvc`）且 CRT 链接方式（如都用 `/MD`）统一，可正常一起运行；若为 MinGW 目标（`...-windows-gnu`）则 ABI/运行库不同，混用会出问题。
  - **跨 DLL 边界**：避免"一个模块分配、另一个模块释放"内存/对象，建议 C 风格接口或明确所有权。
- **同一会话内同时命中 MSVC 与 clang 模块断点**：需微软 cpptools 的 `cppvsdbg`（能读 PDB；clang 侧用 `clang-cl /Z7` 或 `clang++ -g -gcodeview` 生成 CodeView/PDB）。
- **障碍**：`ms-vscode.cpptools` 为微软专有许可，Open VSX 无官方版本，在自编译非官方构建中使用涉及许可合规，需自行判断。
- 备选：改纯开源工具链（Clang/LLVM + CodeLLDB，或 MinGW g++ + gdb）可合法、省心配置。

### 10.4 未决事项 / 下一步

- [ ] 与用户确认最终调试路线（A：Clang/LLVM + CodeLLDB；B：MSVC + 微软 cppvsdbg）
- [ ] 按所选路线在真实 C++ 项目目录创建 `.vscode/tasks.json` + `.vscode/launch.json`

### 10.5 清理

排查期间的临时文件（`query.json`、`response.json`、`q1.json`、`r1~r3.json`、`product.overrides.json`、误建的 `改动文档.md`）均已删除，无残留。

---

## 11. 已评估但尚未实现的方案（规划中）（2026-07-16）

以下为讨论过但**尚未编写代码**的方向，供后续参考：

### 11.1 Part 级别拖拽（Sidebar / Panel / Auxiliary Bar 整体拖动换边）
- 现状：VS Code 主布局底层使用 `SerializableGrid`（`src/vs/base/browser/ui/grid/grid.ts`），已提供 `moveView(view, size, ref, direction)`。
- 最小可行方案：给 Part 标题栏加拖拽手柄 → 拖拽时显示 drop indicator → 落点调用 `setPanelPosition()` / `setSideBarPosition()` → 同步 CSS 类与持久化。
- 预估：Panel 换边 2–3 天；Sidebar / Auxiliary Bar 左右互换 2–3 天；联调与样式 1–2 天。
- Panel 整体拖拽换边暂未实现。

### 11.2 Panel 内 View 像编辑器一样自由分屏（上下左右）
- 现状：`ViewPaneContainer` 底层是单方向 `PaneView`（`src/vs/base/browser/ui/splitview/paneview.ts`），只能单向排列，拖拽只做同方向 reorder。
- 方案：将底层 `PaneView` 替换为 `Grid`，复用 `ViewPaneDropOverlay` 的 UP/DOWN/LEFT/RIGHT，落点调用 `grid.addView` / `grid.moveView`；并保存/恢复 Grid 布局结构。
- 风险：ViewPane 的 header 折叠逻辑与 Grid 的 `IView` 接口需重写；拖拽事件可能与内部 List/Tree 冲突；Activity Bar / 标题栏需随激活子区域联动。
- 预估：单容器原型 5–8 天；全容器推广 + 稳定化约 3–5 周。

---

## 12. 验证方式

1. 等待 `watch-client` 编译通过（`Finished compilation with 0 errors`）。
2. 重新加载窗口（`Developer: Reload Window`）；涉及 `product.json` 的改动需**完全重启**开发实例。
3. 检查项：
   - 活动栏在 top / bottom / right 时均显示 Run and Debug 图标（右侧 Secondary Side Bar 不显示）。
   - 默认活动栏位于顶部。
   - Debug 视图默认出现在右侧 Auxiliary Bar；Debug Console 可从 Views 菜单隐藏。
   - 编辑器标题栏出现显隐图标；关闭最后一个空编辑器组后编辑器区隐藏并可恢复。
   - 视图标题栏无折叠箭头，悬停时右侧出现关闭按钮，可隐藏视图。
   - `explorer.enableFoldersViewHiding`、`problems.enableProblemsViewHiding` 关闭时对应视图不可隐藏、开启时可隐藏。
   - 侧边栏/面板分组标题栏显示新的背景色与边框。
   - 扩展面板可搜索并安装 Open VSX 上的外部插件。

---

## 13. 编辑器区关闭按钮去背景 + Ctrl+K W 关闭全部编辑器后隐藏编辑器区（2026-07-21）

### 13.1 去除编辑器区 X 按钮背景色（移除 toggled）
`src/vs/workbench/browser/actions/layoutActions.ts`
- "Toggle Editor Area Visibility" 命令（`workbench.action.toggleEditorPartVisibility`）原带 `toggled: MainEditorAreaVisibleContext`，会让编辑器标题栏右上角的 X 按钮在编辑器区可见时呈现"选中/高亮"背景。
- 移除该 `toggled` 属性，按钮不再显示背景色，仅保留普通图标外观。

### 13.2 Ctrl+K W 关闭全部编辑器后同时隐藏编辑器区域
`src/vs/workbench/browser/parts/editor/editorCommands.ts`（`CLOSE_EDITORS_IN_GROUP_COMMAND_ID` 处理器，即 Ctrl+K W 实际绑定的命令）
- 需求：Ctrl+K W 关闭全部编辑器后，不仅关闭编辑器，还要把空的编辑器区域一并隐藏。
- 实现：在关闭所有编辑器后，若主编辑器区（`mainPart`）所有分组均为空（`groups.every(g => g.isEmpty)`），调用 `layoutService.setPartHidden(true, Parts.EDITOR_PART, mainWindow)` 隐藏编辑器区。

**排查与修复的两个根因**：
1. **async 之后使用 accessor 无效**：VS Code 命令处理器的 `ServicesAccessor` 只在回调同步执行期间有效；在 `await` 之后再调用 `accessor.get(...)` 会失效/无效果。这是前两次"隐藏代码不生效"的根本原因。修复：在 `await` 之前先解析好 `IEditorGroupsService`、`IWorkbenchLayoutService` 等所有需要的服务。
2. **辅助窗口下误隐藏主编辑区**：原逻辑无条件针对 `mainPart` 隐藏，若在辅助（Auxiliary）窗口触发 Ctrl+K W，会错误隐藏主窗口编辑区。修复：关闭前先用 `getPart(group) === mainPart` 计算 `affectsMainPart`，仅当本次操作确实作用于主编辑器区、且其所有分组为空时才隐藏。

> 说明：关闭时使用 `excludeSticky: true`，故若某分组仍保留 sticky 编辑器，`groups.every(g => g.isEmpty)` 为假，编辑器区保持可见，符合预期。

---

## 14. 主要 Part（编辑器 / 面板 / 侧边栏 / 辅助栏）之间增加 4px 间距（2026-07-21）

**需求**：让编辑器区（Editor）、面板（Panel）、主侧边栏（Sidebar）、辅助侧边栏（Auxiliary Bar）这些顶层 Part 之间有 4px 的视觉间隔。

**背景**：这些顶层 Part 由工作台 `SerializableGrid`（`workbenchGrid`）以绝对定位精确布局，相邻 Part 边缘紧贴，普通 `margin` 无法在其间产生间距。

`src/vs/workbench/browser/media/part.css`
- 两步实现：
  1. 为工作台网格容器 `.monaco-grid-view`（所有 Part 的背后容器）设置 `background-color: var(--vscode-titleBar-activeBackground, #1e1e1e)`——这就是间隙透出的颜色。
  2. 为 `.part.editor`、`.part.panel`、`.part.sidebar`、`.part.auxiliarybar`、`.part.activitybar`、`.part.statusbar` 设置 `border: 2px solid transparent` + `background-clip: padding-box`。
- 原理：每个 Part 加 2px **透明**边框，相邻两个 Part 相加即形成 4px 间隙、窗口边缘处形成 2px 内缩；`background-clip: padding-box` 保证 Part 自身背景不绘制到透明边框区域，于是间隙/内缩处透出第 1 步设置的网格背景色，视觉上每个 Part 像一块"悬浮卡片"。Part 本身 `box-sizing: border-box`，边框不改变其栅格尺寸。
- 说明：之前只加透明边框而未给网格上色，间隙背后无固定颜色，导致间隙颜色异常；补上网格背景色后间隙颜色统一为标题栏背景色。


- **关键点（间隙均匀）**：必须让所有相邻 Part（含 Activity Bar、Status Bar）都带同样的 2px 边框，否则"有边框 Part"挨着"无边框 Part"处只有 2px、而两个有边框 Part 之间是 4px，造成间隙不均（尤其 Panel 与活动栏/状态栏相邻处）。全部纳入后每条边界统一 4px。

> 注：先前误将该需求实现为"视图分组（View Pane）标题栏间距"（改 `paneviewlet.css`），已回退，仅保留本 Part 级实现。

---

## 15. 编辑器分组拖拽只影响相邻组（禁用 Grid 比例布局）（2026-08-04）

**需求**：多个编辑器分组（edit group）宽度/高度不同时，拖拽某个组的分隔线（sash）应当**只调整紧邻的两个组**，而不应连带缩放其他非拖拽目标的组（即不希望"一个组被拖，其他组也跟着变"）。

**根因**：编辑器区底层是树状嵌套的 `Grid`（`src/vs/base/browser/ui/grid/grid.ts`），由多层 `SplitView` 组成。Grid 的 `proportionalLayout` 默认值为 `true`（`src/vs/base/browser/ui/grid/gridview.ts:1171`）。该开关会沿 `BranchNode` 逐层传给每一层 `SplitView`。当布局为嵌套结构（例如左侧一个组、右侧上下两个组）时，拖拽某个分隔线导致父分支尺寸变化，会**按比例**重新分配其所有子组尺寸——包括那些非拖拽目标的组，表现就是"拖一个组，其他组也被缩放"。

**修复**：在 `editorPart.ts` 创建 Grid 的两处入口显式传 `proportionalLayout: false`，使拖拽只调整 sash 两侧的相邻两个视图，其余视图尺寸保持不变。`proportionalLayout: false` 会被 `BranchNode` 自动继承到所有后续 `addGroup` 动态新增的子分支，无需额外改动。

### 15.1 改动文件
`src/vs/workbench/browser/parts/editor/editorPart.ts`
- `doCreateGridControlWithState()` 中 `SerializableGrid.deserialize(...)` 的 options 增加 `proportionalLayout: false`：
  ```ts
  { styles: { separatorBorder: this.gridSeparatorBorder }, proportionalLayout: false }
  ```
- `doCreateGridControl()` 中首次创建（无历史状态）时同样传入：
  ```ts
  this.doSetGridWidget(new SerializableGrid(initialGroup, { proportionalLayout: false }));
  ```

### 15.2 验证
1. 编译通过（`watch-client` 0 errors）。
2. 创建嵌套布局（如 2×2 或多列分组），拖拽其中一条分隔线，确认只有其两侧的组尺寸变化，其余非相邻组保持不动。
3. 动态 `addGroup` 新增分组后，拖拽行为同样只影响相邻组。

---

## 16. 编辑器分组拖拽只影响相邻组（修复 SplitView.resize 核心算法）（2026-08-04）

**需求**：同 #15。上一次修复在 `editorPart.ts` 设置 `proportionalLayout: false` 后问题仍然存在——拖拽某个编辑器组的分隔线时，同一行/列中非紧邻的其他组仍被连带缩放。

**根因**：`proportionalLayout: false` 只是禁用了"按比例缩放"，但 SplitView 的核心 `resize()` 函数（`src/vs/base/browser/ui/splitview/splitview.ts:1250-1251`）在计算哪些 view 参与尺寸分配时，使用的是：

```
upIndexes = range(index, -1)      // sash 左侧所有 view
downIndexes = range(index + 1, this.viewItems.length)  // sash 右侧所有 view
```

对于 **3 个 group 水平排列（索引 0, 1, 2）**，拖拽 sash[0]（group0 与 group1 之间）时：
- upIndexes = [0] ✓
- downIndexes = [1, 2] ✗ — **group2 不应该参与**

随后 `resize()` 的 delta 分配循环（1302-1318行）会遍历 downItems **所有元素**：当 group1 到达 min/max 边界后，剩余 delta 会溢出到 group2，导致非相邻组也被改变大小。

**修复**：将 `resize()` 和 `onSashStart()` 中的 `upIndexes` / `downIndexes` 从"整侧所有 view"改为**仅包含紧邻 sash 的两个 view（index 和 index+1）**。这样拖拽任何 sash 时，delta 只在两个相邻 view 之间传递，不会波及更远的 view。

### 16.1 改动文件
`src/vs/base/browser/ui/splitview/splitview.ts`
- `resize()` 函数（~1251行）：`upIndexes = [index]`, `downIndexes = [index + 1]`
- `onSashStart()` 函数（~929行）：同步修改

### 16.2 影响分析
- **2 个 view 的 SplitView**（Panel、Sidebar 等）：修改前后行为完全一致（up=[0], down=[1]），无影响。
- **3+ 个 view 的 SplitView**（编辑器多 group）：从"拖一带动一片"变为"只动相邻两个"，符合预期。
- **边界安全**：sash index 最大为 `viewItems.length - 2`，故 `index + 1` 最大为 `viewItems.length - 1`，不会越界。

### 16.3 验证
1. 编译通过（tsc 无错误）。
2. 创建 3 个及以上水平排列的编辑器组，拖拽中间的任意一条分隔线，确认只有该分隔线两侧的两个组尺寸变化，第三个及之后的组保持不变。







