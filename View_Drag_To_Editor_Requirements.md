# 视图（OUTLINE / PROBLEMS / PORTS）拖入编辑器区 — 需求拆解、估时与风险

> 目标：让 Sidebar / Panel / Auxiliary Bar 中的视图（ViewPane）能够通过拖拽，放置到编辑器（Editor）代码编辑区域，并作为编辑器 tab 存在。
> 日期：2026-07-21

---

## 一、核心难点（结论）

视图（`OUTLINE` / `PROBLEMS` / `PORTS` 等）本质是 `ViewPane` 子类，由各自的 `ViewPaneContainer`（Sidebar / Panel / AuxBar）通过 `createView(viewDescriptor, options)` **各自实例化**（见 `src/vs/workbench/browser/parts/views/viewPaneContainer.ts:698`），没有通用工厂。而编辑器区只认 `EditorInput + EditorPane`。两者生命周期、状态、依赖注入完全独立。

所以这不是"放开 drop 就行"的活，真正的工作量是**给任意 `ViewPane` 做一套 `EditorInput / EditorPane` 适配层**。

---

## 二、任务拆分与估时

> 下表为 **2026-07-22 修订版**。原估时（13.5–22 人天）基于"不确定 ViewPane 能否进编辑器"的假设；P0 Spike 已证实可行，并顺带完成了 P1 / P2 / P3 / P5 的部分，故整体压缩。

| # | 任务 | 内容 | 原估时 | 修订估时 | 状态 |
|---|------|------|--------|----------|------|
| P0 | 技术预研 Spike | 验证：能否把任意 `ViewPane` 脱离原容器渲染到任意 DOM 节点；视图 show/hide/focus 在 editor 生命周期下是否正常；状态是否丢失 | 2–3 天 | — | ✅ 已完成 |
| P1 | 解除编辑器区 drop 阻断 | `editorPart.ts` 的 `onDragOver` 中，当 `dropData.type === 'view'` 时设 `dropEffect='copy'`，并跳过展开侧栏/面板逻辑 | 0.5 天 | — | ✅ 已完成 |
| P2 | 新增 `ViewEditorInput` + `ViewEditorPane` | 新建 `EditorInput` 子类（承载 `viewId`），新建 `EditorPane` 子类负责托管目标视图、处理布局/焦点/dispose | 3–5 天 | 1–2 天 | 🟡 原型已完成，剩 orientation 覆盖 + 关闭归还 |
| P3 | 视图实例化桥接 | 通用工厂 `instantiationService.createInstance(descriptor.ctorDescriptor.ctor, …staticArgs, options)` 已验证可行，抽成正式 API 即可 | 2–3 天 | 0.5 天 | 🟢 风险已消除 |
| P4 | drop 处理 + 从原容器移除 | `editorPart` 的 `onDrop` 读取 `viewId`；从原 `ViewContainerModel` 隐藏/移除该 view；调用 `openEditor(new ViewEditorInput(viewId))` | 1–2 天 | 1–2 天 | ⬜ 未做（核心"移动"逻辑） |
| P5 | 序列化 / 持久化 / 恢复 | `EditorInput` 的 `toJSON / fromJSON`；工作区布局恢复；recently-closed；辅助窗口（aux window）路径 | 2–3 天 | 1–2 天 | 🟡 基础 serializer 已有，补全恢复/辅助窗口 |
| P6 | 关闭 / 清理 | 关闭 editor tab 时 dispose 视图；处理"归还到原容器"；多实例共存 | 1 天 | 1 天 | 🟡 dispose 已有，缺"归还" |
| P7 | 测试与边界 | 多视图、HC 主题、拆分编辑器组、拖出还原、撤销/重做布局、性能 | 2–3 天 | 2–3 天 | ⬜ 未做 |
| — | 拖出还原（editor → Sidebar） | 支持从 editor tab 拖回 Sidebar，避免"单向黑洞" | — | 1 天 | ⬜ 新增（原方案漏估） |

**剩余工作量：约 7.5–11.5 人天**（已花约 3–3.5 人天在 Spike + 原型上）。

### 2.1 分期交付建议

- **Phase 1 — 最小可用（拖入即移动，关闭即归还）：P2 收尾 + P3 + P4 + P6 ≈ 3.5–5.5 天**
  - 拖入后原容器不再重复显示，关闭 tab 时视图归还原容器。这是"能用"的门槛，优先做。
- **Phase 2 — 持久化：P5 ≈ 1–2 天**
  - 重启/切换工作区后，编辑器里的视图布局能恢复；覆盖辅助窗口。
- **Phase 3 — 打磨与回归：拖出还原 + P7 ≈ 3–4 天**
  - 支持从 editor tab 拖回 Sidebar（避免"单向黑洞"）；HC 主题、拆分编辑器组、多视图、性能回归。

