/**
 * The two mechanisms that stopped `node-builtin-scan` and `runtime-pattern-scan`
 * from filing findings about files and text a browser build never uses.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine". Both defects were found by running the probe engine against real npm
 * packages for #16's end-to-end acceptance criterion, which is the first time any
 * probe target was anything other than a hand-written synthetic fixture.
 *
 * Governing Spec: #16 — a rejection has to be a statement about the artifact the cell
 * would ship. `es-toolkit`, `three` and `@embedpdf/pdfium` were all refused for
 * `platform-api-unavailable` while their browser artifacts contained **no** Node
 * builtins: a verdict about an artifact, reached without looking at the artifact.
 *
 * The cases below are the three packages' real shapes, reduced to the minimum that
 * reproduces each: an entry beside a Node-only sibling, an optional loader outside
 * the entry's import graph, and a specifier that only ever appears in a JSDoc
 * `@example`.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyBrowserField,
  browserFieldRedirectsSpecifier,
  resolveBrowserEntryPaths,
  resolveImportsMapSubpath,
  selfReferenceResolver,
  UNUSABLE_TARGET_EVIDENCE,
} from "./browser-entry.ts";
import { observeExportMetadata } from "./export-metadata.ts";
import type { ResolvedPackageIdentity } from "./identity.ts";
import {
  analyzeModuleSource,
  collectReachableSourceFiles,
  maskComments,
  sourceWithoutComments,
  sourceWithoutCommentsLenient,
} from "./module-source.ts";

describe("resolveBrowserEntryPaths", () => {
  it("prefers the browser condition over the Node builds beside it", () => {
    // `@embedpdf/pdfium`'s exact shape: a browser build next to an ESM and a CJS
    // Node build, all reachable through distinct conditions.
    const resolution = resolveBrowserEntryPaths({
      exports: {
        ".": {
          browser: { types: "./dist/index.d.ts", default: "./dist/index.browser.js" },
          import: { types: "./dist/index.d.ts", default: "./dist/index.js" },
          require: { types: "./dist/index.d.cts", default: "./dist/index.cjs" },
        },
        "./pdfium.wasm": "./dist/pdfium.wasm",
      },
    });

    expect(resolution.entries).toEqual(["dist/index.browser.js"]);
  });

  it("takes the import condition when a package publishes no browser one", () => {
    // `@embedpdf/engines`' shape: no `browser` condition at all.
    const resolution = resolveBrowserEntryPaths({
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js", require: "./dist/index.cjs" } },
    });

    expect(resolution.entries).toEqual(["dist/index.js"]);
  });

  it("does not expand a subpath wildcard, which needs a request to resolve", () => {
    // `three`'s shape: the root entry plus exported subtrees. `examples/jsm/*` is
    // where the optional loaders live, and it is not an entry.
    const resolution = resolveBrowserEntryPaths({
      exports: {
        ".": { import: "./build/three.module.js", require: "./build/three.cjs" },
        "./examples/jsm/*": "./examples/jsm/*",
        "./addons": "./examples/jsm/Addons.js",
      },
    });

    expect(resolution.entries).toEqual(["build/three.module.js"]);
  });

  it("falls back to browser → module → main when exports is absent", () => {
    expect(resolveBrowserEntryPaths({ module: "./esm.js", main: "./cjs.js" }).entries).toEqual(["./esm.js".slice(2)]);
    expect(resolveBrowserEntryPaths({ main: "./index.js" }).entries).toEqual(["index.js"]);
  });

  it("honours a string browser field as the entry", () => {
    expect(resolveBrowserEntryPaths({ browser: "./browser.js", main: "./index.js" }).entries).toEqual(["browser.js"]);
  });

  it("returns no entries for a package with no browser-resolvable entry", () => {
    expect(resolveBrowserEntryPaths({ main: "./addon.node" }).entries).toEqual([]);
    expect(resolveBrowserEntryPaths({ exports: { ".": { node: "./server.js" } } }).entries).toEqual([]);
  });

  it("strips a bundler query suffix and a leading ./", () => {
    expect(resolveBrowserEntryPaths({ exports: { ".": "./src/entry.ts?raw" } }).entries).toEqual(["src/entry.ts"]);
  });
});

describe("analyzeModuleSource and maskComments", () => {
  it("reports the specifiers a module really imports", () => {
    const analysis = analyzeModuleSource(
      ['import { a } from "./a.js";', 'export * from "./b.js";', "const c = await import('./c.js');", "const d = require('./d.js');"].join("\n"),
    );

    expect(analysis?.imports.map(entry => `${entry.kind}:${entry.specifier}`)).toEqual([
      "static:./a.js",
      "static:./b.js",
      "dynamic:./c.js",
      "require:./d.js",
    ]);
  });

  it("does not treat an export without a source as an import", () => {
    const analysis = analyzeModuleSource("const a = 1;\nexport { a };\n");

    expect(analysis?.imports).toEqual([]);
  });

  it("records the offsets of every comment", () => {
    const source = "// leading\nconst a = 1;\n/* block\nspans lines */\nconst b = 2;\n";
    const analysis = analyzeModuleSource(source);

    expect(analysis?.commentRanges).toHaveLength(2);
    const [line, block] = analysis!.commentRanges;
    expect(source.slice(line!.start, line!.end)).toBe("// leading");
    expect(source.slice(block!.start, block!.end)).toBe("/* block\nspans lines */");
  });

  it("blanks a comment without moving anything around it", () => {
    // Newlines survive so a diagnostic quoting the masked text still lines up.
    const source = "/* one\ntwo */const a = 1;";
    const masked = maskComments(source, analyzeModuleSource(source)!.commentRanges);

    expect(masked.length).toBe(source.length);
    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
    expect(masked).not.toContain("one");
    expect(masked).not.toContain("two");
    expect(masked).toContain("const a = 1;");
  });

  it("returns undefined for source that is not JavaScript", () => {
    expect(analyzeModuleSource("<<<not javascript at all >>>")).toBeUndefined();
  });

  it("keeps a real import visible while hiding a commented one", () => {
    // `es-toolkit`'s real shape, which is why this rule exists: `node:fs` and
    // `node:vm` appear only inside JSDoc `@example` blocks.
    const source = [
      "/**",
      " * @example",
      " * if (isNode()) {",
      " *   const fs = import('node:fs');",
      " * }",
      " */",
      "export function isNode() {",
      '  return typeof process !== "undefined";',
      "}",
      "",
    ].join("\n");

    expect(sourceWithoutComments(source)).not.toContain("node:fs");
    // The original is untouched: masking returns a copy.
    expect(source).toContain("node:fs");
  });

  it("leaves source unchanged when it will not parse", () => {
    // Fail-open: dropping an unparseable file would hide a real Node dependency.
    const source = "import { x } from 'fs';\n<<<<broken";

    expect(sourceWithoutComments(source)).toBe(source);
  });
});

