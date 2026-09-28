# Implementation Plan — Phase 2: Drag & View-Move Support

[Overview]
Enable users to drag a view pane from the sidebar/panel into the editor area, and drag it back out, by wiring the existing P0 spike into a complete, production-quality drag-and-drop pipeline.

The P0 spike already proves the concept: `ViewEditorInput` / `ViewEditorPane` exist, the `onDrop` handler in `editorPart.ts` opens a `ViewEditorInput` when `dragData.type === 'view'`, and `ViewContainerLocation.Editor = 3` is registered. Phase 2 turns this spike into a real feature by:

1. Making the drag **start** correctly from any view pane header (the `draggableElement` in `viewPaneContainer.ts` already calls `CompositeDragAndDropObserver.INSTANCE.registerDraggable` with `type: 'view'`—no change needed there).
2. Making the **dragover** overlay in `editorPart.ts` show a proper drop-indicator instead of silently accepting everything.
3. Making the **drop** call `viewDescriptorService.moveViewToLocation(view, ViewContainerLocation.Editor)` so the view is properly relocated, not just visually duplicated.
4. Making `viewDescriptorService.moveViewToLocation` handle `ViewContainerLocation.Editor` without crashing (it currently calls `registerGeneratedViewContainer` which may not handle the new location).
5. Adding a **reverse drag** path: when a `ViewEditorInput` tab is dragged out of the editor area back to a sidebar/panel drop target, the view is moved back to its original location.

---

[Types]
New and modified type definitions required for Phase 2.

### New: `IViewEditorDragData` (in `src/vs/workbench/browser/dnd.ts`)
No new type needed — `CompositeDragAndDropData` already carries `{ type: 'view' | 'composite'; id: string }`. The `id` is the `viewId`.

### Modified: `ViewContainerLocation` switch arms
Every exhaustive switch over `ViewContainerLocation` must handle the new `Editor = 3` case. Files already fixed in Phase 1:
- `src/vs/workbench/common/views.ts` — `ViewContainerLocationToString` ✓
- `src/vs/workbench/contrib/terminal/browser/terminalGroup.ts` — `_getPosition()` ✓

Files that still need an `Editor` arm added (see [Functions]):
- `src/vs/workbench/browser/parts/views/viewPaneContainer.ts` — `get orientation()` switch
- `src/vs/workbench/services/views/browser/viewDescriptorService.ts` — `registerGeneratedViewContainer` / `moveViewToLocation`

### New: `EDITOR_VIEW_CONTAINER_ID` constant (already exported from `layout.ts`)
Used as the stable container id for the editor-hosted view container.

---

[Files]
Six files require modification; no new files need to be created.

**Modified files:**

1. `src/vs/workbench/browser/parts/editor/editorPart.ts`
   - Improve `onDragOver` to set `dropEffect = 'move'` and show a visual indicator when `dragData.type === 'view'`.
   - Improve `onDrop` to call `moveViewToLocation(view, ViewContainerLocation.Editor)` instead of just opening a `ViewEditorInput` directly (the `ViewEditorPane.setInput` path already handles rendering).
   - Add `onDragStart` on the editor tab strip to register a reverse-drag source when a `ViewEditorInput` tab is being dragged.

2. `src/vs/workbench/browser/parts/views/viewPaneContainer.ts`
   - Add `case ViewContainerLocation.Editor: return Orientation.VERTICAL;` to the `get orientation()` switch so the container does not throw when a view is in the editor location.
   - Add `onDrop` handling in the pane-level drop target to accept a `type: 'view'` drag coming from the editor area (reverse drag), calling `viewDescriptorService.moveViewsToContainer([viewDescriptor], this.viewContainer)`.

3. `src/vs/workbench/services/views/browser/viewDescriptorService.ts`
   - In `moveViewToLocation`: add a guard so that when `location === ViewContainerLocation.Editor` the method uses the fixed `EDITOR_VIEW_CONTAINER_ID` container rather than generating a random id.
   - In `registerGeneratedViewContainer`: ensure the `Editor` location is accepted (currently the method may only handle Sidebar/Panel/AuxiliaryBar).
   - In `moveViewsToContainer`: ensure the `Editor` location does not trigger the "reset to default" logic that would immediately move the view back.

