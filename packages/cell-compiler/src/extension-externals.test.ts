import { Script, createContext } from "node:vm";

import { rolldown } from "rolldown";
import { describe, expect, it } from "vitest";

import {
  EXTENSION_EXTERNAL_MAPPINGS,
  normalizeExtensionMappings,
  type DependencyDecision,
  type ExtensionExternalMapping,
  type ExtensionLibraryListing,
} from "@forguncy-react-workspace/core";

import { compileCell } from "./artifact.ts";
import type { CellBundlerPort, CompileCellOutcome } from "./artifact.ts";
import { CELL_ENTRY_COMPONENT_BINDING } from "./entry.ts";
import {
  extensionExternalModuleIds,
  formatExtensionExternalsPlan,
  interceptedExtensionExternalModuleIds,
  planExtensionExternals,
  renderExtensionExternalModule,
  EXTENSION_EXTERNAL_GENERATED_BANNER,
} from "./extension-externals.ts";
import { frontendLibraryReference } from "./frontend-libraries.ts";

// ---------------------------------------------------------------------------
// The page object the extension publishes
// ---------------------------------------------------------------------------

/**
 * A stand-in for what the TanStack Query extension creates as `globalThis.TanStackQuery`.
 *
 * Deliberately shaped like the *facade* rather than like the npm package's module
 * namespace: the extension's bundle decides what the global carries, and what this
 * contract has to preserve is the authored import's behaviour against that object —
 * named members, and one identity per member however many cells read it.
 *
 * The real facade is a designer-side artifact that cannot be installed here, so this
 * is a fixture and not evidence: what a green run below establishes is the generated
 * module's behaviour, never that the extension is present on a page.
 */
function tanStackQueryFacade(): Record<string, unknown> {
  class QueryClient {
    readonly label = "shared query client";
  }
  const useQuery = (): string => "query result";
  return {
    QueryClient,
    useQuery,
    hashKey: (key: unknown): string => JSON.stringify(key),
  };
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

interface ExtensionSandbox {
  /** How many times the module read the extension global. */
  readonly reads: () => number;
  /** Install or replace the global, as a page loading the library would. */
  readonly install: (value: unknown) => void;
  /** Evaluate a generated module in this sandbox and return its exports. */
  readonly run: (source: string) => Record<string, unknown>;
  /** Evaluate anything else — a bundled artifact — in the same sandbox. */
  readonly runScript: (source: string) => void;
  /** What the evaluated script published as `globalThis.RESULT`, for the bundle tests. */
  readonly result: () => Record<string, unknown> | undefined;
}

/**
 * A sandbox whose extension global can be installed before *or after* evaluation.
 *
 * Two things it is for, and the second is the one that matters:
 *
 * - counting reads of the global, because "the module resolves the global while its body
 *   runs" is a claim about *when*, and a counter is the only way to assert a timing;
 * - installing the global late, which is the case a first design of this module got
 *   wrong: the module looked fine in isolation and produced a namespace that could never
 *   gain the extension's members once a bundler's interop had enumerated it.
 *
 * `node:vm` rather than `eval` so the counted name is the only place a global exists — a
 * test that leaked `globalThis.TanStackQuery` into the test process would pass for the
 * wrong reason.
 */
function extensionSandbox(globalName: string, initial?: unknown): ExtensionSandbox {
  let reads = 0;
  let value = initial;
  const sandbox: Record<string, unknown> = { module: { exports: {} } };
  sandbox.globalThis = sandbox;

  const install = (next: unknown): void => {
    value = next;
    Object.defineProperty(sandbox, globalName, {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return value;
      },
    });
  };
  if (initial !== undefined) install(initial);

  const context = createContext(sandbox);
  return {
    reads: () => reads,
    install,
    run: (source: string) => {
      new Script(source, { filename: "generated extension externals module" }).runInContext(context);
      return (sandbox.module as { exports: Record<string, unknown> }).exports;
    },
    runScript: (source: string) => {
      new Script(source, { filename: "bundled artifact" }).runInContext(context);
    },
    result: () => sandbox.RESULT as Record<string, unknown> | undefined,
  };
}

/** The thrown error, or a failure explaining that nothing was thrown. */
function caught(run: () => unknown): Record<string, unknown> {
  try {
    run();
  } catch (error) {
    return error as Record<string, unknown>;
  }
  throw new Error("Expected the generated module to throw, and it did not.");
}

