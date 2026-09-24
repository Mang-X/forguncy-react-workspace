/**
 * The `extension` dependency PoC: `examples/extension-query` compiled for real.
 *
 * Decision source: GitHub Issue #13 — "Implement: `extension` PoC with existing
 * TanStack Query package" (https://github.com/Mang-X/forguncy-react-workspace/issues/13),
 * under governing Spec #12 (https://github.com/Mang-X/forguncy-react-workspace/issues/12)
 * with the compilation path built by #7 (https://github.com/Mang-X/forguncy-react-workspace/issues/7).
 *
 * #13's steps 1–6 are what this file executes: the example carries a real
 * `@tanstack/react-query` source dependency (for authored-source types and the
 * editor), one recorded `extension` decision — read from the example's own
 * `fgc.lock.json`, conformance-audited, then projected — maps it to
 * `libraryId: tanstack-query` / global `TanStackQuery`, the compiler
 * externalizes every import of it to the generated extension module,
 * `frontendLibraries` is derived from that decision rather than written by
 * hand, and the artifact is asserted — several ways — to contain no npm
 * implementation of the package. The example's own self-check
 * (`client=pass | provider=pass | query=pass`) is what turns "the wiring works"
 * into an assertion: every verdict is computed from the objects the *page
 * global* handed the cell, so a cell that bundled its own copy, resolved the
 * wrong identity, or silently read `undefined` renders `fail`.
 *
 * Two projections, two questions (PR review of #61, P1): #13 steps 7–8 have
 * run — the committed lock records the Forguncy target a real runtime
 * validation observed, so `realRuntimeValidation` is `"validated"` for this
 * record. Both projections are asserted against that fact:
 *
 * - The **deployment gate** (`compilationDependencies`) *admits* the fresh,
 *   runtime-validated record; a copy with `target` cleared (the honest
 *   pre-validation state) still withholds with
 *   `realRuntimeValidation: "not-validated"`, and a moved extension
 *   (`extension-version-changed` or `extension-identity-changed`) still
 *   withholds as staleness — a recorded runtime claim freezes neither axis.
 * - The **local projection** (`localCompilationDependencies`, after the same
 *   conformance audit + a real `LockEnvironment`) is what feeds `compileCell`.
 *   It enforces freshness on every axis (package/probe/toolchain/extension
 *   drift still withholds) and only relaxes `realRuntimeValidation`, so
 *   "recorded decision → externalization" is proven end-to-end.
 *
 * Version alignment — the package.json pin, the install graph, the lock record
 * and the environment's extension version — is asserted equal on `5.102.8`.
 * The lock's `extension.identity` (the integrity hash `listFrontendLibraries`
 * reported) is asserted equal to the environment's `extensionIdentities` entry,
 * so the identity axis is checked end-to-end rather than left null.
 *
 * Shared identity — #13's reason this package is `extension` and not `inline` —
 * is tested explicitly rather than inferred: the last test compiles the example
 * twice and evaluates both Cells against *one* sandbox global, then requires the
 * two Cells to have bound the very same provider function and the very same
 * `QueryClient` class. Two Cells each constructing their own client instance is
 * the expected shape (module scope is per Cell); cache sharing across Cells is an
 * application-level choice, not something this PoC claims. #13's steps 7–8
 * discharged the real two-Cell validation in a real project; this file does
 * not substitute for it, and its sandbox is not evidence for it.
 *
 * What is deliberately *not* claimed: AGENTS.md rule 7 forbids presenting any
 * of *this file* as Forguncy runtime compatibility. These tests prove
 * compilation, assembly and sandboxed evaluation of the artifact; the
 * real-runtime evidence lives on #13 itself (MCP-sync into a real project,
 * two Cells rendering on a real page).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, Script } from "node:vm";

import type { DependencyDecision, LockEnvironment } from "@forguncy-react-workspace/core";
import { EXTENSION_EXTERNAL_MAPPINGS, RUNTIME_CONTRACT_TARGET } from "@forguncy-react-workspace/core";
import type { ExtensionCatalog, WithheldCompilationDependency } from "@forguncy-react-workspace/dependency-resolver";
import {
  auditLockDecisionConformance,
  compilationDependencies,
  composeProbeFingerprint,
  conformanceErrors,
  localCompilationDependencies,
  readFgcLock,
  recordedPackageNames,
  resolveInstalledVersions,
} from "@forguncy-react-workspace/dependency-resolver";
import { describe, expect, it } from "vitest";

import { compileCell } from "./artifact.ts";
import type { CompileCellOutcome } from "./artifact.ts";
import { CELL_ENTRY_COMPONENT_BINDING } from "./entry.ts";
import { createRolldownCellBundler } from "./rolldown-bundler.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const exampleRoot = join(packageRoot, "..", "..", "examples", "extension-query");
const entry = "src/App.tsx";

const PACKAGE_NAME = "@tanstack/react-query";
const EXPECTED_VERSION = "5.102.8";
const EXPECTED_IDENTITY = "sha256:37df6a5941008a3de11d76d481ff9ab43331e6ed0b278a0ada69f803710bde3e";
const EXPECTED_REPORT = "client=pass | provider=pass | query=pass";

/**
 * #12's shipped mapping table, projected onto the shape the conformance audit
 * reads — so the catalog the test supplies is the same table the compiler
 * compiles against, not a second hand-written copy that could drift.
 */
