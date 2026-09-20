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

import { RuntimeFacadeContractError } from "./capabilities";
import type { CellPropKey, ForguncyPropMember } from "./capabilities";

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
 * One configured server command.
 *
 * `#5` pins "a record of command name to async function". The parameters are
 * `unknown[]` because a command's parameter list belongs to the Forguncy
 * project, not to this workspace — the façade can type the *envelope* and the
 * caller narrows the payload, or a generated declaration supplies it later.
 */
export type ServerCommandCall = (...parameters: readonly unknown[]) => Promise<ServerCommandResult>;

/**
 * The `ServerCommands` base prop.
 *
 * The `| undefined` member is not defensive typing: #5 records that a name the
 * designer did not configure is `undefined` on the record, so calling it raises
 * a plain `TypeError` rather than a platform error. Expressing that in the type
 * is what makes the façade's wrapper handle the case that #5 says exists.
 */
export type ServerCommandBindings = Readonly<Record<string, ServerCommandCall | undefined>>;

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
 * What a provider resolves.
 *
 * Both provider kinds satisfy this one type, which is how #27's "mock/provider
 * boundary" is enforced structurally rather than by convention: a mock that
 * covers less than the host does not compile, and authored source that reaches a
 * capability the host has cannot be running against a mock that lacks it.
 *
 * Declared, not implemented — see the module header. #29 implements both sides.
 */
export interface RuntimeFacadeHostBindings {
  readonly cellProps: RuntimeFacadeCellProps;
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
    supplies: "The base `props` the ReactCellType runtime injects, read at the moment the cell renders.",
    missingCapabilityOutcome:
      "The runtime injects every base prop key on every cell, so a missing base prop is a broken page rather than a supported state; #5 records empty `Permissions` as an open question, which stays an open question here.",
    realRuntimeRequired: true,
  },
  mock: {
    kind: "mock",
    supplies:
      "The same `RuntimeFacadeHostBindings` surface with project/example-provided values, so authored source runs unchanged under `vp dev`.",
    missingCapabilityOutcome:
      "A capability the project did not configure resolves to the absence #5 records for it — an unconfigured server-command name is `undefined`, not a thrown error — so a cell meets the same shape locally as it will in Forguncy.",
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
 * The façade exercises the exception condition rather than the prohibition:
 * holding no module state is what makes it safe for the compiler to inline it
 * per Cell (#6's boundary owns the lowering). The `holdsModuleState: false`
 * member is the load-bearing one — a façade singleton would break the moment two
 * cells on one page declared different mock providers, and #5 already records
 * that two cells can observe different snapshots of the same page global.
 */
export const RUNTIME_FACADE_PACKAGING_POLICY = {
  holdsModuleState: false,
  perCellDuplicateAllowed: true,
  compilerOwnsImportLowering: true,
  reason:
    "A stateless façade has nothing to share between Cells, so inlining it costs bytes and buys no divergence. Whether the compiler lowers façade imports to generated host bindings is the artifact/compiler boundary's decision (#6), not this contract's; this module only states what the façade must hold in order for lowering to stay safe.",
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
