# Panel 三栏分区（left / center / right）需求拆解、估时与风险

> **目标**：在现有"双栏分区（left / right）"基础上，把 Panel 扩展为**水平方向三个分区**（left / center / right），用户可把视图拖到任意一栏，三栏之间支持独立的视图容器与拖拽分屏。
> **继承**：本方案直接复用 `bugfix/view-drag` 分支已完成的双栏实现（`PanelPart` + `PanelSidePart`）。
> **日期**：2026-08-14

---

## 一、总体结论

- **布局方向**：水平（左右）三栏，非上下。
- **难度评估**：中等偏上。**约 13.5–18 人天**。
- **核心难点**（相对双栏新增）：① 三向视图互斥（一次打开可能要与两栏冲突）；② 三分几何的拖拽分屏预览（两个切割边界）。
- **架构前提**：当前双栏已是"N 侧通用结构"的良好基础——`PanelSidePart` 已把单侧的标题栏、composite bar、互斥、fallback 全封装好。把 `2` 改成 `3` 主要是把 `PanelSide = 'left' | 'right'` 泛化为列表，并让 `SplitView`、互斥、布局、拖拽预览都基于"3 个 side"工作。

---

## 二、核心数据结构改造（最关键）

### 2.1 枚举与字段泛化

**文件**：`src/vs/workbench/browser/parts/panel/panelSidePart.ts`

```typescript
// 现状
export type PanelSide = 'left' | 'right';

// 改为
export type PanelSide = 'left' | 'center' | 'right';
export const PANEL_SIDES: readonly PanelSide[] = ['left', 'center', 'right'] as const;
```

**文件**：`src/vs/workbench/browser/parts/panel/panelPart.ts`

| 现状（双栏） | 改为（三栏） | 是否需改结构 |
|------|------|------|
| `private leftPart: PanelSidePart;` `private rightPart: PanelSidePart;` | `private sideParts: PanelSidePart[];`（长度 3） | 是 |
| `type PanelSide = 'left' | 'right';`（在 panelPart 内或共享） | `'left' \| 'center' \| 'right'` | 是 |
| `private hiddenSides = new Set<PanelSide>();` | 无需改结构（Set 天然支持 3 个 key） | 否 |
| `private activeContainerBySide = new Map<PanelSide, string>();` | 无需改结构（Map 天然支持） | 否 |
| `sideFallbackSchedulers` / `sideContainerViewSubscriptions` / `lastClosedContainerBySide` | 均为 Map/Set，无需改结构 | 否 |
| `private rightInSplit = false;` | 改为 `private visibleSideIndices: number[]` 或从 `splitView.length` + `hiddenSides` 推导 | 是 |

**重要约束**：统一用 `PANEL_SIDES.indexOf(side)` 得到 `index`，所有 `SplitView` 的 view 操作按 `index` 进行，避免引入新的布尔字段（双栏的 `rightInSplit` 已是易错点，三栏不能再加 `centerInSplit`）。

### 2.2 二分 → 三分的方法改造

- `getOtherSidePart(side)` → 改为 `getSiblingSideParts(side): PanelSidePart[]`（返回另两个），所有调用点改为遍历。
- `createSide` 调用改为循环：`PANEL_SIDES.forEach(side => this.sideParts.push(this.createSide(side)))`。

---

## 三、SplitView 三 view（中）

**文件**：`panelPart.ts`

1. `create()` 中初始化为 **3 个** `getSideView(...)`：
   ```typescript
   views: PANEL_SIDES.map(side => ({ size: ..., view: this.getSideView(this.sideParts[idx], side) }))
   ```
2. `addRightToSplit` / `removeRightFromSplit` → 泛化为：
   - `addSideToSplit(side: PanelSide)`：`this.splitView.addView(view, size, index)`
   - `removeSideFromSplit(side: PanelSide)`：`this.splitView.removeView(index, Sizing.Distribute)`
3. `relayoutSides` / `layout` / `updateSideVisibility`：把"0/1 两个 index"扩展为"遍历 `visibleSideIndices`"。
4. `rightViewInSplit` getter（`splitView.length > 1`）改为 `visibleSideCount = splitView.length`，并配合 `hiddenSides` 推导真实可见状态。

---

## 四、三向视图互斥（中高，主要坑）⚠️

**核心不变量**：任意两栏不得同时显示共享同一 view 的容器。

### 4.1 互斥检查泛化

**文件**：`panelPart.ts`

