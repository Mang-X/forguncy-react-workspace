import { createRequire } from "node:module";
import { Script, createContext } from "node:vm";

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

interface SandboxOptions {
  readonly React?: unknown;
  readonly ReactDOM?: unknown;
  readonly extraGlobals?: Record<string, unknown>;
}

/**
 * Evaluate a generated module the way a CommonJS interop wrapper would.
 *
 * `node:vm` rather than `eval` so the sandbox is the only place a global exists:
 * a bridge test that leaked `globalThis.React` into the test process would pass
 * for the wrong reason.
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

function errorCodeOf(thrown: unknown): string | undefined {
  return typeof thrown === "object" && thrown !== null ? (thrown as { code?: string }).code : undefined;
}

// ---------------------------------------------------------------------------

/** The ReactDOM surface #5 observed on the page global. */
const ReactDOM = { version: "19.2.7", createRoot: () => undefined };

describe("generated host-global modules", () => {
  // #9's first acceptance criterion, asserted as object identity rather than as
  // behaviour: a module that re-exported through a proxy would pass every
  // functional check and still break the identity two cells compare.
  it("exports the page's own React object, not a copy or a wrapper", () => {
    const source = renderHostBridgeGlobalModule(globalMapping("react"));
    expect(evaluateModule(source, { React })).toBe(React);
    // Object identity is the assertion; the wrapper check is here so the reason
    // cannot be lost if the assertion is ever rewritten.
    expect(source).not.toContain("Proxy");
    expect(source).not.toContain("Object.assign");
  });

  it("exports the page's own ReactDOM object", () => {
    const exported = evaluateModule(renderHostBridgeGlobalModule(globalMapping("react-dom")), { ReactDOM });
    expect(exported).toBe(ReactDOM);
  });

  it("starts with the generated-module banner", () => {
    expect(renderHostBridgeModule(globalMapping("react")).startsWith(HOST_BRIDGE_GENERATED_BANNER)).toBe(true);
    expect(renderHostBridgeModule(adapterMapping()).startsWith(HOST_BRIDGE_GENERATED_BANNER)).toBe(true);
  });

  // #5 records React as always available, so its absence means the artifact is not
  // running on the target it was compiled for. That has to be a structured refusal
  // rather than an `undefined` that surfaces wherever the value is first used.
  it("refuses with a structured diagnostic when an always-available global is absent", () => {
    let thrown: unknown;
    try {
      evaluateModule(renderHostBridgeGlobalModule(globalMapping("react")));
    } catch (error) {
      thrown = error;
    }

    expect(errorCodeOf(thrown)).toBe("host-global-missing");
    const error = thrown as { name: string; specifier: string; globalName: string; fixOwner: string; message: string };
    expect(error.name).toBe("HostBridgeError");
    expect(error.specifier).toBe("react");
    expect(error.globalName).toBe("React");
    expect(error.fixOwner).toBe("host-environment");
    expect(error.message).toContain("host-global-missing");
  });

  // The counterpart, and the reason the generated module branches on availability:
  // #5 measured one cell seeing `antd` and another cell on the same page not
  // seeing it, so a throw here would break a legal cell.
  it("binds a preset-conditional global as-is instead of throwing", () => {
    const source = renderHostBridgeGlobalModule(globalMapping("antd"));
    expect(evaluateModule(source)).toBeUndefined();
    expect(source).not.toContain("throw");

    const antd = { Button: () => null };
    expect(evaluateModule(source, { extraGlobals: { antd } })).toBe(antd);
  });
});

