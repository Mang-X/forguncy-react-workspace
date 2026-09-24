/**
 * The reachability walk measured against the bundler that actually runs.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe engine".
 *
 * ## Why this test does not assert the walk's own output
 *
 * Seven review rounds each found the same defect family — the walk and rolldown disagreeing
 * about which files a browser build contains — and every one was invisible to the walk's own
 * tests, because a test that states what the walk *should* return only re-encodes the author's
 * understanding of manifest resolution. That understanding was wrong repeatedly: `browser`
 * remaps, remap chains, remap keying, array fallbacks, array order, condition order, comment
 * masking in unparseable files, self-referenced substitution.
 *
 * So this test **builds the fixture for real** and compares the walk's file set against the
 * files rolldown actually bundled, read from the emitted chunk's `modules` map. The bundler is
 * the oracle, because the premise of the whole probe is that a claim about an artifact is
 * answered by the artifact.
 *
 * ## Why the comparison is on files rather than on a builtin pattern
 *
 * An earlier version regexed a Node builtin out of the artifact's *text* and out of each
 * reachable file's *text*. That was wrong twice over:
 *
 * - **Text is not code.** A license banner or a string mentioning `require("fs")` made the
 *   artifact look like it needed `fs`, failing the test on a package whose verdict was
 *   correct. The walk's own scanners mask comments before matching; an oracle that does not is
 *   a second, weaker implementation of the same judgement.
 * - **A builtin-only assertion has no power over the artifacts that matter.** A false `worker`
 *   risk from a file the bundler never bundled is a real walk error that a builtin regex cannot
 *   see, so it passed.
 *
 * The file set is what the two sides actually disagree about, so it is what is compared. A
 * builtin check survives only as a *secondary* assertion, on masked text (the artifact is masked
 * too: rolldown preserves `/*!` licence banners, and one quoting `from "fs"` made an earlier
 * version fail a package whose walk and verdict were both correct).
 *
 * ## Tree-shaking: why `bundled ⊆ reachable` is asserted and the reverse is not
 *
 * rolldown drops modules whose bindings are unused, so a file the walk reached but the bundler
 * shook out was genuinely reached, and *reaching* it is defensible — the walk is the pre-shake
 * elimination set and applies no tree-shaking. What is not defensible is a **finding** drawn
 * from such a file, because the artifact does not contain it. Measured: an unused named import
 * whose module called `new Worker(` produced a `worker` risk, and the same shape with
 * `process.dlopen` produced a rejection, while rolldown built a clean artifact both times.
 *
 * So the assertions are: every bundled file is reachable, and no finding's evidence names a
 * reached-but-not-bundled file. The engine enforces the second directly for both channels — the
 * scans are bounded by the bundler's own `modules` — and this test checks it independently.
 *
 * Local checks only: rolldown is the same bundler the Cell compiler uses, not a Forguncy
 * runtime.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import type { OutputAsset, OutputChunk } from "rolldown";
import { describe, expect, it } from "vitest";

import { applyBrowserField, resolveBrowserEntryPaths, selfReferenceResolver } from "./browser-entry.ts";
import { runCandidateBuild } from "./build.ts";
import { runDependencyProbe } from "./probe-engine.ts";
import { collectReachableSourceFiles, sourceWithoutCommentsLenient } from "./module-source.ts";

/**
 * A synthetic package, reduced to the shape a review round found the walk disagreeing about.
 *
 * `expectShakenOut` names files the bundler may legitimately drop. A case that expects a file
 * to be reachable *and* bundled leaves it out, which is the assertion that has the power to
 * catch a walk that followed the wrong file.
 */
interface OracleCase {
  readonly name: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly files: Readonly<Record<string, string>>;
  /** Files whose presence in the bundle is asserted. Omitted files are not checked. */
  readonly mustBundle?: readonly string[];
  /** Files whose *absence* from the bundle is asserted — the false-positive shapes. */
  readonly mustNotBundle?: readonly string[];
}

const NODE_ONLY = "import { readFileSync } from 'node:fs';\nconsole.log(readFileSync);\nexport const v = 1;\n";
const CLEAN = "console.log('ran');\nexport const v = 1;\n";