### 2.2 修订后排期风险点（比原估时更准了）

1. **"归还原容器"语义**是剩下最大的坑：同一 view 在 `ViewContainerModel` 里只属于一个容器，拖进编辑器时怎么"摘走"、关闭时怎么"挂回"，要小心处理可见性/顺序，可能比估时多 0.5–1 天。
2. **状态保留**：树展开/滚动/筛选在"进编辑器 → 切走 → 切回"后是否保留，取决于视图自身，可能要逐视图适配。
3. **上游合并**：改动集中在 `editorPart.ts`、各视图容器，VS Code 升级 rebase 仍会痛（未变）。

---

## 三、风险点

1. **架构耦合（最高风险）**：`ViewPane` 由各 `ViewPaneContainer` 子类用 `createView` 实例化（每个视图有自己的 pane 类，如 `OutlinePane`、`MarkersPane`、`TunnelView`），无统一工厂。要进 editor，要么重构视图创建层抽通用工厂（影响面大），要么让每个容器暴露外部分发接口（侵入每个容器）。**这是整个需求能否落地的关键不确定性，必须在 P0 Spike 验证**。

2. **生命周期冲突**：视图有 `show / hide / focusVisible / setVisible` 等容器级语义，editor group 有 `open / close / activate` 语义，两者不对应。视图在 editor 里被隐藏（如切到别的 tab）时状态/订阅怎么处理容易出 bug。

3. **状态保存**：树展开、滚动位置、筛选条件等视图内部状态在"拖进 editor → 关闭 → 重开"后是否保留，需要额外设计。

4. **与原容器共存**：同一视图能否既在 Sidebar 又在 editor 开多个实例？还是"拖进 editor 就从原容器消失"？这影响 `ViewContainerModel` 的数据模型（当前一个 view 只属于一个容器）。

5. **上游合并成本**：改动点分散在 `dnd.ts`、`editorPart.ts`、`viewPaneContainer.ts`、各视图容器，且 VS Code 这些文件升级频繁，**后续 rebase 冲突会很痛**。

6. **与现有视图拖拽体系冲突**：`moveViewToLocation` 只支持 `Sidebar / Panel / AuxiliaryBar` 三个位置，没有"Editor"位置。需要新增位置枚举或绕开该体系，可能破坏现有布局持久化逻辑。

7. **可发现性与反向操作（UX）**：用户拖进去后，怎么拖出来？是否要支持从 editor tab 拖回 Sidebar？否则会变成"单向黑洞"。

8. **性能**：部分视图（如 PROBLEMS / MARKERS）订阅大量诊断数据，在 editor 里常驻可能加重渲染负担。

---

## 四、推进策略

- **P0 Spike 已完成（2026-07-21）**：已证实"任意 ViewPane 可经通用工厂实例化并渲染到编辑器区"，且原型已放开 drop 并打开 editor tab。详见第六、七节。
- **按修订后排期分期推进（见第二节 2.1）**：优先 Phase 1（最小可用：拖入即移动、关闭即归还），再 Phase 2（持久化），最后 Phase 3（拖出还原 + 回归）。
- **范围收敛**：首版建议做"拖进 editor 后从原容器消失、不可多实例"的最小可用版（即方案 A：视图仍登记在原容器、仅从原容器隐藏），降低 P3 / P4 / P6 复杂度；暂不引入 `ViewContainerLocation.Editor` 枚举（方案 B）。
- **替代方案（不改代码，立即可用）**：把 OUTLINE / PROBLEMS / PORTS 拖到 **Auxiliary Bar（右侧栏）** 或 **Panel 最大化**，获得更大的独立工作空间。

---

## 五、P0 Spike 验证清单

- [x] 选定 1–2 个代表性视图（建议 `PROBLEMS/MARKERS` 与 `OUTLINE`），确认其 `ViewPane` 子类构造依赖。
- [x] 验证能否用 `IInstantiationService` 直接实例化该 `ViewPane` 并 `create` 到任意 `HTMLElement`。
- [ ] 验证渲染后数据/交互是否正常（树、筛选、命令）。
- [ ] 验证 `setVisible(false)` / 容器销毁时视图是否正确 dispose，无残留订阅/内存泄漏。
- [ ] 验证视图内部状态（展开、滚动、筛选）在隐藏/重显后是否保留。
- [x] 输出结论：通用工厂方案 vs 外部分发方案，哪条路更可行；给出 P2/P3 的具体落地建议。

---

## 六、P0 Spike 阶段结论（2026-07-21）

### 6.1 已确认的事实（代码级）

