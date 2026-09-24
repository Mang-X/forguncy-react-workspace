/**
 * Which capabilities the runtime façade is allowed to expose.
 *
 * Decision source: GitHub Issue #27 — "Spec: typed Forguncy runtime facade for
 * application-owned capabilities"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/27), governed by
 * - #4 "application ownership boundaries and dependency strategy semantics"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 "establish the ReactCellType target/runtime contract on Forguncy 12.0.100"
 *   — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 *
 * #27 lists six *candidate* capability families and then attaches the rule that
 * makes the list safe to implement: "Exact APIs must be derived from #5 and
 * current Forguncy MCP/product documentation before implementation" and "Do
 * **not** invent APIs merely because they would be convenient."
 *
 * So this module is not the façade. It is the *resolution* of that candidate
 * list against what #5 actually observed, recorded as data for the same reason
 * `core` records its decisions as data: a boundary that only exists in a
 * comment cannot be asserted by a test, a diagnostic or the implementation
 * Issue (#29).
 *
 * Two things here are load-bearing.
 *
 * **Every address is derived, never restated.** A capability does not carry a
 * copied member name or a copied evidence channel list; it carries a `core`
 * export name plus a selector, and the channel list is read out of that record
 * at import time. A restated channel list is a second source of truth that
 * drifts the moment #5 is re-probed, and #5 is exactly the kind of Issue whose
 * facts a later Forguncy version can change.
 *
 * **A capability says how far the evidence goes, and nothing further.** #5 pins
 * `props.Forguncy`'s *member names* and, separately, the call shape of two
 * bridges. It does not pin the signatures of most members. A façade that typed
 * `hasPermission(email, permissionName): Promise<boolean>` would be guessing, so
 * `confirmation` records which of the three levels applies and the guards below
 * refuse a claim that outruns it.
 */

import {
  CELL_DATA_SOURCE_CONTRACT,
  CELL_FORGUNCY_FACADE,
  CELL_FORGUNCY_PROP_KEYS,
  CELL_PROPS_BASE_KEYS,
  CELL_PROPS_KEY_ORDER,
  CELL_SERVER_COMMANDS_CONTRACT,
  CELL_USER_SCOPE_BINDINGS,
  cellUserScopeBinding,
  isApplicationOwned,
} from "@forguncy-react-workspace/core/browser";
import type { OwnershipConcernId, RuntimeEvidenceChannel } from "@forguncy-react-workspace/core/browser";

// ---------------------------------------------------------------------------
// Names derived from the verified contract
// ---------------------------------------------------------------------------

/** The base `props` keys the runtime always injects, as `core` pins them. */
export type CellPropKey = (typeof CELL_PROPS_BASE_KEYS)[number];

/** A member of the `props.Forguncy` handle, as `core` pins the key list. */
export type ForguncyPropMember = (typeof CELL_FORGUNCY_PROP_KEYS)[number];

// ---------------------------------------------------------------------------
// Evidence sources
// ---------------------------------------------------------------------------

/**
 * The `core` records a façade claim may be derived from.
 *
 * Closed on purpose. `#27`'s first acceptance criterion is that every façade API
 * maps to a confirmed capability "with evidence from #5 or a linked product
 * contract"; a capability that cites a source outside this list either belongs
 * to a different Issue's contract or is citing nothing.
 */
export const RUNTIME_FACADE_EVIDENCE_SOURCE_IDS = [
  "forguncy-prop-facade",
  "cell-props-key-order",
  "server-commands-contract",
  "data-source-contract",
  "user-scope-bindings",
] as const;

export type RuntimeFacadeEvidenceSourceId = (typeof RUNTIME_FACADE_EVIDENCE_SOURCE_IDS)[number];

export interface RuntimeFacadeEvidenceSource {
  readonly id: RuntimeFacadeEvidenceSourceId;
  /** The `core` export this claim reads, so a reader can check it rather than trust it. */
  readonly coreExport: string;
  /** The channels `core` observed that record through. Read out of `core`, not copied. */
  readonly evidence: readonly RuntimeEvidenceChannel[];
}

/**
 * Unique evidence channels, first-seen order preserved.
 *
 * Order is preserved rather than sorted so the derived list still reads in the
 * order `core` recorded the channels, which is the order they were observed in.
 */
export function dedupeEvidenceChannels(
  channels: readonly RuntimeEvidenceChannel[],
): readonly RuntimeEvidenceChannel[] {
  return [...new Set(channels)];
}

const USER_SCOPE_BINDING_EVIDENCE: readonly RuntimeEvidenceChannel[] = dedupeEvidenceChannels(
  CELL_USER_SCOPE_BINDINGS.flatMap(binding => binding.evidence),
);

export const RUNTIME_FACADE_EVIDENCE_SOURCES: Readonly<
  Record<RuntimeFacadeEvidenceSourceId, RuntimeFacadeEvidenceSource>