const CASES: readonly OracleCase[] = [
  {
    name: "no remap (control)",
    manifest: { main: "./index.js" },
    files: { "index.js": CLEAN },
    mustBundle: ["index.js"],
  },
  {
    name: "browser remap, single hop",
    manifest: { main: "./index.js", browser: { "./index.js": "./index.browser.js" } },
    files: { "index.js": NODE_ONLY, "index.browser.js": CLEAN },
    mustBundle: ["index.browser.js"],
    mustNotBundle: ["index.js"],
  },
  {
    name: "browser remap, two-hop chain",
    manifest: { main: "./index.js", browser: { "./index.js": "./a.js", "./a.js": "./b.js" } },
    files: { "index.js": NODE_ONLY, "a.js": NODE_ONLY, "b.js": CLEAN },
    mustBundle: ["b.js"],
    mustNotBundle: ["index.js", "a.js"],
  },
  {
    name: "browser remap on a relative import",
    manifest: { main: "./index.js", browser: { "./impl.js": "./impl.browser.js" } },
    files: { "index.js": 'export { v } from "./impl.js";\n', "impl.js": NODE_ONLY, "impl.browser.js": CLEAN },
    mustBundle: ["impl.browser.js"],
    mustNotBundle: ["impl.js"],
  },
  {
    name: "browser remap keyed on the resolved file, request without an extension",
    // The request-vs-resolved bug: a resolver substitutes the *resolved* file, so a key of
    // `./impl.js` applies to `from "./impl"`.
    manifest: { main: "./index.js", browser: { "./impl.js": "./impl.browser.js" } },
    files: { "index.js": 'export { v } from "./impl";\n', "impl.js": NODE_ONLY, "impl.browser.js": CLEAN },
    mustBundle: ["impl.browser.js"],
    mustNotBundle: ["impl.js"],
  },
  {
    name: "browser remap keyed on the resolved entry, main without an extension",
    manifest: { main: "./dist/index", browser: { "./dist/index.js": "./dist/index.browser.js" } },
    files: { "dist/index.js": NODE_ONLY, "dist/index.browser.js": CLEAN },
    mustBundle: ["dist/index.browser.js"],
    mustNotBundle: ["dist/index.js"],
  },
  {
    name: "browser remap keyed on a directory index",
    manifest: { main: "./index.js", browser: { "./sub/index.js": "./sub/index.browser.js" } },
    files: { "index.js": 'export { v } from "./sub";\n', "sub/index.js": NODE_ONLY, "sub/index.browser.js": CLEAN },
    mustBundle: ["sub/index.browser.js"],
    mustNotBundle: ["sub/index.js"],
  },
  {
    name: "browser remap on a subpath resolved through exports",
    // The substitution has to apply to a self-reference target too, not only a relative import.
    manifest: {
      name: "oracle",
      exports: { ".": "./index.js", "./s": "./impl.js", "./package.json": "./package.json" },
      browser: { "./impl.js": "./impl.browser.js" },
    },
    files: { "index.js": 'export { v } from "oracle/s";\n', "impl.js": NODE_ONLY, "impl.browser.js": CLEAN },
    mustBundle: ["impl.browser.js"],
    mustNotBundle: ["impl.js"],
  },
  {
    name: "browser remap on an imports-map target",
    manifest: {
      name: "oracle",
      exports: { ".": "./index.js", "./package.json": "./package.json" },
      imports: { "#impl": "./impl.js" },
      browser: { "./impl.js": "./impl.browser.js" },
    },
    files: { "index.js": 'export { v } from "#impl";\n', "impl.js": NODE_ONLY, "impl.browser.js": CLEAN },
    mustBundle: ["impl.browser.js"],
    mustNotBundle: ["impl.js"],
  },
  {
    name: "exports array, first clean",
    manifest: { exports: { ".": ["./browser.js", "./node.js"] } },
    files: { "browser.js": CLEAN, "node.js": NODE_ONLY },
    mustBundle: ["browser.js"],
    mustNotBundle: ["node.js"],
  },
  {
    name: "exports array, order reversed",
    manifest: { exports: { ".": ["./node.js", "./browser.js"] } },
    files: { "browser.js": CLEAN, "node.js": NODE_ONLY },
    mustBundle: ["node.js"],
  },
  {
    name: "condition key order: default before browser",
    // Node and rolldown both take the first key whose condition is active, so `default` listed
    // first wins over `browser`. The walk used a preference ranking and took `browser`, which
    // disagreed with both.
    manifest: { exports: { ".": { default: "./n.js", browser: "./b.js" }, "./package.json": "./package.json" } },
    files: { "b.js": CLEAN, "n.js": NODE_ONLY },
    mustBundle: ["n.js"],
    mustNotBundle: ["b.js"],
  },
  {
    name: "condition key order: browser before default",
    manifest: { exports: { ".": { browser: "./b.js", default: "./n.js" }, "./package.json": "./package.json" } },
    files: { "b.js": CLEAN, "n.js": NODE_ONLY },
    mustBundle: ["b.js"],
    mustNotBundle: ["n.js"],
  },
  {
    name: "an inactive condition is skipped for a later active one",
    // `require` is not active for an ESM browser bundle, so the resolver moves past it to
    // `default`. This is the case that pins `ACTIVE_EXPORT_CONDITIONS` against the bundler: a
    // set that wrongly included `require` would pick `r.js` here.
    manifest: { exports: { ".": { require: "./r.js", default: "./b.js" }, "./package.json": "./package.json" } },
    files: { "r.js": NODE_ONLY, "b.js": CLEAN },
    mustBundle: ["b.js"],
    mustNotBundle: ["r.js"],
  },
  {
    name: "the module condition is active",
    // `module` is a bundler condition, not a Node one, so it has to be in the active set or
    // the walk disagrees with rolldown by skipping it.
    manifest: { exports: { ".": { module: "./m.js", default: "./n.js" }, "./package.json": "./package.json" } },
    files: { "m.js": CLEAN, "n.js": NODE_ONLY },
    mustBundle: ["m.js"],
    mustNotBundle: ["n.js"],
  },
  {
    name: "the node condition is inactive for a browser build",
    manifest: { exports: { ".": { node: "./n.js", default: "./b.js" }, "./package.json": "./package.json" } },
    files: { "n.js": NODE_ONLY, "b.js": CLEAN },
    mustBundle: ["b.js"],
    mustNotBundle: ["n.js"],
  },
  {
    name: "self-reference through exports",
    manifest: {
      name: "oracle",
      exports: { ".": "./index.js", "./server": "./lib/server.js", "./package.json": "./package.json" },
    },
    files: { "index.js": 'export { v } from "oracle/server";\n', "lib/server.js": NODE_ONLY },
    mustBundle: ["lib/server.js"],
  },
  {
    name: "imports map",
    manifest: {
      name: "oracle",
      exports: { ".": "./index.js", "./package.json": "./package.json" },
      imports: { "#impl": "./src/impl.js" },
    },
    files: { "index.js": 'export { v } from "#impl";\n', "src/impl.js": NODE_ONLY },
    mustBundle: ["src/impl.js"],
  },
  {
    name: "imports array order",
    manifest: {
      name: "oracle",
      exports: { ".": "./index.js", "./package.json": "./package.json" },
      imports: { "#a": ["./b.js", "./a.js"] },
    },
    files: { "index.js": 'export { v } from "#a";\n', "b.js": CLEAN, "a.js": NODE_ONLY },
    mustBundle: ["b.js"],
    mustNotBundle: ["a.js"],
  },
  {
    name: "a risk in a file tree-shaking removes is not reported",
    // `sideEffects: false` plus an unused *named* import is the one shape where rolldown alone
    // shakes a module out (measured: `export {x} from` and `export *` both keep it). The walk
    // applies no tree-shaking, so it reaches `w.js` — which is fine — but a finding drawn from
    // that file is not, because the artifact has no `new Worker(` in it.
    manifest: { main: "./index.js", sideEffects: false },
    files: {
      "index.js": 'import { dead } from "./w.js";\nexport const live = 1;\n',
      "w.js": "export const dead = () => new Worker('./x.js');\nexport const other = 2;\n",
    },
    mustBundle: ["index.js"],
    mustNotBundle: ["w.js"],
  },
  {
    name: "a native indicator in a shaken-out file is not reported",
    // The case both the risk bound and the file-set assertion missed. `process.dlopen` is a
    // *call*, so no import names it and rolldown neither resolves nor fails on it: it just
    // drops the module whose binding is unused. Measured: build passed, artifact had no
    // `dlopen`, and the report refused the package for a native addon. The evidence token had
    // to carry the file for this assertion to be able to see it at all.
    manifest: { main: "./index.js" },
    files: {
      "index.js": 'import { dead } from "./w.js";\nexport const live = 1;\n',
      "w.js": "export const dead = () => process.dlopen({}, './a.node');\nexport const other = 2;\n",
    },
    mustBundle: ["index.js"],
    mustNotBundle: ["w.js"],
  },
  {
    name: "a licence banner quoting an import is not read as code",
    // rolldown preserves `/*!` and `@license` banners. A banner quoting `from "fs"` must not
    // make the artifact look like it needs `fs` — measured as a false alarm on a clean package.
    manifest: { main: "./index.js" },
    files: { "index.js": '/*! Copyright X. Example: import x from "fs" */\nexport const live = 1;\n' },
    mustBundle: ["index.js"],
  },
  {
    name: "node build beside a browser entry",
    manifest: {
      exports: { ".": { browser: "./index.browser.js", import: "./index.js" }, "./package.json": "./package.json" },
    },
    files: { "index.browser.js": CLEAN, "index.js": NODE_ONLY },
    mustBundle: ["index.browser.js"],
    mustNotBundle: ["index.js"],
  },
];

