/**
 * Library-selection signals: what makes a package a good or a bad candidate for
 * a Forguncy React cell, expressed so a decision can point at a named reason.
 *
 * Decision source: GitHub Issue #16 — "Spec: Agent-driven dependency selection
 * and empirical compatibility probe".
 * https://github.com/Mang-X/forguncy-react-workspace/issues/16
 *
 * Governing architecture Spec Issue: #4, which fixes who owns what and therefore
 * which side of the boundary a capability (and its replacement) has to stay on.
 *
 * Why a catalogue of *signals* instead of a compatibility list: npm is
 * unbounded, so any table that answers "does package X work?" is obsolete the
 * moment it is written, and a package-specific adapter for every long-tail
 * library is not maintainable. What is bounded — and what actually generalises —
 * is the small set of *properties* that decide whether a package can reach a
 * cell. Those properties are the signals below.
 *
 * The load-bearing property is the family a signal belongs to, because the three
 * families ask for three different actions and only one of them may end a
 * candidate's life:
 *
 * - `positive` — favours a candidate. It can never accept one: this is the
 *   module that makes "ESM is a positive signal, not proof of compatibility"
 *   checkable rather than a sentence in a document.
 * - `risk` — makes a deterministic probe mandatory. It can never reject a
 *   candidate: Worker, WASM and runtime asset loading are *investigated*, not
 *   assumed broken, and #16 says so explicitly.
 * - `replacement` — the candidate's artifact cannot reach this target at all.
 *   This is the only family that rejects, and it rejects the *artifact for this
 *   target*, never the package in the abstract.
 *
 * Deliberately absent, in two different senses:
 *
 * - **Any signal read from a package's prose.** The observation channels below are
 *   all machine-checkable, and neither a README nor a documentation site is one of
 *   them — see {@link NON_EVIDENCE_SIGNAL_SOURCES}. The rule "never declare
 *   compatibility from README inspection alone" is only enforceable if a
 *   documentation-derived claim has no channel to be recorded in.
 * - **Ownership.** No signal here says which side of the #4 boundary a capability
 *   belongs to. Ownership is a property of the *capability*, not of a package's
 *   artifact: "this package implements navigation" cannot be read off a manifest,
 *   and an unknown package filling an application-owned role is exactly as
 *   conflicting as a well-known one. Modelling it as a signal would put a
 *   bundling-adjacent observation in the position of an architecture decision and
 *   would contradict the ownership gate that has to run first. It is obtained from
 *   `assessDependencyRole` in `platform-conflicts.ts` instead — see
 *   {@link MACHINE_OBSERVED_SIGNAL_INVARIANT}.
 */

import type { TechnicalDependencyRejection, TechnicalRejectionCode } from "./rejection";

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

export const SELECTION_SIGNAL_FAMILIES = ["positive", "risk", "replacement"] as const;
export type SelectionSignalFamily = (typeof SELECTION_SIGNAL_FAMILIES)[number];

/**
 * What a family lets a decision do. Two booleans carry the whole policy, and the
 * combination is the point: `acceptsCandidateOnItsOwn` is false everywhere, and
 * `rejectsCandidateOnItsOwn` is true only for `replacement`.
 *
 * The asymmetry is not stylistic. Treating `risk` as a rejection turns every
 * Worker-backed viewer into a permanent "unsupported" verdict that no upgrade
 * can clear; treating `positive` as acceptance is how a package that merely
 * ships ESM gets declared compatible without ever being built.
 */
export interface SelectionSignalFamilySemantics {
  readonly family: SelectionSignalFamily;
  /** The instruction an Agent reads in a report. */
  readonly agentAction: string;
  /** Does observing this family alone accept the candidate? False for every family. */
  readonly acceptsCandidateOnItsOwn: boolean;
  /** Does observing this family alone reject the candidate artifact? */
  readonly rejectsCandidateOnItsOwn: boolean;
  readonly nextStep: string;
}

export const SELECTION_SIGNAL_FAMILY_SEMANTICS: Readonly<
  Record<SelectionSignalFamily, SelectionSignalFamilySemantics>
