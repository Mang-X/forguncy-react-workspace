/**
 * The host module bridge: which authored import is bound to which host identity,
 * and what the compilation path must generate so that binding holds.
 *
 * Decision source: GitHub Issue #9 — "Spec: host module bridge for React,
 * ReactDOM, antd and built-in globals"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/9).
 *
 * Governing architecture Spec Issues:
 * - #4 — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 *
 * #4 decides that a dependency resolves to exactly one of four strategies and
 * that `host` means "supplied by the Forguncy / ReactCellType host". #5 records
 * which names the host actually installs in a cell. Neither says what a `host`
 * decision *compiles to* for a particular import, and that gap is #9's whole
 * subject: `import React from "react"` has to end up bound to the page's React
 * object, and `import { jsx } from "react/jsx-runtime"` has to end up bound to
 * something that behaves like React's JSX runtime.
 *
 * Two things in this module are deliberately *not* re-derived:
 *
 * - **Which globals exist.** Every mapping names a global and the module reads
 *   that name's record out of #5's user-scope list rather than restating
 *   availability. A mapping for a name #5 never recorded cannot be written here
 *   without the guard below rejecting it, which is what stops this table from
 *   becoming a second, more optimistic copy of the runtime contract.
 * - **What a `host` decision means.** Mappings are read against `core`'s own
 *   strategy records, so `host` here keeps #4's semantics — the module is not
 *   bundled, and the artifact must not contain a second copy of it.
 *
 * The bridge is a **module-resolution** interception, not a source transform.
 * That is #9's fourth and fifth acceptance criteria ("Standard source imports
 * remain unchanged", "Host-global mappings can be configured/extended without
 * hardcoding package-specific AST rewrites") expressed as a property of the
 * mechanism rather than as a promise: the authored source is never an input to
 * anything here, so there is no code path that *could* rewrite it, and the table
 * below is the only place a mapping is declared.
 *
 * Scope note: this module states the mapping decisions, the identity rules, the
 * JSX runtime adapter's contract, the diagnostic vocabulary, and the non-goals.
 * It deliberately does not generate the interposed module source, plan a build,
 * or emit a guard: those are the compiler's projection of this contract (#9's
 * Decision names "the Vite+/Rolldown compilation path"), and they live in
 * `@forguncy-react-workspace/cell-compiler`. It also does not decide *whether* a
 * package should be `host` — that is #4's strategy, applied by #16's selection
 * flow.
 */

import {
  formatGoverningSpecReferenceLine,
  GOVERNING_ARCHITECTURE_DECISIONS,
  HOST_BRIDGE_DECISION,
} from "./governance";
import type { ArchitectureDecisionSource } from "./governance";
import { findPlatformConflictRule } from "./platform-conflicts";
import { cellUserScopeBinding, CELL_PRESET_LIBRARIES } from "./runtime-contract";
import type { CellBindingAvailability, CellUserScopeBinding, RuntimeEvidenceChannel } from "./runtime-contract";

// ---------------------------------------------------------------------------
// The mechanism
// ---------------------------------------------------------------------------

/**
 * Where the bridge attaches.
 *
 * Recorded as data because it is the answer to two acceptance criteria at once,
 * and a reviewer has to be able to check it without reading the compiler:
 * intercepting at module resolution keyed on the specifier means authored source
 * is never parsed or rewritten by the bridge, and it means the set of bridged
 * imports is exactly the set declared in {@link HOST_BRIDGE_MAPPINGS}.
 */
export const HOST_BRIDGE_INTERCEPTION_POINT = "module-resolution";

export const HOST_BRIDGE_MECHANISM = {
  /** What the bundler is asked to intercept. */
  interceptionPoint: HOST_BRIDGE_INTERCEPTION_POINT,
  /** Whether authored source is transformed by the bridge. */
  rewritesAuthoredSource: false,
  /** Whether the bridge parses authored source at all. */
  inspectsAuthoredSource: false,
  /** Interception is keyed on the specifier, exactly as authored. */
  interceptionKey: "specifier",
  /** The interposed module is supplied to the bundler in place of the dependency. */
  suppliedVia: "resolver-and-loader-hook",
  /** Where the mapping table lives. */
  mappingSource: "HOST_BRIDGE_MAPPINGS",
  note:
    "A package-specific AST rewrite (\"if the import is `react`, replace the default binding\") would break both of #9's extension criteria: it puts the package name in code, and it makes the outcome depend on how the source happened to be written. A resolver hook keyed on the specifier has neither property — supporting a new module is a row in the table. What the bridge *does* key on is the authored specifier string, which is why subpath ids are listed explicitly rather than inferred from the package name.",
} as const;

// ---------------------------------------------------------------------------
// Mapping kinds
// ---------------------------------------------------------------------------

/**
 * How a module id is bridged.
 *
 * - `host-global` — the page already holds an object for this module, so the
 *   interposed module is that object or a view of it.
 * - `jsx-runtime-adapter` — no page object has the module's *shape*, so the
 *   interposed module is code the compiler generates. #9 names this case
 *   explicitly ("`react/jsx-runtime` and `react/jsx-dev-runtime` -> explicit
 *   adapter preserving JSX runtime semantics") and it is why the kind exists
 *   rather than being a flag on a global mapping: an adapter has no global, and a
 *   mapping with no global must not be readable as "a global we have not filled
 *   in yet".
 */
export const HOST_BRIDGE_MAPPING_KINDS = ["host-global", "jsx-runtime-adapter"] as const;

export type HostBridgeMappingKind = (typeof HOST_BRIDGE_MAPPING_KINDS)[number];

