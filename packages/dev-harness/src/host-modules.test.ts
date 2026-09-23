/**
 * The host-substitution plan, executed rather than described.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), whose plan step 4 requires
 *   reusing "the host-module bridge mapping where possible so compiler/dev behavior does not
 *   drift", and
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22), which makes that reuse an
 *   acceptance criterion ("Host dependency mapping is reusable between compiler and dev runtime
 *   instead of maintaining two unrelated maps").
 *
 * `host-modules.ts` claims three specific things in its comments, and this file is what makes
 * each of them an assertion rather than a promise:
 *
 * 1. that the mapping is *derived* from #9's bridge table and not a second hand-written list —
 *    tested by handing the derivation a table the real one does not contain and observing the
 *    answer change;
 * 2. that `react/jsx-dev-runtime` arrives through that derivation rather than a special case,
 *    which is the id authored JSX actually compiles to and therefore the one a hand-written
 *    entry would be most tempting for;
 * 3. that a bridged id the harness has no copy of is still *aliased* — to a module that throws
 *    the explanation — so it can never silently take the ordinary npm path.
 *
 * The tables are injected where the exported signatures allow it. `findLocalDevModuleIdResolution`
 * (which `host-modules.ts` delegates the lookup to) takes them as optional parameters, so a test
 * can ask "what would this do with a different bridge table" without editing the real one — which
 * is the only way to prove derivation rather than re-assert the current contents.
 */

import { HOST_BRIDGE_MAPPINGS, hostBridgeModuleIds } from "@forguncy-react-workspace/core";
import { findLocalDevModuleIdResolution, LOCAL_DEV_MODULE_RESOLUTIONS } from "@forguncy-react-workspace/runtime";
import { describe, expect, it } from "vitest";

import {
  findHostModuleStandIn,
  hostModuleAliases,
  hostModuleDedupePackages,
  hostPackageVersionExpectations,
  hostPackageVersionMismatches,
  installedHostPackageVersion,
  LocalHostResolutionError,
  UNAVAILABLE_HOST_MODULE_PREFIX,
  unavailableHostModuleId,
  unavailableHostModuleOf,
  unavailableHostModuleSource,
  unavailableHostModules,
} from "./host-modules";

/** Every module id the real bridge table intercepts, in table order. */
const interceptedIds = HOST_BRIDGE_MAPPINGS.flatMap(hostBridgeModuleIds);

describe("the host substitution is derived from the bridge table", () => {
  /**
   * The claim in `host-modules.ts`'s docstring: "there is no second table here and no package
   * name typed into a resolver."
   *
   * Asserted by coverage in both directions rather than by reading the file: every id the table
   * intercepts is either resolvable or explicitly unavailable, so no id can be silently absent
   * from the plan.
   */
  it("accounts for every module id the bridge intercepts", () => {
    const aliases = hostModuleAliases();

    for (const moduleId of interceptedIds) {
      expect(Object.hasOwn(aliases, moduleId), `no alias for bridged id "${moduleId}"`).toBe(true);
    }

    // And nothing beyond the table: an alias for an id no row names would stand in for a module
    // no decision covers, which is the direction `assertLocalDevResolutionsCoverHostBridge`
    // refuses for the resolution rows.
    for (const aliased of Object.keys(aliases)) {
      expect(interceptedIds, `alias for unbridged id "${aliased}"`).toContain(aliased);
    }
  });

  /**
   * The subpath claim: `react/jsx-dev-runtime` is a `moduleId` on the `react/jsx-runtime`
   * adapter row, *not* a row specifier, so a row-keyed lookup would answer "no row" for an id
   * the bridge does intercept.
   *
   * This is the test that keeps the derivation honest. If someone later "simplifies" the lookup
   * to key on row specifiers, or adds a hand-written entry for the dev runtime, this fails —
   * and the failure matters because `react/jsx-dev-runtime` is what authored JSX actually
   * compiles to during development, so it is load-bearing for every Cell in the loop.
   */
  it("resolves react/jsx-dev-runtime through the adapter row, not a special case", () => {
    const row = HOST_BRIDGE_MAPPINGS.find(mapping => hostBridgeModuleIds(mapping).includes("react/jsx-dev-runtime"));

    expect(row, "no bridge row carries react/jsx-dev-runtime").toBeDefined();
    // It is a subpath of its row, not the row's own specifier — the whole point.
    expect(row?.specifier).toBe("react/jsx-runtime");
    expect(row?.specifier).not.toBe("react/jsx-dev-runtime");

    const standIn = findHostModuleStandIn("react/jsx-dev-runtime");
    expect(standIn?.packageName).toBe("react");
    expect(hostModuleAliases()["react/jsx-dev-runtime"]).toBeDefined();
  });

  /**
   * Derivation, proved by perturbation: a *different* bridge table must produce a different
   * plan, which is only possible if the plan is read off the table rather than written beside it.
   *
   * This asks `runtime`'s lookup — the function `host-modules.ts` delegates to — with a table
   * this repository does not contain. If the harness held its own hand-written list, this table
   * would be ignored and the lookup would still answer for `react`.
   */
  it("answers from the table it is given, so a different table gives a different answer", () => {
    const invented = [
      {
        kind: "host-global" as const,
        specifier: "some-invented-package",
        globalName: "SomeInventedGlobal",
        binds: [{ moduleId: "some-invented-package", shape: "host-identity" as const }],
        identityRule: "test fixture",
        verifiedMembers: [],
        evidence: [],
        note: "test fixture",
      },
    ];

    // The invented id is resolved by this table...
    const withInvented = findLocalDevModuleIdResolution(
      "some-invented-package",
      LOCAL_DEV_MODULE_RESOLUTIONS,
      invented,
    );
    // ...and the real one is not, because the lookup read the table it was handed.
    const realIdWithInventedTable = findLocalDevModuleIdResolution("react", LOCAL_DEV_MODULE_RESOLUTIONS, invented);
    expect(realIdWithInventedTable).toBeUndefined();

    // The invented table has no resolution row, so there is no stand-in — the second half of the
    // same derivation: the *row* names the package, and without one nothing is claimed.
    expect(withInvented).toBeUndefined();

    // With the real table, `react` resolves — so the difference above is the table, not the call.
    expect(findLocalDevModuleIdResolution("react")?.resolution.localPackage).toBe("react");
  });
});

