import { createRequire } from "node:module";
import { Script, createContext } from "node:vm";
import { format } from "node:util";

import { describe, expect, it } from "vitest";

import {
  HOST_BRIDGE_DEFERRED_MODULES,
  HOST_BRIDGE_MAPPINGS,
  type DependencyDecision,
  type HostBridgeGlobalMapping,
} from "@forguncy-react-workspace/core";

import {
  formatHostBridgePlan,
  interceptedHostBridgeModuleIds,
  planHostBridge,
  renderHostBridgeAdapterModule,
  renderHostBridgeGlobalModule,
  renderHostBridgeGuard,
  renderHostBridgeModule,
  HOST_BRIDGE_GENERATED_BANNER,
} from "./host-bridge";

// ---------------------------------------------------------------------------
// The real React the host injects
// ---------------------------------------------------------------------------

/**
 * React 19.2.7, loaded at the *host's* version rather than at whatever a
 * dependency range resolves to.
 *
 * Test-only, and deliberately loaded through `createRequire` instead of an
 * `import`: an `import` would need React's type declarations here, and the whole
 * point of #9 is that nothing in `src/` depends on React's types or its module
 * identity. What is asserted below is the *generated source*'s behaviour against
 * the same React build #5 measured on the host.
 */
const require = createRequire(import.meta.url);
const React = require("react") as Record<string, unknown>;
const { renderToString } = require("react-dom/server") as {
  renderToString: (element: unknown) => string;
};

/** The ReactDOM surface #5 observed on the page global. */
const ReactDOM = { version: "19.2.7", createRoot: () => undefined };

interface SandboxOptions {
  readonly React?: unknown;
  readonly ReactDOM?: unknown;
  readonly extraGlobals?: Record<string, unknown>;
}

/**
 * Evaluate a generated module the way a CommonJS interop wrapper would.
 *
 * `node:vm` rather than `eval` so the sandbox is the only place a global exists: a
 * bridge test that leaked `globalThis.React` into the test process would pass for
 * the wrong reason.
 */
function evaluateModule(source: string, options: SandboxOptions = {}): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    module: { exports: {} },
    ...(options.React === undefined ? {} : { React: options.React }),
    ...(options.ReactDOM === undefined ? {} : { ReactDOM: options.ReactDOM }),
    ...options.extraGlobals,
  };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  new Script(source, { filename: "generated host bridge module" }).runInContext(context);
  return (sandbox.module as { exports: Record<string, unknown> }).exports;
}

function evaluateScript(source: string, options: SandboxOptions = {}): void {
  const sandbox: Record<string, unknown> = {
    module: { exports: {} },
    ...(options.React === undefined ? {} : { React: options.React }),
    ...(options.ReactDOM === undefined ? {} : { ReactDOM: options.ReactDOM }),
    ...options.extraGlobals,
  };
  sandbox.globalThis = sandbox;
  new Script(source, { filename: "generated host bridge guard" }).runInContext(createContext(sandbox));
}

function globalMapping(specifier: string): HostBridgeGlobalMapping {
  const mapping = HOST_BRIDGE_MAPPINGS.find(candidate => candidate.specifier === specifier);
  if (mapping === undefined || mapping.kind !== "host-global") {
    throw new Error(`"${specifier}" is not a host-global mapping`);
  }
  return mapping;
}

function adapterMapping() {
  const mapping = HOST_BRIDGE_MAPPINGS.find(candidate => candidate.kind === "jsx-runtime-adapter");
  if (mapping === undefined || mapping.kind !== "jsx-runtime-adapter") {
    throw new Error("The bridge table has no JSX runtime adapter mapping");
  }
  return mapping;
}

function hostDecision(packageName: string, globalName = "React"): DependencyDecision {
  return { strategy: "host", packageName, globalName };
}

function inlineDecision(packageName: string): DependencyDecision {
  return { strategy: "inline", packageName };
}

function codeOf(thrown: unknown): string | undefined {
  return typeof thrown === "object" && thrown !== null ? (thrown as { code?: string }).code : undefined;
}

/** The thrown error, or a failure explaining that nothing was thrown. */
function caught(run: () => unknown): Record<string, unknown> {
  try {
    run();
  } catch (error) {
    return error as Record<string, unknown>;
  }
  throw new Error("Expected the generated bridge to throw, and it did not.");
}

// ---------------------------------------------------------------------------

