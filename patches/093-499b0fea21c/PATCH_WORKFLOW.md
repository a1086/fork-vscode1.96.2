# 分支改动打包 / 打 Patch 工作流

本文档记录如何把当前 fork 分支（`vscode-fork-dev`）的本地提交，导出成可分发、可一键应用的 patch 包，并部署到云桌面。

适用分支当前状态：基于上游 fork 基点 `fabdb6a30b4`，到 HEAD 共 **一批自定义提交**（具体数量以 `patches/INDEX.md` 为准，随分支增长）。

---

## 一、交付物清单

需一起拷贝到云桌面的文件/目录（建议都放在同一个根目录，例如 `D:\patchtool\`）：

| 文件 / 目录 | 作用 | 在哪运行 |
| --- | --- | --- |
| `make_patches.ps1` | **生成** patch：把本地提交导出到 `patches/` | 本机（需 git + 仓库） |
| `patches/` | 导出的所有提交文件（每个 commit 一个文件夹 + 元数据），其中 `patches/_base/` 额外保存每个文件的"基线版本"（即该 commit 的父版本，用于三方合并的冲突检测） | 随包分发 |
| `apply_patches.ps1` | **应用** patch 的核心脚本（依赖 `git merge-file` 做三方合并，云桌面需有 git） | 云桌面 |
| `apply.bat` | `apply_patches.ps1` 的双击入口包装 | 云桌面 |

> 注意：`patches/` 里已经是**真实的源码文件**（不是 git 补丁文本），所以云桌面**不需要仓库有改动历史**；但 `apply_patches.ps1` 做三方合并时依赖 `git merge-file`，因此云桌面需安装 git。

---

## 二、patches/ 目录结构

```
patches/
  001-041a368987b/          # 每个文件夹 = 一个提交（序号-短哈希）
    src/vs/...              # 该提交当时版本的原相对路径文件
    _COMMIT_INFO.txt        # 该提交的哈希/作者/日期/改动文件清单
  002-fac5fe8f18a/
  ...
  089-b830316691b/
  _BASE.txt                 # fork 基点哈希（fabdb6a30b4），记住后用于增量
  _LAST.txt                 # 上次导出到的 HEAD 哈希，用于增量判定
  _DELETED.txt              # 分支中已被删除的文件清单（应用时要删掉）
  INDEX.md                  # 提交的总索引
```

---

## 三、打 Patch（生成）—— 本机

在仓库根目录（即 `make_patches.ps1` 所在目录）运行，需本机有 git：

```powershell
# 全量重建：从 fork 基点 fabdb6a30b4 到 HEAD 重新导出所有提交
powershell -ExecutionPolicy Bypass -File make_patches.ps1 -Full

# 增量导出：仅导出上次 (-Last) 之后新增的提交，追加新 NNN 文件夹（快）
powershell -ExecutionPolicy Bypass -File make_patches.ps1 -Incremental