- `containersShareViewOnSide(containerId, side)`：当前 `getOtherSidePart(side)`，改为遍历 `getSiblingSideParts(side)`，任一共享则返回 `true`。
- `releaseOtherSideIfViewOverlap(side, containerId)`：从"释放另一侧"改为"遍历另两个 side，对每个共享的 side 调用 `clearAndUnpinSide`"。**释放顺序固定为 `left`（基线）→ `center` → `right`（最后释放）**，保证确定性强、最终布局可预测。

### 4.2 视图模型订阅

- `subscribeToSideContainerViews`：view 新增时，检查另两个 side（而非一个），释放所有冲突侧。
- `enforceViewUniquenessAfterRestore`：从"left vs right"扩展为"任意两侧都不共享 view"的全校验。

### 4.3 跨栏移动后的源栏补偿

- `movePaneCompositeToSide(id, toSide)`：当前排除"目标侧"一个，改为排除**另外两个** side 的 view（即 `toSide` 之外的两个）。fallback 挑选逻辑：
  ```typescript
  const otherSides = PANEL_SIDES.filter(s => s !== toSide);
  // isValidFallback 排除 otherSides 中任一侧当前容器共享 view
  ```

---

## 五、拖拽分屏预览（中）

**文件**：`panelPart.ts` → `registerSplitDropTarget` / `getSplitTargetSide`

现状的 `getSplitTargetSide` 按"左右中线"二分；改为按**三个 view 的当前宽度**算**两个边界**：

```typescript
const sizes = visibleSideIndices.map(i => this.splitView.getViewSize(i));
// 累积宽度得到 splitX1、splitX2
const splitX1 = rect.left + sizes[0];
const splitX2 = rect.left + sizes[0] + sizes[1];
const targetSide =
  e.clientX < splitX1 ? 'left'
  : e.clientX < splitX2 ? 'center'
  : 'right';
```

- `dragenter / dragover / dragleave / drop` 五个监听器的 `splitPreviewSide` 逻辑原样复用（sticky preview + 仅在变化时重算），只改命中判断。
- `clearSplitPreview` 改为：若仍无视图，从 split 移除空 side（而非只移除 right）。
- 边界抖动防护：严格复用双栏已修好的 sticky preview 机制，避免三栏下两个边界引发的 add/remove 闪烁。

---

## 六、持久化（小）

**文件**：`panelPart.ts`

1. `layoutSettingsKey`（当前 `workbench.panel.dualLayout`）JSON：
   - 现状：`{ rightInSplit: boolean; hiddenSides: string[] }`
   - 改为：`{ hiddenSides: string[]; visibleSides: string[] }`（或直接复用 `activePanelSettingsKeyFor(side)` 为每个 side 存 active id —— **推荐**，改动最小）
2. `splitRatioSettingsKey`：1 个比例 → 2 个切割点：
   - `workbench.panel.leftCenterRatio`
   - `workbench.panel.centerRightRatio`
   - `loadSplitRatio` / `saveSplitRatio` 改为读写两个比例。
3. `loadDualPanelLayout` / `saveDualPanelLayout` / `captureLayoutBeforeHide`：改读写新结构（"dual" 命名建议改为 `panelLayout` 或仅改内部字段，避免误导）。

---

## 七、上下文键（小）

**文件**：`src/vs/workbench/common/contextkeys.ts`

新增（参照现有 `PanelLeftFocusContext` / `PanelRightFocusContext`）：

```typescript
export const ActivePanelCenterContext = new RawContextKey<string>('activePanelCenter', '', ...);
export const PanelCenterFocusContext = new RawContextKey<boolean>('panelCenterFocus', false, ...);
```

**文件**：`panelSidePart.ts`

- 构造函数中 `ActivePanelLeftContext/Right` → `ActivePanel*Context`（按 `side` 映射三套）。
- `create()` 中 focus 镜像：当前 `sideFocusKey = (left?PanelLeftFocusContext:PanelRightFocusContext)`，`otherSideFocusKey` 对称；改为按 `side` 取自身与"另两个"的 focus key（三向，不再是简单的二选一）。
- `getActivePaneComposite()` / `getFocusedSide()` / `getSideToHide()`（`panelPart.ts`）：focus 判定从"左/右"三态扩展为"左/中/右"。

---

## 八、CSS（小）

**文件**：`src/vs/workbench/browser/parts/panel/media/panelpart.css`