describe("generated host-global modules", () => {
  // #9's first acceptance criterion, asserted as object identity rather than as
  // behaviour: a module that re-exported through a proxy would pass every
  // functional check and still break the identity two cells compare.
  it("exports the page's own React object, not a copy or a wrapper", () => {
    const source = renderHostBridgeModule(globalMapping("react"), "react");
    expect(evaluateModule(source, { React })).toBe(React);
    // Object identity is the assertion; the wrapper check is here so the reason
    // cannot be lost if the assertion is ever rewritten.
    expect(source).not.toContain("Proxy");
    expect(source).not.toContain("Object.assign");
  });

  it("exports the page's own ReactDOM object for the package id", () => {
    const exported = evaluateModule(renderHostBridgeModule(globalMapping("react-dom"), "react-dom"), { ReactDOM });
    expect(exported).toBe(ReactDOM);
  });

  it("starts with the generated-module banner", () => {
    expect(renderHostBridgeModule(globalMapping("react"), "react").startsWith(HOST_BRIDGE_GENERATED_BANNER)).toBe(true);
    expect(
      renderHostBridgeModule(globalMapping("react-dom"), "react-dom/client").startsWith(HOST_BRIDGE_GENERATED_BANNER),
    ).toBe(true);
    expect(
      renderHostBridgeModule(adapterMapping(), "react/jsx-runtime").startsWith(HOST_BRIDGE_GENERATED_BANNER),
    ).toBe(true);
  });

  // #5 records React as always available, so its absence means the artifact is not
  // running on the target it was compiled for. That has to be a structured refusal
  // rather than an `undefined` that surfaces wherever the value is first used.
  it("refuses with a structured diagnostic when an always-available global is absent", () => {
    const error = caught(() => evaluateModule(renderHostBridgeModule(globalMapping("react"), "react")));
    expect(codeOf(error)).toBe("host-global-missing");
    expect(error.name).toBe("HostBridgeError");
    expect(error.specifier).toBe("react");
    expect(error.globalName).toBe("React");
    expect(error.fixOwner).toBe("host-environment");
    expect(String(error.message)).toContain("host-global-missing");
  });

  // The counterpart, and the reason the generated module branches on availability:
  // #5 measured one cell seeing `antd` and another cell on the same page not seeing
  // it, so a throw here would break a legal cell.
  it("binds a preset-conditional global as-is instead of throwing", () => {
    const source = renderHostBridgeModule(globalMapping("antd"), "antd");
    expect(evaluateModule(source)).toBeUndefined();
    expect(source).not.toContain("throw");

    const antd = { Button: () => null };
    expect(evaluateModule(source, { extraGlobals: { antd } })).toBe(antd);
  });
});

// ---------------------------------------------------------------------------
// The narrowed subpath view — #9's "host-compatible ReactDOM surface"
// ---------------------------------------------------------------------------

describe("the react-dom/client view", () => {
  const source = () => renderHostBridgeModule(globalMapping("react-dom"), "react-dom/client");
  const view = (globals: SandboxOptions = { ReactDOM }) => evaluateModule(source(), globals);

  it("forwards the members #5 observed, and they are the host's own values", () => {
    const exported = view();
    expect(Object.keys(exported).sort()).toEqual(["createRoot", "version"]);
    expect(exported.createRoot).toBe(ReactDOM.createRoot);
    expect(exported.version).toBe(ReactDOM.version);
  });

  // The review's first finding: before this, the generated module for a subpath was
  // the whole host object, so an unobserved export was either exposed or silently
  // `undefined`. `hydrateRoot` is a real export of `react-dom/client` 19.2.7 that #5
  // never read off the page global, which makes it the case worth pinning.
  it("refuses an export outside the observed surface instead of forwarding it", () => {
    const exported = view();
    const error = caught(() => exported.hydrateRoot);
    expect(codeOf(error)).toBe("host-member-not-verified");
    expect(error.member).toBe("hydrateRoot");
    expect(error.specifier).toBe("react-dom/client");
    expect(error.fixOwner).toBe("dependency-decision");
    expect(String(error.message)).toContain("re-probing");

    // Not merely `undefined`: the name is absent from the exported surface as well,
    // so a bundler's own interop cannot resolve it to `undefined` either.
    expect("hydrateRoot" in exported).toBe(false);
    expect(Object.keys(exported)).not.toContain("hydrateRoot");
  });

  it("refuses an unobserved member of the host object even when the host carries it", () => {
    const hostWithHydrate = { ...ReactDOM, hydrateRoot: () => undefined };
    const exported = evaluateModule(source(), { ReactDOM: hostWithHydrate });
    expect(codeOf(caught(() => exported.hydrateRoot))).toBe("host-member-not-verified");
  });

  // The trap is doubly narrow: it must refuse what was never observed *and* not trip
  // on the protocol names a CommonJS consumer asks for before any real member.
  it("answers interop protocol names without consulting the host object", () => {
    const exported = view();
    expect(exported.__esModule).toBeUndefined();
    expect(exported.then).toBeUndefined();
    // `default` answers with the guarded view rather than the raw object, so the
    // interop protocol is not a way around the refusal above.
    expect(exported.default).toBe(exported);
    expect((exported as Record<symbol, unknown>)[Symbol.toStringTag]).toBeUndefined();
  });

  it("refuses with host-global-missing when the host object is absent", () => {
    const error = caught(() => evaluateModule(source(), {}));
    expect(codeOf(error)).toBe("host-global-missing");
    expect(error.globalName).toBe("ReactDOM");
  });

  it("is a view rather than the host object, and says so in the source", () => {
    const text = source();
    expect(text).toContain("Proxy");
    expect(text).not.toContain("module.exports = globalThis[");
  });

  it("refuses to render a module id its mapping does not intercept", () => {
    expect(() => renderHostBridgeModule(globalMapping("react-dom"), "react-dom/server")).toThrow(/does not intercept/);
    expect(() => renderHostBridgeModule(globalMapping("react"), "react/jsx-runtime")).toThrow(/does not intercept/);
  });
});

