/**
 * The browser half of the harness: mount a Cell as ordinary React.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23), whose plan steps 2 and 3
 *   this module is ("mount an example Cell source as ordinary React", "support
 *   example/project-provided mock props and `ServerCommands` implementations"), and
 * - #22 — "Spec: local Vite+ development runtime for React Cells"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/22).
 *
 * Reachable as `@forguncy-react-workspace/dev-harness/mount`, and it is the only part of the
 * package a page loads. It imports nothing node-side, which is what lets the generated entry
 * import it *by package name*: a harness that reached its own plugin from here would pull
 * `node:module` into the browser graph — the defect `core/browser` exists to fix,
 * reintroduced one layer up. `mount.ts` importing `types.ts` is fine; `types.ts` has no
 * imports of its own.
 *
 * ## What mounting means, and what is deliberately absent
 *
 * One Cell, one React root, the mock installed before the first render. Everything else is
 * left alone:
 *
 * - **No error boundary.** `LOCAL_DEV_ERROR_SURFACING.installsErrorBoundary` and
 *   `catchesCellErrors` are both `false`, and #22's fourth acceptance criterion asks for errors
 *   "visible through normal browser/Vite tooling". A boundary rendering a fallback would turn a
 *   loud failure into a Cell that renders the wrong thing — the outcome a dev loop exists to
 *   avoid. So the render is left to throw, and the error reaches the console, Vite's HMR
 *   overlay and the terminal.
 * - **No host globals.** Nothing is assigned onto `globalThis` so authored source could reach a
 *   host name without importing it (`LOCAL_DEV_FORBIDDEN_PATTERNS`'
 *   `global-installed-for-convenience`). The compile path binds module *ids*, not globals, so a
 *   global-reading Cell is one the bridge cannot bind either — and the aliases the plugin
 *   installs are what make the imported form work.
 * - **No second props source.** The Cell is handed the mock's own `cellProps`, so the props it
 *   receives and the host surface it reaches through the façade are the same object. See
 *   {@link mountCell} for why that is load-bearing rather than tidy.
 *
 * ## The mock is resolved from the Cell's own fixture
 *
 * `virtual:forguncy/cell/<id>` exports the Cell's `fixture`. Resolving it here through
 * `runtime`'s `resolveCellFixtureOptions` applies #28's contract — missing, non-consumable,
 * misspelt and wrongly-shaped fixtures each fail with their own failure class — so the harness
 * restates none of those rules and cannot hold a weaker version of them.
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  assertLocalDevProviderIsMock,
  createMockRuntimeFacadeProvider,
  installRuntimeFacadeProvider,
  resolveCellFixtureOptions,
} from "@forguncy-react-workspace/runtime";
import type { CellFixtureContext, MockRuntimeFacadeOptions, RuntimeFacadeProvider } from "@forguncy-react-workspace/runtime";

import type { DevHarnessMountableCell, DevHarnessMountTarget } from "./types.ts";

/** What {@link mountCell} hands back, so a test or a console can inspect the loop. */
export interface DevHarnessMountedCell {
  readonly cellId: string;
  /** The provider the Cell's façade calls resolve through. */
  readonly provider: RuntimeFacadeProvider;
  /** The base props the Cell was rendered with — the mock's `cellProps`, verbatim. */
  readonly props: Readonly<Record<string, unknown>>;
  /** The Cell's React root. */
  readonly root: { readonly unmount: () => void };
}