# 不带参数默认等效于 -Full；也可用 -Base <hash> 指定其它基点
```

- 增量模式靠 `patches/_LAST.txt` 记住上次导出的 HEAD；若发现历史被改写（上次导出点不再是祖先），会自动回退到全量重建。
- 每个提交独立成文件夹，便于单独查看某个提交的改动。
- 生成时还会把每个被改文件的"基线版本"（即该 commit 的父版本）导出到 `patches/_base/<NNN>/<path>`，供 `apply_patches.ps1` 的三方合并判断。

---

## 四、打 Patch（应用）—— 云桌面

把 `apply.bat` + `apply_patches.ps1` + `patches\` 三个一起拷到云桌面任意目录，然后：

```bat
apply.bat                                :: 默认目标仓库 D:\project\vscode-100.0，三方合并模式（适配高版本安全）
apply.bat DRY                            :: 先预览将要合并/覆盖/删除哪些文件，不改动（强烈建议先跑一次确认）
apply.bat "D:\别的路径\vscode"            :: 套到指定仓库（合并模式）
apply.bat DRY "D:\别的路径\vscode"        :: 对指定仓库做预览
apply.bat FORCE                          :: 强制全量覆盖：跳过合并，一律把 patch 文件盖到目标（只适合同版本重套用，会覆盖掉目标里已被上游改过的同名文件，慎用）
apply.bat FORCE "D:\别的路径\vscode"      :: 指定仓库 + 强制覆盖
```

> 脚本只认两个开关：`DRY`（预览）和 `FORCE`（强制覆盖）。**`FORCE` 不加就是默认的合并模式**，这也是适配高版本该用的模式。旧文档里的 `SAFE` 开关已废弃，不要再使用。

行为说明：
1. 按提交序号顺序，把 `patches/NNN-*/` 下所有文件（除 `_COMMIT_INFO.txt` 与 `_base/` 元数据）以**三方合并**方式落到目标仓库对应相对路径。**后提交的覆盖先提交的**。
2. 读取 `patches/_DELETED.txt`，删除目标仓库中那些分支已移除的文件。
3. 云桌面需要 git（脚本用 `git merge-file` 做合并），但**不需要仓库本身有改动历史**——它只比对文件字节内容。
4. **默认就是「适配高版本」的合并模式**（等价于旧文档的 `SAFE` / `-KeepOnConflict`，现在无需加任何开关），判定逻辑基于 `patches/_base` 里的基线版本（= 该 commit 的父版本）：
   - 目标文件不存在 → 当作新文件，直接写入；
   - 目标文件已与 patch 内容一致 → 视为已应用，跳过；
   - 目标文件仍等于基线版本（干净、未被上游改过）→ 安全，直接套用 patch（覆盖）；
   - 目标文件与基线、patch 都不一致（高版本已自行改动）→ 用 `git merge-file` 做三方合并：能自动合的自动合，合不来的在文件内写 `<<<<<<<` / `=======` / `>>>>>>>` 冲突标记，列入冲突清单，需在 VS Code 里搜 `<<<<<<<` 逐块修掉标记行；
   - **硬性失败保护**：若 `git merge-file` 报错（如二进制/含 NUL 文件 "Cannot merge binary files"）或合并输出为空，脚本**绝不会清空目标文件**，而是跳过并列入失败清单。这修复了早期版本把目标文件直接覆盖成 0 字节的致命 bug。
5. **`FORCE` 模式（`-Force`）**：跳过合并，一律把 patch 文件覆盖到目标。只适合同版本仓库的重新套用；套到高版本会覆盖掉上游已改过的同名文件，**非常危险，默认不要用**。

---

## 五、推荐发版流程

1. **本机提交代码**后，运行增量导出（首次或要彻底干净时可用 `-Full`）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File make_patches.ps1 -Incremental
   ```
2. 把 `patches\` + `apply.bat` + `apply_patches.ps1` + `make_patches.ps1` 一起拷到云桌面（可整体打包成 zip 搬运）。
3. 云桌面先跑 `apply.bat DRY` 确认范围，再双击 `apply.bat` 完成一键覆盖。

---

## 六、校验记录（本机已验证）

- `patches/` 含当前分支全部提交（数量见 `patches/INDEX.md`），按提交顺序应用后的结果，与 `git show HEAD` 对应文件**逐字节一致**。
- 工作区若有未提交改动，应用结果以"已提交状态"为准（这是预期行为）。

---

## 七、版本升级维护（例如 1.96.2 → 1.100.0）

核心原则：这批改动始终作为 **git 提交栈**维护在分支上；升级时把整个栈 **rebase 到新的上游 tag**，再重新导出 batch。batch 工具本身（`make_patches.ps1` / `apply.bat`）几乎不用改，只换"基点"。

### 为什么不能直接复用旧 batch

batch 是基于**旧基点**的文件快照，若把基于 1.96.2 的旧 `patches/` 直接套到 1.100.0 上，会因基线错位而把旧内容错误合并/覆盖到上游已改过的同名文件。因此升级后必须**重新生成 batch，且生成源是 rebase 后的分支**（导出的文件已基于 1.100.0 代码，基线也自动变为各 commit 的父版本）。

### 最小步骤

```powershell
# 1) 拉取上游新版本（假设本地 upstream 远程指向 microsoft/vscode）
git fetch upstream
git tag 1.100.0 upstream/1.100.0        # 或直接使用对应 commit

