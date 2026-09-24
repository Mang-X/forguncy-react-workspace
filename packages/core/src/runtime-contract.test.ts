import { describe, expect, it } from "vitest";

import * as contract from "./runtime-contract.ts";
import {
  CELL_DATA_SOURCE_CONTRACT,
  CELL_ENTRY_RESOLUTION_ORDER,
  CELL_ENTRY_SHAPES,
  CELL_FORGUNCY_FACADE,
  CELL_FORGUNCY_PROP_KEYS,
  CELL_HOST_RUNTIME_SEMANTICS,
  CELL_PRESET_LIBRARIES,
  CELL_PRESET_LIBRARY_DEFAULT,
  CELL_PROPS_BASE_KEYS,
  CELL_PROPS_KEY_ORDER,
  CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR,
  CELL_SERVER_COMMANDS_CONTRACT,
  CELL_SERVER_COMMAND_RESULT_KEYS,
  CELL_SOURCE_EXECUTION_MODEL,
  CELL_SOURCE_REJECTIONS,
  CELL_SOURCE_REJECTION_ENVELOPE,
  CELL_SOURCE_SIZE_OBSERVATIONS,
  CELL_SOURCE_VALIDATION_MECHANISM,
  CELL_USER_SCOPE_BINDINGS,
  cellSourceValidationVisitsAstKey,
  cellUserScopeBinding,
  describeRuntimeContractTarget,
  emitCellEntryShapes,
  findCellEntryShape,
  findCellHostRuntimeFact,
  findCellPresetLibrary,
  findCellSourceRejection,
  FRONTEND_LIBRARY_REFERENCE_CONTRACT,
  FRONTEND_LIBRARY_REFERENCE_EXAMPLE,
  FRONTEND_LIBRARY_RUNTIME_SEMANTICS,
  nonWorkingCellEntryShapes,
  openRuntimeContractQuestions,
  persistedDefaultCellPreset,
  rejectedCellSourceConstructs,
  RUNTIME_CONTRACT_TARGET,
  RUNTIME_CONTRACT_UNKNOWNS,
} from "./runtime-contract.ts";
import type { RuntimeEvidenceChannel } from "./runtime-contract.ts";
import {
  citesDecision,
  citesEveryArchitectureDecision,
  GOVERNING_ARCHITECTURE_SPEC_REFERENCE_LINE,
  RUNTIME_CONTRACT_DECISION,
  RUNTIME_CONTRACT_DECISION_REFERENCE,
} from "./governance.ts";

/**
 * The evidence vocabulary, read from the module rather than restated here, so a
 * channel cannot be introduced by editing two places in step.
 */
const KNOWN_EVIDENCE_CHANNELS: readonly RuntimeEvidenceChannel[] = contract.RUNTIME_EVIDENCE_CHANNELS;

/** Why `value` cannot be trusted as a fact record, or `undefined` when it can. */
function evidenceProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return "is not a fact record";
  }
  const evidence = (value as { evidence?: unknown }).evidence;
  if (!Array.isArray(evidence)) {
    return "has no evidence array";
  }
  if (evidence.length === 0) {
    return "has an empty evidence array";
  }
  const unknownChannels = evidence.filter(channel => !KNOWN_EVIDENCE_CHANNELS.includes(channel as RuntimeEvidenceChannel));
  if (unknownChannels.length > 0) {
    return `cites unknown evidence channel(s): ${unknownChannels.join(", ")}`;
  }
  return undefined;
}

/**
 * Values that are *not* facts about the target.
 *
 * Kept deliberately short and justified per entry: every name here is an escape
 * from the evidence requirement.
 */
const NON_FACT_EXPORTS: readonly string[] = [
  // The vocabulary that facts are labelled with, not a fact about the target.
  "RUNTIME_EVIDENCE_CHANNELS",
  // An unanswered question is recorded precisely because nobody observed an
  // answer, so requiring evidence on it would be backwards.
  "RUNTIME_CONTRACT_UNKNOWNS",
];

/**
 * One hop inside an evidence-bearing record.
 *
 * A string reads a property. A `match` reads the first list entry whose property
 * equals the given value — that is how "the preset marked as the persisted
 * default" is expressed without accepting an arbitrary function.
 */
type DerivedPathStep = string | { readonly match: { readonly property: string; readonly equals: unknown } };

interface DerivedExportRule {
  /** The export that must be a value taken from `source`. */
  readonly name: string;
  /** The evidence-bearing export it is taken from. */
  readonly source: string;
  readonly path: readonly DerivedPathStep[];
}

