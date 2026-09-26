/**
 * The generated runtime binding: the same source, executed as a production Cell.
 *
 * Decision source: GitHub Issue #82 — "修复 Runtime：在生产 Cell 入口自动安装 Host
 * Provider"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/82), under #81, and the
 * requirement it implements is stated on #27/#29's side:
 * `packages/runtime/src/host-provider.ts`'s header asks for "something inside the Cell
 * scope" to build the provider from the Cell's own `props` and `useDataSource` and
 * install it before the first façade call, and
 * `RUNTIME_FACADE_PACKAGING_POLICY.compilerOwnsImportLowering` leaves emitting that to
 * the artifact/compiler boundary.
 *
 * ## The defect this file pins, and why a compile-level test could not see it
 *
 * Every test that existed before this one stopped at the artifact *text*.
 * `dev-harness-example.test.ts` proves the same source compiles and carries no
 * local-only branch — and it was green while the artifact was unrunnable: it never
 * executed the output, and the local loop that *does* run this source
 * (`dev-harness`'s `mountCell`) installs a mock provider itself, so the one path that
 * executed the Cell supplied the provider the artifact never had.
 *
 * So the reproduction is an *execution*, not a string check: compile the entry, run the
 * artifact the way the platform runs cell source, and call the façade. Before #82 that
 * throws `provider-not-installed` — which is the failure this file exists to keep out.
 *
 * ## How the artifact is executed, and what makes that faithful
 *
 * `#5` read the product runtime and recorded the mechanism
 * (`CELL_SOURCE_EXECUTION_MODEL`): the cell source is evaluated as the body of a
 * `new Function(...)` whose parameters are the injected capabilities, and the `App`
 * path additionally nests user code in an arrow IIFE that declares the wrapper-locals —
 * `props`, `useDataSource` and the rest — before placing the source. That is what
 * {@link runCellArtifact} reproduces, and the two things it has to get right are both
 * recorded facts rather than conveniences:
 *
 * 1. **`props` and `useDataSource` are free identifiers in the Cell scope.** They are
 *    wrapper-locals, not `window` properties (`CELL_USER_SCOPE_BINDINGS`: both are
 *    `onWindow: "never"`), so the artifact may name them without importing anything and
 *    the harness has to declare them exactly as the platform does.
 * 2. **The host values are built inside the sandbox realm.** This is the subtle one and
 *    it cost a probe to find: `facade.ts`'s `permissionMap` refuses a value whose
 *    prototype is not a plain record's, and a host object literal constructed in the
 *    test realm carries the *test* realm's `Object.prototype` — so a test that seeded it
 *    from outside would see the façade's own correct refusal and report it as a defect.
 *    The host props are therefore composed by a script that runs *in* the context, which
 *    is also what the page does: Forguncy builds `props` in the page realm, the same
 *    realm the artifact evaluates in.
 *
 * ## What is claimed, and what is not
 *
 * This is `local` evidence in #4's vocabulary. It proves the artifact installs a host
 * provider and delegates through it, against a *stub* host whose shapes are #5's
 * recorded ones. It does not prove anything about a real Forguncy page — whether the
 * platform re-evaluates the artifact per render, and therefore whether a re-render reads
 * fresh `props`, is not decidable from this repository and is #83's and #84's subject.
 * AGENTS.md rule 7 forbids presenting this as runtime compatibility.
 */
import { join } from "node:path";
import { createContext, Script } from "node:vm";

import { CELL_RUNTIME_BINDING_CONTRACT, cellUserScopeBinding } from "@forguncy-react-workspace/core";
import type { DependencyDecision } from "@forguncy-react-workspace/core";
import { describe, expect, it } from "vitest";

import { compileCell } from "./artifact.ts";
import type { CompileCellOutcome } from "./artifact.ts";
import { CELL_ENTRY_COMPONENT_BINDING, CELL_ENTRY_WRAPPER_HOST_NAMES } from "./entry.ts";
import { createRolldownCellBundler } from "./rolldown-bundler.ts";
import {
  CELL_RUNTIME_BINDING_HOST_NAMES,
  RUNTIME_BINDING_GENERATED_BANNER,
  renderRuntimeBindingModule,
  runtimeBindingNamesAreVerified,
} from "./runtime-binding.ts";
import { loadPnpmWorkspaceGraph } from "./workspace-graph.ts";

