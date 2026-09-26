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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("records the Node major line rather than the exact patch release", async () => {
    await withProject(async root => {
      await project(root);
      const identity = await readToolchainIdentity(root);

      // A major is where Node can change resolution; patch lines are bugfix-only. CI pins `"24"`,
      // so an exact version here would rot every committed lock on a schedule unrelated to the
      // project — a reason that fires for nothing is one readers learn to ignore.
      expect(identity.node).toBe(process.versions.node.split(".")[0]);
      expect(identity.node).not.toContain(".");
    });
  });

  it("produces one identity for a project however the caller spells its root", async () => {
    // Measured while wiring this up: `locatePackage`'s host primitive takes a `file:` URL or an
    // absolute path and throws `ERR_INVALID_URL` for a relative one, which this module read as
    // "not installed" — so a relative root reported `vitePlus: null` for a project whose Vite+ was
    // perfectly well installed. Every caller here passes an absolute root, so the bug was invisible
    // until the two spellings were compared, and it would have shipped as a record reported
    // `toolchain-unknown` for no reason.
    await withProject(async root => {
      await project(root);
      await install(root, "vite-plus", { name: "vite-plus", version: "0.3.9" });

      const spelledRelatively = relativeToCwd(root);
      // Asserted rather than skipped silently: if this ever becomes `null` the case stops measuring
      // the relative branch, and a green run would mean nothing.
      expect(spelledRelatively, "this platform cannot spell the temp root relatively").not.toBeNull();

      const absolute = await readToolchainIdentity(root);
      const relative = await readToolchainIdentity(spelledRelatively!);

      expect(relative).toEqual(absolute);
      expect(relative.vitePlus).toBe("0.3.9");
    });
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

  it("follows `packageManager` to the authoritative lockfile when several are present", async () => {
    // PR #114 review, P2. A migrating project easily leaves both `pnpm-lock.yaml` and
    // `package-lock.json` behind. Hashing whichever came first in a hardcoded order meant the digest
    // could cover a lockfile that describes no install: measured on an npm project with a stale pnpm
    // lock beside it, moving the *effective* npm lock's transitive dependency left the digest
    // byte-identical.
    // Both lockfiles are present in every run, and the case varies exactly one of them at a time.
    // A 2x2 matrix over (which file moved) x (which manager is named), so "follows the manager"
    // and "ignores the other file" are two separate assertions rather than one coincidence.
    const forManager = async (packageManager: string, pnpmText: string, npmDeps: string): Promise<string | null> =>
      withProject(async root => {
        // `lockfile: null` so the helper does not also write a pnpm lockfile: this case is about
        // which of several *present* lockfiles is authoritative, and both must be written here.
        await project(root, {
          packageManager,
          lockfile: null,
          extra: {
            "pnpm-lock.yaml": pnpmText,
            "package-lock.json": JSON.stringify({ name: "consumer", dependencies: { b: npmDeps } }),
          },
        });
        return (await readInstallGraphIdentity(root)).lockfile;
      });

    const NPM = "npm@11.0.0";
    const PNPM = "pnpm@11.18.0";

    // npm project: the npm lock is followed, the pnpm lock is ignored.
    const npmBase = await forManager(NPM, "pnpm v1\n", "1.0.0");
    expect(npmBase).not.toBeNull();
    expect(await forManager(NPM, "pnpm v1\n", "2.0.0")).not.toBe(npmBase);
    expect(await forManager(NPM, "pnpm v2\n", "1.0.0")).toBe(npmBase);

    // pnpm project: the mirror image, so the choice is the manager's rather than "always prefer one
    // name" — a fixed priority list would have answered identically in both halves.
    const pnpmBase = await forManager(PNPM, "pnpm v1\n", "1.0.0");
    expect(await forManager(PNPM, "pnpm v2\n", "1.0.0")).not.toBe(pnpmBase);
    expect(await forManager(PNPM, "pnpm v1\n", "2.0.0")).toBe(pnpmBase);
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

      // "No patches declared" is a fact, not a gap — the digest of two empty source lists (the
      // digest moved from a bare array to a per-source object in the PR #114 review fix, so that
      // one source cannot shadow the other). Conflating it with `null` would make every unpatched
      // project permanently stale.
      expect(identity.patches).toBe(digestOf(JSON.stringify({ manifest: [], workspace: [] })));
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