4. `src/vs/workbench/contrib/viewInEditor/browser/viewEditorPane.ts`
   - Register a `CompositeDragAndDropObserver.INSTANCE.registerDraggable` on the pane's title/header element so that dragging a view out of the editor area produces a `type: 'view'` drag event that the sidebar/panel drop targets can receive.
   - On successful drag-out (dragend with a successful drop), call `viewDescriptorService.moveViewToLocation(view, originalLocation)` to move the view back.

5. `src/vs/workbench/browser/parts/views/viewPane.ts`
   - Expose a `draggableElement` getter (or confirm it already exists) that `viewPaneContainer.ts` uses for `registerDraggable`. If it does not exist, add it pointing to the pane header element.

6. `src/vs/workbench/browser/layout.ts` *(already modified in Phase 1)*
   - No further changes needed for Phase 2 beyond what was done in Phase 1.

---

[Functions]
New and modified functions required for Phase 2.

### New functions

**`editorPart.ts` — inside the `onDragOver` callback (anonymous, already exists)**
- Extend the existing `onDragOver` body to read `e.dragAndDropData?.getData()` and, when `type === 'view'`, set `e.eventData.dataTransfer.dropEffect = 'move'` and add a CSS class `drop-view-target` to the overlay.

**`viewEditorPane.ts` — `registerReverseDrag(titleElement: HTMLElement): IDisposable`**
- Signature: `private registerReverseDrag(titleElement: HTMLElement): IDisposable`
- File: `src/vs/workbench/contrib/viewInEditor/browser/viewEditorPane.ts`
- Purpose: registers the pane title as a draggable source with `type: 'view'` so the view can be dragged back to a sidebar/panel container.
- Called from `setInput` after the pane is rendered.

### Modified functions

**`editorPart.ts` — `onDrop` callback (anonymous, lines ~1146–1156)**
- File: `src/vs/workbench/browser/parts/editor/editorPart.ts`
- Current: opens `ViewEditorInput` directly via `IEditorService.openEditor`.
- Change: before opening the editor, call `viewDescriptorService.moveViewToLocation(viewDescriptor, ViewContainerLocation.Editor)` so the view is properly relocated in the registry. Then open the `ViewEditorInput` as before.
- Requires injecting `IViewDescriptorService` into the `EditorPart` constructor (it is already available via `this.viewDescriptorService` if the part uses it, otherwise inject it).

**`viewDescriptorService.ts` — `moveViewToLocation`**
- File: `src/vs/workbench/services/views/browser/viewDescriptorService.ts`
- Current: calls `this.registerGeneratedViewContainer(location)` which generates a random id.
- Change: add a branch `if (location === ViewContainerLocation.Editor) { container = this.registerGeneratedViewContainer(location, EDITOR_VIEW_CONTAINER_ID); }` to use the stable id.
- Import `EDITOR_VIEW_CONTAINER_ID` from `layout.ts` or move the constant to `views.ts` to avoid a circular dependency.

**`viewDescriptorService.ts` — `registerGeneratedViewContainer`**
- File: `src/vs/workbench/services/views/browser/viewDescriptorService.ts`
- Current: may not handle `ViewContainerLocation.Editor` in its internal `ctorDescriptor` selection.
- Change: add a fallback that uses a minimal `SyncDescriptor` (same pattern as AuxiliaryBar) when `location === ViewContainerLocation.Editor`.

**`viewPaneContainer.ts` — `get orientation()`**
- File: `src/vs/workbench/browser/parts/views/viewPaneContainer.ts`
- Current: switch has `Sidebar`, `AuxiliaryBar`, `Panel` — no `Editor` arm, causing a TypeScript exhaustiveness error.
- Change: add `case ViewContainerLocation.Editor: return Orientation.VERTICAL;`