const repositoryRoot = join(process.cwd());
const cellSourceDirectory = join(repositoryRoot, "examples", "dev-harness", "cells", "sales-summary", "src");
const cellEntry = join(cellSourceDirectory, "App.tsx");

/**
 * The entry's decisions, as the example's own `package.json` reasons them.
 *
 * `react` is `host`, so #9's bridge intercepts the specifier and binds the page's
 * object. `@forguncy-react-workspace/runtime` needs no row: it is workspace source
 * (#14), flattened into the artifact like any other source file.
 */
const DEPENDENCIES: readonly DependencyDecision[] = [
  { strategy: "host", packageName: "react", globalName: "React" },
];

function compileExample(): Promise<CompileCellOutcome> {
  return compileCell(
    { entry: cellEntry, dependencies: [...DEPENDENCIES] },
    { bundler: createRolldownCellBundler({ dir: cellSourceDirectory }) },
  );
}

function compiledCode(outcome: CompileCellOutcome): string {
  if (outcome.status !== "compiled") {
    throw new Error(
      `Expected the example to compile; it was rejected with:\n${outcome.diagnostics
        .map(diagnostic => `  - ${diagnostic.code}: ${diagnostic.message}`)
        .join("\n")}`,
    );
  }
  return outcome.artifact.code;
}

/**
 * A Cell that never mentions the façade, compiled from a scratch file.
 *
 * Written into the example's own directory rather than into a temp tree so it resolves
 * `react` the same way the example does, and removed afterwards. The marker string is
 * what makes "this is the plain artifact" checkable rather than assumed.
 */