/**
 * The one identity field a mapping may be checked against.
 *
 * #8's `ForguncyTargetIdentity` records the host React version and nothing else
 * about the host module identities, so `hostReactVersion` is the only field
 * offerable. A mapping whose identity matters but has no field to check it
 * against must say so in `identityRule` instead of naming a field it cannot
 * honour — the resolver's lock audit reached the same conclusion about ReactDOM.
 */
export const HOST_BRIDGE_IDENTITY_FIELDS = ["hostReactVersion"] as const;

export type HostBridgeIdentityField = (typeof HOST_BRIDGE_IDENTITY_FIELDS)[number];

interface HostBridgeMappingBase {
  readonly kind: HostBridgeMappingKind;
  /**
   * The module id the bridge intercepts, exactly as authored.
   *
   * The bare package name for a whole-module mapping; a subpath id for a mapping
   * that only exists as a subpath.
   */
  readonly specifier: string;
  /**
   * Further module ids that resolve to the same host identity.
   *
   * Listed rather than derived: `react-dom/client` is a subpath of a package that
   * has one global, while `react/jsx-runtime` is a subpath whose *shape* differs
   * from its package's — so "a subpath belongs to its package" is not a rule that
   * holds here.
   */
  readonly moduleIds?: readonly string[];
  /**
   * Members of the host object `#5` observed, verbatim.
   *
   * Kept per mapping rather than as one global list because the evidence is
   * per-observation: #5 read `React.version` off the injected object and
   * `ReactDOM.createRoot` off the page global. A name that is not here is *not*
   * thereby absent; it is unobserved, which is why {@link guardedMembers} exists
   * and why an empty list is a legitimate value.
   */
  readonly verifiedMembers: readonly string[];
  /**
   * Members the bridged module needs that #5 did *not* observe on the host.
   *
   * The honest alternative to assuming them. A guarded member is checked when the
   * bridge is installed and produces {@link HostBridgeDiagnostic} code
   * `host-global-incompatible` when it is missing, so an assumption that turns out
   * to be wrong is reported by name rather than surfacing as `undefined`.
   */
  readonly guardedMembers?: readonly string[];
  /** The #5 evidence channels behind this mapping. */
  readonly evidence: readonly RuntimeEvidenceChannel[];
  readonly note?: string;
}

export interface HostBridgeGlobalMapping extends HostBridgeMappingBase {
  readonly kind: "host-global";
  /** The page global the module is bound to, spelled as #5 records it. */
  readonly globalName: string;
  /**
   * The `#8` target-identity field whose recorded value must equal the host's.
   *
   * Absent is a statement, not an omission: it means no recorded field can check
   * this mapping's identity, and `identityRule` has to say what keeps it honest
   * instead.
   */
  readonly identityField?: HostBridgeIdentityField;
  /**
   * Whether a second copy of this module on the page breaks something the first
   * copy owns.
   *
   * Absent means false, matching the lock's convention. The flag is what makes a
   * bundled duplicate an error rather than a style choice: React is the module
   * #5 verified is one object per page whose identity hooks and context dispatch
   * through, so a second copy anywhere is observable from every cell.
   */
  readonly identitySensitive?: boolean;
  /** What keeps this mapping's identity true. Required, even without a field. */
  readonly identityRule: string;
}

export interface HostBridgeAdapterMapping extends HostBridgeMappingBase {
  readonly kind: "jsx-runtime-adapter";
  /** An adapter has no page object to name. */
  readonly globalName?: never;
  readonly adapter: HostBridgeAdapterId;
  /** The host members the adapter's generated code reads. */
  readonly requiredHostMembers: readonly string[];
}

export type HostBridgeMapping = HostBridgeGlobalMapping | HostBridgeAdapterMapping;

export type HostBridgeAdapterId = "jsx-runtime";

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * #9's mapping table.
 *
 * `react`, `react-dom` and `antd` are #9's stated initial candidates. The JSX
 * runtime row is #9's adapter case. `dayjs` and `echarts` are #9's "later
 * built-ins", and they are not here — see {@link HOST_BRIDGE_DEFERRED_MODULES}
 * for why each one is deferred rather than merely absent.
 *
 * What each row is *not*: a permission. A row says the bridge knows how to bind
 * the import if the lock decides the package is `host`. Whether it should be
 * `host` is #4's strategy decision, made by #16's selection flow.
 */
