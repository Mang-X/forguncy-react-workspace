# 记录决策

来源：Spec #8（`fgc.lock.json` 契约、证据链接、新鲜度）、#16 第 7 条（"通过 #8 持久化成功/失败决策，避免重复调查"）。

## 决策文件

**Agent 产出，脚本从不代填。** 脚本不知道策略，也不判归属——它只校验、测量、持久化。

```jsonc
{
  "packageName": "es-toolkit",
  "role": "cell-local-ui",        // 归属问题按 (能力, 包) 对评估；不给则拒绝，脚本不猜
  "strategy": "inline",           // host | inline | extension | replace

  // extension / replace 必填：PR diff 要能解释策略选择
  "rationale": "…",

  // 技术拒绝（replace + kind: technical）必填：已评估的替代项
  "alternatives": ["…"],
  "rejection": {
    "kind": "technical",
    "code": "platform-api-unavailable",   // 必须是 probe 观测到的发现所映射的 code
    "summary": "…", "evidence": ["…"], "remediation": "…"
  },

  // strategy: host / extension 时必填
  "globalName": "React",
  // strategy: extension 时另需
  "libraryId": "tanstack-query",
  "extensionVersion": "5.102.8",
  "extensionIdentity": "sha256:…",

  "cellTarget": null,                  // 默认 null，即适用于每个 target
  "imports": ["debounce"],             // 可选：Cell 会具名导入的绑定，让尺寸估算偏向"小"（非下界）。
                                       // 省略或 null = 整个命名空间（估算偏向"大"）。详见下节。
  "validatedAgainstRuntime": false,    // 置 true 需 cite runtime-observation 且 smoke 步骤通过
  "evidence": [{ "kind": "spec-issue", "reference": "…" }]
}
```

### 决策文件里**没有** `artifactEvidence`

这是 Agent 输入与脚本产出之间最容易搞错的一处，所以单列一节。

`artifactEvidence` 是**锁记录的字段**，不是决策文件的字段。`rejection.code` 为
`cell-code-budget-exceeded` 时，决策文件只**声明这条拒绝是哪一条**（code 加上
`cellTarget` 指向的 Cell）；两个字符数是 `audit` / `record` **真的编译该 Cell** 之后，
从编译器自己的诊断里取出、由脚本写进锁的。

**手填会被当场拒绝，而不是被忽略**：`decisionFromFile` 对
`document.artifactEvidence !== undefined` 直接 fail（"a compile measurement is not the
caller's to state"）。忽略一个文件特意写上的字段，会让调用者以为自己填的数字被采纳了。

这条拒绝是 #77 round 5 的结论：revision 14 曾接受文件里的两个数字，于是调用者可以挑任意
`codeCharacters > budgetCharacters` 给自己背书——两个自证的数字，与 revision 13 移除的合成
probe finding 一样不可信。

锁记录长这样（**由脚本写入**，供核对，不要手改）：

```jsonc
{
  "packageName": "es-toolkit",
  "cellTarget": "capped",
  "strategy": "replace",
  "rejection": { "kind": "technical", "code": "cell-code-budget-exceeded", … },
  "artifactEvidence": {                // 脚本编译该 Cell 后写入，逐字取自编译器诊断
    "compileFingerprint": "cell=\"…\";budget=8000",
    "subjectDecision": { "strategy": "inline" },   // 被拒前该包在该 Cell 里的策略
    "subjectRenderedCharacters": 10597,             // 该包自己贡献的字符数（bundler 记账）
    "codeCharacters": 15074,                        // 编译器对该 Cell 报出的实际测量值
    "budgetCharacters": 8000                        // 那次编译实际用的上限
  }
}
```

字段的含义与校验见下面「硬上限判定」。`status` 会重新编译并核对其中每一项，被改过的数字
报 `artifact-verdict-changed` / `artifact-attribution-changed`。

