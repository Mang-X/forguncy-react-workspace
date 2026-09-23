/**
 * The probe engine end-to-end against the committed fixture projects (#17).
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #16 (protocol validity, observing-step table, determinism,
 * no absolute paths, risks-vs-failures), #8 (fingerprint/cache invalidation and
 * the lock evidence this engine hands back), #4 (architecture conflicts are
 * ownership, not probe, findings — `assessDependencyRole` decides those).
 *
 * Local checks only: these tests execute the engine's build step through the
 * workspace Rolldown stack. They are not a Forguncy runtime validation.
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { ProbeReport } from "@forguncy-react-workspace/core";
import {
  assessDependencyRole,
  assessLockDecision,
  assessProbeReport,
  assertProbeReport,
  findForbiddenProbeKeys,
  forguncyTargetIdentity,
  lockProbeStatusForAssessment,
  PROBE_REPORT_SCHEMA_VERSION,
  PROBE_STEP_IDS,
  replacementRejectionFor,
  RUNTIME_CONTRACT_TARGET,
  serializeProbeReport,
  validateProbeReport,
} from "@forguncy-react-workspace/core";

import type { DependencyProbeResult, RunDependencyProbeOptions } from "./probe-engine";
import {
  ProbeIdentityError,
  probeLockEnvironment,
  probeRunLockEvidence,
  runDependencyProbe,
} from "./probe-engine";
import { probeCacheRelativePath } from "./cache";
import { composeProbeFingerprint } from "./fingerprint";

const FIXTURES_ROOT = fileURLToPath(new URL("../__fixtures__/probe", import.meta.url));

function fixture(name: string): string {
  return join(FIXTURES_ROOT, name);
}

async function probe(
  name: string,
  packageName: string,
  overrides: Partial<RunDependencyProbeOptions> = {},
): Promise<DependencyProbeResult> {
  return runDependencyProbe({
    projectRoot: fixture(name),
    packageName,
    cache: false,
    ...overrides,
  });
}

function validationByStep(report: ProbeReport): Map<string, string> {
  return new Map(report.validation.map(entry => [entry.step, entry.outcome]));
}

function riskSignals(report: ProbeReport): string[] {
  return report.risks.map(risk => risk.signal);
}

function rejectionSignals(report: ProbeReport): string[] {
  return report.rejectionFindings.map(finding => finding.signal);
}

describe("runDependencyProbe: report validity", () => {
  it("emits a protocol-valid report with all nine steps exactly once", async () => {
    const { report } = await probe("pure-esm-utility", "tiny-math");

    expect(validateProbeReport(report)).toEqual([]);
    assertProbeReport(report);
    expect(report.schemaVersion).toBe(PROBE_REPORT_SCHEMA_VERSION);
    expect(report.validation.map(entry => entry.step)).toEqual([...PROBE_STEP_IDS]);
    expect(findForbiddenProbeKeys(report)).toEqual([]);
    expect(report.environment.packageName).toBe("tiny-math");
    expect(report.environment.packageVersion).toBe("1.0.0");
    expect(report.environment.source).toBe("https://github.com/example/tiny-math");
  });

  it("keeps absolute fixture paths out of the serialized report", async () => {
    const { report } = await probe("pure-esm-utility", "tiny-math");
    const text = serializeProbeReport(report);
    const root = fixture("pure-esm-utility");

    expect(text).not.toContain(root);
    expect(text).not.toContain(root.split("\\").join("/"));
    // A leaked absolute path would still show a drive-letter or home path form.
    expect(text).not.toMatch(/[A-Za-z]:\\/);
    expect(text).not.toMatch(/\/Users\//);
    expect(text).not.toMatch(/\/home\//);
  });

  it("is byte-identical across two uncached runs of the same inputs", async () => {
    const first = await probe("pure-esm-utility", "tiny-math");
    const second = await probe("pure-esm-utility", "tiny-math");

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(serializeProbeReport(first.report)).toBe(serializeProbeReport(second.report));
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(false);
  });
});

describe("runDependencyProbe: pure ESM utility", () => {
  it("supports deployment with the positive signals as facts", async () => {
    const { report, assessment, lockStatus } = await probe("pure-esm-utility", "tiny-math");

    expect(assessment.status).toBe("supports-deployment");
    expect(lockStatus).toBe("passed");
    expect(rejectionSignals(report)).toEqual([]);
    expect(riskSignals(report)).toEqual([]);

    const facts = report.facts;
    expect(facts.some(fact => fact.name === "signal.no-node-builtins" && fact.value === true)).toBe(true);
    expect(facts.some(fact => fact.name === "exports.browser-resolvable" && fact.value === true)).toBe(true);
    expect(facts.some(fact => fact.name === "signal.self-contained-runtime-assets" && fact.value === true)).toBe(true);

    const outcomes = validationByStep(report);
    expect(outcomes.get("package-identity")).toBe("passed");
    expect(outcomes.get("export-metadata")).toBe("passed");
    expect(outcomes.get("node-builtin-scan")).toBe("passed");
    expect(outcomes.get("build")).toBe("passed");
    expect(outcomes.get("artifact-scan")).toBe("passed");
    expect(outcomes.get("asset-inventory")).toBe("passed");
    expect(outcomes.get("runtime-pattern-scan")).toBe("passed");
    expect(outcomes.get("size")).toBe("passed");
    // No browser in this toolchain: the honest record is a skip with a reason.
    expect(outcomes.get("runtime-smoke")).toBe("skipped");
    const smoke = report.validation.find(entry => entry.step === "runtime-smoke")!;
    expect(smoke.diagnostics).toEqual([]);
    expect(smoke.detail.length).toBeGreaterThan(0);
  });
});

describe("runDependencyProbe: react library", () => {
  it("records peer ranges and shipped types as facts, still supports deployment", async () => {
    const { report, assessment } = await probe("react-library", "@fixture/date-picker");

    expect(assessment.status).toBe("supports-deployment");
    expect(report.facts.some(fact => fact.name === "peerDependencies.ranges")).toBe(true);
    expect(report.facts.some(fact => fact.name === "exports.types-present" && fact.value === true)).toBe(true);
    expect(rejectionSignals(report)).toEqual([]);
  });
});

describe("runDependencyProbe: worker and wasm risks are risks, not failures", () => {
  it("keeps Worker/WASM as risks and still passes the static steps", async () => {
    const { report, assessment, lockStatus } = await probe("worker-wasm-risk", "heavy-parser");

    const outcomes = validationByStep(report);
    expect(outcomes.get("build")).toBe("passed");
    expect(outcomes.get("artifact-scan")).toBe("passed");
    expect(outcomes.get("runtime-pattern-scan")).toBe("passed");

    const signals = riskSignals(report);
    expect(signals).toContain("worker");
    expect(signals).toContain("import-meta-url-asset");
    // WASM may surface from artifact-scan (or asset-inventory); never as a rejection.
    expect(signals).toContain("wasm");
    expect(rejectionSignals(report)).toEqual([]);

    // Risks never turn a clean static report into a rejection-only one on their own.
    expect(assessment.status).toBe("supports-deployment");
    expect(lockStatus).toBe("passed");
    expect(assessment.risksToWeigh.length).toBeGreaterThan(0);
  });

  it("attributes worker risks to the observing steps the protocol allows", async () => {
    const { report } = await probe("worker-wasm-risk", "heavy-parser");

    for (const risk of report.risks) {
      expect(["artifact-scan", "runtime-pattern-scan", "asset-inventory"]).toContain(risk.step);
    }
    for (const finding of report.rejectionFindings) {
      expect(["artifact-scan", "runtime-pattern-scan", "asset-inventory"]).not.toContain(
        // no rejections expected here; guard against wasm being mis-filed
        finding.signal === "wasm" ? "runtime-pattern-scan" : "",
      );
    }
    expect(rejectionSignals(report)).toEqual([]);
  });
});

describe("runDependencyProbe: node-only package", () => {
  it("files the node-filesystem rejection and maps it to platform-api-unavailable", async () => {
    const { report, assessment, lockStatus } = await probe("node-only", "config-from-disk");

    const finding = report.rejectionFindings.find(
      entry => entry.signal === "node-filesystem-process-or-native-addon",
    );
    expect(finding).toBeDefined();
    expect(finding?.step).toBe("node-builtin-scan");
    expect(finding?.evidence.some(item => item.startsWith("builtin:"))).toBe(true);

    // Positive signal is absent when builtins were found.
    expect(report.facts.some(fact => fact.name === "signal.no-node-builtins" && fact.value === true)).toBe(false);

    expect(assessment.status).toBe("supports-rejection-only");
    expect(lockStatus).toBe("failed");
    expect(replacementRejectionFor("node-filesystem-process-or-native-addon", "config-from-disk")?.code).toBe(
      "platform-api-unavailable",
    );
    // The step succeeded at observing — a rejection is not a step failure.
    expect(validationByStep(report).get("node-builtin-scan")).toBe("passed");
  });

  it("detects a Node-only transitive dep nested only under the candidate", async () => {
    // `disk-reader` is installed solely under `clean-wrapper/node_modules/`;
    // the project root cannot resolve it. The scan must still walk it via
    // Node resolution from the candidate's directory.
    const { report, assessment } = await probe("nested-node-only", "clean-wrapper");

    const finding = report.rejectionFindings.find(
      entry => entry.signal === "node-filesystem-process-or-native-addon",
    );
    expect(finding).toBeDefined();
    expect(finding?.evidence).toContain("package:disk-reader@1.0.0");
    expect(report.facts.some(fact => fact.name === "signal.no-node-builtins" && fact.value === true)).toBe(false);

    const scanned = report.facts.find(fact => fact.name === "graph.packages-scanned")?.value;
    expect(scanned).toContain("disk-reader@1.0.0");
    expect(assessment.status).toBe("supports-rejection-only");
  });

  it("scans both installed versions of a same-named transitive package", async () => {
    // `shared-util@1.0.0` (clean) under branch-a and `shared-util@2.0.0`
    // (node-only) under branch-b: deduping by package *name* would skip the
    // second and miss the rejection.
    const { report } = await probe("multi-version-shared", "dual-branch");

    const scanned = report.facts.find(fact => fact.name === "graph.packages-scanned")?.value ?? [];
    expect(scanned).toContain("shared-util@1.0.0");
    expect(scanned).toContain("shared-util@2.0.0");

    const finding = report.rejectionFindings.find(
      entry => entry.signal === "node-filesystem-process-or-native-addon",
    );
    expect(finding).toBeDefined();
    expect(finding?.evidence).toContain("package:shared-util@2.0.0");
    expect(finding?.evidence).not.toContain("package:shared-util@1.0.0");
  });

  it("keeps a dependency whose package.json is not exported in the graph", async () => {
    // `sealed-package` uses a strict `exports` map without `./package.json`:
    // resolving the bare entry returns `lib/entry.js`, and appending
    // `package.json` to that path would silently drop the package.
    const { report } = await probe("strict-exports", "app-with-sealed");

    const scanned = report.facts.find(fact => fact.name === "graph.packages-scanned")?.value ?? [];
    expect(scanned).toContain("sealed-package@1.0.0");

    const finding = report.rejectionFindings.find(
      entry => entry.signal === "node-filesystem-process-or-native-addon",
    );
    expect(finding).toBeDefined();
    expect(finding?.evidence).toContain("package:sealed-package@1.0.0");
  });
});

/**
 * The three shapes that produced a false `platform-api-unavailable` on a real package.
 *
 * Each fixture is the minimum reduction of a package the first real-package probe
 * refused while its browser artifact contained no Node builtins. The synthetic
 * fixtures above never caught this because each of their packages has exactly one
 * entry file, so "every file in the tree" and "every file the browser build reaches"
 * happened to be the same set. These fixtures exist so that coincidence is no longer
 * load-bearing.
 *
 * Governing Spec: #16 — a rejection is a claim about the artifact the cell would
 * ship, and a claim made without looking at the artifact is not evidence.
 */