1. **任意 ViewPane 可经通用工厂实例化（P3 风险大幅降低）**
   `ViewPaneContainer.createView`（`src/vs/workbench/browser/parts/views/viewPaneContainer.ts:702`）的实现：

   ```ts
   protected createView(viewDescriptor: IViewDescriptor, options: IViewletViewOptions): ViewPane {
       return (this.instantiationService as any).createInstance(
           viewDescriptor.ctorDescriptor.ctor,
           ...(viewDescriptor.ctorDescriptor.staticArguments || []),
           options) as ViewPane;
   }
   ```

   `IViewDescriptor.ctorDescriptor` 已经携带了 pane 的构造器与静态参数，因此**不需要为每个视图单独写适配代码**，一个通用工厂即可 `instantiationService.createInstance(ctor, ...staticArgs, options)` 出任意 `ViewPane`。`options` 只需 `IViewletViewOptions`（`{ id, title, fromExtensionId?, expanded?, singleViewPaneContainerTitle? }`）。

2. **中央阻塞点：`ViewContainerLocation` 是只有 3 个值的 `const enum`**
   `src/vs/workbench/common/views.ts:39`：

   ```ts
   export const enum ViewContainerLocation {
       Sidebar,
       Panel,
       AuxiliaryBar
   }
   ```

   没有 `Editor` 位置。`moveViewToLocation` / `registerGeneratedViewContainer`（`viewDescriptorService.ts:328` / `:503`）只会在 Sidebar/Panel/AuxiliaryBar 之一注册一个 `ViewPaneContainer`，而 `ViewPaneContainer` 必然挂载到对应 Part（Sidebar/Panel/AuxBar），**不是编辑器区**。

3. **ViewPane 与"所属容器/位置"强耦合**
   - 构造函数（`viewPane.ts:384-400`）调用 `viewDescriptorService.getViewLocationById(id)` 决定 `orientation`，并写入 `viewLocation` context key。
   - `renderHeader`（`viewPane.ts:506`）调用 `getViewContainerByViewId(id)` 监听容器标题变化。
   - 若把视图从原容器彻底移除，`getViewLocationById` 返回 `null`，构造/渲染会出问题。因此 pane 必须"仍属于某个已注册的容器"才能正常创建。

### 6.2 两条候选架构（P3 的核心决策）

**方案 A：不新增位置枚举，视图仍登记在原容器，但把 pane DOM 渲染进编辑器**
- 做法：`ViewEditorPane` 用通用工厂 `createInstance(ctor, ...staticArgs, options)` 创建 pane，调用 `pane.render()`，把 `pane.element` append 到编辑器 pane 的 DOM；同时从原 `ViewContainerModel` 隐藏该 view（不真正移除，仅 `setVisible(false)` / 从可见描述符中剔除），保证 `getViewLocationById` 仍有值。
- 优点：不动 `ViewContainerLocation` 枚举，影响面小；通用工厂直接复用。
- 缺点：
  - 视图"逻辑上属于原容器、物理上在编辑器"，状态保存/恢复要走原容器模型，需小心处理"原容器是否还显示它"。
  - `orientation` 仍按原位置计算（Panel 视图为 HORIZONTAL），在编辑器竖区长条里可能观感不对，需覆盖。
  - 关闭 editor tab 时要把视图"归还"到原容器可见列表。

**方案 B：新增 `ViewContainerLocation.Editor` 枚举值 + 一个"虚拟" ViewPaneContainer**
- 做法：扩展 `const enum` 增加 `Editor`；新增一个不挂载到任何 Part 的 `ViewPaneContainer`（或复用现有机制但让编辑器区成为其宿主）；`moveViewsToContainer` 到该容器；`ViewEditorPane` 从该容器取 pane 渲染。
- 优点：语义最干净，视图真正"属于编辑器位置"，与现有 `moveViewToLocation` 体系一致，序列化/恢复可走既有 `viewCustomizations` 通道。
- 缺点（高风险）：
  - `const enum` 改动会触发**全代码库所有对 3 个位置的 switch/if**（layout.ts、paneCompositePart.ts、layoutActions.ts、各 Part 的 `getViewContainerLocation` 分支等）都需要处理第 4 个值，否则编译/逻辑遗漏。
  - 需新增"Editor 位置的容器如何被编辑器区承载"的渲染路径，等于在 Grid 体系里塞进一个非 Editor 的视图，与 `EditorGroupView` 模型冲突。

### 6.3 Spike 推荐

