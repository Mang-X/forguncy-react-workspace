/**
 * The installed provider: how the façade's public surface reaches the host, and
 * what every way of not reaching it means.
 *
 * Decision source: GitHub Issue #27 — "Spec: typed Forguncy runtime facade for
 * application-owned capabilities"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/27).
 * Implementation: GitHub Issue #29 — "Implement: typed Forguncy runtime facade
 * and local mock provider"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/29).
 *
 * #27 declares both halves of this module and implements neither: the port is
 * `contract.ts`'s `RuntimeFacadeHostBindings` ("declared, not implemented — #29
 * implements both sides"), and the resolution rule is
 * `RUNTIME_FACADE_RESOLUTION_MODEL.accessor` — "the façade's public surface,
 * resolved from the installed provider". This module is that resolution: one
 * slot, two provider kinds (`RUNTIME_FACADE_PROVIDER_EXPECTATIONS`), and no third
 * way in.
 *
 * ## The slot is the only state in the package, and it is per copy
 *
 * #27's packaging policy asked for a façade that holds no module state, so that
 * duplicating it per Cell stays safe. Implementing the provider boundary shows
 * why that condition needed sharpening rather than obeying: a façade with **no**
 * state cannot resolve a provider at all, and a façade **shared** between Cells
 * cannot hold a per-Cell provider — two cells would clobber each other's props
 * the moment both rendered. So the copy has to be per Cell (which is exactly what
 * `perCellDuplicateAllowed` permits), and what has to be true is the thing the
 * policy was protecting: nothing *domain*-shaped is held, and the slot is never
 * hoisted into a module two cells share. `RUNTIME_FACADE_PACKAGING_POLICY` now
 * states that, and `runtimeFacadeProviderState()` is what a diagnostic reads to
 * check it.
 *
 * The slot holds a provider, not a capability, which is why a Cell that never
 * touches the façade is never refused for anything (#9's rule: refusing an
 * artifact because of a capability it does not use is worse than not checking).
 * Any call that *does* reach the surface needs the provider, so the accessor
 * fails fast at the first use rather than lazily at the first resolution.
 *
 * ## Every absence has a shape, and the shape is data
 *
 * `RUNTIME_FACADE_ABSENCE_MODES` exists because "the value is not there" is not
 * one condition. #5 records three different ones at three different addresses,
 * and they have three different fixes:
 *
 * - a base prop or a handle member the runtime always injects is **missing**, so
 *   the provider is not host-shaped and the binding/wiring is wrong;
 * - a server-command name the designer did not list is `undefined` **by design**
 *   (`CELL_SERVER_COMMANDS_CONTRACT`: "only the names listed in
 *   `availableServerCommands` are present"), so it is a page configuration
 *   rather than a wiring fault;
 * - an undeclared data source is an error **state** rather than an absence
 *   (`CELL_DATA_SOURCE_CONTRACT.unknownSourceOutcome`), so it is not an error
 *   path here at all.
 *
 * Collapsing those into one `undefined` — or into one error code — is the
 * failure this table is here to prevent, and the module's test drives every row
 * of it so a declared code cannot become one nothing ever emits.
 */

import type { RuntimeFacadeProvider, RuntimeFacadeProviderKind } from "./contract";

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export const RUNTIME_FACADE_RESOLUTION_ERROR_CODES = [
  "provider-not-installed",
  "provider-kind-conflict",
  "host-binding-not-confirmed",
  "binding-not-exposed",
  "provider-binding-missing",
  "capability-not-supplied",
  "server-command-not-configured",
] as const;

export type RuntimeFacadeResolutionErrorCode = (typeof RUNTIME_FACADE_RESOLUTION_ERROR_CODES)[number];

/**
 * Thrown when a façade call cannot reach a confirmed host address.
 *
 * Distinct from `RuntimeFacadeContractError`, and the distinction is not
 * cosmetic: that one means *this repository's registry* is wrong and is thrown
 * while a contract is being checked, this one means *the running page's wiring*
 * is wrong and is thrown while a cell is running. Reporting one as the other
 * would send the reader to the wrong file.
 */
export class RuntimeFacadeResolutionError extends Error {
  readonly code: RuntimeFacadeResolutionErrorCode;
  /**
   * The confirmed address the failure is about, when it is about one.
   *
   * Carried as a field rather than only interpolated into the message so a test,
   * a console listener or a future diagnostic can report "which addresses were
   * asked for" without parsing prose.
   */
  readonly address: string | undefined;