export const HOST_BRIDGE_MAPPINGS: readonly HostBridgeMapping[] = [
  {
    kind: "host-global",
    specifier: "react",
    globalName: "React",
    identityField: "hostReactVersion",
    identitySensitive: true,
    identityRule:
      "#5 measured `React.version === \"19.2.7\"` on the injected object and verified `single-react-instance-per-page`, so the recording `ForguncyTargetIdentity.hostReactVersion` is a real check: the bridge compares the page's `React.version` against it and refuses on a mismatch. The version check is the *second* line of defence; the first is that nothing else in the artifact may carry a React implementation at all.",
    verifiedMembers: ["version", "createElement", "useState", "useEffect", "useMemo", "useRef", "useCallback"],
    evidence: ["product-runtime-source", "generated-runtime-browser"],
    note:
      "#5 records `React` as an injected parameter *and* a window property, and verified the two are the same object, so a bridge that resolves it off `globalThis` binds the same identity the cell's own wrapper parameter holds. The verified members come from the product's runtime source (which reads `React.createElement` and destructures `React.useState`/`useEffect`/`useMemo`/`useRef`/`useCallback`) plus the probe that read `React.version` in a cell.",
  },
  {
    kind: "host-global",
    specifier: "react-dom",
    globalName: "ReactDOM",
    moduleIds: ["react-dom/client"],
    identitySensitive: true,
    identityRule:
      "No recorded field can check this one: #8's `ForguncyTargetIdentity` holds a host React version and no ReactDOM version, so comparing anything here would mean inventing a number to compare against. What keeps it honest is therefore structural — the mapping is identity-sensitive, so a bundled ReactDOM duplicate is a diagnostic, and the surface the subpath may use is limited to the members #5 actually observed.",
    verifiedMembers: ["version", "createRoot"],
    evidence: ["product-runtime-source", "generated-runtime-browser"],
    note:
      "`react-dom/client` rides on this row because the page has one ReactDOM global, and that global is where `createRoot` was observed. The observed surface is deliberately short: `createRoot` and `version` were read off `window.ReactDOM` in a real page, and nothing else was. A subpath consumer therefore gets a *host-compatible* surface — the members #5 established — not the published `react-dom/client` module, whose other exports (`hydrateRoot` among them) are unobserved and must be reported rather than silently resolved to `undefined`.",
  },
  {
    kind: "host-global",
    specifier: "antd",
    globalName: "antd",
    identityRule:
      "No field can check it, and none should: the resolver's lock audit already recorded why — antd's own context does not cross cells (#5's `context-does-not-cross-cells`), so a cell with its own copy shares nothing a second copy could split. What this mapping needs instead is a truthful availability statement, which it gets from #5 rather than from a rule written here.",
    verifiedMembers: [],
    evidence: ["product-runtime-source", "designer-api", "generated-runtime-browser"],
    note:
      "The one mapping whose global is *conditionally* present: #5 records `antd` as available `after-the-declared-preset-resolves`, page-wide once loaded, and captured per cell at its own render instant — the ECharts-preset cell on the probe page saw `antd === undefined` while the AntDesign cell on the same page saw an object. So a bridged `antd` that is absent is a supported state, not a broken page, and the bridge reports it instead of throwing. `verifiedMembers` is empty because #5 established the global's existence (`typeof antd === \"object\"`), never an inventory of its exports.",
  },
  {
    kind: "jsx-runtime-adapter",
    specifier: "react/jsx-runtime",
    moduleIds: ["react/jsx-dev-runtime"],
    adapter: "jsx-runtime",
    requiredHostMembers: ["createElement"],
    guardedMembers: ["Fragment"],
    verifiedMembers: [],
    evidence: ["product-runtime-source", "generated-runtime-browser"],
    note:
      "Neither id appears in #5's user-scope list, and that list is the whole `host` mapping surface — so no page global may claim one, which is exactly what #9 says (\"Do not map `react/jsx-runtime` directly to the React object\"). The adapter delegates to the host React's `createElement`, the same member the product's own runtime source uses; `Fragment` is a *guarded* member because #5 never read it off the host object.",
  },
];

/**
 * Module ids #9 names as future built-ins, and the evidence each one still owes.
 *
 * Recorded rather than omitted because "not mapped yet" and "decided against" are
 * different answers, and #9 gives them different ones: these are its "later
 * built-ins ... only after #5 confirms availability/version semantics". #5
 * confirmed availability for both. The version semantics are what is missing, and
 * they are missing in a way that matters here — see each `reason`.
 */
export interface HostBridgeDeferredModule {
  readonly specifier: string;
  /** The global #5 did record, so the deferral cannot be mistaken for absence. */
  readonly globalName: string;
  /** The #5 statement that made this a deferral rather than an omission. */
  readonly reason: string;
  /** What the mapping would need before it could be added to the table. */
  readonly requires: string;
  /** The preset that installs the global, when one does. */
  readonly preset?: string;
}

export const HOST_BRIDGE_DEFERRED_MODULES: readonly HostBridgeDeferredModule[] = [
  {
    specifier: "dayjs",
    globalName: "dayjs",
    preset: "AntDesign",
    reason:
      "#5 records `dayjs` as an injected parameter available `after-the-declared-preset-resolves`, loaded as a dependency of the AntDesign preset rather than as a preset of its own. Its *version* is unobserved — nothing in #5 pins which dayjs the AntDesign chain ships — so an identity rule for it would have to be written from nothing.",
    requires:
      "A recorded dayjs version (or a decision that no version check is needed because a second copy is harmless), plus a decision about the per-render-instant snapshot: #5 shows two cells on one page observing different values of the same preset global, so a bridge that binds `dayjs` eagerly at artifact scope would bind one cell's snapshot for every cell.",
  },
  {
    specifier: "echarts",
    globalName: "echarts",
    preset: "ECharts",
    reason:
      "#5 records `echarts` as available only when the cell declares the ECharts preset, and as absent otherwise — `typeof echarts === \"undefined\"` in the AntDesign-preset probe cell. That makes its absence a *normal* state for most cells, which is a materially different bridge contract from the one `antd` needs.",
    requires:
      "A recorded echarts version, and an answer to what a bridged `echarts` import means for a cell that did not declare the preset. #9's non-goal \"support application-level libraries that conflict with #4 ownership\" is adjacent but not the same question: this one is about a legitimate library whose availability is a per-cell configuration fact.",
  },
];

// ---------------------------------------------------------------------------
// Reading the table
// ---------------------------------------------------------------------------

/** Every module id a mapping intercepts: its specifier and its declared subpaths. */
export function hostBridgeModuleIds(mapping: HostBridgeMapping): readonly string[] {
  return [mapping.specifier, ...(mapping.moduleIds ?? [])];
}

/** Every module id the bridge intercepts, in table order. */
export function hostBridgeInterceptedModuleIds(
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): readonly string[] {
  return mappings.flatMap(hostBridgeModuleIds);
}

/**
 * The mapping for a module id, by exact id.
 *
 * Exact matching is the point: #9 says a mapping list is the configurable
 * surface, so `react-dom/client` has to be listed to be bridged. A prefix rule
 * would silently bridge `react-router/dom` from a `react-router` row and would
 * make "which imports are intercepted" unanswerable from the table alone.
 */
export function findHostBridgeModuleMapping(
  specifier: string,
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): HostBridgeMapping | undefined {
  return mappings.find(mapping => hostBridgeModuleIds(mapping).includes(specifier));
}