describe("generated JSX runtime adapter", () => {
  const adapter = adapterMapping();
  const source = () => renderHostBridgeAdapterModule(adapter);

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
    const jsx = runtime.jsx as (type: unknown, props: unknown, key?: unknown) => { props: { children?: unknown }; key: unknown };

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
    const jsx = runtime.jsx as (type: unknown, props: unknown, key?: unknown) => { props: Record<string, unknown>; key: unknown };

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

  it("ignores the dev-only arguments of jsxDEV", () => {
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

  // The whole reason the adapter exists: an element it produced has to be a real
  // React element at the host's version, not a lookalike object.
  it("produces elements the host ReactDOM renders, with no unique-key warning", () => {
    const runtime = evaluateModule(source(), { React });
    const jsx = runtime.jsx as (type: unknown, props: unknown, key?: unknown) => unknown;
    const jsxs = runtime.jsxs as (type: unknown, props: unknown) => unknown;

    const createElement = React.createElement as (type: string, props: unknown, child: unknown) => unknown;
    const Child = (props: { label: string }) => createElement("li", null, props.label);
    const list = jsxs("ul", {
      children: [jsx(Child, { label: "a" }, "k-a"), jsx(Child, { label: "b" }, "k-b"), jsx(Child, { label: "c" }, "k-c")],
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

    let thrown: unknown;
    try {
      jsx("div", { children: "x" });
    } catch (error) {
      thrown = error;
    }

    expect(errorCodeOf(thrown)).toBe("host-global-missing");
    expect((thrown as { specifier: string }).specifier).toBe("react/jsx-runtime");
  });

  // Fragment is a *guarded* member: #5 never read `React.Fragment` off the host
  // object, so the bridge checks it on access instead of binding a snapshot.
  it("reports a guarded member as incompatible rather than resolving to undefined", () => {
    const hostWithoutFragment = { version: "19.2.7", createElement: React.createElement };
    const runtime = evaluateModule(source(), { React: hostWithoutFragment });

    let thrown: unknown;
    try {
      void runtime.Fragment;
    } catch (error) {
      thrown = error;
    }

    expect(errorCodeOf(thrown)).toBe("host-global-incompatible");
    expect((thrown as { member: string }).member).toBe("Fragment");
    expect((thrown as { fixOwner: string }).fixOwner).toBe("dependency-decision");
  });
});

describe("the artifact guard", () => {
  it("passes on a host matching the recorded identity", () => {
    expect(() =>
      evaluateScript(renderHostBridgeGuard({ recordedHostReactVersion: "19.2.7" }), { React, ReactDOM }),
    ).not.toThrow();
  });

  // The version strategy #9 asks for: the lock records the host build a decision
  // was verified against, and a page running a different build is a decision whose
  // evidence no longer applies.
  it("refuses a host whose recorded identity does not match", () => {
    const olderReact = { ...React, version: "18.3.1" };
    let thrown: unknown;
    try {
      evaluateScript(renderHostBridgeGuard({ recordedHostReactVersion: "19.2.7" }), {
        React: olderReact,
        ReactDOM,
      });
    } catch (error) {
      thrown = error;
    }

    expect(errorCodeOf(thrown)).toBe("host-global-incompatible");
    expect((thrown as { member: string }).member).toBe("version");
  });

  it("checks every always-available global, not just the identity-sensitive ones", () => {
    expect(() =>
      evaluateScript(renderHostBridgeGuard({ recordedHostReactVersion: "19.2.7" }), { React }),
    ).toThrowError(/host-global-missing/);
  });

  it("refuses when a required global is absent", () => {
    expect(() =>
      evaluateScript(renderHostBridgeGuard({ recordedHostReactVersion: "19.2.7" }), {
        ReactDOM,
      }),
    ).toThrowError(/host-global-missing/);
  });

  it("emits no identity check when no recorded version was supplied", () => {
    const differentReact = { ...React, version: "18.3.1" };
    const guard = renderHostBridgeGuard({ recordedHostReactVersion: undefined });
    expect(guard).not.toContain("18.3.1");
    expect(() => evaluateScript(guard, { React: differentReact, ReactDOM })).not.toThrow();
  });

  // Preset-conditional globals are reported at build time, where the cell's
  // declared preset is known, and never thrown — #5 records their absence as a
  // supported state.
  it("never throws for a preset-conditional global", () => {
    const guard = renderHostBridgeGuard({ recordedHostReactVersion: "19.2.7" });
    expect(guard).not.toContain("antd");
  });
});

describe("planning the bridge", () => {
  it("derives one interception per mapping, from the table alone", () => {
    const plan = planHostBridge();
    expect(plan.interceptions.map(interception => interception.specifier)).toEqual(
      HOST_BRIDGE_MAPPINGS.map(mapping => mapping.specifier),
    );
    expect(plan.interceptions.flatMap(interception => interception.moduleIds)).toEqual(interceptedHostBridgeModuleIds());
    expect(plan.diagnostics).toEqual([]);
    for (const interception of plan.interceptions) {
      expect(interception.source.startsWith(HOST_BRIDGE_GENERATED_BANNER)).toBe(true);
      expect(interception.bundledForbidden).toBe(true);
    }
  });

  // #9's fifth acceptance criterion. A synthetic row is added to the table the way
  // a project would add one, and the plan grows without a line of code changing —
  // which is what "no hardcoded package-specific AST rewrites" has to mean in
  // practice.
  it("extends the interception set from the table, with no code change", () => {
    const dayjs: HostBridgeGlobalMapping = {
      kind: "host-global",
      specifier: "dayjs",
      globalName: "dayjs",
      identityRule: "A project-supplied row; #9 defers it until its version semantics are recorded.",
      verifiedMembers: [],
      evidence: ["product-runtime-source"],
    };

    const plan = planHostBridge({ mappings: [...HOST_BRIDGE_MAPPINGS, dayjs] });
    expect(plan.diagnostics).toEqual([]);
    expect(plan.interceptions.map(interception => interception.specifier)).toContain("dayjs");
    expect(plan.interceptions.at(-1)?.source).toContain('globalThis["dayjs"]');
  });

  // The structural half of the same criterion: a generator whose only parameter is
  // a mapping cannot see authored source, so there is nothing for a per-package AST
  // rule to hook into.
  it("gives every generator the mapping as its only input", () => {
    expect(renderHostBridgeModule).toHaveLength(1);
    expect(renderHostBridgeGlobalModule).toHaveLength(1);
    expect(renderHostBridgeAdapterModule).toHaveLength(1);
  });

  it("reports a `host` decision the table cannot bind", () => {
    const plan = planHostBridge({ decisions: [hostDecision("lodash", "_")] });
    expect(plan.diagnostics.map(diagnostic => diagnostic.code)).toEqual(["host-mapping-missing"]);
    expect(plan.diagnostics[0]?.specifier).toBe("lodash");
  });

  it("reports a bridged module that the decision bundles anyway", () => {
    const plan = planHostBridge({ decisions: [inlineDecision("react")] });
    const diagnostic = plan.diagnostics.find(candidate => candidate.code === "host-module-duplicated");
    expect(diagnostic?.specifier).toBe("react");
    expect(diagnostic?.detail).toContain("observable from every cell");
  });

  it("reports a JSX runtime id claimed by a page global, and only once", () => {
    const plan = planHostBridge({ decisions: [hostDecision("react/jsx-runtime")] });
    const codes = plan.diagnostics.map(diagnostic => diagnostic.code);
    expect(codes).toContain("host-adapter-not-used");
    // The adapter row *is* the mapping, so the same module must not also be
    // reported as unmapped.
    expect(codes).not.toContain("host-mapping-missing");
    expect(codes.filter(code => code === "host-adapter-not-used")).toHaveLength(1);
  });

  it("reports no diagnostic for the decisions the table supports", () => {
    const plan = planHostBridge({
      decisions: [hostDecision("react", "React"), hostDecision("react-dom", "ReactDOM"), hostDecision("antd", "antd")],
    });
    expect(plan.diagnostics).toEqual([]);
  });

  it("reports a preset-conditional global the cell's preset does not install", () => {
    expect(planHostBridge({ cellPreset: "AntDesign" }).diagnostics).toEqual([]);

    const withoutAntd = planHostBridge({ cellPreset: "None" });
    const diagnostic = withoutAntd.diagnostics.find(candidate => candidate.code === "host-global-missing");
    expect(diagnostic?.specifier).toBe("antd");
    expect(diagnostic?.detail).toContain("supported state");

    // Not declaring a preset is not the same as declaring `None`: the bridge
    // reports nothing rather than guessing what the cell declares.
    expect(planHostBridge({ cellPreset: undefined }).diagnostics).toEqual([]);
  });

  it("reports an unknown preset by name", () => {
    const plan = planHostBridge({ cellPreset: "SomeFuturePreset" as "AntDesign" });
    expect(plan.diagnostics[0]?.code).toBe("host-mapping-missing");
    expect(plan.diagnostics[0]?.specifier).toBe("cell-preset");
  });

  it("converts an incoherent table into a diagnostic instead of an exception", () => {
    const duplicate: HostBridgeGlobalMapping = { ...globalMapping("antd"), specifier: "antd-again", moduleIds: ["antd"] };
    const plan = planHostBridge({ mappings: [...HOST_BRIDGE_MAPPINGS, duplicate] });
    expect(plan.diagnostics.map(diagnostic => diagnostic.code)).toContain("host-mapping-conflict");
  });

  it("formats a plan with the fix owner on every line", () => {
    const report = formatHostBridgePlan(planHostBridge({ decisions: [hostDecision("lodash", "_")] }));
    expect(report).toContain("Host bridge intercepts 6 module id(s)");
    expect(report).toContain("[host-mapping-missing]");
    expect(report).toContain("fix owner: dependency-decision");
  });

  // A sanity check that the deferrals #9 records are genuinely absent from the
  // table rather than merely not asserted anywhere.
  it("does not intercept the built-ins #9 defers", () => {
    for (const deferred of HOST_BRIDGE_DEFERRED_MODULES) {
      expect(interceptedHostBridgeModuleIds()).not.toContain(deferred.specifier);
    }
  });
});