describe("runDependencyProbe: a Node build beside a browser build", () => {
  it("does not refuse a package whose Node entries are unreachable from its browser entry", async () => {
    // `@embedpdf/pdfium`'s shape: `index.browser.js` next to `index.js` /
    // `index.cjs`, where only the Node builds reach `fs`/`module`.
    const { report, assessment, lockStatus } = await probe("node-build-not-browser-entry", "dual-build");

    expect(rejectionSignals(report)).toEqual([]);
    expect(assessment.status).toBe("supports-deployment");
    expect(lockStatus).toBe("passed");

    // The positive signal is present precisely because the builtins were not reachable.
    expect(report.facts.some(fact => fact.name === "signal.no-node-builtins" && fact.value === true)).toBe(true);
    const specifiers = report.facts.find(fact => fact.name === "graph.node-only-specifiers")?.value;
    expect(specifiers).toEqual([]);

    // Coverage: the report says how much of the package it actually read, so
    // "nothing was found" cannot be confused with "nothing was looked at". This is
    // the distinction that was invisible while the step scanned whole directories.
    const reachable = report.facts.find(fact => fact.name === "graph.reachable-file-count")?.value;
    expect(reachable).toBe(1); // the browser entry, and only it
    // Nothing was dropped or unparseable, so the resolutions fact is empty.
    expect(report.facts.find(fact => fact.name === "graph.entry-resolutions")?.value).toEqual([]);
  });
});

