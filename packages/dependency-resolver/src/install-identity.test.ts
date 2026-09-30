/**
 * #94's acceptance criteria, measured on real install graphs.
 *
 * Decision source: GitHub Issue #94 — "Probe 身份：采集真实安装图、补丁和实际构建工具版本"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/94
 *
 * ## Why these are filesystem tests rather than unit tests over a mock
 *
 * The defect this ticket closes is that identity was read from a **declaration** rather than from
 * an installation, and a declaration is exactly what a mock would hand back. So every case below
 * builds a real `node_modules` tree, a real lockfile and real patch files, and asserts on what the
 * reader makes of them. A stubbed resolver would have agreed with the old implementation — which is
 * the failure mode `install-graph.test.ts` records for the same reason.
 *
 * ## What each case is pinned to
 *
 * The four acceptance criteria, one describe block each:
 *
 * 1. a transitive bump, a patch and a real bundler move all change the identity, while a *directory*
 *    move does not;
 * 2. the versions recorded are the installed ones, and Vite+'s own bundler is not mistaken for the
 *    project's;
 * 3. an install state that cannot be established yields an explicitly unknown component rather than
 *    a complete-looking identity;
 * 4. an old lock still reads, and reports the axis as unknown rather than passing.
 *
 * Local checks only: this reads a filesystem and a lockfile. It makes no Forguncy runtime claim.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative as relativePath } from "node:path";

import { describe, expect, it } from "vitest";

import { readInstallGraphIdentity, readToolchainIdentity } from "./install-identity.ts";

/** Removes a temp tree even when a case throws, so a failure cannot leak a directory. */
async function withProject<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "fgc-identity-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFileAt(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function install(root: string, packageName: string, manifest: Record<string, unknown>): Promise<void> {
  await writeFileAt(
    join(root, "node_modules", ...packageName.split("/"), "package.json"),
    JSON.stringify(manifest),
  );
}

/**
 * A project with one installed package, a lockfile and a manifest.
 *
 * `transitiveVersion` is what the *root package's own dependency* is installed at — the shape a
 * version-range resolution changes without any version the lock records moving, which is the case
 * #94 exists for.
 */
async function project(
  root: string,
  options: {
    readonly transitiveVersion?: string;
    readonly patch?: string;
    readonly lockfile?: string | null;
    readonly extra?: Record<string, string>;
    /** The manifest's `packageManager`, which decides which lockfile is authoritative. */
    readonly packageManager?: string;
  } = {},
): Promise<void> {
  await writeFileAt(
    join(root, "package.json"),
    JSON.stringify({
      name: "consumer",
      version: "0.0.0",
      private: true,
      type: "module",
      ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
    }),
  );
  if (options.lockfile !== null) {
    await writeFileAt(join(root, "pnpm-lock.yaml"), options.lockfile ?? "lockfileVersion: '9.0'\n");
  }
  await install(root, "a", { name: "a", version: "1.0.0" });
  await install(root, "a/node_modules/b", { name: "b", version: options.transitiveVersion ?? "1.0.0" });
  for (const [path, contents] of Object.entries(options.extra ?? {})) {
    await writeFileAt(join(root, ...path.split("/")), contents);
  }
  if (options.patch !== undefined) {
    await writeFileAt(join(root, "pnpm-workspace.yaml"), "patchedDependencies:\n  b@1.0.0: patches/b.patch\n");
    await writeFileAt(join(root, "patches", "b.patch"), options.patch);
  }
}

const digestOf = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