describe("generated JSX runtime adapter", () => {
  const adapter = adapterMapping();
  const source = (moduleId = "react/jsx-runtime") => renderHostBridgeAdapterModule(adapter, moduleId);

  it("exports jsx, jsxs, jsxDEV and a Fragment that is the host's own", () => {
    const runtime = evaluateModule(source(), { React });
    expect(typeof runtime.jsx).toBe("function");
    expect(typeof runtime.jsxs).toBe("function");
    expect(typeof runtime.jsxDEV).toBe("function");
    expect(runtime.Fragment).toBe(React.Fragment);
  });

  // #9's rule, and the regression that found it: aliasing the React object would
  // make `jsx(type, props, key)` reach `createElement(type, config, children)`.
  it("is not the React object", () => {
    const runtime = evaluateModule(source(), { React });
    expect(runtime).not.toBe(React);
    expect(runtime.jsx).not.toBe(React.createElement);
  });

  it("keeps props.children when no key is given, and passes no third argument", () => {
    const runtime = evaluateModule(source(), { React });
    const jsx = runtime.jsx as (
      type: unknown,
      props: unknown,
      key?: unknown,
    ) => { props: { children?: unknown }; key: unknown };

    const plain = jsx("div", { children: "hello" });
    expect(plain.props.children).toBe("hello");
    expect(plain.key).toBeNull();

    // An explicit `undefined` third argument is the trap: it selects
    // createElement's children branch and overwrites props.children.
    const explicit = jsx("div", { children: "hi" }, undefined);
    expect(explicit.props.children).toBe("hi");
    expect(explicit.key).toBeNull();
  });

  it("keeps the key out of children and children out of the key", () => {
    const runtime = evaluateModule(source(), { React });
    const jsx = runtime.jsx as (
      type: unknown,
      props: unknown,
      key?: unknown,
    ) => { props: Record<string, unknown>; key: unknown };

    const Child = () => null;
    const keyed = jsx(Child, { label: "a" }, "k-a");
    expect(keyed.key).toBe("k-a");
    expect(keyed.props.children).toBeUndefined();

    const keyedWithChildren = jsx("div", { children: ["x", "y"] }, "k-div");
    expect(keyedWithChildren.key).toBe("k-div");
    expect(keyedWithChildren.props.children).toEqual(["x", "y"]);
  });

  it("gives every child in a jsxs list its own key", () => {
    const runtime = evaluateModule(source(), { React });
    const jsx = runtime.jsx as (type: unknown, props: unknown, key?: unknown) => unknown;
    const jsxs = runtime.jsxs as (type: unknown, props: unknown) => { props: { children: { key: unknown }[] } };

    const Child = () => null;
    const list = jsxs("ul", {
      children: [
        jsx(Child, { label: "a" }, "k-a"),
        jsx(Child, { label: "b" }, "k-b"),
        jsx(Child, { label: "c" }, "k-c"),
      ],
    });

    expect(list.props.children.map(child => child.key)).toEqual(["k-a", "k-b", "k-c"]);
  });

  it("accepts jsxDEV's dev-only arguments without letting them touch key or children", () => {
    const runtime = evaluateModule(source(), { React });
    const jsxDEV = runtime.jsxDEV as (
      type: unknown,
      props: unknown,
      key: unknown,
      isStaticChildren: boolean,
      source: unknown,
      self: unknown,
    ) => { props: { children?: unknown }; key: unknown };

    const element = jsxDEV("div", { children: "text" }, "k-dev", false, undefined, undefined);
    expect(element.key).toBe("k-dev");
    expect(element.props.children).toBe("text");
  });

  // #11's PoC regression, at unit level. Static keyless children must be marked
  // validated (the way React's own jsxs marks them) or every multi-child JSX
  // warns under a development host React — and that false positive is visually
  // identical to the real signal: a keyless map through jsx must still warn,
  // because that warning is how a dropped key is seen.
  it("marks static children validated, and keeps a keyless map warning as the key-loss signal", () => {
    const runtime = evaluateModule(source(), { React });
    const jsx = runtime.jsx as (type: unknown, props: unknown, key?: unknown) => unknown;
    const jsxs = runtime.jsxs as (type: unknown, props: unknown) => unknown;
    const jsxDEV = runtime.jsxDEV as (
      type: unknown,
      props: unknown,
      key?: unknown,
      isStaticChildren?: boolean,
      source?: unknown,
      self?: unknown,
    ) => unknown;

    const warnings: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      warnings.push(format(...args));
    };
    const keyWarnings = () => warnings.filter(message => /unique "key" prop/.test(message));
    const render = (element: unknown) => {
      warnings.length = 0;
      renderToString(element);
    };

    try {
      render(
        jsxs("section", {
          children: [jsx("h1", { children: "a" }), jsx("h2", { children: "b" })],
        }),
      );
      expect(keyWarnings()).toEqual([]);

      render(
        jsxDEV(
          "section",
          { children: [jsx("h1", { children: "a" }), jsx("h2", { children: "b" })] },
          undefined,
          true,
          undefined,
          undefined,
        ),
      );
      expect(keyWarnings()).toEqual([]);

      render(
        jsx("ul", {
          children: [jsx("li", { children: "x" }), jsx("li", { children: "y" })],
        }),
      );
      expect(keyWarnings().length).toBeGreaterThan(0);

      const rows = [
        { key: "row-alpha", label: "alpha" },
        { key: "row-beta", label: "beta" },
      ];
      render(
        jsxs("ul", {
          children: rows.map(row => jsx("li", { children: row.label }, row.key)),
        }),
      );
      expect(keyWarnings()).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });

  // The whole reason the adapter exists: an element it produced has to be a real
  // React element at the host's version, not a lookalike object.
  it("produces elements the host ReactDOM renders, with no unique-key warning", () => {
    const runtime = evaluateModule(source(), { React });
    const jsx = runtime.jsx as (type: unknown, props: unknown, key?: unknown) => unknown;
    const jsxs = runtime.jsxs as (type: unknown, props: unknown) => unknown;

    const createElement = React.createElement as (type: string, props: unknown, child: unknown) => unknown;
    const Child = (props: { label: string }) => createElement("li", null, props.label);
    const list = jsxs("ul", {
      children: [
        jsx(Child, { label: "a" }, "k-a"),
        jsx(Child, { label: "b" }, "k-b"),
        jsx(Child, { label: "c" }, "k-c"),
      ],
    });

    const warnings: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    let html = "";
    try {
      html = renderToString(list);
    } finally {
      console.error = originalError;
    }

    expect(html).toBe("<ul><li>a</li><li>b</li><li>c</li></ul>");
    expect(warnings.some(message => /unique "key" prop/.test(message))).toBe(false);
  });

  // #9's React identity rule list: a required global missing is what the guard is
  // for, and evaluating the module before the host is there must not be the moment
  // it fails — module evaluation order belongs to the bundler.
  it("evaluates without the host React, and fails with a structured error on first use", () => {
    const runtime = evaluateModule(source());
    const jsx = runtime.jsx as (type: unknown, props: unknown) => unknown;

    const error = caught(() => jsx("div", { children: "x" }));
    expect(codeOf(error)).toBe("host-global-missing");
    expect(error.specifier).toBe("react/jsx-runtime");
  });

  // Both ids share one adapter, so a failure from a dev build has to name the id the
  // source actually imported rather than the row's first id.
  it("names the dev runtime id in a failure from a dev build", () => {
    const runtime = evaluateModule(source("react/jsx-dev-runtime"));
    const jsxDEV = runtime.jsxDEV as (type: unknown, props: unknown) => unknown;
    const error = caught(() => jsxDEV("div", {}));
    expect(codeOf(error)).toBe("host-global-missing");
    expect(error.specifier).toBe("react/jsx-dev-runtime");
  });

  // Fragment is a *guarded* member: #5 never read `React.Fragment` off the host
  // object, so the bridge checks it on access instead of binding a snapshot.
  it("reports a guarded member as incompatible rather than resolving to undefined", () => {
    const hostWithoutFragment = { version: "19.2.7", createElement: React.createElement };
    const runtime = evaluateModule(source(), { React: hostWithoutFragment });

    const error = caught(() => runtime.Fragment);
    expect(codeOf(error)).toBe("host-global-incompatible");
    expect(error.member).toBe("Fragment");
    expect(error.fixOwner).toBe("dependency-decision");
  });
});

