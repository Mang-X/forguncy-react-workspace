/**
 * The runtime façade's boundary: what it resolves through, what it costs, and
 * what it refuses to become.
 *
 * Decision source: GitHub Issue #27 — "Spec: typed Forguncy runtime facade for
 * application-owned capabilities"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/27).
 *
 * `capabilities.ts` answers *which* capabilities the façade may expose. This
 * module answers the three questions #27 asks around that list, none of which is
 * a capability:
 *
 * 1. **Resolution.** #27 requires "a mock/provider boundary usable by #22/#23 so
 *    authored business/UI source does not branch on `if (isForguncy)` or
 *    directly read random globals". So the façade is addressed through a
 *    provider, and the two provider kinds must expose the same public surface.
 *    The port is declared here and **not implemented**: #27 is the Spec, #29 is
 *    the implementation, and shipping a half-verified reader here would make the
 *    façade look validated when only its contract is.
 * 2. **Packaging.** #27 requires that a compile-time/host-backed façade "must
 *    not add a duplicate runtime copy per Cell unless intentionally tiny and
 *    stateless", and allows the compiler to lower façade imports.
 * 3. **Non-goals.** #27's Non-goals section forbids the façade becoming an
 *    application framework. Each one is recorded against the #4 concern it would
 *    have duplicated, so a proposal to add one has to argue against a named
 *    owner rather than against a sentence.
 *
 * Everything typed here is typed from a `core` record. Nothing is typed from
 * what a Forguncy API "usually looks like": the whole point of #27's first
 * acceptance criterion is that the host contract, not convention, decides.
 */

import { CELL_SERVER_COMMANDS_CONTRACT, concernsOwnedBy, isApplicationOwned } from "@forguncy-react-workspace/core";
import type { OwnershipConcernId } from "@forguncy-react-workspace/core";

import {
  RUNTIME_FACADE_CAPABILITIES,
  RuntimeFacadeContractError,
  runtimeFacadeBindingName,
} from "./capabilities";
import type {
  CellPropKey,
  ForguncyPropMember,
  RuntimeFacadeCapability,
  RuntimeFacadeHostBinding,
} from "./capabilities";

// ---------------------------------------------------------------------------
// The confirmed call shapes
// ---------------------------------------------------------------------------

/** The reserved result keys #5 pins on every server-command result. */
export type ServerCommandResultKey = (typeof CELL_SERVER_COMMANDS_CONTRACT.resultKeys)[number];

/**
 * A server-command result, as #5 pins it.
 *
 * `errorCode` and `errorMessage` are reserved, and "every other key on a result
 * is one of the command's own named returns". Both halves are `unknown` on
 * purpose: #5 records that the keys exist, not what a given command puts in
 * them, and a named return is by definition the command's own business.
 */
export type ServerCommandResult = {
  readonly [key in ServerCommandResultKey]?: unknown;
} & {
  readonly [namedReturn: string]: unknown;
};

/**
 * The parameter tuples a command-specific declaration supplies, keyed by command
 * name.
 *
 * An entry is a claim the declaration is entitled to make and this contract is
 * not: #5 pins that `props.ServerCommands[name]` is an async function and that a
 * name the designer never configured is `undefined`, but not what any individual
 * command takes.
 */
export interface ServerCommandParameterMap {
  readonly [commandName: string]: readonly unknown[];
}

/**
 * One configured server command.
 *
 * #5 records exactly one executed call:
 *
 *     await props.ServerCommands.GetSalesData({})   // → { errorCode: 0, errorMessage: "OK", data: [ … ] }
 *
 * so a single object argument is a **confirmed** form — for that command. What is
 * unpinned is what each command needs, and the two obvious defaults both assert
 * something nobody observed: `readonly never[]` admits a zero-argument call the
 * evidence does not contain, and `readonly unknown[]` admits every arity.
 *
 * So the parameter list has **no default**. The only way to call a command is to
 * supply its tuple, which is exactly the knowledge a generated declaration has
 * and this contract does not. An unknown parameter list stays un-callable rather
 * than becoming a call that might be invalid in a real Forguncy page.
 */
export type ServerCommandCall<Parameters extends readonly unknown[]> = (
  ...parameters: Parameters
) => Promise<ServerCommandResult>;

