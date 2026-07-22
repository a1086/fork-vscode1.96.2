# VS Code 默认菜单与对应脚本汇总

> 汇总时间：2026-07-14
> 基于 VS Code 源码 tag `1.96.2`
> 所有菜单 ID 定义在：`src/vs/platform/actions/common/actions.ts`

---

## 一、顶部菜单栏（Menubar）

主菜单栏在 `menubarControl.ts` 中组装，各子菜单项分散在不同模块注册。

### 主菜单定义

```ts:48:127:src/vs/workbench/browser/parts/titlebar/menubarControl.ts
MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
    submenu: MenuId.MenubarFileMenu,
    title: { value: 'File', ... },
    order: 1
});
MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
    submenu: MenuId.MenubarEditMenu,
    title: { value: 'Edit', ... },
    order: 2
});
MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
    submenu: MenuId.MenubarSelectionMenu,
    title: { value: 'Selection', ... },
    order: 3
});
MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
    submenu: MenuId.MenubarViewMenu,
    title: { value: 'View', ... },
    order: 4
});
MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
    submenu: MenuId.MenubarGoMenu,
    title: { value: 'Go', ... },
    order: 5
});
MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
    submenu: MenuId.MenubarTerminalMenu,
    title: { value: 'Terminal', ... },
    order: 7
});
MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
    submenu: MenuId.MenubarHelpMenu,
    title: { value: 'Help', ... },
    order: 8
});
MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, {
    submenu: MenuId.MenubarPreferencesMenu,
    title: { value: 'Preferences', ... },
    when: IsMacNativeContext,
    order: 9
});
```

| 菜单 | MenuId | 主要注册文件 |
|---|---|---|
| File | `MenubarFileMenu` | `src/vs/workbench/browser/parts/editor/editor.contribution.ts`<br>`src/vs/workbench/browser/actions/workspaceActions.ts`<br>`src/vs/workbench/browser/actions/windowActions.ts`<br>`src/vs/workbench/contrib/files/browser/fileActions.contribution.ts`<br>`src/vs/workbench/contrib/preferences/browser/preferences.contribution.ts`<br>`src/vs/workbench/contrib/userDataProfile/browser/userDataProfile.ts`<br>`src/vs/workbench/contrib/remote/browser/remoteIndicator.ts`<br>`src/vs/workbench/electron-sandbox/desktop.contribution.ts` |
| Edit | `MenubarEditMenu` | `src/vs/editor/contrib/clipboard/browser/clipboard.ts` |
| Selection | `MenubarSelectionMenu` | `src/vs/workbench/contrib/codeEditor/browser/toggleMultiCursorModifier.ts` |
| View | `MenubarViewMenu` | `src/vs/workbench/services/views/browser/viewsService.ts`（视图注入）<br>`src/vs/workbench/browser/actions/layoutActions.ts`<br>`src/vs/workbench/browser/parts/editor/editor.contribution.ts`<br>`src/vs/workbench/contrib/quickaccess/browser/quickAccess.contribution.ts`<br>`src/vs/workbench/contrib/codeEditor/browser/toggleWordWrap.ts` |
| Go | `MenubarGoMenu` | `src/vs/workbench/browser/parts/editor/editor.contribution.ts`<br>`src/vs/workbench/contrib/quickaccess/browser/quickAccess.contribution.ts`<br>`src/vs/workbench/contrib/files/browser/fileActions.contribution.ts`<br>`src/vs/editor/contrib/bracketMatching/browser/bracketMatching.ts`<br>`src/vs/workbench/contrib/scm/browser/dirtydiffDecorator.ts` |
| Terminal | `MenubarTerminalMenu` | `src/vs/workbench/contrib/tasks/browser/task.contribution.ts` |
| Help | `MenubarHelpMenu` | `src/vs/workbench/contrib/quickaccess/browser/quickAccess.contribution.ts`<br>`src/vs/workbench/contrib/welcomeWalkthrough/browser/walkThrough.contribution.ts`<br>`src/vs/workbench/contrib/issue/common/issue.contribution.ts`<br>`src/vs/workbench/contrib/issue/electron-sandbox/process.contribution.ts` |
| Preferences（Mac） | `MenubarPreferencesMenu` | macOS 原生偏好设置 |

---

## 二、View 菜单下的子菜单