架构拒绝（能力归 Forguncy）**不要**手写 `rejection`：`rejection` 就是归属评估自己给的那条，手写会被 `record` 拒绝（code 必须一致）。同理，架构拒绝不记 `alternatives`——替代的是能力的所有者（宿主），不是包。

## `cellTarget` 与 `imports`：一个 Cell，两个声明输入

这两项都进 probe 的**指纹**，所以它们必须是**测量时**就定好的输入，而不是事后从记录里猜出来的：

- **`cellTarget`**：这个决策作用于哪个 Cell（`forguncy.config` 里的 `cells.<id>`）。它决定 probe 用哪个 `output.codeBudgetCharacters` 作为上限来**估算**。决策文件里写了就等于 `--cell`，命令行**不必**再重复一遍；两处都写且不一致会被拒绝（一个记录只能对应一个 Cell 身份）。
- **`imports`**：Cell 会具名导入的绑定列表。它让 probe 的合成入口从 `import * as candidate` 变成 `import { … }`，从而改变估算的**偏向方向**：具名时数字**偏小**（大概低估），命名空间时**偏大**（大概高估）。

  两个方向都只是**偏向**，**都不是上下界**（#77 revision 13 用 `react-library` 的 `DatePicker` 反例推翻了两个方向的关系，见 `size.ts`），因此也**都不授权任何拒绝**——probe 在任何 surface 下都不产生 `cell-artifact-budget-exceeded`。

  字段是**集合**：排序去重后落盘，`["a","b"]` 与 `["b","a"]` 必然是同一份字节。空数组不是合法写法——"整个命名空间"的写法是 `null` 或省略。

### 硬上限判定不由 probe 给出（#77 revision 13）

`--cell` 声明的上限会被**估算**并与 `size.codeCharacters` 比较，比较结果作为 `artifact.budgetCharacters` 事实记入报告，但 **probe 在任何情况下都不产生 `cell-artifact-budget-exceeded`**，`imports` 偏向"下"也不产生。原因有二，且都与"这个数字不是那个数字"有关：

1. probe 用原始 Rolldown 构建一个**合成候选**；编译器的 Cell 构建会装上 `createInterceptionResolver`，把 `host`/`extension` 依赖换成虚拟模块或页面全局。两个构建的**解析图不同**，所以 probe 的产物可以**大于**真实 Cell。仓库里的 `react-library` fixture 就是反例：`DatePicker` 的**具名** probe 会把 npm `react` 的 `createElement` 内联进去，而真实编译会把 `react` 解析到宿主 React——真实 Cell 反而更小。
2. `imports` 是**调用方的声明**，不是从 Cell 读出来的事实：Cell 可能导入了却因未使用被 tree-shake 掉，声明也可能与源码不符。

因此 `cell-artifact-budget-exceeded` 的**唯一**权威是编译器：`auditCodeBudget` 对**合成后的 Cell 源码**应用 `codeBudgetCharacters`，那里入口是 Cell 自己的、解析图是真的。probe 报告里的尺寸数字是**估算**，供 Agent 参考；它不是拒绝依据。`PROBE_STEPS_OBSERVING_SIGNAL` 里这个信号没有任何观测步骤，所以一份把该 finding 归到任何 probe 步骤的报告会被 `validateProbeReport` 判为**无效**，而不只是"不推荐"。

**但这个真实的编译器判定是可记录的**，而且**测量由脚本自己做**：决策文件写
`rejection.code = "cell-code-budget-exceeded"`（外加它作用于哪个 Cell），`audit` / `record`
就真的编译那个 Cell，把结果写进锁记录的 `artifactEvidence`。文件**不提供**任何数字——见
上面「决策文件里没有 `artifactEvidence`」。