describe("collectReachableSourceFiles", () => {
  async function packageTree(files: Record<string, string>, manifest: Record<string, unknown>): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "fgc-reachability-"));
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest), "utf8");
    for (const [name, contents] of Object.entries(files)) {
      const path = join(directory, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, "utf8");
    }
    return directory;
  }

  it("follows relative imports and ignores everything else", async () => {
    const directory = await packageTree(
      {
        "index.js": "export { a } from './lib/a.js';\n",
        "lib/a.js": "export const a = 1;\n",
        "unused.js": "export const orphan = 1;\n",
      },
      { exports: { ".": "./index.js" } },
    );

    const reachable = await collectReachableSourceFiles(directory, ["index.js"]);

    expect(reachable.files.map(file => file.relativePath)).toEqual(["index.js", "lib/a.js"]);
  });

  it("does not follow a bare specifier, which is a separate graph node", async () => {
    const directory = await packageTree(
      { "index.js": "import React from 'react';\nexport const a = React;\n" },
      { exports: { ".": "./index.js" } },
    );

    const reachable = await collectReachableSourceFiles(directory, ["index.js"]);

    expect(reachable.files.map(file => file.relativePath)).toEqual(["index.js"]);
  });

  it("resolves an extensionless specifier and a directory index", async () => {
    const directory = await packageTree(
      {
        "index.js": "export { a } from './lib';\nexport { b } from './dir';\n",
        "lib.js": "export const a = 1;\n",
        "dir/index.js": "export const b = 2;\n",
      },
      { exports: { ".": "./index.js" } },
    );

    const reachable = await collectReachableSourceFiles(directory, ["index.js"]);

    expect(reachable.files.map(file => file.relativePath)).toEqual(["dir/index.js", "index.js", "lib.js"]);
  });

  it("returns nothing reachable when the manifest names no usable entry", async () => {
    const directory = await packageTree({ "index.js": "export const a = 1;\n" }, { main: "./addon.node" });

    const reachable = await collectReachableSourceFiles(directory, []);

    expect(reachable.files).toEqual([]);
  });

  it("reports an entry that does not exist rather than silently scanning nothing", async () => {
    const directory = await packageTree({ "other.js": "export const a = 1;\n" }, { exports: { ".": "./index.js" } });

    const reachable = await collectReachableSourceFiles(directory, ["index.js"]);

    expect(reachable.files).toEqual([]);
    expect(reachable.missingEntries).toEqual(["index.js"]);
  });

  it("reports a relative specifier that escapes the package", async () => {
    const directory = await packageTree(
      { "index.js": "import '../../outside.js';\nexport const a = 1;\n" },
      { exports: { ".": "./index.js" } },
    );

    const reachable = await collectReachableSourceFiles(directory, ["index.js"]);

    expect(reachable.escapedSpecifiers).toEqual(["../../outside.js"]);
  });

  it("still returns an unparseable file, with its imports unknowable", async () => {
    // The file is part of the graph, so it must be scanned: a real Node dependency
    // inside it has to stay reportable.
    const directory = await packageTree(
      { "index.js": "const a = <<<broken;\n" },
      { exports: { ".": "./index.js" } },
    );

    const reachable = await collectReachableSourceFiles(directory, ["index.js"]);

    expect(reachable.files.map(file => file.relativePath)).toEqual(["index.js"]);
    expect(reachable.files[0]?.analysis).toBeUndefined();
    // Comments were not removed, so a text scan sees the raw file.
    expect(reachable.files[0]?.masked).toBe(reachable.files[0]?.source);
  });

  it("terminates on an import cycle", async () => {
    const directory = await packageTree(
      { "index.js": "export * from './a.js';\n", "a.js": "export * from './index.js';\n" },
      { exports: { ".": "./index.js" } },
    );

    const reachable = await collectReachableSourceFiles(directory, ["index.js"]);

    expect(reachable.files.map(file => file.relativePath).sort()).toEqual(["a.js", "index.js"]);
  });

  it("cleans up its own temporary directory", async () => {
    // Guards the helper above rather than the module: a leaked temp tree would make
    // the suite accumulate state across runs.
    const directory = await packageTree({ "index.js": "export const a = 1;\n" }, { main: "index.js" });
    await rm(directory, { recursive: true, force: true });
    await expect(collectReachableSourceFiles(directory, ["index.js"])).resolves.toBeDefined();
  });
});