1. `.panel-side-left` / `.panel-side-right` 增加 `.panel-side-center` 选择器（复用同一套 flex 规则）。
2. 拖拽分屏预览边框：现状只高亮 `.panel-side-right`：
   ```css
   .monaco-workbench .part.panel .panel-split.panel-split-preview .panel-side-right { border-left: 1px dashed ...; }
   ```
   改为按 `splitPreviewSide` 动态加 class（如 `.panel-split-preview-left/center/right`），分别高亮对应侧的左边框/右边框。
3. sash 分隔线规则（`.monaco-sash.vertical`）对三栏天然适用，无需改动。

---

## 九、文件改动清单汇总

| 文件 | 改动类型 | 难度 |
|------|------|------|
| `panel/panelSidePart.ts` | `PanelSide` 枚举 + `center` 分支（构造函数、focus、context key） | 中 |
| `panel/panelPart.ts` | 数据结构泛化、SplitView 三 view、三向互斥、三分几何、持久化 | 中高 |
| `common/contextkeys.ts` | 新增 `ActivePanelCenterContext` / `PanelCenterFocusContext` | 小 |
| `panel/media/panelpart.css` | `.panel-side-center` + 分屏预览边框 | 小 |

---

## 十、工作量估算

| 模块 | 难度 | 估时 |
|------|------|------|
| 数据结构泛化（Map/Set/数组 + index 推导） | 中 | 2-3 天 |
| SplitView 三 view 动态增删 + 几何 | 中 | 2-3 天 |
| 三向互斥与 fallback（含释放顺序） | 中高 | 3-4 天 |
| 拖拽分屏预览（双边界几何） | 中 | 2-3 天 |
| 持久化 + restore | 小 | 1-2 天 |
| 上下文键 + focus 判定 | 小 | 0.5-1 天 |
| CSS | 小 | 0.5 天 |
| 测试 + 边界（HC 主题、拆分组、轮回测试、三栏闪烁） | 中 | 3-4 天 |
| **合计** | | **约 14–21 人天（取中值 13.5–18）** |

---

## 十一、风险点与缓解

### 高风险
1. **三向互斥的释放顺序**：一次打开可能和两栏都冲突，先释放谁影响最终布局。
   - 缓解：固定优先级 `left → center → right`（left 为基线，right 最后释放）。
2. **三分几何的 `splitX` 抖动**：双栏的 add/remove 闪烁坑在三栏放大（两个边界）。
   - 缓解：严格复用已修好的 sticky preview，仅在 `splitPreviewSide` 变化时重算布局。

### 中风险
1. **`hiddenSides` 与 `visibleSideIndices` 一致性**：三栏后"哪些 side 在 split"更复杂。
   - 缓解：把"是否在 split"统一从 `splitView.length` + `hiddenSides` 推导，不引入新布尔字段。
2. **跨栏移动的源栏 fallback**：排除目标侧一个 → 需排除另外两个，逻辑易漏。
   - 缓解：用 `PANEL_SIDES.filter(s => s !== toSide)` 统一生成排除集合。

### 低风险
- 上下文键三向后 `getActivePaneComposite` 的 focus 判定需覆盖"三栏都无 focus"的兜底（默认返回含 active composite 的某一栏，偏好 `lastFocusedSide`）。

---

## 十二、验收标准

### 功能
- [ ] Panel 默认打开为单栏（left 填充），center / right 为可拖拽激活的空分区。
- [ ] 从 Activity Bar / Sidebar / Auxiliary Bar / Editor 拖视图到任意空分区，该分区被激活并显示视图。
- [ ] 三栏可同时各显示一个不共享 view 的容器。
- [ ] 拖入会与某栏共享 view 的容器时，相关栏被互斥释放（不出现同一 view 在两栏）。
- [ ] 关闭任意一栏的 side 按钮，另两栏填充剩余宽度。
- [ ] 拖动分栏 sash 调整三栏宽度，比例持久化（两个切割点）。
- [ ] Toggle Panel 关/开后，三栏布局（含隐藏状态）精确恢复。
- [ ] 重启/切换工作区后，三栏布局正确恢复。

### 兼容性
- [ ] HC 高对比度主题下三栏渲染正常。
- [ ] 拆分编辑器组时 Panel 三栏布局正确。
- [ ] 三栏拖拽分屏预览无持续闪烁。
- [ ] 现有双栏持久化数据可平滑迁移（旧 `dualLayout` 键缺失时回退到 left 单栏）。

---

## 十三、后续优化方向
1. 允许同一 view 在多个栏同时显示（可选关闭互斥）。
2. 栏数可配置（2/3/N）。
3. 栏间拖拽整容器交换位置。