/**
 * Values that are *taken from* an evidence-bearing record instead of carrying
 * evidence themselves.
 *
 * Expressed as a path rather than as a predicate on purpose: a predicate is one
 * more place a restated value can hide, because it lets a name pass by declaring
 * how it would like to be derived. A path instead points at where the value
 * actually lives inside the record, so a value that is not in the record cannot
 * be registered here.
 */
const DERIVED_EXPORTS: readonly DerivedExportRule[] = [
  {
    name: "CELL_PRESET_LIBRARY_DEFAULT",
    source: "CELL_PRESET_LIBRARIES",
    path: [{ match: { property: "isPersistedDefault", equals: true } }, "name"],
  },
  { name: "CELL_PROPS_BASE_KEYS", source: "CELL_PROPS_KEY_ORDER", path: ["baseKeys"] },
  { name: "CELL_FORGUNCY_PROP_KEYS", source: "CELL_FORGUNCY_FACADE", path: ["keys"] },
  { name: "CELL_SERVER_COMMAND_RESULT_KEYS", source: "CELL_SERVER_COMMANDS_CONTRACT", path: ["resultKeys"] },
  {
    name: "FRONTEND_LIBRARY_REFERENCE_EXAMPLE",
    source: "FRONTEND_LIBRARY_REFERENCE_CONTRACT",
    path: ["example"],
  },
];

function formatPath(path: readonly DerivedPathStep[]): string {
  return path
    .map(step => (typeof step === "string" ? `.${step}` : `[${step.match.property} == ${String(step.match.equals)}]`))
    .join("");
}

function resolvePath(root: unknown, path: readonly DerivedPathStep[]): unknown {
  let current = root;
  for (const step of path) {
    if (typeof step === "string") {
      if (typeof current !== "object" || current === null) return undefined;
      current = (current as Record<string, unknown>)[step];
      continue;
    }
    if (!Array.isArray(current)) return undefined;
    current = current.find(
      item =>
        typeof item === "object" &&
        item !== null &&
        (item as Record<string, unknown>)[step.match.property] === step.match.equals,
    );
  }
  return current;
}

/**
 * Walks the module's exported values and reports every one that is neither
 * evidence-bearing, taken from an evidence-bearing record, nor declared
 * non-factual.
 *
 * The traversal *is* the invariant: it is deliberately not a list of names, so an
 * export added later cannot slip through unclassified, and it validates each
 * evidence member against the vocabulary rather than only counting them.
 */
function auditExportedFacts(module: Record<string, unknown>): {
  readonly problems: string[];
  readonly inspected: number;
} {
  const problems: string[] = [];
  let inspected = 0;

  for (const [name, value] of Object.entries(module)) {
    // Module-interop artifacts are not values this module chose to export.
    if (name === "__esModule" || name === "default") continue;
    if (typeof value === "function") continue;
    inspected += 1;

    if (NON_FACT_EXPORTS.includes(name)) continue;

    const rule = DERIVED_EXPORTS.find(entry => entry.name === name);
    if (rule) {
      const source = module[rule.source];
      if (source === undefined) {
        problems.push(`${name}: source ${rule.source} is not exported`);
      } else if (Array.isArray(source)) {
        if (source.length === 0) {
          problems.push(`${name}: source ${rule.source} is empty`);
        } else {
          source.forEach((item, index) => {
            const why = evidenceProblem(item);
            if (why) problems.push(`${name}: source ${rule.source}[${index}] ${why}`);
          });
        }
      } else {
        const why = evidenceProblem(source);
        if (why) problems.push(`${name}: source ${rule.source} ${why}`);
      }

      if (resolvePath(source, rule.path) !== value) {
        problems.push(`${name}: is not the value at ${rule.source}${formatPath(rule.path)}`);
      }
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) problems.push(`${name}: is an empty list`);
      value.forEach((item, index) => {
        const why = evidenceProblem(item);
        if (why) problems.push(`${name}[${index}] ${why}`);
      });
      continue;
    }

    const why = evidenceProblem(value);
    if (why) problems.push(`${name} ${why}`);
  }

  return { problems, inspected };
}