  constructor(code: RuntimeFacadeResolutionErrorCode, message: string, address?: string) {
    super(message);
    this.name = "RuntimeFacadeResolutionError";
    this.code = code;
    this.address = address;
  }
}

// ---------------------------------------------------------------------------
// The absence taxonomy
// ---------------------------------------------------------------------------

/** Whether an absence is refused, or is a state the host itself returns. */
export const RUNTIME_FACADE_ABSENCE_SHAPES = ["throws", "returns-the-hosts-error-state"] as const;

export type RuntimeFacadeAbsenceShape = (typeof RUNTIME_FACADE_ABSENCE_SHAPES)[number];

/**
 * The families of address a façade call can name.
 *
 * A family, not a registry: `cell-prop` and `forguncy-member` are two families of
 * address `core` records, and `provider` is the slot failures that are about no
 * particular address at all (nothing is installed, two providers conflict).
 */
export const RUNTIME_FACADE_ADDRESS_KINDS = [
  "provider",
  "cell-prop",
  "forguncy-member",
  "cell-hook",
  "server-command-name",
  "data-source-name",
] as const;

export type RuntimeFacadeAddressKind = (typeof RUNTIME_FACADE_ADDRESS_KINDS)[number];

/**
 * One way a façade call can fail to reach its address.
 *
 * `id` is a resolution error code except for the single non-error row, which is
 * why the union is written as an explicit `|` rather than as
 * `RuntimeFacadeResolutionErrorCode`: the row about an undeclared data source is
 * deliberately *not* an error code, and typing it as one would let a reader
 * believe the façade throws for it.
 */
export type RuntimeFacadeAbsenceId = RuntimeFacadeResolutionErrorCode | "undeclared-data-source";

export interface RuntimeFacadeAbsenceMode {
  readonly id: RuntimeFacadeAbsenceId;
  readonly shape: RuntimeFacadeAbsenceShape;
  /**
   * Every address family a lookup can fail at and produce this code, in the order
   * they are listed in `RUNTIME_FACADE_ADDRESS_KINDS`.
   *
   * Plural, and that is a correction rather than a convenience. A resolution error
   * names a *diagnosis*, and one diagnosis can arise at more than one family:
   *
   * - `host-binding-not-confirmed` is one rule — "the name is not an address #5
   *   observed" — applied to a base prop and to a handle member;
   * - `binding-not-exposed` is likewise one rule — "a confirmed address reached
   *   through the wrong member" — applied to both;
   * - `capability-not-supplied` covers a `props.Forguncy` member that answered a
   *   shape #5 did not record, *and* a server command that resolved to something
   *   other than the result record;
   * - `provider-binding-missing` covers the provider's own bindings record, a base
   *   prop, and a handle member, because all three are read through the same
   *   own-property rule.
   *
   * A single-valued field had to pick one family and be wrong about the rest, which
   * is what review found: the row named `forguncy-member` while
   * `invokeServerCommand` was throwing the same code about a `server-command-name`.
   * Splitting the codes by family instead was the alternative and was rejected —
   * `binding-not-exposed` for a base prop and for a handle member are the same
   * diagnosis with the same fix, so two codes would differ only in which registry
   * they consult, which is an invented API of exactly the kind this package refuses.
   *
   * What each entry claims is narrow and testable, in both directions: a test drives
   * one real call per family listed here (so a family nothing produces fails), and
   * asserts every producer's family is listed (so a producer the row omits fails).
   * `address` on the thrown error may name something finer-grained *within* the
   * family — the permission name for `hasPermission`, say — because that is what the
   * reader needs; the family is what the lookup belongs to.
   */
  readonly addressKinds: readonly RuntimeFacadeAddressKind[];
  /** Why the address is absent. Stated as the cause, not as the symptom. */
  readonly cause: string;
  /** What the reader should change. An error a reader cannot act on is a crash. */
  readonly remediation: string;
}