describe("runDependencyProbe: an optional loader outside the entry graph", () => {
  it("does not report a Worker risk from a file the browser entry cannot reach", async () => {
    // `three`'s shape: draco/basis loaders under `examples/jsm/` that each construct a
    // Worker, none reachable from `build/three.module.js`.
    const { report, assessment } = await probe("unreachable-optional-loader", "engine-lib");

    expect(rejectionSignals(report)).toEqual([]);
    // The Worker lives in an exported-but-unentered subtree, so there is no risk to weigh.
    expect(riskSignals(report)).not.toContain("worker");
    expect(assessment.status).toBe("supports-deployment");
  });
});

describe("runDependencyProbe: builtins named only in comments", () => {
  it("does not refuse a package whose Node specifiers appear only in JSDoc examples", async () => {
    // `es-toolkit`'s shape, which produced both false positives at once: `node:fs`
    // inside a JSDoc `@example` on a reachable file, and a real `node:child_process`
    // behind the `./server` subpath the root entry never imports.
    const { report, assessment, lockStatus } = await probe("comment-only-builtins", "util-lib");

    expect(rejectionSignals(report)).toEqual([]);
    expect(report.facts.some(fact => fact.name === "signal.no-node-builtins" && fact.value === true)).toBe(true);
    expect(assessment.status).toBe("supports-deployment");
    expect(lockStatus).toBe("passed");
  });
});

/**
 * The artifact bound: which files a finding may be drawn from.
 *
 * Reaching a file and bundling it are different sets — rolldown drops a module whose bindings
 * are unused while the walk, which applies no tree-shaking, still reaches it — so a finding has
 * to be bounded by the artifact. These cases pin that bound and its bookkeeping fact.
 */
describe("runDependencyProbe: a finding is attributed to the package that contributed it", () => {
  it("names only the nested dependency whose own file carries the builtin", async () => {
    // `attribution-outer`'s directory contains the nested `attribution-inner`, so a containment
    // test alone matched both and the rejection named **both** packages. Measured: the evidence
    // listed `package:attribution-outer@1.0.0` for a builtin that only the nested package's
    // source imports — a claim about a package a reviewer would check and find nothing in.
    //
    // Two separate mechanisms had to agree for this: the file-to-package attribution (deepest
    // containing directory) and the contributor list (derived from the hits, not seeded with the
    // probed root).
    const { report, assessment } = await probe("nested-package-attribution", "attribution-outer");

    const finding = report.rejectionFindings.find(
      entry => entry.signal === "node-filesystem-process-or-native-addon",
    );
    expect(finding).toBeDefined();
    expect(finding?.evidence).toContain("package:attribution-inner@1.0.0");
    expect(finding?.evidence).not.toContain("package:attribution-outer@1.0.0");
    expect(assessment.status).toBe("supports-rejection-only");

    // The outer package is still walked — it is in the graph and its own files are scanned; it
    // simply contributes no hit.
    const scanned = report.facts.find(fact => fact.name === "graph.packages-scanned")?.value ?? [];
    expect(scanned).toContain("attribution-outer@1.0.0");
    expect(scanned).toContain("attribution-inner@1.0.0");
  });
});