describe("an unserved host substitution is still aliased, to an explanation", () => {
  /**
   * The failure mode this exists to prevent: a bridged id falling through to the ordinary npm
   * path, where it would either fail with Vite's generic "failed to resolve" or — worse, if some
   * other install were reachable — bind a copy the artifact will never carry.
   *
   * `antd` is the real case: #9 intercepts it, it is a legitimate `host` dependency, and this
   * harness deliberately does not install it (the page provides it).
   */
  it("aliases every unserved id to a virtual module, never to nothing", () => {
    const aliases = hostModuleAliases();
    const unserved = unavailableHostModules();

    for (const entry of unserved) {
      expect(aliases[entry.moduleId]).toBe(unavailableHostModuleId(entry.moduleId));
      expect(aliases[entry.moduleId].startsWith(UNAVAILABLE_HOST_MODULE_PREFIX)).toBe(true);
    }
  });

  /**
   * The round trip the plugin relies on: `resolveId` receives the alias target and `load` has to
   * recover the module id from it. A prefix test that did not round-trip would make `load` return
   * `null`, and Vite would then serve the virtual id as a missing file.
   */
  it("round-trips a module id through the virtual id", () => {
    for (const moduleId of ["antd", "react-dom/client"]) {
      expect(unavailableHostModuleOf(unavailableHostModuleId(moduleId))).toBe(moduleId);
    }
    // And an id that is not one of ours is not claimed.
    expect(unavailableHostModuleOf("virtual:forguncy/cell/orderList")).toBeUndefined();
    expect(unavailableHostModuleOf("react")).toBeUndefined();
  });

  /**
   * The generated module must *throw*, not export a placeholder.
   *
   * That is the design: the stack trace then ends at the authored `import` that needs the
   * package, which is where the decision has to be made. A module exporting `undefined` would
   * move the failure to whatever consumed the value — and a module exporting a stub would be a
   * local-only pass, the thing this whole mechanism refuses.
   */
  it("generates a module that throws, naming the package and the fix", () => {
    const unserved = unavailableHostModules();
    expect(unserved.length, "expected at least one unserved host substitution (antd)").toBeGreaterThan(0);

    const entry = unserved[0];
    if (entry === undefined) throw new Error("unreachable: asserted above");

    const source = unavailableHostModuleSource(entry.moduleId);
    expect(source).toContain("throw new Error(");
    expect(source).toContain(entry.packageName);
    // The message names what to do, not only what is wrong.
    expect(source).toContain("packages/dev-harness/package.json");
  });

  /** Asking for an explanation of an id that *is* served is a programming error, and says so. */
  it("refuses to explain a substitution that is served", () => {
    expect(() => unavailableHostModuleSource("react")).toThrowError(LocalHostResolutionError);
  });
});

describe("the installed versions are checked against the recorded target", () => {
  /**
   * #5 recorded React's version on Forguncy 12.0.100 and `runtime` carries it; the harness's own
   * install is compared against that, never against a number typed here.
   *
   * This is the test that makes "pinned to the version #5 measured" checkable: the expectation
   * comes from `localDevAlignmentChecks`, so a change to the recorded target changes this.
   */
  it("expects the recorded host version for each substituted package", () => {
    const expectations = hostPackageVersionExpectations();

    const react = expectations.find(entry => entry.packageName === "react");
    expect(react, "no version expectation for react").toBeDefined();
    expect(react?.field).toBe("hostReactVersion");
    // Read off the target rather than written here: the assertion is that the two agree.
    expect(react?.expected).toMatch(/^\d+\.\d+\.\d+/);
  });

  /**
   * One package, one expectation. `react` and `react/jsx-runtime` are two bridge rows and one
   * installed package; a harness that demanded the version twice would make one fact look like
   * two, and a disagreement between them would make the answer depend on row order.
   */
  it("groups the rows by package, so one package has one expected version", () => {
    const packages = hostPackageVersionExpectations().map(entry => entry.packageName);
    expect(new Set(packages).size).toBe(packages.length);
  });

  /**
   * The install actually satisfies the expectation in this workspace — otherwise the loop would
   * be exercising a React the target does not ship, and every local render would be evidence
   * about a different target.
   *
   * `antd` is absent from the expectations *and* from the install, which is the correct pair:
   * #5 recorded no antd version, so there is nothing to compare and the row says why.
   */
  it("matches the recorded version in this workspace, and reports nothing to fix", () => {
    const react = installedHostPackageVersion("react");
    expect(react, "react is not installed for the harness").toBeDefined();

    const mismatches = hostPackageVersionMismatches();
    expect(
      mismatches,
      `harness install does not match the recorded target: ${JSON.stringify(mismatches)}`,
    ).toEqual([]);
  });

  /** The dedupe list is the installed packages only, because it names copies for Vite to collapse. */
  it("dedupes only packages that are actually installed", () => {
    for (const packageName of hostModuleDedupePackages()) {
      expect(installedHostPackageVersion(packageName), `${packageName} is not installed`).toBeDefined();
    }
    // `antd` is bridged but not installed, so it must not be asked for as a copy to keep.
    expect(hostModuleDedupePackages()).not.toContain("antd");
  });
});