/** Every name the generated source reads off a global, in source order. */
function globalsReadBy(source: string): readonly string[] {
  return [...source.matchAll(/globalThis\[("(?:[^"\\]|\\.)*")\]/g)].map(match => JSON.parse(match[1] ?? '""') as string);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mapping(overrides: Partial<ExtensionExternalMapping> = {}): ExtensionExternalMapping {
  return {
    packageName: "some-package",
    libraryId: "some-library",
    globalName: "SomeLibrary",
    metadataSource: "verified-catalog",
    metadataReference: "MangMax/forguncy-react-library",
    verificationRule: "A catalog entry whose id and global the listing confirms.",
    verifiedBy: ["product-documentation"],
    note: "synthetic row",
    ...overrides,
  };
}

function extensionDecision(
  packageName: string,
  libraryId = "tanstack-query",
  globalName = "TanStackQuery",
): DependencyDecision {
  return { strategy: "extension", packageName, libraryId, globalName };
}

function inlineDecision(packageName: string): DependencyDecision {
  return { strategy: "inline", packageName };
}

const CANONICAL_ROW = EXTENSION_EXTERNAL_MAPPINGS[0] as ExtensionExternalMapping;

/** A listing shaped the way `api.app.listFrontendLibraries` reports one. */
function listing(overrides: Partial<ExtensionLibraryListing> = {}): ExtensionLibraryListing {
  return {
    id: "tanstack-query",
    name: "TanStack Query for ReactCellType",
    globalName: "TanStackQuery",
    exists: true,
    typeDefinitionAvailable: true,
    ...overrides,
  };
}

function codes(plan: { readonly diagnostics: readonly { readonly code: string }[] }): readonly string[] {
  return plan.diagnostics.map(diagnostic => diagnostic.code);
}

/**
 * A config's normalized mapping set, or a failure that prints the diagnostics.
 *
 * The config here is the shape a project commits, and the normalization is `core`'s own
 * — so the table the compiler is handed below is the table a real project's config
 * produces, rather than a list this test assembled by hand.
 */
function normalizeOrThrow(config: unknown): { readonly mappings: readonly ExtensionExternalMapping[] } {
  const result = normalizeExtensionMappings(config);
  if (!result.ok) {
    throw new Error(
      `Expected this config to normalize:\n${result.diagnostics
        .map(diagnostic => `${diagnostic.path}: [${diagnostic.code}] ${diagnostic.message}`)
        .join("\n")}`,
    );
  }
  return result.mappings;
}

// The cross-module check below compiles the same decisions through #6's boundary, so
// it needs a bundle the artifact guards accept. It carries no dependency code at all:
// what is asserted is the metadata the two derivations agree on.
const TRIVIAL_BUNDLE = [
  `var ${CELL_ENTRY_COMPONENT_BINDING} = (function () {`,
  '  return function App() { return React.createElement("div", null, "trivial"); };',
  "})();",
].join("\n");

// No `resolveEntrySpecifiers`: no workspace graph is supplied, so `bundle` alone is
// a complete port for this fixture.
const bundler: CellBundlerPort = { bundle: async () => ({ code: TRIVIAL_BUNDLE, inlinedPackages: [] }) };

async function compileWith(dependencies: readonly DependencyDecision[]): Promise<CompileCellOutcome> {
  return compileCell({ entry: "src/App.tsx", dependencies }, { bundler });
}

// ---------------------------------------------------------------------------
// The generated module
// ---------------------------------------------------------------------------

describe("the generated extension externals module", () => {
  it("starts with the generated-module banner", () => {
    for (const moduleId of ["@tanstack/react-query", "@tanstack/query-core"]) {
      expect(renderExtensionExternalModule(CANONICAL_ROW, moduleId).startsWith(EXTENSION_EXTERNAL_GENERATED_BANNER)).toBe(
        true,
      );
    }
  });

  it("answers the authored import from the page object, with the page's own member identities", () => {
    // #12's first acceptance criterion: normal source imports keep working. An
    // `import { useQuery, QueryClient }` becomes a member access on `module.exports`,
    // and object identity is preserved because the member is the page's own value —
    // which is what "shared module/class/context identity across Cells" means in
    // practice.
    const facade = tanStackQueryFacade();
    const exported = extensionSandbox("TanStackQuery", facade).run(
      renderExtensionExternalModule(CANONICAL_ROW, "@tanstack/react-query"),
    );

    expect(exported.useQuery).toBe(facade.useQuery);
    expect(exported.QueryClient).toBe(facade.QueryClient);
  });

  it("exports the page object itself rather than a wrapper over it", () => {
    // Identity of the module, not only of its members. A wrapper that forwarded every
    // member would pass every behavioural check above and still fail this one, and a
    // consumer that enumerates the module — a namespace import does, see the interop
    // block below — has to see the real object's own names.
    const facade = tanStackQueryFacade();
    const source = renderExtensionExternalModule(CANONICAL_ROW, "@tanstack/react-query");

    expect(extensionSandbox("TanStackQuery", facade).run(source)).toBe(facade);
    expect(source).not.toContain("Proxy");
    expect(source).not.toContain("__esModule");
  });

  it("gives two packages of one extension the same member identity", () => {
    // The reason `@tanstack/query-core` rides on the react-query row: two imports must
    // not produce two `QueryClient` classes, or a cache one cell fills is invisible to
    // the next.
    const facade = tanStackQueryFacade();
    const reactQuery = extensionSandbox("TanStackQuery", facade).run(
      renderExtensionExternalModule(CANONICAL_ROW, "@tanstack/react-query"),
    );
    const queryCore = extensionSandbox("TanStackQuery", facade).run(
      renderExtensionExternalModule(CANONICAL_ROW, "@tanstack/query-core"),
    );

    expect(queryCore.QueryClient).toBe(reactQuery.QueryClient);
  });

  it("resolves the global exactly once, while its own body runs", () => {
    // The first load-order rule, as a countable property rather than a promise. One
    // read, at the moment the body runs: not zero (which would mean the module deferred
    // the decision to somewhere nothing can report it) and not one per use.
    const sandbox = extensionSandbox("TanStackQuery", tanStackQueryFacade());

    sandbox.run(renderExtensionExternalModule(CANONICAL_ROW, "@tanstack/react-query"));

    expect(sandbox.reads()).toBe(1);
  });

  it("fails by name, with the library and the global, when the page never loaded the library", () => {
    const error = caught(() =>
      extensionSandbox("TanStackQuery").run(
        renderExtensionExternalModule(CANONICAL_ROW, "@tanstack/query-core"),
      ),
    );

    expect(error.code).toBe("extension-global-missing");
    // The id the author actually imported, not the row's primary package: a failure
    // that named the wrong import would send a reader to the wrong file.
    expect(error.specifier).toBe("@tanstack/query-core");
    expect(error.libraryId).toBe("tanstack-query");
    expect(error.globalName).toBe("TanStackQuery");
    expect(error.fixOwner).toBe("extension-metadata");
  });

  it("reads exactly one global name, its own", () => {
    // The second load-order rule, as a property of the emitted text: a mapping cannot
    // require that one extension was loaded before another, because no code path names
    // another extension's global. Asserted as the *set* of names read, so a change in
    // how many times the module looks the global up does not read as a regression.
    const source = renderExtensionExternalModule(CANONICAL_ROW, "@tanstack/react-query");
    const read = globalsReadBy(source);

    expect(read.length).toBeGreaterThan(0);
    expect(new Set(read)).toEqual(new Set(["TanStackQuery"]));
  });

  it("is byte-stable for the same mapping", () => {
    // #6 promise 7, at this module's granularity: two runs over one row produce one
    // artifact body.
    expect(renderExtensionExternalModule(CANONICAL_ROW, "@tanstack/react-query")).toBe(
      renderExtensionExternalModule(CANONICAL_ROW, "@tanstack/react-query"),
    );
  });

  it("refuses to render a module id its row does not intercept", () => {
    expect(() => renderExtensionExternalModule(CANONICAL_ROW, "react-dom/client")).toThrow(
      /does not intercept/,
    );
  });
});

// ---------------------------------------------------------------------------
// The bundler's CommonJS -> ESM interop
// ---------------------------------------------------------------------------

/**
 * Bundles an entry against the generated module with the bundler this repository's
 * toolchain actually installs, and returns the single-chunk output.
 *
 * The point of going through a real build rather than hand-writing the interop helper is
 * that the failure this block exists for is invisible in the module's own source: the
 * module was correct on its own terms and wrong once a consumer's namespace import
 * enumerated it. `moduleType: "commonjs"` on the resolved id is what makes Rolldown treat
 * the interposed module the way #7's resolver hook will — leaving it unresolved would
 * make the import external instead, which is a shape #6 forbids and a different test.
 */
async function bundleWithRolldown(entrySource: string, moduleSource: string): Promise<string> {
  const bundle = await rolldown({
    input: "entry.js",
    plugins: [
      {
        name: "extension-externals-fixture",
        resolveId(source) {
          if (source === "entry.js") return source;
          if (source === EXTENSION_PACKAGE) return { id: `\0${EXTENSION_PACKAGE}`, moduleType: "commonjs" };
          return null;
        },
        load(id) {
          if (id === "entry.js") return entrySource;
          if (id === `\0${EXTENSION_PACKAGE}`) return moduleSource;
          return null;
        },
      },
    ],
  });
  const { output } = await bundle.generate({ format: "iife", name: "CellArtifact" });
  const chunk = output[0];
  if (chunk === undefined || chunk.type !== "chunk") throw new Error("Expected a single chunk.");
  return chunk.code;
}

const EXTENSION_PACKAGE = "@tanstack/react-query";

const NAMED_ENTRY = [
  `import { useQuery, QueryClient } from ${JSON.stringify(EXTENSION_PACKAGE)};`,
  `globalThis.RESULT = { useQuery: typeof useQuery, cls: typeof QueryClient, same: QueryClient };`,
].join("\n");

const NAMESPACE_ENTRY = [
  `import * as TQ from ${JSON.stringify(EXTENSION_PACKAGE)};`,
  `globalThis.RESULT = { useQuery: typeof TQ.useQuery, cls: typeof TQ.QueryClient, same: TQ.QueryClient, names: Object.keys(TQ).sort() };`,
].join("\n");

describe("the generated module through a real CommonJS -> ESM interop", () => {
  it("keeps a namespace import resolvable when the global is on the page", async () => {
    // The regression for the design this module first had. `import * as TQ` makes the
    // bundler build a namespace by enumerating `module.exports`; a module whose own
    // property names were only knowable later produced a namespace with nothing in it,
    // and `TQ.useQuery` stayed `undefined` for the rest of the page's life — silently,
    // while every `node:vm` test of the raw module passed.
    const code = await bundleWithRolldown(
      NAMESPACE_ENTRY,
      renderExtensionExternalModule(CANONICAL_ROW, "@tanstack/react-query"),
    );
    const facade = tanStackQueryFacade();
    const sandbox = extensionSandbox("TanStackQuery", facade);

    sandbox.runScript(code);

    expect(sandbox.result()?.useQuery).toBe("function");
    expect(sandbox.result()?.cls).toBe("function");
    expect(sandbox.result()?.same).toBe(facade.QueryClient);
    // The extension's own member names, which is the assertion this test exists for.
    // `default` is there because the interop helper adds one to any CommonJS module that
    // does not declare `__esModule`, and the page object cannot declare anything — it is
    // the extension's object, not ours to annotate. That is the same `default` every CJS
    // dependency of a cell would get, so it is the behaviour a cell's author expects
    // rather than an artifact of this mapping.
    expect(sandbox.result()?.names).toEqual(["QueryClient", "default", "hashKey", "useQuery"]);
  });

  it("keeps a named import resolvable when the global is on the page", async () => {
    const code = await bundleWithRolldown(
      NAMED_ENTRY,
      renderExtensionExternalModule(CANONICAL_ROW, "@tanstack/react-query"),
    );
    const facade = tanStackQueryFacade();
    const sandbox = extensionSandbox("TanStackQuery", facade);

    sandbox.runScript(code);

    expect(sandbox.result()?.useQuery).toBe("function");
    expect(sandbox.result()?.same).toBe(facade.QueryClient);
  });

  it("turns a global that arrives too late into a named error, not an empty namespace", async () => {
    // The two shapes differ only here, and this is why the module resolves the global
    // while its body runs. A deferred read left the namespace permanently empty —
    // `undefined` at every use, with nothing to report. Reading here fails once, by name.
    const code = await bundleWithRolldown(
      NAMESPACE_ENTRY,
      renderExtensionExternalModule(CANONICAL_ROW, "@tanstack/react-query"),
    );
    const sandbox = extensionSandbox("TanStackQuery");

    const error = caught(() => sandbox.runScript(code));

    expect(error.code).toBe("extension-global-missing");
    expect(sandbox.result()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

describe("planning the extension externals", () => {
  it("projects the table, one interception per intercepted module id", () => {
    const plan = planExtensionExternals();

    expect(plan.catalog.map(entry => entry.moduleId)).toEqual(["@tanstack/react-query", "@tanstack/query-core"]);
    expect(plan.catalog.every(entry => entry.bundledForbidden)).toBe(true);
    expect(plan.catalog[1]?.source).toContain('"@tanstack/query-core"');
    expect(interceptedExtensionExternalModuleIds()).toEqual(["@tanstack/react-query", "@tanstack/query-core"]);
  });

  it("says the activation is unstated rather than empty when nothing was supplied", () => {
    // "The caller did not say what this cell uses" and "this cell uses nothing" are
    // different answers, and only one of them may be wired from.
    const plan = planExtensionExternals();

    expect(plan.activation).toBe("unstated");
    expect(plan.wireable).toBe(false);
    expect(plan.interceptions).toEqual([]);
    expect(plan.diagnostics).toEqual([]);
  });

  it("reads an explicitly empty decision list as stated, not as unstated", () => {
    // Review regression (#48, finding 2). `decisions: []` is a caller that knows there
    // are no decisions; classifying it as "unknown" made a known-empty artifact
    // indistinguishable from an unspecified one, which is exactly the distinction
    // `activation` exists to draw.
    const knownEmpty = planExtensionExternals({ decisions: [] });
    const alsoKnownEmpty = planExtensionExternals({ referencedSpecifiers: [] });
    const unspecified = planExtensionExternals({});

    expect(knownEmpty.activation).toBe("stated");
    expect(knownEmpty.wireable).toBe(true);
    expect(knownEmpty.interceptions).toEqual([]);
    expect(alsoKnownEmpty.activation).toBe("stated");
    expect(unspecified.activation).toBe("unstated");
  });

  it("activates a module the decisions name", () => {
    const plan = planExtensionExternals({
      decisions: [extensionDecision("@tanstack/react-query"), extensionDecision("@tanstack/query-core")],
    });

    expect(extensionExternalModuleIds(plan)).toEqual(["@tanstack/react-query", "@tanstack/query-core"]);
    expect(plan.activation).toBe("stated");
  });

  it("collapses two packages of one extension into one library reference", () => {
    // #12's "frontendLibraries metadata is generated without duplicates", at this
    // module's granularity.
    const plan = planExtensionExternals({
      decisions: [extensionDecision("@tanstack/react-query"), extensionDecision("@tanstack/query-core")],
    });

    expect(plan.libraries).toEqual([frontendLibraryReference("tanstack-query")]);
    expect(plan.libraries).toHaveLength(1);
  });

  it("reports the same library metadata #6 derives for the artifact", async () => {
    // Two independent derivations — the plan's activation and #6's collection over the
    // decisions — compared against the artifact the boundary actually produces, so the
    // plan cannot promise a library the artifact does not declare.
    const dependencies = [extensionDecision("@tanstack/react-query"), extensionDecision("@tanstack/query-core")];
    const plan = planExtensionExternals({
      decisions: dependencies,
      referencedSpecifiers: ["@tanstack/react-query"],
    });

    const outcome = await compileWith(dependencies);
    if (outcome.status !== "compiled") throw new Error("Expected the artifact to compile.");
    expect(plan.libraries).toEqual(outcome.artifact.frontendLibraries);
  });

  it("does not activate a reference with no decision, and says what is missing instead", () => {
    // The state #12's third load-order rule is about, and the one #6's own audit cannot
    // see: the interposition means the import never reaches the bundler as an external
    // one, so nothing else would notice that no library was declared.
    const plan = planExtensionExternals({ referencedSpecifiers: ["@tanstack/react-query"] });

    expect(plan.interceptions).toEqual([]);
    expect(codes(plan)).toEqual(["extension-not-declared"]);
    expect(plan.diagnostics[0]?.detail).toContain('"tanstack-query"');
  });

  it("activates a reference whose governing decision is an extension decision", () => {
    const plan = planExtensionExternals({
      decisions: [extensionDecision("@tanstack/react-query")],
      referencedSpecifiers: ["@tanstack/react-query"],
    });

    expect(extensionExternalModuleIds(plan)).toEqual(["@tanstack/react-query"]);
    expect(plan.diagnostics).toEqual([]);
  });

  it("leaves a reference alone when the artifact deliberately carries its own copy", () => {
    // A mapping row says how an `extension` decision compiles; it is not a policy that
    // the package must be `extension`. Reporting either of these would make a
    // legitimate configuration unwritable.
    const inlined = planExtensionExternals({
      decisions: [inlineDecision("@tanstack/react-query")],
      referencedSpecifiers: ["@tanstack/react-query"],
    });
    const decidedButNotReferenced = planExtensionExternals({ decisions: [inlineDecision("@tanstack/react-query")] });

    expect(inlined.interceptions).toEqual([]);
    expect(inlined.diagnostics).toEqual([]);
    expect(decidedButNotReferenced.diagnostics).toEqual([]);
  });

  it("reports an extension decision the table has no row for", () => {
    const plan = planExtensionExternals({ decisions: [extensionDecision("echarts", "echarts-ext", "EChartsFacade")] });

    expect(codes(plan)).toEqual(["extension-mapping-missing"]);
    expect(plan.interceptions).toEqual([]);
  });

  it("reports a decision that names a different library or global than its row", () => {
    const wrongLibrary = planExtensionExternals({
      decisions: [extensionDecision("@tanstack/react-query", "some-other-library")],
    });
    const wrongGlobal = planExtensionExternals({
      decisions: [extensionDecision("@tanstack/react-query", "tanstack-query", "SomeOtherGlobal")],
    });

    // One finding, not two. A contradiction like this used to also produce
    // `extension-not-declared` — a consequence of the mismatch, and one that stopped
    // being true once a contradictory mapping became non-wireable: there is no
    // interception any more, so there is nothing "resolved through" the row's library.
    expect(codes(wrongLibrary)).toEqual(["extension-mapping-conflict"]);
    expect(wrongLibrary.diagnostics[0]?.detail).toContain('"tanstack-query"');
    expect(codes(wrongGlobal)).toEqual(["extension-mapping-conflict"]);
    expect(wrongGlobal.diagnostics[0]?.detail).toContain('binds "TanStackQuery"');
  });

  it("is order-independent for decisions and references alike", () => {
    // #12's deterministic-ordering requirement, and the mechanism behind "never assume
    // one extension can depend on another extension being loaded first": nothing the
    // plan reports depends on the order the caller listed things in.
    const forward = planExtensionExternals({
      decisions: [extensionDecision("@tanstack/react-query"), extensionDecision("@tanstack/query-core")],
      referencedSpecifiers: ["@tanstack/react-query", "@tanstack/query-core"],
    });
    const reversed = planExtensionExternals({
      decisions: [extensionDecision("@tanstack/query-core"), extensionDecision("@tanstack/react-query")],
      referencedSpecifiers: ["@tanstack/query-core", "@tanstack/react-query"],
    });

    const shape = (plan: typeof forward) => ({
      catalog: plan.catalog.map(entry => entry.moduleId),
      interceptions: extensionExternalModuleIds(plan),
      libraries: plan.libraries,
      diagnostics: plan.diagnostics,
      sources: plan.catalog.map(entry => entry.source),
    });
    expect(shape(reversed)).toEqual(shape(forward));
  });

  it("returns a plan for an incoherent table rather than throwing, and keeps the rest of the audit", () => {
    // Two libraries claiming one page global: a state the platform's own validation
    // refuses, so a table that allowed it would describe a designer state that cannot
    // be reached.
    const incoherent = [
      mapping({ packageName: "a", libraryId: "lib-a", globalName: "Shared" }),
      mapping({ packageName: "b", libraryId: "lib-b", globalName: "Shared" }),
    ];

    const plan = planExtensionExternals({ mappings: incoherent, decisions: [extensionDecision("a", "lib-a", "Shared")] });

    expect(codes(plan)).toContain("extension-mapping-conflict");
    // The regression that matters: a failure anywhere in the construction chain must
    // not discard the entries that are fine, which is what "return an empty plan"
    // would look like from the outside.
    expect(plan.catalog.map(entry => entry.moduleId)).toEqual(["a", "b"]);
    // And the other half: the catalog survives for diagnosis while nothing may be wired
    // from it, so a caller cannot resolve its imports by table order by reading the
    // diagnostics late.
    expect(plan.activation).toBe("stated");
    expect(plan.wireable).toBe(false);
    expect(plan.interceptions).toEqual([]);
  });

  it("makes a table in which two rows claim one module id non-wireable", () => {
    // Review regression (#48, finding 1). The activation predicate matches the module
    // id, so with two rows claiming one id both interceptions satisfied it and
    // `interceptions` carried two different generated sources for a single import —
    // wireable, and resolved by table order. `extension-mapping-conflict` was already
    // reported, but a diagnostic is advice: the list itself has to be unusable.
    const colliding = [
      mapping({ packageName: "shared", libraryId: "lib-a", globalName: "LibA" }),
      mapping({ packageName: "other", libraryId: "lib-b", globalName: "LibB", moduleIds: ["shared"] }),
    ];

    const plan = planExtensionExternals({
      mappings: colliding,
      decisions: [extensionDecision("shared", "lib-a", "LibA")],
      referencedSpecifiers: ["shared"],
    });

    expect(codes(plan)).toContain("extension-mapping-conflict");
    expect(plan.wireable).toBe(false);
    expect(plan.interceptions).toEqual([]);
    // The catalog shows the reason: one module id, two rows.
    expect(plan.catalog.map(entry => entry.moduleId)).toEqual(["shared", "other", "shared"]);
  });

  it("uses the caller's table end to end, not the shipped default", () => {
    // A row a caller adds has to participate in activation and generation, not merely
    // appear in the catalog: a capability the bridge refuses to use is worse than one
    // it does not have.
    const custom = [mapping({ packageName: "es-toolkit", libraryId: "es-toolkit-ext", globalName: "EsToolkit" })];
    const plan = planExtensionExternals({
      mappings: custom,
      decisions: [extensionDecision("es-toolkit", "es-toolkit-ext", "EsToolkit")],
      referencedSpecifiers: ["es-toolkit"],
    });

    expect(plan.catalog.map(entry => entry.moduleId)).toEqual(["es-toolkit"]);
    expect(extensionExternalModuleIds(plan)).toEqual(["es-toolkit"]);
    expect(plan.libraries).toEqual([frontendLibraryReference("es-toolkit-ext")]);
    expect(plan.interceptions[0]?.source).toContain('globalThis["EsToolkit"]');
    expect(plan.interceptions[0]?.source).not.toContain("TanStackQuery");
  });

  it("keeps an unstated metadata audit distinct from a supplied one", () => {
    const unstated = planExtensionExternals({ decisions: [extensionDecision("@tanstack/react-query")] });
    const stated = planExtensionExternals({
      decisions: [extensionDecision("@tanstack/react-query")],
      extensionLibraries: [listing()],
    });
    const empty = planExtensionExternals({
      decisions: [extensionDecision("@tanstack/react-query")],
      extensionLibraries: [],
    });

    expect(unstated.metadata).toBe("unstated");
    expect(unstated.diagnostics).toEqual([]);
    expect(stated.metadata).toBe("stated");
    expect(stated.diagnostics).toEqual([]);
    // An empty listing is "checked, and nothing is verified", which is a finding
    // rather than a pass.
    expect(empty.metadata).toBe("stated");
    expect(codes(empty)).toEqual(["extension-library-unverified"]);
  });

  it("audits only the mappings this artifact depends on", () => {
    // A project is not required to have installed every extension the table knows
    // about, so a listing that omits a row the artifact never touches is not a finding.
    // A finding here would be a diagnostic about something unused, which is what turns
    // a checker into noise.
    const twoRows = [
      mapping({ packageName: "used", libraryId: "used-lib", globalName: "UsedLib" }),
      mapping({ packageName: "unused", libraryId: "unused-lib", globalName: "UnusedLib" }),
    ];
    const listingOfUsedOnly: ExtensionLibraryListing[] = [
      { id: "used-lib", name: "Used", globalName: "UsedLib", exists: true, typeDefinitionAvailable: true },
    ];

    const plan = planExtensionExternals({
      mappings: twoRows,
      decisions: [extensionDecision("used", "used-lib", "UsedLib")],
      extensionLibraries: listingOfUsedOnly,
    });

    expect(plan.metadata).toBe("stated");
    expect(plan.diagnostics).toEqual([]);
  });

  it("reports each way the extension metadata can disagree with the table", () => {    const decisions = [extensionDecision("@tanstack/react-query")];
    const cases: readonly {
      readonly name: string;
      readonly listing: ExtensionLibraryListing;
      readonly code: string;
    }[] = [
      { name: "unknown id", listing: listing({ id: "other" }), code: "extension-library-unverified" },
      { name: "renamed global", listing: listing({ globalName: "QueryGlobal" }), code: "extension-global-mismatch" },
      { name: "absent bundle", listing: listing({ exists: false }), code: "extension-bundle-missing" },
      {
        name: "no types",
        listing: listing({ typeDefinitionAvailable: false }),
        code: "extension-types-missing",
      },
    ];

    for (const testCase of cases) {
      const plan = planExtensionExternals({ decisions, extensionLibraries: [testCase.listing] });
      expect(codes(plan), testCase.name).toEqual([testCase.code]);
    }
  });

  it("renders a plan report naming the libraries and both activation states", () => {
    const plan = planExtensionExternals({ decisions: [extensionDecision("@tanstack/react-query")] });
    const report = formatExtensionExternalsPlan(plan);

    expect(report).toContain("@tanstack/react-query -> TanStackQuery");
    expect(report).toContain("frontendLibraries: tanstack-query");
    expect(report).toContain("Wiring: allowed");
    expect(report).toContain("Extension metadata: unstated");
    expect(report).toContain("No extension externals diagnostics.");
  });

  it("names which of the two reasons a plan is not wireable", () => {
    // "Tell me what this cell uses" and "the mapping information contradicts itself" are
    // different next actions, so a report that said only "refused" would send a reader to
    // the wrong one.
    const unspecified = formatExtensionExternalsPlan(planExtensionExternals());
    const contradictory = formatExtensionExternalsPlan(
      planExtensionExternals({
        mappings: [mapping({ packageName: "a", libraryId: "lib", globalName: "Lib" })],
        decisions: [extensionDecision("a", "other-lib", "Lib")],
      }),
    );

    expect(unspecified).toContain("Wiring: refused (no decisions and no reference list were supplied");
    expect(contradictory).toContain("the mapping information contradicts itself");
  });

  it("does not wire a plan whose decision contradicts the row it selects", () => {
    // Review follow-up: the same "two answers to one question" failure as the table-level
    // collision, reached from the other side. The decision names one library, the row
    // names another, so the interception would read one global while the artifact
    // declares the other library.
    const plan = planExtensionExternals({
      decisions: [extensionDecision("@tanstack/react-query", "some-other-library")],
      referencedSpecifiers: ["@tanstack/react-query"],
    });

    expect(codes(plan)).toContain("extension-mapping-conflict");
    expect(plan.wireable).toBe(false);
    expect(plan.interceptions).toEqual([]);
  });

  it("still wires when the only finding is a mapping that does not exist", () => {
    // The bound on the rule above: "there is no mapping for this package" is a truthful
    // absence rather than a contradiction, and the mappings that do exist are still
    // precisely known — so the interceptions this artifact does have remain usable.
    const plan = planExtensionExternals({
      decisions: [extensionDecision("@tanstack/react-query"), extensionDecision("echarts", "echarts-ext", "ECharts")],
    });

    expect(codes(plan)).toEqual(["extension-mapping-missing"]);
    expect(plan.wireable).toBe(true);
    expect(extensionExternalModuleIds(plan)).toEqual(["@tanstack/react-query"]);
  });
});

// ---------------------------------------------------------------------------
// A project's own mappings, from config to artifact (#85)
// ---------------------------------------------------------------------------

describe("a project's own mappings reach the compile (#85)", () => {
  it("compiles a package the built-in table has never heard of, with no change to `core`", async () => {
    // #85's first criterion, asserted where it actually matters: through the *plan the
    // compiler wires*, over a config the project wrote, with `core`'s table untouched.
    // The block above proves the plan honours a caller's table; this proves the table a
    // *config* produces is such a table, which is the gap #85 exists to close.
    const normalized = normalizeOrThrow({
      cells: {},
      extensions: {
        mappings: [
          {
            packageName: "@acme/widgets",
            libraryId: "acme-widgets",
            globalName: "AcmeWidgets",
            metadataSource: "verified-catalog",
            metadataReference: "acme/forguncy-library",
            verificationRule: "A verified catalog entry whose id and global the listing confirms.",
            verifiedBy: ["product-documentation"],
            note: "a project row, which the built-in table does not carry",
          },
        ],
      },
    });

    expect(EXTENSION_EXTERNAL_MAPPINGS.map(row => row.packageName)).not.toContain("@acme/widgets");

    const plan = planExtensionExternals({
      mappings: normalized.mappings,
      decisions: [extensionDecision("@acme/widgets", "acme-widgets", "AcmeWidgets")],
      referencedSpecifiers: ["@acme/widgets"],
    });

    expect(plan.wireable).toBe(true);
    expect(plan.diagnostics).toEqual([]);
    expect(extensionExternalModuleIds(plan)).toEqual(["@acme/widgets"]);
    expect(plan.interceptions[0]?.source).toContain('globalThis["AcmeWidgets"]');
    // The TanStack Query row is still there, because a project row adds rather than
    // replaces — so adding one extension cannot silently drop another.
    expect(plan.catalog.map(entry => entry.moduleId)).toContain("@tanstack/react-query");
  });

  it("derives the artifact's `frontendLibraries` from a project row, exactly once", () => {
    // The metadata half of the same criterion: a project row has to reach
    // `frontendLibraries`, and the canonicalization has to collapse a row's declared
    // module ids back into one reference.
    //
    // Asserted on the plan rather than through `compileCell`, and that is the scope
    // boundary rather than an omission: `compileCell` takes no mapping option yet, so
    // wiring the config into the pre-bundle pass, the bundler and the artifact metadata
    // is #86's work. What #85 owes is that the normalized rows *produce* the right
    // metadata, which is the derivation `collectFrontendLibraries` runs over the same
    // decisions the artifact is assembled from.
    const normalized = normalizeOrThrow({
      cells: {},
      extensions: {
        mappings: [
          {
            packageName: "@acme/widgets",
            moduleIds: ["@acme/widgets-core"],
            libraryId: "acme-widgets",
            globalName: "AcmeWidgets",
            metadataSource: "verified-catalog",
            metadataReference: "acme/forguncy-library",
            verificationRule: "A verified catalog entry whose id and global the listing confirms.",
            verifiedBy: ["product-documentation"],
            note: "a project row, which the built-in table does not carry",
          },
        ],
      },
    });

    const plan = planExtensionExternals({
      mappings: normalized.mappings,
      decisions: [extensionDecision("@acme/widgets-core", "acme-widgets", "AcmeWidgets")],
      referencedSpecifiers: ["@acme/widgets-core"],
    });

    // Two module ids resolved through one row, and one reference — #12's "one extension
    // stands in for more than one package", which a project row inherits.
    //
    // The two lists are read separately on purpose, because they answer different
    // questions: the *catalog* is the row's whole capability (both ids), while the
    // *interceptions* are what this artifact activates (the id it actually imports).
    // Asserting only the second would leave "the row covers its sibling" unpinned.
    const projectIds = plan.catalog
      .map(entry => entry.moduleId)
      .filter(moduleId => moduleId.startsWith("@acme/"));
    expect(projectIds).toEqual(["@acme/widgets", "@acme/widgets-core"]);
    // The built-ins are still in the catalog, which is what "additive" means in practice:
    // a project row was added and the TanStack Query row is still planned for.
    expect(plan.catalog.map(entry => entry.moduleId)).toContain("@tanstack/react-query");
    expect(extensionExternalModuleIds(plan)).toEqual(["@acme/widgets-core"]);
    expect(plan.libraries).toEqual([frontendLibraryReference("acme-widgets")]);
    expect(plan.diagnostics).toEqual([]);
  });

  it("refuses a config whose project row collides with the built-in table, before any compile", () => {
    // #85's third criterion at the config boundary: the conflict is a *config* error
    // with a config path, so it is reported before a bundler is ever asked to build —
    // not discovered later as a plan diagnostic that cannot say which file was wrong.
    const result = normalizeExtensionMappings({
      cells: {},
      extensions: {
        mappings: [
          {
            packageName: "@tanstack/react-query",
            libraryId: "other-library",
            globalName: "OtherGlobal",
            metadataSource: "verified-catalog",
            metadataReference: "acme/forguncy-library",
            verificationRule: "A second claim for a package the built-in table already maps.",
            verifiedBy: ["product-documentation"],
            note: "a second claim for a package the built-in table already maps",
          },
        ],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["extension-mapping-conflict"]);
    expect(result.diagnostics[0]?.path).toBe("extensions.mappings");
  });
});