describe("runDependencyProbe: files the build loaded by a path the root entry misses", () => {
  it("scans a dependency's exports-subpath file, which the artifact contains", async () => {
    // Reached only through `import "subpath-dep/sub"`: the dependency's own root entry resolves
    // to `clean.js`, so a walk from that entry never sees `native.js`. The artifact does contain
    // it, though, and `process.dlopen` is a call rather than an import — rolldown neither
    // resolves nor fails on it, so nothing else would have caught this. Measured before the
    // fix: `supports-deployment` with no rejection for an artifact that carries a `dlopen`.
    const { report, assessment } = await probe("dependency-subpath-native", "subpath-host");

    const finding = report.rejectionFindings.find(
      entry => entry.signal === "node-filesystem-process-or-native-addon",
    );
    expect(finding).toBeDefined();
    expect(finding?.evidence.some(item => item.includes("native.js"))).toBe(true);
    expect(assessment.status).toBe("supports-rejection-only");

    // The dependency's own root-entry file **is** reached but is not in the artifact — the build
    // loaded its `./sub` file instead — so the coverage fact has to count it. An earlier assertion
    // here expected `0`, which froze a bug: the count was computed by subtracting cardinalities,
    // and in this fixture the reachable set `{clean.js}` and the scanned set `{native.js}` are
    // both length 1, so the difference read as nothing had been dropped. That is the one fact a
    // reader consults to understand why the walk and the artifact disagree, so it has to be a
    // set difference rather than a subtraction.
    expect(report.facts.find(fact => fact.name === "graph.files-shaken-out")?.value).toBe(1);
  });

  it("follows a `browser` redirect to the shim the build actually loads", async () => {
    // `{"browser": {"fs": "./fs-shim.js"}}` means the browser build loads the shim, not `fs`.
    // Treating the specifier as merely "redirected away" left the shim unscanned, and the
    // `node:fs` it imports was never seen — measured as `supports-rejection-only` with an
    // empty `rejectionFindings`, the state that justifies neither deployment nor a refusal.
    const { report, assessment } = await probe("browser-redirect-native", "redirect-host");

    const finding = report.rejectionFindings.find(
      entry => entry.signal === "node-filesystem-process-or-native-addon",
    );
    expect(finding).toBeDefined();
    expect(assessment.status).toBe("supports-rejection-only");
  });
});

describe("runDependencyProbe: the artifact bound's path tests", () => {
  it("keeps a real package directory named `.fgc` inside the bound", async () => {
    // The bound's containment test must not special-case `.fgc` by name. The probe's scratch
    // directory sits at the *project* root, so it never appears under the package — an
    // exclusion by name can therefore only drop real package files. Measured: a package
    // shipping `src/.fgc/x.js` was bundled by rolldown, contained a `dlopen`, and the engine
    // reported `supports-deployment` with no rejection.
    const { report, assessment } = await probe("dot-fgc-directory", "dot-fgc");

    const finding = report.rejectionFindings.find(
      entry => entry.signal === "node-filesystem-process-or-native-addon",
    );
    expect(finding).toBeDefined();
    expect(finding?.evidence.some(item => item.includes("src/.fgc/x.js"))).toBe(true);
    expect(assessment.status).toBe("supports-rejection-only");
    // And the file is not miscounted as shaken out.
    expect(report.facts.find(fact => fact.name === "graph.files-shaken-out")?.value).toBe(0);
  });

  it("treats a file whose name begins with `..` as inside the package", async () => {
    // `..` is a path *segment*, not a string prefix. A bare `startsWith("..")` classified
    // `./..helper.js` — a real relative import of a file the package ships — as escaped, so
    // the walk reported a false `escapedSpecifiers` entry and never filed the rejection for
    // the builtin inside it, while rolldown bundled it.
    const { report, assessment } = await probe("dotdot-filename", "dotdot-name");

    const finding = report.rejectionFindings.find(
      entry => entry.signal === "node-filesystem-process-or-native-addon",
    );
    expect(finding).toBeDefined();
    expect(assessment.status).toBe("supports-rejection-only");
    expect(report.facts.find(fact => fact.name === "graph.entry-resolutions")?.value).toEqual([]);
  });

  it("bounds a transitive dependency by the artifact too", async () => {
    // The bound has to answer for **every** graph member, not only the probed package: a
    // dependency is bundled or dropped by the same build. Bounding only the root left a
    // shaken-out dependency's `dlopen` producing a rejection — the same false rejection, one
    // level of graph indirection out. `dep-lib` is declared and imported but its binding is
    // unused, so rolldown drops it.
    const { report, assessment } = await probe("shaken-out-dependency", "shaken-dep");

    expect(rejectionSignals(report)).toEqual([]);
    expect(assessment.status).toBe("supports-deployment");
    expect(report.facts.find(fact => fact.name === "graph.files-shaken-out")?.value).toBe(1);
    expect(report.facts.some(fact => fact.name === "signal.no-node-builtins" && fact.value === true)).toBe(true);
  });
});

describe("runDependencyProbe: findings are bounded by the artifact", () => {
  it("does not report a native indicator from a file the bundle does not contain", async () => {
    // `process.dlopen` is reached through no import, so rolldown neither resolves nor fails on
    // it — it simply drops the module. Measured before the bound: build passed, the artifact
    // contained no `dlopen`, and the report refused the package for a native addon.
    const { report, assessment } = await probe("shaken-out-native", "shaken-native");

    expect(rejectionSignals(report)).toEqual([]);
    expect(assessment.status).toBe("supports-deployment");
    expect(report.facts.find(fact => fact.name === "graph.files-shaken-out")?.value).toBe(1);
    expect(report.facts.some(fact => fact.name === "signal.no-node-builtins" && fact.value === true)).toBe(true);
  });

  it("does not report a Worker risk from a file the bundle does not contain", async () => {
    const { report, assessment } = await probe("shaken-out-worker", "shaken-worker");

    expect(riskSignals(report)).not.toContain("worker");
    expect(assessment.status).toBe("supports-deployment");
    expect(report.facts.find(fact => fact.name === "runtime.files-shaken-out")?.value).toBe(1);
  });

  it("still reports the same findings when the file is kept in the bundle", async () => {
    // The control: `export *` keeps the module, so the rejection stands. Without this, a bound
    // that suppressed everything would pass the two cases above.
    const { report, assessment } = await probe("kept-native", "kept-native");

    const finding = report.rejectionFindings.find(
      entry => entry.signal === "node-filesystem-process-or-native-addon",
    );
    expect(finding).toBeDefined();
    // The evidence names the file, which is what makes the claim checkable.
    expect(finding?.evidence.some(item => item.includes("w.js"))).toBe(true);
    expect(assessment.status).toBe("supports-rejection-only");
    expect(report.facts.find(fact => fact.name === "graph.files-shaken-out")?.value).toBe(0);
  });

  it("keeps a file whose name contains `.fgc` inside the bound", async () => {
    // The scratch-directory exclusion is a path *segment* test. A substring check dropped
    // `.fgc-helper.js` from the bound while rolldown had it in the bundle, which made
    // `graph.files-shaken-out` claim a drop that had not happened.
    const { report } = await probe("fgc-in-name", "fgc-name");

    expect(report.facts.find(fact => fact.name === "graph.files-shaken-out")?.value).toBe(0);
    expect(report.facts.find(fact => fact.name === "runtime.files-shaken-out")?.value).toBe(0);
  });
});