/**
 * Mount one Cell into a DOM element, with the fixture's mock provider installed.
 *
 * The order is load-bearing, and it is the only ordering choice here: resolve the fixture,
 * merge any overlay, build the provider, validate its kind, install it, and only *then* create
 * the root. Creating the root first would let a Cell reach the façade before the slot is
 * filled — a failure the façade reports correctly, but as a consequence of the harness's own
 * sequencing rather than of anything the project did.
 *
 * **The props are the mock's own base props.** This is the one place the harness decides
 * something a project might expect to configure, so the reasoning is worth the space: #5
 * records the runtime calling a Cell's entry with the base props (`props.Forguncy`,
 * `props.Permissions`, `props.ServerCommands`, `props.ImageContext`), and the mock's
 * `bindings.cellProps` *is* that record — `mock-provider.ts` builds it from `core`'s
 * `CELL_PROPS_BASE_KEYS`, defaults the two that are always objects on every Cell, and refuses
 * any key #5 never verified. Passing it through is therefore not a convenience: it is the same
 * object the façade resolves, which is what makes it impossible for a Cell to observe a
 * difference between the props it is handed and the host surface it reaches through an
 * accessor. A second, harness-shaped props object passed to `createElement` would be exactly
 * that difference, which is also why {@link DevHarnessMountTarget.propsOverlay} is folded into
 * the mock's options rather than passed alongside them.
 *
 * `installRuntimeFacadeProvider` is called directly, and re-installing the same provider *kind*
 * is explicitly allowed — which is what keeps a React Fast Refresh pass, or a re-render after a
 * props change, from being refused as an environment change. Installing a different kind is
 * refused by the contract, and that asymmetry is the correct one: the harness re-mounting a
 * Cell is normal, two harnesses disagreeing about the host is not.
 */
export function mountCell(cell: DevHarnessMountableCell, target: DevHarnessMountTarget): DevHarnessMountedCell {
  const context: CellFixtureContext =
    target.fixturePath === undefined
      ? { cellId: cell.cellId }
      : { cellId: cell.cellId, fixturePath: target.fixturePath };

  // #28's consumption half minus the provider construction, so the overlay below can be merged
  // *before* the provider is built: `createMockRuntimeFacadeProvider` is the one place that
  // knows which cellProps keys are legal, and merging afterwards would route the overlay around
  // that check.
  const fixtureOptions: MockRuntimeFacadeOptions = resolveCellFixtureOptions(cell.fixture, context);
  const options: MockRuntimeFacadeOptions = mergeOverlay(fixtureOptions, target.propsOverlay);
  const provider = createMockRuntimeFacadeProvider(options);

  // A `host` provider reads bindings a live ReactCellType runtime injects, and this process by
  // definition does not have one — so anything but a mock here is a category error, and the
  // contract's guard names it as one rather than failing later on a missing binding.
  assertLocalDevProviderIsMock(provider);
  installRuntimeFacadeProvider(provider);

  const props = provider.bindings.cellProps as unknown as Readonly<Record<string, unknown>>;
  const root = createRoot(target.element);
  root.render(createElement(cell.Cell as never, props as never));

  return { cellId: cell.cellId, provider, props, root };
}

/**
 * Fold the harness's value props over the fixture's.
 *
 * Only `cellProps` is mergeable, and that is a boundary rather than an omission. A fixture's
 * other three fields are *behaviours* — `serverCommands` and `dataSources` are maps of
 * functions, and `forguncyMembers` is a map of live host members. There is no JSON value to
 * merge into them, and pretending otherwise would mean the harness inventing a call shape for a
 * capability #5 recorded — which is the one direction `mock-provider.ts` refuses to lean.
 *
 * The overlay is `Partial`-shaped because `cellProps` is: a harness overriding one permission
 * must not have to restate the others, and `mock-provider` already treats an absent key as
 * absent rather than as `undefined`.
 */
function mergeOverlay(
  fixture: MockRuntimeFacadeOptions,
  overlay: Readonly<Record<string, unknown>> | undefined,
): MockRuntimeFacadeOptions {
  if (overlay === undefined || Object.keys(overlay).length === 0) {
    return fixture;
  }
  // No `?? {}` fallback: spreading `undefined` contributes nothing, and the lint rule is right
  // that the empty object is noise. The cast is the real assertion — `mock-provider` is what
  // validates which keys are legal, and it runs when the provider is built from this.
  return {
    ...fixture,
    cellProps: { ...fixture.cellProps, ...overlay } as MockRuntimeFacadeOptions["cellProps"],
  };
}