| 子菜单 | MenuId | 主要注册文件 |
|---|---|---|
| Appearance | `MenubarAppearanceMenu` | `src/vs/workbench/browser/actions/layoutActions.ts`<br>`src/vs/workbench/browser/parts/panel/panelActions.ts`<br>`src/vs/workbench/browser/parts/activitybar/activitybarPart.ts` |
| Editor Layout | `MenubarLayoutMenu` | `src/vs/workbench/browser/parts/editor/editor.contribution.ts` |
| Switch Editor | `MenubarSwitchEditorMenu` | `src/vs/workbench/browser/parts/editor/editor.contribution.ts` |
| Switch Group | `MenubarSwitchGroupMenu` | `src/vs/workbench/browser/parts/editor/editor.contribution.ts` |
| Recent | `MenubarRecentMenu` | `src/vs/workbench/browser/parts/editor/editor.contribution.ts` |
| New Breakpoint | `MenubarNewBreakpointMenu` | Debug 模块 |
| Share | `MenubarShare` | 各分享功能模块 |
| Copy | `MenubarCopy` | 剪贴板相关 |
| Home | `MenubarHomeMenu` | 主屏幕相关 |

---

## 三、编辑器相关菜单

| 菜单 | MenuId | 主要注册文件 |
|---|---|---|
| 编辑器右键菜单 | `EditorContext` | `src/vs/editor/contrib/clipboard/browser/clipboard.ts`<br>`src/vs/editor/contrib/gotoSymbol/browser/goToCommands.ts`<br>`src/vs/workbench/contrib/debug/browser/debugCommands.ts`<br>`src/vs/workbench/contrib/notebook/browser/controller/coreActions.ts`<br>`src/vs/workbench/contrib/quickaccess/browser/quickAccess.contribution.ts` |
| 简单编辑器右键 | `SimpleEditorContext` | 简单编辑器 |
| 编辑器内容区 | `EditorContent` | 编辑器内容 |
| 行号右键 | `EditorLineNumberContext` | 行号上下文 |
| 编辑器复制子菜单 | `EditorContextCopy` | `clipboard.ts` |
| 编辑器 Peek 子菜单 | `EditorContextPeek` | Peek 功能 |
| 编辑器分享子菜单 | `EditorContextShare` | 分享功能 |
| 编辑器标题栏 | `EditorTitle` | 编辑器标签页标题栏 |
| 编辑器标题栏运行 | `EditorTitleRun` | 编辑器运行按钮 |
| 编辑器标题栏右键 | `EditorTitleContext` | 编辑器标签页右键 |
| 编辑器标题栏分享 | `EditorTitleContextShare` | 编辑器标签页分享 |
| 空编辑器组 | `EmptyEditorGroup` | 空编辑器组区域 |
| 空编辑器组右键 | `EmptyEditorGroupContext` | 空编辑器组右键 |
| 编辑器标签栏右键 | `EditorTabsBarContext` | 编辑器标签栏 |
| 编辑器标签栏显示标签子菜单 | `EditorTabsBarShowTabsSubmenu` | 标签显示设置 |
| Zen 模式显示标签子菜单 | `EditorTabsBarShowTabsZenModeSubmenu` | Zen 模式标签设置 |
| 编辑器操作位置子菜单 | `EditorActionsPositionSubmenu` | 编辑器操作按钮位置 |

---

## 四、资源管理器相关菜单

| 菜单 | MenuId | 主要注册文件 |
|---|---|---|
| 文件资源管理器右键 | `ExplorerContext` | `src/vs/workbench/contrib/files/browser/fileActions.contribution.ts`<br>`src/vs/workbench/contrib/files/electron-sandbox/fileActions.contribution.ts`<br>`src/vs/editor/contrib/clipboard/browser/clipboard.ts`<br>`src/vs/workbench/contrib/externalTerminal/browser/externalTerminal.contribution.ts`<br>`src/vs/workbench/contrib/timeline/browser/timeline.contribution.ts` |
| 资源管理器分享 | `ExplorerContextShare` | 分享功能 |
| 打开的编辑器右键 | `OpenEditorsContext` | 打开编辑器列表 |
| 打开的编辑器分享 | `OpenEditorsContextShare` | 打开编辑器分享 |
| 问题面板右键 | `ProblemsPanelContext` | 问题面板 |
| 时间线项右键 | `TimelineItemContext` | 时间线 |
| 时间线标题 | `TimelineTitle` | 时间线标题栏 |

