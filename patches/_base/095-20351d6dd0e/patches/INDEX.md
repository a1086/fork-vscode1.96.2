# Commit Export Index

Base: fabdb6a30b4  ->  HEAD
Total commits: 91

## 001-041a368987b
- Subject: feat: 活动栏常驻 Run and Debug 图标，Debug 视图默认移至 Auxiliary Bar，活动栏默认位置改 top

## 002-fac5fe8f18a
- Subject: feat: 编辑器区显隐切换与空组关闭优化，Ctrl+K W 关闭后隐藏编辑器区，去除 X 按钮背景

## 003-5191ea8de9a
- Subject: feat: 视图标题栏移除折叠箭头改悬停关闭；Explorer Folders / Problems 支持可隐藏开关

## 004-5c041be078f
- Subject: feat: 分组标题配色调整；主要 Part 间增加 6px 背景间隙

## 005-24014a8bf22
- Subject: feat: 支持将视图（OUTLINE/PROBLEMS/PORTS）拖入编辑器区作为 editor tab（P0 原型）

## 006-fa4cdb42e5d
- Subject: chore: 扩展市场指向 Open VSX；.npmrc 增加注释镜像配置

## 007-c6f6babc3af
- Subject: feat: 视图拖入编辑器区交互与样式细化（panelPart/part.css），补充菜单参考/需求拆解/源码分析等文档

## 008-b1833679d30
- Subject: feat: 视图拖入编辑器区交互与样式细化（panelPart/part.css），补充菜单参考/需求拆解/源码分析等文档

## 009-4de4d8af389
- Subject: 调整工作台主要部件间距和面板边框样式 - 优化编辑器、侧边栏、辅助栏等主要部件之间的视觉间距 - 调整面板顶部边框宽度以改善视觉效果

## 010-80f314f0575
- Subject: feat: 实现从panel bar/ aux bar/ activity bar的view 拖拽到edit code 区域，但是存在拖进去样式错位，不能再从edit code区域拖拽出来，在edit code 区域关闭view之后，view又出现了拖拽之前的位置

## 011-d83d27ceee4
- Subject: fix: 修复 从 aux bar/panel bar/activity bar 拖拽到edit 区域的view，切换view的时候，上一个view的DOM没有完全销毁掉，导致切换过的内容会同时出现在一个view里面

## 012-a8196adeaca
- Subject: fix: view-in-editor 拖入编辑器区显示 UNDEFINED 标题

## 013-77760554e39
- Subject: docs: 追加 view-in-editor UNDEFINED 修复总结并更新 getName 兜底逻辑

## 014-c2139706611
- Subject: feat: add 6px visible divider between editor groups

## 015-6281f1f30fc
- Subject: fix: 拖空 Panel 后自动隐藏（参考 Auxiliary Bar 机制）

## 016-4bcb1904756
- Subject: fix: 视图拖拽到编辑器边缘时展开折叠的 Panel/辅助栏，并补充改动总结

## 017-d1f97b86385
- Subject: fix: 点击 Activity Bar 的 Debug 图标时展开 Auxiliary Bar

## 018-06b3b02d4d1
- Subject: fix: 修复编辑器区 X 按钮（Toggle Editor Area Visibility）在多 group 时误关所有 group

## 019-4319db526b8
- Subject: fix: 编辑器分组拖拽只影响相邻组，禁用 Grid 比例布局

## 020-d8f4feebf18
- Subject: fix: Toggle Panel 打开时恢复默认高度，不继承上次 maxSize

## 021-bde2f79dcfc
- Subject: fix: 编辑器分组拖拽只影响相邻组，修复 SplitView.resize 核心算法

## 022-c81330056ea
- Subject: feat: Part 间距及 Panel 顶部分割线调整为 4px

## 023-5f901652246
- Subject: fix(terminal): 修复终端视图拖入 Editor 区域后渲染/焦点异常

## 024-88e9bc41811
- Subject: fix: focus existing editor tab when opening an editor-hosted view via menu

## 025-3b942121989
- Subject: fix: 拖空 Panel 后自动隐藏面板（补充同步隐藏路径 + 改动总结文档）

## 026-c1325731171
- Subject: fix: 隐藏拖入编辑器区的视图 header 标题文字，保留操作按钮

## 027-f80478d4f82
- Subject: fix: 拖空 Panel 后自动隐藏面板（加固延迟双检查）+ Panel 默认高度调整为 1/2