describe("runtime contract target", () => {
  it("pins the exact product build the contract was established against", () => {
    expect(RUNTIME_CONTRACT_TARGET.productVersion).toBe("12.0.100.0");
    expect(RUNTIME_CONTRACT_TARGET.productBuild).toContain("12.0.100.0+");
    expect(RUNTIME_CONTRACT_TARGET.hostReactVersion).toBe("19.2.7");
    expect(RUNTIME_CONTRACT_TARGET.hostReactDomVersion).toBe(RUNTIME_CONTRACT_TARGET.hostReactVersion);
    expect(RUNTIME_CONTRACT_TARGET.browserTranspilerVersion).toBe("7.29.4");
  });

  it("is governed by the runtime contract decision", () => {
    expect(RUNTIME_CONTRACT_TARGET.decision).toBe(RUNTIME_CONTRACT_DECISION);
    expect(RUNTIME_CONTRACT_DECISION.issue).toBe(5);
    expect(RUNTIME_CONTRACT_DECISION_REFERENCE).toBe("#5");
    expect(citesDecision(RUNTIME_CONTRACT_TARGET.decision.url, RUNTIME_CONTRACT_DECISION)).toBe(true);
  });

  it("renders a header a report or PR body can carry", () => {
    const header = describeRuntimeContractTarget();
    expect(header).toContain("12.0.100.0");
    expect(header).toContain("19.2.7");
    expect(header).toContain("7.29.4");
  });
});

// The Issue's fifth acceptance criterion is "no claim relies solely on
// implementation guesses". The type system already forbids an `assumption`
// channel; the checks below assert the weaker runtime property that no recorded
// fact was left without one.
describe("evidence discipline", () => {
  // The earlier version of this suite enumerated fact tables by hand, so a new
  // exported constant could be added with no provenance while the suite stayed
  // green. The traversal below *is* the invariant: every exported value has to be
  // evidence-bearing, taken from an evidence-bearing record, or explicitly
  // declared non-factual — and every evidence member is checked against the
  // vocabulary, not merely counted.
  it("audits every exported value", () => {
    const { problems, inspected } = auditExportedFacts(contract as Record<string, unknown>);
    expect(
      problems,
      "An exported value must carry real evidence, be taken from an evidence-bearing record, or be declared non-factual.",
    ).toEqual([]);

    // Guard against a vacuous pass: if the namespace stopped being enumerable,
    // the traversal would inspect nothing and still report success.
    expect(inspected, "the audit must have inspected the module's exported values").toBeGreaterThan(15);
  });

  // The concrete bypass this guard exists to stop: a count-only check is satisfied
  // by an untyped export claiming a channel that does not exist.
  it("rejects a fact that cites an invented evidence channel", () => {
    expect(evidenceProblem({ value: "guess", evidence: ["assumption"] })).toMatch(
      /unknown evidence channel\(s\): assumption/,
    );
    expect(evidenceProblem({ value: "guess", evidence: ["generated-runtime-browser", "probably"] })).toMatch(
      /unknown evidence channel\(s\): probably/,
    );
    expect(evidenceProblem({ evidence: ["generated-runtime-browser"] })).toBeUndefined();
  });

  it("rejects a fact with no usable evidence", () => {
    expect(evidenceProblem({ evidence: [] })).toMatch(/empty evidence array/);
    expect(evidenceProblem({ value: "guess" })).toMatch(/no evidence array/);
    expect(evidenceProblem("guess")).toMatch(/is not a fact record/);
    expect(evidenceProblem(null)).toMatch(/is not a fact record/);
  });

  it("pins the evidence vocabulary", () => {
    // Adding a channel has to be a deliberate edit here too, so a single untyped
    // export cannot introduce a new label on its own.
    expect([...KNOWN_EVIDENCE_CHANNELS]).toEqual([
      "product-runtime-source",
      "product-documentation",
      "designer-api",
      "generated-runtime-browser",
    ]);
  });

  // A registered derivation has to point at where the value actually lives, so
  // DERIVED_EXPORTS cannot be used as a general escape hatch: a value that is not
  // present inside the record cannot resolve.
  it("only accepts a derivation that resolves to the registered value", () => {
    expect(resolvePath(CELL_PROPS_KEY_ORDER, ["baseKeys"])).toBe(CELL_PROPS_BASE_KEYS);
    expect(resolvePath(CELL_FORGUNCY_FACADE, ["keys"])).toBe(CELL_FORGUNCY_PROP_KEYS);
    expect(resolvePath(CELL_SERVER_COMMANDS_CONTRACT, ["resultKeys"])).toBe(CELL_SERVER_COMMAND_RESULT_KEYS);
    expect(resolvePath(FRONTEND_LIBRARY_REFERENCE_CONTRACT, ["example"])).toBe(FRONTEND_LIBRARY_REFERENCE_EXAMPLE);
    expect(
      resolvePath(CELL_PRESET_LIBRARIES, [{ match: { property: "isPersistedDefault", equals: true } }, "name"]),
    ).toBe(CELL_PRESET_LIBRARY_DEFAULT);

    expect(resolvePath(CELL_PROPS_KEY_ORDER, ["baseKeys", "nope"])).toBeUndefined();
    expect(resolvePath(CELL_PROPS_KEY_ORDER, [{ match: { property: "nope", equals: true } }, "name"])).toBeUndefined();
    expect(resolvePath("a string", ["anything"])).toBeUndefined();
  });

  it("keeps AntDesign as the persisted default that the constant reports", () => {
    expect(CELL_PRESET_LIBRARY_DEFAULT).toBe("AntDesign");
    expect(CELL_PRESET_LIBRARY_DEFAULT).toBe(persistedDefaultCellPreset().name);
    expect(CELL_PRESET_LIBRARY_DEFAULT).toBe(findCellPresetLibrary("AntDesign").name);
  });

  it("records the open questions rather than guessing them", () => {
    expect(RUNTIME_CONTRACT_UNKNOWNS.length).toBeGreaterThan(0);
    const ids = RUNTIME_CONTRACT_UNKNOWNS.map(unknown => unknown.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const unknown of RUNTIME_CONTRACT_UNKNOWNS) {
      expect(unknown.question.trim().length, unknown.id).toBeGreaterThan(0);
      expect(unknown.whyOpen.trim().length, unknown.id).toBeGreaterThan(0);
    }
  });

  it("lets a downstream Issue find the questions it owns", () => {
    const forBudget = openRuntimeContractQuestions("#21");
    expect(forBudget.map(unknown => unknown.id)).toContain("absolute-source-ceiling");
    expect(openRuntimeContractQuestions("#6").map(unknown => unknown.id)).toContain("property-change-re-render");
  });
});

