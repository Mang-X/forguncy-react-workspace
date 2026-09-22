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
  /**
   * The family of address behind this refusal, as the refusal path declared it.
   *
   * Carried for the same reason as `address`, and it is the finer fact of the two:
   * a code can be raised about more than one family (`provider-binding-missing`
   * covers a base prop, the handle, a handle member, the hook and the bindings
   * record), so the code alone cannot say which. Deriving it from the code is
   * therefore not possible, and a test that wants to check it against the taxonomy
   * has to observe it here rather than assume it — which is exactly the mistake
   * review caught in the producer table, where a hand-written annotation was
   * compared against a hand-written row and the two agreeing proved nothing.
   */
  readonly addressKind: RuntimeFacadeAddressKind;

  constructor(
    code: RuntimeFacadeResolutionErrorCode,
    message: string,
    address: string | undefined,
    addressKind: RuntimeFacadeAddressKind,
  ) {
    super(message);
    this.name = "RuntimeFacadeResolutionError";
    this.code = code;
    this.address = address;
    this.addressKind = addressKind;
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
   * **Derived, not written down.** This is a projection of
   * {@link RUNTIME_FACADE_REFUSAL_PATHS} and {@link RUNTIME_FACADE_STATE_PATH},
   * computed when {@link RUNTIME_FACADE_ABSENCE_MODES} is built. It has to be: when
   * this field was hand-written it could disagree with the implementation, and it
   * did. Now the failure *paths* declare the family, the throw sites name a path,
   * and the row reads the answer back — so there is no second place for it to drift
   * to. A hand-written copy here would be a second declaration pretending to be a
   * check.
   *
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

/**
 * One way a refusal happens: the class it belongs to, and the family of address it
 * is about.
 *
 * `id` names the *situation*, not the code, because several situations share a code
 * and they are still different things to explain. `code` is narrowed to a resolution
 * error code by the `satisfies` below, so this table cannot borrow the one row that
 * is a returned state rather than a refusal.
 */
export interface RuntimeFacadeRefusalPath {
  readonly id: string;
  readonly code: RuntimeFacadeResolutionErrorCode;
  readonly addressKind: RuntimeFacadeAddressKind;
}

/**
 * Every way this package refuses a call, as data — one row per failure *path*.
 *
 * This is the piece the taxonomy needed and could not supply on its own: the
 * *paths*. An address family belongs to the way a call fails, not to the code and
 * not to the member that failed. `provider-binding-missing` covers five different
 * lookups, and `useDataSource` can fail about a `cell-hook` or answer a
 * `data-source-name` state, so neither the code nor the surface member determines
 * the family. Review found that out the hard way: the handle read was annotated as a
 * handle-member failure when `Forguncy` is a *base prop*, and the annotation passed
 * because it was only ever compared against another hand-written list.
 *
 * Turning the paths into data is what makes the three copies one copy:
 *
 * - every refusal is constructed by {@link refuseAbsence}, which reads the code and
 *   the family from the path — a throw site names a path instead of choosing a code
 *   and leaving the family to be decided later by whoever wrote the row or the test;
 * - `addressKinds` on each row is derived from this table
 *   ({@link runtimeFacadeAbsenceAddressKinds}), so the taxonomy cannot disagree with
 *   the paths: there is nothing left to disagree with;
 * - the regression's producer table is keyed by {@link RuntimeFacadeRefusalPathId},
 *   so a path added here with no producer that drives it does not compile.
 *
 * That last point is what closes the hole: a path nothing exercised used to stay
 * green on both sides, because both sides were hand-written lists of the same thing.
 * A path nothing exercises now fails to build.
 */
export const RUNTIME_FACADE_REFUSAL_PATHS = [
  { id: "provider-not-installed", code: "provider-not-installed", addressKind: "provider" },
  { id: "provider-kind-conflict", code: "provider-kind-conflict", addressKind: "provider" },
  { id: "base-prop-not-confirmed", code: "host-binding-not-confirmed", addressKind: "cell-prop" },
  {
    id: "handle-member-not-confirmed",
    code: "host-binding-not-confirmed",
    addressKind: "forguncy-member",
  },
  { id: "base-prop-not-exposed", code: "binding-not-exposed", addressKind: "cell-prop" },
  { id: "handle-member-not-exposed", code: "binding-not-exposed", addressKind: "forguncy-member" },
  { id: "provider-carries-no-bindings", code: "provider-binding-missing", addressKind: "provider" },
  { id: "base-prop-not-supplied", code: "provider-binding-missing", addressKind: "cell-prop" },
  { id: "handle-not-supplied", code: "provider-binding-missing", addressKind: "cell-prop" },
  {
    id: "handle-member-not-supplied",
    code: "provider-binding-missing",
    addressKind: "forguncy-member",
  },
  {
    id: "data-source-hook-not-supplied",
    code: "provider-binding-missing",
    addressKind: "cell-hook",
  },
  {
    id: "called-member-not-callable",
    code: "capability-not-supplied",
    addressKind: "forguncy-member",
  },
  {
    id: "called-member-answered-wrong-shape",
    code: "capability-not-supplied",
    addressKind: "forguncy-member",
  },
  {
    id: "server-command-entry-not-callable",
    code: "capability-not-supplied",
    addressKind: "server-command-name",
  },
  {
    id: "server-command-result-invalid",
    code: "capability-not-supplied",
    addressKind: "server-command-name",
  },
  {
    id: "server-command-not-configured",
    code: "server-command-not-configured",
    addressKind: "server-command-name",
  },
] as const satisfies readonly RuntimeFacadeRefusalPath[];

/**
 * The one absence that is not a refusal: the host answers an undeclared data source
 * with an error *state* on the result, so nothing is thrown and
 * {@link refuseAbsence} must not be able to name this path.
 *
 * A separate row rather than a member of the table above, because that is what makes
 * the exclusion a type rather than a rule someone has to remember.
 */
export const RUNTIME_FACADE_STATE_PATH = {
  id: "undeclared-data-source",
  code: "undeclared-data-source",
  addressKind: "data-source-name",
} as const;

/** The address family a situation is about, and the class it is reported under. */
export interface RuntimeFacadeAbsencePath {
  readonly id: RuntimeFacadeAbsencePathId;
  readonly code: RuntimeFacadeAbsenceId;
  readonly addressKind: RuntimeFacadeAddressKind;
}

export type RuntimeFacadeRefusalPathId = (typeof RUNTIME_FACADE_REFUSAL_PATHS)[number]["id"];
export type RuntimeFacadeAbsencePathId =
  | RuntimeFacadeRefusalPathId
  | typeof RUNTIME_FACADE_STATE_PATH.id;

/** Every path, refusals and the one returned state, in one list to iterate. */
export const RUNTIME_FACADE_ABSENCE_PATHS: readonly RuntimeFacadeAbsencePath[] = [
  ...RUNTIME_FACADE_REFUSAL_PATHS,
  RUNTIME_FACADE_STATE_PATH,
];

function refusalPath(id: RuntimeFacadeRefusalPathId): RuntimeFacadeRefusalPath {
  const path = RUNTIME_FACADE_REFUSAL_PATHS.find(candidate => candidate.id === id);
  if (!path) {
    throw new Error(`Unknown façade refusal path "${id}".`);
  }
  return path;
}

export function findRuntimeFacadeAbsencePath(id: RuntimeFacadeAbsencePathId): RuntimeFacadeAbsencePath {
  const path = RUNTIME_FACADE_ABSENCE_PATHS.find(candidate => candidate.id === id);
  if (!path) {
    throw new Error(`Unknown façade absence path "${id}".`);
  }
  return path;
}

/**
 * The families a code can be raised about, derived from the paths rather than
 * written down beside them.
 *
 * Ordered by `RUNTIME_FACADE_ADDRESS_KINDS` so the answer is a property of the
 * vocabulary rather than of the order rows happen to appear in the table above.
 */
export function runtimeFacadeAbsenceAddressKinds(
  id: RuntimeFacadeAbsenceId,
): readonly RuntimeFacadeAddressKind[] {
  return RUNTIME_FACADE_ADDRESS_KINDS.filter(kind =>
    RUNTIME_FACADE_ABSENCE_PATHS.some(path => path.code === id && path.addressKind === kind),
  );
}

/**
 * The one way a refusal is constructed.
 *
 * Takes a path rather than a code, so the code and the address family are read from
 * the table together. Before this, a throw site chose a code — often by way of a
 * helper that had one hard-coded — and the family was decided separately by whoever
 * wrote the taxonomy row or the regression's annotation. That is how a *command name*
 * came to be reported as a provider wiring fault, and how a *base prop* came to be
 * annotated as a handle member.
 */
export function refuseAbsence(
  path: RuntimeFacadeRefusalPathId,
  address: string | undefined,
  message: string,
): RuntimeFacadeResolutionError {
  const { code, addressKind } = refusalPath(path);
  return new RuntimeFacadeResolutionError(code, message, address, addressKind);
}

/**
 * The prose half of the taxonomy, keyed by row.
 *
 * Everything that is a *fact about the running call* — which address family a code
 * can be raised about, and which family each way of failing belongs to — lives in
 * `RUNTIME_FACADE_REFUSAL_PATHS` / `RUNTIME_FACADE_STATE_PATH` instead, and is
 * attached to these rows when the table is built. What is left here is what only a
 * reader can supply: the cause and the remediation.
 */
const RUNTIME_FACADE_ABSENCE_DESCRIPTIONS: readonly Omit<
  RuntimeFacadeAbsenceMode,
  "addressKinds"
>[] = [
  {
    id: "provider-not-installed",
    shape: "throws",
    cause:
      "No provider was installed in this copy of the package, so no address resolves. The provider is selected by the harness, never by the Cell.",
    remediation:
      "Install one before the first façade call: a generated host binding does it from the cell's own props and `useDataSource`, and a local harness does it with a mock provider.",
  },
  {
    id: "provider-kind-conflict",
    shape: "throws",
    cause:
      "A provider of another kind is already installed in this copy, so installing this one would mean two harnesses driving the same Cell — and the Cell would silently change environment mid-life.",
    remediation:
      "Call `uninstallRuntimeFacadeProvider()` first. Switching environments is an explicit harness action, not something a second install should do as a side effect.",
  },
  {
    id: "host-binding-not-confirmed",
    shape: "throws",
    cause:
      "The requested name is not an address #5 observed at either family the accessors reach. Reachable from JavaScript that never saw the types, and from an `as never` cast in TypeScript.",
    remediation:
      "Use a name `core` records: `CELL_PROPS_BASE_KEYS` for a base prop, `CELL_FORGUNCY_PROP_KEYS` for a handle member.",
  },
  {
    id: "binding-not-exposed",
    shape: "throws",
    cause:
      "The name is a confirmed address, but this accessor is not the façade member that exposes it. Reaching one address through two members is how a façade acquires a second way to be wrong.",
    remediation:
      "Use the member the capability registry names for it. `ServerCommands`, for example, is exposed through `invokeServerCommand`, which answers an unconfigured command name with `server-command-not-configured` instead of a bare `TypeError`.",
  },
  {
    id: "provider-binding-missing",
    shape: "throws",
    cause:
      "The installed provider does not carry the address, or carries something that is not the shape the ReactCellType runtime injects there — the bindings record itself, a base prop, the handle, a handle member, or the `useDataSource` hook. Every one of those is injected on every Cell, so either way the provider was not built from the Cell's own props, and this is a wiring fault rather than a state a page can be in.",
    remediation:
      "Build the provider through `createHostRuntimeFacadeProvider()` from the cell's own `props`, or through `createMockRuntimeFacadeProvider()` in local development. Both fill the addresses the runtime always injects, in the shapes it injects them.",
  },
  {
    id: "capability-not-supplied",
    shape: "throws",
    cause:
      "The address exists on the provider but what is behind it contradicts #5's record: a member #5 *called* is not callable, or such a member answered a shape #5 did not record, or a server command entry is not callable, or a command resolved to something other than the result record. Callability is asked only of addresses whose call shape #5 recorded — a `member-presence` member is handed over as the handle holds it, because #5 read its name from the key list and never its `typeof` — so a non-function at one of those is a shape the evidence permits, not this code. The wrong-answer cases are the worse ones, because a wrong answer reported as the declared type is indistinguishable from a right one.",
    remediation:
      "Configure the capability on the page or Cell in the designer, or supply it in the mock provider — a mock that omits a member #5 called reports this code rather than standing in with `undefined`, and a command declared without a callable entry is declared but not supplied. Nothing is misconfigured when the *answer* is the wrong shape: the address answered something the recorded contract does not describe, so check the product runtime version — or, for a server command, the command's own implementation — before trusting the value.",
  },
  {
    id: "server-command-not-configured",
    shape: "throws",
    cause:
      "#5 records only the names in `availableServerCommands` as present, so an unconfigured name is `undefined` on the record by design — the page did not make that command available to this Cell.",
    remediation:
      "Add the command to the Cell's available server commands in the designer, or supply it in the mock provider's `serverCommands`.",
  },
  {
    id: "undeclared-data-source",
    shape: "returns-the-hosts-error-state",
    cause:
      "#5 records a name that was never declared as an error state whose message contains the name, not as a thrown exception, so the binding answers with that state.",
    remediation:
      "Nothing to fix in the façade: surface the result's `error` field, and declare the data source on the page when the data is supposed to exist.",
  },
];

/**
 * The taxonomy, with each row's address families derived from the refusal paths.
 *
 * Derived rather than written down beside the rows, and that is the correction this
 * table needed: when `addressKinds` was hand-written it could disagree with the
 * implementation, and it did — `capability-not-supplied` was listed as a
 * `forguncy-member` code while `invokeServerCommand` was already emitting it about a
 * `server-command-name`. A projection cannot disagree with its source.
 */
export const RUNTIME_FACADE_ABSENCE_MODES: readonly RuntimeFacadeAbsenceMode[] =
  RUNTIME_FACADE_ABSENCE_DESCRIPTIONS.map(description => ({
    ...description,
    addressKinds: runtimeFacadeAbsenceAddressKinds(description.id),
  }));

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
    throw refuseAbsence(
      "provider-kind-conflict",
      provider.kind,
      `A "${installedProvider.kind}" provider is already installed, so installing a "${provider.kind}" one would change this Cell's environment mid-life. Uninstall the current provider first.`,
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
    // No address: nothing resolved, so the failure is about the slot rather than
    // about anything a call named.
    throw refuseAbsence(
      "provider-not-installed",
      undefined,
      "No runtime façade provider is installed in this copy. Install one before the first façade call — a generated host binding does it from the Cell's props, and a local harness does it with a mock provider.",
    );
  }
  return installedProvider;
}