> = {
  "forguncy-prop-facade": {
    id: "forguncy-prop-facade",
    coreExport: "CELL_FORGUNCY_FACADE",
    evidence: CELL_FORGUNCY_FACADE.evidence,
  },
  "cell-props-key-order": {
    id: "cell-props-key-order",
    coreExport: "CELL_PROPS_KEY_ORDER",
    evidence: CELL_PROPS_KEY_ORDER.evidence,
  },
  "server-commands-contract": {
    id: "server-commands-contract",
    coreExport: "CELL_SERVER_COMMANDS_CONTRACT",
    evidence: CELL_SERVER_COMMANDS_CONTRACT.evidence,
  },
  "data-source-contract": {
    id: "data-source-contract",
    coreExport: "CELL_DATA_SOURCE_CONTRACT",
    evidence: CELL_DATA_SOURCE_CONTRACT.evidence,
  },
  "user-scope-bindings": {
    id: "user-scope-bindings",
    coreExport: "CELL_USER_SCOPE_BINDINGS",
    evidence: USER_SCOPE_BINDING_EVIDENCE,
  },
};

// ---------------------------------------------------------------------------
// Where a capability actually comes from
// ---------------------------------------------------------------------------

/**
 * A confirmed address inside the host, never a new name for one.
 *
 * The `cell-prop` and `forguncy-member` variants are typed by `core`'s own
 * literal unions, so a member name that #5 never observed is a compile error
 * rather than a test failure. `cell-hook` is the one variant that cannot be
 * typed that way: `CELL_USER_SCOPE_BINDINGS` is declared as an array of records
 * rather than as a tuple, so its names widen to `string` and the guard below
 * checks membership at runtime instead.
 */
export type RuntimeFacadeHostBinding =
  | { readonly kind: "cell-prop"; readonly prop: CellPropKey }
  | { readonly kind: "forguncy-member"; readonly member: ForguncyPropMember }
  | { readonly kind: "cell-hook"; readonly hook: string };

/**
 * How far #5's evidence actually goes for a capability.
 *
 * - `call-shape`: the capability was *called* during the probe, and what it
 *   returns was observed. This records that the call was seen, not that its
 *   signature is complete — what stays unpinned is stated per capability in
 *   `note`, and in the call types themselves, where `ServerCommandBindings`
 *   admits no call until a declaration supplies a command's parameters.
 * - `member-presence`: only the name was observed; nothing was called.
 *
 * Two levels, because they are the two #5's evidence currently distinguishes. A
 * third, "result observed but invocation not", existed while
 * `data-source-binding` was believed to be in that state; #5's evidence records
 * three executed `useDataSource` calls, so it is not, and keeping an unused level
 * would have implied coverage this contract does not have.
 *
 * The same correction had to be made one address over, and it is recorded here
 * because the mistake is structural rather than clerical: `permission-check` and
 * the `getPermissions` address of `permission-snapshot` were first written as
 * `member-presence`, because the summary this module derives its key lists from
 * records only the *names* on the `props.Forguncy` handle. #5's own comments
 * record both being called (`hasPermission("ProbePermission")` → `true`,
 * `getPermissions()` → `{"ProbePermission": true}`, neither awaited), so the level
 * was wrong in the direction that matters: it told a reader nothing was run at the
 * exact place a call shape was available. The rule that follows is that a level is
 * set from the executed call, never from the key list — and, since a level is per
 * capability, two addresses with different evidence cannot share one.
 *
 * There is deliberately no "expected" or "conventional" member: collapsing the
 * levels is what would make the façade's types look stronger than the evidence
 * behind them.
 */
export type RuntimeFacadeConfirmation = "call-shape" | "member-presence";

/**
 * Which boundary a capability sits on.
 *
 * `unclassified` is not a failure state. It is what #27 asks for: a member whose
 * presence #5 pinned but whose purpose it did not is re-exposed *without* a
 * boundary claim, because filing it under a plausible-looking #4 concern is how
 * the façade would start asserting ownership nobody verified.
 */
export type RuntimeFacadeCapabilityScope =
  | {
      readonly kind: "application";
      readonly concern: OwnershipConcernId;
      /** The sentence that pins this capability to that concern. */
      readonly basis: string;
    }
  | {
      readonly kind: "host-helper";
      /** The sentence that pins this as a mechanical host helper. */
      readonly basis: string;
    }
  | { readonly kind: "unclassified"; readonly reason: string };