// The multi-cell facts describe the page the cells share. They make component
// state, hooks and React Context local to a cell by construction — but *not*
// module identity, which stays page-global (the record says so at length).
describe("host runtime across cells", () => {
  it("records that the page has one React instance shared by every cell", () => {
    const fact = findCellHostRuntimeFact("single-react-instance-per-page");
    expect(fact.statement).toMatch(/one React instance/);
    expect(fact.evidence).toContain("generated-runtime-browser");
  });

  it("records the shared globalThis and the per-cell root", () => {
    expect(findCellHostRuntimeFact("shared-global-this").statement).toMatch(/share one globalThis/);
    expect(findCellHostRuntimeFact("one-react-root-per-cell").statement).toMatch(/its own ReactDOM root/);
  });

  it("states that React Context does not cross cell roots", () => {
    const fact = findCellHostRuntimeFact("context-does-not-cross-cells");
    expect(fact.statement).toMatch(/not visible to another cell/);
    // This one was only established in the browser: the source shows separate
    // roots, but the isolation itself was executed.
    expect(fact.evidence).toEqual(["generated-runtime-browser"]);
  });

  it("says cell initialisation order is not layout order", () => {
    expect(findCellHostRuntimeFact("initialisation-order-is-not-layout-order").statement).toMatch(
      /not the layout order/,
    );
  });

  it("gives every host runtime fact a way to be observed again", () => {
    expect(CELL_HOST_RUNTIME_SEMANTICS.length).toBeGreaterThanOrEqual(5);
    const ids = CELL_HOST_RUNTIME_SEMANTICS.map(fact => fact.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const fact of CELL_HOST_RUNTIME_SEMANTICS) {
      expect(fact.statement.trim().length, fact.id).toBeGreaterThan(0);
      expect(fact.howToObserve.trim().length, fact.id).toBeGreaterThan(0);
    }
  });

  // Source-only facts must not look like executed ones.
  it("marks the teardown fact as read rather than executed", () => {
    const fact = findCellHostRuntimeFact("unmount-clears-the-cell-root");
    expect(fact.evidence).toEqual(["product-runtime-source"]);
    expect(fact.howToObserve).toMatch(/Not executed/);
  });

  it("rejects unknown fact ids", () => {
    // @ts-expect-error an unknown id must not be accepted at the type level either
    expect(() => findCellHostRuntimeFact("not-a-fact")).toThrow(/Unknown ReactCellType host runtime fact/);
  });
});