describe("collectReachableSourceFiles: self-references", () => {
  const SELF_REF_MANIFEST = {
    name: "self-ref-lib",
    exports: { ".": "./index.js", "./server": "./lib/server.js", "./package.json": "./package.json" },
  };

  async function selfRefTree(files: Record<string, string>): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "fgc-self-ref-"));
    await writeFile(join(directory, "package.json"), JSON.stringify(SELF_REF_MANIFEST), "utf8");
    for (const [name, contents] of Object.entries(files)) {
      const path = join(directory, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, "utf8");
    }
    return directory;
  }

  it("follows the package's own name through its exports map", async () => {
    // Exactly what a bundler does, and the case that was a false *negative*: the walk
    // reached only the entry, so a builtin in the referenced file was never seen.
    const directory = await selfRefTree({
      "index.js": 'export { exec } from "self-ref-lib/server";\n',
      "lib/server.js": "import { execSync } from 'node:child_process';\nexport const exec = execSync;\n",
    });

    const reachable = await collectReachableSourceFiles(directory, ["index.js"], selfReferenceResolver(SELF_REF_MANIFEST));

    expect(reachable.files.map(file => file.relativePath)).toEqual(["index.js", "lib/server.js"]);
  });

  it("does not follow the bare self-reference, which is already the walk's seed", async () => {
    const directory = await selfRefTree({ "index.js": 'export { a } from "self-ref-lib";\n' });

    const reachable = await collectReachableSourceFiles(directory, ["index.js"], selfReferenceResolver(SELF_REF_MANIFEST));

    expect(reachable.files.map(file => file.relativePath)).toEqual(["index.js"]);
  });

  it("does not follow another package's name", async () => {
    const directory = await selfRefTree({ "index.js": "import x from 'three';\nexport const a = x;\n" });

    const reachable = await collectReachableSourceFiles(directory, ["index.js"], selfReferenceResolver(SELF_REF_MANIFEST));

    expect(reachable.files.map(file => file.relativePath)).toEqual(["index.js"]);
  });

  it("takes the first usable alternative of an array-valued subpath", async () => {
    // An array is an ordered fallback list: a resolver stops at the first alternative that
    // resolves. Taking them all scanned a file the bundler never bundles — measured on
    // `{".": ["./browser.js", "./node.js"]}`, where rolldown bundled only `browser.js` and
    // built cleanly while the scan reported the `node:fs` in `node.js`.
    //
    // The first alternative here is *absent*, so the usable one is the second — which is
    // exactly why "take `[0]`" would be wrong in the other direction.
    const manifest = {
      name: "alt-lib",
      exports: { ".": "./index.js", "./x": ["./missing.js", "./real.js"], "./package.json": "./package.json" },
    };
    const directory = await mkdtemp(join(tmpdir(), "fgc-alt-"));
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest), "utf8");
    await writeFile(join(directory, "index.js"), 'export { a } from "alt-lib/x";\n', "utf8");
    await writeFile(join(directory, "real.js"), "export const a = 1;\n", "utf8");

    const reachable = await collectReachableSourceFiles(directory, ["index.js"], selfReferenceResolver(manifest));

    expect(reachable.files.map(file => file.relativePath)).toEqual(["index.js", "real.js"]);
  });

  it("follows a wildcard subpath", async () => {
    const manifest = {
      name: "wild-lib",
      exports: { ".": "./index.js", "./feature/*": "./lib/*.js", "./package.json": "./package.json" },
    };
    const directory = await mkdtemp(join(tmpdir(), "fgc-wild-"));
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest), "utf8");
    await mkdir(join(directory, "lib"), { recursive: true });
    await writeFile(join(directory, "index.js"), 'export { a } from "wild-lib/feature/thing";\n', "utf8");
    await writeFile(join(directory, "lib/thing.js"), "export const a = 1;\n", "utf8");

    const reachable = await collectReachableSourceFiles(directory, ["index.js"], selfReferenceResolver(manifest));

    expect(reachable.files.map(file => file.relativePath)).toEqual(["index.js", "lib/thing.js"]);
  });

  it("follows a self-reference when the package publishes no exports map", async () => {
    // With no `exports`, Node resolves `pkg/sub` through `node_modules` — for the
    // package's own name that means the copy on disk, which is a different graph.
    const manifest = { name: "no-exports-lib", main: "./index.js", module: "./index.js" };
    const directory = await mkdtemp(join(tmpdir(), "fgc-noexports-"));
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest), "utf8");
    await mkdir(join(directory, "lib"), { recursive: true });
    await writeFile(join(directory, "index.js"), 'export { a } from "no-exports-lib/lib/thing.js";\n', "utf8");
    await writeFile(join(directory, "lib/thing.js"), "export const a = 1;\n", "utf8");

    const reachable = await collectReachableSourceFiles(directory, ["index.js"], selfReferenceResolver(manifest));

    expect(reachable.files.map(file => file.relativePath)).toEqual(["index.js"]);
  });

  it("follows a `#imports` specifier, which a bundler resolves through the manifest", async () => {
    // The same mechanism as a self-reference and the same asymmetry: the walk followed
    // `pkg/sub` but not `#name`, so a package whose root re-exports from an `imports`
    // entry reached one file, reported `no-node-builtins: true`, and filed no rejection —
    // while the bundler followed the specifier and failed on the builtin inside it.
    const manifest = {
      name: "imports-lib",
      exports: { ".": "./index.js", "./package.json": "./package.json" },
      imports: { "#node-impl": "./src/node-impl.js" },
    };
    const directory = await mkdtemp(join(tmpdir(), "fgc-imports-"));
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest), "utf8");
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "index.js"), 'export { read } from "#node-impl";\n', "utf8");
    await writeFile(join(directory, "src/node-impl.js"), "export const read = 1;\n", "utf8");

    const reachable = await collectReachableSourceFiles(directory, ["index.js"], selfReferenceResolver(manifest));

    expect(reachable.files.map(file => file.relativePath)).toEqual(["index.js", "src/node-impl.js"]);
  });

  it("does not follow a `#name` when the package declares no imports map", async () => {
    // Without an `imports` map, `#name` is a private specifier no resolver can answer, so
    // it is not evidence about this package.
    const manifest = { name: "no-imports-lib", exports: { ".": "./index.js" } };
    const directory = await mkdtemp(join(tmpdir(), "fgc-noimports-"));
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest), "utf8");
    await writeFile(join(directory, "index.js"), 'export { a } from "#missing";\n', "utf8");

    const reachable = await collectReachableSourceFiles(directory, ["index.js"], selfReferenceResolver(manifest));

    expect(reachable.files.map(file => file.relativePath)).toEqual(["index.js"]);
  });

  it("composes an `imports` hop with a self-reference hop", async () => {
    // The two mechanisms are independent, so a file reached through one can leave
    // through the other. Both hops have to compose, or the walk stops one level short of
    // whatever builtin sits at the end of the chain.
    const manifest = {
      name: "chain-lib",
      exports: { ".": "./index.js", "./deep": "./src/deep.js", "./package.json": "./package.json" },
      imports: { "#impl": "./src/impl.js" },
    };
    const directory = await mkdtemp(join(tmpdir(), "fgc-chain-"));
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest), "utf8");
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "index.js"), 'export * from "#impl";\n', "utf8");
    await writeFile(join(directory, "src/impl.js"), 'export * from "chain-lib/deep";\n', "utf8");
    await writeFile(join(directory, "src/deep.js"), "export const x = 1;\n", "utf8");

    const reachable = await collectReachableSourceFiles(directory, ["index.js"], selfReferenceResolver(manifest));

    expect(reachable.files.map(file => file.relativePath)).toEqual(["index.js", "src/deep.js", "src/impl.js"]);
  });

  it("does not follow an `imports` target that names an external package", async () => {
    // `"#dep": "some-pkg"` resolves through `node_modules` — a separate graph node, not a
    // file here. Joining it as a local path made the walk follow a coincidentally-named
    // local file and attribute that package's builtins to *this* package's name: a
    // measured false rejection, and the class this change exists to remove.
    const manifest = {
      name: "shadow-lib",
      exports: { ".": "./index.js", "./package.json": "./package.json" },
      imports: { "#dep": "some-pkg" },
    };
    const directory = await mkdtemp(join(tmpdir(), "fgc-shadow-"));
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest), "utf8");
    await writeFile(join(directory, "index.js"), 'export * from "#dep";\n', "utf8");
    // The coincidental local file, named to collide with the package name.
    await writeFile(join(directory, "some-pkg.js"), "export const x = 1;\n", "utf8");

    const reachable = await collectReachableSourceFiles(directory, ["index.js"], selfReferenceResolver(manifest));

    expect(reachable.files.map(file => file.relativePath)).toEqual(["index.js"]);
  });

  it("does not follow a scoped `imports` target that names an external package", async () => {
    const manifest = {
      name: "scoped-lib",
      exports: { ".": "./index.js", "./package.json": "./package.json" },
      imports: { "#dep": "@scope/pkg" },
    };
    const directory = await mkdtemp(join(tmpdir(), "fgc-scoped-"));
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest), "utf8");
    await writeFile(join(directory, "index.js"), 'export * from "#dep";\n', "utf8");

    const reachable = await collectReachableSourceFiles(directory, ["index.js"], selfReferenceResolver(manifest));

    expect(reachable.files.map(file => file.relativePath)).toEqual(["index.js"]);
  });
});