---

## 五、视图容器标题栏菜单

| 菜单 | MenuId | 主要注册文件 |
|---|---|---|
| 视图容器标题栏 | `ViewContainerTitle` | `src/vs/workbench/browser/parts/views/viewPaneContainer.ts`（"..." 菜单通用框架）<br>各视图模块的 `*.contribution.ts` |
| 视图容器标题栏右键 | `ViewContainerTitleContext` | 视图容器标题栏右键 |
| 视图标题 | `ViewTitle` | 单个视图标题栏 |
| 视图标题右键 | `ViewTitleContext` | 单个视图标题栏右键 |
| 视图项右键 | `ViewItemContext` | 视图里的树节点右键 |
| 侧边栏标题 | `SidebarTitle` | 左侧边栏标题 |
| 面板标题 | `PanelTitle` | 底部面板标题 |
| 辅助侧栏标题 | `AuxiliaryBarTitle` | 右侧辅助侧栏标题 |
| 辅助侧栏头部 | `AuxiliaryBarHeader` | 右侧辅助侧栏头部 |

---

## 六、面板位置/对齐菜单

| 菜单 | MenuId | 主要注册文件 |
|---|---|---|
| 面板对齐 | `PanelAlignmentMenu` | `src/vs/workbench/browser/parts/panel/panelActions.ts` |
| 面板位置 | `PanelPositionMenu` | `src/vs/workbench/browser/parts/panel/panelActions.ts` |
| 活动栏位置 | `ActivityBarPositionMenu` | `src/vs/workbench/browser/parts/activitybar/activitybarPart.ts` |
| 布局控制菜单 | `LayoutControlMenu` | 标题栏布局控制 |
| 布局控制子菜单 | `LayoutControlMenuSubmenu` | 标题栏布局控制子菜单 |

---

## 七、调试（Debug）菜单

| 菜单 | MenuId | 主要注册文件 |
|---|---|---|
| 调试主菜单 | `MenubarDebugMenu` | `src/vs/workbench/contrib/debug/browser/debug.contribution.ts` |
| 调试工具栏 | `DebugToolBar` | 浮动调试工具栏 |
| 调试工具栏停止 | `DebugToolBarStop` | 调试工具栏停止按钮 |
| 调用堆栈工具栏 | `DebugCallStackToolbar` | 调用堆栈 |
| 断点上下文 | `DebugBreakpointsContext` | 断点视图右键 |
| 调用堆栈上下文 | `DebugCallStackContext` | 调用堆栈右键 |
| 调试控制台上下文 | `DebugConsoleContext` | 调试控制台右键 |
| 变量上下文 | `DebugVariablesContext` | 变量视图右键 |
| Notebook 变量上下文 | `NotebookVariablesContext` | Notebook 变量 |
| 监视上下文 | `DebugWatchContext` | 监视视图右键 |
| 调试悬停上下文 | `DebugHoverContext` | 调试悬停 |
| 创建调试配置 | `DebugCreateConfiguration` | 创建 launch.json |

---

## 八、源代码管理（SCM）菜单

| 菜单 | MenuId | 主要注册文件 |
|---|---|---|
| 输入框 | `SCMInputBox` | 提交信息输入框 |
| 变更列表 | `SCMChangesContext` | 变更列表 |
| 单个变更 | `SCMChangeContext` | 单个变更项 |
| 资源上下文 | `SCMResourceContext` | SCM 文件项右键 |
| 资源文件夹上下文 | `SCMResourceFolderContext` | SCM 文件夹项 |
| 资源组上下文 | `SCMResourceGroupContext` | SCM 资源组 |
| 源代码控制标题 | `SCMSourceControlTitle` | 源代码控制面板标题 |
| 源代码控制 | `SCMSourceControl` | 源代码控制 |
| 源代码控制内联 | `SCMSourceControlInline` | 内联操作 |
| 历史标题 | `SCMHistoryTitle` | 历史记录标题 |
| 历史项引用上下文 | `SCMHistoryItemRefContext` | 历史项引用 |
| SCM 标题 | `SCMTitle` | SCM 面板标题 |
| 资源分享 | `SCMResourceContextShare` | SCM 分享 |

---

## 九、终端（Terminal）菜单