describe("cell render failure", () => {
  it("records that a failed cell clears its root instead of showing the error", () => {
    expect(CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR.rendersErrorTextInCell).toBe(false);
    expect(CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR.behavior).toMatch(/rendered with null/);
  });

  // A source-only fact must not look like an executed one, and this one could not
  // be executed at all: the designer refused every rejected sample, so no rejected
  // source ever reached a page.
  it("marks the failure behaviour as read rather than executed", () => {
    expect(CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR.evidence).toEqual(["product-runtime-source"]);
    expect(CELL_RUNTIME_RENDER_FAILURE_BEHAVIOR.note).toMatch(/frontend-library failures/);
  });
});

describe("execution model", () => {
  it("transforms with the react preset only", () => {
    expect(CELL_SOURCE_EXECUTION_MODEL.transformPresets).toEqual(["react"]);
    expect(CELL_SOURCE_EXECUTION_MODEL.missingTransforms).toEqual(
      expect.arrayContaining(["typescript", "preset-env"]),
    );
  });

  // The parameter order is part of the contract: the runtime binds them
  // positionally, so a copied signature that reorders them still type-checks but
  // binds the wrong values.
  it("binds the host through the documented parameter order", () => {
    expect(CELL_SOURCE_EXECUTION_MODEL.injectedParameters).toEqual([
      "React",
      "antd",
      "echarts",
      "dayjs",
      "ForguncyReactHelper",
      "__useDataSource",
      "__props",
    ]);
  });

  it("keeps top-level declarations out of the page globals", () => {
    expect(CELL_SOURCE_EXECUTION_MODEL.perCellCompilationScope).toBe(true);
    expect(CELL_SOURCE_EXECUTION_MODEL.topLevelDeclarationsReachGlobalThis).toBe(false);
  });
});

describe("entry shapes", () => {
  it("never lets a generator emit a shape that validates but does not render", () => {
    const emittable = emitCellEntryShapes().map(shape => shape.id);
    expect(emittable).not.toContain("app-async-function-declaration");
    expect(emittable).not.toContain("no-entry");
    expect(emittable).toContain("app-function-declaration");
    expect(emittable).toContain("render-call");
  });

  it("names the accepted-but-broken async entry as the only write-time false pass", () => {
    expect(nonWorkingCellEntryShapes().map(shape => shape.id)).toEqual([
      "app-async-function-declaration",
      "no-entry",
    ]);

    // `no-entry` is not meant to render anything, so the interesting set is the
    // shapes that actually name an entry: exactly one of them is accepted and
    // still fails.
    const brokenEntries = nonWorkingCellEntryShapes().filter(shape => shape.id !== "no-entry");
    expect(brokenEntries.map(shape => shape.id)).toEqual(["app-async-function-declaration"]);
    expect(brokenEntries[0]?.note).toContain("#482");
  });

  // `findCellEntryShape` is a lookup by id, so duplicate ids would silently make
  // one shape unreachable.
  it("gives every entry shape a unique id and a described shape", () => {
    const ids = CELL_ENTRY_SHAPES.map(shape => shape.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const shape of CELL_ENTRY_SHAPES) {
      expect(shape.shape.trim().length, shape.id).toBeGreaterThan(0);
    }
  });

  it("flags the silent no-entry case", () => {
    const noEntry = findCellEntryShape("no-entry");
    expect(noEntry.acceptedAtWriteTime).toBe(true);
    expect(noEntry.renderedAtRuntime).toBe(false);
    expect(noEntry.note).toMatch(/silently/);
  });

  it("records resolution precedence in a contiguous order that starts at render(value)", () => {
    expect(CELL_ENTRY_RESOLUTION_ORDER.map(step => step.order)).toEqual([1, 2, 3, 4, 5]);
    expect(CELL_ENTRY_RESOLUTION_ORDER[0]?.mechanism).toContain("render(value)");
    expect(CELL_ENTRY_RESOLUTION_ORDER[1]?.mechanism).toContain("App");
    expect(CELL_ENTRY_RESOLUTION_ORDER.every(step => step.evidence.length > 0)).toBe(true);
  });

  it("rejects unknown entry shapes instead of returning undefined", () => {
    // @ts-expect-error an unknown id must not be accepted at the type level either
    expect(() => findCellEntryShape("not-a-shape")).toThrow(/Unknown ReactCellType entry shape/);
  });
});

