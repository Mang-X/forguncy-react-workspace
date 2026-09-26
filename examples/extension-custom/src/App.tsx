import { createChart, renderChart } from "@example/chart-kit";

/**
 * The authored source that makes a non-built-in extension's import real — Issue #85's fixture.
 *
 * Decision sources: GitHub Issues
 * - #85 — "扩展配置：建立项目级 mappings 输入与统一校验入口"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/85)
 * - #12 — "Spec: `extension` dependencies as external modules + `frontendLibraries`
 *   metadata" (https://github.com/Mang-X/forguncy-react-workspace/issues/12)
 *
 * Three things about this file are the test, and each is deliberate:
 *
 * 1. **The import is an ordinary npm import.** No Forguncy global, no
 *    `frontendLibraries` reference, no annotation — #12's first acceptance criterion is
 *    that the authored source is untouched, and source that had to be written specially
 *    would be evidence against that rather than for it.
 * 2. **`@example/chart-kit` is not installed and does not exist.** So a compile of this
 *    file can only succeed if the mapping's resolver hook answered the specifier before
 *    node resolution ran. A missing interception is a loud `UNRESOLVED_ENTRY`-class
 *    failure rather than a quiet inline of an npm copy — the same reason
 *    `examples/host-antd` leaves `antd` uninstallable.
 * 3. **Two named imports from one module.** Named bindings are the shape a consumer's
 *    namespace import exercises through the bundler's enumeration, and `@example/chart-kit`
 *    is one module id here: the generated module exports the page object itself, so a
 *    named import cannot read `undefined` merely because of how it was written.
 *
 * What this file does *not* establish: that the extension exists, that the page global is
 * present, or that anything renders. Locally there is no page — #88 is where a real
 * extension is validated on one — and AGENTS.md rule 7 forbids reporting a local green
 * build as runtime compatibility.
 */
export function App() {
  // Read off the page global the mapping names, so a compile that bound the wrong global
  // fails here rather than rendering a blank panel.
  const report = typeof createChart === "function" && typeof renderChart === "function" ? "pass" : "fail";

  return (
    <section data-extension-custom="self-check">
      <h1>extension @example/chart-kit PoC</h1>
      <output>{`imports=${report}`}</output>
    </section>
  );
}