| 菜单 | MenuId | 主要注册文件 |
|---|---|---|
| 终端实例上下文 | `TerminalInstanceContext` | 终端面板右键 |
| 终端编辑器实例上下文 | `TerminalEditorInstanceContext` | 编辑器区域终端右键 |
| 终端新建下拉 | `TerminalNewDropdownContext` | 终端新建下拉 |
| 终端标签上下文 | `TerminalTabContext` | 终端标签页右键 |
| 终端标签空白区上下文 | `TerminalTabEmptyAreaContext` | 终端标签栏空白区 |
| 终端粘性滚动上下文 | `TerminalStickyScrollContext` | 终端粘性滚动 |

**主要注册文件：**
- `src/vs/workbench/contrib/terminal/browser/terminalActions.ts`
- `src/vs/workbench/contrib/terminal/browser/terminalMenus.ts`
- `src/vs/workbench/contrib/terminal/browser/terminalInstance.ts`
- `src/vs/workbench/contrib/terminal/browser/terminalService.ts`

---

## 十、Notebook 菜单

| 菜单 | MenuId |
|---|---|
| 工具栏 | `NotebookToolbar` |
| 粘性滚动上下文 | `NotebookStickyScrollContext` |
| 单元格标题 | `NotebookCellTitle` |
| 单元格删除 | `NotebookCellDelete` |
| 单元格插入 | `NotebookCellInsert` |
| 单元格之间 | `NotebookCellBetween` |
| 单元格列表顶部 | `NotebookCellListTop` |
| 单元格执行 | `NotebookCellExecute` |
| 单元格执行跳转 | `NotebookCellExecuteGoTo` |
| 单元格执行主操作 | `NotebookCellExecutePrimary` |
| Diff 单元格输入标题 | `NotebookDiffCellInputTitle` |
| Diff 文档元数据 | `NotebookDiffDocumentMetadata` |
| Diff 单元格元数据 | `NotebookDiffCellMetadataTitle` |
| Diff 单元格输出 | `NotebookDiffCellOutputsTitle` |
| 输出工具栏 | `NotebookOutputToolbar` |
| 大纲筛选 | `NotebookOutlineFilter` |
| 大纲操作 | `NotebookOutlineActionMenu` |
| 编辑器布局配置 | `NotebookEditorLayoutConfigure` |
| 内核源 | `NotebookKernelSource` |

**主要注册文件：** `src/vs/workbench/contrib/notebook/browser/controller/coreActions.ts` 等。

---

## 十一、Chat / AI 助手菜单

| 菜单 | MenuId |
|---|---|
| Chat 上下文 | `ChatContext` |
| Chat 代码块 | `ChatCodeBlock` |
| Chat 对比块 | `ChatCompareBlock` |
| Chat 消息标题 | `ChatMessageTitle` |
| Chat 消息底部 | `ChatMessageFooter` |
| Chat 执行 | `ChatExecute` |
| Chat 执行二级 | `ChatExecuteSecondary` |
| Chat 输入框 | `ChatInput` |
| Chat 输入框侧边 | `ChatInputSide` |
| Chat 编辑部件工具栏 | `ChatEditingWidgetToolbar` |
| Chat 编辑编辑器内容 | `ChatEditingEditorContent` |
| Chat 编辑 Hunk | `ChatEditingEditorHunk` |
| Chat 编辑修改文件工具栏 | `ChatEditingWidgetModifiedFilesToolbar` |
| Chat 输入资源附件上下文 | `ChatInputResourceAttachmentContext` |
| Chat 输入符号附件上下文 | `ChatInputSymbolAttachmentContext` |
| Chat 内联资源锚点 | `ChatInlineResourceAnchorContext` |
| Chat 内联符号锚点 | `ChatInlineSymbolAnchorContext` |
| Chat 编辑代码块上下文 | `ChatEditingCodeBlockContext` |
| Chat 命令中心 | `ChatCommandCenter` |
| Chat 附件上下文 | `ChatAttachmentsContext` |

---

## 十二、评论（Comment）菜单

| 菜单 | MenuId |
|---|---|
| 评论编辑器操作 | `CommentEditorActions` |
| 评论线程标题 | `CommentThreadTitle` |
| 评论线程操作 | `CommentThreadActions` |
| 评论线程附加操作 | `CommentThreadAdditionalActions` |
| 评论线程标题上下文 | `CommentThreadTitleContext` |
| 评论线程评论上下文 | `CommentThreadCommentContext` |
| 评论标题 | `CommentTitle` |
| 评论操作 | `CommentActions` |
| 评论视图线程操作 | `CommentsViewThreadActions` |