/**
 * The `ServerCommands` base prop.
 *
 * Generic over the command map, because that is where the parameter knowledge
 * lives. The default map is **empty**, so a bare `ServerCommandBindings` admits no
 * call at all: `keyof Record<never, never>` is `never`, and indexing it is a type
 * error. Unpinned parameters therefore read as "cannot be safely called".
 *
 * A provider still satisfies this type — every object is assignable to the empty
 * map — so the port carries the host's real record while the contract refuses to
 * pretend it knows how to invoke it. The `| undefined` on an unconfigured name is
 * the one thing lost by the empty default, and it is recorded as the fact it is in
 * `capabilities.ts` rather than encoded here.
 */
export type ServerCommandBindings<Commands extends ServerCommandParameterMap = Record<never, never>> = {
  readonly [Name in keyof Commands]?: ServerCommandCall<Commands[Name]>;
};

/**
 * The base `props` object, addressed by the keys `core` verifies.
 *
 * Built as a mapped type over `CELL_PROPS_BASE_KEYS` rather than written out, so
 * a key #5 adds to the base prop list cannot be silently missing here, and the
 * two members whose shape `core` pins get that shape instead of `unknown`.
 */
export type RuntimeFacadeCellProps = {
  readonly [Key in CellPropKey]: Key extends "ServerCommands"
    ? ServerCommandBindings
    : Key extends "Forguncy"
      ? Readonly<Record<ForguncyPropMember, unknown>>
      : unknown;
};

// ---------------------------------------------------------------------------
// Resolution: the provider boundary
// ---------------------------------------------------------------------------

export const RUNTIME_FACADE_PROVIDER_KINDS = ["host", "mock"] as const;

export type RuntimeFacadeProviderKind = (typeof RUNTIME_FACADE_PROVIDER_KINDS)[number];

/**
 * A data source's result, as #5 pins it.
 *
 * The four required fields are `resultFieldsExecuted` — the ones a probe actually
 * read — written out rather than derived, because `core` records them in a
 * mutable array while it declares `CELL_SERVER_COMMANDS_CONTRACT.resultKeys` as a
 * literal tuple. `(typeof …)[number]` there yields `"errorCode" | "errorMessage"`
 * and is worth deriving; here it would yield `string` and require nothing, which
 * is worse than writing the four names down. A test compares these names against
 * the `core` list so the two cannot quietly diverge.
 *
 * `reload` is declared explicitly rather than admitted through a string index
 * signature: an index signature would let `result.relaod` type-check, and #27's
 * rule is that an unconfirmed name is omitted rather than guessed.
 * `ServerCommandResult` does carry an index signature, and the asymmetry is
 * deliberate — #5 records that "every other key on a result is one of the
 * command's own named returns" (`namedReturnsAreExtraKeys`), so arbitrary keys
 * *are* that contract. Nothing equivalent was recorded for a data-source result.
 */
export interface DataSourceResult {
  readonly data: unknown;
  readonly totalCount: unknown;
  readonly loading: unknown;
  readonly error: unknown;
  /** Documented but never observed on a result, so optional rather than required. */
  readonly reload?: unknown;
}

/** One `orderBySqlParams` entry, named as #5 passed it. */
export interface DataSourceOrderByParam {
  readonly ColumnName: string;
  /** `"DESC"` is the only value #5 exercised; the full domain is unconfirmed. */
  readonly Order: string;
}

/**
 * The option fields #5 passed to `useDataSource`.
 *
 * Named because they are load-bearing rather than incidental: #5 records that
 * they take effect **server-side** — `top: 3` returned three rows while
 * `totalCount` stayed `72`, and `orderBySqlParams` reordered the rows the server
 * sent.
 */
export interface DataSourceQueryOptions {
  /** Server-side row limit. */
  readonly top?: number;
  /** Server-side row offset. */
  readonly offset?: number;
  /** Server-side ordering. */
  readonly orderBySqlParams?: readonly DataSourceOrderByParam[];
}

/**
 * The cell's `useDataSource` binding, as #5 confirmed it.
 *
 * #5 executed three calls:
 *
 *     useDataSource("Sales", { top: 3 })
 *     useDataSource("Sales", { top: 2, offset: 1, orderBySqlParams: [{ ColumnName: "销售额", Order: "DESC" }] })
 *     useDataSource("NoSuchSource")
 *
 * so the name is the first argument, the options object is optional, and the
 * result is the pinned envelope. Modelling it as the binding itself — rather than
 * as a name→binding map — keeps those facts: a map would state the name twice and
 * let the two disagree, and a zero-argument resolver would drop the options #5
 * proved are applied.
 *
 * The undeclared case belongs to the binding, not to the port: #5 records it as an
 * error *state* whose message contains the name, not a throw, so a provider that
 * has no such source answers with that state instead of omitting a key.
 */