describe("rejected source", () => {
  it("carries the platform's own wording for the fixed messages", () => {
    expect(findCellSourceRejection("import-declaration").message).toBe(
      "ReactCellType does not support import statements. Use the provided global variables instead.",
    );
    expect(findCellSourceRejection("export-declaration").message).toBe(
      "ReactCellType does not support export statements. Define App, element, or call render(value) instead.",
    );
    expect(findCellSourceRejection("react-use").message).toContain("React.use is not supported");
  });

  it("separates what the platform refuses from what only the bundler refuses", () => {
    const refusedIds = rejectedCellSourceConstructs().map(rejection => rejection.id);
    expect(refusedIds).toContain("import-declaration");
    expect(refusedIds).toContain("typescript-annotation");

    // The one record that describes a *non*-rejection must not be reported as one.
    const dynamicImport = findCellSourceRejection("runtime-import-call-not-rejected");
    expect(dynamicImport.rejected).toBe(false);
    expect(refusedIds).not.toContain(dynamicImport.id);
    expect(dynamicImport.note).toMatch(/bundler requirement/);
  });

  it("marks the parse-error messages as position-dependent samples", () => {
    for (const rejection of CELL_SOURCE_REJECTIONS) {
      expect(rejection.message.trim().length, rejection.id).toBeGreaterThan(0);
      if (rejection.stage === "babel") {
        expect(rejection.messageVaries, rejection.id).toBe(true);
      }
    }
  });

  it("documents the error envelope both validation passes surface through", () => {
    expect(CELL_SOURCE_REJECTION_ENVELOPE.template).toContain("ReactCellType 代码验证失败");
    expect(CELL_SOURCE_REJECTION_ENVELOPE.stageTags).toEqual(["preview", "babel"]);
  });

  it("rejects unknown rejection ids", () => {
    // @ts-expect-error an unknown id must not be accepted at the type level either
    expect(() => findCellSourceRejection("not-a-rejection")).toThrow(/Unknown ReactCellType source rejection/);
  });
});

// The messages in `CELL_SOURCE_REJECTIONS` say what is refused; they cannot say
// whether a construct is refused by its text or by its syntax. That difference
// decides whether a local guard may scan raw source at all, so it is recorded
// separately and pinned here.
describe("how the target decides what to refuse", () => {
  it("decides on parsed syntax nodes, not on text", () => {
    const mechanism = CELL_SOURCE_VALIDATION_MECHANISM;

    // Comments and tokens are skipped by the walk, so text inside them is never
    // even visited — which is what makes a raw-text scan an over-rejection.
    for (const key of ["leadingComments", "trailingComments", "innerComments", "tokens"]) {
      expect(mechanism.skippedAstKeys, key).toContain(key);
      expect(cellSourceValidationVisitsAstKey(key), key).toBe(false);
    }
    // The ordinary children of a node are still visited, so the predicate is not
    // simply "false for everything".
    expect(cellSourceValidationVisitsAstKey("body")).toBe(true);
    expect(cellSourceValidationVisitsAstKey("callee")).toBe(true);
  });

  it("names the declaration nodes and the callee shapes it refuses", () => {
    const mechanism = CELL_SOURCE_VALIDATION_MECHANISM;
    expect(mechanism.refusedDeclarationNodeTypes).toEqual(["ImportDeclaration"]);
    expect(mechanism.refusedDeclarationNodeTypePrefix).toBe("Export");
    expect(mechanism.refusedBareCalleeNames).toEqual(["useActionState", "useOptimistic", "useFormStatus"]);
    expect(mechanism.refusedMemberCalleeObjects).toEqual(["React", "ReactDOM"]);
    expect(mechanism.refusedReactOnlyMemberNames).toEqual(["use"]);

    // A `new X()` is a `NewExpression`, so this boundary is what stops a local
    // guard from refusing something the platform accepts.
    expect(mechanism.refusedCalleeNodeType).toBe("CallExpression");
    expect(mechanism.note).toMatch(/new useFormStatus\(\)/);
    expect(mechanism.note).toMatch(/computed member/);

    // Every name refused as a bare call must also be the property of a refused
    // member call, which is why one message table serves both.
    for (const name of mechanism.refusedBareCalleeNames) {
      expect(mechanism.refusedMemberNames, name).toContain(name);
      expect(findCellSourceRejection(rejectionIdForCalleeName(name))).toBeDefined();
    }
  });

  // The wrap is the reason a top-level `return` is legal to this pass and still
  // refused later by the parse of the raw source.
  it("wraps the source before checking calls, so this pass is not the raw parse", () => {
    expect(CELL_SOURCE_VALIDATION_MECHANISM.reactCallCheckWrap).toContain("() =>");
    expect(CELL_SOURCE_VALIDATION_MECHANISM.declarationSourceType).toBe("module");
    expect(CELL_SOURCE_VALIDATION_MECHANISM.parseCall).toContain('presets: ["react"]');
    expect(CELL_SOURCE_VALIDATION_MECHANISM.ignoresParseFailure).toBe(true);
  });

  it("carries the evidence channel it was read through, and a caveat", () => {
    expect(CELL_SOURCE_VALIDATION_MECHANISM.evidence).toEqual(["product-runtime-source"]);
    expect(CELL_SOURCE_VALIDATION_MECHANISM.note).toMatch(/is not refused/);
    expect(CELL_SOURCE_VALIDATION_MECHANISM.note).toMatch(/import\(\.\.\.\)/);
  });
});