export interface RuntimeFacadeCapability {
  readonly id: RuntimeFacadeCapabilityId;
  readonly family: RuntimeFacadeFamilyId;
  readonly summary: string;
  readonly scope: RuntimeFacadeCapabilityScope;
  readonly confirmation: RuntimeFacadeConfirmation;
  readonly hostBindings: readonly RuntimeFacadeHostBinding[];
  /** `core` records this capability is derived from. Never empty. */
  readonly evidenceSources: readonly RuntimeFacadeEvidenceSourceId[];
  /** Set when the capability is weaker than its name suggests. */
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// The candidate families, resolved
// ---------------------------------------------------------------------------

/**
 * #27's six candidate families, in the order the Issue lists them.
 *
 * Kept as #27's wording in `candidate` so that a reader comparing this module
 * against the Issue is comparing like with like, and so that reworking a verdict
 * is a deliberate edit against the Spec rather than an incidental tidy-up.
 */
export const RUNTIME_FACADE_FAMILY_IDS = [
  "cell-props-and-context",
  "server-command-invocation",
  "application-navigation",
  "page-and-cross-cell-state",
  "page-events-and-commands",
  "host-and-global-lookup",
] as const;

export type RuntimeFacadeFamilyId = (typeof RUNTIME_FACADE_FAMILY_IDS)[number];

export type RuntimeFacadeFamilyVerdict = "admitted" | "omitted";

export interface RuntimeFacadeFamily {
  readonly id: RuntimeFacadeFamilyId;
  /** #27's own phrasing of the candidate family. */
  readonly candidate: string;
  readonly verdict: RuntimeFacadeFamilyVerdict;
  readonly rationale: string;
  readonly evidenceSources: readonly RuntimeFacadeEvidenceSourceId[];
  /** Non-empty exactly when the verdict is `admitted`. */
  readonly capabilityIds: readonly RuntimeFacadeCapabilityId[];
  /** What a Cell author does instead. Present exactly when the verdict is `omitted`. */
  readonly guidance?: string;
  /** The evidence that would be needed to admit it. Present exactly when omitted. */
  readonly blockedBy?: string;
}

export const RUNTIME_FACADE_FAMILIES: readonly RuntimeFacadeFamily[] = [
  {
    id: "cell-props-and-context",
    candidate: "access to confirmed Cell props/context",
    verdict: "admitted",
    rationale:
      "#5 pins both halves of the address: the base `props` key list the runtime always injects, and the member list of the `props.Forguncy` handle. That is enough to give authored source a typed accessor for every confirmed member and no reason to reach into `props` itself. This family also carries the confirmed data-source hook: `useDataSource` is a wrapper-local of the cell scope, and #5 pins its result fields, so the cell's data binding is reachable without a second data layer.",
    evidenceSources: ["cell-props-key-order", "forguncy-prop-facade", "data-source-contract", "user-scope-bindings"],
    capabilityIds: [
      "data-source-binding",
      "permission-snapshot",
      "permission-check",
      "permission-map-read",
      "current-user",
      "session-control",
      "file-upload",
      "upload-limit",
      "cell-method-exposure",
      "forguncy-value-conversions",
      "image-context",
    ],
  },
  {
    id: "server-command-invocation",
    candidate: "server-command invocation wrappers over confirmed `props.ServerCommands` semantics",
    verdict: "admitted",
    rationale:
      "#5 pins this bridge more completely than any other: a record of command name to async function, the reserved result keys, the behaviour of a name that was not configured, and that a command's own named returns are extra keys on the same result. It is the one capability the façade can type end to end, which is why #27 singles it out in its acceptance criteria.",
    evidenceSources: ["server-commands-contract", "cell-props-key-order"],
    capabilityIds: ["server-command-invocation"],
  },
  {
    id: "application-navigation",
    candidate: "page/application navigation through Forguncy APIs rather than React Router",
    verdict: "omitted",
    rationale:
      "#5's confirmed `props.Forguncy` member list contains no navigation member, and no navigation API appears in the observed cell-user scope. In Forguncy, navigation is a command configured on a page (页面跳转) rather than a callable cell API, and #5 did not probe a cell-facing bridge for it. Admitting one here would be exactly the invented API #27 forbids, and inventing it would be worse than omitting it: authored source would depend on a signature nothing has verified.",
    evidenceSources: ["forguncy-prop-facade", "user-scope-bindings"],
    capabilityIds: [],
    guidance:
      "Express navigation as a Forguncy page command on the page or cell, or expose an intent through a cell method and let the page command decide. Do not add React Router or a cell-local history: #4 records application navigation as Forguncy-owned precisely because a cell-local router creates a second history the host cannot observe.",
    blockedBy:
      "A linked product contract that pins a cell-callable navigation API on the observed target, followed by a probe through the same channels #5 used.",
  },
  {
    id: "page-and-cross-cell-state",
    candidate: "page-property or cross-Cell state access only where a stable host API exists",
    verdict: "omitted",
    rationale:
      "#5 observed that all cells on a page share one `globalThis`, and that a Cell's own React root means React Context does not cross cells. Neither observation is a data API: a shared mutable global is a runtime fact, not a stable contract, and #5 pins no host read/write accessor for page or global state. #27 also forbids the façade becoming a cross-Cell state store, so admitting this family on the strength of `globalThis` would implement the non-goal.",
    evidenceSources: ["user-scope-bindings"],
    capabilityIds: [],
    guidance:
      "Keep shared state in Forguncy page state and drive it through page commands. Where a cell must publish something, expose it as a cell method and let Forguncy own the channel between cells.",
    blockedBy:
      "A linked product contract that pins a host accessor for page or cross-cell state, plus the explicit decision in #4's terms that the façade may read it without becoming a store.",
  },
  {
    id: "page-events-and-commands",
    candidate: "page events/commands only where product contracts are confirmed",
    verdict: "omitted",
    rationale:
      "#5 pins no cell-facing subscribe or dispatch API for page events. Commands reach a cell because the designer configured them on that cell, which makes them a property of the page configuration rather than a callable bridge inside the cell source. #5's open question about whether a property change re-executes the cell entry or re-renders the existing tree is unresolved, which by itself is enough to refuse a lifecycle-shaped API that would depend on the answer.",
    evidenceSources: ["cell-props-key-order", "user-scope-bindings"],
    capabilityIds: [],
    guidance:
      "Configure commands on the cell in the designer, and expose cell behaviour as a cell method so a configured command has something to call.",
    blockedBy:
      "A linked product contract that pins a cell-facing event or command API, and a resolution of #5's open `property-change-re-render` question.",
  },
  {
    id: "host-and-global-lookup",
    candidate: "host asset/global lookup helpers required by generated/runtime code",
    verdict: "omitted",
    rationale:
      "This family is required by *generated* code, not by authored application code, and #27's decision scopes the façade to application-owned capabilities. A host global is a dependency-strategy concern (#4's `host`), resolved by the artifact/compiler boundary (#6) and by the sheet of names #5 verified as visible in cell source. Re-exporting those names through the façade would give one value two addresses and would let authored source depend on a resolution the compiler is supposed to own.",
    evidenceSources: ["user-scope-bindings"],
    capabilityIds: [],
    guidance:
      "Import the dependency normally and let the compiler resolve it to a host global, or declare it `extension` when shared module identity is required. Raw global lookup stays a low-level escape hatch outside the façade's public surface, not an authoring pattern.",
    blockedBy:
      "Nothing, unless #4's `host` strategy is itself re-scoped: admitting it would mean changing who owns host resolution, which is #4's decision and not this façade's.",
  },
];

// ---------------------------------------------------------------------------
// The admitted capabilities
// ---------------------------------------------------------------------------

export const RUNTIME_FACADE_CAPABILITY_IDS = [
  "server-command-invocation",
  "data-source-binding",
  "permission-snapshot",
  "permission-check",
  "permission-map-read",
  "current-user",
  "session-control",
  "file-upload",
  "upload-limit",
  "cell-method-exposure",
  "forguncy-value-conversions",
  "image-context",
] as const;

export type RuntimeFacadeCapabilityId = (typeof RUNTIME_FACADE_CAPABILITY_IDS)[number];

export const RUNTIME_FACADE_CAPABILITIES: readonly RuntimeFacadeCapability[] = [
  {
    id: "server-command-invocation",
    family: "server-command-invocation",
    summary: "Invoke a server command the designer made available to this cell, by name.",
    scope: {
      kind: "application",
      concern: "server-commands",
      basis:
        "#4 records server commands and business workflows as Forguncy-owned, and the only confirmed route to them is the `ServerCommands` base prop.",
    },
    confirmation: "call-shape",
    hostBindings: [{ kind: "cell-prop", prop: "ServerCommands" }],
    evidenceSources: ["server-commands-contract", "cell-props-key-order"],
    note: "Only names the designer listed in `availableServerCommands` are present. #5 records a name that was not configured as `undefined` on the record, so calling it is a plain `TypeError` rather than a platform error — the façade's wrapper has to answer for that case instead of passing it through.",
  },
  {
    id: "data-source-binding",
    family: "cell-props-and-context",
    summary: "Read a Forguncy data source the page declared, with the loading and error state the host reports.",
    scope: {
      kind: "application",
      concern: "business-data-source",
      basis:
        "#4 records business data sources as Forguncy-owned so that permissions and server-side rules stay authoritative; the confirmed cell-facing binding is the `useDataSource` wrapper-local.",
    },
    confirmation: "call-shape",
    hostBindings: [{ kind: "cell-hook", hook: "useDataSource" }],
    evidenceSources: ["data-source-contract", "user-scope-bindings"],
    note: "The call was observed, not just the result: #5 executed `useDataSource(\"Sales\", { top: 3 })`, `useDataSource(\"Sales\", { top: 2, offset: 1, orderBySqlParams: [...] })` and `useDataSource(\"NoSuchSource\")`, so the name is the first argument and the options object is optional, with `top`/`offset`/`orderBySqlParams` acting server-side. The option set is what was exercised, not a proven-complete list. A name that was never declared is an error state rather than a thrown exception, so a wrapper must not turn it into one. This is also the only admitted capability whose address is a wrapper-local rather than a prop, which is why `RuntimeFacadeHostBindings` carries a second, dedicated channel for it.",
  },
  {
    id: "permission-snapshot",
    family: "cell-props-and-context",
    summary: "Read the permission snapshot the host resolved before the page rendered.",
    scope: {
      kind: "application",
      concern: "permissions",
      basis:
        "#4 records permissions as host-resolved context a cell must consume rather than recompute; `Permissions` is a base prop key, and #5 records its emptiness as an open question instead of a second meaning.",
    },
    confirmation: "member-presence",
    hostBindings: [{ kind: "cell-prop", prop: "Permissions" }],
    evidenceSources: ["cell-props-key-order", "forguncy-prop-facade"],
    note: "#5 leaves it open whether the snapshot can come back empty for a configured permission, so the façade must not treat an empty snapshot as a decided negative. The handle's `getPermissions()` returns the same map and *was* called, which is why it is not this capability's second address: a value prop and an executed call cannot share one confirmation level, so filing both here recorded the call as a mere name. It is `permission-map-read`.",
  },
  {
    id: "permission-check",
    family: "cell-props-and-context",
    summary: "Ask the host whether the current user holds a permission.",
    scope: {
      kind: "application",
      concern: "permissions",
      basis: "The check is the host's own evaluation, which is what #4 requires a cell to consume rather than reproduce.",
    },
    confirmation: "call-shape",
    hostBindings: [{ kind: "forguncy-member", member: "hasPermission" }],
    evidenceSources: ["forguncy-prop-facade"],
    note: "#5 executed `props.Forguncy.hasPermission(\"ProbePermission\")` and recorded the returned value — `true` for a configured, permitted name — **without** `await`, unlike the `ServerCommands` call recorded beside it, which the same section reports as `await … resolved in 185 ms`. So the call is synchronous and returns a boolean. What stays unpinned is the negative: the probe only ran a granted permission, so `false` for a denied name is what the return type implies rather than a case that was executed.",
  },
  {
    id: "permission-map-read",
    family: "cell-props-and-context",
    summary: "Read every configured permission's boolean through the host handle.",
    scope: {
      kind: "application",
      concern: "permissions",
      basis:
        "The same concern as the snapshot it mirrors: #4 puts the resolved permission set on Forguncy's side, and #5 records the map as one boolean per configured `permissions[].name`.",
    },
    confirmation: "call-shape",
    hostBindings: [{ kind: "forguncy-member", member: "getPermissions" }],
    evidenceSources: ["forguncy-prop-facade"],
    note: "#5 executed `props.Forguncy.getPermissions()` and recorded `{\"ProbePermission\": true}` without `await`, so this is the synchronous map form of `permission-snapshot`. It is filed as its own capability because a confirmation is a property of the call, and this is a different call: the snapshot has no invocation to confirm, so one level could not honestly cover both — the same over-claim `data-source-binding` was corrected for, one address over.",
  },
  {
    id: "current-user",
    family: "cell-props-and-context",
    summary: "Read the signed-in user the host already resolved.",
    scope: {
      kind: "application",
      concern: "permissions",
      basis:
        "The identity a permission snapshot is relative to is host-owned context; #4 puts permissions and auth context on Forguncy's side of the boundary.",
    },
    confirmation: "member-presence",
    hostBindings: [{ kind: "forguncy-member", member: "getCurrentUser" }],
    evidenceSources: ["forguncy-prop-facade"],
  },
  {
    id: "session-control",
    family: "cell-props-and-context",
    summary: "Start or end the session through the host's own sign-in and sign-out.",
    scope: {
      kind: "application",
      concern: "permissions",
      basis:
        "#4 lists auth context as host-provided and #27 lists implementing an auth framework as a non-goal, so the façade may only delegate to the host's session verbs.",
    },
    confirmation: "member-presence",
    hostBindings: [
      { kind: "forguncy-member", member: "logIn" },
      { kind: "forguncy-member", member: "logOut" },
    ],
    evidenceSources: ["forguncy-prop-facade"],
    note: "#5 pins these as members of the handle; it does not pin what they return or whether they resolve their own redirects.",
  },
  {
    id: "file-upload",
    family: "cell-props-and-context",
    summary: "Upload a file through the host rather than posting to a cell-invented endpoint.",
    scope: {
      kind: "application",
      concern: "business-data-source",
      basis:
        "An upload stores data the application owns and that its server-side rules govern, so #4's data-source ownership applies rather than the cell owning a second write path.",
    },
    confirmation: "member-presence",
    hostBindings: [{ kind: "forguncy-member", member: "uploadFiles" }],
    evidenceSources: ["forguncy-prop-facade"],
    note: "`getUploadLimit` is recorded separately because #5 pins neither the unit nor the source of that limit, so it cannot be folded into this capability's contract.",
  },
  {
    id: "upload-limit",
    family: "cell-props-and-context",
    summary: "Read the host's own declared upload limit.",
    scope: {
      kind: "host-helper",
      basis:
        "It reports a host configuration value and neither reads nor mutates application-owned state, so filing it under a #4 concern would claim a boundary it does not sit on.",
    },
    confirmation: "member-presence",
    hostBindings: [{ kind: "forguncy-member", member: "getUploadLimit" }],
    evidenceSources: ["forguncy-prop-facade"],
    note: "#5 pins the member name only; the unit and whether the limit is per file or per request are unconfirmed, so a wrapper must not convert it into a byte count.",
  },
  {
    id: "cell-method-exposure",
    family: "cell-props-and-context",
    summary: "Publish a cell-provided method so a configured Forguncy command can reach it.",
    scope: {
      kind: "unclassified",
      reason:
        "#5 pins `exposeMethod` as a member name and nothing else. Its signature, and which host-side actor may invoke the exposed method, are both unprobed — and either answer decides whether this is cross-cell communication, page lifecycle, or neither. Assigning a concern now would pick one of those answers before it has been observed.",
    },
    confirmation: "member-presence",
    hostBindings: [{ kind: "forguncy-member", member: "exposeMethod" }],
    evidenceSources: ["forguncy-prop-facade"],
  },
  {
    id: "forguncy-value-conversions",
    family: "cell-props-and-context",
    summary: "Use the host's own date and colour conversions instead of a cell-local reimplementation.",
    scope: {
      kind: "host-helper",
      basis:
        "The three conversions are mechanical format transforms over their arguments; they neither read nor mutate application-owned state, and reproducing them in a cell would create a second implementation of a host value for no ownership gain.",
    },
    confirmation: "member-presence",
    hostBindings: [
      { kind: "forguncy-member", member: "ConvertDateToOADate" },
      { kind: "forguncy-member", member: "ConvertOADateToDate" },
      { kind: "forguncy-member", member: "ConvertToCssColor" },
    ],
    evidenceSources: ["forguncy-prop-facade"],
    note: "One capability over three members: splitting them would produce three records whose only difference is a name. The OADate pair is a single round-trip contract and is only safe to expose together.",
  },
  {
    id: "image-context",
    family: "cell-props-and-context",
    summary: "Read the image context the runtime always injects.",
    scope: {
      kind: "unclassified",
      reason:
        "#5 pins `ImageContext` as a base prop key and says nothing about its contents or when it is populated, so the façade can carry the value but cannot describe it.",
    },
    confirmation: "member-presence",
    hostBindings: [{ kind: "cell-prop", prop: "ImageContext" }],
    evidenceSources: ["cell-props-key-order"],
  },
];

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export const RUNTIME_FACADE_CONTRACT_ERROR_CODES = [
  "unknown-capability",
  "unknown-family",
  "unknown-evidence-source",
  "unknown-host-binding",
  "capability-not-admissible",
  "family-not-admissible",
  "boundary-not-admissible",
  "binding-shadows-cell-scope",
  // Raised by the surface audit (#29) rather than by a registry lookup: it means
  // the registered surface and the members the accessor actually returns have
  // drifted apart, which is a contract failure and not a resolution failure.
  "surface-not-exposed",
] as const;

export type RuntimeFacadeContractErrorCode = (typeof RUNTIME_FACADE_CONTRACT_ERROR_CODES)[number];

/** Thrown when a façade claim outruns the evidence recorded for it. */
export class RuntimeFacadeContractError extends Error {
  readonly code: RuntimeFacadeContractErrorCode;