export type DataSourceBinding = (
  dataSourceName: string,
  options?: DataSourceQueryOptions,
) => DataSourceResult;

/**
 * What a provider resolves.
 *
 * Both provider kinds satisfy this one type, which is how #27's "mock/provider
 * boundary" is enforced structurally rather than by convention: a mock that
 * covers less than the host does not compile, and authored source that reaches a
 * capability the host has cannot be running against a mock that lacks it.
 *
 * **Every admitted capability's address has a carrier here**, and the check is per
 * address rather than per kind: `runtimeFacadePortChannelOfBinding` answers
 * `undefined` for a binding whose concrete address the port does not carry, so a
 * second wrapper-local cannot ride along on the first one's channel. See
 * `RUNTIME_FACADE_PORT_CHANNEL_MEMBERS` for how a channel and its member are held
 * in correspondence by the type system rather than by a comment.
 *
 * Declared, not implemented — see the module header. #29 implements both sides.
 */
export interface RuntimeFacadeHostBindings {
  readonly cellProps: RuntimeFacadeCellProps;
  /**
   * The `useDataSource` wrapper-local, under its confirmed name rather than
   * renamed: this port exists to carry host addresses, not to invent new ones.
   */
  readonly useDataSource: DataSourceBinding;
}

/**
 * The channels the port provides.
 *
 * The channel union derives from this tuple, so adding a channel here is what
 * forces the rest of the machinery to account for it.
 */
export const RUNTIME_FACADE_PORT_CHANNELS = ["cell-props", "use-data-source"] as const;

export type RuntimeFacadePortChannel = (typeof RUNTIME_FACADE_PORT_CHANNELS)[number];

/**
 * Which member of {@link RuntimeFacadeHostBindings} carries each channel.
 *
 * The `satisfies` is the load-bearing part: it makes the map exhaustive over the
 * channel union **and** forces every value to be an actual member name, so the
 * channel definition and the port shape are bound at the type level rather than
 * being two lists a reviewer has to compare by eye.
 */
export const RUNTIME_FACADE_PORT_CHANNEL_MEMBERS = {
  "cell-props": "cellProps",
  "use-data-source": "useDataSource",
} as const satisfies Readonly<Record<RuntimeFacadePortChannel, keyof RuntimeFacadeHostBindings>>;

/** The one wrapper-local hook the port carries, by its confirmed name. */
export const RUNTIME_FACADE_PORT_HOOK_NAME = "useDataSource";

/**
 * Which port channel carries a binding, or `undefined` when the port has none.
 *
 * Keyed on the binding's *identity*, not its kind: a `cell-hook` is carried only
 * when its hook is the one the port has a member for. Returning `undefined`
 * instead of falling back to a channel is what lets the guard refuse a newly
 * admitted wrapper-local rather than reporting it as already covered.
 */
export function runtimeFacadePortChannelOfBinding(
  binding: RuntimeFacadeHostBinding,
): RuntimeFacadePortChannel | undefined {
  switch (binding.kind) {
    case "cell-prop":
    case "forguncy-member":
      return "cell-props";
    case "cell-hook":
      return binding.hook === RUNTIME_FACADE_PORT_HOOK_NAME ? "use-data-source" : undefined;
  }
}

/** True when the port has a carrier for this exact binding. */
export function runtimeFacadePortCoversBinding(binding: RuntimeFacadeHostBinding): boolean {
  const channel = runtimeFacadePortChannelOfBinding(binding);
  return channel !== undefined && RUNTIME_FACADE_PORT_CHANNELS.includes(channel);
}

/** Every channel the admitted capabilities need, derived from the registry. */
export function runtimeFacadePortChannels(): readonly RuntimeFacadePortChannel[] {
  const channels = RUNTIME_FACADE_CAPABILITIES.flatMap(capability =>
    capability.hostBindings.map(runtimeFacadePortChannelOfBinding),
  ).filter((channel): channel is RuntimeFacadePortChannel => channel !== undefined);
  return [...new Set(channels)];
}

/**
 * Refuse a contract whose registry addresses something the port cannot carry.
 *
 * This is the check that would have caught admitting `data-source-binding` against
 * a props-only port, and it runs per binding rather than per kind so that a second
 * wrapper-local cannot ride along on the first one's channel.
 */