const EXTENSION_CATALOG: ExtensionCatalog = {
  mappings: EXTENSION_EXTERNAL_MAPPINGS.map(mapping => ({
    packageName: mapping.packageName,
    libraryId: mapping.libraryId,
    globalName: mapping.globalName,
  })),
};

/**
 * The `LockEnvironment` a real project's page would report right now.
 *
 * Versions come from the install graph the bundler reads; the probe
 * fingerprint is recomposed from the same declared inputs the recorded probe
 * used (recomputable without re-running, #8 rule 2); the extension version is
 * what `api.app.listFrontendLibraries` reports for a page that has the
 * verified extension installed.
 */
async function environmentFor(overrides: Partial<LockEnvironment> = {}): Promise<LockEnvironment> {
  const lock = await readFgcLock(exampleRoot);
  const { versions } = await resolveInstalledVersions(exampleRoot, recordedPackageNames(lock));
  const probeFingerprints: Record<string, string> = {};
  for (const record of lock.decisions) {
    probeFingerprints[record.packageName] = composeProbeFingerprint({
      probeId: "inline-bundle",
      entry: PACKAGE_NAME,
    }).fingerprint;
  }

  return {
    resolvedVersions: versions,
    target: RUNTIME_CONTRACT_TARGET,
    toolchain: { vitePlus: "0.3.2" },
    probeFingerprints,
    extensionVersions: { "tanstack-query": EXPECTED_VERSION },
    extensionIdentities: { "tanstack-query": EXPECTED_IDENTITY },
    ...overrides,
  };
}

/** Read + conformance-audit the example's lock, asserting no conformance errors. */
async function conformedLock() {
  const lock = await readFgcLock(exampleRoot);
  const diagnostics = auditLockDecisionConformance(lock, { extensionCatalog: EXTENSION_CATALOG });
  expect(conformanceErrors(diagnostics).map(diagnostic => diagnostic.code)).toEqual([]);
  return lock;
}

/**
 * The local/probe projection the PoC compiles through: conformance-audited
 * lock + environment → `localCompilationDependencies` → `compileCell`.
 * Freshness still gates; only real-runtime validation is relaxed. Explicitly
 * *not* the deployment gate — see the gate tests below.
 */
async function dependenciesFromLock(environment?: LockEnvironment): Promise<{
  dependencies: readonly DependencyDecision[];
  withheld: readonly WithheldCompilationDependency[];
}> {
  const lock = await conformedLock();
  return localCompilationDependencies(lock, environment ?? (await environmentFor()));
}