/** The rejection record whose message the target throws for a refused callee name. */
function rejectionIdForCalleeName(name: string): Parameters<typeof findCellSourceRejection>[0] {
  const byName: Readonly<Record<string, Parameters<typeof findCellSourceRejection>[0]>> = {
    useActionState: "use-action-state",
    useOptimistic: "use-optimistic",
    useFormStatus: "use-form-status",
  };
  const id = byName[name];
  if (id === undefined) {
    throw new Error(`No source rejection record is registered for the refused callee "${name}".`);
  }
  return id;
}

describe("names visible inside a cell", () => {
  it("keeps the injected parameters distinguishable from window globals", () => {
    expect(cellUserScopeBinding("React")?.availableInCellSource).toBe("always");
    expect(cellUserScopeBinding("React")?.onWindow).toBe("always");

    // The runtime passes these as arguments, so they are usable but invisible on
    // `window`; reading them through `window` is a real failure mode.
    for (const name of ["ForguncyReactHelper", "props", "useDataSource", "render", "useState", "DataSourceCompareType"]) {
      expect(cellUserScopeBinding(name)?.onWindow, name).toBe("never");
    }
  });

  it("ties preset-provided names to the preset resolving first", () => {
    for (const name of ["antd", "dayjs", "echarts"]) {
      expect(cellUserScopeBinding(name)?.availableInCellSource, name).toBe(
        "after-the-declared-preset-resolves",
      );
    }
  });

  it("returns undefined for an unknown name rather than inventing a binding", () => {
    expect(cellUserScopeBinding("Reactify")).toBeUndefined();
    expect(cellUserScopeBinding("")).toBeUndefined();
  });

  // The binding list is the whole `host` mapping surface, so a duplicate name would
  // make one entry unreachable and silently widen or narrow what a cell may use.
  it("lists each host-provided name once", () => {
    const names = CELL_USER_SCOPE_BINDINGS.map(binding => binding.name);
    expect(new Set(names).size).toBe(names.length);
    for (const binding of CELL_USER_SCOPE_BINDINGS) {
      expect(cellUserScopeBinding(binding.name), binding.name).toBe(binding);
    }
  });
});

describe("preset libraries", () => {
  it("has exactly one persisted default, and it is the one that also loads dayjs", () => {
    const defaults = CELL_PRESET_LIBRARIES.filter(preset => preset.isPersistedDefault);
    expect(defaults.map(preset => preset.name)).toEqual([CELL_PRESET_LIBRARY_DEFAULT]);
    expect(defaults[0]?.providesGlobals).toEqual(["dayjs", "antd"]);
  });

  it("treats None as genuinely library-free", () => {
    expect(findCellPresetLibrary("None").providesGlobals).toEqual([]);
    expect(findCellPresetLibrary("None").scriptChain).toEqual([]);
  });

  it("loads ECharts through the runtime module loader, not a script URL", () => {
    const echarts = findCellPresetLibrary("ECharts");
    expect(echarts.runtimeModule).toBe("chart");
    expect(echarts.scriptChain).toEqual([]);
  });

  it("rejects unknown preset names", () => {
    // @ts-expect-error an unknown preset must not be accepted at the type level either
    expect(() => findCellPresetLibrary("Moment")).toThrow(/Unknown ReactCellType preset library/);
  });
});