describe("runDependencyProbe: the reachability rule still catches a real Node dependency", () => {
  it("keeps filing the rejection when a reachable file genuinely needs a builtin", async () => {
    // The fix must not be a blanket amnesty: `config-from-disk`'s builtin is in the
    // file its entry imports, so it is exactly as rejected as it was before.
    const { report, assessment } = await probe("node-only", "config-from-disk");

    const finding = report.rejectionFindings.find(
      entry => entry.signal === "node-filesystem-process-or-native-addon",
    );
    expect(finding).toBeDefined();
    expect(finding?.step).toBe("node-builtin-scan");
    expect(assessment.status).toBe("supports-rejection-only");
  });

  it("withholds the clean bill of health when no browser entry could be reached", async () => {
    // The blanket-amnesty shape an adversarial review found: a server-only package that
    // attaches a `browser` field. `export-metadata` used to count the bare field as
    // proof of browser-resolvability while the entry resolution (correctly) named no
    // browser-executable root, so the dependency step reached zero files and reported
    // `no-node-builtins: true` — a clean result drawn from an empty set, on a package
    // whose only source file imports `node:fs`.
    //
    // With the two steps agreeing, `export-metadata` files the rejection it should. The
    // assertions here cover this step's half: it must not claim a clean scan when it
    // reached nothing.
    const { report, assessment } = await probe("unreachable-no-browser-entry", "server-only");

    expect(assessment.status).not.toBe("supports-deployment");

    const noBuiltins = report.facts.find(fact => fact.name === "signal.no-node-builtins");
    expect(noBuiltins?.value).toBe(false);
    expect(report.facts.find(fact => fact.name === "scan.no-reachable-source")?.value).toBe(true);
    expect(report.facts.find(fact => fact.name === "graph.reachable-file-count")?.value).toBe(0);

    // The rejection comes from the step that can answer the question from the manifest.
    expect(report.rejectionFindings.map(finding => finding.signal)).toContain(
      "ssr-or-server-only-without-browser-build",
    );
  });

  it("follows the package's own name through its exports map, as a bundler does", async () => {
    // The third shape, and the one that would have been a false *negative*: a root
    // entry that re-exports from its own `./server` subpath. Node and every bundler
    // resolve a self-reference through the package's `exports` map, so a walk that
    // followed only `./` and `../` reached the entry alone and filed no finding —
    // even though the build itself fails on the builtin it never looked at.
    //
    // A false negative is the more dangerous direction of the two: the report neither
    // supported deployment nor justified a rejection, so no decision was recordable.
    const { report, assessment } = await probe("self-referencing-subpath", "self-ref-lib");

    const finding = report.rejectionFindings.find(
      entry => entry.signal === "node-filesystem-process-or-native-addon",
    );
    expect(finding).toBeDefined();
    expect(finding?.evidence).toContain("builtin:node:child_process");
    expect(assessment.status).toBe("supports-rejection-only");

    // Both files, not just the entry: the self-reference was followed.
    expect(report.facts.find(fact => fact.name === "graph.reachable-file-count")?.value).toBe(2);
  });
});

describe("runDependencyProbe: broken build", () => {
  it("fails the build with actionable, portable diagnostics and cascades skips", async () => {
    const { report, assessment, lockStatus } = await probe("broken-build", "broken-widget");

    const build = report.validation.find(entry => entry.step === "build")!;
    expect(build.outcome).toBe("failed");
    expect(build.diagnostics.length).toBeGreaterThan(0);
    expect(build.diagnostics.every(line => line.trim().length > 0)).toBe(true);
    expect(build.detail.length).toBeGreaterThan(0);

    const outcomes = validationByStep(report);
    expect(outcomes.get("artifact-scan")).toBe("skipped");
    expect(outcomes.get("asset-inventory")).toBe("skipped");
    expect(outcomes.get("size")).toBe("skipped");
    // Source is still readable: this step does not cascade into a skip.
    expect(outcomes.get("runtime-pattern-scan")).toBe("passed");
    // Runtime smoke skipped with a reason pointing at the failed required step.
    expect(outcomes.get("runtime-smoke")).toBe("skipped");

    // A skip carries no findings, so the cascade invents nothing about an
    // artifact that was never produced.
    const skipped = report.validation.filter(entry => entry.outcome === "skipped");
    expect(skipped.every(entry => entry.diagnostics.length === 0)).toBe(true);
    expect(
      report.rejectionFindings.every(finding => finding.step !== "artifact-scan" && finding.step !== "size"),
    ).toBe(true);

    expect(assessment.status).toBe("supports-rejection-only");
    expect(assessment.failedSteps).toContain("build");
    expect(lockStatus).toBe("failed");
    // Diagnostics must not leak absolute paths even on failure.
    const text = serializeProbeReport(report);
    expect(text).not.toContain(fixture("broken-build"));
  });
});