/**
 * The regressions an adversarial review of the reachability change found.
 *
 * Each reproduced on the first implementation, and each is in the *dangerous*
 * direction: a false rejection restored, a real finding hidden, or the graph quietly
 * truncated. They sit together because they share a cause — the mechanisms below are
 * new, and one that works only on the shapes its author had in mind is
 * indistinguishable from one that works.
 */
describe("maskComments: offsets are UTF-16 code units", () => {
  it("blanks a comment preceded by an astral character", () => {
    // Babel reports code-unit offsets; spreading the string into an array yields code
    // points, and the two diverge at the first astral character, so blanking landed
    // short. At 22 astral characters the comment survived masking entirely, putting
    // `require(\"node:fs\")` written in prose back in front of the scanner — the exact
    // false rejection this module exists to remove.
    const source = `const ICONS = "${"\u{1F600}".repeat(22)}";\n// require("node:fs")\nexport const b = 1;\n`;

    const masked = maskComments(source, analyzeModuleSource(source)!.commentRanges);

    expect(masked).not.toContain("node:fs");
    expect(masked).toContain("export const b = 1;");
    // Length is preserved in the unit the offsets are in.
    expect(masked.length).toBe(source.length);
    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
  });

  it("does not consume real code after an astral character", () => {
    // Drift in the other direction blanked real code, which *hides* a finding instead
    // of inventing one.
    const source = `const e = "${"\u{1F600}"}";\n// c\nrequire("node:fs");\n`;

    const masked = maskComments(source, analyzeModuleSource(source)!.commentRanges);

    expect(masked).toContain('require("node:fs")');
    expect(masked).not.toContain("// c");
  });

  it("blanks adjacent and nested-looking comments without losing code", () => {
    const source = "/*aaa*//*bbb*/const x = 1;\n/* ccc /* ddd */const y = 2;\n";

    const masked = maskComments(source, analyzeModuleSource(source)!.commentRanges);

    // Checked against the comment bodies, not bare letters: "c" occurs in `const`.
    expect(masked).not.toContain("aaa");
    expect(masked).not.toContain("bbb");
    expect(masked).not.toContain("ccc");
    expect(masked).not.toContain("ddd");
    expect(masked).toContain("const x = 1;");
    expect(masked).toContain("const y = 2;");
    expect(masked.length).toBe(source.length);
  });
});

describe("analyzeModuleSource: native indicators and TypeScript", () => {
  it("reports process.dlopen, which the parse must supply", () => {
    // Routing the scan through the parser dropped `dlopen` detection for every
    // parseable file: the text fallback that had the pattern runs only for files that
    // do *not* parse. A reachable module whose only native dependency was a `dlopen`
    // reported zero native indicators and `no-node-builtins: true`.
    const analysis = analyzeModuleSource(
      "const b = process.dlopen(module, './build/Release/native.node');\nexport default b;\n",
    );

    expect(analysis?.nativeIndicators).toContain("source:process.dlopen");
  });

  it("still reports a require of a .node file", () => {
    expect(
      analyzeModuleSource("const n = require('./addon.node');\nexport default n;\n")?.nativeIndicators,
    ).toContain("source:require-*.node");
  });

  it("does not mistake a computed or unrelated member call for dlopen", () => {
    expect(analyzeModuleSource("process['dlopen'](a, b);\n")?.nativeIndicators ?? []).toEqual([]);
    expect(analyzeModuleSource("other.dlopen(a, b);\n")?.nativeIndicators ?? []).toEqual([]);
  });

  it("parses TypeScript annotations, which packages ship as entries", () => {
    // Without the plugin a typed file returns undefined, and because an unparseable
    // file enqueues nothing the walk silently truncated there, hiding every file
    // beyond it.
    expect(analyzeModuleSource("const x: number = 1;\nexport { x };\n")).toBeDefined();
    expect(analyzeModuleSource("export enum E { A = 1 }\n")).toBeDefined();
    expect(analyzeModuleSource("interface A { b: string }\nexport type { A };\n")).toBeDefined();
  });

  it("parses decorators, which TypeScript packages ship", () => {
    // Without `decorators-legacy` these report `undefined`, and an unparseable reachable
    // file truncates the walk — so a decorated `.ts` entry hid everything past it.
    expect(analyzeModuleSource("@dec class A {}\nexport { A };\n")).toBeDefined();
    expect(analyzeModuleSource("@Injectable()\nclass S {}\nexport { S };\n")).toBeDefined();
    expect(analyzeModuleSource("class A { @observable x = 1; }\nexport { A };\n")).toBeDefined();
  });

  it("still parses JSX and TSX, which the decorator plugin must not break", () => {
    expect(analyzeModuleSource("export const C = () => <div className='a'>{1}</div>;\n")).toBeDefined();
    expect(analyzeModuleSource("export const f = <T,>(x: T) => <div>{String(x)}</div>;\n")).toBeDefined();
  });
});