> = {
  positive: {
    family: "positive",
    agentAction: "Keep this candidate in the shortlist, and say why it is preferred over the others.",
    acceptsCandidateOnItsOwn: false,
    rejectsCandidateOnItsOwn: false,
    nextStep:
      "Probe the shortlisted candidates. A positive signal narrows the field; it is never evidence that the package runs in a Forguncy cell, so it cannot be the reason a strategy is chosen.",
  },
  risk: {
    family: "risk",
    agentAction: "Probe the specific risk before deciding, and record what the probe observed.",
    acceptsCandidateOnItsOwn: false,
    // The single most important rule in this module: a risk is a reason to look,
    // not a verdict. Worker/WASM/asset-loading findings are surfaced as facts so
    // the Agent can weigh them against the alternative, and a risk that turns out
    // to be handled by the chosen deployment path is not a failure at all.
    rejectsCandidateOnItsOwn: false,
    nextStep:
      "Run the deterministic probe and read the finding. A risk raises the cost of the candidate and may move the decision to `replace`, but it never decides it on its own.",
  },
  replacement: {
    family: "replacement",
    agentAction: "Do not deploy this package to this target; evaluate an alternative or a host-owned capability.",
    acceptsCandidateOnItsOwn: false,
    rejectsCandidateOnItsOwn: true,
    nextStep:
      "Prefer `replace` with an evaluated alternative (#16 rule 5) over a permanent project-local adapter, unless the repair-recipe conditions in `selection-policy.ts` hold.",
  },
};

export function isSelectionSignalFamily(value: unknown): value is SelectionSignalFamily {
  return typeof value === "string" && (SELECTION_SIGNAL_FAMILIES as readonly string[]).includes(value);
}

export function selectionSignalFamilySemantics(family: SelectionSignalFamily): SelectionSignalFamilySemantics {
  return SELECTION_SIGNAL_FAMILY_SEMANTICS[family];
}

// ---------------------------------------------------------------------------
// Observation channels
// ---------------------------------------------------------------------------

/**
 * Where a signal is actually observed.
 *
 * Every channel here is a machine artefact: a manifest, a resolved dependency
 * graph, a build output, a bundle, a running page. There is deliberately no
 * `documentation` channel, because a claim that can only be supported by prose
 * is exactly the claim #16 refuses to accept.
 */
export const SIGNAL_OBSERVATION_CHANNELS = [
  "registry-metadata",
  "package-manifest",
  "package-files",
  "dependency-graph",
  "build-output",
  "artifact-scan",
  "runtime-observation",
] as const;
export type SignalObservationChannel = (typeof SIGNAL_OBSERVATION_CHANNELS)[number];

/**
 * Sources that may inform a *hypothesis* but can never be an observation channel.
 *
 * Exported as data so a test can assert the omission instead of a comment
 * claiming it, and so a future contributor adding a signal has the rule in front
 * of them: if the only way to see a signal is to read prose about the package,
 * the signal has to be redefined in terms of something the probe can measure.
 */
export const NON_EVIDENCE_SIGNAL_SOURCES = [
  "readme",
  "documentation-site",
  "blog-post",
  "issue-comment",
  "model-recall",
] as const;
export type NonEvidenceSignalSource = (typeof NON_EVIDENCE_SIGNAL_SOURCES)[number];

/**
 * What a signal is allowed to be a statement about.
 *
 * The invariant exists because the tempting mistake is to add a signal like
 * "does not implement an application-owned concern" or "implements a Forguncy-owned
 * capability". Both read naturally and both are wrong: they are conclusions of the
 * #4 capability-ownership decision, not observations of a package artifact, and
 * nothing in a manifest or a registry entry can establish them. Keeping them out of
 * this catalogue is what lets `PROBE_ENGINE_NON_RESPONSIBILITIES` and the ownership
 * gate remain true at the same time — the gate runs first and answers the ownership
 * question, and this module never offers a machine observation that could be
 * substituted for it.
 */
export const MACHINE_OBSERVED_SIGNAL_INVARIANT =
  "A selection signal is an observation about a package's artifact. It is never a verdict about which side of the #4 ownership boundary a capability belongs to; that comes from assessDependencyRole in platform-conflicts.ts." as const;

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

export interface SelectionSignal {
  readonly id: SelectionSignalId;
  readonly family: SelectionSignalFamily;
  readonly label: string;
  /** What the signal means for a cell, in one sentence. */
  readonly summary: string;
  readonly observedFrom: SignalObservationChannel;
}