describe("the artifact guard", () => {
  it("passes on a host matching the recorded identity", () => {
    expect(() =>
      evaluateScript(renderHostBridgeGuard({ recordedHostReactVersion: "19.2.7" }), { React, ReactDOM }),
    ).not.toThrow();
  });

  // The version strategy #9 asks for: the lock records the host build a decision was
  // verified against, and a page running a different build is a decision whose
  // evidence no longer applies.
  it("refuses a host whose recorded identity does not match", () => {
    const olderReact = { ...React, version: "18.3.1" };
    const error = caught(() =>
      evaluateScript(renderHostBridgeGuard({ recordedHostReactVersion: "19.2.7" }), {
        React: olderReact,
        ReactDOM,
      }),
    );

    expect(codeOf(error)).toBe("host-global-incompatible");
    expect(error.member).toBe("version");
  });

  it("checks every always-available global, not just the identity-sensitive ones", () => {
    expect(() =>
      evaluateScript(renderHostBridgeGuard({ recordedHostReactVersion: "19.2.7" }), { React }),
    ).toThrowError(/host-global-missing/);
  });

  it("refuses when a required global is absent", () => {
    expect(() =>
      evaluateScript(renderHostBridgeGuard({ recordedHostReactVersion: "19.2.7" }), { ReactDOM }),
    ).toThrowError(/host-global-missing/);
  });

  it("emits no identity check when no recorded version was supplied", () => {
    const differentReact = { ...React, version: "18.3.1" };
    const guard = renderHostBridgeGuard({ recordedHostReactVersion: undefined });
    expect(guard).not.toContain("18.3.1");
    expect(() => evaluateScript(guard, { React: differentReact, ReactDOM })).not.toThrow();
  });

  // Preset-conditional globals are reported at build time, where the cell's declared
  // preset is known, and never thrown — #5 records their absence as a supported
  // state.
  it("never throws for a preset-conditional global", () => {
    const guard = renderHostBridgeGuard({ recordedHostReactVersion: "19.2.7" });
    expect(guard).not.toContain("antd");
  });
});