export function assertRuntimeFacadePortCoversAdmittedCapabilities(
  capabilities: readonly RuntimeFacadeCapability[] = RUNTIME_FACADE_CAPABILITIES,
): void {
  for (const capability of capabilities) {
    for (const binding of capability.hostBindings) {
      if (!runtimeFacadePortCoversBinding(binding)) {
        throw new RuntimeFacadeContractError(
          "capability-not-admissible",
          `Façade capability "${capability.id}" addresses "${runtimeFacadeBindingName(binding)}", which RuntimeFacadeHostBindings has no channel for.`,
        );
      }
    }
  }
}

export interface RuntimeFacadeProvider {
  readonly kind: RuntimeFacadeProviderKind;
  readonly bindings: RuntimeFacadeHostBindings;
}

export interface RuntimeFacadeProviderExpectation {
  readonly kind: RuntimeFacadeProviderKind;
  readonly supplies: string;
  /** What happens when a capability the shared surface promises is unavailable. */
  readonly missingCapabilityOutcome: string;
  /** Whether evidence for this provider can only come from a real Forguncy page. */
  readonly realRuntimeRequired: boolean;
}

/**
 * What each provider is expected to supply.
 *
 * `mock`'s entry is deliberately as long as `host`'s: #27 asks that the same
 * public façade be mockable, and `host-and-global-lookup`'s omission means a mock
 * never has to impersonate a host global — only the confirmed bindings.
 */
export const RUNTIME_FACADE_PROVIDER_EXPECTATIONS: Readonly<
  Record<RuntimeFacadeProviderKind, RuntimeFacadeProviderExpectation>
> = {
  host: {
    kind: "host",
    supplies:
      "Both `RuntimeFacadeHostBindings` channels, read at the moment the cell renders: the base `props` the ReactCellType runtime injects, and the declared data sources behind the cell's `useDataSource` wrapper-local.",
    missingCapabilityOutcome:
      "The runtime injects every base prop key on every cell, so a missing base prop is a broken page rather than a supported state; #5 records empty `Permissions` and an undeclared data source as open/error states rather than exceptions, and both stay that way here.",
    realRuntimeRequired: true,
  },
  mock: {
    kind: "mock",
    supplies:
      "The same `RuntimeFacadeHostBindings` surface with project/example-provided values on both channels, so authored source runs unchanged under `vp dev` — including data-source behaviour, which #22 requires to be injectable by the example.",
    missingCapabilityOutcome:
      "A capability the project did not configure resolves to the absence #5 records for it — an unconfigured server-command name is `undefined`, and an undeclared data source is an error state rather than a throw — so a cell meets the same shape locally as it will in Forguncy.",
    realRuntimeRequired: false,
  },
};

/**
 * How authored source reaches the host.
 *
 * Recorded as data because it is the requirement #22/#23 build against, and
 * because the two `false` members are the ones a reviewer has to be able to
 * check: a branch on the host, or a direct global read, reintroduces exactly the
 * coupling #27's problem statement describes.
 */
export const RUNTIME_FACADE_RESOLUTION_MODEL = {
  accessor: "The façade's public surface, resolved from the installed provider.",
  authoredSourceBranchesOnHost: false,
  authoredSourceReadsHostGlobals: false,
  providersSharePublicSurface: true,
  note: "The provider is selected by the harness, not by the Cell. Authored source never observes which provider it got, because the moment it can, the mock stops being a stand-in for the host surface and becomes a second code path.",
} as const;

// ---------------------------------------------------------------------------
// Packaging
// ---------------------------------------------------------------------------

/**
 * What the façade is allowed to cost per Cell.
 *
 * #27: "If the runtime facade is compile-time/host-backed, it must not add a
 * duplicate runtime copy per Cell unless intentionally tiny and stateless. The
 * compiler may lower facade imports to generated host bindings where appropriate."
 *
 * **Amended by #29, because implementing the resolution #27 specifies in this
 * same contract showed the condition could not hold as written.** #27 asks the
 * façade to resolve its surface "from the installed provider"
 * ({@link RUNTIME_FACADE_RESOLUTION_MODEL}), and implementing that needs exactly
 * one thing held: the installed provider. A façade with no state at all cannot
 * resolve a provider, and a façade *shared* between Cells cannot hold a per-Cell
 * provider — two Cells rendering would clobber each other's props. So per-Cell
 * duplication is not an allowed optimisation here, it is the requirement, and the
 * condition for that exception has to describe what is actually held:
 *
 * - `holdsProviderSlot` is true, and the slot is per copy (`provider.ts`);
 * - `holdsDomainState` is false, which is the invariant the original wording was
 *   protecting: nothing business-, page- or cross-Cell-shaped is held, so two
 *   Cells can never observe each other through the façade;
 * - `perCellDuplicateAllowed` stays true, and it is now load-bearing rather than
 *   an exception: it is what makes the slot per Cell.
 *
 * Replacing the boolean with two is the point rather than a tidy-up: a single
 * `holdsModuleState` could not distinguish "holds nothing" from "holds the one
 * thing every façade must hold", so either reading of it would have been wrong
 * for one of the two answers.
 */