export type SelectionSignalId =
  // positive
  | "browser-first-esm-distribution"
  | "first-class-vite-entry-point"
  | "shipped-typescript-declarations"
  | "high-level-react-api"
  | "no-node-builtins"
  | "self-contained-runtime-assets"
  | "maintained-and-licensed"
  // risk
  | "worker"
  | "shared-worker"
  | "wasm"
  | "import-meta-url-asset"
  | "runtime-fetch-of-package-asset"
  | "dynamic-import-or-code-splitting"
  | "css-font-or-image-assets"
  | "portal-to-document-body"
  | "webgl-canvas-lifecycle"
  | "global-singleton-assumption"
  // replacement
  | "node-filesystem-process-or-native-addon"
  | "ssr-or-server-only-without-browser-build"
  | "service-worker-or-special-header-requirement"
  | "cell-artifact-budget-exceeded"
  | "runtime-assets-not-embeddable"
  | "dynamic-module-loading-cannot-be-eliminated"
  | "amd-umd-branch-observed-in-artifact"
  | "host-module-identity-mismatch-observed"
  | "global-namespace-collision-observed";

/**
 * Every signal, grouped by family so a reader can see the three policy buckets at
 * a glance. Order inside a family is documentation order, not priority: the
 * families are the only ranking this module claims.
 */
