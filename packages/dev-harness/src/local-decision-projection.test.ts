import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { RUNTIME_CONTRACT_TARGET } from "@forguncy-react-workspace/core";
import { readFgcLock, resolveInstalledVersions } from "@forguncy-react-workspace/dependency-resolver/local";

import {
  DEFAULT_LOCAL_EXTENSION_CATALOG,
  LOCAL_DEV_UNOBSERVABLE_STALENESS_REASONS,
  installedToolchain,
  projectLocalDecisions,
} from "./local-decision-projection.ts";
import { removeTempProject } from "./temp-project.ts";

/**
 * The validity projection, at the level review asked for: what the compiler's own pipeline does to a
 * lock, and where this process stops being able to mirror it.
 *
 * Decision sources: GitHub Issues
 * - #23 — "Implement: Vite+ local React Cell dev harness with HMR"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/23)
 * - #8 — "Spec: reproducible dependency decisions and `fgc.lock.json`"
 *   (https://github.com/Mang-X/forguncy-react-workspace/issues/8)
 *
 * ## What the finding was, and why the tests are shaped this way
 *
 * The harness ran only the *target* projection and treated every selected record as active. The
 * compiler does more: it conformance-audits the lock and then withholds records whose evidence is
 * stale, and `compileCell` **refuses** an artifact whose decision was withheld
 * (`unresolved-dependency-decision`). So the local loop could substitute for a dependency the
 * compiler would not compile, giving a green render for an artifact that cannot exist.
 *
 * The measurement that shapes the design is `extension-query`'s real lock projected with only what a
 * local process can observe: every `extension` record comes back withheld, because an extension's
 * version and identity are a page's answer. Applying the compiler's rule literally would therefore
 * drop every extension decision and let a Cell resolve silently through npm — the first defect in
 * this line of work, restored. The tests below pin both halves: what this process *can* judge
 * decides, and what it cannot is reported rather than either withholding or ignoring.
 *
 * ## The fixtures install what they record
 *
 * `package-version-unknown` is a locally-observable reason, so a lock naming a package the project
 * does not have is withheld for a real reason — and a fixture like that would test the withholding
 * path while claiming to test something else. Each fixture therefore installs its recorded package
 * at the recorded version, which is what a real project's tree has. That is also why the first
 * version of this file's `package-version-changed` test works by installing the *wrong* version: the
 * reason it asserts cannot be produced any other way.
 */
const RECORDED_VERSION = "5.102.8";

/** A temp project whose lock records one `extension` decision, with the package installed. */
async function projectWithDecision(overrides: {
  readonly decision?: Record<string, unknown>;
  readonly installedVersion?: string;
} = {}): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "dev-harness-projection-"));
  onTestFinished(() => removeTempProject(root));

  // The lockfile is written **first**, before the identity below is read. #94 reads identity from
  // the install graph, so a lockfile created afterwards would make the recorded `probedWith` say
  // "no lockfile" while the environment the projection compares against says otherwise — and the
  // fixture would report `install-graph-changed` for a project where nothing moved. The content is
  // irrelevant: the digest is over bytes, and both sides read the same file.
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

  const base = {
    packageName: "@tanstack/react-query",
    cellTarget: null,
    strategy: "extension",
    resolvedVersion: RECORDED_VERSION,
    globalName: "TanStackQuery",
    libraryId: "tanstack-query",
    probe: { status: "passed", fingerprint: "probe=x", versionIndependent: false },
    target: {
      product: "Forguncy",
      productVersion: "12.0.100.0",
      // The contract's own build, because a record's `target` is compared field-by-field against it
      // and any other value is `forguncy-target-changed` — a real finding about a real drift, and a
      // fixture using a placeholder build would be asserting that instead of the case it names.
      productBuild: RUNTIME_CONTRACT_TARGET.productBuild,
      hostReactVersion: RUNTIME_CONTRACT_TARGET.hostReactVersion,
    },
    // The toolchain the fixture records is the one this process reports, so the axis compares equal
    // rather than manufacturing `toolchain-changed`.
    probedWith: await installedToolchain(root),
    extension: { version: RECORDED_VERSION, identity: "sha256:aa" },
    rejectedCandidate: null,
    rationale: "fixture",
    evidence: [{ kind: "runtime-observation", reference: "https://example.invalid/r.md" }],
  };

  writeFileSync(
    join(root, "fgc.lock.json"),
    JSON.stringify({ schemaVersion: 1, decisions: [{ ...base, ...overrides.decision }] }),
    "utf8",
  );

  mkdirSync(join(root, "node_modules", "@tanstack", "react-query"), { recursive: true });
  writeFileSync(
    join(root, "node_modules", "@tanstack", "react-query", "package.json"),
    JSON.stringify({
      name: "@tanstack/react-query",
      version: overrides.installedVersion ?? RECORDED_VERSION,
      type: "module",
      main: "index.js",
    }),
    "utf8",
  );
  writeFileSync(join(root, "node_modules", "@tanstack", "react-query", "index.js"), "export const STUB = true;\n", "utf8");

  return root;
}