/**
 * The deployment gate a real ship path runs: conformance-audited lock +
 * environment → `compilationDependencies`. Admits the recorded target when
 * fresh; the gate tests below assert both withheld states (no target, drift).
 */
async function deploymentGate(environment?: LockEnvironment): Promise<{
  dependencies: readonly DependencyDecision[];
  withheld: readonly WithheldCompilationDependency[];
}> {
  const lock = await conformedLock();
  return compilationDependencies(lock, environment ?? (await environmentFor()));
}

function compileWith(dependencies: readonly DependencyDecision[]): Promise<CompileCellOutcome> {
  return compileCell({ entry, dependencies }, { bundler: createRolldownCellBundler({ dir: exampleRoot }) });
}

async function compileExample(): Promise<CompileCellOutcome> {
  const { dependencies, withheld } = await dependenciesFromLock();
  expect(withheld).toEqual([]);
  expect(dependencies).toHaveLength(1);
  return compileWith(dependencies);
}

function compiledCodeOf(outcome: Extract<CompileCellOutcome, { readonly status: "compiled" }>): string {
  return outcome.artifact.code;
}

async function compiledArtifact(): Promise<string> {
  const outcome = await compileExample();
  expect(outcome.status).toBe("compiled");
  if (outcome.status !== "compiled") throw new Error("The example did not compile.");
  return compiledCodeOf(outcome);
}

// ---------------------------------------------------------------------------
// The page objects
// ---------------------------------------------------------------------------

interface CellElement {
  readonly type: unknown;
  readonly props: Readonly<Record<string, unknown>>;
}

type CellComponent = () => CellElement;

/**
 * The page's React, reduced to what the example touches.
 *
 * A stub rather than the installed `react`: the artifact under test must read
 * the *page* object through the generated JSX runtime adapter, and a stub makes
 * that observable — an artifact that bundled its own React would ignore this
 * object entirely.
 */
function reactStub(): Record<string, unknown> {
  return {
    version: "19.2.7",
    Fragment: Symbol.for("react.fragment"),
    createElement: (type: unknown, props: Record<string, unknown> | null) => ({ type, props: props ?? {} }),
  };
}

/**
 * The extension global a page that loaded `tanstack-query` would publish.
 *
 * `from-page-global` is unique to this facade: the authored `queryFn` returns a
 * different string and never runs in the sandbox, so rendered text carrying
 * `from-page-global` proves the data reached the cell through the page object —
 * global → generated module → interop → hook → element. Like every facade in
 * this suite, this is a fixture, never evidence that the real extension exists.
 */
function tanStackQueryFacade(): Record<string, unknown> {
  class QueryClient {
    readonly label = "page query client";
  }
  const QueryClientProvider = (props: Readonly<Record<string, unknown>>): unknown => props.children;
  const useQuery = (): Record<string, unknown> => ({ data: "from-page-global" });
  return { QueryClient, QueryClientProvider, useQuery };
}

/** Page functions an expanded tree must stop at, not call — they are the *page's*. */
function pageOpaqueSet(facade: Readonly<Record<string, unknown>>): ReadonlySet<unknown> {
  return new Set(Object.values(facade));
}

// ---------------------------------------------------------------------------
// Sandbox evaluation
// ---------------------------------------------------------------------------

interface CellSandbox {
  /** Evaluate one compiled Cell artifact, as a page loading a Cell would. */
  readonly run: (code: string) => void;
  /** The entry component the most recent `run` bound. */
  readonly component: () => CellComponent;
}

/**
 * Evaluates artifacts in an isolated `vm` context seeded with `globals`.
 *
 * One sandbox can run several artifacts, which is what makes the shared-identity
 * test possible: both Cells observe the *same* `TanStackQuery` value, exactly as
 * two Cells on one page observe the one global the extension published. `node:vm`
 * rather than the test process so the stubbed page globals are the only ones the
 * artifacts can see, and `globalThis` is aliased onto the sandbox before the
 * context is created because the generated host and extension modules read their
 * page objects through `globalThis`.
 */