export const SELECTION_SIGNALS: readonly SelectionSignal[] = [
  // --- positive: preferences that narrow the field --------------------------
  {
    id: "browser-first-esm-distribution",
    family: "positive",
    label: "Browser-first / ESM-first distribution",
    summary:
      "The package ships a browser-executable ESM entry as its primary distribution, rather than a Node-targeted build the bundler has to repair.",
    observedFrom: "package-manifest",
  },
  {
    id: "first-class-vite-entry-point",
    family: "positive",
    label: "First-class Vite entry point",
    summary:
      "The package ships its own Vite-facing entry (a plugin export or an officially supported preset) instead of relying on ad-hoc configuration.",
    observedFrom: "package-manifest",
  },
  {
    id: "shipped-typescript-declarations",
    family: "positive",
    label: "Shipped TypeScript declarations",
    summary: "Types are published with the package, so cell code type-checks against the real API rather than a hand-written stub.",
    observedFrom: "package-manifest",
  },
  {
    id: "high-level-react-api",
    family: "positive",
    label: "High-level React API for a UI concern",
    summary:
      "For a UI capability, the package exposes a React-level API so the cell does not have to drive a low-level engine lifecycle itself.",
    observedFrom: "package-manifest",
  },
  {
    id: "no-node-builtins",
    family: "positive",
    label: "No Node builtin or native dependency",
    summary: "Nothing in the package's resolved dependency graph reaches a Node builtin or a native addon.",
    observedFrom: "dependency-graph",
  },
  {
    id: "self-contained-runtime-assets",
    family: "positive",
    label: "Self-contained JS/CSS or simple assets",
    summary: "Everything the package needs at runtime is inlineable into the cell artifact, with no sibling file fetched later.",
    observedFrom: "artifact-scan",
  },
  {
    id: "maintained-and-licensed",
    family: "positive",
    label: "Active maintenance and acceptable license",
    summary: "The package is currently maintained and its license is acceptable for the target deployment.",
    observedFrom: "registry-metadata",
  },

  // --- risk: probe before deciding, never an automatic rejection ------------
  {
    id: "worker",
    family: "risk",
    label: "Spawns a Worker",
    summary:
      "The bundle starts a Worker, which the cell deployment path may not be able to represent; it has to be shown working, not assumed broken.",
    observedFrom: "artifact-scan",
  },
  {
    id: "shared-worker",
    family: "risk",
    label: "Spawns a SharedWorker",
    summary: "The bundle relies on a SharedWorker, whose cross-context identity a cell cannot assume.",
    observedFrom: "artifact-scan",
  },
  {
    id: "wasm",
    family: "risk",
    label: "Loads WASM",
    summary: "The bundle loads a WebAssembly module, which is an extra asset with its own loading and MIME behaviour.",
    observedFrom: "artifact-scan",
  },
  {
    id: "import-meta-url-asset",
    family: "risk",
    label: "Resolves an asset through `new URL(..., import.meta.url)`",
    summary:
      "The package resolves a runtime asset relative to its own module URL, a pattern that survives bundling as a file path rather than as inlined code.",
    observedFrom: "build-output",
  },
  {
    id: "runtime-fetch-of-package-asset",
    family: "risk",
    label: "Fetches a package-relative asset at runtime",
    summary: "The package fetches data, a dictionary or a model at runtime from a path inside the package.",
    observedFrom: "artifact-scan",
  },
  {
    id: "dynamic-import-or-code-splitting",
    family: "risk",
    label: "Dynamic import / code splitting",
    summary:
      "The build emits more than one chunk, so the generated cell would depend on a sibling chunk being served alongside it.",
    observedFrom: "build-output",
  },
  {
    id: "css-font-or-image-assets",
    family: "risk",
    label: "Ships CSS, fonts or images",
    summary: "The package brings stylesheets or binary assets that have to be inlined or otherwise represented in the cell.",
    observedFrom: "artifact-scan",
  },
  {
    id: "portal-to-document-body",
    family: "risk",
    label: "Portals to `document.body`",
    summary: "The package mounts outside its own React root, which interacts with how the host page owns the document.",
    observedFrom: "runtime-observation",
  },
  {
    id: "webgl-canvas-lifecycle",
    family: "risk",
    label: "Owns a WebGL/Canvas lifecycle",
    summary:
      "The package drives GPU or canvas resources whose creation and disposal have to follow the cell's mount/unmount behaviour.",
    observedFrom: "runtime-observation",
  },
  {
    id: "global-singleton-assumption",
    family: "risk",
    label: "Assumes a process-wide singleton",
    summary:
      "The package keeps its state on a module-level singleton, so whether it still behaves correctly depends on how the cell's module is instantiated.",
    observedFrom: "runtime-observation",
  },

  // --- replacement: the artifact cannot reach this target -------------------
  {
    id: "node-filesystem-process-or-native-addon",
    family: "replacement",
    label: "Requires Node filesystem/process/network or a native addon",
    summary:
      "The package needs a Node runtime capability that does not exist in the browser, so no bundling configuration can produce a browser artifact of it.",
    observedFrom: "dependency-graph",
  },
  {
    id: "ssr-or-server-only-without-browser-build",
    family: "replacement",
    label: "Server-only package with no browser build",
    summary:
      "The package targets server-side rendering and ships no browser entry, so a client cell has nothing to execute.",
    observedFrom: "package-manifest",
  },
  {
    id: "service-worker-or-special-header-requirement",
    family: "replacement",
    label: "Needs a service worker, cross-origin isolation or a special header",
    summary:
      "The package requires a response header or an isolation mode the target deployment cannot guarantee, so it cannot be handed a cell.",
    observedFrom: "runtime-observation",
  },
  {
    id: "cell-artifact-budget-exceeded",
    family: "replacement",
    label: "Generated cell artifact exceeds the code budget",
    summary: "The artifact the chosen deployment path produces is larger than the measured cell budget allows.",
    observedFrom: "build-output",
  },
  {
    id: "runtime-assets-not-embeddable",
    family: "replacement",
    label: "Runtime assets cannot be embedded or represented",
    summary:
      "The package needs assets at runtime that the chosen target path can neither inline nor serve, and no configuration changes that.",
    observedFrom: "artifact-scan",
  },
  {
    id: "dynamic-module-loading-cannot-be-eliminated",
    family: "replacement",
    label: "A dynamic module load survives bundling",
    summary:
      "The build could not eliminate a runtime module load, so the artifact depends on resolving a module while the page runs — which a single-script cell deployment cannot represent.",
    observedFrom: "build-output",
  },
  {
    id: "amd-umd-branch-observed-in-artifact",
    family: "replacement",
    label: "The artifact is a UMD wrapper that takes the AMD branch",
    summary:
      "The shipped bundle is a UMD/AMD wrapper, so in a page that defines `define` it takes the AMD branch instead of registering the expected global.",
    observedFrom: "build-output",
  },
  {
    id: "host-module-identity-mismatch-observed",
    family: "replacement",
    label: "The host global's module identity does not match what the cell needs",
    summary:
      "The global the host exposes is not the same module instance the cell would share, so imports through it would be a second copy (hooks, Context, `instanceof`).",
    observedFrom: "runtime-observation",
  },
  {
    id: "global-namespace-collision-observed",
    family: "replacement",
    label: "A global the package writes collides with one the host owns",
    summary:
      "The package registers a global name the host page already uses, so loading it would overwrite host state.",
    observedFrom: "runtime-observation",
  },
];

const SIGNAL_BY_ID: ReadonlyMap<SelectionSignalId, SelectionSignal> = new Map(
  SELECTION_SIGNALS.map(signal => [signal.id, signal]),
);

