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
  "validatedAgainstRuntime": false,    // 置 true 需 cite runtime-observation 且 smoke 步骤通过
  "evidence": [{ "kind": "spec-issue", "reference": "…" }]
}
```

架构拒绝（能力归 Forguncy）**不要**手写 `rejection`：`rejection` 就是归属评估自己给的那条，手写会被 `record` 拒绝（code 必须一致）。同理，架构拒绝不记 `alternatives`——替代的是能力的所有者（宿主），不是包。

## 脚本对决策文件做的事

- **归属**：跑 `assessDependencyRole(packageName, role)`。是平台冲突 → 走架构分支。
- **probe**：架构拒绝不 probe（其证据是归属决策）；其余策略 probe 该包，并**以 probe 报告作为证据**，不接受"文档说可以"。
- **audit**：跑 `auditSelectionDecision`，检查归属门、决策欠的证据、报告是否关于这个包、技术拒绝是否绑定机器观测到的发现、repair recipe 是否满足三条件。**有问题就拒绝写入。**
- **写入**：`recordDependencyDecision` 合并进 `fgc.lock.json`（读-改-写，合并而非覆盖，证据是并集）。

脚本会**自动**为决策补两条 `spec-issue` 链接：#16（决策所依据的 Spec），以及架构拒绝时的 #4（#8 规则 5 要求架构冲突可追溯到归属决策）。URL 从 `core` 读出，不硬编码。

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