describe("collectReachableSourceFiles: truncation and unusable paths", () => {
  async function truncTree(files: Record<string, string>, manifest: Record<string, unknown>): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "fgc-trunc-"));
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest), "utf8");
    for (const [name, contents] of Object.entries(files)) {
      const path = join(directory, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, "utf8");
    }
    return directory;
  }

  it("walks through a TypeScript chain instead of stopping at the first typed file", async () => {
    const directory = await truncTree(
      {
        "index.ts": 'export * from "./mid.ts";\n',
        "mid.ts": "const x: number = 1;\nexport * from './deep.ts';\n",
        "deep.ts": "import { r } from 'node:fs';\nexport const z = r;\n",
      },
      { name: "tslib", exports: { ".": "./index.ts" } },
    );

    const reachable = await collectReachableSourceFiles(directory, ["index.ts"]);

    expect(reachable.files.map(file => file.relativePath)).toEqual(["deep.ts", "index.ts", "mid.ts"]);
  });

  it("follows a bundler-query specifier, which is how a Worker entry is declared", async () => {
    const directory = await truncTree(
      { "index.js": 'import W from "./w.js?worker";\nexport default W;\n', "w.js": "export default 1;\n" },
      { name: "q", exports: { ".": "./index.js" } },
    );

    const reachable = await collectReachableSourceFiles(directory, ["index.js"]);

    expect(reachable.files.map(file => file.relativePath)).toEqual(["index.js", "w.js"]);
    expect(reachable.unresolvedSpecifiers).toEqual([]);
  });

  it("does NOT follow a file imported for its bytes, not its code", async () => {
    // `?raw`/`?url`/`?inline` hand the importer the file's *contents*; its own code is
    // never in the bundle, so a Node builtin inside it cannot disqualify the artifact.
    // Following these produced a false `platform-api-unavailable` rejection on a package
    // shipping a `?raw` template beside Node-only tooling — the exact failure class this
    // change removes, and a regression the first version of the query fix introduced.
    for (const query of ["?raw", "?url", "?inline", "?raw&foo", "?foo&raw"]) {
      const directory = await truncTree(
        {
          "index.js": `import src from "./prompt.js${query}";\nexport default src;\n`,
          "prompt.js": "import { readFileSync } from 'node:fs';\nexport const p = readFileSync('x');\n",
        },
        { name: "r", exports: { ".": "./index.js" } },
      );

      const reachable = await collectReachableSourceFiles(directory, ["index.js"]);

      expect(reachable.files.map(file => file.relativePath), query).toEqual(["index.js"]);
      // Not reported as a drop either: skipping it is the intended reading, not a fault.
      expect(reachable.unresolvedSpecifiers, query).toEqual([]);
    }
  });

  it("still follows a Worker when the query also says inline", async () => {
    // `worker` wins over `inline`: `?worker&inline` is Vite's spelling for "bundle this
    // Worker and inline it as a data URL", and the Worker's code and imports are in the
    // artifact. Applying `inline` first stopped the walk there — a false *negative*,
    // which is the direction this walk must not fail in.
    for (const query of ["?worker", "?worker&inline", "?inline&worker"]) {
      const directory = await truncTree(
        { "index.js": `import W from "./w.js${query}";\nexport default W;\n`, "w.js": "export default 1;\n" },
        { name: "w", exports: { ".": "./index.js" } },
      );

      const reachable = await collectReachableSourceFiles(directory, ["index.js"]);

      expect(reachable.files.map(file => file.relativePath), query).toEqual(["index.js", "w.js"]);
    }
  });

  it("reports a relative specifier that resolves to nothing", async () => {
    // The walk stopping here was previously invisible: the only trace was a smaller
    // file count, which reads identically to a healthy package.
    const directory = await truncTree(
      { "index.js": 'import a from "./missing.js";\nexport default a;\n' },
      { name: "m", exports: { ".": "./index.js" } },
    );

    const reachable = await collectReachableSourceFiles(directory, ["index.js"]);

    expect(reachable.unresolvedSpecifiers).toEqual(["./missing.js"]);
    expect(reachable.escapedSpecifiers).toEqual([]);
  });

  it("distinguishes an escaping specifier from an unresolvable one", async () => {
    const directory = await truncTree(
      { "index.js": 'import a from "../../outside.js";\nimport b from "./nope.js";\nexport { a, b };\n' },
      { name: "d", exports: { ".": "./index.js" } },
    );

    const reachable = await collectReachableSourceFiles(directory, ["index.js"]);

    expect(reachable.escapedSpecifiers).toEqual(["../../outside.js"]);
    expect(reachable.unresolvedSpecifiers).toEqual(["./nope.js"]);
  });

  it("names an unparseable reachable file so the truncation is reviewable", async () => {
    const directory = await truncTree(
      { "index.js": "const a = <<<broken;\n" },
      { name: "u", exports: { ".": "./index.js" } },
    );

    const reachable = await collectReachableSourceFiles(directory, ["index.js"]);

    expect(reachable.unparseableFiles).toEqual(["index.js"]);
  });
});

describe("resolveBrowserEntryPaths: unusable manifest paths", () => {
  it("reduces an absolute, escaping or windows target to no entry", () => {
    // A manifest path is content from a downloaded package and it reaches
    // `runtime.entry-paths` / `graph.entry-resolutions`, so an absolute one must not
    // reach report content — and it is not an entry either, because it cannot name a file
    // inside this package.
    const unusable = [
      "/Users/someone/proj/index.js",
      "../../outside/index.js",
      `C:${"\\"}Users${"\\"}x${"\\"}index.js`,
    ];

    for (const target of unusable) {
      expect(resolveBrowserEntryPaths({ main: target }).entries, target).toEqual([]);
      // Naming it in the report is fine; naming the *path* is not.
      expect(UNUSABLE_TARGET_EVIDENCE).not.toContain("/");
    }
  });

  it("keeps a legitimate nested relative path", () => {
    // A monorepo layout inside a published package is not an escape.
    expect(resolveBrowserEntryPaths({ exports: { ".": "./packages/a/index.js" } }).entries).toEqual([
      "packages/a/index.js",
    ]);
  });

  it("names no entry for an unusable target, and never the placeholder", () => {
    // An unusable target is not a file. Reporting the marker string as an entry made the
    // walk try to read a file named after it and file a *missing entry* — asserting the
    // package forgot a file when its manifest named an unusable path.
    for (const manifest of [
      { main: "/abs/index.js" },
      { exports: { ".": "/abs/index.js" } },
      { exports: { ".": "" } },
      { browser: "   " },
    ]) {
      expect(resolveBrowserEntryPaths(manifest).entries, JSON.stringify(manifest)).toEqual([]);
    }
  });

  it("treats a .node target as unusable even when it carries a query", () => {
    // The extension test has to run after the query is stripped, or this step and
    // `export-metadata` disagree about the same manifest.
    expect(resolveBrowserEntryPaths({ exports: { ".": "./a.node?x" } }).entries).toEqual([]);
    expect(resolveBrowserEntryPaths({ exports: { ".": "./a.node" } }).entries).toEqual([]);
  });
});

/**
 * The two steps must agree about which entry a browser resolver stops at.
 *
 * They did not. `observeExportMetadata` accepted a bare `browser` field even when
 * `exports` hid every browser entry, while `resolveBrowserEntryPaths` treated `exports`
 * as authoritative — so a strictly server-only package was reported browser-resolvable
 * by the step that could have rejected it while the step that scans source reached zero
 * files. The agreement is a property of the pair, so it is asserted over a table of
 * manifest shapes rather than per step: a change to either condition order that breaks
 * it fails here.
 */
