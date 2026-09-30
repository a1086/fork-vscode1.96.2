# Patch Index (full-file snapshot)
Base: fabdb6a30b4 -> HEAD
Total commits: 99

## 1 - feat: 活动栏常驻 Run and Debug 图标，Debug 视图默认移至 Auxiliary Bar，活动栏默认位置改 top
## 2 - feat: 编辑器区显隐切换与空组关闭优化，Ctrl+K W 关闭后隐藏编辑器区，去除 X 按钮背景
## 3 - feat: 视图标题栏移除折叠箭头改悬停关闭；Explorer Folders / Problems 支持可隐藏开关
## 4 - feat: 分组标题配色调整；主要 Part 间增加 6px 背景间隙
## 5 - feat: 支持将视图（OUTLINE/PROBLEMS/PORTS）拖入编辑器区作为 editor tab（P0 原型）
## 6 - chore: 扩展市场指向 Open VSX；.npmrc 增加注释镜像配置
## 7 - feat: 视图拖入编辑器区交互与样式细化（panelPart/part.css），补充菜单参考/需求拆解/源码分析等文档
## 8 - feat: 视图拖入编辑器区交互与样式细化（panelPart/part.css），补充菜单参考/需求拆解/源码分析等文档
## 9 - 调整工作台主要部件间距和面板边框样式 - 优化编辑器、侧边栏、辅助栏等主要部件之间的视觉间距 - 调整面板顶部边框宽度以改善视觉效果
## 10 - feat: 实现从panel bar/ aux bar/ activity bar的view 拖拽到edit code 区域，但是存在拖进去样式错位，不能再从edit code区域拖拽出来，在edit code 区域关闭view之后，view又出现了拖拽之前的位置
## 11 - fix: 修复 从 aux bar/panel bar/activity bar 拖拽到edit 区域的view，切换view的时候，上一个view的DOM没有完全销毁掉，导致切换过的内容会同时出现在一个view里面
## 12 - fix: view-in-editor 拖入编辑器区显示 UNDEFINED 标题
## 13 - docs: 追加 view-in-editor UNDEFINED 修复总结并更新 getName 兜底逻辑
## 14 - feat: add 6px visible divider between editor groups
## 15 - fix: 拖空 Panel 后自动隐藏（参考 Auxiliary Bar 机制）
## 16 - fix: 视图拖拽到编辑器边缘时展开折叠的 Panel/辅助栏，并补充改动总结
## 17 - fix: 点击 Activity Bar 的 Debug 图标时展开 Auxiliary Bar
## 18 - fix: 修复编辑器区 X 按钮（Toggle Editor Area Visibility）在多 group 时误关所有 group
## 19 - fix: 编辑器分组拖拽只影响相邻组，禁用 Grid 比例布局
## 20 - fix: Toggle Panel 打开时恢复默认高度，不继承上次 maxSize
## 21 - fix: 编辑器分组拖拽只影响相邻组，修复 SplitView.resize 核心算法
## 22 - feat: Part 间距及 Panel 顶部分割线调整为 4px
## 23 - fix(terminal): 修复终端视图拖入 Editor 区域后渲染/焦点异常
## 24 - fix: focus existing editor tab when opening an editor-hosted view via menu
## 25 - fix: 拖空 Panel 后自动隐藏面板（补充同步隐藏路径 + 改动总结文档）
## 26 - fix: 隐藏拖入编辑器区的视图 header 标题文字，保留操作按钮
## 27 - fix: 拖空 Panel 后自动隐藏面板（加固延迟双检查）+ Panel 默认高度调整为 1/2
## 28 - docs: 追加 Panel 自动隐藏加固与 Panel 默认高度调整到改动总结
## 29 - fix: 通过 View 打开的 Panel 高度过低（强制恢复首选高度 40%）
## 30 - fix: Panel 视图关闭按钮支持关闭 View 菜单打开的未 pinned 视图内容
## 31 - docs: 在改动总结.md 追加第19章 Panel 关闭按钮修复说明
## 32 - fix: 通过 View 菜单打开 Panel 时恢复合理高度(~40%) 且保持可拖拽收缩
## 33 - feat(panel): Panel 视图 tab 关闭按钮默认隐藏，悬停/聚焦/激活时显示
## 34 - fix: 修复 Ports 等带 staticArguments 的视图拖入编辑器区报错
## 35 - fix: add close button to Secondary Side Bar header and defer Output view load
## 36 - fix: 修复编辑器多group布局恢复错乱并解耦拖拽只影响所在列
## 37 - chore: rebrand product to AccoTest
## 38 - feat(workbench): support dual-side (split) panel layout
## 39 - docs: update Changes_Summary with rebrand and dual-side panel
## 40 - feat: 新增 panel和aux 区域的视图能够拖拽脱离编辑器，并修复Panel分区的bug，主要修复了 没有视图的时候Panel应该隐藏，初始化打开编辑器的时候，展示单个Panel，单个Panel只展示Terminal和DEBUG CONSOLE两个视图，多次点击Toggle Panel的时候，能够记住上一次Panel的状态
## 41 - style: 调整 edit view 的间距，从border换成margin
## 42 - style: 各区域分隔改用 margin 间隙，并修复 hygiene 检查问题
## 43 - feat: 更新 总结文档
## 44 - chore: 删除视图拖拽相关调试日志打印
## 45 - fix: 修正视图拖出独立窗口后的归位与重启恢复逻辑区分视图从 Panel/Aux 直接拖出窗口与先从 Editor 拖出窗口两条路径， 关闭辅助窗口时分别归位回原栏或保留在 Editor 区，避免视图消失或残留副本，- 移除序列化反序列化时错误的 moveViewToLocation 调用，修复刷新编辑器后，抛出 No view container found for view id的问题，修正 Panel 空态（两侧均无视图时自动隐藏）再次展开时错误地拉起某个视图，改为展示空拖放占位区对齐 editorTabsControl 的开窗判定，消除栏内跨侧拖拽产生重复视图的问题， 修正 compositeBar 拖出窗口的复合视图（如 Debug）解析与开窗顺序
## 46 - style: 调整 视图在editor 和aux以及 left side bar中的样式，优化显示的位置以及选中的样式
## 47 - fix: 修复paenl 视图为空的时候，应该隐藏的bug
## 48 - fix: 修正视图拖出窗口/拖拽归位与 Panel 空态的多处问题
## 49 - feat: 新增8600菜单，调整Panel左右分区的分割线包裹在了滚动条里面
## 50 - doc: 更新总结文档
## 51 - fix: 8600子菜单通过commandService执行命令
## 52 - doc: 更新总结文档
## 53 - fix: remember last Panel hidden/shown state across reload
## 54 - fix: 空编辑器组水印在隐藏 Panel/SideBar 时垂直水平居中
## 55 - fix: 把菜单 8600 的位置从 最后移动到 view之后
## 56 - doc: 更新总结文档
## 57 - doc: 更新总结文档
## 58 - feat: 实现双Panel的最大化/恢复的功能
## 59 - fix: 修复terminal视图拖拽出来独立的窗口，关闭窗口之后，功能不可用状态
## 60 - fix: 调整 aux bar，debug功能下的视图，可以拖拽到和debug图标水平一排显示
## 61 - fix: 编辑器区承载视图改为缓存复用并保留 webview 上下文
## 62 - docs: 更新 Changes_Summary.md 本周提交总结（双Panel按侧最大化/终端拖窗/aux bar/视图缓存）
## 63 - fix(view-drag): 重启后编辑器承载视图归位 + Panel 空侧自动回退
## 64 - docs: 追加第 59 节改动总结（重启后视图归位 + Panel 空侧回退）
## 65 - fix: 修复视图拖出归位、残留覆盖层与无分隔线 sash 问题
## 66 - doc: 更新总结文档（§55 视图拖出归位/残留覆盖层/无分隔线 sash 修复）
## 67 - fix: 修复 从panel中直接拖拽出来的时候，功能显示有问题
## 68 - fix: 放行指定自定义插件(AccoTEST.ate-tool-ext)的Panel视图容器
## 69 - fix(view-drag): 修复编辑器承载视图的布局/渲染与生命周期并清理调试日志
## 70 - fix(view-drag): 视图拖拽不重载 webview 内容（handoff 复用）+ 减轻首次拖入编辑器闪烁 + 清理调试日志
## 71 - fix: 为 Panel 自定义视图白名单增加容器 id 前缀双保险
## 72 - Merge branch 'bugfix/view-drag' of https://github.com/a1086/fork-vscode1.96.2 into bugfix/view-drag
## 73 - fix: 修复自定义插件Panel视图tab永不显示的根因（注册即unpin）
## 74 - chore: 提交分支上遗留的未跟踪文件 viewPaneTransfer.ts
## 75 - fix: 视图拖拽健壮性修复 — 终端 resize 崩溃防护、webview 重定位布局、辅助栏默认显示
## 76 - doc: 更新文档
## 77 - fix(view-drag): 修复视图拖出新窗口的布局时机（等待样式与窗口尺寸稳定后再布局）
## 78 - doc: 更新文档
## 79 - fix: 辅助侧边栏(Aux Bar)启动时默认显示运行和调试视图
## 80 - fix(view-drag): 关闭时清理拖入 Panel 的自定义视图位置（保留终端与 REPL）
## 81 - doc: 更新文档
## 82 - feat: 插件布局键为 Setup/Debug 时隐藏 Panel 最大化/恢复按钮
## 83 - fix: 视图编辑器承载视图在辅助窗口的布局收敛，并清理需求文档
## 84 - fix(view-drag): move debug panel to side on session start and add layout menu presets
## 85 - doc: 改动列表按模块归类重排 (Changes_List.md) 并补充汇总 (Changes_Summary.md §69)
## 86 - fix(view-drag): 启用 Panel 侧边溢出并修复编辑器承载终端样式与侧最大化上下文
## 87 - workbench: remove debug logs and panel-size repair; make hygiene pass
## 88 - workbench: 提交面板/编辑器/视图拖拽改动，并修复 hygiene 使其通过
## 89 - docs: 更新改动总结文档并重排章节编号
## 90 - chore: add patch batch tooling and workflow docs
## 91 - workbench: 启动恢复面板时处理 panel.lastHidden===false 并移除调试日志
## 92 - docs: 更新改动总结文档（新增 §58 面板启动恢复与调试日志清理）
## 93 - chore: 提交当前分支 patches/ 全量导出（91 个提交，基于 fabdb6a30b4）
## 94 - workflow: 修复补丁生成/应用脚本（字节安全三方合并、_base 存父提交、日志重定向）
## 95 - feat(workbench): 新增 ModulePart 并调整布局/主题/调试工具栏
## 96 - chore(patches): 重新导出全量补丁快照（含 _base merge base 与 092/093）
## 97 - docs: 更新 Changes_Summary.md 改动总结（新增 §59，汇总本次 4 个提交）
## 98 - feat(theme): Accotest theme 归入独立分组并设为默认深色主题
## 99 - docs: Changes_Summary.md 追加 §60 Accotest 主题分组与默认主题