# 2) 把这批提交整体 rebase 到新基线（只在这一步解决冲突，其余自动）
git checkout vscode-fork-dev
git rebase 1.100.0
#    - 无冲突的提交自动重放
#    - 冲突会停住：手动改 -> git add -> git rebase --continue
#    - 若某提交功能上游已自带，可 git rebase --skip 丢弃

# 3) 用新基点重新导出 batch（工具无需改，只换 -Base / 更新 _BASE.txt）
#    方式 A：直接指定新基点
powershell -ExecutionPolicy Bypass -File make_patches.ps1 -Base <1.100.0的commit> -Full
#    方式 B：先更新 patches/_BASE.txt 为新基点，再 -Full（之后 -Incremental 也据此计算）
#           （_BASE.txt 内容改为新 commit 哈希即可，脚本会优先读取它）

# 4) 把新的 patches\ + apply.bat + apply_patches.ps1 拷到云桌面，
#    apply.bat DRY "D:\目标仓库" 确认（冲突文件会列在下方，并在文件内写 <<<<<<< 标记）、
#    apply.bat "D:\目标仓库" 应用（默认即为合并模式，高版本安全）；
#    若想和同版本强一致覆盖，才用 apply.bat FORCE。
```

### 要点

- **唯一需要人工的地方**：rebase 时与你改动**重叠**的文件（上游同位置也改了）要解冲突；不重叠的提交 git 全自动，零工作量。
- **batch 工具零改动**：`make_patches.ps1` / `apply.bat` 不用碰，只是调用时换 `-Base`。
- **绝不拿旧 `patches/` 直接套新 vscode**：必须按第 3 步重新生成。
- rebase 完成后，建议把 `patches/_BASE.txt` 更新为新基点，保证后续 `-Incremental` 增量计算正确。
- 若某几个提交的功能上游新版本已自带，**rebase 时 `git rebase --skip` 丢弃**即可，对应 batch 自然不再导出它。

### 具体示例：升级到 1.100.0

经确认，1.100.0 的 tag 指向的 base commit 为：

```
19e0f9e681ecb8e5c09d8784acaa601316ca4571
```

> 以 `git rev-parse 1.100.0` 的本地输出为准；不同镜像源打出的 tag 偶尔会有差异。

本机执行（rebase 即「适配 1.100.0」那一步）：

```powershell
# 0) 前提：工作区干净、当前在 vscode-fork-dev、1.100.0 的 commit 本地存在
git status --short
git branch --show-current
git fetch upstream --tags                # 无 upstream 远程时先：git remote add upstream https://github.com/microsoft/vscode.git
git rev-parse 1.100.0                       # 应等于 19e0f9e681ecb8e5c09d8784acaa601316ca4571

# 1) 把这批提交整体 rebase 到 1.100.0 基点（冲突处手动解决后 --continue）
git rebase 19e0f9e681ecb8e5c09d8784acaa601316ca4571

# 2) 用新基点重新导出 batch（-Full 清空旧 patches/ 重建，_BASE.txt 自动更新为新基点）
powershell -ExecutionPolicy Bypass -File make_patches.ps1 -Base 19e0f9e681ecb8e5c09d8784acaa601316ca4571 -Full

# 3) 把新 patches\ + apply.bat + apply_patches.ps1 拷到云桌面，apply.bat DRY 确认后双击
```

要点：`apply.bat` 这边**没有 Base 概念**，它只复制 `patches/` 里已导好的文件；云桌面仓库本身也需是 1.100.0，否则版本不一致会出错。