/** Every mapping whose specifier or subpath belongs to `packageName`. */
export function hostBridgeMappingsForPackage(packageName: string): readonly HostBridgeMapping[] {
  return HOST_BRIDGE_MAPPINGS.filter(mapping => packageNameOfModuleId(mapping.specifier) === packageName);
}

/**
 * The npm package a module id belongs to.
 *
 * Only used to answer package-shaped questions (which package's identity is
 * being checked); interception itself never keys on it.
 */
export function packageNameOfModuleId(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? specifier);
}

/** The host-global rows only — the projection the lock's conformance audit reads. */
export function hostBridgeGlobalMappings(
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): readonly HostBridgeGlobalMapping[] {
  return mappings.filter((mapping): mapping is HostBridgeGlobalMapping => mapping.kind === "host-global");
}

/** The adapter rows only. */
export function hostBridgeAdapterMappings(
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): readonly HostBridgeAdapterMapping[] {
  return mappings.filter((mapping): mapping is HostBridgeAdapterMapping => mapping.kind === "jsx-runtime-adapter");
}

/**
 * The `#5` binding a mapping's global resolves to.
 *
 * The single place a mapping's availability comes from. A host-global mapping
 * whose `globalName` has no binding is not a mapping with an unknown state; it is
 * a mapping for a name the host does not install, and the guard refuses it.
 */
export function hostBridgeBindingOf(mapping: HostBridgeGlobalMapping): CellUserScopeBinding | undefined {
  return cellUserScopeBinding(mapping.globalName);
}

/** When the bridged global is present, as #5 records it. */
export function hostBridgeAvailabilityOf(mapping: HostBridgeGlobalMapping): CellBindingAvailability | undefined {
  return hostBridgeBindingOf(mapping)?.availableInCellSource;
}

/**
 * Whether the bridged global is guaranteed present in every cell.
 *
 * `always` only. `after-the-declared-preset-resolves` is *not* a weaker kind of
 * always: #5 measured two cells on one page disagreeing about the same global, so
 * a mapping in that state has a legal absent case and the generated bridge has to
 * behave accordingly.
 */
export function hostBridgeGlobalIsAlwaysAvailable(mapping: HostBridgeGlobalMapping): boolean {
  return hostBridgeAvailabilityOf(mapping) === "always";
}

/** The globals a bridged import may not find on the page, and the preset that gates each. */
export function hostBridgePresetConditionalGlobals(): readonly { globalName: string; preset: string }[] {
  return hostBridgeGlobalMappings()
    .filter(mapping => !hostBridgeGlobalIsAlwaysAvailable(mapping))
    .flatMap(mapping =>
      CELL_PRESET_LIBRARIES.filter(preset => preset.providesGlobals.includes(mapping.globalName)).map(preset => ({
        globalName: mapping.globalName,
        preset: preset.name,
      })),
    );
}

// ---------------------------------------------------------------------------
// Identity rules
// ---------------------------------------------------------------------------

/**
 * Whether a mapping's identity can be checked against the lock.
 *
 * Three answers, because two would collapse a real distinction. `checked` means a
 * recorded field backs the mapping. `self-enforced` means the mapping's identity
 * is what the *duplicate* rule protects — nothing is compared, but a second copy
 * is still a diagnostic. `unbacked` is the state that must not exist: an
 * identity-sensitive mapping with neither a field nor a rule, which would look
 * verified while checking nothing.
 */
export type HostBridgeIdentityBasis = "checked-against-lock" | "self-enforced" | "not-identity-sensitive";

export function hostBridgeIdentityBasis(mapping: HostBridgeGlobalMapping): HostBridgeIdentityBasis {
  if (mapping.identitySensitive !== true) return "not-identity-sensitive";
  return mapping.identityField === undefined ? "self-enforced" : "checked-against-lock";
}

/** The mappings a bundled duplicate would break. */
export function hostBridgeIdentitySensitiveMappings(
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): readonly HostBridgeGlobalMapping[] {
  return hostBridgeGlobalMappings(mappings).filter(mapping => mapping.identitySensitive === true);
}

// ---------------------------------------------------------------------------
// The JSX runtime adapter
// ---------------------------------------------------------------------------

/**
 * The members the generated adapter must export.
 *
 * `jsxs` and `jsxDEV` are not optional extras: the automatic JSX runtime picks
 * between `jsx` and `jsxs` on static-children count, and the dev runtime uses
 * `jsxDEV`, so an adapter missing either one fails only in the build mode or the
 * children shape that selects it.
 */
export const JSX_RUNTIME_ADAPTER_EXPORTS = ["jsx", "jsxs", "jsxDEV", "Fragment"] as const;

export type JsxRuntimeAdapterExport = (typeof JSX_RUNTIME_ADAPTER_EXPORTS)[number];

export const JSX_RUNTIME_ADAPTER_RULE_IDS = [
  "key-is-not-children",
  "no-third-argument-without-a-key",
  "declared-key-wins-over-props-key",
  "children-live-in-props",
  "jsxs-shares-jsx",
  "jsxDEV-ignores-dev-only-arguments",
  "fragment-is-the-host-fragment",
  "evaluation-must-not-throw",
  "adapter-is-not-the-react-object",
] as const;

export type JsxRuntimeAdapterRuleId = (typeof JSX_RUNTIME_ADAPTER_RULE_IDS)[number];

export interface JsxRuntimeAdapterRule {
  readonly id: JsxRuntimeAdapterRuleId;
  /** The rule, stated as the thing the generated code must do. */
  readonly statement: string;
  /** Why violating it is invisible until something actually renders. */
  readonly why: string;
  /** Where the requirement was established, so it is not re-argued from scratch. */
  readonly establishedBy: string;
}