describe("props and platform bridge", () => {
  it("records the base key order the runtime initialises props in", () => {
    expect(CELL_PROPS_BASE_KEYS).toEqual(["Forguncy", "Permissions", "ServerCommands", "ImageContext"]);
  });

  it("lists the Forguncy facade the target actually injects", () => {
    expect(CELL_FORGUNCY_PROP_KEYS).toContain("hasPermission");
    expect(CELL_FORGUNCY_PROP_KEYS).toContain("ConvertDateToOADate");
    expect(CELL_FORGUNCY_PROP_KEYS).toContain("exposeMethod");
  });

  it("distinguishes an unconfigured server command from a failing one", () => {
    expect(CELL_SERVER_COMMAND_RESULT_KEYS).toEqual(["errorCode", "errorMessage"]);
    expect(CELL_SERVER_COMMANDS_CONTRACT.unconfiguredNameType).toBe("undefined");
    expect(CELL_SERVER_COMMANDS_CONTRACT.unconfiguredCallOutcome).toContain("is not a function");
  });

  it("treats an unknown data source as an error state rather than a throw", () => {
    expect(CELL_DATA_SOURCE_CONTRACT.unknownSourceOutcome).toMatch(/error state/);
    expect(CELL_DATA_SOURCE_CONTRACT.resultFieldsDocumented).toEqual(
      expect.arrayContaining(CELL_DATA_SOURCE_CONTRACT.resultFieldsExecuted),
    );
  });
});

describe("frontend libraries", () => {
  it("keeps only the per-cell readiness guarantee", () => {
    expect(FRONTEND_LIBRARY_RUNTIME_SEMANTICS.perCellReadinessAwaited).toBe(true);
    expect(FRONTEND_LIBRARY_RUNTIME_SEMANTICS.loadOrderGuaranteed).toBe(false);
    expect(FRONTEND_LIBRARY_RUNTIME_SEMANTICS.crossCellReadinessGuaranteed).toBe(false);
  });

  it("states that extension globals are page-wide but bound per render instant", () => {
    expect(FRONTEND_LIBRARY_RUNTIME_SEMANTICS.globalsArePageWide).toBe(true);
    expect(FRONTEND_LIBRARY_RUNTIME_SEMANTICS.presetGlobalsBoundPerRenderInstant).toBe(true);
  });

  it("carries the reference shape as data, not as prose", () => {
    expect(Object.keys(FRONTEND_LIBRARY_REFERENCE_EXAMPLE)).toEqual(["libraryId"]);
  });
});

describe("cell source size", () => {
  it("claims no hard limit, because none was found", () => {
    expect(CELL_SOURCE_SIZE_OBSERVATIONS.hardCharacterLimit).toBeNull();
  });

  it("orders the two measurements so the notice threshold is bracketable", () => {
    expect(CELL_SOURCE_SIZE_OBSERVATIONS.transpilerNoticeNotObservedAtCharacters).toBeLessThan(
      CELL_SOURCE_SIZE_OBSERVATIONS.transpilerNoticeObservedAtCharacters,
    );
    expect(CELL_SOURCE_SIZE_OBSERVATIONS.largestAcceptedSourceCharacters).toBe(
      CELL_SOURCE_SIZE_OBSERVATIONS.transpilerNoticeObservedAtCharacters,
    );
  });

  // A budget that only produced a warning would be a style concern. It is
  // recorded as a gate because the project's acceptance check counts console
  // errors, and this notice is emitted at error level.
  it("records the transpiler notice at console error level", () => {
    expect(CELL_SOURCE_SIZE_OBSERVATIONS.transpilerNoticeConsoleLevel).toBe("error");
    expect(CELL_SOURCE_SIZE_OBSERVATIONS.transpilerNoticeMessage).toContain("500KB");
  });
});

describe("governing architecture decisions", () => {
  it("adds the runtime contract to the line a multi-Spec document carries", () => {
    expect(GOVERNING_ARCHITECTURE_SPEC_REFERENCE_LINE).toBe("Governing architecture Spec Issue(s): #4, #5");
    expect(citesEveryArchitectureDecision(GOVERNING_ARCHITECTURE_SPEC_REFERENCE_LINE)).toBe(true);
    expect(citesDecision(GOVERNING_ARCHITECTURE_SPEC_REFERENCE_LINE, RUNTIME_CONTRACT_DECISION)).toBe(true);
  });

  // The module is the projection of Issue #5, so it has to be able to say which
  // decision it came from without a document.
  it("has a URL that reads back as a citation of this decision", () => {
    expect(citesDecision(RUNTIME_CONTRACT_DECISION.url, RUNTIME_CONTRACT_DECISION)).toBe(true);
    expect(citesDecision(RUNTIME_CONTRACT_DECISION.url)).toBe(false);
  });
});
