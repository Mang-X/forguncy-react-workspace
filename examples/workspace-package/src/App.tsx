/**
 * The Cell, as an author writes it: ordinary workspace imports by package name.
 *
 * Decision source: GitHub Issue #15 — "Implement: workspace package flattening
 * PoC" (https://github.com/Mang-X/forguncy-react-workspace/issues/15), exercising
 * #14's contract (https://github.com/Mang-X/forguncy-react-workspace/issues/14).
 *
 * Two things are on purpose, and each is one of #15's acceptance criteria:
 *
 * 1. **The imports are the package names, not relative paths.** `@app/ui` and
 *    `@app/tokens` are exactly what an author types in a pnpm workspace, and this
 *    file needs no alias, no `paths` mapping and no path rewriting to work —
 *    which is #15's first criterion. Nothing below mentions a Cell, a bundler or
 *    Forguncy.
 * 2. **Only a subset of `@app/ui`'s exports is imported.** `ThemeScope` and
 *    `formatMoney` are; `excerpt` is not, and neither is `trimmed` — which
 *    `@app/ui` itself reaches two hops away. The pair is the shape #15's
 *    tree-shaking criterion needs: the used source has to be *present* in the
 *    artifact and the unused export has to be gone, and a one-sided assertion
 *    would pass on an empty artifact.
 *
 * The self-check is computed by imported workspace code rather than written here,
 * so the rendered verdict is evidence that the *package's* functions ran inside the
 * Cell instead of a copy of their source being pasted in — the same shape
 * `examples/inline-es-toolkit` uses, and for the same reason: a component that
 * merely renders a static string would prove nothing about what was bundled.
 *
 * It deliberately recomputes using **only the exports this Cell already imports**.
 * A check that reached for `excerpt` or `trimmed` would make them used, and they are
 * the two names the tree-shaking criterion needs to stay unused.
 */

import { ThemeScope, formatMoney } from "@app/ui";
import { SURFACE_RADIUS, SURFACE_STEP } from "@app/tokens";

import { ORDER_TOTAL } from "./orders";

const EXPECTED_MONEY = "CNY 1234.50";

/**
 * Fixed inputs with fixed answers, so each verdict is a claim about the compiled
 * code rather than about the environment.
 *
 * The values come from two different workspace packages — `formatMoney` from
 * `@app/ui`, the two constants from `@app/tokens`, which `@app/ui` itself reaches —
 * so a `pass` here cannot be produced by one package having been inlined while the
 * other's import quietly resolved to something else.
 */
function selfCheck(): string {
  const results = [
    `money=${formatMoney(ORDER_TOTAL) === EXPECTED_MONEY ? "pass" : "fail"}`,
    `radius=${SURFACE_RADIUS === 6 ? "pass" : "fail"}`,
    `step=${SURFACE_STEP === 2 ? "pass" : "fail"}`,
  ];
  return results.join(" | ");
}

export function App() {
  const report = selfCheck();

  return (
    <ThemeScope title="workspace package flattening PoC">
      <p data-workspace-domain="order-total">{formatMoney(ORDER_TOTAL)}</p>
      <output data-workspace-self-check={report.includes("fail") ? "fail" : "pass"}>{report}</output>
      <small>{`surface-step=${SURFACE_STEP}`}</small>
    </ThemeScope>
  );
}