/**
 * The adapter's semantics.
 *
 * These are the "same lessons already verified in `MangMax/forguncy-react-library`"
 * that #9's React identity rules point at: that repository's `pack-tools`
 * host-React plugin carries the two-argument/two-case rule and its
 * `packages/tanstack-charts/tests/jsx-runtime-adapter.mjs` is the regression that
 * found it. What is recorded here is the *contract*, per rule, including the one
 * case that repository could not have: evaluating the bridge before the host
 * global exists.
 *
 * Note what is deliberately absent — any statement that the adapter is
 * equivalent to `React.createElement`. It is not, and the whole rule list exists
 * because treating the two as interchangeable silently loses `key` and
 * overwrites `children`.
 */
export const JSX_RUNTIME_ADAPTER_RULES: readonly JsxRuntimeAdapterRule[] = [
  {
    id: "key-is-not-children",
    statement:
      "The third parameter is the JSX `key`, so it must never be forwarded as the delegate's third argument.",
    why:
      "`jsx(type, props, key)` and `createElement(type, config, children)` agree on their first two parameters and disagree on their third. Passing the key through as the third argument therefore does not fail — it sets `children` to the key and drops the key, so a keyed list renders with the wrong children and React reuses DOM nodes by index.",
    establishedBy:
      "`MangMax/forguncy-react-library` `tooling/pack-tools/src/esbuild-host-react.js` (the two documented traps), with the regression in `packages/tanstack-charts/tests/jsx-runtime-adapter.mjs`.",
  },
  {
    id: "no-third-argument-without-a-key",
    statement:
      "When the key is absent, the delegate is called with exactly two arguments — not with an explicit `undefined` third one.",
    why:
      "An explicit third argument selects the delegate's children branch, which *assigns* `props.children` from it. The element still renders, so the failure is a component that receives `undefined` children while its props looked correct at the call site.",
    establishedBy: "Same adapter and regression as `key-is-not-children`.",
  },
  {
    id: "declared-key-wins-over-props-key",
    statement:
      "A defined third parameter wins over `props.key` and does not remain in the props passed to the delegate.",
    why:
      "The delegate reads the key out of its config argument, so a key the automatic runtime passed separately has to be merged in — and a `key` left in props is a second address for the same value, which is the state where the two can disagree.",
    establishedBy: "Same adapter and regression as `key-is-not-children`.",
  },
  {
    id: "children-live-in-props",
    statement: "`children` comes from `props` and is never synthesised from remaining arguments.",
    why:
      "The automatic runtime has no varargs form: every child is already a value inside `props.children`, including arrays of child elements for a static-children call. Deriving children from arguments would produce a second, differently-shaped children value for calls that pass one.",
    establishedBy:
      "#9's acceptance criterion \"JSX runtime behavior is covered by tests with children and keyed lists\", read against React's own `jsx` signature.",
  },
  {
    id: "jsxs-shares-jsx",
    statement: "`jsxs` is the same implementation as `jsx`.",
    why:
      "The two differ only in static-children metadata that the element factory does not observe; giving them separate implementations creates a second place for the key/children rule to be got wrong.",
    establishedBy: "`MangMax/forguncy-react-library` `tooling/pack-tools/src/esbuild-host-react.js`.",
  },
  {
    id: "jsxDEV-ignores-dev-only-arguments",
    statement:
      "`jsxDEV` accepts and ignores the dev-only arguments (`isStaticChildren`, `source`, `self`), so `react/jsx-dev-runtime` uses the same adapter.",
    why:
      "The dev arguments carry debugging metadata, not element semantics. Ignoring them is what allows one adapter to serve both runtime ids, which #9 asks for by naming both ids in one bullet.",
    establishedBy:
      "`MangMax/forguncy-react-library` (the adapter binds both runtime ids to one source), recorded as a deliberate simplification rather than an unimplemented feature.",
  },
  {
    id: "fragment-is-the-host-fragment",
    statement: "`Fragment` is the host React object's own `Fragment`, not a lookalike.",
    why:
      "A JSX fragment produced by anything other than the host React's own fragment type would not be reconciled as a fragment by the host's reconciler.",
    establishedBy:
      "`MangMax/forguncy-react-library`'s regression asserts `Fragment === React.Fragment`. On Forguncy, #5 did not read `React.Fragment` off the injected object, which is why this mapping lists it under `guardedMembers` and the bridge checks it rather than assuming it.",
  },
  {
    id: "evaluation-must-not-throw",
    statement:
      "Evaluating the adapter module while the host global is absent must not throw; the failure is deferred to first use.",
    why:
      "Module evaluation order is a bundler decision, so an adapter that throws while loading would make the *artifact* fail at a moment the cell source did not choose. Deferring keeps the failure attached to the call that needed the host.",
    establishedBy:
      "`MangMax/forguncy-react-library`'s regression records a check named \"宿主 React 缺失时求值不抛错\" (`packages/tanstack-charts/tests/jsx-runtime-adapter.mjs`).",
  },
  {
    id: "adapter-is-not-the-react-object",
    statement: "The adapter module never exports the React object itself.",
    why:
      "#9 states it directly: `react/jsx-runtime` must not be mapped to the React object, because the two disagree about the third parameter — `React.createElement`'s is children. Mapping the id to React would reintroduce `key-is-not-children` one level down, where the source no longer shows a `jsx(...)` call to inspect.",
    establishedBy: "#9's React identity rules.",
  },
];

/**
 * The cases an adapter implementation has to be tested against.
 *
 * Enumerated so "covered by tests with children and keyed lists" (#9's second
 * acceptance criterion) is a list a reviewer can check off against a test file
 * instead of an adjective. Each entry names the rule it exercises, so a case that
 * disappears takes its rule's coverage with it.
 */