/**
 * A bare specifier imported by `source` that is a **Node builtin**.
 *
 * The builtin list comes from Node itself (`builtinModules`) rather than from the walk's
 * `NODE_ONLY_BUILTINS`, and that independence is the point: an oracle judging builtins by the
 * same set the walk uses would inherit the walk's blind spots and report agreement whenever
 * both were wrong.
 */
function namesBuiltin(source: string): boolean {
  const specifiers = [
    ...source.matchAll(/\bnode:[a-z_][a-z_/]*/g),
    ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ];
  return specifiers.some(match => {
    const raw = match[0].startsWith("node:") ? match[0] : (match[1] ?? "");
    const bare = raw.startsWith("node:") ? raw.slice("node:".length) : raw;
    if (bare.startsWith(".") || bare.startsWith("#") || bare.startsWith("@") || bare.length === 0) {
      return false;
    }
    return BUILTIN_MODULES.has(bare.split("/")[0]!);
  });
}

/** Node's own builtin names, so the oracle does not share the walk's notion of one. */
const BUILTIN_MODULES: ReadonlySet<string> = new Set(builtinModules.map(name => name.replace(/^node:/, "")));

/**
 * Writes a project whose installed `oracle` package is the fixture.
 *
 * The package lives under `node_modules/oracle/` rather than at the project root because
 * `runCandidateBuild` builds a synthetic entry that imports the package **by name**, so the
 * package has to be resolvable from the project.
 */