/** The projection, over a fixture's lock, with the axes a local process can actually supply. */
async function project(root: string, cellTarget: string | null = null) {
  const lock = await readFgcLock(root);
  const { versions } = await resolveInstalledVersions(root, lock.decisions.map(record => record.packageName));

  return projectLocalDecisions({
    lock,
    cellTarget,
    resolvedVersions: versions,
    target: RUNTIME_CONTRACT_TARGET,
    toolchain: await installedToolchain(root),
  });
}

describe("a record this process cannot fully judge is kept and reported, not withheld", () => {
  it("keeps a valid extension decision whose only unobservable evidence is the page's", async () => {
    const projection = await project(await projectWithDecision());

    // Kept, which is the whole design decision: withholding here would drop every extension decision
    // on every project and let the Cell resolve through npm instead.
    expect(projection.decisions.map(decision => decision.packageName)).toEqual(["@tanstack/react-query"]);
    expect(projection.withheld).toEqual([]);

    // And reported, naming the axes rather than saying "some evidence" — the reasons are the
    // contract's own vocabulary, filtered to the ones this process cannot evaluate.
    expect(projection.unobservableEvidence).toHaveLength(1);
    expect(projection.unobservableEvidence[0]?.stalenessReasons).toEqual(
      expect.arrayContaining(["extension-version-unknown", "extension-identity-unknown"]),
    );
    expect(
      projection.unobservableEvidence[0]?.stalenessReasons.every(reason =>
        LOCAL_DEV_UNOBSERVABLE_STALENESS_REASONS.includes(reason),
      ),
    ).toBe(true);
  });

  it("names both unobservable axes it knows about, so the list cannot silently shrink", () => {
    // A guard on the constant rather than on a projection: an axis removed from this list would stop
    // being reported as a boundary and start withdrawing decisions, which is the failure the whole
    // module exists to prevent. The two groups are separate capabilities — a page's answer, and the
    // probe engine's composer — so both are named here.
    expect(LOCAL_DEV_UNOBSERVABLE_STALENESS_REASONS).toEqual([
      "extension-version-unknown",
      "extension-version-changed",
      "extension-identity-unknown",
      "extension-identity-changed",
      "probe-fingerprint-unknown",
      "probe-fingerprint-changed",
    ]);
  });
});