export interface JsxRuntimeAdapterCase {
  readonly id: string;
  /** The call, written the way the automatic JSX runtime emits it. */
  readonly call: string;
  /** What has to hold afterwards. */
  readonly expectation: string;
  readonly covers: readonly JsxRuntimeAdapterRuleId[];
}

export const JSX_RUNTIME_ADAPTER_CASES: readonly JsxRuntimeAdapterCase[] = [
  {
    id: "children-only",
    call: "jsx('div', { children: 'text' })",
    expectation: "`props.children` is the value that was passed, and the element's key is null.",
    covers: ["no-third-argument-without-a-key", "children-live-in-props"],
  },
  {
    id: "explicit-undefined-key",
    call: "jsx('div', { children: 'text' }, undefined)",
    expectation: "Behaves exactly like omitting the key: children survive, key is null.",
    covers: ["no-third-argument-without-a-key"],
  },
  {
    id: "key-without-children",
    call: "jsx(Child, { label: 'a' }, 'k-a')",
    expectation: "The element's key is `k-a` and `props.children` is untouched.",
    covers: ["key-is-not-children"],
  },
  {
    id: "key-with-children",
    call: "jsx('div', { children: ['x', 'y'] }, 'k-div')",
    expectation: "Both the key and the children array survive intact.",
    covers: ["key-is-not-children", "children-live-in-props"],
  },
  {
    id: "keyed-list-via-jsxs",
    call: "jsxs('ul', { children: [jsx(Child, props, 'k-a'), jsx(Child, props, 'k-b')] })",
    expectation: "Every child element carries its own key, and rendering the list produces no unique-key warning.",
    covers: ["jsxs-shares-jsx", "declared-key-wins-over-props-key"],
  },
  {
    id: "dev-runtime-call-shape",
    call: "jsxDEV('div', { children: 'text' }, 'k-dev', false, undefined, undefined)",
    expectation: "Same result as the two-argument `jsx` call with the same key; the dev-only arguments are ignored.",
    covers: ["jsxDEV-ignores-dev-only-arguments"],
  },
  {
    id: "fragment-identity",
    call: "runtime.Fragment === React.Fragment",
    expectation: "The exported fragment is the host object's own.",
    covers: ["fragment-is-the-host-fragment"],
  },
  {
    id: "module-is-not-the-react-object",
    call: "require('react/jsx-runtime') !== globalThis.React",
    expectation:
      "The interposed module exports the adapter's own functions rather than the React object, so a `jsx(...)` call can never reach `createElement` with the key sitting in the children position.",
    covers: ["adapter-is-not-the-react-object"],
  },
  {
    id: "evaluation-without-host-react",
    call: "evaluate the adapter with no `React` on `globalThis`",
    expectation: "Evaluation does not throw; the first call that needs the host reports `host-global-missing`.",
    covers: ["evaluation-must-not-throw"],
  },
];

/**
 * What the adapter deliberately does not do.
 *
 * Kept beside the rules so a proposal to "finish" the adapter has to argue against
 * a stated boundary. Both entries are #9's, not inventions: the dev metadata is
 * explicitly droppable, and the element-creation strategy is the host's.
 */
export const JSX_RUNTIME_ADAPTER_NON_GOALS = [
  "Reproduce the dev runtime's debugging metadata (`source`, `self`, component stacks). The arguments are accepted so a dev build works; producing the metadata would mean reimplementing a React-internal surface.",
  "Reimplement element creation. The adapter builds elements through the host React's own factory, so `$$typeof` and React's private element shape stay the host's business and cannot drift from the host build.",
] as const;

// ---------------------------------------------------------------------------
// The diagnostic vocabulary
// ---------------------------------------------------------------------------

/**
 * The codes the bridge reports under.
 *
 * One vocabulary for two moments, on purpose. The same condition — the page
 * global a mapping needs is not there — is a build-time refusal when the table
 * names a global #5 never recorded, and a runtime failure when a page lacks the
 * global anyway. Giving those two different codes would let an Agent treat a
 * runtime failure as unrelated to the mapping decision that produced it.
 *
 * How this relates to #6's artifact codes: `duplicate-host-mapping` and
 * `missing-extension-mapping` are the *artifact's* vocabulary and stay that way.
 * A bridge diagnostic is about a mapping, not about a produced artifact, so a
 * compiler that reports both is reporting two different findings — "this mapping
 * cannot be honoured" and "this artifact breaks a guarantee" — not two spellings
 * of one.
 */
export const HOST_BRIDGE_DIAGNOSTIC_CODES = [
  "host-mapping-missing",
  "host-global-missing",
  "host-global-incompatible",
  "host-module-duplicated",
  "host-adapter-not-used",
  "host-mapping-conflict",
] as const;

export type HostBridgeDiagnosticCode = (typeof HOST_BRIDGE_DIAGNOSTIC_CODES)[number];

/** When a code can be reported. */
export type HostBridgeDiagnosticMoment = "build" | "runtime" | "both";

/** Which side of the pipeline has to act. Never omitted: a code is not a dead end. */
export type HostBridgeFixOwner = "bridge-mapping" | "dependency-decision" | "host-environment" | "cell-source";

export interface HostBridgeDiagnosticRule {
  readonly code: HostBridgeDiagnosticCode;
  readonly moment: HostBridgeDiagnosticMoment;
  readonly label: string;
  /** One sentence stating the condition, without the offending value. */
  readonly states: string;
  readonly remediation: string;
  readonly fixOwner: HostBridgeFixOwner;
  /**
   * Whether the condition can be repaired by a mapping change.
   *
   * `false` for the ones where no mapping fixes anything — a missing page global
   * and a bundled duplicate are properties of the page and of the artifact, not of
   * the table — so a caller does not go looking for a row to add.
   */
  readonly fixableByMapping: boolean;
}