**`viewPaneContainer.ts` — pane-level `onDrop` callback**
- File: `src/vs/workbench/browser/parts/views/viewPaneContainer.ts`
- Current: handles `type: 'view'` drops between pane containers in the same location.
- Change: add a check — if the dragged view's current location is `ViewContainerLocation.Editor`, call `viewDescriptorService.moveViewsToContainer([viewDescriptor], this.viewContainer)` to move it back.

---

[Classes]
No new classes are needed; existing classes are modified.

**Modified: `EditorPart`** (`src/vs/workbench/browser/parts/editor/editorPart.ts`)
- Inject `IViewDescriptorService` if not already present.
- Extend the drop-overlay registration block to call `moveViewToLocation`.

**Modified: `ViewEditorPane`** (`src/vs/workbench/contrib/viewInEditor/browser/viewEditorPane.ts`)
- Add `IViewDescriptorService` injection (already present).
- Add `registerReverseDrag` private method.
- Track `originalLocation: ViewContainerLocation` so the reverse drag knows where to send the view back.

**Modified: `ViewPaneContainer`** (`src/vs/workbench/browser/parts/views/viewPaneContainer.ts`)
- Extend `get orientation()` switch.
- Extend pane-level `onDrop` to handle reverse-drag from editor.

---

[Dependencies]
No new npm packages are required.

**Potential circular dependency risk:**
- `EDITOR_VIEW_CONTAINER_ID` is currently exported from `layout.ts`.
- `viewDescriptorService.ts` must not import from `layout.ts` (workbench browser layer importing from workbench browser parts layer would create a cycle).
- **Resolution:** move `EDITOR_VIEW_CONTAINER_ID` to `src/vs/workbench/common/views.ts` (or a new `src/vs/workbench/common/viewContainerIds.ts`) so both `layout.ts` and `viewDescriptorService.ts` can import it without a cycle.

---

[Testing]
Manual smoke-test scenarios; no automated test files are added in Phase 2.

**Scenario 1 — Drag view into editor:**
1. Open the OUTLINE view in the sidebar.
2. Drag its header into the editor area.
3. Verify: a `ViewEditorInput` tab opens, the OUTLINE pane renders inside the editor, and the view disappears from the sidebar.

**Scenario 2 — Drag view back to sidebar:**
1. With OUTLINE open in the editor (from Scenario 1), drag the `ViewEditorInput` tab header back to the sidebar drop target.
2. Verify: the tab closes, the OUTLINE view reappears in the sidebar at its original position.

**Scenario 3 — Reload persistence:**
1. Drag OUTLINE into the editor, then reload the window.
2. Verify: the `ViewEditorInputSerializer` restores the tab and the view renders correctly.

**Scenario 4 — Exhaustive switch regression:**
1. Run `tsc --noEmit` and confirm zero errors in `viewPaneContainer.ts`, `viewDescriptorService.ts`, and `terminalGroup.ts`.

---

[Implementation Order]
Changes must be applied in dependency order to avoid compile errors at each step.

1. **Move `EDITOR_VIEW_CONTAINER_ID` to `views.ts`** — eliminates the circular-dependency risk before any other file imports it.
2. **Update `layout.ts`** — re-export `EDITOR_VIEW_CONTAINER_ID` from `views.ts` (or remove the local declaration and import from `views.ts`).
3. **Fix `viewPaneContainer.ts` `get orientation()` switch** — adds the `Editor` arm; compile-time fix, no runtime change.
4. **Fix `viewDescriptorService.ts` `moveViewToLocation` + `registerGeneratedViewContainer`** — makes the service correctly handle `ViewContainerLocation.Editor` using the stable container id.
5. **Extend `editorPart.ts` `onDrop`** — call `moveViewToLocation` before opening the editor input; extend `onDragOver` to set `dropEffect = 'move'`.
6. **Extend `viewEditorPane.ts`** — add `registerReverseDrag`, track `originalLocation`, call `moveViewToLocation` on drag-out.
7. **Extend `viewPaneContainer.ts` pane-level `onDrop`** — accept reverse-drag from editor location.
8. **Compile check** — run `tsc --noEmit`; fix any remaining exhaustive-switch errors.
9. **Manual smoke tests** — run Scenarios 1–4 above.