describe("runDependencyProbe: budget", () => {
  it("files cell-artifact-budget-exceeded while the size step still passes", async () => {
    const { report, assessment } = await probe("pure-esm-utility", "tiny-math", {
      cellArtifactBudgetBytes: 4,
    });

    const size = report.validation.find(entry => entry.step === "size")!;
    expect(size.outcome).toBe("passed");
    const finding = report.rejectionFindings.find(entry => entry.signal === "cell-artifact-budget-exceeded");
    expect(finding?.step).toBe("size");
    expect(assessment.status).toBe("supports-rejection-only");
    expect(assessment.rejectionFindings.map(entry => entry.signal)).toContain("cell-artifact-budget-exceeded");
  });

  it("keeps the budget out of a second run's fingerprint when it is not declared", async () => {
    const withoutBudget = await probe("pure-esm-utility", "tiny-math");
    const withBudget = await probe("pure-esm-utility", "tiny-math", { cellArtifactBudgetBytes: 1_000_000 });

    expect(withoutBudget.fingerprint).not.toBe(withBudget.fingerprint);
    expect(withBudget.fingerprint).toContain("budget");
  });
});

describe("runDependencyProbe: cache", () => {
  // A prior run's `.fgc/probe-cache/` would make the first assertion a lie:
  // these tests own a cold start, so they clear the fixture's scratch space.
  it("serves a byte-identical report from the file cache on the second run", async () => {
    const projectRoot = fixture("pure-esm-utility");
    await rm(join(projectRoot, ".fgc"), { recursive: true, force: true });

    const first = await runDependencyProbe({ projectRoot, packageName: "tiny-math" });
    expect(first.fromCache).toBe(false);

    const second = await runDependencyProbe({ projectRoot, packageName: "tiny-math" });
    expect(second.fromCache).toBe(true);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(serializeProbeReport(second.report)).toBe(serializeProbeReport(first.report));
    expect(second.cacheRelativePath).toBe(probeCacheRelativePath(first.fingerprint));
    expect(second.cacheRelativePath.startsWith(".fgc/probe-cache/")).toBe(true);
  });

  it("re-probes when the declared fingerprint inputs change", async () => {
    const projectRoot = fixture("pure-esm-utility");
    await rm(join(projectRoot, ".fgc"), { recursive: true, force: true });
    await runDependencyProbe({ projectRoot, packageName: "tiny-math", cache: false });

    const changed = await runDependencyProbe({
      projectRoot,
      packageName: "tiny-math",
      probeId: "amd-detect",
    });

    expect(changed.fromCache).toBe(false);
    expect(changed.fingerprint).toContain('probe="amd-detect"');
  });

  it("treats a corrupt cache file as a miss", async () => {
    const projectRoot = fixture("pure-esm-utility");
    await rm(join(projectRoot, ".fgc"), { recursive: true, force: true });
    const first = await runDependencyProbe({ projectRoot, packageName: "tiny-math" });
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = join(projectRoot, ...first.cacheRelativePath.split("/"));
    await mkdir(join(projectRoot, ".fgc", "probe-cache"), { recursive: true });
    await writeFile(path, "not json", "utf8");

    const second = await runDependencyProbe({ projectRoot, packageName: "tiny-math" });
    expect(second.fromCache).toBe(false);
    expect(serializeProbeReport(second.report)).toBe(serializeProbeReport(first.report));
  });

  it("re-probes when a runtime-smoke hook is supplied over a cached hookless report", async () => {
    const projectRoot = fixture("pure-esm-utility");
    await rm(join(projectRoot, ".fgc"), { recursive: true, force: true });

    const first = await runDependencyProbe({ projectRoot, packageName: "tiny-math" });
    expect(first.fromCache).toBe(false);
    expect(first.report.validation.find(entry => entry.step === "runtime-smoke")?.outcome).toBe("skipped");

    let hookRan = false;
    const second = await runDependencyProbe({
      projectRoot,
      packageName: "tiny-math",
      runtimeSmoke: () => {
        hookRan = true;
        return { facts: [{ name: "smoke.ran", value: true }] };
      },
    });

    expect(hookRan).toBe(true);
    expect(second.fromCache).toBe(false);
    expect(second.report.validation.find(entry => entry.step === "runtime-smoke")?.outcome).toBe("passed");
    expect(second.report.facts.some(fact => fact.name === "smoke.ran")).toBe(true);
  });

  it("does not let a hooked run answer a later hookless run", async () => {
    // Smoke mode is not in the fingerprint. A hooked report must never be
    // written under the shared key, or the hookless run would inherit
    // runtime-smoke: passed plus any hook-added findings it never requested.
    const projectRoot = fixture("pure-esm-utility");
    await rm(join(projectRoot, ".fgc"), { recursive: true, force: true });

    const hooked = await runDependencyProbe({
      projectRoot,
      packageName: "tiny-math",
      runtimeSmoke: () => ({
        facts: [{ name: "smoke.ran", value: true }],
        rejectionFindings: [
          {
            signal: "host-module-identity-mismatch-observed",
            summary: "Hook-only rejection that must not leak.",
            evidence: ["runtime-smoke"],
          },
        ],
      }),
    });
    expect(hooked.fromCache).toBe(false);
    expect(hooked.report.validation.find(entry => entry.step === "runtime-smoke")?.outcome).toBe("passed");

    const hookless = await runDependencyProbe({ projectRoot, packageName: "tiny-math" });
    expect(hookless.fromCache).toBe(false);
    expect(hookless.report.validation.find(entry => entry.step === "runtime-smoke")?.outcome).toBe("skipped");
    expect(hookless.report.facts.some(fact => fact.name === "smoke.ran")).toBe(false);
    expect(hookless.report.rejectionFindings.some(finding => finding.summary.includes("Hook-only"))).toBe(false);
  });

  it("re-probes when a different package shares the fingerprint via a custom entry", async () => {
    // `entry` is overridable and part of the fingerprint, so two same-version
    // packages can collide on one key. The cached environment must name this
    // package before it answers.
    const projectRoot = fixture("pure-esm-utility");
    await rm(join(projectRoot, ".fgc"), { recursive: true, force: true });

    const first = await runDependencyProbe({
      projectRoot,
      packageName: "tiny-math",
      entry: "shared-probe-entry",
    });
    expect(first.fromCache).toBe(false);
    expect(first.report.environment.packageName).toBe("tiny-math");

    const second = await runDependencyProbe({
      projectRoot,
      packageName: "tiny-strings",
      entry: "shared-probe-entry",
    });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.fromCache).toBe(false);
    expect(second.report.environment.packageName).toBe("tiny-strings");
    expect(second.report.environment.packageVersion).toBe("1.0.0");
  });

  it("re-probes when the toolchain differs from the cached report", async () => {
    const projectRoot = fixture("pure-esm-utility");
    await rm(join(projectRoot, ".fgc"), { recursive: true, force: true });

    const first = await runDependencyProbe({
      projectRoot,
      packageName: "tiny-math",
      toolchain: { vitePlus: "0.0.1" },
    });
    expect(first.fromCache).toBe(false);
    expect(first.report.environment.toolchain.vitePlus).toBe("0.0.1");

    // Same fingerprint (toolchain is excluded from the lock fingerprint), but
    // the cached environment must not answer a different toolchain.
    const second = await runDependencyProbe({
      projectRoot,
      packageName: "tiny-math",
      toolchain: { vitePlus: "9.9.9" },
    });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.fromCache).toBe(false);
    expect(second.report.environment.toolchain.vitePlus).toBe("9.9.9");
  });

  it("re-probes when the target differs from the cached report", async () => {
    const projectRoot = fixture("pure-esm-utility");
    await rm(join(projectRoot, ".fgc"), { recursive: true, force: true });

    const first = await runDependencyProbe({ projectRoot, packageName: "tiny-math" });
    expect(first.fromCache).toBe(false);

    const otherTarget = { ...forguncyTargetIdentity(RUNTIME_CONTRACT_TARGET), productBuild: "other" };
    const second = await runDependencyProbe({
      projectRoot,
      packageName: "tiny-math",
      target: otherTarget,
    });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.fromCache).toBe(false);
    expect(second.report.environment.target?.productBuild).toBe("other");
  });
});