## 028-4c07bc2cd47
- Subject: docs: 追加 Panel 自动隐藏加固与 Panel 默认高度调整到改动总结

## 029-407756fe579
- Subject: fix: 通过 View 打开的 Panel 高度过低（强制恢复首选高度 40%）

## 030-57fb34d8a7b
- Subject: fix: Panel 视图关闭按钮支持关闭 View 菜单打开的未 pinned 视图内容

## 031-58f444e3c6f
- Subject: docs: 在改动总结.md 追加第19章 Panel 关闭按钮修复说明

## 032-5d190a7fd87
- Subject: fix: 通过 View 菜单打开 Panel 时恢复合理高度(~40%) 且保持可拖拽收缩

## 033-96d0539792f
- Subject: feat(panel): Panel 视图 tab 关闭按钮默认隐藏，悬停/聚焦/激活时显示

## 034-f1a12a8aea9
- Subject: fix: 修复 Ports 等带 staticArguments 的视图拖入编辑器区报错

## 035-6e32daa2b30
- Subject: fix: add close button to Secondary Side Bar header and defer Output view load

## 036-d375c281bd5
- Subject: fix: 修复编辑器多group布局恢复错乱并解耦拖拽只影响所在列

## 037-dbfff790b83
- Subject: chore: rebrand product to AccoTest

## 038-1be72123205
- Subject: feat(workbench): support dual-side (split) panel layout

## 039-c69d5e1209f
- Subject: docs: update Changes_Summary with rebrand and dual-side panel

## 040-4d45e42af65
- Subject: feat: 新增 panel和aux 区域的视图能够拖拽脱离编辑器，并修复Panel分区的bug，主要修复了 没有视图的时候Panel应该隐藏，初始化打开编辑器的时候，展示单个Panel，单个Panel只展示Terminal和DEBUG CONSOLE两个视图，多次点击Toggle Panel的时候，能够记住上一次Panel的状态

## 041-6f2ad989dd9
- Subject: style: 调整 edit view 的间距，从border换成margin

## 042-f1dde1416d8
- Subject: style: 各区域分隔改用 margin 间隙，并修复 hygiene 检查问题

## 043-e02fbad9a25
- Subject: feat: 更新 总结文档

## 044-548528e777f
- Subject: chore: 删除视图拖拽相关调试日志打印

## 045-bc9a2ce98f0
- Subject: fix: 修正视图拖出独立窗口后的归位与重启恢复逻辑区分视图从 Panel/Aux 直接拖出窗口与先从 Editor 拖出窗口两条路径， 关闭辅助窗口时分别归位回原栏或保留在 Editor 区，避免视图消失或残留副本，- 移除序列化反序列化时错误的 moveViewToLocation 调用，修复刷新编辑器后，抛出 No view container found for view id的问题，修正 Panel 空态（两侧均无视图时自动隐藏）再次展开时错误地拉起某个视图，改为展示空拖放占位区对齐 editorTabsControl 的开窗判定，消除栏内跨侧拖拽产生重复视图的问题， 修正 compositeBar 拖出窗口的复合视图（如 Debug）解析与开窗顺序

## 046-f24b6ac2688
- Subject: style: 调整 视图在editor 和aux以及 left side bar中的样式，优化显示的位置以及选中的样式

## 047-eefde95def6
- Subject: fix: 修复paenl 视图为空的时候，应该隐藏的bug

## 048-2d2aabdf40d
- Subject: fix: 修正视图拖出窗口/拖拽归位与 Panel 空态的多处问题

## 049-814d76b8687
- Subject: feat: 新增8600菜单，调整Panel左右分区的分割线包裹在了滚动条里面

## 050-789b1a7d918
- Subject: doc: 更新总结文档

## 051-5a9c63e5490
- Subject: fix: 8600子菜单通过commandService执行命令

## 052-dc3784b26e4
- Subject: doc: 更新总结文档

## 053-332e6f6e2fe
- Subject: fix: remember last Panel hidden/shown state across reload

## 054-813b75b2642
- Subject: fix: 空编辑器组水印在隐藏 Panel/SideBar 时垂直水平居中

## 055-acc4d63ea7d
- Subject: fix: 把菜单 8600 的位置从 最后移动到 view之后

## 056-16990aeb316
- Subject: doc: 更新总结文档

## 057-9dbd11d2673
- Subject: doc: 更新总结文档

