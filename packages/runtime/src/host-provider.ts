/**
 * The production provider: the two confirmed addresses a real Cell supplies.
 *
 * Decision source: GitHub Issue #27 — "Spec: typed Forguncy runtime facade for
 * application-owned capabilities"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/27).
 * Implementation: GitHub Issue #29 — "Implement: typed Forguncy runtime facade
 * and local mock provider"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/29).
 *
 * ## Where the host values enter the façade
 *
 * This module is the boundary, and the reason it takes both values as arguments
 * rather than reading them is the fact #5 records about the cell's scope:
 * `props` and `useDataSource` are **wrapper-locals** of the arrow IIFE the
 * ReactCellType runtime wraps cell source in
 * (`CELL_SOURCE_EXECUTION_MODEL.userCodeNesting`), and `props` is not a window
 * property. So they exist in the Cell's lexical scope and nowhere else. The
 * package cannot reach them, and it must not try: `#27` names ad-hoc access to
 * host globals as the coupling the façade removes, and
 * `RUNTIME_FACADE_FORBIDDEN_PATTERNS.host-global-sniffing` records the same.
 *
 * What that means in practice is that *something inside the Cell scope* has to
 * hand the two values over. Stating the requirement is this module's job;
 * emitting it is the artifact/compiler boundary's (#6/#7), which
 * `RUNTIME_FACADE_PACKAGING_POLICY.compilerOwnsImportLowering` leaves there on
 * purpose. That emitter now exists — #82 added it as
 * `CELL_RUNTIME_BINDING_CONTRACT` in `core` (the names, declared as data) plus
 * `cell-compiler`'s `runtime-binding.ts` (the generated module), which the
 * bundler interposes in place of an authored façade import. This module is
 * unchanged by that: it states the shape, and the compiler satisfies it.
 *
 * So the requirement is recorded here, as the shape a generated binding
 * has to satisfy and nothing more:
 *
 * 1. build the provider from the Cell's own `props` and `useDataSource`;
 * 2. install it before the first façade call, which in practice means before the
 *    Cell's element renders.
 *
 * **#82's generated binding satisfies those two and no more.** It has no teardown
 * path, so do not read this list as a description of what the compiler currently
 * emits: an earlier version of this comment carried a third item ("uninstall it
 * when the Cell is torn down") as though the generated binding met it, which no
 * code did. The correction is deliberate, and what replaces it is the honest
 * status rather than a substitute third requirement.
 *
 * Whether a teardown is needed at all is *not decided here*, and the argument is
 * recorded rather than the conclusion:
 *
 * - The slot is per copy (`provider.ts`) and the package is flattened per Cell
 *   (#14), so a Cell's provider is unreachable from another Cell's copy — which
 *   is what `RUNTIME_FACADE_PACKAGING_POLICY.perCellDuplicateAllowed` buys.
 * - Within one copy, re-installing the same kind replaces, so a re-render or an
 *   HMR pass is served without an uninstall.
 *
 * Those two are why the missing teardown is not a *known* defect. They are not a
 * proof that it is not one: whether the platform re-evaluates the artifact when a
 * Cell is torn down or its properties change is not decidable from this
 * repository (`RUNTIME_CONTRACT_UNKNOWNS`' `artifact-re-evaluated-per-render`),
 * and multi-instance and lifecycle behaviour has to be settled by execution
 * rather than by this reasoning. That is #83's subject, with the real-page
 * confirmation in #84. A caller that needs the slot cleared today has
 * `uninstallRuntimeFacadeProvider()`; the generated binding deliberately does not
 * call it, because doing so on a guess would be the compiler inventing lifecycle
 * policy from an unverified premise.
 *
 * ## Why the factory is thin on purpose
 *
 * It validates nothing and walks nothing. Which addresses a provider carries is
 * answered when one is asked for (see `provider.ts` for the taxonomy), because
 * refusing a Cell over a capability it never uses is a failure mode of its own —
 * and because a host binding that passes a wrong object should report *which*
 * address is missing rather than "the props object looks wrong".
 */

import type {
  DataSourceBinding,
  RuntimeFacadeCellProps,
  RuntimeFacadeHostBindings,
  RuntimeFacadePortChannel,
  RuntimeFacadeProvider,
} from "./contract.ts";
import { RUNTIME_FACADE_PORT_CHANNELS, RUNTIME_FACADE_PORT_CHANNEL_MEMBERS } from "./contract.ts";

export interface HostRuntimeFacadeProviderInput {
  /**
   * The `props` object the ReactCellType runtime injected into this Cell.
   *
   * `RuntimeFacadeCellProps` rather than a copy of the host's type: it is a
   * mapped type over `CELL_PROPS_BASE_KEYS`, so a base prop #5 adds cannot be
   * missing from the Cell's side of the façade without being missing here too.
   */
  readonly cellProps: RuntimeFacadeCellProps;
  /** The Cell's `useDataSource` wrapper-local, under its confirmed name. */
  readonly useDataSource: DataSourceBinding;
}

/**
 * The port channels a host binding must fill, derived from the channel list.
 *
 * A generated binding that reads this instead of hard-coding two names cannot
 * fall behind a channel added to the port: the values here are the port's own
 * member names.
 */
export const RUNTIME_FACADE_HOST_BINDING_CHANNELS: readonly string[] = RUNTIME_FACADE_PORT_CHANNELS.map(
  (channel: RuntimeFacadePortChannel) => RUNTIME_FACADE_PORT_CHANNEL_MEMBERS[channel],
);

/** Build the provider a real Cell installs. */
export function createHostRuntimeFacadeProvider(
  input: HostRuntimeFacadeProviderInput,
): RuntimeFacadeProvider {
  const bindings: RuntimeFacadeHostBindings = {
    cellProps: input.cellProps,
    useDataSource: input.useDataSource,
  };
  return { kind: "host", bindings };
}
