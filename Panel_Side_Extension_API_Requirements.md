# 第三方扩展指定视图落在左侧 / 右侧 Panel 区 — 可行方案

> **目标**：让一个第三方插件（独立的 `.vsix` / 扩展工程）安装到「二次开发的 VS Code」后，
> 能够声明式地指定「我的视图容器显示在左侧 Panel 还是右侧 Panel」。
> **前提**：当前 `bugfix/view-drag` 分支已具备双栏 Panel（`PanelSide = 'left' | 'right'`），
> 但 `side` 目前是内部状态，第三方扩展无法触及。
> **日期**：2026-08-14

---

## 一、现状与约束（为什么标准扩展做不到）

通过核查源码确认：

1. **`PanelSide` 是纯内部类型**
   - 定义于 `src/vs/workbench/browser/parts/panel/panelSidePart.ts:39`
     ```ts
     export type PanelSide = 'left' | 'right';
     ```
   - 仅被 `panelPart.ts` / `panelSidePart.ts` / `dnd.ts` 这些 workbench 内部模块使用。
   - 扩展 API（`src/vs/workbench/api/common/*`）中**无任何引用**。

2. **`moveViewToLocation` / `movePaneCompositeToSide` 未暴露给扩展**
   - 在 `api/common` 下零匹配（`moveViewToLocation` 只出现在
     `src/vs/workbench/browser/parts/views/viewPaneContainer.ts` 内部拖拽逻辑）。
   - 扩展只能拿到 `ViewContainerLocation.Panel`（`src/vs/workbench/common/views.ts:41`），
     这是一个**粗粒度位置**，没有 `side` 维度。

3. **扩展贡献点无 `side` 字段**
   - 现有 `viewsContainers` / `views` 扩展点只描述「放到 Panel」，不含落左还是落右。

**结论**：纯第三方扩展装到官方或其他未改造的 VS Code，**无法**指定左/右；
最多只能说「放到 Panel 区」，最终落在哪个 side 由二开版内部决定。
要让扩展能指定，必须由「二开版 VS Code」主动开放一个契约。

---

## 二、可行方案总览

| 方案 | 扩展侧写法 | 二开版改动 | 兼容性 | 推荐度 |
|------|-----------|-----------|--------|--------|
| **A. 新增命令** | `vscode.commands.executeCommand('workbench.panel.moveContainerToSide', id, 'right')` | 注册一条内部命令，调用 `PanelPart.movePaneCompositeToSide` | 官方 VS Code 执行会报「命令不存在」 | ⭐⭐ |
| **B. 扩展点加 `side` 字段（声明式）** | `package.json` 里 `viewsContainers.panel[].side = 'right'` | 解析 `side` 字段，restore 时按 side 打开 | 官方 VS Code 静默忽略 `side`，退化为「放 Panel」 | ⭐⭐⭐⭐（推荐） |
| **C. Proposed API 暴露 `moveViewToSide`** | `vscode.moveViewToSide(id, 'right')`（`enableProposedApi`） | 在 `IViewDescriptorService` 加方法并暴露 | 仅本二开版支持，需 `enableProposedApi` | ⭐⭐⭐ |

> 三者**可并存**。但最贴近 VS Code 扩展模型、扩展作者成本最低的是 **方案 B**。

---

## 三、推荐方案：B（扩展点加 `side` 字段）

### 3.1 扩展作者的使用方式（纯声明，零代码）

```jsonc
// 第三方扩展的 package.json
{
  "contributes": {
    "viewsContainers": {
      "panel": [
        { "id": "myExt.output",  "title": "我的输出", "icon": "$(output)", "side": "left" },
        { "id": "myExt.metrics", "title": "我的指标", "icon": "$(pulse)", "side": "right" }
      ]
    },
    "views": {
      "myExt.output":  [{ "id": "myExt.outputView",  "name": "输出" }],
      "myExt.metrics": [{ "id": "myExt.metricsView", "name": "指标" }]
    }
  }
}
```

- `side` 取值：`'left' | 'right'`（缺省或未写 → 按现有默认逻辑，落在 left）。
- 安装到**本二开版** → 按 `side` 精确落位；安装到**官方 VS Code** → `side` 被忽略，视图仍进 Panel（单栏），不报错。

### 3.2 二开版需要改的代码

#### 改动 1：扩展点 schema 允许 `side`

文件：`src/vs/workbench/common/extensionPointSchemaV1.ts`（或 views 贡献点对应 schema 位置）

```ts
// viewsContainers.panel 数组元素的 schema 增加：
side: {
    type: 'string',
    enum: ['left', 'right'],
    description: '指定该视图容器落在 Panel 的左侧还是右侧分区（仅本发行版支持）。'
}
```

#### 改动 2：容器描述符携带 `side`

- 在 `IViewContainer` 或注册时传入的 options 里加可选字段 `side?: PanelSide`。
- 扩展注册入口（`extHostViews.ts` 把扩展点转为内部 `ViewContainer` 处）读取 `side` 并写入。

#### 改动 3：PanelPart 按 `side` 创建 / restore

文件：`src/vs/workbench/browser/parts/panel/panelPart.ts`

现状（create 末尾，第 578–612 行附近）：

```ts
const leftLastActive  = storage.get(activePanelSettingsKeyFor('left'),  ...);
const rightLastActive = storage.get(activePanelSettingsKeyFor('right'), ...);
const leftRestoreId  = leftLastActive  || getRestoreContainerId('left')  || undefined;
this.leftPart.restore(leftRestoreId).then(() => {
    const rightRestoreId = rightLastActive || undefined;   // 目前 right 无默认
    if (rightRestoreId) { this.addRightToSplit(); }
    return this.rightPart.restore(rightRestoreId);
});
```