describe("runDependencyProbe: runtime smoke", () => {
  it("runs a supplied hook, re-stamps its findings, and passes the step", async () => {
    const { report } = await probe("pure-esm-utility", "tiny-math", {
      runtimeSmoke: () => ({
        facts: [{ name: "smoke.mounted", value: true }],
        risks: [{ signal: "global-singleton-assumption", summary: "React identity assumed.", evidence: ["page"] }],
      }),
    });

    const smoke = report.validation.find(entry => entry.step === "runtime-smoke")!;
    expect(smoke.outcome).toBe("passed");
    expect(smoke.detail).toContain("fact(s)");
    expect(report.facts.some(fact => fact.step === "runtime-smoke" && fact.name === "smoke.mounted")).toBe(true);
    expect(
      report.risks.some(risk => risk.step === "runtime-smoke" && risk.signal === "global-singleton-assumption"),
    ).toBe(true);
    expect(validateProbeReport(report)).toEqual([]);
  });

  it("fails the step with the thrown message as diagnostics", async () => {
    const { report, assessment } = await probe("pure-esm-utility", "tiny-math", {
      runtimeSmoke: () => {
        throw new Error("browser unavailable\nsecond line");
      },
    });

    const smoke = report.validation.find(entry => entry.step === "runtime-smoke")!;
    expect(smoke.outcome).toBe("failed");
    expect(smoke.diagnostics).toEqual(["browser unavailable", "second line"]);
    // runtime-smoke is not deployment-required; a thrown smoke does not by
    // itself block supports-deployment when every static step passed.
    expect(assessment.failedSteps).toContain("runtime-smoke");
    expect(validateProbeReport(report)).toEqual([]);
  });

  it("awaits an async hook", async () => {
    const { report } = await probe("pure-esm-utility", "tiny-math", {
      runtimeSmoke: async () => ({ facts: [{ name: "smoke.async", value: true }] }),
    });

    expect(report.facts.some(fact => fact.name === "smoke.async")).toBe(true);
    expect(report.validation.find(entry => entry.step === "runtime-smoke")?.outcome).toBe("passed");
  });

  it("hands the hook a pre-smoke report: eight steps, not a complete nine-step report", async () => {
    let seen: { step: string; outcome: string }[] = [];
    await probe("pure-esm-utility", "tiny-math", {
      runtimeSmoke: ({ report }) => {
        seen = report.validation.map(entry => ({ step: entry.step, outcome: entry.outcome }));
        return {};
      },
    });

    expect(seen).toHaveLength(8);
    expect(seen.map(entry => entry.step)).not.toContain("runtime-smoke");
    // The eight static steps are already complete when the hook runs.
    expect(seen.every(entry => entry.outcome === "passed" || entry.outcome === "failed" || entry.outcome === "skipped")).toBe(
      true,
    );
  });
});

describe("runDependencyProbe: identity failures throw", () => {
  it("throws ProbeIdentityError for a package that is not installed", async () => {
    await expect(probe("pure-esm-utility", "definitely-not-installed")).rejects.toBeInstanceOf(ProbeIdentityError);
    await expect(probe("pure-esm-utility", "definitely-not-installed")).rejects.toMatchObject({
      reason: "not-installed",
      packageName: "definitely-not-installed",
    });
  });
});

