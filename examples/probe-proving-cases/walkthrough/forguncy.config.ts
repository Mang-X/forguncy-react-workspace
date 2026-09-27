/**
 * The walkthrough project the Skill's own commands are run against.
 *
 * Decision source: GitHub Issue #91 — "修复 Skill：移除手填 artifactEvidence 指令，并执行文档示例回归"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/91) — acceptance criterion 2
 * ("超限证据由实际 Cell compile 产生") and 3 ("文档示例执行测试随 CI 运行").
 *
 * ## Why this exists at all
 *
 * `SKILL.md`'s commands have to be *runnable*, and an Agent following them needs a project
 * that declares a Cell with a cap before it has one of its own. Issue #91's confirmed defect
 * was that the documented oversize recipe told the reader to hand-copy two numbers out of a
 * compiler diagnostic — an input `scripts/select_dependency.mjs` refuses outright. A recipe
 * cannot be checked by reading it, so the documented example is executed by
 * `evals/walkthrough.test.ts`, which reads the decision files **out of `SKILL.md`** and runs
 * them here. That is why this fixture is committed rather than built per-test: a fixture a
 * test invents is a second copy of the example, and the doc could then be wrong while the
 * test stayed green — the shape #91 is about.
 *
 * ## Why the config is a plain object rather than `defineForguncyConfig`
 *
 * This directory is deliberately **not** a pnpm workspace member: it declares no
 * `package.json`, so `pnpm-workspace.yaml`'s `examples/*` glob does not pick it up and the
 * workspace graph this repository's tests read is unchanged. The consequence is that
 * `@forguncy-react-workspace/core` is not linked into any `node_modules` this directory can
 * resolve, so importing `defineForguncyConfig` here would fail to load. A plain default
 * export is a valid config — `loadForguncyConfig` validates the *loaded module* rather than
 * trusting the authoring helper, which is the property that makes a hand-written `.mjs`
 * config loadable too — and it keeps this fixture out of the workspace graph.
 *
 * ## The candidate
 *
 * `es-toolkit` is installed by the enclosing example (`examples/probe-proving-cases`), which
 * is what the probe's ancestor walk resolves against. Nothing here is installed locally.
 *
 * ## The two Cells
 *
 * `capped` declares `codeBudgetCharacters: 8000`, which this Cell's composed source genuinely
 * exceeds (~15k characters, ~10.6k of them `es-toolkit`'s) — so the compiler files its own
 * `cell-code-budget-exceeded` diagnostic and the oversize rejection has a real measurement
 * behind it. `uncapped` declares no `output` block, which is the state a project that has
 * adopted the contract but set no ceiling is in; the same rejection is refused there, and
 * that refusal is a case in the walkthrough test rather than an omission.
 */
export default {
  runtime: { forguncyVersion: "12.0.100" },
  cells: {
    capped: {
      entry: "./cells/app/src/App.tsx",
      target: { pageName: "Walkthrough", cell: "A1" },
      output: { codeBudgetCharacters: 8000, justification: "walkthrough fixture (#91)" },
    },
    uncapped: {
      entry: "./cells/app/src/App.tsx",
      target: { pageName: "Walkthrough", cell: "B2" },
    },
  },
};