  constructor(code: RuntimeFacadeContractErrorCode, message: string) {
    super(message);
    this.name = "RuntimeFacadeContractError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function findRuntimeFacadeEvidenceSource(
  id: RuntimeFacadeEvidenceSourceId,
): RuntimeFacadeEvidenceSource {
  const source = RUNTIME_FACADE_EVIDENCE_SOURCES[id];
  if (!source) {
    throw new RuntimeFacadeContractError("unknown-evidence-source", `Unknown façade evidence source "${id}".`);
  }
  return source;
}

export function findRuntimeFacadeCapability(id: RuntimeFacadeCapabilityId): RuntimeFacadeCapability {
  const capability = RUNTIME_FACADE_CAPABILITIES.find(candidate => candidate.id === id);
  if (!capability) {
    throw new RuntimeFacadeContractError("unknown-capability", `Unknown façade capability "${id}".`);
  }
  return capability;
}

export function findRuntimeFacadeFamily(id: RuntimeFacadeFamilyId): RuntimeFacadeFamily {
  const family = RUNTIME_FACADE_FAMILIES.find(candidate => candidate.id === id);
  if (!family) {
    throw new RuntimeFacadeContractError("unknown-family", `Unknown façade candidate family "${id}".`);
  }
  return family;
}

/** The capabilities of one family, in registry order. */
export function runtimeFacadeCapabilitiesOfFamily(
  family: RuntimeFacadeFamilyId,
): readonly RuntimeFacadeCapability[] {
  return RUNTIME_FACADE_CAPABILITIES.filter(capability => capability.family === family);
}

export function admittedRuntimeFacadeFamilies(): readonly RuntimeFacadeFamily[] {
  return RUNTIME_FACADE_FAMILIES.filter(family => family.verdict === "admitted");
}

/**
 * The families #27 listed that this contract refuses.
 *
 * Read this list before reporting the façade as complete: every entry is a
 * capability a Cell author will otherwise invent locally, and each one names the
 * evidence that would be needed to admit it.
 */
export function omittedRuntimeFacadeFamilies(): readonly RuntimeFacadeFamily[] {
  return RUNTIME_FACADE_FAMILIES.filter(family => family.verdict === "omitted");
}

/** The evidence channels behind a capability, derived from its `core` records. */
export function runtimeFacadeEvidenceChannels(
  capability: RuntimeFacadeCapability,
): readonly RuntimeEvidenceChannel[] {
  return dedupeEvidenceChannels(
    capability.evidenceSources.flatMap(sourceId => findRuntimeFacadeEvidenceSource(sourceId).evidence),
  );
}

/**
 * The #4 concern a capability exercises, or `undefined` when the contract
 * refuses to claim one.
 *
 * Returning `undefined` rather than a default is the point: a caller that wants
 * a concern has to handle the unclassified case, which is how a façade stays
 * from quietly acquiring an owner it was never granted.
 */
export function runtimeFacadeConcernOf(
  capability: RuntimeFacadeCapability,
): OwnershipConcernId | undefined {
  return capability.scope.kind === "application" ? capability.scope.concern : undefined;
}

export function applicationOwnedRuntimeFacadeCapabilities(): readonly RuntimeFacadeCapability[] {
  return RUNTIME_FACADE_CAPABILITIES.filter(capability => capability.scope.kind === "application");
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** The name a binding addresses, whichever kind it is. */
export function runtimeFacadeBindingName(binding: RuntimeFacadeHostBinding): string {
  switch (binding.kind) {
    case "cell-prop":
      return binding.prop;
    case "forguncy-member":
      return binding.member;
    case "cell-hook":
      return binding.hook;
  }
}

/**
 * True when a binding re-addresses a name that is already visible inside cell
 * source.
 *
 * #5's `CELL_USER_SCOPE_BINDINGS` is the list of names a cell may reference
 * without importing anything. Giving one of them a second address through the
 * façade would not add a capability, only a way for two spellings of the same
 * value to disagree.
 *
 * `cell-hook` is exempt because that is its purpose: the canonical name *is* the
 * confirmed address, and the façade re-exports it rather than renaming it.
 */
export function runtimeFacadeBindingShadowsCellScope(binding: RuntimeFacadeHostBinding): boolean {
  if (binding.kind === "cell-hook") {
    return false;
  }
  return cellUserScopeBinding(runtimeFacadeBindingName(binding)) !== undefined;
}

function assertHostBindingConfirmed(binding: RuntimeFacadeHostBinding, capabilityId: string): void {
  if (binding.kind === "cell-hook") {
    if (cellUserScopeBinding(binding.hook) === undefined) {
      throw new RuntimeFacadeContractError(
        "unknown-host-binding",
        `Façade capability "${capabilityId}" binds cell hook "${binding.hook}", which is not a name #5 verified inside cell source.`,
      );
    }
    return;
  }
  // `cell-prop` and `forguncy-member` are typed by `core`'s literal unions, so a
  // name that #5 never observed cannot reach here through the type system. The
  // guard still runs, because the registry is data and a value can arrive from
  // JavaScript that never saw the types.
  if (binding.kind === "cell-prop" && !CELL_PROPS_BASE_KEYS.includes(binding.prop)) {
    throw new RuntimeFacadeContractError(
      "unknown-host-binding",
      `Façade capability "${capabilityId}" binds cell prop "${binding.prop}", which is not one of the base props #5 verified.`,
    );
  }
  if (binding.kind === "forguncy-member" && !CELL_FORGUNCY_PROP_KEYS.includes(binding.member)) {
    throw new RuntimeFacadeContractError(
      "unknown-host-binding",
      `Façade capability "${capabilityId}" binds Forguncy member "${binding.member}", which is not one #5 verified on the cell handle.`,
    );
  }
}

/**
 * Refuse a capability that claims more than the evidence supports.
 *
 * The four rules are:
 *
 * 1. it has at least one host binding and at least one evidence source, so it is
 *    neither an abstraction with nowhere to delegate nor a claim with no source;
 * 2. every binding addresses something #5 verified, and none of them gives a
 *    name already visible in cell source a second address;
 * 3. an `application` scope names a concern that #4 actually assigned to
 *    Forguncy, and states the sentence that pins it there;
 * 4. `call-shape` may not travel with an `unclassified` scope, because knowing
 *    how to call something is enough to know whose boundary it is on.
 */
export function assertRuntimeFacadeCapabilityAdmissible(capability: RuntimeFacadeCapability): void {
  const id = capability.id;

  if (capability.hostBindings.length === 0) {
    throw new RuntimeFacadeContractError(
      "capability-not-admissible",
      `Façade capability "${id}" has no host binding, so it delegates to nothing.`,
    );
  }
  if (capability.evidenceSources.length === 0) {
    throw new RuntimeFacadeContractError(
      "capability-not-admissible",
      `Façade capability "${id}" cites no evidence source, so its capability is unconfirmed.`,
    );
  }

  for (const binding of capability.hostBindings) {
    // Checked before confirmation on purpose: "this is already a name the cell
    // can see" is a stronger reason to refuse than "this name is unverified",
    // and it is the one a reader is most likely to have got wrong.
    if (runtimeFacadeBindingShadowsCellScope(binding)) {
      throw new RuntimeFacadeContractError(
        "binding-shadows-cell-scope",
        `Façade capability "${id}" binds "${runtimeFacadeBindingName(binding)}", which #5 already makes visible to cell source without an import.`,
      );
    }
    assertHostBindingConfirmed(binding, id);
  }

  if (capability.scope.kind === "application") {
    if (capability.scope.basis.trim().length === 0) {
      throw new RuntimeFacadeContractError(
        "capability-not-admissible",
        `Façade capability "${id}" claims application concern "${capability.scope.concern}" without stating what pins it there.`,
      );
    }
    if (!isApplicationOwned(capability.scope.concern)) {
      throw new RuntimeFacadeContractError(
        "capability-not-admissible",
        `Façade capability "${id}" claims concern "${capability.scope.concern}", which #4 does not assign to Forguncy.`,
      );
    }
  }

  if (capability.scope.kind === "unclassified" && capability.scope.reason.trim().length === 0) {
    throw new RuntimeFacadeContractError(
      "capability-not-admissible",
      `Façade capability "${id}" is unclassified without saying why.`,
    );
  }

  if (capability.scope.kind === "host-helper" && capability.scope.basis.trim().length === 0) {
    throw new RuntimeFacadeContractError(
      "capability-not-admissible",
      `Façade capability "${id}" is filed as a host helper without stating what pins it there.`,
    );
  }

  if (capability.confirmation === "call-shape" && capability.scope.kind === "unclassified") {
    throw new RuntimeFacadeContractError(
      "capability-not-admissible",
      `Façade capability "${id}" has a confirmed call shape but refuses to name a boundary; a pinned call shape is enough to know whose capability it is.`,
    );
  }
}

/** Refuse a family whose verdict and payload disagree. */
export function assertRuntimeFacadeFamilyAdmissible(family: RuntimeFacadeFamily): void {
  const id = family.id;

  if (family.rationale.trim().length === 0) {
    throw new RuntimeFacadeContractError("family-not-admissible", `Façade family "${id}" has no rationale.`);
  }

  if (family.verdict === "admitted") {
    if (family.capabilityIds.length === 0) {
      throw new RuntimeFacadeContractError(
        "family-not-admissible",
        `Façade family "${id}" is admitted but names no capability, so the verdict is unbacked.`,
      );
    }
    if (family.blockedBy !== undefined) {
      throw new RuntimeFacadeContractError(
        "family-not-admissible",
        `Façade family "${id}" is admitted and blocked at the same time.`,
      );
    }
    return;
  }

  if (family.capabilityIds.length > 0) {
    throw new RuntimeFacadeContractError(
      "family-not-admissible",
      `Façade family "${id}" is omitted but still names capabilities.`,
    );
  }
  if (family.blockedBy === undefined || family.blockedBy.trim().length === 0) {
    throw new RuntimeFacadeContractError(
      "family-not-admissible",
      `Façade family "${id}" is omitted without naming the evidence that would admit it.`,
    );
  }
  if (family.guidance === undefined || family.guidance.trim().length === 0) {
    throw new RuntimeFacadeContractError(
      "family-not-admissible",
      `Façade family "${id}" is omitted without telling a Cell author what to do instead.`,
    );
  }
}

/**
 * Check the whole contract at once.
 *
 * Exported as one entry point so a future lint, generator or CI gate can assert
 * the façade surface without re-deriving which checks matter. It also proves the
 * two registries agree: every family's capability ids resolve, and every
 * capability is claimed by exactly one family.
 */
export function assertRuntimeFacadeSurfaceIsConfirmed(): void {
  for (const capability of RUNTIME_FACADE_CAPABILITIES) {
    assertRuntimeFacadeCapabilityAdmissible(capability);
    const family = findRuntimeFacadeFamily(capability.family);
    if (!family.capabilityIds.includes(capability.id)) {
      throw new RuntimeFacadeContractError(
        "capability-not-admissible",
        `Façade capability "${capability.id}" names family "${family.id}", which does not claim it.`,
      );
    }
  }

  for (const family of RUNTIME_FACADE_FAMILIES) {
    assertRuntimeFacadeFamilyAdmissible(family);
    for (const capabilityId of family.capabilityIds) {
      const capability = findRuntimeFacadeCapability(capabilityId);
      if (capability.family !== family.id) {
        throw new RuntimeFacadeContractError(
          "capability-not-admissible",
          `Façade family "${family.id}" claims capability "${capabilityId}", which belongs to "${capability.family}".`,
        );
      }
    }
  }

  const claimed = RUNTIME_FACADE_FAMILIES.flatMap(family => family.capabilityIds);
  if (claimed.length !== RUNTIME_FACADE_CAPABILITIES.length) {
    throw new RuntimeFacadeContractError(
      "capability-not-admissible",
      `The façade registries disagree: ${RUNTIME_FACADE_CAPABILITIES.length} capabilities registered, ${claimed.length} claimed by families.`,
    );
  }
}