- `codeCharacters` 是编译器对该 Cell 报出的实际测量值，`budgetCharacters` 是那次编译实际用的上限。两者都要记，是因为这样结论才**可核对**：只有 `codeCharacters > budgetCharacters` 才支持这条拒绝，校验会当场核对，对不上就拒绝记录。
- `budgetCharacters` **必然等于**该 Cell 在 `forguncy.config` 里声明的 `output.codeBudgetCharacters`（`--cell` / 决策文件的 `cellTarget` 指向的那个），因为它就是从那次编译的 plan 里读出来的。Cell 没有声明上限时编译根本不产生这个诊断，拒绝会以「declares no output.codeBudgetCharacters」被拒——所以"针对一个没人设过的天花板声称超限"这种记录在结构上无法产生。
- `compileFingerprint` / `subjectDecision` / `subjectRenderedCharacters` 一并记录，是 `status` 能重新编译并核对这条记录的依据（被改过的数字报 `artifact-verdict-changed` / `artifact-attribution-changed`）。
- 反过来，其它 code 的记录**不会**带 `artifactEvidence`：那些 code 是 probe 能观测的，脚本只在 `isArtifactObservedRejectionCode` 为真时编译取数，所以带上编译数字的 probe 拒绝在结构上产生不了。
- 这条记录的 evidence profile 是 `artifact-rejection`（**不是** `technical-rejection`）：它要求 probe **通过**——包本身没问题，超限的是合成出来的 Cell。这正是"好包 + 过大 Cell"这个预期状态之所以能落盘的原因。
- revision 14 之前写的 `cell-code-budget-exceeded` 记录**仍然可读**，只是 stale（`artifact-evidence-missing`），需要从新的证据路径重新记录。不升 schema、不静默删除或改判——见 `lock-migration.ts` 的契约。

## 脚本对决策文件做的事

- **归属**：跑 `assessDependencyRole(packageName, role)`。是平台冲突 → 走架构分支。
- **probe**：架构拒绝不 probe（其证据是归属决策）；其余策略 probe 该包，并**以 probe 报告作为证据**，不接受"文档说可以"。
- **audit**：跑 `auditSelectionDecision`，检查归属门、决策欠的证据、报告是否关于这个包、技术拒绝是否绑定机器观测到的发现、repair recipe 是否满足三条件。
- **conformance**：把决策放进候选锁，跑 `validateLockDecisionConformance`——`extension` 的 `libraryId` 必须来自已验证目录或真实 `listFrontendLibraries` 清单；`host` 的 `globalName` 必须是目标真的提供的全局。**只拦 error**，warning 是"关于 Cell 的事实"，不阻断。
- **写入**：读锁 → 合并 → 过上述全部检查 → 才 `writeFgcLock`。**任一检查不通过就不落盘**。

`writeFgcLock` 的替换是**原子**的（同目录临时文件 → `rename` 覆盖目标）。这在本流程里是**契约，不是锦上添花**：上面的证据回滚把「写锁抛错」读作「锁没变」，若底层用普通 `writeFile`（以 `w` 打开会**先截断**），中途失败就会留下半份锁——于是回滚删掉本次证据、而 stderr 还说「Nothing was written」，最坏的三件事同时发生。原子替换后目标只可能是旧文档或新文档，绝不会是混合体。

`--extension-catalog` 可覆盖默认目录，且接受 #12 的两种来源，二者**不可互换**：

| 输入 | shape | 怎么用 |
|---|---|---|
| 已验证 mapping 目录 | `packageName` / `libraryId` / `globalName` 行 | 直接作为目录用——它**声明了**每个 npm 包由哪个扩展提供 |
| 原始 `listFrontendLibraries` 清单 | `id` / `name` / `globalName` / `exists` / `typeDefinitionAvailable` | 拿**本仓库声明的行**去比对该清单（`auditExtensionLibraryMetadata`）；`name` 是显示名，**绝不**当作 npm 包名 |

清单**不能**用来建立"某个扩展提供某个包"这条关系——那条关系只记录在声明的表里。所以清单里出现一个本仓库未声明的包时，会报 `extension-mapping-not-declared`，告诉你该换输入，而不是让你去找一行来加。

