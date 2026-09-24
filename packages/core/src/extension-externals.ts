/**
 * The `extension` strategy's external mapping: which authored import a verified
 * Forguncy Frontend Extension stands in for, what the compilation path must
 * generate so that import resolves against the extension's page global, and the
 * diagnostics the build and the sync both report under.
 *
 * Decision source: GitHub Issue #12 — "Spec: `extension` dependencies as external
 * modules + `frontendLibraries` metadata"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/12).
 *
 * Governing architecture Spec Issues:
 * - #4 — https://github.com/Mang-X/forguncy-react-workspace/issues/4
 * - #5 — https://github.com/Mang-X/forguncy-react-workspace/issues/5
 *
 * Spec Issues built on them that this module *reads* rather than restates:
 * - #6 "generated ReactCellType artifact and compiler boundary" — the metadata
 *   shape an extension decision contributes to, and the canonical order of it.
 *   https://github.com/Mang-X/forguncy-react-workspace/issues/6
 * - #8 "reproducible dependency decisions and `fgc.lock.json`" — the persisted
 *   record an `extension` decision is written as.
 *   https://github.com/Mang-X/forguncy-react-workspace/issues/8
 *
 * #4 decides that a dependency resolves to exactly one of four strategies and that
 * `extension` means "backed by a verified Forguncy Frontend Extension". #5 records
 * what the runtime does with `frontendLibraries`: a cell's own declared libraries
 * resolve before that cell's entry runs, a loaded global is page-wide, and — the
 * two negative facts this module is built around — neither the page-level load
 * order nor another cell's readiness is guaranteed. Neither Spec says what an
 * `extension` decision *compiles to* for a particular import, and that gap is
 * #12's subject.
 *
 * Three things are deliberately **not** re-derived here:
 *
 * - **What `extension` means.** #4 owns the strategy semantics and #8 owns how the
 *   decision is persisted, so this module reads `libraryId` and `globalName` off
 *   `core`'s own decision type instead of declaring a second record shape.
 * - **What an extension *is*.** `MangMax/forguncy-react-library` is the catalog of
 *   already verified reusable extension packages and `MangMax/forguncy-frontend-library`
 *   owns the workflow for creating one. #12 says explicitly that this repository
 *   "only consumes extension identity/mapping; it does not duplicate packaging
 *   logic", so the catalog is an **input** here, not a table: see
 *   {@link auditExtensionLibraryMetadata}.
 * - **Where the metadata shape comes from.** The fields the audit reads are the
 *   ones `api.app.listFrontendLibraries` returns, spelled as it spells them
 *   (`id`, `name`, `globalName`, `exists`, `typeDefinitionAvailable`) rather than
 *   renamed into this module's vocabulary. #12's rule is that a `libraryId` comes
 *   from that listing or a verified catalog artifact; a shape that renamed the
 *   fields would make "did this come from the listing" unanswerable.
 *
 * Scope note: this module states the mapping decisions, the load-order rules, the
 * metadata audit, the diagnostic vocabulary and the non-goals. It does not
 * generate the interposed module, plan a build, or package an extension. The
 * generated code is the compiler's projection of this contract and lives in
 * `@forguncy-react-workspace/cell-compiler`; packaging an extension is
 * `MangMax/forguncy-frontend-library`'s.
 */

import {
  EXTENSION_EXTERNALS_DECISION,
  formatGoverningSpecReferenceLine,
  GOVERNING_ARCHITECTURE_DECISIONS,
} from "./governance.ts";
import type { ArchitectureDecisionSource } from "./governance.ts";
import { hostBridgeGlobalMappings, hostBridgeModuleIds } from "./host-bridge.ts";
import { CELL_PRESET_LIBRARIES, FRONTEND_LIBRARY_REFERENCE_CONTRACT } from "./runtime-contract.ts";
import type { RuntimeEvidenceChannel } from "./runtime-contract.ts";

// ---------------------------------------------------------------------------
// The mechanism
// ---------------------------------------------------------------------------

/**
 * Where the external mapping attaches.
 *
 * The same answer #9 gave for `host`, for the same two reasons: intercepting at
 * module resolution keyed on the specifier means authored source is never parsed
 * or rewritten (#12: "Compiler external mapping can preserve normal source
 * imports"), and it means the set of mapped imports is exactly the set declared in
 * {@link EXTENSION_EXTERNAL_MAPPINGS}.
 */
export const EXTENSION_EXTERNAL_INTERCEPTION_POINT = "module-resolution";

export const EXTENSION_EXTERNAL_MECHANISM = {
  interceptionPoint: EXTENSION_EXTERNAL_INTERCEPTION_POINT,
  /** Whether authored source is transformed by the mapping. */
  rewritesAuthoredSource: false,
  /** Whether the mapping parses authored source at all. */
  inspectsAuthoredSource: false,
  /** Interception is keyed on the specifier, exactly as authored. */
  interceptionKey: "specifier",
  /** The interposed module is supplied to the bundler in place of the dependency. */
  suppliedVia: "resolver-and-loader-hook",
  /** Where the mapping table lives. */
  mappingSource: "EXTENSION_EXTERNAL_MAPPINGS",
  /**
   * Whether the interposition is accompanied by the `frontendLibraries`
   * reference that makes the global present.
   *
   * `true`, and it is not a detail: #5 records the readiness guarantee as a
   * property of the libraries a **cell declares**, so an interposition without the
   * reference is an artifact that reads a global the page was never told to load.
   * See {@link EXTENSION_LOAD_ORDER_RULES} rule 3.
   */
  declaresLibraryReference: true,
  note:
    "The npm implementation is not bundled into the artifact; the compiled module references the extension's page global instead (#12's Decision). A package-specific AST rewrite would put the package name in code; a resolver hook keyed on the specifier has not got that property — supporting a new package is a row in the table.",
} as const;

// ---------------------------------------------------------------------------
// Extension metadata
// ---------------------------------------------------------------------------

/**
 * Where a mapping's extension identity was verified.
 *
 * Only two sources, because #12 names only two: "`libraryId` must come from
 * `listFrontendLibraries` or a verified catalog artifact, not be guessed from
 * display name". A mapping has to say which of the two it used, which is what makes
 * "this id was inferred from a package name" a state that cannot be written down.
 */
export const EXTENSION_METADATA_SOURCES = ["list-frontend-libraries", "verified-catalog"] as const;

export type ExtensionMetadataSource = (typeof EXTENSION_METADATA_SOURCES)[number];

/**
 * One extension as `api.app.listFrontendLibraries` reports it.
 *
 * Field names are the platform's, not this module's. The three optional fields are
 * optional rather than defaulted because "the listing did not say" and "the listing
 * said no" are different answers, and the audit reports only the second — the same
 * distinction `HOST_BRIDGE_MAPPINGS` draws between an unobserved member and an
 * absent one.
 */
