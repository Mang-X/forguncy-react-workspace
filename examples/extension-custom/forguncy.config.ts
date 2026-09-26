import { defineForguncyConfig } from "@forguncy-react-workspace/core";

/**
 * The project config that makes a non-built-in extension compile — Issue #85's fixture.
 *
 * Decision sources: GitHub Issues
 * - #85 — "扩展配置：建立项目级 mappings 输入与统一校验入口"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/85) — this file is the
 *   artifact its first acceptance criterion is about,
 * - #12 — "Spec: `extension` dependencies as external modules + `frontendLibraries`
 *   metadata" (https://github.com/Mang-X/forguncy-react-workspace/issues/12) — owns what
 *   a row must say,
 * - #26 — "Spec: project configuration and React Cell target declarations"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/26) — owns the document.
 *
 * ## What is deliberately *not* here
 *
 * No `strategy`, and no `dependencies` block. Those decide that `@example/chart-kit`
 * should be `extension`, and that decision belongs in `fgc.lock.json` (Issues #4/#8) —
 * this file only records *what the extension is*, so the decision and the mapping can be
 * reviewed separately and neither can silently override the other.
 *
 * ## The identity in this row is a placeholder, and says so
 *
 * `libraryId` and `globalName` here describe an extension this repository has not built
 * or uploaded. That is intentional for #85, whose scope is the *configuration* path: the
 * row is well-formed enough to plan and compile against (`metadataSource` names which of
 * #12's two sources the id would come from, and `metadataReference` names it), and what
 * it has not done is survive `auditExtensionLibraryMetadata` against a real
 * `api.app.listFrontendLibraries` listing. #88 is where a real extension is put on a real
 * page and that audit is what confirms the identity — so a green compile from this
 * example is evidence about the *mapping path*, never that the extension exists.
 */
export default defineForguncyConfig({
  runtime: {
    forguncyVersion: "12.0.100",
    projectAlias: "extension-custom-example",
  },
  extensions: {
    mappings: [
      {
        packageName: "@example/chart-kit",
        libraryId: "example-chart-kit",
        globalName: "ExampleChartKit",
        metadataSource: "verified-catalog",
        metadataReference: "MangMax/forguncy-react-library#example-chart-kit",
        verificationRule:
          "The catalog entry indexes the vendor modules the extension contains behind one global. The id and global here are this fixture's own; #88 confirms them against `api.app.listFrontendLibraries` on a real project before any claim about the extension is made.",
        verifiedBy: ["product-documentation"],
        note: "A project row, not a repository row: the built-in table is unchanged, and this example exists to prove a config alone can supply a mapping.",
      },
    ],
  },
  cells: {
    chartPanel: {
      entry: "./src/App.tsx",
      target: { pageName: "销售看板", cell: "B2" },
    },
  },
});