脚本会**自动**为决策补两条 `spec-issue` 链接：#16（决策所依据的 Spec），以及架构拒绝时的 #4（#8 规则 5 要求架构冲突可追溯到归属决策）。URL 从 `core` 读出，不硬编码。

## 证据必须真实存在、不可被覆盖、且必须能随锁一起提交

锁里 cite 的 `probe` 链接形如 `fgc-evidence/<sha256>.json`——**与锁并列的一个目录**，不是 `.fgc/` 下。三条要求各自逼出这个设计：

**一、跑过的测量必须落盘——但只在决策被接受时。** `--no-cache` 只强制"不读缓存里的旧 report"，不会丢弃本次测量。但**测量与持久化是分开的**：`probe`/`audit` 只测量并算出"会被 cite 的地址"，不写文件；`record` 在 selection 与 conformance **全部通过之后**才写证据，然后才写锁。

这个顺序是刻意的：证据是可提交的文件，写它就是改动工作树。若在测量阶段就写，`audit`（文档明确称其为 read-only counterpart）会弄脏仓库；而被拒绝的 `record` 会在"Nothing was written"这句话下面留下一个孤儿文件。先写证据再写锁，也能保证任一步失败时不会出现"锁引用了本次没能写出的文件"。

**二、路径按内容寻址，不按 probe fingerprint。** fingerprint 不包含 smoke 模式：`--runtime-smoke` 跑出的 report 与同一次普通 probe 的 report 会是**相同 fingerprint、不同内容**。若按 fingerprint 存，后一次 hookless 运行会覆盖前一次带 smoke 的证据——锁仍写着 `target != null`／`validated`，但它 cite 的文件里已经没有当初那条 `runtime-smoke: passed`。读侧守卫（`cacheHitAnswersThisRun`）只能防"误读"，防不了"覆写"，所以证据不能与缓存共用路径：

| 位置 | 寻址方式 | 用途 |
|---|---|---|
| `.fgc/probe-cache/<fingerprint>.json` | probe 声明输入 | #17 的缓存，可被同 fingerprint 的运行覆盖。**不要 cite 它。** |
| `fgc-evidence/<content>.json` | report 字节的 sha256 | 锁 cite 的不可变工件。内容不同则路径不同，不可能互相覆盖 |

**三、必须在锁旁边，而不是 .fgc/ 里。** `fgc.lock.json` 是要被 review、被提交的，而本仓库全局忽略 `.fgc/`。证据放在那里意味着**全新 checkout 后锁 cite 的文件根本不存在**——锁仍显示 `probe.status: passed` 与非 null `target`，而引用指向空气，且没有任何读取方会察觉。对 runtime-smoke 尤其致命：静态 probe 可以在任何机器上重测，真机 smoke 结果未必能在 reviewer 机器上复现，这正是需要持久化证据的场景。

因此 `fgc-evidence/` **要随锁一起提交**。`status` 报两类问题，都列入 `blockers` 并以非零码退出：

| 字段 | 含义 |
|---|---|
| `unresolvedEvidence` | 引用不存在、读不出（含被同名目录占据） |
| `alteredEvidence` | 文件在，但**内容与文件名不符**——被误改、合并冲突解决错了、或根本不是一份合法 report |

后者是 content-addressed 语义的核心：文件名**就是**对内容的断言，因此必须校验，不能只看"路径存在"。

校验的是 **canonical report**，不是 checkout 出来的原始字节。这个区别在 Windows 上是真实的：`serializeProbeReport` 输出 LF，地址是那条 LF 字符串的 hash，而 Git 在 `core.autocrlf=true` 下 checkout 时会把文本文件改成 CRLF。若对原始字节做 hash/比对，一个**没人动过、只是从 Git 检出**的证据文件就会被误报为 `alteredEvidence`——而本仓库没有 `.gitattributes` 固定这些文件，那等于依赖每个使用者的 Git 配置。定义在 canonical report 上就不依赖任何配置：EOL 变化不改变文档含义，也就不该改变地址。篡改仍然能被发现，因为流程会**先 parse 再比对**——不是合法 report 的直接失败，字段被改的 canonicalize 后不同。