export interface ExtensionLibraryListing {
  /** `listFrontendLibraries[].id` — the stable id. Never a display name or a file name. */
  readonly id: string;
  /**
   * `listFrontendLibraries[].name` — the display name.
   *
   * Carried so that a lookup by display name can be refused *by name*: #12's rule
   * is about this field specifically, and a listing that omitted it would leave the
   * audit unable to say which of the two strings a caller had used.
   */
  readonly name?: string;
  /** `listFrontendLibraries[].globalName` — the page global the bundle publishes. */
  readonly globalName: string;
  /** `listFrontendLibraries[].exists` — whether the runtime bundle file is present. */
  readonly exists?: boolean;
  /** `listFrontendLibraries[].typeDefinitionAvailable` — whether `types.d.ts` is present. */
  readonly typeDefinitionAvailable?: boolean;
}

/**
 * The extension id rules the platform's manifest validation enforces.
 *
 * Recorded here because two of the checks below are about shape and they have to
 * agree with the platform rather than with taste: an id that the
 * `FrontendLibraryPackageService` would refuse can never be a `libraryId`, however
 * plausible it looks.
 */
export const EXTENSION_LIBRARY_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/** Ids the platform reserves for the built-in preset libraries. */
export const EXTENSION_RESERVED_LIBRARY_IDS: readonly string[] = CELL_PRESET_LIBRARIES.map(preset => preset.name);

/**
 * Windows device names the platform refuses as the first segment of an id.
 *
 * Kept because {@link EXTENSION_LIBRARY_ID_PATTERN} cannot express it, and because
 * `con`, `nul` and `aux` are exactly the ids a person types as a placeholder.
 */
export const EXTENSION_RESERVED_LIBRARY_ID_SEGMENTS = [
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
] as const;

/**
 * Page globals an extension may not publish.
 *
 * The platform's manifest validation rejects these, so this is the platform's list
 * rather than this module's opinion. It matters twice over here: a mapping that named
 * one of these would describe an extension the platform would never accept, *and* it is
 * the reason a host-bridged global and an extension global can never collide — `React`,
 * `ReactDOM` and `antd` are all on it. {@link extensionGlobalClaimReason} still asks the
 * host-bridge table separately, because that question has a different answer to give,
 * and the test beside this module asserts the coincidence rather than relying on it.
 */
export const EXTENSION_RESERVED_GLOBAL_NAMES = [
  "$",
  "jQuery",
  "React",
  "ReactDOM",
  "Babel",
  "Forguncy",
  "GC",
  "antd",
  "echarts",
  "dayjs",
  "ForguncyReactHelper",
  "ReactCellTypeAntDesignZhCN",
  "ForguncyAIAssistant",
  "ReactCellTypeCodeEditor",
  "forguncyWebBrowserBridge",
  "MonacoEnvironment",
  "define",
  "require",
] as const;

/** A single JavaScript identifier, which every `globalName` has to be. */
export const EXTENSION_GLOBAL_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** JavaScript reserved words a `globalName` may not be. */
const JAVASCRIPT_RESERVED_WORDS: readonly string[] = [
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
];

export function isExtensionLibraryId(value: string): boolean {
  if (!EXTENSION_LIBRARY_ID_PATTERN.test(value)) return false;
  if (value.endsWith(".")) return false;
  const firstSegment = value.split(".")[0] ?? value;
  if ((EXTENSION_RESERVED_LIBRARY_ID_SEGMENTS as readonly string[]).includes(firstSegment.toUpperCase())) return false;
  return !EXTENSION_RESERVED_LIBRARY_IDS.some(reserved => reserved.toLowerCase() === value.toLowerCase());
}

/**
 * Whether a name could be a global at all, before asking whether it is available.
 *
 * Split from {@link isExtensionGlobalName} because the two answers need different
 * sentences: "`Foo.Bar` is not an identifier" and "`antd` is reserved" are different
 * repairs, and a guard that collapsed them would send a reader looking for a
 * reservation that is not the problem.
 */
function isSingleJavaScriptIdentifier(value: string): boolean {
  if (!EXTENSION_GLOBAL_NAME_PATTERN.test(value)) return false;
  return !JAVASCRIPT_RESERVED_WORDS.includes(value);
}

/**
 * Whether a name is acceptable as an extension global, shape and availability
 * together.
 *
 * The host-bridge table is deliberately *not* consulted here — that question is
 * {@link extensionGlobalClaimReason}'s, which reports *why* — but every host global is
 * on the platform's reserved list, so the two agree today. The test beside this module
 * asserts that rather than assuming it.
 */
export function isExtensionGlobalName(value: string): boolean {
  if (!isSingleJavaScriptIdentifier(value)) return false;
  return !EXTENSION_RESERVED_GLOBAL_NAMES.some(reserved => reserved === value);
}

/**
 * What the guards compare a mapping against beyond the mapping itself.
 *
 * Options rather than module-level state, and threaded through *every* guard below,
 * because "which globals the host bridge already binds" is the one input these checks
 * read from a *second* table. A check that consulted `core`'s shipped host table while
 * its caller compared against a different one would report a clean verdict on a table
 * that really collides — and it would also be the only one of these predicates a test
 * could not exercise, since every shipped host global happens to be on the platform's
 * reserved list already. See the test that asserts that coincidence rather than
 * relying on it.
 */
export interface ExtensionExternalContractOptions {
  /** The page globals #9's host bridge binds. Defaults to `core`'s own table. */
  readonly hostGlobals?: readonly string[];
  /** The module ids #9's host bridge intercepts. Defaults to `core`'s own table. */
  readonly hostModuleIds?: readonly string[];
}

function defaultHostGlobals(): readonly string[] {
  return hostBridgeGlobalMappings().map(mapping => mapping.globalName);
}

function defaultHostModuleIds(): readonly string[] {
  return hostBridgeGlobalMappings().flatMap(hostBridgeModuleIds);
}

/**
 * Every global an extension may not claim, and why.
 *
 * One function rather than two checks at each call site: the platform's reserved
 * list and #9's host-bridge table are two different reasons for the same refusal, and
 * a caller that only asked one of them would accept a mapping the other already rules
 * out.
 */