export const HOST_BRIDGE_DIAGNOSTIC_RULES: Readonly<Record<HostBridgeDiagnosticCode, HostBridgeDiagnosticRule>> = {
  "host-mapping-missing": {
    code: "host-mapping-missing",
    moment: "build",
    label: "No bridge mapping for a module that must be bridged",
    states: "A module id had to be bridged and no row of the mapping table covers it.",
    remediation:
      "Decide the dependency again, or add a mapping row. Which one is right depends on why it was `host`: #4 only allows `host` for a module the platform really provides, so a module with no mapping is usually a module that should be `inline` or `extension` instead. Adding a row is correct only when #5 records a global that supplies the module.",
    fixOwner: "dependency-decision",
    fixableByMapping: true,
  },
  "host-global-missing": {
    code: "host-global-missing",
    moment: "both",
    label: "Bridged host global is not on the page",
    states: "A mapping's global was not present when the bridge needed it.",
    remediation:
      "At build time the global is one #5 never recorded, so the mapping is wrong. At runtime the page lacks a global the Forguncy version under test installs, which means the target is not the pinned one — re-run the contract probe (#5) before trusting any mapping. A preset-gated global is reported, not thrown, because #5 records its absence as a supported per-cell state.",
    fixOwner: "host-environment",
    fixableByMapping: false,
  },
  "host-global-incompatible": {
    code: "host-global-incompatible",
    moment: "both",
    label: "Bridged host global is present but not the recorded identity",
    states: "The global exists but failed the mapping's identity rule.",
    remediation:
      "Compare the recorded `ForguncyTargetIdentity` against what the page actually has. A mismatch means the lock was written against a different Forguncy build, so the decision it carries is no longer evidence for this target; re-probe rather than adjusting the check. A guarded member missing on an otherwise correct host means #5's observed surface is smaller than the module needs.",
    fixOwner: "dependency-decision",
    fixableByMapping: false,
  },
  "host-module-duplicated": {
    code: "host-module-duplicated",
    moment: "build",
    label: "A host-provided module was bundled as well",
    states: "The artifact carries an implementation of a module that is also bridged to a host identity.",
    remediation:
      "Remove the bundled copy. For an identity-sensitive mapping this is not a size decision: #5 verified one React object per page and that hooks and context dispatch through it, so a second copy is observable from every cell on the page.",
    fixOwner: "dependency-decision",
    fixableByMapping: false,
  },
  "host-adapter-not-used": {
    code: "host-adapter-not-used",
    moment: "build",
    label: "A module needing the generated adapter was resolved some other way",
    states: "A module id whose bridge is an adapter was bound to a page global, or to an implementation.",
    remediation:
      "Bind it through the adapter. No page global has the module's shape — that is what makes it an adapter rather than a global mapping — and binding the React object in its place reintroduces the key/children confusion the adapter exists to prevent.",
    fixOwner: "bridge-mapping",
    fixableByMapping: true,
  },
  "host-mapping-conflict": {
    code: "host-mapping-conflict",
    moment: "build",
    label: "Two mappings claim one module id, or one identity serves two modules",
    states: "The mapping table itself is inconsistent.",
    remediation:
      "Make the table name each module id once and each host identity once. Two rows for one specifier make the interception order decide the outcome, and one global serving two module identities means code that is not the same module can pass an identity check.",
    fixOwner: "bridge-mapping",
    fixableByMapping: true,
  },
};

/** True for a code a build can report. */
export function hostBridgeDiagnosticIsBuildTime(code: HostBridgeDiagnosticCode): boolean {
  return HOST_BRIDGE_DIAGNOSTIC_RULES[code].moment !== "runtime";
}

/** True for a code the generated runtime guard can report. */
export function hostBridgeDiagnosticIsRuntime(code: HostBridgeDiagnosticCode): boolean {
  return HOST_BRIDGE_DIAGNOSTIC_RULES[code].moment !== "build";
}

/** Codes shareable between the build and the running page. */
export function sharedHostBridgeDiagnosticCodes(): readonly HostBridgeDiagnosticCode[] {
  return HOST_BRIDGE_DIAGNOSTIC_CODES.filter(code => HOST_BRIDGE_DIAGNOSTIC_RULES[code].moment === "both");
}

// ---------------------------------------------------------------------------
// Non-goals
// ---------------------------------------------------------------------------

export const HOST_BRIDGE_NON_GOALS = [
  "Treat every Forguncy global as automatically safe or stable. #5 records per-global availability and per-cell snapshot behaviour; a name being on `window` says nothing about when it is there, so a mapping without availability evidence is refused rather than defaulted.",
  "Supply an application-level library that conflicts with #4's ownership. The bridge binds module identities; it does not make an ownership conflict resolvable, so a mapping for a package implementing a Forguncy-owned capability is refused.",
  "Decide that a package should be `host`. A mapping says how a `host` decision compiles, never that the decision is correct; #4 owns the strategy and #16 owns the selection flow.",
  "Give a `host` mapping a working `inline` fallback. A bridge that falls back to bundling cannot honour the identity rule — the whole point of the mapping is that there is one implementation on the page.",
] as const;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Thrown by the table guards. Distinct from #6's diagnostic types on purpose. */
export class HostBridgeContractError extends Error {
  readonly code: "mapping-not-admissible";

  constructor(message: string) {
    super(message);
    this.name = "HostBridgeContractError";
    this.code = "mapping-not-admissible";
  }
}