describe("planning the bridge", () => {
  // The catalog is the table projected: what the bridge *could* intercept. It is a
  // capability list, never an instruction — see the activation block below for what a
  // caller may actually wire.
  it("projects the table into a per-module-id catalog", () => {
    const plan = planHostBridge();
    expect(plan.catalog.map(entry => entry.moduleId)).toEqual(interceptedHostBridgeModuleIds());
    expect(plan.diagnostics).toEqual([]);
    for (const entry of plan.catalog) {
      expect(entry.source.startsWith(HOST_BRIDGE_GENERATED_BANNER)).toBe(true);
      expect(entry.bundledForbidden).toBe(true);
    }

    // No decisions and no references: the answer to "what does this artifact
    // activate" is unknown, and the plan says so rather than handing back the whole
    // catalog as if it had been decided.
    expect(plan.activation).toBe("unstated");
    expect(plan.interceptions).toEqual([]);
  });

  it("gives each module id the source its own shape needs", () => {
    const byId = new Map(planHostBridge().catalog.map(entry => [entry.moduleId, entry]));
    expect(byId.get("react")?.shape).toBe("host-identity");
    expect(byId.get("react-dom")?.shape).toBe("host-identity");
    expect(byId.get("react-dom/client")?.shape).toBe("verified-member-view");
    expect(byId.get("antd")?.shape).toBe("host-identity");
    expect(byId.get("react/jsx-runtime")?.shape).toBe("jsx-runtime-adapter");
    expect(byId.get("react/jsx-dev-runtime")?.shape).toBe("jsx-runtime-adapter");

    expect(byId.get("react-dom/client")?.source).not.toBe(byId.get("react-dom")?.source);
    expect(byId.get("react-dom/client")?.source).toContain("Proxy");
    expect(byId.get("react-dom")?.source).toContain('globalThis["ReactDOM"]');
    expect(byId.get("react-dom")?.source).not.toContain("Proxy");
  });

  // #9's fifth acceptance criterion. A synthetic row is added to the table the way a
  // project would add one, and the catalog grows without a line of code changing —
  // which is what "no hardcoded package-specific AST rewrites" has to mean in practice.
  it("extends the catalog from the table, with no code change", () => {
    const dayjs: HostBridgeGlobalMapping = {
      kind: "host-global",
      specifier: "dayjs",
      globalName: "dayjs",
      binds: [{ moduleId: "dayjs", shape: "host-identity" }],
      identityRule: "A project-supplied row; #9 defers it until its version semantics are recorded.",
      verifiedMembers: [],
      evidence: ["product-runtime-source"],
    };

    const plan = planHostBridge({ mappings: [...HOST_BRIDGE_MAPPINGS, dayjs] });
    expect(plan.diagnostics).toEqual([]);
    expect(plan.catalog.map(entry => entry.moduleId)).toContain("dayjs");
    expect(plan.catalog.at(-1)?.source).toContain('globalThis["dayjs"]');
  });

  // The structural half of the same criterion: a generator whose only inputs are a
  // mapping and a module id cannot see authored source, so there is nothing for a
  // per-package AST rule to hook into.
  it("gives every generator the mapping as its input, never authored source", () => {
    expect(renderHostBridgeModule).toHaveLength(2);
    expect(renderHostBridgeGlobalModule).toHaveLength(2);
    expect(renderHostBridgeAdapterModule).toHaveLength(2);
    expect(() => renderHostBridgeModule(globalMapping("react"), "not-intercepted")).toThrow();
  });

  it("reports a `host` decision the table cannot bind", () => {
    const plan = planHostBridge({ decisions: [hostDecision("lodash", "_")] });
    expect(plan.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["host-mapping-missing"]);
    expect(plan.diagnostics[0]?.specifier).toBe("lodash");
  });

  // The review's second finding from round one. `antd` is not identity-sensitive, so a
  // cell-local inline copy shares nothing that a second copy could split — reporting it
  // would turn a table row into a policy, and the resolver's own duplicate audit draws
  // the same line.
  it("reports a bundled duplicate only for an identity-sensitive mapping", () => {
    const react = planHostBridge({ decisions: [inlineDecision("react")] });
    const diagnostic = react.diagnostics.find(candidate => candidate.code === "host-module-duplicated");
    expect(diagnostic?.specifier).toBe("react");
    expect(diagnostic?.detail).toContain("observable from every cell");

    expect(planHostBridge({ decisions: [inlineDecision("antd")] }).diagnostics).toEqual([]);
    expect(planHostBridge({ decisions: [inlineDecision("lodash")] }).diagnostics).toEqual([]);
  });

  it("reports a JSX runtime id claimed by a page global, and only once", () => {
    const plan = planHostBridge({ decisions: [hostDecision("react/jsx-runtime")] });
    const codes = plan.diagnostics.map(diagnostic => diagnostic.code);
    expect(codes).toContain("host-adapter-not-used");
    // The adapter row *is* the mapping, so the same module must not also be reported
    // as unmapped.
    expect(codes).not.toContain("host-mapping-missing");
    expect(codes.filter(code => code === "host-adapter-not-used")).toHaveLength(1);
  });

  it("reports no diagnostic for the decisions the table supports", () => {
    const plan = planHostBridge({
      decisions: [hostDecision("react", "React"), hostDecision("react-dom", "ReactDOM"), hostDecision("antd", "antd")],
    });
    expect(plan.diagnostics).toEqual([]);
  });

  it("converts an incoherent table into a diagnostic instead of an exception", () => {
    const duplicate: HostBridgeGlobalMapping = {
      ...globalMapping("antd"),
      specifier: "antd-again",
      binds: [{ moduleId: "antd", shape: "host-identity" }],
    };
    const plan = planHostBridge({ mappings: [...HOST_BRIDGE_MAPPINGS, duplicate] });
    expect(plan.diagnostics.map(diagnostic => diagnostic.code)).toContain("host-mapping-conflict");
  });

  it("formats a plan, separating the catalog from the activations", () => {
    const report = formatHostBridgePlan(planHostBridge({ decisions: [hostDecision("lodash", "_")] }));
    expect(report).toContain("Host bridge catalog: 6 module id(s)");
    expect(report).toContain("Activations: stated");
    expect(report).toContain("[host-mapping-missing]");
    expect(report).toContain("fix owner: dependency-decision");
  });

  it("does not intercept the built-ins #9 defers", () => {
    for (const deferred of HOST_BRIDGE_DEFERRED_MODULES) {
      expect(interceptedHostBridgeModuleIds()).not.toContain(deferred.specifier);
    }
  });
});