describe("a record this process can judge is withheld, exactly as the compiler withholds it", () => {
  it("withholds a decision whose installed version has moved", async () => {
    // The reason is `package-version-changed`, which this process can see for itself — so the local
    // loop does not act on the record, which is the compiler's answer rather than a stricter one.
    const projection = await project(await projectWithDecision({ installedVersion: "6.0.0" }));

    expect(projection.decisions).toEqual([]);
    expect(projection.withheld.map(entry => entry.packageName)).toEqual(["@tanstack/react-query"]);
    expect(projection.withheld[0]?.stalenessReasons).toContain("package-version-changed");
    // Not reported as a boundary: this process *did* judge it.
    expect(projection.unobservableEvidence).toEqual([]);
  });

  it("decides on the worst axis, so one observable reason outweighs unobservable ones", async () => {
    // The case the `every`/`some` distinction turns on, and the one a boolean-shaped bug survives:
    // a record whose reasons are *one observable and several unobservable* must be withheld. The
    // first implementation wrote `reasons.every(isLocallyObservable) === false`, which is true when
    // any reason is unobservable — the opposite answer — and no type could catch it.
    const projection = await project(await projectWithDecision({ installedVersion: "6.0.0" }));

    const reasons = projection.withheld[0]?.stalenessReasons ?? [];
    expect(reasons).toContain("package-version-changed");
    expect(reasons.length).toBeGreaterThan(1);
    expect(reasons.some(reason => !LOCAL_DEV_UNOBSERVABLE_STALENESS_REASONS.includes(reason))).toBe(true);
  });
});

describe("the target-selection half stays fixed", () => {
  it("acts on the mounted Cell's record, never two records for one package", async () => {
    // The reviewer's earlier case, kept here as the projection's own guard: a raw-lock scan returns
    // both records for a package, and the audit then sees an `extension` decision for a Cell that
    // decided `inline`. Measured before the fix: all three of `probe`, `other` and `null` came back
    // with two records, so the defect was back through the projection.
    const root = await projectWithDecision();
    const lock = JSON.parse(readFileSync(join(root, "fgc.lock.json"), "utf8")) as {
      decisions: Record<string, unknown>[];
    };
    const [only] = lock.decisions;
    lock.decisions = [
      { ...only, cellTarget: null, strategy: "extension" },
      { ...only, cellTarget: "probe", strategy: "inline", extension: null },
    ];
    writeFileSync(join(root, "fgc.lock.json"), JSON.stringify(lock), "utf8");

    // One record per package, and it is the Cell-specific one.
    const forProbe = await project(root, "probe");
    expect(forProbe.decisions.map(decision => decision.strategy)).toEqual(["inline"]);

    // The fallback answers for every other Cell.
    const forOther = await project(root, "other-cell");
    expect(forOther.decisions.map(decision => decision.strategy)).toEqual(["extension"]);
  });
});

describe("a conformance error refuses, because the compiler would not compile it", () => {
  it("reports a decision the mapping table cannot bind as a conformance error", async () => {
    const projection = await project(
      await projectWithDecision({
        decision: {
          // The table intercepts `@tanstack/react-query`; this id is the same *shape* and binds
          // nothing, which is what the audit reports.
          packageName: "@tanstack/react-query",
          libraryId: "not-a-verified-library",
        },
      }),
    );

    // The code the audit actually reports for a library the row does not name — read off the
    // failure rather than guessed: the first version of this asserted `extension-library-not-verified`,
    // which is the code for a *missing* catalog entry, and the audit's own naming is precise about
    // the difference between "no mapping provides this" and "the decision names a different library
    // than the mapping does".
    expect(projection.conformanceErrors.map(diagnostic => diagnostic.code)).toContain("extension-library-mismatch");
  });

  it("finds no conformance error in a lock shaped the way the compiler accepts", async () => {
    // The control: the same fixture without the deliberate disagreement. Without this, the test above
    // would pass for a projection that reported every lock as non-conformant.
    const projection = await project(await projectWithDecision());

    expect(projection.conformanceErrors).toEqual([]);
  });
});

describe("the extension catalog is derived, so the harness audits as the compiler does", () => {
  it("projects core's mapping table rather than auditing against nothing", () => {
    // An absent catalog is an *error* in the audit (`extension-catalog-missing`) — "the verification
    // step did not happen" — so a harness that omitted it would refuse every project with an
    // extension dependency. The default is what keeps the harness from being stricter than the
    // compiler for no reason.
    expect(DEFAULT_LOCAL_EXTENSION_CATALOG.mappings.map(mapping => mapping.packageName)).toContain(
      "@tanstack/react-query",
    );
  });
});