describe("#94: identity comes from the install graph, not from a declaration", () => {
  it("changes when a transitive dependency moves, with the root package's version held still", async () => {
    // A real pnpm lockfile names the resolved version of every package, including the transitive
    // ones, so this is what a re-resolution writes. The root package `a@1.0.0` is unchanged — that
    // is the case the old identity could not see, and the reason it reported `fresh`.
    const lockfileFor = (bVersion: string): string =>
      [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      a:",
        "        specifier: 1.0.0",
        "        version: 1.0.0",
        "",
        "packages:",
        "",
        "  a@1.0.0:",
        "    resolution: {integrity: sha512-aaa}",
        "  b@1.0.0:",
        "    resolution: {integrity: sha512-bbb}",
        "",
      ]
        .join("\n")
        .replace(`  b@1.0.0:`, `  b@${bVersion}:`);

    const before = await withProject(async root => {
      await project(root, { transitiveVersion: "1.0.0", lockfile: lockfileFor("1.0.0") });
      return readInstallGraphIdentity(root);
    });
    const after = await withProject(async root => {
      await project(root, { transitiveVersion: "2.0.0", lockfile: lockfileFor("2.0.0") });
      return readInstallGraphIdentity(root);
    });

    // `a`'s own version is what a lock record names, and it did not move — the record's
    // `resolvedVersion` is identical in both runs.
    expect(before.lockfile).not.toBe(after.lockfile);
  });

  it("changes when a patch is added, and again when the patch's own text changes", async () => {
    const none = await withProject(async root => {
      await project(root);
      return readInstallGraphIdentity(root);
    });
    const patched = await withProject(async root => {
      await project(root, { patch: "--- a\n+++ b\n" });
      return readInstallGraphIdentity(root);
    });
    const rePatched = await withProject(async root => {
      await project(root, { patch: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n" });
      return readInstallGraphIdentity(root);
    });

    expect(patched.patches).not.toBe(none.patches);
    // The file's *content*, not only the declaration: a patch edited without a re-install is the
    // change a declaration-only digest would miss.
    expect(rePatched.patches).not.toBe(patched.patches);
  });

  it("does not change when a file's line endings differ, only its content", async () => {
    // The defect this closes was found on CI rather than here, and it is the reason the digest
    // normalizes: this repository sets `core.autocrlf=true`, so a Windows working tree holds
    // `pnpm-lock.yaml` with CRLF while the committed bytes — and CI's checkout — are LF. Hashing raw
    // bytes gave one project two identities, and a lock re-recorded on Windows reported
    // `install-graph-changed` on Linux for a graph that had not moved.
    //
    // The line-ending convention is a fact about the *checkout*, not about the install, so the
    // digest must be a function of content. The fixture writes the two spellings explicitly, since
    // a temp file's own endings would otherwise be whatever this platform produced.
    const body = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n";
    const lf = await withProject(async root => {
      await project(root, { lockfile: body });
      return readInstallGraphIdentity(root);
    });
    const crlf = await withProject(async root => {
      await project(root, { lockfile: body.replace(/\n/g, "\r\n") });
      return readInstallGraphIdentity(root);
    });

    expect(crlf).toEqual(lf);
  });

  it("does not change when only the project's absolute directory changes", async () => {
    const first = await withProject(async root => {
      await project(root);
      return readInstallGraphIdentity(root);
    });
    const second = await withProject(async root => {
      await project(root);
      return readInstallGraphIdentity(root);
    });

    // Two different temp directories, one set of real inputs: the identity is over file content, so
    // it must be equal. A path in the digest would make every lock machine-specific, which is the
    // portability rule `core` enforces on the whole document.
    expect(second).toEqual(first);
  });

  it("changes when the lockfile content changes, even with the tree identical", async () => {
    const before = await withProject(async root => {
      await project(root, { lockfile: "lockfileVersion: '9.0'\n" });
      return readInstallGraphIdentity(root);
    });
    const after = await withProject(async root => {
      await project(root, { lockfile: "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: false\n" });
      return readInstallGraphIdentity(root);
    });

    expect(after.lockfile).not.toBe(before.lockfile);
  });

  it("keeps the two patch sources apart, so editing the effective one moves the digest", async () => {
    // PR #114 review, P1. Both files may declare a patch for one dependency, and pnpm applies the
    // *workspace* one. Merging the sources into one `declaration → path` map let `package.json`
    // shadow it, so the digest covered a patch that was never applied: measured, editing the
    // effective workspace patch with an unchanged lockfile and no re-install left the digest
    // byte-identical — a false fresh of exactly the class #94 removes.
    const withPatches = async (workspacePatch: string): Promise<string | null> =>
      withProject(async root => {
        await project(root, {
          extra: {
            "package.json": JSON.stringify({
              name: "consumer",
              version: "0.0.0",
              patchedDependencies: { "b@1.0.0": "patches/manifest.patch" },
            }),
            "pnpm-workspace.yaml": "patchedDependencies:\n  b@1.0.0: patches/workspace.patch\n",
            "patches/workspace.patch": workspacePatch,
            "patches/manifest.patch": "manifest patch\n",
          },
        });
        return (await readInstallGraphIdentity(root)).patches;
      });

    const before = await withPatches("workspace patch v1\n");
    const after = await withPatches("workspace patch v2\n");
    const manifestEdited = await withProject(async root => {
      await project(root, {
        extra: {
          "package.json": JSON.stringify({
            name: "consumer",
            version: "0.0.0",
            patchedDependencies: { "b@1.0.0": "patches/manifest.patch" },
          }),
          "pnpm-workspace.yaml": "patchedDependencies:\n  b@1.0.0: patches/workspace.patch\n",
          "patches/workspace.patch": "workspace patch v1\n",
          "patches/manifest.patch": "manifest patch EDITED\n",
        },
      });
      return (await readInstallGraphIdentity(root)).patches;
    });

    expect(before).not.toBeNull();
    // The effective source moving is the case that matters.
    expect(after).not.toBe(before);
    // And the shadowed one still counts, so neither source can be edited without invalidating.
    expect(manifestEdited).not.toBe(before);
  });

  it("covers the legacy `pnpm.patchedDependencies` site, so editing its patch file moves the digest", async () => {
    // PR #114 review round 3, P1. pnpm 10 and earlier read patches from
    // `package.json#pnpm.patchedDependencies` (pnpm#11536 records 10.33.x still doing so, with the
    // move to `pnpm-workspace.yaml` landing in 11). Only the **top-level** `patchedDependencies` was
    // read here, so a patch declared at the legacy site reached `configuration` as a *path* but its
    // file contents were never digested. Measured, under `pnpm@10.x`: keeping the lockfile and the
    // declared path fixed and editing `patches/foo.patch` moved none of the three digests — a patch
    // edit could not invalidate anything, which violates #94's "a patch change must move identity".
    const withLegacyPatch = async (patchText: string): Promise<{ patches: string | null; configuration: string | null }> =>
      withProject(async root => {
        await project(root, {
          packageManager: "pnpm@10.33.0",
          extra: {
            // The legacy location, nested under `pnpm`, and *no* top-level declaration.
            "package.json": JSON.stringify({
              name: "consumer",
              version: "0.0.0",
              packageManager: "pnpm@10.33.0",
              pnpm: { patchedDependencies: { "b@1.0.0": "patches/foo.patch" } },
            }),
            "patches/foo.patch": patchText,
          },
        });
        const identity = await readInstallGraphIdentity(root);
        return { patches: identity.patches, configuration: identity.configuration };
      });

    const before = await withLegacyPatch("patch v1\n");
    const after = await withLegacyPatch("patch v2 edited\n");

    // The lockfile is unchanged in both runs (same `project()` default) and so is the declared path,
    // so the *only* input that moved is the patch file's contents.
    expect(before.patches).not.toBeNull();
    expect(after.patches).not.toBe(before.patches);
  });

  it("changes when the configuration that affects resolution changes", async () => {
    const before = await withProject(async root => {
      await project(root, { extra: { "pnpm-workspace.yaml": "packages:\n  - packages/*\n" } });
      return readInstallGraphIdentity(root);
    });
    const after = await withProject(async root => {
      await project(root, {
        extra: { "pnpm-workspace.yaml": "packages:\n  - packages/*\noverrides:\n  b: 3.0.0\n" },
      });
      return readInstallGraphIdentity(root);
    });

    expect(after.configuration).not.toBe(before.configuration);
  });

  it("digests what the manager installed, so install-time parameters cannot hide", async () => {
    // PR #114 review round 5, P1. Every other component is an *input*, and inputs cannot confirm a
    // result: review pointed out that npm's `omit` default comes from `process.env.NODE_ENV` and
    // `--omit=optional` is a CLI flag, so neither reaches `package-lock.json` nor `.npmrc`.
    //
    // Reproduced end to end on a real npm project before this was written: a default install puts
    // `@rolldown/binding-win32-x64-msvc` on disk while `npm install --omit=optional` does not, and
    // the two runs leave a **byte-identical** `package-lock.json` — so every earlier digest agreed
    // and a warm cache answered for a tree that had changed. The manager's own record is the fix,
    // because it is a fact about the result.
    const npmTree = async (entries: readonly string[]): Promise<string | null | undefined> =>
      withProject(async root => {
        await writeFileAt(
          join(root, "package.json"),
          JSON.stringify({ name: "consumer", version: "0.0.0", packageManager: "npm@11.0.0" }),
        );
        // Identical in both runs: the lockfile and the manifest do not move.
        await writeFileAt(
          join(root, "package-lock.json"),
          JSON.stringify({ name: "consumer", dependencies: { rolldown: "1.2.9" } }),
        );
        const packages: Record<string, unknown> = {};
        for (const entry of entries) {
          packages[entry] = { version: "1.2.9" };
        }
        await writeFileAt(
          join(root, "node_modules", ".package-lock.json"),
          JSON.stringify({ name: "consumer", lockfileVersion: 3, packages }),
        );
        return (await readInstallGraphIdentity(root)).installedTree;
      });

    const base = ["node_modules/rolldown", "node_modules/@rolldown/pluginutils"];
    const withOptionalBinding = [...base, "node_modules/@rolldown/binding-win32-x64-msvc"];

    const installed = await npmTree(withOptionalBinding);
    const omitted = await npmTree(base);

    expect(installed).not.toBeNull();
    // The lockfile, the patches and the configuration are byte-identical across these two runs, so
    // `installedTree` is the only component that can carry the change.
    expect(omitted).not.toBe(installed);

    // pnpm's equivalent: `included` records the dependency classes that were installed, and
    // `--no-optional` flips `optionalDependencies` (measured on a real install, where the platform
    // binding then leaves disk).
    //
    // The record is written in the **real** shape (JSON, one line per field), copied field-for-field
    // from a pnpm install rather than hand-rolled as block YAML — a hand-rolled fixture is how the
    // `hoistPattern` count in an earlier revision of this case got written wrong.
    const pnpmTree = async (
      overrides: Record<string, unknown>,
      store: readonly string[] = ["a@1.0.0", "b@1.0.0"],
    ): Promise<string | null | undefined> =>
      withProject(async root => {
        await writeFileAt(
          join(root, "package.json"),
          JSON.stringify({ name: "consumer", version: "0.0.0", packageManager: "pnpm@11.18.0" }),
        );
        await writeFileAt(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        await writeFileAt(
          join(root, "node_modules", ".modules.yaml"),
          JSON.stringify({
            included: { dependencies: true, devDependencies: true, optionalDependencies: true },
            nodeLinker: "isolated",
            hoistPattern: ["*"],
            publicHoistPattern: [],
            ...overrides,
          }),
        );
        // The store, whose directory names are the installed package identities the digest covers.
        await writeFileAt(join(root, "node_modules", ".pnpm", "node_modules", ".keep"), "");
        for (const name of store) {
          await writeFileAt(join(root, "node_modules", ".pnpm", name, "node_modules", "pkg", "package.json"), "{}");
        }
        return (await readInstallGraphIdentity(root)).installedTree;
      });

    const pnpmDefault = await pnpmTree({});
    expect(pnpmDefault).not.toBeNull();
    // Each of these is a real pnpm flag, and each changes what resolution can reach while the
    // lockfile stays put.
    expect(
      await pnpmTree({ included: { dependencies: true, devDependencies: true, optionalDependencies: false } }),
    ).not.toBe(pnpmDefault);
    expect(await pnpmTree({ nodeLinker: "hoisted" })).not.toBe(pnpmDefault);
    // `pnpm install --shamefully-hoist` moves this from `[]` to `["*"]` with `included` and
    // `nodeLinker` both unchanged — measured on a real install. The pair is the shape review round 6
    // named, and omitting the hoisting fields left it invisible.
    expect(await pnpmTree({ publicHoistPattern: ["*"] })).not.toBe(pnpmDefault);
    // And the round-7 case: with `--no-lockfile` pnpm re-resolves, so a transitive can move while
    // every layout field and the lockfile digest hold still. The store names are what capture it.
    expect(await pnpmTree({}, ["a@1.0.0", "b@2.0.0"])).not.toBe(pnpmDefault);

    // A record missing a hoisting field is unknown rather than silently read as the empty pattern —
    // the fail-closed direction, since an absent field is not the same fact as an empty one.
    const absent = await withProject(async root => {
      await writeFileAt(
        join(root, "package.json"),
        JSON.stringify({ name: "consumer", version: "0.0.0", packageManager: "pnpm@11.18.0" }),
      );
      await writeFileAt(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await writeFileAt(
        join(root, "node_modules", ".modules.yaml"),
        JSON.stringify({ included: { dependencies: true }, nodeLinker: "isolated" }),
      );
      return readInstallGraphIdentity(root);
    });
    expect(absent.installedTree).toBeNull();
  });

  it("reads the record of the lockfile's manager, not whichever marker is found first", async () => {
    // PR #114 review round 6, P1. Choosing the record by first match re-trusted the accumulated
    // markers: a project that ran `pnpm install` and later `npm install` keeps **both**, so in the
    // migration case — `pnpm-lock.yaml` deleted, `package-lock.json` the only lockfile — the walk
    // correctly identified npm while the record read still preferred the stale `.modules.yaml`.
    // Measured: npm's materialized entry set changed under `--omit=optional` and `installedTree` did
    // not move.
    const migrating = async (npmEntries: readonly string[]): Promise<{ lockfile: string | null; installedTree: string | null | undefined }> =>
      withProject(async root => {
        await writeFileAt(
          join(root, "package.json"),
          JSON.stringify({ name: "consumer", version: "0.0.0", packageManager: "npm@11.0.0" }),
        );
        // Only npm's lockfile is present; the pnpm one was removed by the migration.
        await writeFileAt(
          join(root, "package-lock.json"),
          JSON.stringify({ name: "consumer", dependencies: { rolldown: "1.2.9" } }),
        );
        // A stale marker from the old pnpm install, frozen across both runs.
        await writeFileAt(
          join(root, "node_modules", ".modules.yaml"),
          [
            "included:",
            "  dependencies: true",
            "  devDependencies: true",
            "  optionalDependencies: true",
            "nodeLinker: isolated",
            "hoistPattern:",
            '  - "*"',
            "publicHoistPattern: []",
            "",
          ].join("\n"),
        );
        const packages: Record<string, unknown> = {};
        for (const entry of npmEntries) {
          packages[entry] = { version: "1.2.9" };
        }
        await writeFileAt(
          join(root, "node_modules", ".package-lock.json"),
          JSON.stringify({ name: "consumer", lockfileVersion: 3, packages }),
        );
        const identity = await readInstallGraphIdentity(root);
        return { lockfile: identity.lockfile, installedTree: identity.installedTree };
      });

    const base = ["node_modules/rolldown"];
    const withBinding = [...base, "node_modules/@rolldown/binding-win32-x64-msvc"];

    const before = await migrating(withBinding);
    const after = await migrating(base);

    // npm's lockfile is what was digested in both runs...
    expect(before.lockfile).not.toBeNull();
    expect(after.lockfile).toBe(before.lockfile);
    // ...so npm's record must be what was read, and its movement must show.
    expect(before.installedTree).not.toBeNull();
    expect(after.installedTree).not.toBe(before.installedTree);
  });

  it("digests a workspace link's target contents, not only the link path", async () => {
    // PR #114 review round 8, P1. A workspace dependency is a symlink **out of** the install tree —
    // measured, pnpm links `node_modules/bar` to `packages/bar` and npm records
    // `{resolved: "packages/bar", link: true}` with the same symlink on disk — and no other digest
    // describes the target's files. So a consumer of `bar@1.0.0` could cache a probe, then an edit to
    // `packages/bar/src/index.js` alone moved nothing while Rolldown's next build read the new
    // source. Measured: `installedTree` byte-identical across exactly that edit.
    const withWorkspaceSource = async (source: string): Promise<string | null | undefined> =>
      withProject(async root => {
        await writeFileAt(
          join(root, "package.json"),
          JSON.stringify({ name: "consumer", version: "0.0.0", packageManager: "pnpm@11.18.0" }),
        );
        await writeFileAt(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        // The workspace package: same name, same version, in every run.
        await writeFileAt(
          join(root, "packages", "bar", "package.json"),
          JSON.stringify({ name: "bar", version: "1.0.0" }),
        );
        await writeFileAt(join(root, "packages", "bar", "src", "index.js"), source);
        // The link pnpm materializes, pointing out of the install tree.
        await mkdir(join(root, "node_modules"), { recursive: true });
        await symlink(join(root, "packages", "bar"), join(root, "node_modules", "bar"), "junction");
        await writeFileAt(
          join(root, "node_modules", ".modules.yaml"),
          JSON.stringify({
            included: { dependencies: true, devDependencies: true, optionalDependencies: true },
            nodeLinker: "isolated",
            hoistPattern: ["*"],
            publicHoistPattern: [],
          }),
        );
        await writeFileAt(join(root, "node_modules", ".pnpm", "node_modules", ".keep"), "");
        await writeFileAt(
          join(root, "node_modules", ".pnpm", "consumer@1.0.0", "node_modules", "consumer", "package.json"),
          "{}",
        );
        return (await readInstallGraphIdentity(root)).installedTree;
      });

    const before = await withWorkspaceSource("export const VERSION = 1;\n");
    const after = await withWorkspaceSource("export const VERSION = 2; // source edited, nothing else\n");

    expect(before).not.toBeNull();
    expect(after).not.toBe(before);

    // The control: the same source composes the same identity, so the case above is about the
    // *content* and not about the fixture being non-deterministic in some other way.
    expect(await withWorkspaceSource("export const VERSION = 1;\n")).toBe(before);
  });

  it("is unknown when the manager writes no install record this toolchain can read", async () => {
    // The fail-closed half: yarn and bun write no record this module can verify, so the answer is
    // `null` — unknown, and therefore stale. Inventing a marker would be the guess #94 removes.
    const yarnProject = await withProject(async root => {
      await writeFileAt(join(root, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0", packageManager: "yarn@4.0.0" }));
      await writeFileAt(join(root, "yarn.lock"), "yarn lock\n");
      return readInstallGraphIdentity(root);
    });

    expect(yarnProject.lockfile).not.toBeNull();
    expect(yarnProject.installedTree).toBeNull();

    // The positive control, and it is what keeps the assertion above from being vacuous: a pnpm
    // project whose record AND store are readable reports a value. Without this half the case would
    // pass against an implementation that never read a record at all.
    const pnpmProject = await withProject(async root => {
      await writeFileAt(join(root, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0", packageManager: "pnpm@11.18.0" }));
      await writeFileAt(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await writeFileAt(
        join(root, "node_modules", ".modules.yaml"),
        ["included:", "  dependencies: true", "  devDependencies: true", "  optionalDependencies: true", "nodeLinker: isolated", "hoistPattern:", "  - \"*\"", "publicHoistPattern: []", ""].join("\n"),
      );
      await writeFileAt(join(root, "node_modules", ".pnpm", "node_modules", ".keep"), "");
      await writeFileAt(join(root, "node_modules", ".pnpm", "a@1.0.0", "node_modules", "pkg", "package.json"), "{}");
      return readInstallGraphIdentity(root);
    });

    expect(pnpmProject.installedTree).not.toBeNull();
  });

  it("covers manager config that changes the installed tree without changing the lockfile", async () => {
    // PR #114 review round 4, P1. This module treats npm/yarn/bun lockfiles as verifiable
    // identities, but only pnpm's configuration was digested — so a non-pnpm project could change
    // what is on disk while all three digests held. Measured with npm's `omit=optional`: npm
    // documents that omitted dependencies are "still resolved and added to the package-lock.json",
    // only "not physically installed on disk", so one lockfile describes two different trees.
    const withNpmrc = async (npmrc: string | null): Promise<string | null> =>
      withProject(async root => {
        // Built directly rather than through `project()`, whose helper always installs a real
        // `node_modules` tree the npm lock does not describe — which the attribution check would
        // (correctly) report as `unknown`, hiding the digest this case is about.
        await writeFileAt(
          join(root, "package.json"),
          JSON.stringify({ name: "consumer", version: "0.0.0", packageManager: "npm@11.0.0" }),
        );
        await writeFileAt(
          join(root, "package-lock.json"),
          JSON.stringify({ name: "consumer", dependencies: { b: "1.0.0" } }),
        );
        if (npmrc !== null) {
          await writeFileAt(join(root, ".npmrc"), npmrc);
        }
        return (await readInstallGraphIdentity(root)).configuration;
      });

    const before = await withNpmrc(null);
    const after = await withNpmrc("omit=optional\n");

    expect(before).not.toBeNull();
    // The lockfile is byte-identical across these two runs — only `.npmrc` moved — so this digest is
    // the only thing that can carry the change.
    expect(after).not.toBe(before);

    // The Yarn and Bun equivalents are covered by the same mechanism: `nodeLinker` decides whether a
    // `node_modules` tree exists at all, and `[install].linker` is the same choice.
    const withYarnRc = async (text: string): Promise<string | null> =>
      withProject(async root => {
        await writeFileAt(
          join(root, "package.json"),
          JSON.stringify({ name: "consumer", version: "0.0.0", packageManager: "yarn@4.0.0" }),
        );
        await writeFileAt(join(root, "yarn.lock"), "yarn lock\n");
        await writeFileAt(join(root, ".yarnrc.yml"), text);
        return (await readInstallGraphIdentity(root)).configuration;
      });
    expect(await withYarnRc("nodeLinker: node-modules\n")).not.toBe(await withYarnRc("nodeLinker: pnp\n"));
  });

  it("attributes an install reached through a differently-spelled root", async () => {
    // The containment test compares a `realpath`'d entry against the install root as the walk
    // *spelled* it, and the two can differ for one directory. Measured on Windows: a runner's temp
    // directory is an 8.3 short path (`C:\Users\RUNNER~1\…`) that `realpath` expands to
    // `runneradmin`, so every entry compared unequal and every install reported `unknown` — the
    // fail-closed direction, but it disables the attribution check on a real runner.
    //
    // Reproduced here the same way without needing a short path: the install root is reached through
    // a **junction**, so the walk spells it with the junction while `realpath` yields the target. The
    // project nests under that spelling, which is what makes the two sides differ.
    await withProject(async root => {
      const real = join(root, "real");
      await writeFileAt(join(real, "package.json"), JSON.stringify({ name: "ws", version: "0.0.0", packageManager: "pnpm@11.18.0" }));
      await writeFileAt(join(real, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await writeFileAt(
        join(real, "node_modules", ".pnpm", "pkg@1.0.0", "node_modules", "pkg", "package.json"),
        JSON.stringify({ name: "pkg", version: "1.0.0" }),
      );

      const linked = join(root, "linked");
      await symlink(real, linked, "junction");
      const project = join(linked, "sub");
      await writeFileAt(join(project, "package.json"), JSON.stringify({ name: "sub", version: "0.0.0" }));
      await mkdir(join(project, "node_modules"), { recursive: true });
      // The entry links back into the store, so it is genuinely part of that install.
      await symlink(
        join(real, "node_modules", ".pnpm", "pkg@1.0.0", "node_modules", "pkg"),
        join(project, "node_modules", "pkg"),
        "junction",
      );

      const viaJunction = await readInstallGraphIdentity(project);
      const viaReal = await readInstallGraphIdentity(join(real, "sub"));

      // Both spellings name one install, so both must resolve — and to the *same* identity.
      expect(viaJunction.lockfile).not.toBeNull();
      expect(viaJunction.lockfile).toBe(viaReal.lockfile);
    });
  });

  it("reads the patch set and the configuration at the install root, not at a nested project", async () => {
    // A workspace member has no lockfile of its own and inherits its root's install, which is the
    // shape `examples/probe-proving-cases` has. Reading the member's own directory would report
    // "no patches" for an install that carries them — and the record would look fresh through the
    // exact change this axis exists to catch.
    const nested = await withProject(async root => {
      await project(root, { patch: "--- a\n+++ b\n" });
      const member = join(root, "packages", "member");
      await writeFileAt(join(member, "package.json"), JSON.stringify({ name: "member", version: "0.0.0" }));
      return { member: await readInstallGraphIdentity(member), root: await readInstallGraphIdentity(root) };
    });

    expect(nested.member).toEqual(nested.root);
    expect(nested.member.lockfile).not.toBeNull();
    expect(nested.member.patches).not.toBeNull();
  });
});

describe("#94: the versions recorded are the ones that actually ran", () => {
  it("records the installed vite-plus, not the range the manifest declares", async () => {
    await withProject(async root => {
      await writeFileAt(
        join(root, "package.json"),
        JSON.stringify({ name: "consumer", version: "0.0.0", devDependencies: { "vite-plus": "^0.3.2" } }),
      );
      await install(root, "vite-plus", { name: "vite-plus", version: "0.3.9" });

      const identity = await readToolchainIdentity(root);

      // The declared range names a *request*; the installed manifest is the answer. A reader that
      // trusted the range would report `0.3.2` for a project running `0.3.9`.
      expect(identity.vitePlus).toBe("0.3.9");
    });
  });

  it("records no vite-plus when the manifest declares one that is not installed", async () => {
    await withProject(async root => {
      await writeFileAt(
        join(root, "package.json"),
        JSON.stringify({ name: "consumer", version: "0.0.0", devDependencies: { "vite-plus": "0.3.2" } }),
      );

      // Declared and absent is `null` — unknown — rather than the declared string. This is the
      // whole change: a declaration is not an installation.
      expect((await readToolchainIdentity(root)).vitePlus).toBeNull();
    });
  });

  it("reads rolldown through this package, so it is the bundler the probe actually imports", async () => {
    await withProject(async root => {
      await project(root);

      const identity = await readToolchainIdentity(root);

      // `probe/build.ts` imports `rolldown` from *this* package, so that is the version a probe
      // bundles with — independent of anything the project installs. `vite-plus` does not depend on
      // `rolldown` at all, which is why the two must not be conflated.
      expect(identity.rolldown).toMatch(/^\d+\.\d+\.\d+/);
      expect(identity.rolldown).toBe(
        (await readToolchainIdentity(root)).rolldown,
      );
    });
  });

  it("records the exact Node version, because a resolver fix moves within one major", async () => {
    // PR #114 review round 8, P1, and this case previously asserted the opposite — it required the
    // major line, on the argument that only a major can change resolution. That argument is false:
    // Node 23.6.0 carries `module: fix async resolution error within the sync findPackageJSON`
    // (nodejs/node#56382, commit 4f77920a9d), a **minor** release of one major, and
    // `package-locator.ts` resolves every identity through exactly that function. Verified against
    // the nodejs repository before changing this: the commit is in `CHANGELOG_V23.md` under 23.6.0.
    await withProject(async root => {
      await project(root);
      const identity = await readToolchainIdentity(root);

      expect(identity.node).toBe(process.versions.node);
      // The positive control for "exact": a major-only reading would fail this on any release whose
      // version has more than one component, which is every real release.
      expect(identity.node).toContain(".");
    });
  });

  it("produces one identity for a project however the caller spells its root", async () => {
    // Measured while wiring this up: `locatePackage`'s host primitive takes a `file:` URL or an
    // absolute path and throws `ERR_INVALID_URL` for a relative one, which this module read as
    // "not installed" — so a relative root reported `vitePlus: null` for a project whose Vite+ was
    // perfectly well installed. Every caller here passes an absolute root, so the bug was invisible
    // until the two spellings were compared, and it would have shipped as a record reported
    // `toolchain-unknown` for no reason.
    //
    // The project is created **under the repo's own `.fgc/`** rather than in `os.tmpdir()`, and that
    // is required rather than convenient: this case needs a relative spelling of the root to exist,
    // and `path.relative` answers with an absolute path when the two are on different drives — which
    // is exactly what `windows-latest` does (its temp directory is on another drive from the
    // checkout). Measured: the first version of this case guarded on a relative path existing and
    // **failed the Windows CI leg** with "this platform cannot spell the temp root relatively". A
    // project under the cwd always has a `..`-prefixed spelling, on every platform. `.fgc/` is
    // gitignored and is already the scratch space other tooling here uses.
    //
    // Being under the repo has one consequence the assertions must account for: the walk sees this
    // project's lockfile **and** the repository's, so the install graph is `unknown` (two claims).
    // That is fine for what this case measures — the toolchain identity, which is resolved from the
    // *project* rather than from the lockfile claim — but it means `toEqual` alone would compare two
    // all-null graphs and pass without exercising the relative branch at all. So the fields that
    // actually move are asserted positively.
    const scratchRoot = join(process.cwd(), ".fgc", "identity-spelling");
    await rm(scratchRoot, { recursive: true, force: true });
    try {
      await project(scratchRoot);
      await install(scratchRoot, "vite-plus", { name: "vite-plus", version: "0.3.9" });

      const spelledRelatively = relativeToCwd(scratchRoot);
      // Asserted rather than skipped silently: if this ever becomes `null` the case stops measuring
      // the relative branch. It cannot be `null` for a root under the cwd, which is why it lives there.
      expect(spelledRelatively, "a root under the cwd always has a relative spelling").not.toBeNull();

      const absolute = await readToolchainIdentity(scratchRoot);
      const relative = await readToolchainIdentity(spelledRelatively!);

      // The positive control: the relative spelling resolved the installed manifest rather than
      // reporting it missing, which is the defect this case exists for.
      expect(absolute.vitePlus).toBe("0.3.9");
      expect(relative.vitePlus).toBe("0.3.9");
      expect(relative).toEqual(absolute);
    } finally {
      await rm(scratchRoot, { recursive: true, force: true });
    }
  });
});

/**
 * `root` as a path relative to the process's cwd, so a caller's *spelling* is what differs.
 *
 * `mkdtemp` returns an absolute path; walking back to a relative one is what a caller passing
 * `"examples/x"` produces. A `..`-prefixed result is a legitimate relative spelling and is used as
 * is — an earlier version of this helper discarded it as "not a real relative path", which meant
 * every case fell back to the absolute form and the assertion passed without ever exercising the
 * relative branch. That is the same "passes for the wrong reason" defect the test exists to catch.
 *
 * A temp directory on a different drive from the cwd has no relative form at all; the absolute one
 * is then the only honest input, and the case is skipped rather than asserted vacuously.
 */
function relativeToCwd(root: string): string | null {
  const relative = relativePath(process.cwd(), root);
  return isAbsolute(relative) ? null : relative;
}

describe("#94: an install state that cannot be established is explicitly unknown", () => {
  it("reports no lockfile as null rather than as an identity", async () => {
    await withProject(async root => {
      await project(root, { lockfile: null });

      const identity = await readInstallGraphIdentity(root);

      // The third acceptance criterion: a project with no lockfile has an install graph this
      // toolchain cannot identify, and presenting a complete-looking identity for it would let a
      // record be verified against nothing.
      expect(identity).toEqual({ lockfile: null, patches: null, configuration: null });
    });
  });

  it("does not let the declared `packageManager` exclude another manager's real lockfile", async () => {
    // PR #114 review round 3, P1, which **corrected** round 2's advice. Round 2 asked for the
    // lockfile to be chosen by the manifest's `packageManager`; that is the same "trust the request
    // string" mistake #94 was written about, and this case is why.
    //
    // A project declaring `pnpm` can have had `npm install` run in it — Corepack does not intercept
    // `npm` (its shims are not installed by default, so `npm` resolves to the Node-bundled copy).
    // Selecting by the declaration then excludes `package-lock.json`, which is the lockfile that
    // actually describes the install, and builds a complete-looking identity from a stale
    // `pnpm-lock.yaml`. Measured before the fix: moving the npm transitive dependency left the
    // identity byte-identical.
    const declared = async (declaredManager: string, npmDeps: string): Promise<string | null> =>
      withProject(async root => {
        await project(root, {
          packageManager: declaredManager,
          lockfile: null,
          extra: {
            "pnpm-lock.yaml": "stale pnpm lock (never re-resolved)\n",
            "package-lock.json": JSON.stringify({ name: "consumer", dependencies: { b: npmDeps } }),
            // The evidence of what actually ran, which must not be overruled by the declaration.
            "node_modules/.package-lock.json": JSON.stringify({ lockfileVersion: 3 }),
          },
        });
        return (await readInstallGraphIdentity(root)).lockfile;
      });

    // Whichever manager the manifest *claims*, two lockfiles are present and neither may be
    // silently dropped — the answer is `unknown`, not a stale identity built from the declared one.
    expect(await declared("pnpm@11.18.0", "1.0.0")).toBeNull();
    expect(await declared("pnpm@11.18.0", "9.9.9")).toBeNull();
    expect(await declared("npm@11.0.0", "1.0.0")).toBeNull();

    // The control: where only the declared manager's lockfile exists at all, the identity is still
    // usable, so this is not a blanket refusal to read anything.
    const unambiguous = await withProject(async root => {
      await project(root, { packageManager: "pnpm@11.18.0", lockfile: null });
      await writeFileAt(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      return (await readInstallGraphIdentity(root)).lockfile;
    });
    expect(unambiguous).not.toBeNull();
  });

  it("is unknown when one manager's two lockfile spellings are both present", async () => {
    // PR #114 review round 2, P1. npm does not have a version-stable rule here: npm 11 documents
    // `npm-shrinkwrap.json` as taking precedence over `package-lock.json`, so an order of
    // `[package-lock, shrinkwrap]` hashes the file npm ignores. Measured with both present under
    // `npm@11.0.0`: editing the *effective* shrinkwrap left the digest byte-identical while editing
    // the shadowed lock moved it — exactly backwards.
    //
    // This module has no verified model of npm's version-dependent rule, so two candidates are
    // `unknown` rather than a pick. Reversing the hardcoded order would only move which case is
    // wrong.
    const both = async (shrinkwrap: string, packageLock: string): Promise<string | null> =>
      withProject(async root => {
        await project(root, {
          packageManager: "npm@11.0.0",
          lockfile: null,
          extra: {
            "npm-shrinkwrap.json": JSON.stringify({ which: shrinkwrap }),
            "package-lock.json": JSON.stringify({ which: packageLock }),
          },
        });
        return (await readInstallGraphIdentity(root)).lockfile;
      });

    expect(await both("s1", "p1")).toBeNull();
    // And neither file can silently dominate: both runs are unknown however they move.
    expect(await both("s2", "p1")).toBeNull();
    expect(await both("s1", "p2")).toBeNull();

    // The control: with only one of the spellings present, npm 11 still yields a usable identity —
    // so this is not a blanket refusal to read an npm lockfile.
    const onlyShrinkwrap = await withProject(async root => {
      await project(root, {
        packageManager: "npm@11.0.0",
        lockfile: null,
        extra: { "npm-shrinkwrap.json": JSON.stringify({ which: "s1" }) },
      });
      return (await readInstallGraphIdentity(root)).lockfile;
    });
    expect(onlyShrinkwrap).not.toBeNull();
  });

  it("is unknown when a nested project has its own install the ancestor lock does not describe", async () => {
    // PR #114 review round 4, P1. Counting ancestors' *lockfiles* answers "who wrote a lock", not
    // "whose install does this project resolve in" — and resolution takes the nearest `node_modules`
    // holding a name. Measured: a project with its own real `node_modules` and no lockfile of its
    // own, whose only ancestor claim was the parent's `pnpm-lock.yaml`; keeping the parent lock and
    // the root package fixed while moving the child's own installed transitive dependency left all
    // three digests unchanged, so a warm cache could answer a report about a tree that had moved.
    //
    // Contrast the *workspace-member* shape a few cases above, where the member's entries are
    // symlinks into the root's `node_modules` and the root's lock genuinely does describe the
    // install: that one still resolves, pinned as a control below.
    const nested = async (childDep: string): Promise<string | null> =>
      withProject(async root => {
        await project(root, { packageManager: "pnpm@11.18.0", lockfile: null });
        await writeFileAt(join(root, "pnpm-lock.yaml"), "parent lock\n");
        const child = join(root, "child");
        await writeFileAt(join(child, "package.json"), JSON.stringify({ name: "child", version: "0.0.0" }));
        // A REAL directory, not a link into the parent's install: this tree belongs to the child.
        await writeFileAt(
          join(child, "node_modules", "a", "node_modules", "b", "package.json"),
          JSON.stringify({ name: "b", version: childDep }),
        );
        return (await readInstallGraphIdentity(child)).lockfile;
      });

    expect(await nested("1.0.0")).toBeNull();
    expect(await nested("2.0.0")).toBeNull();

    // The control: a project with no `node_modules` of its own still resolves to the ancestor's
    // lock — this is the shape the ancestor walk exists for, and the fix must not disable it.
    const plain = await withProject(async root => {
      await project(root, { packageManager: "pnpm@11.18.0", lockfile: null });
      await writeFileAt(join(root, "pnpm-lock.yaml"), "parent lock\n");
      const child = join(root, "child");
      await writeFileAt(join(child, "package.json"), JSON.stringify({ name: "child", version: "0.0.0" }));
      return (await readInstallGraphIdentity(child)).lockfile;
    });
    expect(plain).not.toBeNull();
  });

  it("is unknown when a nested project carries a leftover lock the workspace root also has", async () => {
    // PR #114 review round 2, P1. A lockfile's *presence* is not proof that it owns the install this
    // project resolves in. Measured: a workspace member holding a leftover `package-lock.json`, with
    // the real `pnpm-lock.yaml` one level up and dependencies resolving from the root's
    // `node_modules` — the walk stopped at the member, hashed a lockfile describing no install, and
    // the digest stayed put while the root lock and its transitive dependencies moved.
    const memberWithLeftover = async (leftover: string): Promise<string | null> =>
      withProject(async root => {
        await project(root, { packageManager: "pnpm@11.18.0", lockfile: null });
        await writeFileAt(join(root, "pnpm-lock.yaml"), "root pnpm lock\n");
        const member = join(root, "packages", "member");
        await writeFileAt(join(member, "package.json"), JSON.stringify({ name: "member", version: "0.0.0" }));
        await writeFileAt(join(member, "package-lock.json"), JSON.stringify({ leftover }));
        return (await readInstallGraphIdentity(member)).lockfile;
      });

    // Two ancestors claim a lockfile, so which one owns the install is unestablished.
    expect(await memberWithLeftover("v1")).toBeNull();
    expect(await memberWithLeftover("v2")).toBeNull();

    // The control, and it is the case the ancestor walk exists for: a member with no lockfile of its
    // own still resolves to the workspace root's, so the stricter rule did not disable that.
    const memberClean = await withProject(async root => {
      await project(root, { packageManager: "pnpm@11.18.0", lockfile: null });
      await writeFileAt(join(root, "pnpm-lock.yaml"), "root pnpm lock\n");
      const member = join(root, "packages", "member");
      await writeFileAt(join(member, "package.json"), JSON.stringify({ name: "member", version: "0.0.0" }));
      return (await readInstallGraphIdentity(member)).lockfile;
    });
    expect(memberClean).not.toBeNull();
  });

  it("digests a binary lockfile from its bytes, so distinct files cannot collide", async () => {
    // PR #114 review round 2, P2. `bun.lockb` is binary, and reading it as UTF-8 replaces invalid
    // byte sequences with U+FFFD: measured, `[0x41, 0xff, 0x42]` and `[0x41, 0xfe, 0x42]` both
    // decoded to "A�B" and composed the identical digest, so a lockfile edit could leave the
    // identity unchanged. A digest two different files can share is not an identity.
    const forBytes = async (bytes: Uint8Array): Promise<string | null> =>
      withProject(async root => {
        await project(root, { packageManager: "bun@1.1.0", lockfile: null });
        await mkdir(dirname(join(root, "bun.lockb")), { recursive: true });
        await writeFile(join(root, "bun.lockb"), bytes);
        return (await readInstallGraphIdentity(root)).lockfile;
      });

    const a = new Uint8Array([0x41, 0xff, 0x42]);
    const b = new Uint8Array([0x41, 0xfe, 0x42]);

    // The premise: the two files differ as bytes but are indistinguishable as decoded text.
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0);
    expect(Buffer.from(a).toString("utf8")).toBe(Buffer.from(b).toString("utf8"));

    const digestA = await forBytes(a);
    const digestB = await forBytes(b);
    expect(digestA).not.toBeNull();
    expect(digestA).not.toBe(digestB);
  });

  it("is unknown when no manager is named and several lockfiles could be authoritative", async () => {
    // Guessing one of two is how the false fresh above happens, so the answer is `unknown` rather
    // than a value — #94's third criterion: an unestablished identity must not look complete.
    const twoLocks = await withProject(async root => {
      await project(root, {
        lockfile: null,
        extra: { "pnpm-lock.yaml": "a\n", "package-lock.json": JSON.stringify({ name: "consumer" }) },
      });
      return (await readInstallGraphIdentity(root)).lockfile;
    });
    // A lone lockfile *is* an answer even with no manager named: one file has told us what it is.
    const oneLock = await withProject(async root => {
      await project(root, {
        lockfile: null,
        extra: { "package-lock.json": JSON.stringify({ name: "consumer" }) },
      });
      return (await readInstallGraphIdentity(root)).lockfile;
    });

    expect(twoLocks).toBeNull();
    expect(oneLock).not.toBeNull();
  });

  it("reports a project with no patches as a known empty set, not as unknown", async () => {
    await withProject(async root => {
      await project(root);

      const identity = await readInstallGraphIdentity(root);

      // "No patches declared" is a fact, not a gap — the digest of every declared site being empty.
      // The digest moved from a bare array to a per-site object during review, so that no site can
      // shadow another; the sites are the workspace file, the manifest's top level, and the legacy
      // `pnpm` field (the pnpm 10 location, pnpm#11536). Conflating "none declared" with `null`
      // would make every unpatched project permanently stale.
      expect(identity.patches).toBe(
        digestOf(JSON.stringify({ manifestPnpm: [], manifestTopLevel: [], workspace: [] })),
      );
    });
  });

  it("reports an unreadable patch file as unknown rather than hashing what it could read", async () => {
    await withProject(async root => {
      await writeFileAt(join(root, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0" }));
      await writeFileAt(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      // A declaration naming a file that is not there. `pnpm install` would refuse this project
      // outright, so an identity claiming to describe it would be describing something else.
      await writeFileAt(
        join(root, "pnpm-workspace.yaml"),
        "patchedDependencies:\n  b@1.0.0: patches/missing.patch\n",
      );

      expect((await readInstallGraphIdentity(root)).patches).toBeNull();
    });
  });

  it("stops the ancestor walk at a lockfile it cannot read, rather than skipping to an ancestor's", async () => {
    await withProject(async root => {
      await project(root);
      const member = join(root, "packages", "member");
      await writeFileAt(join(member, "package.json"), JSON.stringify({ name: "member", version: "0.0.0" }));
      // A directory named like a lockfile stops the walk: reporting the root's identity for a
      // member whose own lockfile is unreadable would claim an install this process never read.
      await mkdir(join(member, "pnpm-lock.yaml"), { recursive: true });

      expect((await readInstallGraphIdentity(member)).lockfile).toBeNull();
    });
  });
});