async function makePackage(oneCase: OracleCase): Promise<{ readonly projectRoot: string; readonly packageRoot: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), "fgc-oracle-"));
  const packageRoot = join(projectRoot, "node_modules", "oracle");
  const manifest = { name: "oracle", version: "1.0.0", license: "MIT", type: "module", ...oneCase.manifest };
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(projectRoot, "package.json"), JSON.stringify({ name: "oracle-project", version: "0.0.0", private: true, type: "module" }), "utf8");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify(manifest, null, 2), "utf8");
  for (const [name, contents] of Object.entries(oneCase.files)) {
    const path = join(packageRoot, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
  return { projectRoot, packageRoot };
}

/**
 * The fixture files rolldown actually bundled, as package-relative paths.
 *
 * Filtered by **containment only**: the synthetic probe entry, the rolldown runtime and
 * anything else outside the fixture package are the harness, and nothing else is excluded.
 *
 * Deliberately *not* filtered by a `.fgc` name test. An earlier version dropped any id
 * containing `.fgc`, which is the probe's scratch directory name — but the scratch tree lives
 * at the project root and never appears under `packageRoot`, so that filter could only ever
 * drop real fixture files (`src/.fgc/x.js`, `.fgc-helper.js`). Since this function is the
 * oracle's ground truth, the bug made the oracle blind to exactly the files whose treatment it
 * exists to check: it passed while the engine reported `supports-deployment` for a package
 * whose bundled `src/.fgc/x.js` contained a `dlopen`.
 */
function bundledFiles(output: readonly (OutputChunk | OutputAsset)[] | undefined, packageRoot: string): readonly string[] {
  const ids = (output ?? [])
    .filter((item): item is OutputChunk => item.type === "chunk")
    .flatMap(item => Object.keys(item.modules ?? {}));

  const inside: string[] = [];
  for (const id of ids) {
    // A virtual module id (`\0rolldown/runtime.js`) is not a file on disk.
    if (id.startsWith("\u0000")) {
      continue;
    }
    const relativePath = relative(packageRoot, id);
    // `..` as a path segment, not a prefix: a fixture may ship `..helper.js`.
    if (isAbsolute(relativePath) || relativePath.split(sep).includes("..")) {
      continue;
    }
    inside.push(relativePath.split(sep).join("/"));
  }
  return [...new Set(inside)].sort();
}

describe("the reachability walk agrees with rolldown", () => {
  for (const oneCase of CASES) {
    it(`agrees for: ${oneCase.name}`, async () => {
      const { projectRoot, packageRoot } = await makePackage(oneCase);
      const manifest = { name: "oracle", ...oneCase.manifest };

      const build = await runCandidateBuild({ projectRoot, packageName: "oracle" });
      const { entries } = resolveBrowserEntryPaths(manifest);
      const reachable = await collectReachableSourceFiles(
        packageRoot,
        entries,
        selfReferenceResolver(manifest),
        request => applyBrowserField(manifest, request),
      );
      const reachablePaths = reachable.files.map(file => file.relativePath);

      if (build.outcome === "failed") {
        // A failed build still has to be explained by the walk when it failed on a builtin —
        // otherwise the report claims no builtin for a build that could not be made.
        const failedOnBuiltin = namesBuiltin(build.validation.diagnostics.join("\n"));
        if (failedOnBuiltin) {
          const walkSawBuiltin = reachable.files.some(file => namesBuiltin(file.masked));
          expect(
            walkSawBuiltin,
            `${oneCase.name}: rolldown failed on a Node builtin, but the walk reported none. Reachable: ${reachablePaths.join(", ") || "(none)"}`,
          ).toBe(true);
        }
        // Not asserted further: a build that failed for another reason (a query plugin this
        // bundler lacks, a deliberately absent file) is outside the walk's judgement.
        return;
      }

      // The bundled set is the ground truth. Every bundled fixture file must be reachable:
      // a file in the artifact the walk did not reach is exactly the false-negative shape.
      const bundled = bundledFiles(build.output, packageRoot);
      for (const file of bundled) {
        expect(
          reachablePaths,
          `${oneCase.name}: rolldown bundled "${file}", which the walk did not reach. Walk reached: ${reachablePaths.join(", ") || "(none)"}`,
        ).toContain(file);
      }

      // And the named false-positive files must be absent from the bundle, which is what makes
      // their absence from the walk's report correct rather than lucky.
      for (const file of oneCase.mustNotBundle ?? []) {
        expect(
          bundled,
          `${oneCase.name}: the fixture expected "${file}" to be shaken out, but rolldown bundled it — the case no longer tests what it says`,
        ).not.toContain(file);
      }
      for (const file of oneCase.mustBundle ?? []) {
        expect(
          bundled,
          `${oneCase.name}: the fixture expected "${file}" to be bundled, but rolldown did not`,
        ).toContain(file);
      }

      // Secondary: masked text, so a comment or string cannot move the verdict either way.
      // The artifact **must** be masked too: rolldown preserves `/*!` and `@license` banners,
      // and a banner quoting `import x from "fs"` made this assertion fail on a package whose
      // walk and verdict were both correct. Measured: the banner text survives into the chunk.
      const artifactHasBuiltin = namesBuiltin(
        sourceWithoutCommentsLenient(
          (build.output ?? [])
            .filter((item): item is OutputChunk => item.type === "chunk")
            .map(item => item.code)
            .join("\n"),
        ),
      );
      const walkSawBuiltin = reachable.files.some(file => namesBuiltin(file.masked));
      if (artifactHasBuiltin) {
        expect(
          walkSawBuiltin,
          `${oneCase.name}: the artifact contains a Node builtin, but the walk reported none. Reachable: ${reachablePaths.join(", ")}`,
        ).toBe(true);
      }

      // A file the walk reached but rolldown did not bundle is allowed only when the walk
      // draws **no finding** from it. Reaching it is the pre-tree-shaking elimination set and
      // may legitimately be larger (documented below); *reporting* from it is not, because the
      // artifact does not contain it.
      //
      // Checked over the real report rather than over builtins, because the risk channel is
      // where this bites: measured on `{"sideEffects": false}` with an unused named import,
      // rolldown shook `w.js` out while `runtime-pattern-scan` still reported the
      // `new Worker(` in it — a risk from a file with no `new Worker(` in the artifact. A
      // builtin-only check cannot see that, since `worker` is not a builtin.
      const bundledSet = new Set(bundled);
      const overFollowed = new Set(reachablePaths.filter(path => !bundledSet.has(path)));
      if (overFollowed.size > 0) {
        const probe = await runDependencyProbe({ projectRoot, packageName: "oracle", cache: false });
        const allEvidence = [
          ...probe.report.risks.flatMap(risk => risk.evidence),
          ...probe.report.rejectionFindings.flatMap(finding => finding.evidence),
        ];
        for (const path of overFollowed) {
          expect(
            allEvidence.some(item => item.includes(path)),
            `${oneCase.name}: the walk reached "${path}", which rolldown shook out of the bundle, and reported a finding from it. Evidence: ${allEvidence.join(", ") || "(none)"}`,
          ).toBe(false);
        }
      }
    });
  }
});