export function extensionGlobalClaimReason(
  globalName: string,
  options: ExtensionExternalContractOptions = {},
): string | undefined {
  if (EXTENSION_RESERVED_GLOBAL_NAMES.some(reserved => reserved === globalName)) {
    return "the platform's manifest validation reserves this name, so no extension can publish it";
  }

  const hostGlobals = options.hostGlobals ?? defaultHostGlobals();
  if (hostGlobals.includes(globalName)) {
    return `#9's host bridge already binds the page global "${globalName}" to a host-provided module`;
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Load-order independence
// ---------------------------------------------------------------------------

/**
 * The load-order rules the generated module has to satisfy.
 *
 * #12's third acceptance criterion is "No dependency on extension load order is
 * introduced", and a criterion phrased as an absence has to be turned into
 * statements a test can falsify. Each rule below is such a statement, with the
 * recorded fact that makes it necessary.
 *
 * Rules 1 and 2 are what make the requirement structural rather than a promise: the
 * generated module resolves its global while its own body runs — and therefore, in the
 * CommonJS wrapper a bundler emits, no later than the cell's first use of the import —
 * and it reads only that one global. Nothing in the artifact can observe whether one
 * library was loaded before another, because no code path reads a second library's
 * global and none of them runs before the cell's own entry.
 *
 * Rule 3 is the requirement the bundler's own interop imposes, and it is the one that
 * cannot be reasoned about from our side alone: it exists because a namespace import is
 * built by *enumerating* the module, so a module whose property names appear only later
 * produces a namespace that can never gain them.
 *
 * Rule 4 is the one that would otherwise be a silent runtime failure, and rule 5 is the
 * one #12 states in words ("never assume one extension can depend on another extension
 * being loaded first").
 */
export interface ExtensionLoadOrderRule {
  readonly id: string;
  /** The rule, stated as the thing the generated code must do. */
  readonly statement: string;
  /** Why violating it is invisible until a page happens to load things differently. */
  readonly why: string;
  /** Where the requirement was established, so it is not re-argued from scratch. */
  readonly establishedBy: string;
}

/** When the generated module reads its extension global. */
export const EXTENSION_GLOBAL_READ_TIMING = "module-body-evaluation";

/**
 * What a bundler's CommonJS-to-ESM interop does to a module's export surface.
 *
 * Recorded as a fact about the *consumer* rather than about this repository, because it
 * is the constraint the generated module has to be written against and nothing in the
 * repository's own code enforces it. It is also the one thing here that was found by
 * experiment rather than by reading a Spec: the first version of the generated module
 * answered its imports through a lazily-resolving `Proxy` and passed every `node:vm`
 * test, while a namespace import of the same module produced a namespace that could
 * never contain the extension's members.
 *
 * The mechanism, precisely: for `import * as ns from "<cjs module>"` the bundler emits
 * `__toESM(require_module())`, and `__toESM` calls `__copyProps`, which walks
 * `Object.getOwnPropertyNames(module.exports)` and `Object.getOwnPropertyDescriptor` for
 * each name, defining a forwarding getter on the namespace. `__toESM` has **no**
 * `__esModule` short-circuit — the `__esModule` branch only decides whether a `default`
 * entry is added, so a module cannot opt out by declaring itself ESM. Once the namespace
 * exists, a name that was not an own property at that moment can never be added, and the
 * result is not an error: `import { useQuery }` reads `undefined` for the rest of the
 * page's life.
 *
 * `observedIn` names the build that exhibited it, and the compiler's regression suite
 * runs this shape through that same bundler rather than through a hand-written stand-in,
 * so a future interop change fails a test instead of silently breaking cells.
 */
export const EXTENSION_EXTERNAL_INTEROP_BEHAVIOUR = {
  id: "namespace-is-built-by-enumeration",
  statement:
    "When a consumer imports a CommonJS module as an ESM namespace, the bundler builds that namespace by enumerating the module's own enumerable properties once, and forwards each name through a getter. A name that is not an own property at that moment never appears in the namespace.",
  forcedBy:
    "The bundler's CommonJS-to-ESM interop helper (`__toESM` → `__copyProps`), not by this contract. `__esModule` does not opt a module out of it.",
  consequence:
    "A generated extension module must expose the page object's own member names while its own body runs. A module with a dynamic export surface — one whose names are knowable only after the global exists — yields a namespace that can never gain them, and it fails silently: an authored `import { useQuery }` reads `undefined` rather than throwing.",
  observedIn:
    "rolldown 1.2.9, the version installed through `vite-plus@0.3.2` in this repository; exercised by the interop regression in `@forguncy-react-workspace/cell-compiler`'s test suite.",
} as const;

export const EXTENSION_LOAD_ORDER_RULES: readonly ExtensionLoadOrderRule[] = [
  {
    id: "global-read-when-the-module-body-runs",
    statement: `The generated module resolves its extension global at ${EXTENSION_GLOBAL_READ_TIMING}, and throws with \`extension-global-missing\` if it is absent.`,
    why:
      "This is the direction that is safe to depend on, and the opposite of what a first reading suggests. Deferring the read to first member access looks more conservative, but a bundler emits the interop that consumes this module before any member is accessed — see rule 3 — so a deferred read does not avoid the dependency; it only moves the failure to a place where nothing can report it. Reading here gives one failure mode, at one named moment.",
    establishedBy:
      "#5's `FRONTEND_LIBRARY_RUNTIME_SEMANTICS.perCellReadinessAwaited` (a cell's own declared libraries resolve before that cell's entry runs), plus rule 4 below, which is what makes every mapped library a declared one.",
  },
  {
    id: "export-surface-is-the-page-objects",
    statement:
      "The module's own enumerable properties are the page object's, so a consumer's namespace import sees the extension's real member names.",
    why:
      "A namespace import is built by enumerating this module once, and the resulting namespace can never gain a name afterwards — see the behaviour record above. A module with a dynamic export surface therefore answers a correct authored import with `undefined`, silently, for the rest of the page's life. Exporting the page object itself is also the only shape that preserves member identity across cells.",
    establishedBy:
      "The bundler's `__toESM`/`__copyProps` enumeration, reproduced end to end in `cell-compiler`'s regression rather than inferred from the helper's source.",
  },
  {
    id: "one-global-per-mapping",
    statement: "A mapping's generated module reads exactly the one global the mapping names, and no other extension's.",
    why:
      "One read target per mapping is what removes the inter-extension order from the artifact entirely: two mappings cannot require that one library was loaded before the other, because neither code path can observe the other's global.",
    establishedBy:
      "#12's \"never assume one extension can depend on another extension being loaded first\", read as a property of the generated code rather than as advice.",
  },
  {
    id: "declaration-is-what-makes-it-ready",
    statement:
      "Every extension a cell reads must appear as a `libraryId` in that cell's `frontendLibraries`, because readiness is a guarantee about declared libraries only.",
    why:
      "#5 records `crossCellReadinessGuaranteed: false`: a cell can render while another cell's libraries are still in flight, so a library this cell did not declare is not guaranteed present even though it becomes page-wide once loaded. An interposition without its reference is therefore an import resolved against a global nothing has promised to load — and since rule 1 relies on that promise, an undeclared mapping converts a loud build-time finding into a runtime throw.",
    establishedBy:
      "#5's `FRONTEND_LIBRARY_RUNTIME_SEMANTICS` (`perCellReadinessAwaited: true`, `crossCellReadinessGuaranteed: false`, `globalsArePageWide: true`).",
  },
  {
    id: "no-ordering-between-extensions",
    statement:
      "Nothing in the plan, the artifact metadata or the generated code expresses a dependency between two extensions.",
    why:
      "`frontendLibraries` is a set of references, not a sequence, and #6 pins its persisted order to a canonical sort precisely so that a diff shows the set rather than one machine's load order. An ordering requirement smuggled into the artifact would be invisible in that diff and would depend on a guarantee #5 does not make.",
    establishedBy:
      "#12's deterministic-ordering requirement plus #6's canonical `frontendLibraries` order; #5's `loadOrderGuaranteed: false`.",
  },
];

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * One verified mapping: this npm import is provided by this extension.
 *
 * Keyed by package rather than by extension, because that is the direction the
 * question is asked in — a cell writes `import … from "@tanstack/react-query"` and
 * the compiler has to answer which extension global stands in for it. Sharing is
 * therefore expressed as {@link moduleIds}: a second module id resolving to the same
 * extension identity, which #12 allows ("one extension can stand in for more than
 * one package") and #6's canonical `frontendLibraries` collapses back into one
 * reference.
 */
export interface ExtensionExternalMapping {
  /** The npm package the mapping is keyed by, exactly as authored. */
  readonly packageName: string;
  /**
   * Further module ids that resolve to the same extension identity.
   *
   * Listed rather than derived. `@tanstack/query-core` is a package of its own
   * whose implementation is inside the same extension bundle, while
   * `@tanstack/react-query/persist` would be a subpath the extension does *not*
   * provide — so "a module id belongs to the package it is named after" is not a
   * rule that holds here, and every id the mapping covers is written down.
   */
  readonly moduleIds?: readonly string[];
  /** The stable id from `api.app.listFrontendLibraries`, never a display name. */
  readonly libraryId: string;
  /** The page global the extension publishes, as its manifest declares it. */
  readonly globalName: string;
  /** Which of #12's two sources this identity was verified against. */
  readonly metadataSource: ExtensionMetadataSource;
  /**
   * The catalog or listing the verification came from.
   *
   * Required, because it is the answer to "not be guessed from display name": a
   * mapping whose provenance cannot be named has no business being in a table that
   * the compiler compiles against.
   */
  readonly metadataReference: string;
  /**
   * What makes it true that this extension provides this package.
   *
   * Deliberately not called `identityRule`, which #9 uses for "what keeps this
   * binding the same module across cells". An extension mapping's identity claim is
   * carried by the *page global* rather than checked against a lock field — #8's
   * `ForguncyTargetIdentity` records the host React version and no extension
   * version — so what this field has to state is the provenance of the claim
   * instead.
   */
  readonly verificationRule: string;
  /** The #5 evidence channels behind the mapping. */
  readonly verifiedBy: readonly RuntimeEvidenceChannel[];
  /** What a reader of the table would otherwise have to reconstruct. */
  readonly note: string;
}

/**
 * #12's mapping table.
 *
 * One row, and that is the honest size of it: #12 names the existing TanStack Query
 * extension as its canonical case, and this repository has verified no other
 * extension identity. A row is *not* a recommendation — it says the compiler knows
 * how to bind this import if the lock decides the package is `extension`; whether
 * it should be is #4's strategy, applied by #16's selection flow.
 *
 * Read what a missing row means before adding one: **this table is the mapping this
 * repository consumes, not a catalog of extensions**. An extension that exists in
 * `MangMax/forguncy-react-library` and has no row here is not thereby
 * unverifiable — it is simply not declared as a compilation mapping yet, which is
 * why {@link auditExtensionLibraryMetadata} takes a caller's listing as an input.
 */
export const EXTENSION_EXTERNAL_MAPPINGS: readonly ExtensionExternalMapping[] = [
  {
    packageName: "@tanstack/react-query",
    moduleIds: ["@tanstack/query-core"],
    libraryId: "tanstack-query",
    globalName: "TanStackQuery",
    metadataSource: "verified-catalog",
    metadataReference: "MangMax/forguncy-react-library",
    verificationRule:
      "The extension is a verified catalog entry of `MangMax/forguncy-react-library`, and its package indexes the vendor modules it contains — `@tanstack/react-query`, which re-exports `@tanstack/query-core` — behind one global. The `libraryId` and `globalName` are confirmed against `api.app.listFrontendLibraries` before this mapping is used against a real project: `verifiedBy` records what established the row, and `auditExtensionLibraryMetadata` records what a real listing has to agree with.",
    verifiedBy: ["product-documentation", "designer-api"],
    note:
      "The canonical test case #12 names. `@tanstack/query-core` rides on this row because the vendor package re-exports it (`export * from \"@tanstack/query-core\"`), so the extension's global carries query-core's exports too — which is #12's \"one extension stands in for more than one package\", not two mappings that happen to agree. Two known failure modes are answered by other parts of this contract rather than by a member list: the extension calls `React.createContext` while its own bundle evaluates, so a missing host React fails inside the extension (an `extension` decision cannot repair that — it is #9's host mapping), and a cell whose library never loaded meets `extension-global-missing` when the interposed module runs, by name, rather than `undefined` at each use.",
  },
];

// ---------------------------------------------------------------------------
// Reading the table
// ---------------------------------------------------------------------------

/** Every module id a mapping intercepts: its package and its declared extras. */
export function extensionModuleIds(mapping: ExtensionExternalMapping): readonly string[] {
  return [mapping.packageName, ...(mapping.moduleIds ?? [])];
}

/** Every module id the table intercepts, in table order. */
export function extensionInterceptedModuleIds(
  mappings: readonly ExtensionExternalMapping[] = EXTENSION_EXTERNAL_MAPPINGS,
): readonly string[] {
  return mappings.flatMap(extensionModuleIds);
}

/**
 * The mapping for a module id, by exact id.
 *
 * Exact for the reason #9's lookup is exact: the table is the configurable surface,
 * so a module id has to be listed to be intercepted. A prefix rule would silently
 * bridge `@tanstack/react-query/persist` from the `@tanstack/react-query` row and
 * would make "which imports are intercepted" unanswerable from the table alone.
 */
export function findExtensionExternalMapping(
  specifier: string,
  mappings: readonly ExtensionExternalMapping[] = EXTENSION_EXTERNAL_MAPPINGS,
): ExtensionExternalMapping | undefined {
  return mappings.find(mapping => extensionModuleIds(mapping).includes(specifier));
}

/**
 * The mapping that covers a *package*, widening over the ids a row declares.
 *
 * The lookup a decision uses: a decision names a package, and a package the table
 * lists as one of a row's `moduleIds` is covered by that row rather than by a row of
 * its own.
 */
export function extensionMappingForPackage(
  packageName: string,
  mappings: readonly ExtensionExternalMapping[] = EXTENSION_EXTERNAL_MAPPINGS,
): ExtensionExternalMapping | undefined {
  return mappings.find(mapping => extensionModuleIds(mapping).includes(packageName));
}

/** Every row that names `libraryId`. More than one means one library, several packages. */
export function extensionMappingsForLibrary(
  libraryId: string,
  mappings: readonly ExtensionExternalMapping[] = EXTENSION_EXTERNAL_MAPPINGS,
): readonly ExtensionExternalMapping[] {
  return mappings.filter(mapping => mapping.libraryId === libraryId);
}

/** Every global the table would have the artifact read. */
export function extensionMappingGlobals(
  mappings: readonly ExtensionExternalMapping[] = EXTENSION_EXTERNAL_MAPPINGS,
): readonly string[] {
  return mappings.map(mapping => mapping.globalName);
}

/**
 * How a mapping's extension identity is backed.
 *
 * Two answers, not one, because #12 names two sources and only one of them is the
 * platform: `catalog-declared` means a verified catalog artifact stands behind the
 * row, `listing-confirmed` means the platform's own `listFrontendLibraries` did.
 * Neither is a weaker form of the other — a catalog row still has to be confirmed
 * against a real listing before an artifact is shipped against it, which is what
 * {@link auditExtensionLibraryMetadata} exists to do.
 */
export type ExtensionVerificationBasis = "catalog-declared" | "listing-confirmed";

export function extensionVerificationBasis(mapping: ExtensionExternalMapping): ExtensionVerificationBasis {
  return mapping.metadataSource === "list-frontend-libraries" ? "listing-confirmed" : "catalog-declared";
}

/** The `FrontendLibraryReference` field a mapping's `libraryId` is written into. */
export const EXTENSION_LIBRARY_REFERENCE_FIELD_NAME = FRONTEND_LIBRARY_REFERENCE_CONTRACT.fieldName;

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * The codes the mapping and the generated module report under.
 *
 * One vocabulary for three moments, on purpose. The same condition — "this
 * extension's identity was never verified" — is a sync-time refusal when a listing
 * was supplied and cannot confirm the id, and a build-time refusal when the
 * artifact was planned against a row nobody confirmed. Giving those two different
 * codes would let an Agent treat a build failure as unrelated to the verification
 * step that should have prevented it.
 *
 * How this relates to #6's artifact codes: `missing-extension-mapping` belongs to
 * the *artifact's* vocabulary and stays there. A code here is about a **mapping** or
 * an **extension identity**, not about a produced artifact, so a compiler reporting
 * both is reporting two different findings — "this mapping is not verifiable" and
 * "this artifact breaks a guarantee" — never two spellings of one.
 *
 * The one thing #12 requires and this list deliberately has no code for is a
 * load-order violation. There is nothing to report it *from*: the generated module is a
 * pure function of one mapping, it reads exactly that mapping's `globalName` while its
 * body runs, and it exports the page object as it is, so a violating artifact cannot be
 * produced by this contract in the first place — the invariant is enforced by the shape
 * of the generated code and asserted by tests on that code (including through the
 * bundler's own interop), not by a checker that would have nothing to check. A code here
 * would be one no caller could ever receive.
 */
export const EXTENSION_EXTERNAL_DIAGNOSTIC_CODES = [
  "extension-mapping-missing",
  "extension-library-unverified",
  "extension-global-mismatch",
  "extension-not-declared",
  "extension-mapping-conflict",
  "extension-bundle-missing",
  "extension-types-missing",
  "extension-global-missing",
] as const;

export type ExtensionExternalDiagnosticCode = (typeof EXTENSION_EXTERNAL_DIAGNOSTIC_CODES)[number];

/**
 * When a code can be reported.
 *
 * `sync` is a moment of its own rather than a flavour of `build`: #12 puts the
 * existence and type-definition checks at the point where a decision is synced to a
 * real project, and a compiler has no listing to check them against.
 */
export const EXTENSION_EXTERNAL_DIAGNOSTIC_MOMENTS = ["build", "sync", "runtime"] as const;

export type ExtensionExternalDiagnosticMoment = (typeof EXTENSION_EXTERNAL_DIAGNOSTIC_MOMENTS)[number];

/** Which side of the pipeline has to act. Never omitted: a code is not a dead end. */
export type ExtensionExternalFixOwner =
  | "dependency-decision"
  | "extension-mapping"
  | "extension-metadata"
  | "extension-package";

export interface ExtensionExternalDiagnosticRule {
  readonly code: ExtensionExternalDiagnosticCode;
  readonly moments: readonly ExtensionExternalDiagnosticMoment[];
  readonly label: string;
  /** One sentence stating the condition, without the offending value. */
  readonly states: string;
  readonly remediation: string;
  readonly fixOwner: ExtensionExternalFixOwner;
  /**
   * Whether the condition can be repaired by editing the mapping table.
   *
   * `false` where no table edit fixes anything — an id the platform does not know
   * and a global that is not on the page are properties of the project and of the
   * extension package, not of the table — so a caller does not go looking for a row
   * to add.
   */
  readonly fixableByMapping: boolean;
}

export const EXTENSION_EXTERNAL_DIAGNOSTIC_RULES: Readonly<
  Record<ExtensionExternalDiagnosticCode, ExtensionExternalDiagnosticRule>
> = {
  "extension-mapping-missing": {
    code: "extension-mapping-missing",
    moments: ["build"],
    label: "No external mapping for a package decided `extension`",
    states: "A package is decided `extension` and the mapping table does not intercept it.",
    remediation:
      "Either decide the package as `inline`/`host`/`replace`, or add a row for a genuinely verified extension. Which one is right depends on why `extension` was chosen: #12 only allows it for shared identity, a shared singleton, measured size economics, or a deliberate project standard, so a package with no verified extension is usually a package that should be `inline`. Adding a row is correct only when a verified catalog or listing really provides that package.",
    fixOwner: "dependency-decision",
    fixableByMapping: true,
  },
  "extension-library-unverified": {
    code: "extension-library-unverified",
    moments: ["build", "sync"],
    label: "Extension identity was never verified",
    states:
      "A mapping's `libraryId` is not one the supplied extension metadata reports, or no metadata was supplied to check it against.",
    remediation:
      "Call `api.app.listFrontendLibraries` and check the id against the returned listing, or against a verified catalog artifact. Do not settle this by writing the id down: #12 refuses an id inferred from a display name or a file name, and the two differ often enough that an inferred id is a distinct failure rather than a typo.",
    fixOwner: "extension-metadata",
    fixableByMapping: false,
  },
  "extension-global-mismatch": {
    code: "extension-global-mismatch",
    moments: ["build", "sync"],
    label: "Extension metadata publishes a different global",
    states: "The global the mapping or decision names is not the one the extension's metadata publishes.",
    remediation:
      "Use the global the extension's manifest declares. A compiled artifact that reads the wrong name meets `undefined` at once and fails wherever the member is first touched — and only a real page shows which of the two names the extension actually creates, so re-read the manifest or the listing rather than adjusting the mapping to match the code.",
    fixOwner: "extension-metadata",
    fixableByMapping: false,
  },
  "extension-not-declared": {
    code: "extension-not-declared",
    moments: ["build"],
    label: "An extension-backed import is not declared by this cell",
    states:
      "The artifact resolves an import through an extension mapping without a `libraryId` in the artifact's `frontendLibraries` metadata.",
    remediation:
      "Record an `extension` decision for the package so the library reference is generated, or import the package some other way. #5 records readiness as a guarantee about the libraries a *cell declares*, and does not guarantee another cell's library is loaded, so an undeclared reference is an import resolved against a global nothing has promised to load.",
    fixOwner: "dependency-decision",
    fixableByMapping: false,
  },
  "extension-mapping-conflict": {
    code: "extension-mapping-conflict",
    moments: ["build"],
    label: "Two declarations claim one extension identity",
    states:
      "The mapping table, or a mapping and the decision that selected it, disagree about which package, library or global belongs together.",
    remediation:
      "Make the table name each module id once, each library once and each global once, and make a decision say what the row it selects says. Two rows for one module id make the interception order decide the outcome; one library under two globals, or one global for two libraries, is a claim the platform's own validation refuses, so a lock carrying it is not a decision the compiler can honour.",
    fixOwner: "extension-mapping",
    fixableByMapping: true,
  },
  "extension-bundle-missing": {
    code: "extension-bundle-missing",
    moments: ["sync"],
    label: "The extension's runtime bundle is not present",
    states: "The extension listing says the library has no runtime bundle file, so the global will never be created.",
    remediation:
      "Re-upload the extension package and regenerate the project (`uploadFrontendLibrary` reports `requiresRegenerate` when the generated resources have to move). The metadata can be perfectly correct while the bundle the page actually loads is missing, which is why this is checked separately from the id.",
    fixOwner: "extension-package",
    fixableByMapping: false,
  },
  "extension-types-missing": {
    code: "extension-types-missing",
    moments: ["sync"],
    label: "The extension ships no type definitions",
    states: "The extension listing says the library has no `types.d.ts`.",
    remediation:
      "Re-upload the package with its type definitions. The artifact's behaviour does not depend on them, but the authoring experience does: without them the designer cannot complete the global's members, and an Agent then guesses member names — which is the state #12's validation rules exist to avoid.",
    fixOwner: "extension-package",
    fixableByMapping: false,
  },
  "extension-global-missing": {
    code: "extension-global-missing",
    moments: ["runtime"],
    label: "The extension global is not on the page",
    states: "A generated module needed its extension global and the page did not have it.",
    remediation:
      "Check the cell's `frontendLibraries` reference and the page's console. A library that failed to load renders its error message inside the cell, so an absent global with no console error means the reference is missing rather than the load failed. This is a runtime finding on purpose: no local check can establish that an extension a designer uploaded is present on a page, so the generated code reports it by name instead of leaving `undefined` at the call site.",
    fixOwner: "extension-metadata",
    fixableByMapping: false,
  },
};

export interface ExtensionExternalDiagnostic {
  readonly code: ExtensionExternalDiagnosticCode;
  /** What the diagnostic is about: a package, a module id, a library id or a global. */
  readonly subject: string;
  readonly detail: string;
}

export function createExtensionExternalDiagnostic(
  code: ExtensionExternalDiagnosticCode,
  subject: string,
  detail: string,
): ExtensionExternalDiagnostic {
  return { code, subject, detail };
}

/** The rule behind a diagnostic, so a report can print guidance without the code. */
export function extensionExternalDiagnosticRule(
  code: ExtensionExternalDiagnosticCode,
): ExtensionExternalDiagnosticRule {
  return EXTENSION_EXTERNAL_DIAGNOSTIC_RULES[code];
}

export function extensionExternalDiagnosticCanBeReported(
  code: ExtensionExternalDiagnosticCode,
  moment: ExtensionExternalDiagnosticMoment,
): boolean {
  return EXTENSION_EXTERNAL_DIAGNOSTIC_RULES[code].moments.includes(moment);
}

/** One line per diagnostic, including what to do about it. */
export function formatExtensionExternalDiagnostic(diagnostic: ExtensionExternalDiagnostic): string {
  const rule = EXTENSION_EXTERNAL_DIAGNOSTIC_RULES[diagnostic.code];
  return `${diagnostic.subject}: [${diagnostic.code}] ${rule.label} — ${diagnostic.detail} (fix owner: ${rule.fixOwner})`;
}

export function formatExtensionExternalDiagnostics(
  diagnostics: readonly ExtensionExternalDiagnostic[],
): string {
  return diagnostics.map(formatExtensionExternalDiagnostic).join("\n");
}

// ---------------------------------------------------------------------------
// The metadata audit
// ---------------------------------------------------------------------------

export interface AuditExtensionLibraryMetadataOptions {
  /**
   * The mappings to check, and the reason this is a required field rather than a
   * defaulted one.
   *
   * The table is this repository's mapping surface; a *listing* is one project's
   * designer state, and a project is not required to have installed every extension the
   * table knows about. Defaulting to the whole table would therefore report a finding
   * for every row the project legitimately does not use — a diagnostic about something
   * the artifact never touches, which is the one shape of false positive that makes a
   * checker untrustworthy. Requiring the caller to say which mappings it depends on
   * puts that answer where it is known: the plan passes the rows its artifact uses, and
   * a sync passes the rows its lock records.
   */
  readonly mappings: readonly ExtensionExternalMapping[];
}

/**
 * Checks mappings against the extension metadata a real project reports.
 *
 * This is #12's validation-rule list as code, and it is an **input-driven** audit
 * rather than a table: the list arrives from `api.app.listFrontendLibraries` or from a
 * verified catalog artifact, and the audit states which of those disagree with the
 * mapping. That is also why it returns findings rather than throwing — a listing
 * reflects a designer state that can change without this repository changing.
 *
 * Four questions, each a way a mapping and reality can differ:
 *
 * - is the mapping's `libraryId` a library the listing knows at all
 *   (`extension-library-unverified`)?
 * - is the global the listing publishes the one the mapping names
 *   (`extension-global-mismatch`)?
 * - is the library's runtime bundle actually there (`extension-bundle-missing`)?
 * - are its type definitions there (`extension-types-missing`)?
 *
 * A listing that does not mention whether a bundle exists is left alone, because "not
 * stated" and "stated absent" are different answers; #12 puts both of the last two at
 * the sync boundary, where the designer can still answer them.
 */
export function auditExtensionLibraryMetadata(
  listings: readonly ExtensionLibraryListing[],
  options: AuditExtensionLibraryMetadataOptions,
): readonly ExtensionExternalDiagnostic[] {
  const diagnostics: ExtensionExternalDiagnostic[] = [];

  for (const mapping of options.mappings) {
    // The stable-id lookup wins, and the display-name check is only ever a *better
    // message* for its absence. Asking the display-name question first would let an
    // unrelated library whose display name happens to equal this mapping's id turn a
    // perfectly verified mapping into a finding — a false positive produced by an
    // accident of another library's name, which is the worst kind: nothing in this
    // mapping is wrong and nothing in the listing is wrong either.
    const listing = listings.find(candidate => candidate.id === mapping.libraryId);
    if (listing === undefined) {
      // #12's "never guessed from display name", asked as a question about the listing
      // rather than about the mapping: an id that matches an entry's *name* is the
      // exact mistake the rule names, and it is worth saying so instead of reporting a
      // generic miss.
      const byDisplayName = listings.find(
        candidate => candidate.name !== undefined && candidate.name === mapping.libraryId,
      );
      if (byDisplayName !== undefined) {
        diagnostics.push(
          createExtensionExternalDiagnostic(
            "extension-library-unverified",
            mapping.packageName,
            `"${mapping.libraryId}" is the display name of the library whose stable id is "${byDisplayName.id}". #12 requires the id from \`api.app.listFrontendLibraries\`, so this mapping cannot be confirmed by name.`,
          ),
        );
        continue;
      }

      diagnostics.push(
        createExtensionExternalDiagnostic(
          "extension-library-unverified",
          mapping.packageName,
          `The supplied extension metadata has no library with id "${mapping.libraryId}", so nothing verifies that "${mapping.packageName}" is provided by an extension at all.`,
        ),
      );
      continue;
    }

    if (listing.globalName !== mapping.globalName) {
      diagnostics.push(
        createExtensionExternalDiagnostic(
          "extension-global-mismatch",
          mapping.packageName,
          `Library "${mapping.libraryId}" publishes "${listing.globalName}", but this mapping compiles "${mapping.packageName}" against "${mapping.globalName}".`,
        ),
      );
      continue;
    }

    if (listing.exists === false) {
      diagnostics.push(
        createExtensionExternalDiagnostic(
          "extension-bundle-missing",
          mapping.libraryId,
          `Library "${mapping.libraryId}" has no runtime bundle file, so "${mapping.globalName}" is never created and every import compiled against it fails at run time.`,
        ),
      );
    }

    if (listing.typeDefinitionAvailable === false) {
      diagnostics.push(
        createExtensionExternalDiagnostic(
          "extension-types-missing",
          mapping.libraryId,
          `Library "${mapping.libraryId}" ships no type definitions, so the global "${mapping.globalName}" cannot be completed by the designer or described to the CodeEditor's assistant.`,
        ),
      );
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Non-goals
// ---------------------------------------------------------------------------

export const EXTENSION_EXTERNAL_NON_GOALS = [
  "Package, upload or validate a Forguncy Frontend Extension. `MangMax/forguncy-frontend-library` owns that workflow and `MangMax/forguncy-react-library` owns the catalog of verified packages; this module consumes their identity and mapping and nothing else (#12: \"it does not duplicate packaging logic\").",
  "Decide that a package should be `extension`. A mapping says how an `extension` decision compiles, never that the decision is correct — #4 owns the strategy and #16 owns the selection flow. The same limit applies in the other direction: the presence of a row does not forbid an `inline` decision for that package, because a cell-local copy of a library whose identity is not shared is a legitimate choice.",
  "Give an `extension` mapping an `inline` fallback. A fallback would make the artifact's behaviour depend on whether the page happened to have loaded the library, which is exactly the load-order dependency #12 forbids; a failed load is reported, not papered over.",
  "Narrow a mapping to a measured export surface. There is no inventory of an extension's exports to narrow to — the surface is the vendor module's — so a row that claimed one would be enforcing a list somebody wrote from memory. #9's `verified-member-view` exists where runtime evidence produced an inventory; nothing comparable exists here yet. The generated module therefore exports the page object itself, which is also the only shape that survives a consumer's namespace import: an enumeration-driven namespace has to see the real names (see `EXTENSION_EXTERNAL_INTEROP_BEHAVIOUR`), and a wrapper that forwarded a subset would break any member the wrapper had not heard of.",
] as const;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** Thrown by the table guards. Distinct from #6's diagnostic types on purpose. */
export class ExtensionExternalContractError extends Error {
  readonly code: "mapping-not-admissible";

  constructor(message: string) {
    super(message);
    this.name = "ExtensionExternalContractError";
    this.code = "mapping-not-admissible";
  }
}

/**
 * Refuse a mapping that cannot be honoured.
 *
 * Runs over the table and would run over a project's additions to it, so the checks
 * are per-mapping. Each one is a way a mapping can *look* complete while describing
 * an extension the platform would never publish:
 *
 * 1. a `libraryId` the platform's manifest validation would refuse — the wrong shape, a
 *    reserved built-in id, or a Windows device name;
 * 2. a `globalName` that is not a single JavaScript identifier, or that is a reserved
 *    word;
 * 3. a `globalName` the platform reserves, or one #9's host bridge already binds —
 *    which is a second identity for one page object;
 * 4. a `metadataSource` outside #12's two, or an empty `metadataReference` — the state
 *    in which "not guessed from display name" stops being checkable;
 * 5. a mapping with no evidence channel, which is a claim with no observation behind
 *    it;
 * 6. no `verificationRule`, so nothing says what makes the claim true;
 * 7. its own package id repeated in `moduleIds`, which makes "what does this row
 *    intercept" answerable twice with different intent.
 *
 * Checks 2 and 3 are separate on purpose: "`Foo.Bar` is not an identifier" and "`antd`
 * is reserved" are different repairs, and collapsing them would send a reader looking
 * for a reservation that is not the problem.
 */
export function assertExtensionExternalMappingIsAdmissible(
  mapping: ExtensionExternalMapping,
  options: ExtensionExternalContractOptions = {},
): void {
  if (!isExtensionLibraryId(mapping.libraryId)) {
    throw new ExtensionExternalContractError(
      `Extension mapping "${mapping.packageName}" names library id "${mapping.libraryId}", which the platform's manifest validation would refuse: an id starts with a letter, holds only letters, digits, dots, underscores and dashes, is at most 64 characters, does not end with a dot, and is neither a built-in preset id nor a Windows device name.`,
    );
  }

  if (mapping.globalName.trim().length === 0) {
    throw new ExtensionExternalContractError(
      `Extension mapping "${mapping.packageName}" names no global, so nothing says which page object the import resolves to.`,
    );
  }

  if (!isSingleJavaScriptIdentifier(mapping.globalName)) {
    throw new ExtensionExternalContractError(
      `Extension mapping "${mapping.packageName}" names the global "${mapping.globalName}", which is not a single JavaScript identifier (the platform's manifest validation accepts one identifier and not a path, and not a reserved word).`,
    );
  }

  const claimed = extensionGlobalClaimReason(mapping.globalName, options);
  if (claimed !== undefined) {
    throw new ExtensionExternalContractError(
      `Extension mapping "${mapping.packageName}" binds "${mapping.packageName}" to the global "${mapping.globalName}", and ${claimed}.`,
    );
  }

  if (!EXTENSION_METADATA_SOURCES.includes(mapping.metadataSource)) {
    throw new ExtensionExternalContractError(
      `Extension mapping "${mapping.packageName}" names metadata source "${mapping.metadataSource}", which is not one of #12's two (${EXTENSION_METADATA_SOURCES.join(", ")}).`,
    );
  }

  if (mapping.metadataReference.trim().length === 0) {
    throw new ExtensionExternalContractError(
      `Extension mapping "${mapping.packageName}" names no catalog or listing its library id came from, so nothing distinguishes a verified id from one guessed from a display name.`,
    );
  }

  if (mapping.verifiedBy.length === 0) {
    throw new ExtensionExternalContractError(
      `Extension mapping "${mapping.packageName}" carries no evidence channel, so it records a claim no observation stands behind.`,
    );
  }

  if (mapping.verificationRule.trim().length === 0) {
    throw new ExtensionExternalContractError(
      `Extension mapping "${mapping.packageName}" states no verification rule, so nothing says what makes it true that this extension provides this package.`,
    );
  }

  const declared = extensionModuleIds(mapping);
  const seen = new Set<string>();
  for (const moduleId of declared) {
    if (seen.has(moduleId)) {
      throw new ExtensionExternalContractError(
        `Extension mapping "${mapping.packageName}" lists "${moduleId}" twice, so what the row intercepts has two answers.`,
      );
    }
    seen.add(moduleId);
  }
}

/**
 * Refuse a table in which one module id, one library or one global is claimed twice.
 *
 * A cross-row check, which is why it is separate: each row is admissible on its own,
 * and the problem only exists between them. Four conditions, and all four are checked
 * because the diagnostic's remediation promises all four:
 *
 * 1. one module id claimed by two rows, which makes a resolver hook's outcome depend on
 *    table order;
 * 2. one library under two `globalName`s, which the platform's own validation refuses —
 *    an extension project cannot have two packages publishing different globals under
 *    one display name, and one extension publishes one global;
 * 3. one `globalName` claimed by two libraries, which the platform refuses for the same
 *    reason and which is also physically impossible: a global holds one object;
 * 4. a module id #9's host bridge already binds, which is a conflict *across* the two
 *    tables rather than within one.
 *
 * Module ids listed as `moduleIds` on one row are not a collision: one extension
 * standing in for several packages is exactly what a row means, which is why the check
 * is on the *set* of ids a row claims rather than on the row's key.
 */
export function assertExtensionExternalMappingsAreUnambiguous(
  mappings: readonly ExtensionExternalMapping[] = EXTENSION_EXTERNAL_MAPPINGS,
  options: ExtensionExternalContractOptions = {},
): void {
  const moduleIdOwners = new Map<string, string>();
  for (const mapping of mappings) {
    for (const moduleId of extensionModuleIds(mapping)) {
      const existing = moduleIdOwners.get(moduleId);
      if (existing !== undefined) {
        throw new ExtensionExternalContractError(
          `Module id "${moduleId}" is claimed by both "${existing}" and "${mapping.packageName}", so which global the import resolves to would depend on table order.`,
        );
      }
      moduleIdOwners.set(moduleId, mapping.packageName);
    }
  }

  const globalOwner = new Map<string, string>();
  for (const mapping of mappings) {
    const existing = globalOwner.get(mapping.globalName);
    if (existing !== undefined && existing !== mapping.libraryId) {
      throw new ExtensionExternalContractError(
        `Global "${mapping.globalName}" is claimed by both the library "${existing}" and the library "${mapping.libraryId}". A global holds one object, so at most one of these is what the page publishes.`,
      );
    }
    globalOwner.set(mapping.globalName, mapping.libraryId);
  }

  for (const libraryId of new Set(mappings.map(mapping => mapping.libraryId))) {
    const globals = new Set(
      mappings.filter(mapping => mapping.libraryId === libraryId).map(mapping => mapping.globalName),
    );
    if (globals.size > 1) {
      throw new ExtensionExternalContractError(
        `Library "${libraryId}" is bound to ${globals.size} different globals (${[...globals].join(", ")}). One extension publishes one global name, so the second one can never be created.`,
      );
    }
  }

  const hostModuleIds = new Set(options.hostModuleIds ?? defaultHostModuleIds());
  for (const mapping of mappings) {
    for (const moduleId of extensionModuleIds(mapping)) {
      if (hostModuleIds.has(moduleId)) {
        throw new ExtensionExternalContractError(
          `Module id "${moduleId}" is bound by both #9's host bridge and the extension mapping "${mapping.packageName}", so the same import would resolve to two different identities.`,
        );
      }
    }
  }
}

/** Every guard above, over the shipped table. */
export function assertExtensionExternalContract(
  mappings: readonly ExtensionExternalMapping[] = EXTENSION_EXTERNAL_MAPPINGS,
  options: ExtensionExternalContractOptions = {},
): void {
  for (const mapping of mappings) {
    assertExtensionExternalMappingIsAdmissible(mapping, options);
  }
  assertExtensionExternalMappingsAreUnambiguous(mappings, options);
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Every Spec a change to this table has to cite.
 *
 * The architecture decisions first, then the Specs this mapping is built on —
 * the same shape `HOST_BRIDGE_GOVERNING_DECISIONS` uses, and for the same reason: a
 * change here answers to #4's strategy semantics, #5's runtime facts and #6's
 * metadata contract as much as to #12. The decision record itself lives in
 * `governance.ts` beside the other Specs, because a second package cites it too.
 */
export const EXTENSION_EXTERNALS_GOVERNING_DECISIONS: readonly ArchitectureDecisionSource[] = [
  ...GOVERNING_ARCHITECTURE_DECISIONS,
  EXTENSION_EXTERNALS_DECISION,
];

export const EXTENSION_EXTERNALS_GOVERNING_SPEC_REFERENCE_LINE = formatGoverningSpecReferenceLine(
  EXTENSION_EXTERNALS_GOVERNING_DECISIONS,
);