export const SELECTION_SIGNAL_IDS: readonly SelectionSignalId[] = SELECTION_SIGNALS.map(signal => signal.id);

export function isSelectionSignalId(value: unknown): value is SelectionSignalId {
  return typeof value === "string" && SIGNAL_BY_ID.has(value as SelectionSignalId);
}

export function findSelectionSignal(id: string): SelectionSignal | undefined {
  return SIGNAL_BY_ID.get(id as SelectionSignalId);
}

/** Throws for an unknown id so a typo cannot silently select nothing. */
export function selectionSignal(id: SelectionSignalId): SelectionSignal {
  const signal = SIGNAL_BY_ID.get(id);
  if (!signal) {
    throw new Error(`Unknown dependency-selection signal "${id}".`);
  }
  return signal;
}

export function signalsInFamily(family: SelectionSignalFamily): readonly SelectionSignal[] {
  return SELECTION_SIGNALS.filter(signal => signal.family === family);
}

export function selectionSignalFamilyOf(id: SelectionSignalId): SelectionSignalFamily {
  return selectionSignal(id).family;
}

export function selectionSignalsObservedFrom(channel: SignalObservationChannel): readonly SelectionSignal[] {
  return SELECTION_SIGNALS.filter(signal => signal.observedFrom === channel);
}

// ---------------------------------------------------------------------------
// Signals to rejections (#4)
// ---------------------------------------------------------------------------

/**
 * A replacement signal, stated as the rejection a report can carry.
 *
 * The codes are `rejection.ts`'s, deliberately not a parallel vocabulary: #4
 * already decided that an architectural rejection and a bundling failure are two
 * different answers, and turning a signal into a decision is exactly the moment
 * that distinction has to be preserved rather than reinvented.
 */
export interface ReplacementSignalRejection {
  readonly signal: SelectionSignalId;
  /**
   * Always `technical`, and that is a conclusion rather than a simplification.
   *
   * An architectural rejection says the capability belongs to Forguncy, which is a
   * fact about the capability and is established by the role assessment in
   * `platform-conflicts.ts`. A signal in this catalogue is an observation of a
   * package artifact, so the strongest thing it can establish is that the artifact
   * cannot reach the target — a bundling/runtime answer, i.e. a technical one.
   * Allowing an `architectural` member here would reopen exactly the confusion
   * {@link MACHINE_OBSERVED_SIGNAL_INVARIANT} closes.
   */
  readonly kind: "technical";
  readonly code: TechnicalRejectionCode;
  /** What to do instead. A replacement signal is never a dead end. */
  readonly remediation: string;
}

/**
 * Every replacement signal, mapped to the rejection code its evidence establishes.
 *
 * Two properties are load-bearing, and both are asserted by tests rather than left to
 * review:
 *
 * - **Complete.** Every `TechnicalRejectionCode` #4 defines has at least one evidence
 *   path here. Otherwise the audit's code binding — which requires the recorded code to
 *   be one the observed findings map to — would make a rejection #4 considers legal
 *   permanently unrepresentable. That is why the terminal signals below exist as their
 *   own entries instead of the risk signals being promoted: "the build emitted a
 *   chunk" stays a risk, while "the build could not eliminate the load" is what
 *   rejects.
 * - **Aligned with #8's target requirement.** The codes in
 *   `RUNTIME_CONFIRMED_TECHNICAL_REJECTION_CODES` are exactly those this table produces
 *   from a `runtime-observation` channel, and no static channel may produce one. A
 *   runtime-confirmed code means "only a running host can tell", so it needs a target;
 *   a static code means "no target involved", so claiming one would be theatre.
 */