---

## 十三、其他常用菜单

| 菜单 | MenuId | 说明 |
|---|---|---|
| 命令面板 | `CommandPalette` | `Ctrl+Shift+P` |
| 全局活动 | `GlobalActivity` | 左下角账户同步等 |
| 命令中心 | `CommandCenter` / `CommandCenterCenter` | 标题栏命令中心 |
| 状态栏窗口指示器 | `StatusBarWindowIndicatorMenu` | 状态栏窗口 |
| 状态栏远程指示器 | `StatusBarRemoteIndicatorMenu` | 状态栏远程连接 |
| 标题栏上下文 | `TitleBarContext` / `TitleBarTitleContext` | 标题栏右键 |
| 账户上下文 | `AccountsContext` | 账户头像右键 |
| 扩展上下文 | `ExtensionContext` | 扩展列表右键 |
| 扩展编辑器上下文 | `ExtensionEditorContextMenu` | 扩展详情页右键 |
| 搜索上下文 | `SearchContext` | 搜索面板右键 |
| 搜索操作菜单 | `SearchActionMenu` | 搜索操作 |
| 测试项 | `TestItem` / `TestItemGutter` | 测试视图 |
| 测试配置文件 | `TestProfilesContext` | 测试配置 |
| 测试消息 | `TestMessageContext` / `TestMessageContent` | 测试消息 |
| 测试 Peek | `TestPeekElement` / `TestPeekTitle` / `TestCallStack` | 测试 Peek |
| 合并编辑器工具栏 | `MergeInput1Toolbar` / `MergeInput2Toolbar` / `MergeBaseToolbar` / `MergeInputResultToolbar` | 合并编辑器 |
| 内联补全工具栏 | `InlineCompletionsActions` / `InlineSuggestionToolbar` | 内联补全 |
| 内联编辑工具栏 | `InlineEditsActions` / `InlineEditToolbar` | 内联编辑 |
| 隧道相关 | `TunnelContext` / `TunnelPrivacy` / `TunnelProtocol` / `TunnelPortInline` / `TunnelTitle` / `TunnelLocalAddressInline` / `TunnelOriginInline` / `TunnelInline` | 端口转发 |
| 批量编辑 | `BulkEditTitle` / `BulkEditContext` | 批量编辑 |
| 交互式窗口 | `InteractiveToolbar` / `InteractiveCellTitle` / `InteractiveCellDelete` / `InteractiveCellExecute` / `InteractiveInputExecute` / `InteractiveInputConfig` / `ReplInputExecute` | 交互式窗口 |
| 无障碍视图 | `AccessibleView` | 无障碍视图 |
| 多 Diff 编辑器 | `MultiDiffEditorFileToolbar` | 多文件 Diff |
| Diff 编辑器 Hunk | `DiffEditorHunkToolbar` / `DiffEditorSelectionToolbar` | Diff 编辑器 |
| Webview 上下文 | `WebviewContext` | Webview 右键 |
| 新建文件 | `NewFile` | 新建文件 |
| 问题报告 | `IssueReporter` | 问题报告 |
| Touch Bar | `TouchBarContext` | macOS Touch Bar |
| 粘性滚动 | `StickyScrollContext` | 粘性滚动右键 |

---

## 十四、快速定位菜单注册位置的技巧

在源码中搜索：

```powershell
# 查看某个 MenuId 在哪里被注册
rg "MenuRegistry.appendMenuItem\(MenuId\.EditorContext" src/

# 查看 registerAction2 里使用的菜单
rg "MenuId\.EditorContext" src/
```

或者在 VS Code 里按 `Ctrl+Shift+F` 搜索：

```text
MenuId.MenubarViewMenu
MenuId.EditorContext
MenuId.ExplorerContext
```

---

## 总结

- 所有菜单 ID 在 `src/vs/platform/actions/common/actions.ts` 定义。
- 主菜单栏结构在 `src/vs/workbench/browser/parts/titlebar/menubarControl.ts` 组装。
- 各菜单项主要通过 `MenuRegistry.appendMenuItem(MenuId.XXX, ...)` 或 `registerAction2(...)` 的 `menu` 属性注册。
- 视图相关菜单项大多由各功能模块的 `*.contribution.ts` 文件注册。