- **优先方案 A**（风险/工作量最低，且复用了已确认的通用工厂能力）。把"进编辑器"建模为：**视图在原容器保持登记（保证 `getViewLocationById` 有效），但可见性从原容器移除、转由 `ViewEditorPane` 托管渲染**。
- 方案 B 仅在"希望视图在布局体系里正式成为 Editor 位置"时才考虑，代价是改 `const enum` + 全量位置分支，建议作为后续增强而非首版。
- **P2/P3 落地建议（基于方案 A）**：
  1. 新增 `ViewEditorInput extends EditorInput`，持有 `viewId`；实现 `getTypeId`、`getLabel`、`getResource`（用 `virtualUri`）、`toJSON/fromJSON`。
  2. 新增 `ViewEditorPane extends EditorPane`，在 `createEditor` 里：
     - `const descriptor = viewDescriptorService.getViewDescriptorById(viewId)`
     - `const pane = instantiationService.createInstance(descriptor.ctorDescriptor.ctor, ...staticArgs, { id, title, expanded: true })`
     - `pane.render()`；`this.element.appendChild(pane.element)`；`pane.layout(dimension)`；`pane.setVisible(true)`。
     - `dispose` 时 `pane.dispose()` 并（可选）把视图归还原容器。
  3. 在 `editorPaneRegistry` 注册 `ViewEditorInput` ↔ `ViewEditorPane`。
  4. `editorPart.ts` 的 `onDrop`（`CompositeDragAndDropObserver` 目标）识别 `type === 'view'`，调用 `IEditorService.openEditor(new ViewEditorInput(dropData.id))`，并同步从原容器隐藏该 view。

### 6.4 仍需在后续 Spike 子任务验证（未勾选项）

- 实际跑通：在 `ViewEditorPane` 里实例化 `PROBLEMS`/`OUTLINE` 并渲染到编辑器组，确认树/筛选/命令正常。
- `setVisible(false)` 与 editor group 隐藏 tab 时是否正确 dispose，无残留订阅/内存泄漏。
- 视图内部状态（展开、滚动、筛选）在"进编辑器 → 切走 → 切回"后是否保留。
- HC 主题 / 拖出还原（从 editor tab 拖回 Sidebar）的交互闭环。

---

## 七、P0 Spike 原型实现（2026-07-21，方案 A）

为真正验证可行性，已落地一个最小可运行原型（**未移除视图与原容器的绑定**，仅验证"ViewPane 能否在编辑器区渲染 + drop 能否触发打开"）。

### 7.1 新增文件

- `src/vs/workbench/contrib/viewInEditor/browser/viewEditorInput.ts`
  - `ViewEditorInput extends EditorInput`，持有 `viewId`；`resource = vscode-view:/<viewId>`；`capabilities = Singleton`；实现 `matches` / `toUntyped`。
- `src/vs/workbench/contrib/viewInEditor/browser/viewEditorPane.ts`
  - `ViewEditorPane extends EditorPane`：`setInput` 中通过**通用工厂**
    `instantiationService.createInstance(descriptor.ctorDescriptor.ctor, ...staticArgs, { id, title, expanded: true })` 实例化目标 `ViewPane`，`pane.render()` 后 `this.element.appendChild(pane.element)`；`layout` / `setVisible` / `clearInput` 转发到 pane。
- `src/vs/workbench/contrib/viewInEditor/browser/viewInEditor.contribution.ts`
  - 注册 `ViewEditorPane` ↔ `ViewEditorInput`，并注册 `ViewEditorInputSerializer`（`serialize` 存 `viewId`，`deserialize` 还原）。

### 7.2 修改文件

- `src/vs/workbench/browser/parts/editor/editorPart.ts`
  - `setupDragAndDropSupport` 的 overlay `onDragOver`：当 `dragAndDropData.getData().type === 'view'` 时设 `dropEffect = 'copy'`（不再 `'none'`），并跳过"展开侧栏/面板"逻辑。
  - 新增 overlay `onDrop`：读取 `viewId`，`instantiationService.invokeFunction(accessor => accessor.get(IEditorService).openEditor(new ViewEditorInput(viewId)))`。
- `src/vs/workbench/workbench.common.main.ts`
  - 新增 `import './contrib/viewInEditor/browser/viewInEditor.contribution.js';` 使贡献被加载。

### 7.3 已知限制（原型阶段，非最终行为）

1. **视图仍在原容器显示**：原型未从原 Sidebar/Panel/AuxBar 移除该 view（P4 工作），因此拖入编辑器后原位置仍有一份。验证渲染/交互足够；最终版需 `moveView`/隐藏原容器中的 view。
2. **orientation 沿用原位置**：Panel 视图在编辑器竖区长条里 header 方向可能不对，需覆盖。
3. **未做序列化恢复回归、内存泄漏检查、拖出还原**——见 6.4。

### 7.4 如何验证

1. `npm run compile`（或 `yarn watch`）后启动。
2. 从 Sidebar 拖 `OUTLINE` / `PROBLEMS` / `PORTS` 到编辑器区中央 → 应出现一个以视图名为标题的 editor tab，且内部树/筛选可交互。
3. 观察：原容器里该视图是否仍显示（预期：仍显示，属已知限制 7.3.1）。