export const REPLACEMENT_SIGNAL_REJECTIONS: readonly ReplacementSignalRejection[] = [
  {
    signal: "node-filesystem-process-or-native-addon",
    kind: "technical",
    // `platform-api-unavailable`, not `runtime-api-unavailable`: a browser platform
    // cannot provide a Node builtin, so this is decidable statically and owes no
    // Forguncy target. See the note on `TechnicalRejectionCode`.
    code: "platform-api-unavailable",
    remediation:
      "The role is right and the runtime is wrong: evaluate a browser-first package for the same capability, and keep the original only if a verified extension can provide it.",
  },
  {
    signal: "ssr-or-server-only-without-browser-build",
    kind: "technical",
    code: "platform-api-unavailable",
    remediation: "Choose a package that ships a browser entry, or move the capability to a Forguncy server command where it belongs.",
  },
  {
    signal: "service-worker-or-special-header-requirement",
    kind: "technical",
    // A property of the *target deployment*, so it is observed at runtime and #8
    // requires the record to name the target it was observed under.
    code: "runtime-api-unavailable",
    remediation:
      "Evaluate a package whose runtime requirements the target deployment can actually satisfy; do not add a deployment-wide header or isolation requirement to host one cell.",
  },
  {
    // The one replacement signal whose answer is a measured artifact rather
    // than a runtime fact. It is the only signal that becomes false when a
    // candidate gets smaller, which is why the lock's technical-rejection
    // profile re-evaluates it on a version or toolchain change.
    signal: "cell-artifact-budget-exceeded",
    kind: "technical",
    code: "cell-code-budget-exceeded",
    remediation:
      "Prefer a lighter alternative, a host-provided capability, or a verified extension; keep the package only if a validated build brings it inside the measured budget.",
  },
  {
    signal: "runtime-assets-not-embeddable",
    kind: "technical",
    code: "non-inlineable-asset",
    remediation:
      "Evaluate an alternative whose assets can be inlined or served by the chosen target path, or move the capability to an extension that can ship those assets.",
  },
  {
    signal: "dynamic-module-loading-cannot-be-eliminated",
    kind: "technical",
    code: "dynamic-module-loading",
    remediation:
      "Prefer an alternative the bundler can reduce to one script, or use a verified extension that can serve the chunk the load needs.",
  },
  {
    signal: "amd-umd-branch-observed-in-artifact",
    kind: "technical",
    code: "amd-umd-branch-mismatch",
    remediation:
      "Re-bundle from the package's ESM entry as a single IIFE so no UMD wrapper survives, or choose a package that ships ESM.",
  },
  {
    signal: "host-module-identity-mismatch-observed",
    kind: "technical",
    code: "host-module-identity-mismatch",
    remediation:
      "Map the import to the host's own module through the `host` strategy, or verify a frontend extension that establishes the shared identity.",
  },
  {
    signal: "global-namespace-collision-observed",
    kind: "technical",
    code: "global-namespace-collision",
    remediation:
      "Prefer a package that does not register a global, or load it inside the extension boundary so it cannot overwrite host state.",
  },
];

const REPLACEMENT_REJECTION_BY_SIGNAL: ReadonlyMap<SelectionSignalId, ReplacementSignalRejection> = new Map(
  REPLACEMENT_SIGNAL_REJECTIONS.map(entry => [entry.signal, entry]),
);

export function findReplacementSignalRejection(signal: string): ReplacementSignalRejection | undefined {
  return REPLACEMENT_REJECTION_BY_SIGNAL.get(signal as SelectionSignalId);
}

/**
 * The rejection record for a replacement signal, with the package named.
 *
 * Returns `undefined` for a signal that is not a replacement signal, rather than
 * inventing a rejection: a `risk` finding is not a reason to reject, and a
 * function that answered anyway would make the two families interchangeable at
 * exactly the call site where the difference matters.
 *
 * The result is a *technical* rejection by construction. An architectural
 * rejection — the capability is Forguncy's — is not reachable from here, because
 * it is not a fact about an artifact; get it from `assessDependencyRole`.
 */
export function replacementRejectionFor(
  signal: string,
  packageName: string,
): TechnicalDependencyRejection | undefined {
  const mapping = findReplacementSignalRejection(signal);
  if (!mapping) {
    return undefined;
  }
  const descriptor = findSelectionSignal(signal);
  return {
    kind: "technical",
    code: mapping.code,
    summary: `"${packageName}" cannot be deployed to a React cell: ${descriptor?.summary ?? mapping.signal}.`,
    evidence: [
      `selection-signal:${mapping.signal}`,
      ...(descriptor ? [`observed-from:${descriptor.observedFrom}`] : []),
    ],
    remediation: mapping.remediation,
  };
}

// ---------------------------------------------------------------------------
// What a set of signals may conclude
// ---------------------------------------------------------------------------