async function compilePlainCell(): Promise<string> {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "fgc-runtime-binding-"));
  const entry = join(dir, "PlainCell.tsx");
  writeFileSync(
    entry,
    `export function App() {\n  return <section data-marker="plain-cell-marker">plain cell</section>;\n}\n`,
  );
  try {
    const outcome = await compileCell(
      { entry, dependencies: [...DEPENDENCIES] },
      { bundler: createRolldownCellBundler({ dir }) },
    );
    return compiledCode(outcome);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Executing the artifact as the platform executes cell source
// ---------------------------------------------------------------------------

interface CellElement {
  readonly type: unknown;
  readonly props: Readonly<Record<string, unknown>>;
}

/** What one host call left behind, so a test can assert the delegation happened. */
interface HostCalls {
  readonly dataSources: readonly (readonly [string, unknown])[];
  readonly commands: readonly unknown[];
}

interface ExecutedCell {
  /** The `function App(props)` the platform's first resolution step finds. */
  readonly App: (props: unknown) => CellElement;
  readonly calls: HostCalls;
  /** Anything the Cell reported to `console.error`, so a swallowed failure is visible. */
  readonly logged: readonly unknown[];
  /** The Cell's own component, reached through the wrapper's element. */
  readonly render: () => unknown;
  /**
   * The `code` on the last `RuntimeFacadeResolutionError` thrown, or `undefined`.
   *
   * The façade's refusals carry a stable code and the address they are about
   * (`provider.ts`), and asserting on the code rather than on the message is what makes a
   * test about *which* refusal fired rather than about its wording. Read off the error the
   * `vm` realm threw, which is why the message is matched separately: a value crossing the
   * `vm` boundary is not an instance of the test realm's class, so `instanceof` cannot be
   * used and the structural field is the reliable signal.
   */
  readonly resolutionErrorCode: () => string | undefined;
}

/**
 * The page's React, reduced to what this Cell touches.
 *
 * A stub rather than the installed `react` for the reason #9's tests give: the artifact
 * must read the *page* object, and a stub makes that observable. `createElement` is the
 * only member this Cell's generated JSX adapter needs — #9's adapter delegates
 * `jsx`/`jsxs` to the host object's `createElement`, so seeding one member covers the
 * whole element tree without a second stub to keep in step.
 */
const REACT_STUB = `
globalThis.React = {
  version: "19.2.7",
  Fragment: Symbol.for("react.fragment"),
  createElement: function (type, props) { return { type: type, props: props || {} }; },
  useState: function (initial) { return [initial, function () {}]; },
  useEffect: function () {},
  useMemo: function (factory) { return factory(); },
  useRef: function (value) { return { current: value }; },
  useCallback: function (callback) { return callback; },
};
`;

/**
 * The host values, composed in the sandbox realm — see this file's header.
 *
 * Every value is one #5 recorded on an executed page, and the shapes are the ones the
 * façade is written against rather than convenient stand-ins:
 *
 * - `props` carries the four base keys only, in `CELL_PROPS_KEY_ORDER`;
 * - `Forguncy.hasPermission` / `getPermissions` are **synchronous**, because #5 called
 *   them without `await` while awaiting the command call beside them;
 * - `ServerCommands` holds only the name the page declares, and the call returns the
 *   `{ errorCode, errorMessage, ... }` record;
 * - `useDataSource` answers the three rows `top: 3` asks for with `totalCount` staying
 *   at the server's 240, mirroring #5's observation that paging is the server's.
 *
 * The calls are recorded so the assertions are about *delegation* — the host was reached
 * with the Cell's own arguments — rather than about a value the harness could have
 * produced on its own.
 */
const HOST_STUB = `
globalThis.__HOST_CALLS__ = { dataSources: [], commands: [] };
const handle = {};
handle.hasPermission = function (permissionName) { return permissionName === "Orders.Read"; };
handle.getPermissions = function () { return { "Orders.Read": true }; };
globalThis.__HOST_PROPS__ = {
  Forguncy: handle,
  Permissions: { "Orders.Read": true },
  ServerCommands: {
    GetSalesData: function (payload) {
      globalThis.__HOST_CALLS__.commands.push(payload);
      return Promise.resolve({ errorCode: 0, errorMessage: "OK", payload: payload });
    },
  },
  ImageContext: {},
};
globalThis.__HOST_HOOK__ = function (dataSourceName, options) {
  globalThis.__HOST_CALLS__.dataSources.push([dataSourceName, options]);
  if (dataSourceName !== "Sales") {
    return { data: [], totalCount: 0, loading: false, error: "ReactCellType data source was not found: " + dataSourceName };
  }
  const rows = [{ 月份: "6月", 销售额: 3120 }, { 月份: "5月", 销售额: 2870 }, { 月份: "4月", 销售额: 2450 }];
  const top = options && typeof options.top === "number" ? options.top : rows.length;
  return { data: rows.slice(0, top), totalCount: 240, loading: false, error: null };
};
`;

/**
 * Runs one compiled artifact the way the platform runs cell source.
 *
 * The wrapper is `#5`'s recorded `App` path, reduced to what this Cell needs: an arrow
 * IIFE that declares the wrapper-locals from the values the runtime passed in, then the
 * cell source, then the `App` binding the platform's second resolution step looks for.
 * `__props` / `__useDataSource` are read off `globalThis` rather than passed as
 * arguments only because a `vm` script cannot close over the test's locals; the values
 * are still the sandbox's own, which is the property the header argues for.
 */
function runCellArtifact(code: string): ExecutedCell {
  return runCellArtifactWithHost(code, "");
}

/**
 * The same run, with one extra script that damages the host values first.
 *
 * A separate entry point rather than a parameter on the tests, because "the host is
 * wrong" is a property of the *page* the Cell runs against, not of the Cell — and the
 * damage has to happen inside the sandbox realm, after {@link HOST_STUB} has built the
 * values there, for the same prototype reason the header gives.
 */
function runCellArtifactWithHost(code: string, hostDamage: string): ExecutedCell {
  const logged: unknown[] = [];
  const sandbox: Record<string, unknown> = {
    console: {
      error: (...args: unknown[]) => {
        logged.push(args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : String(a))).join(" "));
      },
      log: () => undefined,
      warn: () => undefined,
    },
  };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);

  new Script(REACT_STUB, { filename: "page-react.js" }).runInContext(context);
  new Script(HOST_STUB, { filename: "page-host.js" }).runInContext(context);
  if (hostDamage.length > 0) {
    new Script(hostDamage, { filename: "page-host-damage.js" }).runInContext(context);
  }

  const wrapper = [
    `(function () {`,
    `  const props = globalThis.__HOST_PROPS__;`,
    `  const useDataSource = globalThis.__HOST_HOOK__;`,
    code,
    `  return function App(nextProps) {`,
    `    return React.createElement(${CELL_ENTRY_COMPONENT_BINDING}, nextProps || {});`,
    `  };`,
    `})()`,
  ].join("\n");

  const App = new Script(wrapper, { filename: "cell-artifact.js" }).runInContext(context) as (
    props: unknown,
  ) => CellElement;

  let lastError: unknown;
  return {
    App,
    calls: sandbox.__HOST_CALLS__ as HostCalls,
    logged,
    render: () => {
      const element = App(sandbox.__HOST_PROPS__);
      const component = element.type as (props: unknown) => unknown;
      try {
        return expandTree(component(element.props));
      } catch (error) {
        lastError = error;
        throw error;
      }
    },
    resolutionErrorCode: () => {
      const code = (lastError as { code?: unknown } | undefined)?.code;
      return typeof code === "string" ? code : undefined;
    },
  };
}