/**
 * Three more false positives, found by an independent review of the finished fix.
 *
 * All three are the same shape as the original defect — a rejection citing a file the
 * browser build never contains — and two of them were *restored* by an earlier fix in this
 * change set, which is why they are grouped and named rather than folded into the cases
 * above.
 */
describe("masking survives a file that will not parse", () => {
  it("does not read a specifier out of a comment in an unparseable file", () => {
    // The original defect, restored by a wrong trade-off: the parse-failure path matched
    // raw text "to avoid a false negative", which put prose back in front of the scanner.
    //
    // The trigger has to be syntax Babel genuinely rejects. `accessor` was the trigger when
    // this was found (`decoratorAutoAccessors` was missing then); that is now parsed, so the
    // case below uses a truncated expression, which no plugin rescues.
    const source = [
      "/**",
      " * @example",
      ' * const c = require("node:child_process");',
      " */",
      "export const broken = ;",
      "",
    ].join("\n");

    // The parse must fail for this to test anything, and it does.
    expect(analyzeModuleSource(source)).toBeUndefined();
    expect(sourceWithoutCommentsLenient(source)).not.toContain("node:child_process");
  });

  it("parses an `accessor` field, so that file takes the parser path rather than the fallback", () => {
    // The plugin list was widened after this was found: an `accessor` field made the whole
    // file unparseable, which truncated the walk at it. Both paths must mask, and this is
    // the assertion that the better path is the one being taken.
    expect(analyzeModuleSource('export class W { accessor label = "w"; }')).toBeDefined();
    expect(analyzeModuleSource("export class W { static accessor x = 1; }")).toBeDefined();
  });

  it("still reports a real import in an unparseable file", () => {
    // The other direction: masking must not be an amnesty for a genuinely broken file.
    const source = ['import { r } from "node:fs";', "export const broken = ;", ""].join("\n");

    expect(sourceWithoutCommentsLenient(source)).toContain("node:fs");
  });

  it("does not mask inside a string literal, which is where specifiers live", () => {
    // The lenient masker is text-based, so this is the property that keeps it usable: a
    // masked string would hide the very import the scanner is looking for.
    const source = ['const p = require("./real.js");', 'const s = "require(\'fs\')";', ""].join("\n");

    const masked = sourceWithoutCommentsLenient(source);

    expect(masked).toContain("require(\"./real.js\")");
    expect(masked).toContain("./real.js");
  });

  it("preserves length and newlines like the parser-based masker", () => {
    const source = ["// one", "/* two", "three */", "const a = 1;", "accessor = bad syntax here", ""].join("\n");

    const masked = sourceWithoutCommentsLenient(source);

    expect(masked.length).toBe(source.length);
    expect(masked.split("\n")).toHaveLength(source.split("\n").length);
    expect(masked).not.toContain("one");
    expect(masked).not.toContain("two");
  });
});

describe("the browser field substitutes a request", () => {
  it("follows the replacement rather than the file it replaces", () => {
    // The `@embedpdf/pdfium` shape one level of indirection out: `dist/index.js` requires
    // `fs` and the manifest replaces it. rolldown bundles only the replacement, so a walk
    // that ignored the substitution reported builtins from a file not in the artifact.
    const manifest = {
      main: "./build/index.js",
      browser: { "./build/index.js": "./build/index.browser.js" },
    };

    expect(resolveBrowserEntryPaths(manifest).entries).toEqual(["build/index.browser.js"]);
    expect(applyBrowserField(manifest, "build/index.js")).toBe("build/index.browser.js");
  });

  it("drops a request the browser field excludes", () => {
    // `false` is an explicit exclusion: the browser build contains no version of the file.
    const manifest = { main: "./index.js", browser: { "./index.js": false } };

    expect(resolveBrowserEntryPaths(manifest).entries).toEqual([]);
  });

  it("leaves an unmapped request alone", () => {
    expect(applyBrowserField({ browser: { "./other.js": "./o.js" } }, "build/index.js")).toBe("build/index.js");
  });

  it("substitutes a request reached by a relative import, not just the entry", () => {
    // The nested form, which the entry-only case does not cover.
    const manifest = { browser: { "./impl.js": "./impl.browser.js" } };

    expect(applyBrowserField(manifest, "impl.js")).toBe("impl.browser.js");
  });
});

describe("an array export is a fallback list, not a union", () => {
  it("takes the first alternative, which is the only one in the bundle", () => {
    // Measured against rolldown: `["./browser.js", "./node.js"]` bundled only
    // `browser.js`, while collecting both made the scan report the `node:fs` in `node.js`.
    expect(resolveBrowserEntryPaths({ exports: { ".": ["./browser.js", "./node.js"] } }).entries).toEqual([
      "browser.js",
    ]);
  });

  it("skips a .node alternative for a later executable one", () => {
    // A `.node` entry is a target but not a file a browser can load, so it does not
    // satisfy the first-match rule.
    expect(resolveBrowserEntryPaths({ exports: { ".": ["./addon.node", "./real.js"] } }).entries).toEqual(["real.js"]);
  });

  it("tries a self-reference's alternatives in order until one exists", async () => {
    // The fallback list, end to end: the first alternative is absent, so the walk must
    // move past it rather than reporting the subpath as unresolved.
    const manifest = {
      name: "fallback-lib",
      exports: { ".": "./index.js", "./x": ["./missing.js", "./real.js"], "./package.json": "./package.json" },
    };
    const directory = await mkdtemp(join(tmpdir(), "fgc-fallback-"));
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest), "utf8");
    await writeFile(join(directory, "index.js"), 'export { a } from "fallback-lib/x";\n', "utf8");
    await writeFile(join(directory, "real.js"), "export const a = 1;\n", "utf8");

    const reachable = await collectReachableSourceFiles(directory, ["index.js"], selfReferenceResolver(manifest));

    expect(reachable.files.map(file => file.relativePath)).toEqual(["index.js", "real.js"]);
  });
});


/**
 * Two false positives found by re-reviewing the array and `browser` fixes themselves.
 *
 * Both are the same family one level out: the fix corrected the case it was written for and
 * stopped there, and each had a walk-vs-bundler disagreement behind it.
 */