URL 形式的引用（如 `runtime-observation` 指向外部报告）不检查，因为它断言的是本命令够不到的地方。

`record` 写证据时同样校验：若目标路径已存在但内容不同（或被目录占据），直接拒绝而不是接受——否则会把错误的字节挂到新记录上，还报告成功。

同一份 report 重复测量得到同一路径（幂等，`created: false`），不同 report 永远不同路径。

## 真机验证怎么落地

`validatedAgainstRuntime: true` 要求 probe 的 `runtime-smoke` 步骤为 `passed`，而该步骤**只有 hook 真的执行并返回**时才记 `passed`（抛错记 `failed`，不传 hook 记 `skipped`）。所以：

```bash
node $S record --project <root> --runtime-smoke ./hook.mjs --decision decision.json
```

`hook.mjs` 由你提供，形态是 `RuntimeSmokeHook`：

```js
export default ({ report, output }) => ({
  facts: [{ name: "page.global", value: "forguncy" }],
  risks: [{ signal: "global-singleton-assumption", summary: "…", evidence: ["…"] }],
});
```

**不接受**"读一份 smoke 结果 JSON"作为替代：那会把"是否验证过"变成可以手写的输入，而这条分支的全部意义就是让 `passed` 由真的执行产生。hook 是你自己的本地模块，与决策文件同一信任级别。

要记 `target` 还需在决策文件里 cite 一条 `runtime-observation` 证据——`target` 的含义是"这份证据在哪个真实运行时里被验证过"，它必须指向一次观测，而不是指向本地缓存文件。

## 关于 `replace` 的两个 #8 规则

- `resolvedVersion` 必须为 `null`——`replace` 记录不为编译的 Cell 保留依赖，写版本会暗示包仍被安装。被拒的版本记在 `rejectedCandidate.version`
- 架构拒绝的 `target` 必须为 `null`：它的证据是决策本身，不能声称在某个运行时观测过。
- 技术拒绝需要 `rationale`（#4 对 `replace` 要求书面理由）。

## 新鲜度：什么时候要重测

`status` 读回锁并报告每条记录是否仍然有效（`freshness` / `stalenessReasons` / `blockers`）。失效原因：

- **精确版本变化**会让技术 probe 证据失效（除决明确证明过版本无关）。规则 2。
- **活字格运行时版本变化**会让对宿主/运行时敏感的证据失效。规则 3。
- **toolchain（Vite+ 版本）变化**会让技术 probe 证据失效。
- **probe 指纹变化**：entry / probe id / 配置 / bundler 输入变了。
- **extension 版本或身份变化**。
- `replace` 记录不参与编译：架构拒绝不被任何变化重新打开；技术拒绝会被候选、toolchain、target 变化重新打开。

`probeFingerprints` 默认 fail-closed（`{}`）：环境说不出"现在会产出什么指纹"时记 `probe-fingerprint-unknown` 并判 stale，而不是静默通过。`status` 会为每条需要 fingerprint 的记录重新推导一次。

**因此**：升级依赖版本、改 Vite+ 版本、切活字格版本之后，跑一次 `status`；stale 的记录要重新 probe 再记。

## 本地 vs 真机

记录默认 `realRuntimeValidation: "not-validated"`，`blockers` 会带 `real-runtime-not-validated`。这是**状态而非缺口**：本地 probe 过、等首次真机验证的决策就是这样。

要变成 `validated`，需要真实 Forguncy 页面上跑过（见 `report-and-handoff.md`），并在决策文件里 cite `runtime-observation` 证据 + 提供通过的 `runtime-smoke` hook。

## 报告

按 `report-and-handoff.md` 的字段输出。**本地检查与真机验证分开陈述**：绿的本地构建不是运行时兼容。