/**
 * Refuse a mapping that cannot be honoured.
 *
 * Runs over the table and would run over a project's additions to it, so the
 * checks are per-mapping. Each one is a way a mapping can *look* complete while
 * describing a binding the host does not provide:
 *
 * 1. an adapter that names a global, or a global mapping that names none;
 * 2. a global no `#5` binding records — the difference between "the host
 *    installs this" and "the package is called this";
 * 3. a global recorded as a `wrapper-local`, which exists only inside the cell's
 *    own render closure and therefore cannot be the identity of a module;
 * 4. a mapping with no evidence channel, which is a claim with no observation
 *    behind it;
 * 5. an identity-sensitive mapping with neither a checkable field nor a rule
 *    saying what keeps it true.
 */
export function assertHostBridgeMappingIsAdmissible(mapping: HostBridgeMapping): void {
  if (mapping.evidence.length === 0) {
    throw new HostBridgeContractError(
      `Host bridge mapping "${mapping.specifier}" carries no evidence channel, so it records a claim no observation stands behind.`,
    );
  }

  if (mapping.kind === "jsx-runtime-adapter") {
    // Read through an `unknown` view rather than the declared property: the type
    // says an adapter has no `globalName`, and this check exists precisely because
    // the type is not what a runtime table is guaranteed to satisfy — a table can
    // be supplied by a project, or read back from JSON.
    const declaredGlobal: unknown = (mapping as { readonly globalName?: unknown }).globalName;
    if (declaredGlobal !== undefined) {
      throw new HostBridgeContractError(
        `Host bridge mapping "${mapping.specifier}" is an adapter and must not name a page global: the reason it is an adapter is that no page object has the module's shape.`,
      );
    }
    if (mapping.requiredHostMembers.length === 0) {
      throw new HostBridgeContractError(
        `Host bridge adapter "${mapping.specifier}" names no host member to delegate to, so it cannot preserve JSX runtime semantics.`,
      );
    }
    return;
  }

  const binding = hostBridgeBindingOf(mapping);
  if (binding === undefined) {
    throw new HostBridgeContractError(
      `Host bridge mapping "${mapping.specifier}" binds to global "${mapping.globalName}", which is not one of the names the runtime contract verified as visible inside a cell.`,
    );
  }

  if (binding.kind === "wrapper-local") {
    throw new HostBridgeContractError(
      `Host bridge mapping "${mapping.specifier}" binds to "${mapping.globalName}", which is a "${binding.kind}": the runtime creates it inside the cell's own render closure, so it cannot be the identity of a module.`,
    );
  }

  if (mapping.identityRule.trim().length === 0) {
    throw new HostBridgeContractError(
      `Host bridge mapping "${mapping.specifier}" states no identity rule, so nothing says what keeps its binding the same module across cells.`,
    );
  }
}

/**
 * Refuse a table in which one module id or one host identity is claimed twice.
 *
 * A cross-row check, which is why it is separate: each row is admissible on its
 * own, and the problem only exists between them.
 */
export function assertHostBridgeMappingsAreUnambiguous(
  mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS,
): void {
  const owners = new Map<string, string>();
  for (const mapping of mappings) {
    for (const moduleId of hostBridgeModuleIds(mapping)) {
      const existing = owners.get(moduleId);
      if (existing !== undefined) {
        throw new HostBridgeContractError(
          `Module id "${moduleId}" is claimed by both "${existing}" and "${mapping.specifier}", so the intercepted behaviour would depend on table order.`,
        );
      }
      owners.set(moduleId, mapping.specifier);
    }
  }
}

/**
 * Refuse a mapping for a package that has no legitimate in-cell role at all.
 *
 * Asked of #4's rule table rather than through a role assessment, and the
 * difference is what makes the check correct rather than merely present: *every*
 * package assessed against an application-owned role comes back as a conflict —
 * including React — because #4's boundary is about the role and not about the
 * package. What makes a package unmappable here is that its rule allows **no**
 * cell-local role (a router, an auth framework), so there is no cell in which the
 * binding could be legitimate.
 *
 * This is #9's second non-goal made checkable: a bridge row for such a package
 * would not resolve the ownership conflict, it would hide one behind a global.
 */
export function assertHostBridgeMappingIsNotAnOwnershipConflict(mapping: HostBridgeMapping): void {
  const packageName = packageNameOfModuleId(mapping.specifier);
  const rule = findPlatformConflictRule(packageName);
  if (rule === undefined || rule.allowedCellLocalRoles.length > 0) return;

  throw new HostBridgeContractError(
    `Host bridge mapping "${mapping.specifier}" would bind a package with no legitimate in-cell role (#4 rule "${rule.id}", concern "${rule.concern}"). A mapping does not resolve an ownership conflict, it hides one behind a global. ${rule.guidance}`,
  );
}

/** Every guard above, over the shipped table. */
export function assertHostBridgeContract(mappings: readonly HostBridgeMapping[] = HOST_BRIDGE_MAPPINGS): void {
  for (const mapping of mappings) {
    assertHostBridgeMappingIsAdmissible(mapping);
    assertHostBridgeMappingIsNotAnOwnershipConflict(mapping);
  }
  assertHostBridgeMappingsAreUnambiguous(mappings);
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Every Spec a change to this table has to cite.
 *
 * The architecture decisions first, then the bridge Spec built on them —
 * the same shape `LOCK_GOVERNING_DECISIONS` uses, and for the same reason: a
 * change here answers to #4's strategy semantics and #5's verified facts as much
 * as to #9. The decision record itself lives in `governance.ts` beside the other
 * Specs, because the dependency resolver cites #9 too and the record is what it
 * cites.
 */
export const HOST_BRIDGE_GOVERNING_DECISIONS: readonly ArchitectureDecisionSource[] = [
  ...GOVERNING_ARCHITECTURE_DECISIONS,
  HOST_BRIDGE_DECISION,
];

export const HOST_BRIDGE_GOVERNING_SPEC_REFERENCE_LINE = formatGoverningSpecReferenceLine(
  HOST_BRIDGE_GOVERNING_DECISIONS,
);