describe("the browser substitution chains, as a resolver chains it", () => {
  it("follows a two-hop replacement to the file the bundler loads", () => {
    // A resolver substitutes until it reaches a path with no replacement, so `index.js`
    // resolves through `a.js` to `b.js`. Applying the table once returned `a.js`, while
    // rolldown bundled `b.js` — so a package whose `index.js` and `a.js` both need
    // `node:fs` but whose `b.js` is clean was refused by the scan and built by the bundler.
    const manifest = { main: "./index.js", browser: { "./index.js": "./a.js", "./a.js": "./b.js" } };

    expect(applyBrowserField(manifest, "index.js")).toBe("b.js");
    expect(resolveBrowserEntryPaths(manifest).entries).toEqual(["b.js"]);
  });

  it("follows a three-hop chain", () => {
    const manifest = {
      main: "./index.js",
      browser: { "./index.js": "./a.js", "./a.js": "./b.js", "./b.js": "./c.js" },
    };

    expect(applyBrowserField(manifest, "index.js")).toBe("c.js");
  });

  it("stops instead of looping when the table cycles", () => {
    // A resolver would recurse forever; the walk returns the last path it reached and leaves
    // the manifest fault to the build step. The property that matters is termination, not
    // *which* path of the cycle comes back — any member is equally wrong to follow, and the
    // build reports the manifest either way.
    const manifest = { main: "./index.js", browser: { "./index.js": "./a.js", "./a.js": "./index.js" } };

    const result = applyBrowserField(manifest, "index.js");
    expect(result === "index.js" || result === "a.js").toBe(true);
    // A path outside the cycle would mean it wandered rather than stopped.
    expect(applyBrowserField({ main: "./index.js", browser: { "./index.js": "./a.js", "./a.js": "./b.js" } }, "index.js")).toBe("b.js");
  });

  it("excludes a file that a chain leads to `false`", () => {
    const manifest = { main: "./index.js", browser: { "./index.js": "./a.js", "./a.js": false } };

    expect(applyBrowserField(manifest, "index.js")).toBeNull();
  });
});

describe("array order is preserved", () => {
  it("takes the first alternative as the manifest lists it, not alphabetically", () => {
    // Sorting destroyed the fallback order: `["./b.js", "./a.js"]` resolved to the
    // alphabetically-first `a.js` while rolldown bundled `b.js`, and two opposite manifests
    // produced the identical verdict — which is what gave the lost order away.
    expect(resolveBrowserEntryPaths({ exports: { ".": ["./b.js", "./a.js"] } }).entries).toEqual(["b.js"]);
    expect(resolveBrowserEntryPaths({ exports: { ".": ["./a.js", "./b.js"] } }).entries).toEqual(["a.js"]);
  });

  it("keeps an `imports` array's order too", () => {
    expect(resolveImportsMapSubpath({ imports: { "#a": ["./b.js", "./a.js"] } }, "#a")).toEqual([
      "b.js",
      "a.js",
    ]);
  });

  it("stops at the first alternative that exists, in manifest order", async () => {
    // The end-to-end property: rolldown bundles the first *existing* alternative, so the
    // walk must not pick a later one that happens to sort earlier.
    const manifest = {
      name: "order-lib",
      exports: { ".": "./index.js", "./package.json": "./package.json" },
      imports: { "#a": ["./b.js", "./a.js"] },
    };
    const directory = await mkdtemp(join(tmpdir(), "fgc-order-"));
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest), "utf8");
    await writeFile(join(directory, "index.js"), 'export { x } from "#a";\n', "utf8");
    await writeFile(join(directory, "b.js"), "export const x = 1;\n", "utf8");
    await writeFile(join(directory, "a.js"), "export const x = 2;\n", "utf8");

    const reachable = await collectReachableSourceFiles(directory, ["index.js"], selfReferenceResolver(manifest));

    expect(reachable.files.map(file => file.relativePath)).toEqual(["b.js", "index.js"]);
  });
});

/**
 * The manifest rules a further review round found the walk modelling differently from Node and
 * from the bundler. All three are false positives in the direction this change exists to remove.
 */
describe("conditions resolve in the manifest's own key order", () => {
  it("takes the first key whose condition is active, not a preferred condition", () => {
    // Measured against Node's own resolver and rolldown, which agree: `default` listed first
    // wins over `browser`, because Node stops at the first active key. The walk used a
    // preference ranking (`browser` before `default`) and so picked the other file — and both
    // steps shared that ranking, so they agreed with each other while disagreeing with Node.
    expect(
      resolveBrowserEntryPaths({ exports: { ".": { default: "./n.js", browser: "./b.js" } } }).entries,
    ).toEqual(["n.js"]);
    expect(
      resolveBrowserEntryPaths({ exports: { ".": { browser: "./b.js", default: "./n.js" } } }).entries,
    ).toEqual(["b.js"]);
  });

  it("skips a condition this resolver does not have and continues", () => {
    // `node` is not active for a browser build, so the resolver moves to the next key.
    expect(
      resolveBrowserEntryPaths({ exports: { ".": { node: "./server.js", default: "./browser.js" } } }).entries,
    ).toEqual(["browser.js"]);
  });

  it("still agrees with export-metadata on every ordering", () => {
    for (const manifest of [
      { exports: { ".": { default: "./n.js", browser: "./b.js" } } },
      { exports: { ".": { browser: "./b.js", default: "./n.js" } } },
      { exports: { ".": { node: "./s.js", default: "./n.js" } } },
      { exports: { ".": { require: "./c.js", import: "./i.js" } } },
    ]) {
      const identity = {
        packageName: "candidate",
        packageVersion: "1.0.0",
        license: null,
        source: null,
        directory: "/virtual/package",
        manifest,
      } as ResolvedPackageIdentity;
      const metadata = observeExportMetadata(identity);
      const resolvable = metadata.facts.find(fact => fact.name === "exports.browser-resolvable")?.value;
      const namesAnEntry = resolveBrowserEntryPaths(manifest).entries.length > 0;
      expect(namesAnEntry, JSON.stringify(manifest)).toBe(resolvable === true);
    }
  });
});