function createSandbox(globals: Readonly<Record<string, unknown>>): CellSandbox {
  const state: Record<string, unknown> = { ...globals };
  state.globalThis = state;
  const context = createContext(state);

  return {
    run: (code: string): void => {
      new Script(code, { filename: "cell-artifact.js" }).runInContext(context);
    },
    component: (): CellComponent => {
      const component = state[CELL_ENTRY_COMPONENT_BINDING];
      if (typeof component !== "function") {
        throw new Error(`The artifact did not bind a function to ${CELL_ENTRY_COMPONENT_BINDING}.`);
      }
      return component as CellComponent;
    },
  };
}

// ---------------------------------------------------------------------------
// Element-tree inspection
// ---------------------------------------------------------------------------

/**
 * Renders artifact-local components in an element tree, by hand.
 *
 * The stub React builds elements but never invokes function children, while the
 * example puts its self-check inside `QueryClientProvider` — a *page* function
 * this helper deliberately does not call. So: call every function element that is
 * not one of the facade's values (those are the page's, and calling them would
 * test the fixture instead of the artifact), recurse into everything else, and
 * stop at host strings. The probe component's hook call works because the
 * facade's `useQuery` is an ordinary function; on a real page React performs
 * this same invocation inside the provider's context.
 */
function expandTree(node: unknown, opaque: ReadonlySet<unknown>): unknown {
  if (Array.isArray(node)) {
    return node.map(child => expandTree(child, opaque));
  }
  if (typeof node !== "object" || node === null || !("type" in node) || !("props" in node)) {
    return node;
  }
  const element = node as CellElement;
  if (typeof element.type === "function" && !opaque.has(element.type)) {
    const rendered = (element.type as (props: Readonly<Record<string, unknown>>) => unknown)(element.props);
    return expandTree(rendered, opaque);
  }
  return {
    type: element.type,
    props: { ...element.props, children: expandTree(element.props.children, opaque) },
  };
}

/** Every text node in an element tree, in render order. */
function flattenText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) flattenText(item, out);
    return out;
  }
  if (typeof node === "object" && node !== null && "props" in node) {
    flattenText((node as CellElement).props.children, out);
  }
  return out;
}

function findElements(node: unknown, predicate: (element: CellElement) => boolean, out: CellElement[] = []): CellElement[] {
  if (Array.isArray(node)) {
    for (const item of node) findElements(item, predicate, out);
    return out;
  }
  if (typeof node === "object" && node !== null && "type" in node && "props" in node) {
    const element = node as CellElement;
    if (predicate(element)) out.push(element);
    findElements(element.props.children, predicate, out);
  }
  return out;
}