export const RUNTIME_FACADE_ABSENCE_MODES: readonly RuntimeFacadeAbsenceMode[] = [
  {
    id: "provider-not-installed",
    shape: "throws",
    addressKinds: ["provider"],
    cause:
      "No provider was installed in this copy of the package, so no address resolves. The provider is selected by the harness, never by the Cell.",
    remediation:
      "Install one before the first façade call: a generated host binding does it from the cell's own props and `useDataSource`, and a local harness does it with a mock provider.",
  },
  {
    id: "provider-kind-conflict",
    shape: "throws",
    addressKinds: ["provider"],
    cause:
      "A provider of another kind is already installed in this copy, so installing this one would mean two harnesses driving the same Cell — and the Cell would silently change environment mid-life.",
    remediation:
      "Call `uninstallRuntimeFacadeProvider()` first. Switching environments is an explicit harness action, not something a second install should do as a side effect.",
  },
  {
    id: "host-binding-not-confirmed",
    shape: "throws",
    addressKinds: ["cell-prop", "forguncy-member"],
    cause:
      "The requested name is not an address #5 observed at either family the accessors reach. Reachable from JavaScript that never saw the types, and from an `as never` cast in TypeScript.",
    remediation:
      "Use a name `core` records: `CELL_PROPS_BASE_KEYS` for a base prop, `CELL_FORGUNCY_PROP_KEYS` for a handle member.",
  },
  {
    id: "binding-not-exposed",
    shape: "throws",
    addressKinds: ["cell-prop", "forguncy-member"],
    cause:
      "The name is a confirmed address, but this accessor is not the façade member that exposes it. Reaching one address through two members is how a façade acquires a second way to be wrong.",
    remediation:
      "Use the member the capability registry names for it. `ServerCommands`, for example, is exposed through `invokeServerCommand`, which answers an unconfigured command name with `server-command-not-configured` instead of a bare `TypeError`.",
  },
  {
    id: "provider-binding-missing",
    shape: "throws",
    addressKinds: ["provider", "cell-prop", "forguncy-member", "cell-hook"],
    cause:
      "The installed provider does not carry the address, or carries something that is not the shape the ReactCellType runtime injects there — the bindings record itself, a base prop, the handle, a handle member, or the `useDataSource` hook. Every one of those is injected on every Cell, so either way the provider was not built from the Cell's own props, and this is a wiring fault rather than a state a page can be in.",
    remediation:
      "Build the provider through `createHostRuntimeFacadeProvider()` from the cell's own `props`, or through `createMockRuntimeFacadeProvider()` in local development. Both fill the addresses the runtime always injects, in the shapes it injects them.",
  },
  {
    id: "capability-not-supplied",
    shape: "throws",
    addressKinds: ["forguncy-member", "server-command-name"],
    cause:
      "The address exists on the provider but what is behind it contradicts #5's record: a member #5 *called* is not callable, or such a member answered a shape #5 did not record, or a server command entry is not callable, or a command resolved to something other than the result record. Callability is asked only of addresses whose call shape #5 recorded — a `member-presence` member is handed over as the handle holds it, because #5 read its name from the key list and never its `typeof` — so a non-function at one of those is a shape the evidence permits, not this code. The wrong-answer cases are the worse ones, because a wrong answer reported as the declared type is indistinguishable from a right one.",
    remediation:
      "Configure the capability on the page or Cell in the designer, or supply it in the mock provider — a mock that omits a member #5 called reports this code rather than standing in with `undefined`, and a command declared without a callable entry is declared but not supplied. Nothing is misconfigured when the *answer* is the wrong shape: the address answered something the recorded contract does not describe, so check the product runtime version — or, for a server command, the command's own implementation — before trusting the value.",
  },
  {
    id: "server-command-not-configured",
    shape: "throws",
    addressKinds: ["server-command-name"],
    cause:
      "#5 records only the names in `availableServerCommands` as present, so an unconfigured name is `undefined` on the record by design — the page did not make that command available to this Cell.",
    remediation:
      "Add the command to the Cell's available server commands in the designer, or supply it in the mock provider's `serverCommands`.",
  },
  {
    id: "undeclared-data-source",
    shape: "returns-the-hosts-error-state",
    addressKinds: ["data-source-name"],
    cause:
      "#5 records a name that was never declared as an error state whose message contains the name, not as a thrown exception, so the binding answers with that state.",
    remediation:
      "Nothing to fix in the façade: surface the result's `error` field, and declare the data source on the page when the data is supposed to exist.",
  },
];

export function findRuntimeFacadeAbsenceMode(id: RuntimeFacadeAbsenceId): RuntimeFacadeAbsenceMode {
  const mode = RUNTIME_FACADE_ABSENCE_MODES.find(candidate => candidate.id === id);
  if (!mode) {
    throw new Error(`Unknown façade absence mode "${id}".`);
  }
  return mode;
}