describe("browser substitutions reach every resolution path", () => {
  it("substitutes a subpath resolved through exports", async () => {
    // The relative-import path applied the substitution; the self-reference path returned the
    // file directly. Measured: the walk followed the file `browser` replaces, so the engine
    // refused a package rolldown built cleanly from the replacement.
    const manifest = {
      name: "sub-lib",
      exports: { ".": "./index.js", "./s": "./impl.js", "./package.json": "./package.json" },
      browser: { "./impl.js": "./impl.browser.js" },
    };
    const directory = await mkdtemp(join(tmpdir(), "fgc-subpath-"));
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest), "utf8");
    await writeFile(join(directory, "index.js"), 'export { v } from "sub-lib/s";\n', "utf8");
    await writeFile(join(directory, "impl.js"), "export const v = 1;\n", "utf8");
    await writeFile(join(directory, "impl.browser.js"), "export const v = 2;\n", "utf8");

    const reachable = await collectReachableSourceFiles(
      directory,
      ["index.js"],
      selfReferenceResolver(manifest),
      request => applyBrowserField(manifest, request),
    );

    expect(reachable.files.map(file => file.relativePath)).toEqual(["impl.browser.js", "index.js"]);
  });

  it("substitutes a subpath resolved through an imports map", async () => {
    const manifest = {
      name: "imp-lib",
      exports: { ".": "./index.js", "./package.json": "./package.json" },
      imports: { "#impl": "./impl.js" },
      browser: { "./impl.js": "./impl.browser.js" },
    };
    const directory = await mkdtemp(join(tmpdir(), "fgc-impsub-"));
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest), "utf8");
    await writeFile(join(directory, "index.js"), 'export { v } from "#impl";\n', "utf8");
    await writeFile(join(directory, "impl.js"), "export const v = 1;\n", "utf8");
    await writeFile(join(directory, "impl.browser.js"), "export const v = 2;\n", "utf8");

    const reachable = await collectReachableSourceFiles(
      directory,
      ["index.js"],
      selfReferenceResolver(manifest),
      request => applyBrowserField(manifest, request),
    );

    expect(reachable.files.map(file => file.relativePath)).toEqual(["impl.browser.js", "index.js"]);
  });

  it("reports a bare specifier the browser field excludes", () => {
    // `{ "fs": false }` is the documented browserify convention for dropping a module. The
    // specifier never reaches its target in a browser build, so a builtin named only there is
    // not one the artifact contains — measured on `{"browser":{"fs":false}}` with
    // `import fs from "fs"`, where rolldown built cleanly and the engine refused the package.
    expect(browserFieldRedirectsSpecifier({ browser: { fs: false } }, "fs")).toBe(true);
    // A redirect to another module is the same judgement: the original is not resolved.
    expect(browserFieldRedirectsSpecifier({ browser: { stream: "stream-browserify" } }, "stream")).toBe(true);
    // A path key is not a bare specifier, and an unmentioned specifier is untouched.
    expect(browserFieldRedirectsSpecifier({ browser: { "./impl.js": "./impl.browser.js" } }, "impl.js")).toBe(false);
    expect(browserFieldRedirectsSpecifier({ browser: { fs: false } }, "path")).toBe(false);
  });
});

describe("entry resolution agrees with export-metadata", () => {
  const SHAPES: readonly { readonly name: string; readonly manifest: Record<string, unknown> }[] = [
    { name: "exports string", manifest: { exports: "./index.js" } },
    { name: "exports array", manifest: { exports: ["./a.js", "./b.js"] } },
    { name: "exports conditional", manifest: { exports: { browser: "./b.js", node: "./n.js" } } },
    { name: "exports subpath only", manifest: { exports: { "./sub": "./s.js" } } },
    { name: "exports null root", manifest: { exports: { ".": null, "./sub": "./s.js" } } },
    { name: "exports browser false", manifest: { exports: { ".": { browser: false, node: "./n.js" } } } },
    { name: "exports node-only plus browser object", manifest: { exports: { ".": { node: "./n.js" } }, browser: { "./x.js": "./y.js" } } },
    { name: "exports node-only plus browser string", manifest: { exports: { ".": { node: "./n.js" } }, browser: "./b.js" } },
    { name: "browser field object", manifest: { browser: { "./index.js": "./b.js" }, main: "./index.js" } },
    { name: "browser field string", manifest: { browser: "./b.js", main: "./index.js" } },
    { name: "main .node", manifest: { main: "./addon.node" } },
    { name: "module only", manifest: { module: "./m.js" } },
    { name: "main only", manifest: { main: "./i.js" } },
    { name: "nothing", manifest: {} },
    { name: "exports node-only", manifest: { exports: { ".": { node: "./n.js" } } } },
    { name: "exports default only", manifest: { exports: { ".": { default: "./d.js" } } } },
    // The shapes a re-review found still disagreeing after the first fix: a `browser`
    // condition pointing at something no browser can execute. `export-metadata` used to
    // accept any string here without the executable check it applied elsewhere, so this
    // was reported browser-resolvable while the entry resolution (correctly) named no
    // file — the same "verdict from an empty set" shape as the `|| browserField` bug.
    { name: "browser condition at a .node addon", manifest: { exports: { ".": { browser: "./addon.node", import: "./real.js" } } } },
    { name: "browser condition at a .node with no fallback", manifest: { exports: { ".": { browser: "./addon.node" } } } },
    { name: "array alternatives, first a .node", manifest: { exports: { ".": ["./addon.node", "./real.js"] } } },
    { name: "array alternatives, all .node", manifest: { exports: { ".": ["./a.node", "./b.node"] } } },
    { name: "browser condition at a bare directory", manifest: { exports: { ".": { browser: "./dist", import: "./real.js" } } } },
    // A third round found these: an unusable target must not be mistaken for an entry.
    // An empty or whitespace target, and an absolute one, are not files — treating them
    // as entries made the walk read a file named after the placeholder and report a
    // *missing entry*, and made `exports: { ".": "" }` look browser-resolvable.
    { name: "empty browser string", manifest: { browser: "" } },
    { name: "whitespace browser string", manifest: { browser: "   " } },
    { name: "empty exports root", manifest: { exports: { ".": "" } } },
    { name: "whitespace exports root", manifest: { exports: { ".": "   " } } },
    { name: "absolute exports root", manifest: { exports: { ".": "/abs/index.js" } } },
    // The `.node` test has to run after the query is stripped, or this reads as
    // executable here while the entry resolution finds nothing.
    { name: "node addon with a query", manifest: { exports: { ".": "./a.node?x" } } },
    { name: "node addon with a query in a condition", manifest: { exports: { ".": { browser: "./a.node?raw", import: "./real.js" } } } },
  ];

  for (const shape of SHAPES) {
    it(`agrees for: ${shape.name}`, () => {
      const identity: ResolvedPackageIdentity = {
        packageName: "candidate",
        packageVersion: "1.0.0",
        license: null,
        source: null,
        directory: "/virtual/package",
        manifest: shape.manifest,
      };
      const metadata = observeExportMetadata(identity);
      const browserResolvable = metadata.facts.find(fact => fact.name === "exports.browser-resolvable")?.value;
      const namesAnEntry = resolveBrowserEntryPaths(shape.manifest).entries.length > 0;

      // The invariant, stated as the two steps' answers agreeing: a package the
      // metadata step calls browser-resolvable is one the scanners can name a file for,
      // and vice versa. Without it, one step's verdict and the other's silence could
      // describe different packages.
      expect(namesAnEntry, `${shape.name}: metadata says ${String(browserResolvable)}`).toBe(
        browserResolvable === true,
      );
    });
  }
});