describe("architecture conflict is ownership, not a probe finding (#4 vs #16)", () => {
  it("probes react-router-dom cleanly while assessDependencyRole rejects the role", async () => {
    const { report, assessment } = await probe("architecture-conflict", "react-router-dom");

    // The probe reports only artifact observations: no rejection findings, steps pass.
    expect(validateProbeReport(report)).toEqual([]);
    expect(rejectionSignals(report)).toEqual([]);
    expect(assessment.status).toBe("supports-deployment");
    expect(assessment.rejectionFindings).toEqual([]);

    // Ownership is a separate gate. A clean probe must not excuse it.
    const ownership = assessDependencyRole({ packageName: "react-router-dom", role: "application-navigation" });
    expect(ownership.status).toBe("platform-conflict");
    expect(ownership).toMatchObject({
      status: "platform-conflict",
      packageName: "react-router-dom",
      role: "application-navigation",
    });
    if (ownership.status === "platform-conflict") {
      expect(ownership.rejection.kind).toBe("architectural");
    }
  });
});

describe("lock integration (#8)", () => {
  it("produces lock evidence with versionIndependent false for a passed run", async () => {
    const result = await probe("pure-esm-utility", "tiny-math");
    const evidence = probeRunLockEvidence(result);

    expect(evidence).toEqual({
      status: "passed",
      fingerprint: result.fingerprint,
      versionIndependent: false,
    });
    expect(evidence?.fingerprint).toBe(
      composeProbeFingerprint({ probeId: "inline-bundle", entry: "tiny-math" }).fingerprint,
    );
  });

  it("returns null lock evidence when the assessment is inconclusive", () => {
    expect(
      probeRunLockEvidence({ fingerprint: "probe=x;entry=y", lockStatus: null }),
    ).toBeNull();
  });

  it("maps assessments to #8 statuses through lockProbeStatusForAssessment", async () => {
    const passed = await probe("pure-esm-utility", "tiny-math");
    const rejected = await probe("node-only", "config-from-disk");

    expect(lockProbeStatusForAssessment(assessProbeReport(passed.report))).toBe("passed");
    expect(lockProbeStatusForAssessment(assessProbeReport(rejected.report))).toBe("failed");
    expect(lockProbeStatusForAssessment(assessProbeReport({
      ...passed.report,
      validation: passed.report.validation.map(entry =>
        entry.step === "runtime-pattern-scan" ? { ...entry, outcome: "skipped" as const } : entry,
      ),
      rejectionFindings: [],
      risks: [],
    }))).toBeNull();
  });

  it("builds a LockEnvironment whose probeFingerprints drive freshness", async () => {
    const result = await probe("pure-esm-utility", "tiny-math");
    const environment = await probeLockEnvironment(fixture("pure-esm-utility"), {
      lock: {
        schemaVersion: 1,
        decisions: [
          {
            strategy: "inline",
            packageName: "tiny-math",
            cellTarget: null,
            resolvedVersion: "1.0.0",
            probe: probeRunLockEvidence(result)!,
            target: forguncyTargetIdentity(RUNTIME_CONTRACT_TARGET),
            probedWith: { vitePlus: null },
            extension: null,
            rejectedCandidate: null,
            rationale: null,
            evidence: [
              {
                kind: "spec-issue",
                reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/8",
              },
            ],
          },
        ],
      },
      probeFingerprints: { "tiny-math": result.fingerprint },
    });

    expect(environment.probeFingerprints["tiny-math"]).toBe(result.fingerprint);
    expect(environment.resolvedVersions["tiny-math"]).toBe("1.0.0");
    expect(environment.target).toEqual(RUNTIME_CONTRACT_TARGET);

    const { findLockDecision } = await import("@forguncy-react-workspace/core");
    const record = findLockDecision(
      {
        decisions: [
          {
            strategy: "inline",
            packageName: "tiny-math",
            cellTarget: null,
            resolvedVersion: "1.0.0",
            probe: probeRunLockEvidence(result)!,
            target: forguncyTargetIdentity(RUNTIME_CONTRACT_TARGET),
            probedWith: { vitePlus: null },
            extension: null,
            rejectedCandidate: null,
            rationale: null,
            evidence: [
              {
                kind: "spec-issue",
                reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/8",
              },
            ],
          },
        ],
      },
      { packageName: "tiny-math" },
    );
    expect(record).not.toBeNull();
    expect(assessLockDecision(record!, environment).freshness).toBe("fresh");
    expect(assessLockDecision(record!, environment).stalenessReasons).toEqual([]);

    const moved = await probeLockEnvironment(fixture("pure-esm-utility"), {
      probeFingerprints: { "tiny-math": "probe=inline-bundle;entry=other" },
      lock: {
        schemaVersion: 1,
        decisions: [
          {
            strategy: "inline",
            packageName: "tiny-math",
            cellTarget: null,
            resolvedVersion: "1.0.0",
            probe: probeRunLockEvidence(result)!,
            target: forguncyTargetIdentity(RUNTIME_CONTRACT_TARGET),
            probedWith: { vitePlus: null },
            extension: null,
            rejectedCandidate: null,
            rationale: null,
            evidence: [
              {
                kind: "spec-issue",
                reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/8",
              },
            ],
          },
        ],
      },
    });
    const changed = assessLockDecision(record!, moved);
    expect(changed.freshness).toBe("stale");
    expect(changed.stalenessReasons).toContain("probe-fingerprint-changed");

    const unknown = await probeLockEnvironment(fixture("pure-esm-utility"), {
      probeFingerprints: {},
      lock: {
        schemaVersion: 1,
        decisions: [
          {
            strategy: "inline",
            packageName: "tiny-math",
            cellTarget: null,
            resolvedVersion: "1.0.0",
            probe: probeRunLockEvidence(result)!,
            target: forguncyTargetIdentity(RUNTIME_CONTRACT_TARGET),
            probedWith: { vitePlus: null },
            extension: null,
            rejectedCandidate: null,
            rationale: null,
            evidence: [
              {
                kind: "spec-issue",
                reference: "https://github.com/Mang-X/forguncy-react-workspace/issues/8",
              },
            ],
          },
        ],
      },
    });
    const missing = assessLockDecision(record!, unknown);
    expect(missing.stalenessReasons).toContain("probe-fingerprint-unknown");
  });
});