改为：在创建容器时，把声明了 `side: 'right'` 的容器视为 right 的「默认候选」：

```ts
// 新增辅助：从扩展声明的 side 推导默认 restore id
private getDeclaredSideRestoreId(side: PanelSide): string | undefined {
    const declared = this.panelViewDescriptorService
        .getViewContainersByLocation(ViewContainerLocation.Panel)
        .find(c => (c as any).side === side
            && this.panelViewDescriptorService.getViewContainerModel(c).activeViewDescriptors.length > 0);
    return declared?.id;
}

// create() 末尾 restore 段：
const leftRestoreId  = leftLastActive  || getDeclaredSideRestoreId('left')  || getRestoreContainerId('left')  || undefined;
this.leftPart.restore(leftRestoreId).then(() => {
    const rightRestoreId = rightLastActive || getDeclaredSideRestoreId('right') || undefined;
    if (rightRestoreId) { this.addRightToSplit(); }
    return this.rightPart.restore(rightRestoreId);
});
```

> 注意：声明式 `side` 与「互斥不变量」（`enforceViewUniquenessAfterRestore`）天然兼容——
> 若左右声明的两个容器共享同一 view，恢复后右侧会被自动释放，行为与现在一致，不会出双显 bug。

#### 改动 4（可选）：拖入时尊重声明

若扩展希望「即便被拖到另一侧，下次启动仍回到声明的 side」，可在 `saveDualPanelLayout`
里把 `activeContainerBySide` 持久化，restore 时优先用已存 side（现状已按 `*.left.activepanelid`
/`*.right.activepanelid` 分别存，所以这一条其实**已经满足**，无需额外改）。

### 3.3 工作量

| 子项 | 估时 |
|------|------|
| 扩展点 schema 加 `side` | 0.5 天 |
| 描述符携带 + 注册入口读取 | 0.5 天 |
| `panelPart.ts` restore 按 side 打开 | 0.5 天 |
| 互斥 / 持久化验证 + 自测 | 0.5 天 |
| **合计** | **约 2 天** |

---

## 四、备选方案：A（新增命令，扩展侧主动调用）

适合「扩展想在**运行时**动态改变 side」的场景（而非仅声明式）。

### 4.1 二开版注册命令

文件：`src/vs/workbench/browser/parts/panel/panelPart.ts`（或 `layoutActions.ts`）

```ts
// 在 PanelPart 或 WorkbenchActions 里注册：
CommandsRegistry.registerCommand('workbench.panel.moveContainerToSide',
    (accessor, id: string, side: 'left' | 'right') => {
        const panelPart = accessor.get(IViewDescriptorService); // 拿到 PanelPart 实例
        // 简化：直接复用跨 side 移动
        panelPart.movePaneCompositeToSide(id, side);
    });
```

### 4.2 扩展侧调用

```ts
import * as vscode from 'vscode';
export function activate(ctx: vscode.ExtensionContext) {
    vscode.commands.executeCommand('workbench.panel.moveContainerToSide', 'myExt.metrics', 'right');
}
```

- 缺点：装到官方 VS Code 会报命令不存在；且需扩展写代码，体验不如 B 声明式。
- 可与 B 并存：B 负责「默认落位」，A 负责「运行时改位」。

---

## 五、备选方案：C（Proposed API 暴露 `moveViewToSide`）

适合需要**最强动态能力**且愿意维护 proposed API 的场景。

1. 在 `IViewDescriptorService` 加：
   ```ts
   moveViewToSide(viewId: string, side: PanelSide): void;
   ```
2. 在 `extHostViews.ts` 暴露为 `vscode.moveViewToSide(...)`，扩展 `package.json` 加
   `"enableProposedApi": true` 与本发行版对应的 proposal 名。
3. 实现里转调 `PanelPart.movePaneCompositeToSide` / `openPaneComposite(side)`。

- 维护成本最高（proposal 签名变动需同步扩展），一般不推荐除非确有运行时强需求。

---

## 六、决策建议

- **只想要「安装即落位」**：用 **方案 B**，扩展作者零代码，最稳。
- **想要「扩展运行时把视图推到某侧」**：B + A 组合。
- **想要编程式细粒度控制（含非 Panel 视图）**：C。

对于「第三方插件安装到二次开发 vscode 并指定左右 Panel」这一需求，**方案 B 是首选**：
它既是 VS Code 既有扩展点模型的延伸（声明式、无命令、无 proposed API），又对官方 VS Code
保持向后兼容（忽略未知字段），是工作量与体验的最佳平衡点。

---

## 七、风险提示

1. **互斥兜底**：若扩展把共享同一 view 的两个容器分别声明到 left / right，恢复后右侧会被
   `enforceViewUniquenessAfterRestore` 释放——这是预期行为，避免双显，但扩展作者需知晓。
2. **跨发行版兼容**：`side` 字段仅本二开版识别，发布到 Marketplace 给其他官方 VS Code 用户时
   会退化为「仅进 Panel 单栏」。建议在扩展 README 注明「需基于本发行版」。
3. **持久化优先级**：用户手动拖拽后存储的 `*.left/right.activepanelid` 优先级高于声明式 `side`
   （`leftLastActive || getDeclaredSideRestoreId`），符合「用户操作覆盖默认」直觉。