// ---------------------------------------------------------------------------
// Activation — the review's second finding of round two
// ---------------------------------------------------------------------------

describe("the plan activates only what the decisions select", () => {
  const activeIds = (options: Parameters<typeof planHostBridge>[0]) =>
    planHostBridge(options).interceptions.map(entry => entry.moduleId);

  it("activates a host decision, and its source is the catalog's", () => {
    const plan = planHostBridge({ decisions: [hostDecision("react", "React")] });
    expect(plan.activation).toBe("stated");
    expect(plan.interceptions.map(entry => entry.moduleId)).toEqual(["react"]);
    expect(plan.interceptions[0]?.source).toBe(plan.catalog.find(entry => entry.moduleId === "react")?.source);
  });

  // The finding: before this, the plan carried an `antd -> globalThis.antd` interception
  // for an artifact that deliberately bundles its own copy, so wiring the plan into a
  // resolver would have made the mapping table a mandatory-host policy.
  it("does not activate a mapping the artifact decided to bundle", () => {
    expect(activeIds({ decisions: [inlineDecision("antd")] })).toEqual([]);
    expect(activeIds({ decisions: [inlineDecision("react")] })).toEqual([]);
    expect(activeIds({ decisions: [{ strategy: "extension", packageName: "antd", libraryId: "x", globalName: "antd" }] })).toEqual([]);
    expect(activeIds({ decisions: [{ strategy: "replace", packageName: "antd", rejection: { kind: "technical", code: "runtime-api-unavailable", summary: "the bundled copy needs an API the target does not expose", remediation: "use something else" } }] })).toEqual([]);
  });

  it("activates the JSX runtime adapter from a reference, because it is not a `host` strategy", () => {
    expect(activeIds({ referencedSpecifiers: ["react/jsx-runtime"] })).toEqual(["react/jsx-runtime"]);
    // The resolver requires `replace` for these ids, so a decision naming one still
    // activates the adapter: it is what a compiler would otherwise act on.
    expect(
      activeIds({
        decisions: [
          {
            strategy: "replace",
            packageName: "react/jsx-runtime",
            rejection: { kind: "technical", code: "runtime-api-unavailable", summary: "the published module carries its own React", remediation: "bind the generated adapter" },
          },
        ],
      }),
    ).toEqual(["react/jsx-runtime"]);
  });

  // A bare reference is not a statement that the page provides the module, so it must
  // not produce an interception — the unresolved import belongs to the decision layer.
  it("does not activate a host-global mapping from a reference alone", () => {
    const plan = planHostBridge({ referencedSpecifiers: ["antd", "react-dom/client"] });
    expect(plan.activation).toBe("stated");
    expect(plan.interceptions).toEqual([]);
  });

  it("keeps the catalog available for a caller that wants the full capability list", () => {
    const plan = planHostBridge({ decisions: [inlineDecision("antd")] });
    expect(plan.catalog.map(entry => entry.moduleId)).toEqual(interceptedHostBridgeModuleIds());
  });

  // The compile boundary's own rule: a `react-dom` decision governs an import of
  // `react-dom/client`, which is exactly why `artifact.findDependencyDecision` accepts
  // either the exact specifier or its package name. An exact-string activation check
  // here would leave the narrowed view — the module id the source actually imports —
  // unactivated while activating the package id it does not import.
  it("activates the referenced subpath when a package-level host decision governs it", () => {
    const plan = planHostBridge({
      decisions: [hostDecision("react-dom", "ReactDOM")],
      referencedSpecifiers: ["react-dom", "react-dom/client"],
    });

    expect(plan.interceptions.map(entry => entry.moduleId)).toEqual(["react-dom", "react-dom/client"]);
    expect(plan.interceptions.map(entry => entry.shape)).toEqual(["host-identity", "verified-member-view"]);
  });

  it("does not activate a subpath the artifact does not reference", () => {
    const plan = planHostBridge({ decisions: [hostDecision("react-dom", "ReactDOM")] });
    expect(plan.interceptions.map(entry => entry.moduleId)).toEqual(["react-dom"]);
  });

  // The consequence of the governing rule, and the reason its precedence has to be
  // structural: a package-level `host` record and an explicit subpath record can both be
  // present with different strategies, and canonical lock order puts the package first.
  // Picking by position would host-intercept a subpath the lock decided to bundle.
  it("lets an explicit subpath decision override the package decision, in either array order", () => {
    const packageDecision = hostDecision("react-dom", "ReactDOM");
    const subpathDecision = inlineDecision("react-dom/client");

    for (const decisions of [
      [packageDecision, subpathDecision],
      [subpathDecision, packageDecision],
    ]) {
      const plan = planHostBridge({ decisions, referencedSpecifiers: ["react-dom/client"] });
      expect(plan.interceptions.map(entry => entry.moduleId)).toEqual(["react-dom"]);
    }
  });
});