## 058-5dcea717833
- Subject: feat: 实现双Panel的最大化/恢复的功能

## 059-6ade9ea218c
- Subject: fix: 修复terminal视图拖拽出来独立的窗口，关闭窗口之后，功能不可用状态

## 060-0594f360245
- Subject: fix: 调整 aux bar，debug功能下的视图，可以拖拽到和debug图标水平一排显示

## 061-ed6aee9881f
- Subject: fix: 编辑器区承载视图改为缓存复用并保留 webview 上下文

## 062-0e10b56f645
- Subject: docs: 更新 Changes_Summary.md 本周提交总结（双Panel按侧最大化/终端拖窗/aux bar/视图缓存）

## 063-691b93a4b68
- Subject: fix(view-drag): 重启后编辑器承载视图归位 + Panel 空侧自动回退

## 064-4f5d8629027
- Subject: docs: 追加第 59 节改动总结（重启后视图归位 + Panel 空侧回退）

## 065-94ccabc88b2
- Subject: fix: 修复视图拖出归位、残留覆盖层与无分隔线 sash 问题

## 066-69ace8765a3
- Subject: doc: 更新总结文档（§55 视图拖出归位/残留覆盖层/无分隔线 sash 修复）

## 067-848ecfc98a7
- Subject: fix: 修复 从panel中直接拖拽出来的时候，功能显示有问题

## 068-4c29b02aaf4
- Subject: fix: 放行指定自定义插件(AccoTEST.ate-tool-ext)的Panel视图容器

## 069-8aca5836774
- Subject: fix(view-drag): 修复编辑器承载视图的布局/渲染与生命周期并清理调试日志

## 070-a3920251a2f
- Subject: fix(view-drag): 视图拖拽不重载 webview 内容（handoff 复用）+ 减轻首次拖入编辑器闪烁 + 清理调试日志

## 071-9361994ffd6
- Subject: fix: 为 Panel 自定义视图白名单增加容器 id 前缀双保险

## 072-7a8f4ac8d4a
- Subject: Merge branch 'bugfix/view-drag' of https://github.com/a1086/fork-vscode1.96.2 into bugfix/view-drag

## 073-2dad2bc7b54
- Subject: fix: 修复自定义插件Panel视图tab永不显示的根因（注册即unpin）

## 074-97933cc5635
- Subject: chore: 提交分支上遗留的未跟踪文件 viewPaneTransfer.ts

## 075-9d39345c45c
- Subject: fix: 视图拖拽健壮性修复 — 终端 resize 崩溃防护、webview 重定位布局、辅助栏默认显示

## 076-af1b6b1cac2
- Subject: doc: 更新文档

## 077-5aee21180ec
- Subject: fix(view-drag): 修复视图拖出新窗口的布局时机（等待样式与窗口尺寸稳定后再布局）

## 078-e829a21372a
- Subject: doc: 更新文档

## 079-60327df4969
- Subject: fix: 辅助侧边栏(Aux Bar)启动时默认显示运行和调试视图

## 080-2562484e031
- Subject: fix(view-drag): 关闭时清理拖入 Panel 的自定义视图位置（保留终端与 REPL）

## 081-a10fab8c226
- Subject: doc: 更新文档

## 082-3242dfb44a6
- Subject: feat: 插件布局键为 Setup/Debug 时隐藏 Panel 最大化/恢复按钮

## 083-2f6e07b9063
- Subject: fix: 视图编辑器承载视图在辅助窗口的布局收敛，并清理需求文档

## 084-d2142a849eb
- Subject: fix(view-drag): move debug panel to side on session start and add layout menu presets

## 085-ab6d0bb4b81
- Subject: doc: 改动列表按模块归类重排 (Changes_List.md) 并补充汇总 (Changes_Summary.md §69)

## 086-173937a4348
- Subject: fix(view-drag): 启用 Panel 侧边溢出并修复编辑器承载终端样式与侧最大化上下文

## 087-8316537760a
- Subject: workbench: remove debug logs and panel-size repair; make hygiene pass

## 088-049356ebbb3
- Subject: workbench: 提交面板/编辑器/视图拖拽改动，并修复 hygiene 使其通过

## 089-b830316691b
- Subject: docs: 更新改动总结文档并重排章节编号

## 090-bda428790a9
- Subject: chore: add patch batch tooling and workflow docs

## 091-624b1e59497
- Subject: workbench: 启动恢复面板时处理 panel.lastHidden===false 并移除调试日志