export interface SignalVerdict {
  /**
   * Never "accepted". Signals can narrow a field or end a candidate's life for
   * this target; only an executed probe supports a deployment strategy, so the
   * best outcome a signal set can produce is "go and probe".
   */
  readonly verdict: "probe-required" | "reject-candidate";
  readonly positiveSignals: readonly SelectionSignalId[];
  readonly risksToProbe: readonly SelectionSignalId[];
  readonly replacementSignals: readonly SelectionSignalId[];
  /** Ids that are not in the catalogue at all — reported, never ignored. */
  readonly unknownSignals: readonly string[];
  readonly reason: string;
}

/**
 * Reduces a bag of observed signals to the only two things they can justify.
 *
 * The absence of an "accepted" verdict is the module's central claim, so it is
 * encoded as a fact about the return type rather than as guidance: a caller that
 * wants a strategy must go through a probe report, because there is no value
 * this function can return that would let it skip one.
 */
export function decideFromSignals(signalIds: readonly string[]): SignalVerdict {
  const positiveSignals: SelectionSignalId[] = [];
  const risksToProbe: SelectionSignalId[] = [];
  const replacementSignals: SelectionSignalId[] = [];
  const unknownSignals: string[] = [];

  for (const id of signalIds) {
    if (!isSelectionSignalId(id)) {
      unknownSignals.push(id);
      continue;
    }
    switch (selectionSignalFamilyOf(id)) {
      case "positive":
        positiveSignals.push(id);
        break;
      case "risk":
        risksToProbe.push(id);
        break;
      case "replacement":
        replacementSignals.push(id);
        break;
    }
  }

  if (replacementSignals.length > 0) {
    return {
      verdict: "reject-candidate",
      positiveSignals,
      risksToProbe,
      replacementSignals,
      unknownSignals,
      reason: `The candidate was rejected for this target by ${replacementSignals.join(", ")}. Positive signals do not outweigh a replacement signal, and the answer is an evaluated alternative rather than an adapter.`,
    };
  }

  const parts: string[] = [];
  if (positiveSignals.length > 0) {
    parts.push(`${String(positiveSignals.length)} positive signal(s) favour the candidate`);
  }
  if (risksToProbe.length > 0) {
    parts.push(`${risksToProbe.join(", ")} must be probed`);
  }
  if (positiveSignals.length === 0 && risksToProbe.length === 0) {
    parts.push("no signal was observed either way");
  }

  return {
    verdict: "probe-required",
    positiveSignals,
    risksToProbe,
    replacementSignals,
    unknownSignals,
    reason: `${parts.join("; ")}. Neither family accepts the candidate, so a deterministic probe is required before any deployment strategy is chosen. An ownership conflict is not routed through here at all: ownership is a property of the capability, so it comes from the #4 role assessment instead of a signal.`,
  };
}

// ---------------------------------------------------------------------------
// Findings validation
// ---------------------------------------------------------------------------

/** The minimum shape a finding needs to be checked against the catalogue. */
export interface SelectionSignalFinding {
  readonly signal: string;
}

/**
 * Checks a list of findings against the catalogue.
 *
 * Two failure modes, and they are different bugs:
 *
 * - an unknown id means the finding cannot be interpreted by anything
 *   downstream, so it is worse than useless in a machine-readable report;
 * - a correctly named signal filed in the wrong bucket means a `risk`-family
 *   finding was recorded as a risk. Given that only the `replacement` family
 *   rejects, that mis-filing is how a Worker notice silently becomes a refusal —
 *   so it is refused here instead of being tolerated and acted on later.
 *
 * `expectedFamily` is explicit rather than derived, so the same check serves
 * every finding list the selection flow produces and no caller has to re-derive
 * which family its bucket holds.
 */
export function validateSignalFindings(
  findings: readonly SelectionSignalFinding[],
  expectedFamily: SelectionSignalFamily,
): readonly string[] {
  const problems: string[] = [];

  findings.forEach((finding, index) => {
    const where = `findings[${index}] ("${finding.signal}")`;
    const descriptor = findSelectionSignal(finding.signal);
    if (!descriptor) {
      problems.push(
        `${where} names a signal that is not in the selection catalogue, so nothing downstream can interpret it.`,
      );
      return;
    }
    if (descriptor.family !== expectedFamily) {
      problems.push(
        `${where} is a "${descriptor.family}" signal, but this list records "${expectedFamily}" findings. A "${descriptor.family}" signal has different consequences${
          expectedFamily === "risk"
            ? " — a risk raises the cost of a candidate, it does not reject it —"
            : ""
        } and must be recorded in its own list.`,
      );
    }
  });

  return problems;
}