/**
 * Renders the Cell's function components by hand, the way React would.
 *
 * The stub React builds elements and never invokes a function child, and this Cell has
 * two: the bundled component the generated wrapper creates an element for, and
 * `ExportButton`, the component holding the command handler. A walker that only recursed
 * into `props.children` would leave `ExportButton` as an unopened element — which is
 * exactly how the async-command assertion first failed, and the failure looked like a
 * missing delegation rather than an unrendered subtree.
 *
 * Nothing here is a *page* function: the page contributes `React.createElement` and the
 * host values, and no element in this tree is one of those. `extension-query-poc.test.ts`
 * needs an opaque-set parameter for its case (the example puts a probe inside a page
 * provider); this Cell has no such element, so the walk calls every function element and
 * the assertion would surface a page function here rather than silently skipping it.
 */
function expandTree(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(child => expandTree(child));
  if (typeof node !== "object" || node === null || !("type" in node) || !("props" in node)) {
    return node;
  }
  const element = node as CellElement;
  if (typeof element.type === "function") {
    const rendered = (element.type as (props: unknown) => unknown)(element.props);
    return expandTree(rendered);
  }
  return { type: element.type, props: { ...element.props, children: expandTree(element.props.children) } };
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

/** Every element carrying the given prop, so a handler can be invoked from a test. */
function findElements(
  node: unknown,
  hasProp: string,
  out: CellElement[] = [],
): CellElement[] {
  if (Array.isArray(node)) {
    for (const item of node) findElements(item, hasProp, out);
    return out;
  }
  if (typeof node === "object" && node !== null && "type" in node && "props" in node) {
    const element = node as CellElement;
    if (element.props[hasProp] !== undefined) out.push(element);
    findElements(element.props.children, hasProp, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The regression
// ---------------------------------------------------------------------------

describe("a compiled Cell that calls the runtime façade", () => {
  it("executes against the host instead of failing for a missing provider", async () => {
    // The reproduction, as one assertion: before #82 this threw
    // `RuntimeFacadeResolutionError: No runtime façade provider is installed in this
    // copy` from the first `runtimeFacade()` call inside the Cell's render. The
    // assertion is deliberately about the *tree*, not about the absence of a throw, so
    // a binding that installed a provider but broke the render still fails here.
    const executed = runCellArtifact(compiledCode(await compileExample()));

    const tree = executed.render();

    expect(flattenText(tree)).toContain("本月销售");
    expect(executed.calls.dataSources).toEqual([["Sales", { top: 3 }]]);
  });

  it("delegates the data-source read to the host hook, with the Cell's own arguments", async () => {
    const executed = runCellArtifact(compiledCode(await compileExample()));

    const text = flattenText(executed.render()).join("|");

    // The three rows the host stub returned for `top: 3`, rendered by the Cell. The
    // values are the host's, so a binding that installed a provider pointing anywhere
    // else — or a second data layer inside the Cell — cannot produce them.
    expect(text).toContain("6月");
    expect(text).toContain("3120");
    expect(text).not.toContain("销售数据不可用");
    expect(executed.calls.dataSources).toEqual([["Sales", { top: 3 }]]);
  });

  it("delegates the permission calls to the host handle", async () => {
    const executed = runCellArtifact(compiledCode(await compileExample()));

    const text = flattenText(executed.render()).join("|");

    // `canReadOrders()` and `readOrderPermissions()` both go through the host handle.
    // The denied branch is the one that proves the *value* travelled: the stub grants
    // `Orders.Read`, so the alert is absent and the rendered map says `true`.
    expect(text).not.toContain("当前用户没有 Orders.Read 权限");
    expect(text).toContain("Orders.Read=true");
  });

  it("delegates an async server command to the host", async () => {
    const executed = runCellArtifact(compiledCode(await compileExample()));

    // Selected by its label rather than by position: the Cell renders two buttons, and
    // the first is the interaction counter whose handler is a `useState` setter. Invoking
    // that one leaves the command uncalled and the assertion failing for a reason that
    // looks like a missing delegation — which is how this test first failed.
    const button = findElements(executed.render(), "onClick").find(element =>
      flattenText(element.props.children).includes("导出"),
    );
    expect(button).toBeDefined();
    (button?.props.onClick as () => void)();
    // The handler fires the call without awaiting it, so the assertion has to wait for the
    // promise chain to drain rather than assume a turn count: the path is
    // `refreshOrders` -> `invokeServerCommand` -> the host's command function, and each hop
    // is an `await`. A macrotask boundary drains all of them, which is why this is a timer
    // and not a fixed number of `Promise.resolve()` turns.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(executed.logged).toEqual([]);
    expect(executed.calls.commands).toEqual([{ top: 3 }]);
  });
});

// ---------------------------------------------------------------------------
// The artifact's shape
// ---------------------------------------------------------------------------

describe("the artifact the binding produces", () => {
  it("stays one self-contained script with no external reference", async () => {
    const outcome = await compileExample();
    const code = compiledCode(outcome);

    // #6's single-artifact guarantee, now that the binding module is in the graph. The
    // `require(` and `export {` arms are the two ways the generated binding could have
    // leaked module syntax into the artifact: the binding module imports the façade as
    // ESM and re-exports it, and an interop shim for either would survive as one of
    // these. Both were observed in a first draft and are why the binding resolves its
    // own façade import to an explicit specifier rather than to the intercepted one.
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bexport\s*\{/);
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toMatch(/\bnode:[a-z]+/);
    // One React identity: the page's. A bundled implementation would be the second.
    expect(code).not.toMatch(/@license React/);
    // `externalImports` is a field of the bundler's *report*, not of the assembled
    // artifact, and an artifact with any external import is refused by assembly — so the
    // fact that this compiled at all is the assertion that nothing survived external.
    // Stated here rather than left implicit because it is the arm a leaked binding import
    // would trip first.
    expect(outcome.status).toBe("compiled");
  });

  it("carries no absolute path from the machine that built it", async () => {
    // The binding embeds a *resolved* façade specifier, which is an absolute path. That
    // is exactly the shape `experimental.attachDebugInfo: "none"` exists to keep out of
    // an artifact, so the property is asserted rather than assumed: the resolved id is
    // inlined as module source, and a leaked path would make the artifact
    // machine-dependent and its bytes unreproducible.
    const code = compiledCode(await compileExample());

    expect(code).not.toContain(repositoryRoot);
    expect(code).not.toContain(repositoryRoot.split("\\").join("/"));
  });
});

// ---------------------------------------------------------------------------
// A Cell that does not use the façade
// ---------------------------------------------------------------------------

describe("a Cell whose source never calls the façade", () => {
  it("carries no provider installation, and is unchanged by the binding's existence", async () => {
    // #9's rule, applied to the provider: initialising for a capability the artifact does
    // not use is worse than not checking. The binding module reaches the graph only
    // because a façade import pulled it in, so a Cell without one must carry no
    // installation and no other trace of the mechanism.
    //
    // The pair of entries is the assertion's control: the example above is the positive
    // case (it imports the façade and does get the install), and this one is the
    // negative. A single entry could not show the difference.
    const facadeFree = await compilePlainCell();

    expect(facadeFree).toContain("plain-cell-marker");
    expect(facadeFree).not.toContain("installRuntimeFacadeProvider");
    expect(facadeFree).not.toContain("createHostRuntimeFacadeProvider");
    expect(facadeFree).not.toContain("runtimeFacade");
    expect(facadeFree).not.toContain(RUNTIME_BINDING_GENERATED_BANNER);

    // The positive control, asserted beside it so neither can pass alone. It looks for the
    // *generated call site* rather than the member name: `installRuntimeFacadeProvider` also
    // occurs in the inlined façade source, so matching the bare name would pass for an
    // artifact that carried the package but generated no binding at all. `cellProps: props`
    // is the free-identifier reference only the generated module makes.
    expect(compiledCode(await compileExample())).toContain("cellProps: props");
  });
});

// ---------------------------------------------------------------------------
// The generated source's contract
// ---------------------------------------------------------------------------

describe("the rendered runtime binding module", () => {
  it("names only identifiers a Cell scope provides", () => {
    // A generated module that reached for an invented global would ship an artifact that
    // throws `ReferenceError` while the artifact is evaluated — before React or the façade
    // is involved, and invisibly to every artifact audit, because a free identifier is not
    // an import and leaves no trace in the module graph.
    expect(runtimeBindingNamesAreVerified()).toBe(true);
    for (const name of CELL_RUNTIME_BINDING_HOST_NAMES) {
      expect(cellUserScopeBinding(name), name).toBeDefined();
    }
  });

  it("references every name it declares, and declares every name it references", () => {
    // The declaration is only worth checking in both directions. One direction alone
    // ("every declared name is verified") passes for a list of names the template never
    // uses; the other alone ("every used name is declared") passes for a declaration that
    // has outlived the template. This is the same pair `entry.test.ts` asserts for the
    // entry templates, applied to the second generated module in this package.
    const source = renderRuntimeBindingModule("/abs/path/to/runtime/index.ts");

    for (const name of CELL_RUNTIME_BINDING_HOST_NAMES) {
      expect(source, name).toMatch(new RegExp(`\\b${name}\\b`));
    }
    // The mirror: the two free identifiers the template is allowed to use are exactly the
    // declared ones. Checked by asking which declared-or-not names the source references in
    // the provider input, which is the only place a free identifier may appear.
    const providerInput = /createHostRuntimeFacadeProvider\(\{([\s\S]*?)\}\)/.exec(source)?.[1] ?? "";
    const referenced = [...providerInput.matchAll(/(\w+):\s*(\w+)/g)].map(match => match[2]);
    expect(referenced.sort()).toEqual([...CELL_RUNTIME_BINDING_HOST_NAMES].sort());
  });

  it("embeds the specifier it is handed, and calls the contract's members", () => {
    // The specifier is data, so the test drives a value the repository never uses: a
    // renderer that hard-coded the façade's real path would pass every test that compiled
    // the example, and would fail only on a project whose façade resolved elsewhere.
    const source = renderRuntimeBindingModule("./some/other/place/index.ts");

    expect(source).toContain(JSON.stringify("./some/other/place/index.ts"));
    expect(source).toContain(CELL_RUNTIME_BINDING_CONTRACT.installMember);
    expect(source).toContain(CELL_RUNTIME_BINDING_CONTRACT.createProviderMember);
    expect(source).toContain("export *");
  });

  it("installs and never uninstalls, which is what the contract's prose now says", () => {
    // Review found the drift this pins: `host-provider.ts` listed "uninstall it when the
    // Cell is torn down" among the requirements a generated binding has to satisfy, and no
    // generated binding did — the comment described a state the code was not in, and a
    // reader would have taken it as what ships.
    //
    // The assertion is on the *rendered source*, not on the prose, because that is the side
    // that can be checked: the doc now states the binding installs and does not uninstall,
    // and this is what makes that statement falsifiable. It fails the moment someone adds a
    // teardown call to the template without deciding the lifecycle question first — which
    // is #83's, and not something the compiler may settle from an unverified premise.
    const source = renderRuntimeBindingModule("/abs/path/to/runtime/index.ts");

    expect(source).toContain(CELL_RUNTIME_BINDING_CONTRACT.installMember);
    expect(source).not.toContain("uninstallRuntimeFacadeProvider");
  });

  it("keeps its names out of the entry wrapper's union", () => {
    // The two generated modules declare their host names separately, and the separation is
    // load-bearing rather than tidy. `CELL_ENTRY_WRAPPER_HOST_NAMES` is the union over the
    // *entry templates*, whose subject is "what a wrapper around the entry component may
    // reference"; `useDataSource` is not one of those and never will be. Merging the two
    // lists would make the union claim a name no entry template uses — and the check that
    // catches a template drifting from its declaration would then have to tolerate a name
    // it never sees.
    //
    // `props` legitimately appears in both, so it cannot carry the assertion; the name
    // that distinguishes the two declarations is the one asserted here.
    expect(CELL_ENTRY_WRAPPER_HOST_NAMES).not.toContain("useDataSource");
    expect(CELL_RUNTIME_BINDING_HOST_NAMES).toContain("useDataSource");
    expect(CELL_ENTRY_WRAPPER_HOST_NAMES).toContain("props");
  });
});

// ---------------------------------------------------------------------------
// The workspace closure (#14) with a façade-importing Cell
// ---------------------------------------------------------------------------

describe("a façade-importing Cell compiled against a workspace graph", () => {
  it("reports no workspace finding and leaves no workspace package external", async () => {
    // The combination no test covered before #82, and the reason the binding's first draft
    // shipped broken: the façade-importing entry was compiled **without** a graph, and every
    // graph-supplied compile used an entry that never imported the façade. So the one case
    // where the two interact — a binding module whose own façade import has to resolve
    // through the same workspace link the authored import uses — was never executed.
    //
    // The failure it hid: resolving the binding's façade import against the `\0` module id
    // rather than against the authored importer makes Rolldown fall back to the process cwd,
    // the façade goes external, and #14's audit then reports the workspace package as left
    // external while assembly refuses the artifact. Both halves are asserted here, because
    // either alone could pass for the wrong reason.
    const graph = await loadPnpmWorkspaceGraph({ root: repositoryRoot });
    const outcome = await compileCell(
      { entry: cellEntry, dependencies: [...DEPENDENCIES] },
      { bundler: createRolldownCellBundler({ dir: cellSourceDirectory }), workspace: graph.graph },
    );

    expect(outcome.status).toBe("compiled");
    if (outcome.status !== "compiled") return;
    expect(outcome.workspace?.diagnostics).toEqual([]);
    // The façade is workspace source, so it is flattened rather than left external — and
    // the closure is what says so, not the absence of a diagnostic.
    expect(outcome.workspace?.closure?.externalModules ?? []).toEqual([]);
    expect(compiledCode(outcome)).toContain("cellProps: props");
  });
});

// ---------------------------------------------------------------------------
// A wrong host binding is still diagnosable
// ---------------------------------------------------------------------------

describe("a host binding that does not carry what the Cell asks for", () => {
  it("refuses the address rather than standing in with a default", async () => {
    // #82's last acceptance criterion: the generated binding must not make a broken host
    // *look* configured. The failure has to stay locatable, and the code has to name the
    // address rather than the binding.
    //
    // `Forguncy` is the handle this Cell reaches `hasPermission` and `getPermissions`
    // through, so removing it is the fault this Cell can actually meet. It is also the
    // *right* address to remove, and that is worth stating: deleting `Permissions` instead
    // would change nothing here, because this Cell reads permissions through the handle and
    // never through the base prop — which is the façade doing its job (the registry routes
    // each capability to one member), not a gap in the check. A test that asserted a throw
    // for the base prop would be asserting the façade refuses an address the Cell never
    // asked for, which #9's rule forbids.
    const executed = runCellArtifactWithHost(
      compiledCode(await compileExample()),
      "delete globalThis.__HOST_PROPS__.Forguncy;",
    );

    expect(() => executed.render()).toThrowError(/provider does not carry "Forguncy"/);
    expect(executed.resolutionErrorCode()).toBe("provider-binding-missing");
  });

  it("refuses a data-source hook that is not callable", async () => {
    // The other half of the port. `useDataSource` is a wrapper-local, so a provider carrying
    // a non-function there is the same class of fault as a missing base prop, and it must be
    // reported with a code rather than as the `TypeError` the call would otherwise raise.
    const executed = runCellArtifactWithHost(
      compiledCode(await compileExample()),
      "globalThis.__HOST_HOOK__ = null;",
    );

    expect(() => executed.render()).toThrowError(/data-source binding/);
    expect(executed.resolutionErrorCode()).toBe("provider-binding-missing");
  });
});
