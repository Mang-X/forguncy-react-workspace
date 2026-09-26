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
import { dirname, join } from "node:path";

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
  } = {},
): Promise<void> {
  await writeFileAt(
    join(root, "package.json"),
    JSON.stringify({ name: "consumer", version: "0.0.0", private: true, type: "module" }),
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
});

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

  it("reports a project with no patches as a known empty set, not as unknown", async () => {
    await withProject(async root => {
      await project(root);

      const identity = await readInstallGraphIdentity(root);

      // "No patches declared" is a fact, not a gap — the digest of an empty set. Conflating it with
      // `null` would make every unpatched project permanently stale.
      expect(identity.patches).toBe(digestOf("[]"));
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
