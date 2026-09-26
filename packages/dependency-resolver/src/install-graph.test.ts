import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import type { LockEnvironment } from "@forguncy-react-workspace/core";
import {
  forguncyTargetIdentity,
  resolveLockDecision,
  RUNTIME_CONTRACT_TARGET,
} from "@forguncy-react-workspace/core";

import {
  compilationDependencies,
  readFgcLock,
  recordDependencyDecision,
  recordedPackageNames,
  resolveInstalledVersions,
} from "./index.ts";

async function writeFileAt(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

/** A project whose install graph this test controls completely. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fgc-install-graph-"));
  await writeFileAt(join(root, "package.json"), JSON.stringify({ name: "probe-project", version: "0.0.0" }));
  return root;
}

/**
 * Writes a package into the project's `node_modules`.
 *
 * Real directories rather than a mocked resolver: the whole value of this module
 * is that it reads the graph the bundler will read, and a mock would test the
 * mock's idea of that graph instead.
 */
async function install(root: string, packageName: string, manifest: Record<string, unknown>): Promise<void> {
  await writeFileAt(join(root, "node_modules", ...packageName.split("/"), "package.json"), JSON.stringify(manifest));
}

describe("resolving exact installed versions", () => {
  it("reads the version of every installed package", async () => {
    const root = await project();
    await install(root, "dayjs", { name: "dayjs", version: "1.11.13" });
    await install(root, "es-toolkit", { name: "es-toolkit", version: "1.39.8" });
    await install(root, "@tanstack/react-query", { name: "@tanstack/react-query", version: "5.90.2" });

    const { versions, unresolved } = await resolveInstalledVersions(root, [
      "dayjs",
      "es-toolkit",
      "@tanstack/react-query",
    ]);

    expect(versions).toEqual({ "@tanstack/react-query": "5.90.2", dayjs: "1.11.13", "es-toolkit": "1.39.8" });
    expect(unresolved).toEqual([]);
  });

  // The property the lock depends on: this is the input to the staleness rule, and
  // a machine path reaching it would travel straight into `fgc.lock.json`, whose
  // portability rule `core` enforces on every string in the document.
  it("returns versions and never a path", async () => {
    const root = await project();
    await install(root, "dayjs", { name: "dayjs", version: "1.11.13" });

    const { versions } = await resolveInstalledVersions(root, ["dayjs"]);

    for (const value of Object.values(versions)) {
      expect(value).not.toMatch(/[\\/]/);
      expect(value).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("finds a package whose exports map hides its own manifest", async () => {
    // `exports` without a `./package.json` entry makes the direct manifest lookup
    // fail, which is the normal state of a modern package — so the module has to
    // reach the manifest through the entry point instead.
    const root = await project();
    await install(root, "es-toolkit", {
      name: "es-toolkit",
      version: "1.39.8",
      exports: { ".": "./dist/index.js" },
    });
    await writeFileAt(join(root, "node_modules", "es-toolkit", "dist", "index.js"), "module.exports = {}\n");

    const { versions, unresolved } = await resolveInstalledVersions(root, ["es-toolkit"]);

    expect(versions).toEqual({ "es-toolkit": "1.39.8" });
    expect(unresolved).toEqual([]);
  });

  it("does not mistake a nested type marker for the package manifest", async () => {
    // The regression this walk exists for: the nearest `package.json` under
    // `dist/esm/` carries no `version`, and stopping there would report the package
    // as unversioned when it is not.
    const root = await project();
    await install(root, "marked", { name: "marked", version: "15.0.3", exports: { ".": "./dist/esm/index.js" } });
    await writeFileAt(join(root, "node_modules", "marked", "dist", "esm", "package.json"), '{"type":"module"}');
    await writeFileAt(join(root, "node_modules", "marked", "dist", "esm", "index.js"), "export default {}\n");

    const { versions } = await resolveInstalledVersions(root, ["marked"]);

    expect(versions).toEqual({ marked: "15.0.3" });
  });

  it("resolves a subpath module id to the package that provides it", async () => {
    // `react/jsx-runtime` is not a package, and #5/#9 both treat it as a module id
    // belonging to `react`. Its version is React's version.
    const root = await project();
    await install(root, "react", {
      name: "react",
      version: "19.2.7",
      exports: { ".": "./index.js", "./jsx-runtime": "./jsx-runtime.js" },
    });
    await writeFileAt(join(root, "node_modules", "react", "index.js"), "module.exports = {}\n");
    await writeFileAt(join(root, "node_modules", "react", "jsx-runtime.js"), "module.exports = {}\n");

    const { versions } = await resolveInstalledVersions(root, ["react", "react/jsx-runtime"]);

    expect(versions).toEqual({ react: "19.2.7", "react/jsx-runtime": "19.2.7" });
  });

  it("reports a package that is not installed rather than throwing", async () => {
    // A lock can record a package the workspace has not installed — an edit in
    // progress — and `LockEnvironment` already turns a missing entry into
    // `package-version-unknown`. Throwing here would turn "run install" into a
    // crash mid-flow.
    const root = await project();

    const { versions, unresolved } = await resolveInstalledVersions(root, ["@tanstack/react-query"]);

    expect(versions).toEqual({});
    expect(unresolved).toEqual([{ packageName: "@tanstack/react-query", reason: "not-installed" }]);
  });

  it("refuses to report an aliased install as the package it stands in for", async () => {
    // With `"react": "npm:preact@10"` installed, resolution succeeds and finds
    // preact's version. Reporting that as React's would make the staleness rule
    // compare a decision about React against a number describing something else —
    // and report the decision as fresh.
    const root = await project();
    await install(root, "react", { name: "preact", version: "10.19.0" });

    const { versions, unresolved } = await resolveInstalledVersions(root, ["react"]);

    expect(versions).toEqual({});
    expect(unresolved).toEqual([{ packageName: "react", reason: "manifest-name-mismatch", manifestName: "preact" }]);
  });

  it("reports a manifest that declares no version", async () => {
    const root = await project();
    await install(root, "versionless", { name: "versionless" });

    const { versions, unresolved } = await resolveInstalledVersions(root, ["versionless"]);

    expect(versions).toEqual({});
    expect(unresolved).toEqual([{ packageName: "versionless", reason: "manifest-without-version" }]);
  });

  it("reads the version of an import-only package rather than calling it not installed", async () => {
    // #89's defect, at this module's level: `exports` publishing only an `import`
    // branch fails both `require.resolve` attempts, so the package was reported as
    // missing from the install graph while it is installed. The lock's staleness
    // rule is this map's consumer, so a false "not installed" makes a recorded
    // decision report `package-version-unknown` for a package that never moved.
    const root = await project();
    await install(root, "import-only-lib", {
      name: "import-only-lib",
      version: "3.2.1",
      type: "module",
      exports: { ".": { import: "./lib/index.js" } },
    });
    await writeFileAt(join(root, "node_modules", "import-only-lib", "lib", "index.js"), "export const a = 1;\n");

    const { versions, unresolved } = await resolveInstalledVersions(root, ["import-only-lib"]);

    expect(versions).toEqual({ "import-only-lib": "3.2.1" });
    expect(unresolved).toEqual([]);
  });

  it("reads the version of a package whose exports publishes no root entry", async () => {
    const root = await project();
    await install(root, "subpath-only-lib", {
      name: "subpath-only-lib",
      version: "4.0.0",
      type: "module",
      exports: { "./only": { import: "./lib/only.js" } },
    });
    await writeFileAt(join(root, "node_modules", "subpath-only-lib", "lib", "only.js"), "export const a = 1;\n");

    const { versions } = await resolveInstalledVersions(root, ["subpath-only-lib"]);

    expect(versions).toEqual({ "subpath-only-lib": "4.0.0" });
  });

  it("reports an unreadable manifest as such, not as a missing package", async () => {
    // Reachable for the first time (#89). The climb this module used to run swallowed
    // a JSON parse failure and kept walking, so a corrupt package root came back as
    // `not-installed` — telling the reader to run `install` when the file is present
    // and broken.
    const root = await project();
    await writeFileAt(join(root, "node_modules", "corrupt", "package.json"), '{ "name": "corrupt", ');

    const { versions, unresolved } = await resolveInstalledVersions(root, ["corrupt"]);

    expect(versions).toEqual({});
    expect(unresolved).toEqual([{ packageName: "corrupt", reason: "manifest-unreadable" }]);
  });

  it("does not report a missing package when the project's own manifest is unreadable", async () => {
    // The catch-all this replaces turned every resolver failure into `not-installed`, so a
    // corrupt *project* manifest made every recorded package look uninstalled — and the
    // lock's reader would be told to run `install` for a project file that is broken.
    const root = await mkdtemp(join(tmpdir(), "fgc-install-graph-base-"));
    await writeFile(join(root, "package.json"), '{ "name": "broken", ', "utf8");

    const { versions, unresolved } = await resolveInstalledVersions(root, ["dayjs"]);

    expect(versions).toEqual({});
    expect(unresolved).toEqual([{ packageName: "dayjs", reason: "base-unreadable" }]);
  });

  it("reports a request that is not a package name as invalid-specifier", async () => {
    // A lock record naming `node:fs` or `./x` is a lock defect, not an unrun install.
    const root = await project();

    const { unresolved } = await resolveInstalledVersions(root, ["node:fs", "./local.js"]);

    expect(unresolved).toEqual([
      { packageName: "./local.js", reason: "invalid-specifier" },
      { packageName: "node:fs", reason: "invalid-specifier" },
    ]);
  });

  it("reports a manifest that declares no name as a name mismatch, not as the request", async () => {
    // A manifest that parses but names nothing cannot be recorded as the artifact the
    // request names — that is the same defect as an alias from a caller's side.
    const root = await project();
    await install(root, "nameless", { version: "1.0.0" });

    const { versions, unresolved } = await resolveInstalledVersions(root, ["nameless"]);

    expect(versions).toEqual({});
    expect(unresolved).toEqual([{ packageName: "nameless", reason: "manifest-name-mismatch" }]);
  });

  it("does not answer for the project root when the package is absent", async () => {
    // An unguarded walk up from a failed lookup reaches the project's own manifest.
    // That would report every missing package as a name mismatch against the
    // project rather than as missing, and would give the project's version to
    // whatever was asked for.
    const root = await project();

    const { versions, unresolved } = await resolveInstalledVersions(root, ["absent-package"]);

    expect(versions).toEqual({});
    expect(unresolved).toEqual([{ packageName: "absent-package", reason: "not-installed" }]);
  });

  it("is deterministic and deduplicated", async () => {
    const root = await project();
    await install(root, "dayjs", { name: "dayjs", version: "1.11.13" });

    const { versions, unresolved } = await resolveInstalledVersions(root, ["dayjs", "zzz-absent", "aaa-absent", "dayjs"]);

    expect(Object.keys(versions)).toEqual(["dayjs"]);
    expect(unresolved.map(entry => entry.packageName)).toEqual(["aaa-absent", "zzz-absent"]);
  });

  it("resolves from the project it is pointed at, not from this package", async () => {
    // The version that matters is the one this workspace installs, which is why the
    // resolution scope is the target project. `vitest` is installed for *this*
    // repository and not for the temp project, so it must not be found there.
    const root = await project();

    const { versions } = await resolveInstalledVersions(root, ["vitest"]);

    expect(versions).toEqual({});
  });
});

/**
 * The loop this module exists for, end to end.
 *
 * #8's acceptance criterion is that "an exact package upgrade makes affected
 * technical evidence stale". While `resolvedVersions` was hand-written, that rule
 * was only ever as true as whoever typed the map — and the map was the one input
 * the whole invalidation path depended on. Here it comes from the install graph,
 * so an upgrade on disk is what moves it.
 */
describe("the install graph as the staleness input", () => {
  const FINGERPRINT = "probe=inline-bundle;entry=src/cells/orders-table/App.tsx";

  async function environmentFor(root: string): Promise<LockEnvironment> {
    const lock = await readFgcLock(root);
    const { versions } = await resolveInstalledVersions(root, recordedPackageNames(lock));
    // The probe inputs themselves are unchanged in both halves of each test, so the
    // only thing that moves is the version the install graph reports.
    const probeFingerprints: Record<string, string> = {};
    for (const record of lock.decisions) {
      probeFingerprints[record.packageName] = FINGERPRINT;
    }

    return {
      resolvedVersions: versions,
      target: RUNTIME_CONTRACT_TARGET,
      toolchain: { vitePlus: "0.3.2" },
      probeFingerprints,
      extensionVersions: {},
      extensionIdentities: {},
    };
  }

  it("makes a recorded decision stale when the installed version moves", async () => {
    const root = await project();
    await install(root, "dayjs", { name: "dayjs", version: "1.11.13" });
    await recordDependencyDecision(root, {
      decision: { strategy: "inline", packageName: "dayjs" },
      probe: { status: "passed", fingerprint: FINGERPRINT, versionIndependent: false },
      resolvedVersion: "1.11.13",
      probedWith: { vitePlus: "0.3.2" },
      target: forguncyTargetIdentity(),
      evidence: [{ kind: "probe", reference: "docs/probes/inline-dayjs.md" }],
    });

    const lock = await readFgcLock(root);
    expect(resolveLockDecision(lock, { packageName: "dayjs" }, await environmentFor(root)).state).toBe("verified");
    expect((await compilationDependencies(lock, await environmentFor(root))).dependencies).toHaveLength(1);

    await install(root, "dayjs", { name: "dayjs", version: "1.11.14" });

    const upgraded = await environmentFor(root);
    expect(resolveLockDecision(lock, { packageName: "dayjs" }, upgraded).assessment).toMatchObject({
      freshness: "stale",
      stalenessReasons: ["package-version-changed"],
    });
    expect((await compilationDependencies(lock, upgraded)).withheld).toContainEqual({
      packageName: "dayjs",
      strategy: "inline",
      reason: "not-verified",
      stalenessReasons: ["package-version-changed"],
      realRuntimeValidation: "validated",
    });
  });

  it("reports a recorded package the workspace no longer installs as unknown, not as unchanged", async () => {
    // Fail-closed: "cannot prove the inputs are unchanged" and "the inputs changed"
    // mean the same thing to a consumer of the evidence.
    const root = await project();
    // A name nothing in the graph answers to, so the observation is about the
    // resolution result rather than about whatever this machine happens to have
    // installed somewhere up the tree.
    const packageName = "recorded-but-not-installed";
    await recordDependencyDecision(root, {
      decision: { strategy: "inline", packageName },
      probe: { status: "passed", fingerprint: FINGERPRINT, versionIndependent: false },
      resolvedVersion: "1.11.13",
      probedWith: { vitePlus: "0.3.2" },
      target: forguncyTargetIdentity(),
      evidence: [{ kind: "probe", reference: "docs/probes/inline-dayjs.md" }],
    });

    const lock = await readFgcLock(root);

    expect(resolveLockDecision(lock, { packageName }, await environmentFor(root)).assessment).toMatchObject({
      freshness: "stale",
      stalenessReasons: ["package-version-unknown"],
    });
  });
});