// ---------------------------------------------------------------------------
// A caller-supplied table participates everywhere — the review's third-round findings
// ---------------------------------------------------------------------------

describe("the plan uses the table it was given, not the shipped default", () => {
  const dayjs: HostBridgeGlobalMapping = {
    kind: "host-global",
    specifier: "dayjs",
    globalName: "dayjs",
    binds: [{ moduleId: "dayjs", shape: "host-identity" }],
    identityRule: "A project-supplied row; #9 defers the shipped one until its version semantics are recorded.",
    verifiedMembers: [],
    evidence: ["product-runtime-source"],
  };

  const customAdapter = {
    kind: "jsx-runtime-adapter",
    specifier: "custom/jsx-runtime",
    adapter: "jsx-runtime",
    requiredHostMembers: ["createElement"],
    guardedMembers: [],
    verifiedMembers: [],
    evidence: ["product-runtime-source"],
  } as const;

  // Before this, `hostBridgeUsage` consulted the shipped table, so an added row appeared
  // in the catalog and was invisible to every reference-driven decision — a capability
  // the bridge could render and refused to use.
  it("lets an added host mapping participate in the preset audit", () => {
    const plan = planHostBridge({
      mappings: [...HOST_BRIDGE_MAPPINGS, dayjs],
      referencedSpecifiers: ["dayjs"],
      cellPreset: "None",
    });

    const diagnostic = plan.diagnostics.find(candidate => candidate.code === "host-global-missing");
    expect(diagnostic?.specifier).toBe("dayjs");
    // `dayjs` is gated by the AntDesign preset per #5, so `AntDesign` makes it clean.
    expect(
      planHostBridge({ mappings: [...HOST_BRIDGE_MAPPINGS, dayjs], referencedSpecifiers: ["dayjs"], cellPreset: "AntDesign" })
        .diagnostics,
    ).toEqual([]);
  });

  it("lets an added host mapping be activated by a host decision", () => {
    const plan = planHostBridge({
      mappings: [...HOST_BRIDGE_MAPPINGS, dayjs],
      decisions: [hostDecision("dayjs", "dayjs")],
    });
    expect(plan.interceptions.map(entry => entry.moduleId)).toEqual(["dayjs"]);
  });

  it("lets an added adapter be activated by a reference", () => {
    const plan = planHostBridge({
      mappings: [...HOST_BRIDGE_MAPPINGS, customAdapter],
      referencedSpecifiers: ["custom/jsx-runtime"],
    });
    expect(plan.interceptions.map(entry => [entry.moduleId, entry.shape])).toEqual([
      ["custom/jsx-runtime", "jsx-runtime-adapter"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// A dry run survives a malformed row — the review's third-round finding
// ---------------------------------------------------------------------------

describe("planHostBridge reports a malformed table instead of throwing", () => {
  it("does not throw on an adapter that names no delegate, and still reports it", () => {
    // The contract guard catches this one, but the renderer would throw a second time
    // while generating the catalog — which is what turned a promised dry run into an
    // exception. The entry is skipped and a diagnostic explains why.
    const broken = {
      kind: "jsx-runtime-adapter",
      specifier: "broken/jsx-runtime",
      adapter: "jsx-runtime",
      requiredHostMembers: [],
      verifiedMembers: [],
      evidence: ["product-runtime-source"],
    } as const;

    let plan: ReturnType<typeof planHostBridge> | undefined;
    expect(() => {
      plan = planHostBridge({ mappings: [...HOST_BRIDGE_MAPPINGS, broken] });
    }).not.toThrow();

    expect(plan?.catalog.map(entry => entry.moduleId)).not.toContain("broken/jsx-runtime");
    const conflicts = plan?.diagnostics.filter(diagnostic => diagnostic.code === "host-mapping-conflict") ?? [];
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect(conflicts.some(diagnostic => /cannot be rendered|names no host member/.test(diagnostic.detail))).toBe(true);
    // The rest of the table is still projected, so a caller can act on the good rows.
    expect(plan?.catalog.map(entry => entry.moduleId)).toContain("react");
  });
});

// ---------------------------------------------------------------------------
// Preset readiness — the review's third finding of round one and first of round two
// ---------------------------------------------------------------------------

describe("preset readiness is audited for the imports the cell relies on", () => {
  const antdMissing = (options: Parameters<typeof planHostBridge>[0]) =>
    planHostBridge(options).diagnostics.filter(diagnostic => diagnostic.code === "host-global-missing");

  it("reports nothing for an unused conditional mapping", () => {
    // Before the fix this reported `antd` for a cell whose preset is `None` even when
    // the artifact never mentions `antd`.
    expect(antdMissing({ cellPreset: "None" })).toEqual([]);
    expect(antdMissing({ cellPreset: "None", decisions: [hostDecision("react", "React")] })).toEqual([]);
    expect(antdMissing({ cellPreset: "ECharts", referencedSpecifiers: ["react", "react-dom"] })).toEqual([]);
  });

  it("reports a conditional mapping the cell relies on through a host decision", () => {
    const fromDecision = antdMissing({ cellPreset: "None", decisions: [hostDecision("antd", "antd")] });
    expect(fromDecision).toHaveLength(1);
    expect(fromDecision[0]?.specifier).toBe("antd");
    expect(fromDecision[0]?.detail).toContain("supported state");
  });

  it("reports a conditional mapping the cell imports with no decision either way", () => {
    const fromReference = antdMissing({ cellPreset: "None", referencedSpecifiers: ["antd"] });
    expect(fromReference).toHaveLength(1);
    expect(fromReference[0]?.specifier).toBe("antd");
  });

  // The round-two finding: a decision that bundles its own copy does not need the host
  // preset, so requiring one would contradict the same change that made it legal.
  it("reports nothing for a conditional mapping another decision bundles", () => {
    expect(antdMissing({ cellPreset: "None", decisions: [inlineDecision("antd")] })).toEqual([]);
    expect(
      antdMissing({
        cellPreset: "None",
        decisions: [{ strategy: "extension", packageName: "antd", libraryId: "x", globalName: "antd" }],
      }),
    ).toEqual([]);
    expect(antdMissing({ cellPreset: "None", referencedSpecifiers: ["antd"], decisions: [inlineDecision("antd")] })).toEqual([]);
  });

  it("reports nothing when the declared preset does install the global", () => {
    expect(antdMissing({ cellPreset: "AntDesign", referencedSpecifiers: ["antd"] })).toEqual([]);
    expect(antdMissing({ cellPreset: "AntDesign", decisions: [hostDecision("antd", "antd")] })).toEqual([]);
  });

  it("abstains when the caller did not say what the cell uses", () => {
    expect(antdMissing({ cellPreset: "None" })).toEqual([]);
  });

  it("still reports an unknown preset, which is a config error rather than a usage question", () => {
    const plan = planHostBridge({ cellPreset: "SomeFuturePreset" as "AntDesign" });
    expect(plan.diagnostics[0]?.code).toBe("host-mapping-missing");
    expect(plan.diagnostics[0]?.specifier).toBe("cell-preset");
  });
});