export const RUNTIME_FACADE_PACKAGING_POLICY = {
  /** The provider slot is the whole of the façade's state. */
  holdsProviderSlot: true,
  /** No business data, no page state, no cross-Cell store. */
  holdsDomainState: false,
  perCellDuplicateAllowed: true,
  compilerOwnsImportLowering: true,
  reason:
    "The slot is safe only because the package is flattened per Cell (#14), so a copy means a slot per Cell; hoisting it into a module two Cells share would hand both whichever rendered last. Whether the compiler lowers façade imports to generated host bindings is the artifact/compiler boundary's decision (#6), not this contract's; this module only states what the façade must hold in order for lowering to stay safe.",
} as const;

// ---------------------------------------------------------------------------
// Non-goals
// ---------------------------------------------------------------------------

/** The Forguncy-owned concerns, derived from `core` rather than listed again. */
export const APPLICATION_OWNED_CONCERNS: readonly OwnershipConcernId[] = concernsOwnedBy("forguncy");

export const RUNTIME_FACADE_BOUNDARY_IDS = [
  "no-application-router",
  "no-cross-cell-state-store",
  "no-business-data-layer",
  "no-auth-implementation",
  "no-page-lifecycle-orchestration",
  "no-host-api-mirror",
] as const;

export type RuntimeFacadeBoundaryId = (typeof RUNTIME_FACADE_BOUNDARY_IDS)[number];

export interface RuntimeFacadeBoundary {
  readonly id: RuntimeFacadeBoundaryId;
  /** #27's non-goal, in its own wording. */
  readonly statement: string;
  /**
   * The #4 concerns this boundary protects.
   *
   * Every entry is Forguncy-owned; the guard below refuses a boundary that
   * guards a concern the cell itself owns, because a cell declining to duplicate
   * its own capability is not a boundary, it is a preference.
   */
  readonly protects: readonly OwnershipConcernId[];
  readonly why: string;
}

export const RUNTIME_FACADE_BOUNDARIES: readonly RuntimeFacadeBoundary[] = [
  {
    id: "no-application-router",
    statement: "Create a framework that competes with Forguncy routing.",
    protects: ["application-navigation"],
    why: "#4 rejects a cell-local router because it would create a second history the host cannot observe, and #5 confirmed no navigation bridge the façade could delegate to instead — so a router is the only implementation available, which is exactly why it must not be built.",
  },
  {
    id: "no-cross-cell-state-store",
    statement: "Become a cross-Cell state store or duplicate data layer.",
    protects: ["application-state", "cross-cell-communication"],
    why: "#27's fifth acceptance criterion states this directly. #5's observed shared `globalThis` makes the anti-pattern easy to reach by accident, which is why the façade's home for shared state is an omission with guidance rather than a convenience API.",
  },
  {
    id: "no-business-data-layer",
    statement: "Create a framework that competes with Forguncy data.",
    protects: ["business-data-source"],
    why: "Business data must stay behind Forguncy's DataSources so permissions and server-side rules remain authoritative; a cell-side cache with its own lifecycle would be a second source of truth (#4's platform-conflict reasoning).",
  },
  {
    id: "no-auth-implementation",
    statement: "Create a framework that competes with Forguncy auth.",
    protects: ["permissions"],
    why: "#4 puts the permission snapshot on the host's side because the host resolved it before the page rendered; a cell that recomputed it would be able to disagree with the page it is on.",
  },
  {
    id: "no-page-lifecycle-orchestration",
    statement: "Create a framework that competes with Forguncy lifecycle.",
    protects: ["page-lifecycle"],
    why: "Cell mounting and disposal are driven by the host page lifecycle, and #5 leaves the property-change re-render question open — so a lifecycle API built on the current reading would encode a guess as a contract.",
  },
  {
    id: "no-host-api-mirror",
    statement: "Reimplement Forguncy client APIs wholesale.",
    protects: APPLICATION_OWNED_CONCERNS,
    why: "The façade exposes an address for a confirmed capability, not a second implementation of it. This boundary names every Forguncy-owned concern so it cannot be read as covering only the ones the other boundaries happened to list.",
  },
];