function providerFrom(tree: unknown, facade: Readonly<Record<string, unknown>>): CellElement {
  const [provider] = findElements(tree, element => element.type === facade.QueryClientProvider);
  if (provider === undefined) {
    throw new Error("The rendered tree contains no QueryClientProvider element from the page facade.");
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extension tanstack-query PoC (#13)", () => {
  it("authors ordinary @tanstack/react-query imports, with no extension global in sight", () => {
    const source = readFileSync(join(exampleRoot, entry), "utf8");

    // #13's source-shape requirement: a normal npm import and a QueryClient /
    // provider / query example. The negative half is the acceptance criterion —
    // authored source never names the extension global or the metadata field;
    // both are the compiler's side of the contract.
    expect(source).toContain('import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"');
    expect(source).toContain("new QueryClient()");
    expect(source).toContain("useQuery({");
    expect(source).toContain("QueryClientProvider");
    expect(source).not.toContain("TanStackQuery");
    expect(source).not.toContain("frontendLibraries");
  });

  it("aligns the package.json pin, the install graph and the lock record on one version", async () => {
    // PR review of #61 point 1: the pin, the installed package, the recorded
    // `resolvedVersion`/`extension.version` and the environment's extension
    // version must all be the verified extension's version — the chain fails
    // closed the moment any of them drifts.
    const manifest = JSON.parse(readFileSync(join(exampleRoot, "package.json"), "utf8")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
    };
    expect(manifest.dependencies?.[PACKAGE_NAME]).toBe(EXPECTED_VERSION);

    const lock = await readFgcLock(exampleRoot);
    const record = lock.decisions.find(candidate => candidate.packageName === PACKAGE_NAME);
    expect(record?.resolvedVersion).toBe(EXPECTED_VERSION);
    expect(record?.extension?.version).toBe(EXPECTED_VERSION);
    expect(record?.extension?.identity).toBe(EXPECTED_IDENTITY);

    const environment = await environmentFor();
    expect(environment.resolvedVersions[PACKAGE_NAME]).toBe(EXPECTED_VERSION);
    expect(environment.extensionVersions["tanstack-query"]).toBe(EXPECTED_VERSION);
    expect(environment.extensionIdentities["tanstack-query"]).toBe(EXPECTED_IDENTITY);
  });

  it("admits the decision through the deployment gate now that a real runtime check recorded a target", async () => {
    // #13 steps 7–8 have run: the committed lock records the observed
    // Forguncy target, so a fresh environment makes the deployment gate admit
    // the decision — the gate path end-to-end, not the local relaxation.
    const { dependencies, withheld } = await deploymentGate();

    expect(withheld).toEqual([]);
    expect(dependencies).toEqual([
      {
        strategy: "extension",
        packageName: PACKAGE_NAME,
        libraryId: "tanstack-query",
        globalName: "TanStackQuery",
      },
    ]);

    const outcome = await compileWith(dependencies);
    expect(outcome.status).toBe("compiled");
  });

  it("withholds a target-less copy of the decision from the deployment gate", async () => {
    // The complement on purpose: the pre-validation state (target cleared on
    // a copy of the committed lock) must still withhold on
    // `realRuntimeValidation: "not-validated"` — recording a target for the
    // real record must not teach the gate to let a target-less one through.
    const lock = await conformedLock();
    const unvalidated = {
      ...lock,
      decisions: lock.decisions.map(record => ({ ...record, target: null })),
    };

    const gate = compilationDependencies(unvalidated, await environmentFor());
    expect(gate.dependencies).toEqual([]);
    expect(gate.withheld).toContainEqual({
      packageName: PACKAGE_NAME,
      strategy: "extension",
      reason: "not-verified",
      stalenessReasons: [],
      realRuntimeValidation: "not-validated",
    });

    const outcome = await compileWith(gate.dependencies);
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") return;
    expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      "unresolved-dependency-decision",
    );
  });

  it("still reports extension-version drift on the deployment gate, even with a recorded target", async () => {
    // Freshness and runtime validation are separate axes (#8): a moved
    // extension withholds as staleness regardless of the recorded target —
    // the runtime claim freezes neither the extension axis nor the gate.
    const environment = await environmentFor({
      extensionVersions: { "tanstack-query": "5.103.0" },
    });

    const { dependencies, withheld } = await deploymentGate(environment);
    expect(dependencies).toEqual([]);
    expect(withheld).toContainEqual({
      packageName: PACKAGE_NAME,
      strategy: "extension",
      reason: "not-verified",
      stalenessReasons: ["extension-version-changed"],
      realRuntimeValidation: "validated",
    });
  });

  it("still reports extension-identity drift on the deployment gate, even with a recorded target", async () => {
    // Identity is the second half of the extension axis (#8): the version can
    // stay put while the uploaded bundle's content hash moves, and the gate
    // must withhold on that alone. `realRuntimeValidation` stays `"validated"`
    // because freshness and runtime validation are independent — the recorded
    // target freezes neither.
    const environment = await environmentFor({
      extensionIdentities: { "tanstack-query": "sha256:other" },
    });

    const { dependencies, withheld } = await deploymentGate(environment);
    expect(dependencies).toEqual([]);
    expect(withheld).toContainEqual({
      packageName: PACKAGE_NAME,
      strategy: "extension",
      reason: "not-verified",
      stalenessReasons: ["extension-identity-changed"],
      realRuntimeValidation: "validated",
    });
  });

  it("withholds package and extension drift on the local path too — freshness still gates", async () => {
    // PR review of #61 P2: the local projection enforces freshness on every
    // axis; its only relaxation is real-runtime validation. A moved pin or
    // extension must fail closed here exactly as on the deployment gate, and
    // the recorded target relaxes nothing about staleness.
    const environment = await environmentFor({
      resolvedVersions: { ...((await environmentFor()).resolvedVersions), [PACKAGE_NAME]: "5.103.0" },
      extensionVersions: { "tanstack-query": "5.103.0" },
    });

    const { dependencies, withheld } = await dependenciesFromLock(environment);
    expect(dependencies).toEqual([]);
    expect(withheld).toContainEqual({
      packageName: PACKAGE_NAME,
      strategy: "extension",
      reason: "not-verified",
      stalenessReasons: ["package-version-changed", "extension-version-changed"],
      realRuntimeValidation: "validated",
    });
  });

  it("emits exactly one tanstack-query reference and no bundled npm implementation", async () => {
    const outcome = await compileExample();

    expect(outcome.status).toBe("compiled");
    if (outcome.status !== "compiled") return;
    const code = compiledCodeOf(outcome);

    // #13: `frontendLibraries` is generated from the decision, exactly once,
    // naming exactly the extension the mapping row resolves the package to.
    expect(outcome.artifact.frontendLibraries).toEqual([{ libraryId: "tanstack-query" }]);

    // The generated extension module is present and reads the page global by
    // name — its own runtime refusal is what a cell without the extension gets.
    expect(code).toContain("TanStackQuery");
    expect(code).toContain("extension-global-missing");

    // The entry wrapper #5/#6 prescribe, binding the single IIFE export.
    expect(code).toContain("function App(props)");
    expect(code).toContain(`React.createElement(${CELL_ENTRY_COMPONENT_BINDING}, props)`);
    expect(code).toContain("extension tanstack-query PoC");

    // No unresolved import may remain, and none of the npm implementation's own
    // internals may have been flattened in: these strings are load-bearing parts
    // of the installed @tanstack/react-query and @tanstack/query-core builds
    // (`notifyManager` is imported by `useQuery` itself, `getQueryCache` /
    // `QueryObserver` are query-core's machinery), so their absence states
    // "externalized, not inlined" against the finished artifact rather than
    // trusting the audits alone.
    expect(code).not.toMatch(/\bfrom\s*["']@tanstack\/react-query["']/);
    expect(code).not.toContain('require("@tanstack/react-query")');
    expect(code).not.toContain("import(");
    expect(code).not.toContain("notifyManager");
    expect(code).not.toContain("getQueryCache");
    expect(code).not.toContain("QueryObserver");
    expect(code).not.toContain("process.env.NODE_ENV");

    const bytes = Buffer.byteLength(code, "utf8");
    console.info(`#13 extension tanstack-query artifact: ${code.length} characters, ${bytes} bytes`);
  });

  it("refuses to evaluate without the page global, which is what rules out a bundled copy", async () => {
    const code = await compiledArtifact();
    const sandbox = createSandbox({ React: reactStub() });

    // With the extension global absent there is nothing for the generated module
    // to export, so evaluation must fail loudly and structurally. A cell that had
    // bundled its own implementation would sail through this run — that is the
    // negative proof #13 step 6 asks for, from the runtime side.
    let thrown: unknown;
    try {
      sandbox.run(code);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "extension-global-missing",
      specifier: "@tanstack/react-query",
      libraryId: "tanstack-query",
      globalName: "TanStackQuery",
    });
  });

  it("renders the self-check through the extension global", async () => {
    const code = await compiledArtifact();
    const facade = tanStackQueryFacade();
    const sandbox = createSandbox({ React: reactStub(), TanStackQuery: facade });
    sandbox.run(code);

    const tree = expandTree(sandbox.component()(), pageOpaqueSet(facade));
    const text = flattenText(tree).join(" ");

    // The example's own deterministic self-check is the oracle: every verdict is
    // computed from the objects the page global supplied, so the whole path —
    // global → generated module → CJS interop → named bindings → element — has
    // to have carried the right identities for this string to appear.
    expect(text).toContain("extension tanstack-query PoC");
    expect(text).toContain(EXPECTED_REPORT);
    expect(text).not.toContain("fail");

    // Data rendered from the facade's `useQuery` and never from the authored
    // `queryFn` (which this sandbox never runs): the value identifies where it
    // came from.
    expect(text).toContain("from-page-global");

    // The provider element's type *is* the page function, and the client it was
    // handed was constructed from the page class — identity, not shape.
    const provider = providerFrom(tree, facade);
    expect(provider.type).toBe(facade.QueryClientProvider);
    expect((provider.props.client as { constructor: unknown }).constructor).toBe(facade.QueryClient);
  });

  it("gives two Cells compiled from this example one shared module identity", async () => {
    // Compiled twice: two Cells, two artifacts — like #13's real-project step 8,
    // where the same example must run in two Cells of one page. The sandboxes
    // are shared on purpose: one `TanStackQuery` global, exactly as one page
    // has one, and both Cells observe it.
    const firstCode = await compiledArtifact();
    const secondCode = await compiledArtifact();
    const facade = tanStackQueryFacade();
    const sandbox = createSandbox({ React: reactStub(), TanStackQuery: facade });
    const opaque = pageOpaqueSet(facade);

    sandbox.run(firstCode);
    const cellA = sandbox.component();
    sandbox.run(secondCode);
    const cellB = sandbox.component();

    const providerA = providerFrom(expandTree(cellA(), opaque), facade);
    const providerB = providerFrom(expandTree(cellB(), opaque), facade);

    // One module identity per page: both Cells bound the exact function object
    // the single global published — strictly equal to each other and to the
    // facade's own. A per-cell bundled copy would fail the first `toBe` against
    // the facade; a facade-shaped wrapper would fail it too, since a wrapper is
    // a different object however faithfully it forwards.
    expect(providerA.type).toBe(facade.QueryClientProvider);
    expect(providerB.type).toBe(facade.QueryClientProvider);
    expect(providerA.type).toBe(providerB.type);

    // The class identity both Cells' clients were constructed from is the page's
    // one class — the same claim at the `new` end of the path.
    expect((providerA.props.client as { constructor: unknown }).constructor).toBe(facade.QueryClient);
    expect((providerB.props.client as { constructor: unknown }).constructor).toBe(facade.QueryClient);

    // Two *instances* are the expected and documented shape: module scope is per
    // Cell, so each Cell constructs its own client. Shared identity here means
    // one module/class on the page; sharing one client instance across Cells is
    // an application-level choice this PoC does not impose.
    expect(providerA.props.client).not.toBe(providerB.props.client);
  });

  it("produces byte-identical artifacts for identical inputs", async () => {
    const original = await compileExample();
    const rerun = await compileExample();

    expect(original.status).toBe("compiled");
    expect(rerun.status).toBe("compiled");
    if (original.status !== "compiled" || rerun.status !== "compiled") return;
    expect(rerun.artifact.code).toBe(original.artifact.code);
    expect(rerun.artifact.frontendLibraries).toEqual(original.artifact.frontendLibraries);
    expect(original.artifact.frontendLibraries).toEqual([{ libraryId: "tanstack-query" }]);
  });
});