/**
 * The codes that are refusals, derived from the table rather than restated.
 *
 * A test asserts this equals {@link RUNTIME_FACADE_RESOLUTION_ERROR_CODES}, so a
 * code added to the union without a row — or a row that quietly downgrades a
 * refusal to a returned state — fails rather than passing as documentation.
 */
export function throwingRuntimeFacadeAbsenceCodes(): readonly RuntimeFacadeResolutionErrorCode[] {
  return RUNTIME_FACADE_ABSENCE_MODES.filter(
    (mode): mode is RuntimeFacadeAbsenceMode & { id: RuntimeFacadeResolutionErrorCode } =>
      mode.shape === "throws",
  ).map(mode => mode.id);
}

// ---------------------------------------------------------------------------
// The slot
// ---------------------------------------------------------------------------

/**
 * What is installed, as a value a diagnostic can read.
 *
 * Two members rather than an optional `kind`, because `undefined` as "no
 * provider" reads like a missing field rather than a state, and because a
 * consumer that has to branch on it should be forced to handle the
 * not-installed case rather than falling through to a default.
 */
export type RuntimeFacadeProviderState =
  | { readonly installed: false }
  | { readonly installed: true; readonly kind: RuntimeFacadeProviderKind };

/**
 * The one slot.
 *
 * Module-scope on purpose, and safe for the reason the policy states: this
 * package is flattened into each Cell (#14), so a copy per Cell means a slot per
 * Cell. Hoisting it into a module two Cells share would hand both of them
 * whichever rendered last, which is the failure `perCellDuplicateAllowed`
 * exists to prevent.
 */
let installedProvider: RuntimeFacadeProvider | undefined;

export function runtimeFacadeProviderState(): RuntimeFacadeProviderState {
  return installedProvider === undefined
    ? { installed: false }
    : { installed: true, kind: installedProvider.kind };
}

/**
 * Install the provider the façade's surface resolves through.
 *
 * Re-installing the same kind replaces the provider, because that is what a
 * re-render (new props, same page) and an HMR pass (re-evaluated module) both
 * look like. Installing a *different* kind is refused: it means two harnesses
 * want the same copy, and letting the second win would move a Cell from the mock
 * to the host — or back — without anyone saying so.
 *
 * Scope note, so the guard is not read as more than it is: this detects a
 * host/mock mix, which no legitimate harness produces. It cannot detect two
 * cells of the *same* kind installing over each other, because nothing in the
 * bindings #5 confirms identifies a cell. That case is prevented by the copy
 * being per Cell, not by this check.
 *
 * The bindings are deliberately **not** walked. Which addresses a provider
 * carries is answered when one is asked for (`provider-binding-missing`), so a
 * provider that lacks a capability this Cell never uses is not refused for it.
 */
export function installRuntimeFacadeProvider(provider: RuntimeFacadeProvider): RuntimeFacadeProvider {
  if (installedProvider !== undefined && installedProvider.kind !== provider.kind) {
    throw new RuntimeFacadeResolutionError(
      "provider-kind-conflict",
      `A "${installedProvider.kind}" provider is already installed, so installing a "${provider.kind}" one would change this Cell's environment mid-life. Uninstall the current provider first.`,
      provider.kind,
    );
  }
  installedProvider = provider;
  return provider;
}

/**
 * Remove the provider, returning what was installed.
 *
 * Returning the previous state rather than nothing is what lets a harness report
 * "the mock was installed and is now gone" instead of an unconditional success,
 * and it is also why the slot needs no third state: "never installed" and "just
 * uninstalled" are distinguishable by the caller that uninstalled.
 */
export function uninstallRuntimeFacadeProvider(): RuntimeFacadeProviderState {
  const previous = runtimeFacadeProviderState();
  installedProvider = undefined;
  return previous;
}

/**
 * The installed provider, or a refusal.
 *
 * Exported for the package's own modules and deliberately **not** re-exported
 * from the entry point: it hands out the raw host bindings, which is the
 * coupling #27's problem statement exists to remove. Authored source reaches
 * capabilities through the façade surface instead.
 */
export function requireRuntimeFacadeProvider(): RuntimeFacadeProvider {
  if (installedProvider === undefined) {
    throw new RuntimeFacadeResolutionError(
      "provider-not-installed",
      "No runtime façade provider is installed in this copy. Install one before the first façade call — a generated host binding does it from the Cell's props, and a local harness does it with a mock provider.",
    );
  }
  return installedProvider;
}