// ---------------------------------------------------------------------------
// Authoring patterns the façade exists to remove
// ---------------------------------------------------------------------------

export const RUNTIME_FACADE_FORBIDDEN_PATTERN_IDS = [
  "host-global-sniffing",
  "host-branching",
  "prop-plumbing",
  "second-address-for-a-cell-binding",
] as const;

export type RuntimeFacadeForbiddenPatternId = (typeof RUNTIME_FACADE_FORBIDDEN_PATTERN_IDS)[number];

export interface RuntimeFacadeForbiddenPattern {
  readonly id: RuntimeFacadeForbiddenPatternId;
  /** The construct to look for, described so a reviewer or a future lint can match it. */
  readonly lookFor: string;
  readonly reason: string;
  readonly use: string;
}

export const RUNTIME_FACADE_FORBIDDEN_PATTERNS: readonly RuntimeFacadeForbiddenPattern[] = [
  {
    id: "host-global-sniffing",
    lookFor: "Reading a host value off `globalThis` or `window` at the point of use.",
    reason:
      "#27's problem statement names ad-hoc access to host globals as the coupling the façade exists to remove, and #5 records that most of what a cell can reach this way is not a stable contract — `ForguncyReactHelper` is injected but is deliberately not a window property.",
    use: "Ask the provider for the capability. Raw global lookup remains an escape hatch for generated code outside the façade's public surface, not an authoring pattern.",
  },
  {
    id: "host-branching",
    lookFor: "`if (isForguncy)`-style capability sniffing inside business or UI source.",
    reason:
      "#27 requires the same façade to be mockable precisely so that authored source does not branch on the host; a host branch makes the local harness (#22/#23) a second code path instead of a stand-in for the same one.",
    use: "Install a mock provider in local development and keep one code path.",
  },
  {
    id: "prop-plumbing",
    lookFor: "Threading `props` down through component trees so a leaf can reach `ServerCommands` or `Permissions`.",
    reason:
      "It couples every intermediate component to a host detail, and it puts the host's shape in the middle of UI code that has no business knowing it.",
    use: "Read the confirmed capability through the façade at the point of use.",
  },
  {
    id: "second-address-for-a-cell-binding",
    lookFor: "Aliasing or wrapping a name #5 already makes visible inside cell source.",
    reason:
      "#5's user-scope list is the complete `host` mapping surface. Giving one of those names a second address does not add a capability, it adds a way for two spellings of the same value to disagree.",
    use: "Use the confirmed name, or the façade accessor where the façade owns the capability.",
  },
];

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Refuse a boundary that guards something the cell owns.
 *
 * A boundary's job is to protect a Forguncy-owned concern from being duplicated
 * inside a cell. Naming a cell-owned concern here would invert it, and the
 * inversion is easy to make: "the façade does not manage animation" reads like a
 * boundary but is only a scope note.
 */
export function assertRuntimeFacadeBoundariesProtectApplicationConcerns(
  boundaries: readonly RuntimeFacadeBoundary[] = RUNTIME_FACADE_BOUNDARIES,
): void {
  for (const boundary of boundaries) {
    if (boundary.protects.length === 0) {
      throw new RuntimeFacadeContractError(
        "boundary-not-admissible",
        `Façade boundary "${boundary.id}" protects no concern, so it constrains nothing.`,
      );
    }
    for (const concern of boundary.protects) {
      if (!isApplicationOwned(concern)) {
        throw new RuntimeFacadeContractError(
          "boundary-not-admissible",
          `Façade boundary "${boundary.id}" protects "${concern}", which #4 assigns to the cell rather than to Forguncy.`,
        );
      }
    }
  }
}

/** The boundary protecting a concern, when one exists. */
export function findRuntimeFacadeBoundaryForConcern(
  concern: OwnershipConcernId,
): RuntimeFacadeBoundary | undefined {
  return RUNTIME_FACADE_BOUNDARIES.find(boundary => boundary.protects.includes(concern));
}
