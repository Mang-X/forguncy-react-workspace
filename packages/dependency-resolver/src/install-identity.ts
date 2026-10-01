/**
 * The identity of the install graph a probe actually resolved against, and of the tools that ran.
 *
 * Decision source: GitHub Issue #94 — "Probe 身份：采集真实安装图、补丁和实际构建工具版本"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/94
 *
 * Governing Specs: #8 (a lock record's `probedWith` is the identity its technical evidence is
 * judged against, and `toolchain-changed`/`toolchain-unknown` are the reasons it produces), #16
 * ("exact package/version/license/source", so the evidence is about one artifact), #17 (the
 * fingerprint must be recomputable without re-running the probe).
 *
 * ## The defect this module closes
 *
 * Identity used to be `readToolchainIdentity`, which read the **declared** `vite-plus` string out
 * of the project's `package.json`. Measured, on a scratch project whose root package was held at
 * `a@1.0.0`:
 *
 * | change | root version | composed fingerprint | identity moved |
 * | --- | --- | --- | --- |
 * | baseline | 1.0.0 | `probe=…;analysis=14;config={};bundler={…}` | — |
 * | transitive `b` 1.0.0 → 2.0.0 | 1.0.0 | byte-identical | **no** |
 * | a patch added | 1.0.0 | byte-identical | **no** |
 *
 * A manifest is a *request*, not an install result: two projects that both write
 * `"vite-plus": "0.3.2"` can run different bundlers, and one can carry a patched transitive
 * dependency the other does not. So a record could keep reporting `fresh` while the artifact it
 * described was gone — the failure #94 exists to remove.
 *
 * ## What identity is taken from
 *
 * Every component is read from the **installation**, never from a declaration:
 *
 * - `vitePlus` — the installed `vite-plus` manifest, resolved through the shared `package-locator`
 *   (#89), so `"^0.3.2"` and `"0.3.2"` stop naming one thing.
 * - `rolldown` — the standalone `rolldown` **this package** resolves, because that is the module
 *   `probe/build.ts` imports and therefore the bundler that actually ran. It is deliberately *not*
 *   read from Vite+: `vite-plus@0.3.2` does not depend on `rolldown` at all (measured), and a
 *   record that conflated the two would say nothing about a build that goes through the other.
 * - `node` — `process.versions.node`, the runtime that executed the probe.
 * - `installGraph` — the digests below.
 *
 * ## Scope, and why it is deliberately conservative
 *
 * The install-graph digests cover the lockfile, the declared patch set (declarations *and* the
 * files they name), and the configuration that affects resolution. They are **broader than
 * necessary**: a change to a dependency no probed package can reach still invalidates, because
 * deciding reachability is the bundler's answer and this layer does not re-derive it. Narrowing to
 * the reachable subgraph is a later optimisation; guessing here would trade a false *stale* for a
 * false *fresh*, and only one of those ships broken code.
 *
 * ## Portability
 *
 * Every digest is over file **content** and repository-relative *declaration* text. No absolute
 * path is ever an input, so the same real inputs in two directories compose the same identity —
 * which is what lets a lock written on one machine be judged on another. The patch path is hashed
 * as the declaration spells it (repository-relative), never as a resolved absolute path.
 *
 * ## Absence is not the same as unreadability
 *
 * A missing lockfile, or a project with no patches declared, is a **known** state: the digests say
 * so and are non-null. A file that is *present and unreadable* is `null` — "this process cannot
 * say" — and freshness reports that as `install-graph-unknown`, which is stale. The distinction is
 * the whole of #94's third acceptance criterion: an identity that cannot be established must not
 * be rendered as a complete-looking one.
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative as relativePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { InstallGraphIdentity, ToolchainIdentity } from "@forguncy-react-workspace/core";
import { FGC_LOCK_FILE_NAME } from "@forguncy-react-workspace/core";
import { parse as parseYaml } from "yaml";

import { locatePackage } from "./package-locator.ts";

/** This package's root, so `rolldown` is resolved from the tree that actually imports it. */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Lockfiles this toolchain recognizes, in preference order.
 *
 * One is chosen rather than all of them hashed: a project has one install graph, and hashing every
 * lockfile present would make an unrelated stray `yarn.lock` invalidate evidence about a pnpm
 * install. First match wins, and the order is the order these managers are supported in.
 */
export const RECOGNIZED_LOCKFILE_NAMES: readonly string[] = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

/**
 * Lockfiles that are **not** text, and so are digested as raw bytes.
 *
 * `bun.lockb` is Bun's binary lockfile (Bun moved its default to the text `bun.lock` in 1.2, but
 * older projects still carry the binary one). Reading it as UTF-8 is not merely lossy: invalid
 * byte sequences are replaced with U+FFFD, so two *different* byte strings can decode to the same
 * string. Measured — `[0x41, 0xff, 0x42]` and `[0x41, 0xfe, 0x42]` both decode to `"A�B"` and
 * composed the identical digest, which means a lockfile edit could leave the identity unchanged.
 *
 * For these files the digest is over the raw bytes and carries **no** line-ending normalization:
 * a binary file has no line-ending convention, and rewriting bytes that are not text would be a
 * different distortion of the same kind.
 */
const BINARY_LOCKFILE_NAMES: ReadonlySet<string> = new Set(["bun.lockb"]);

/** The workspace configuration file pnpm reads, which is where overrides and patches are declared. */
export const WORKSPACE_CONFIG_FILE = "pnpm-workspace.yaml";

/**
 * Artifacts **this toolchain** writes into a project, which are not the project's content.
 *
 * Excluded from a link target's digest for the same structural reason `node_modules` is, and
 * excluding them is not tidiness — two of the three made the identity self-referential:
 *
 * - `.fgc/` — the probe cache and synthetic build entries. Measured: including it made a workspace
 *   member's identity change on every read of an unchanged tree.
 * - `fgc.lock.json` and `fgc-evidence/` — the recorded evidence. These are this toolchain's
 *   *output* about the project, and a project that carries them has them inside the very target
 *   being digested. Measured: reading the identity, writing the lock, and reading it again in the
 *   same process produced two different values, because the first write had become part of the input
 *   to the second read. An identity that cannot survive recording its own evidence carries no
 *   information, and it would re-measure for ever.
 */
const TOOLCHAIN_ARTIFACT_NAMES: ReadonlySet<string> = new Set([".fgc", "fgc-evidence", FGC_LOCK_FILE_NAME]);

/** Whether an entry of a link target is one of this toolchain's own artifacts. */
function isToolchainArtifact(name: string): boolean {
  return TOOLCHAIN_ARTIFACT_NAMES.has(name);
}

/** Whether `path` is a readable directory. */
/**
 * Whether `path` is a directory, or `undefined` when that could not be established.
 *
 * Three states, because the caller reads this as a *fact about the install graph*: only `ENOENT` and
 * `ENOTDIR` say the entry is genuinely absent, and a readable path that is not a directory says it is
 * present and is something else. Every other error says **nothing**, and folding it into "absent"
 * turns "could not read" into "confirmed not there" — the false-fresh shape #94's third criterion
 * rules out. Review round 12: measured, `stat` of a `node_modules` inside a mode-`000` directory
 * returns `EACCES` for a non-root user (CI runs non-root), and that guard answers whether an external
 * link target carries its own install graph.
 *
 * A symlink **loop** does not reach here: `stat` follows a link without descending through it, so a
 * self-referential `node_modules` still reports a directory on both Windows and Linux (measured), and
 * a dangling one reports `ENOENT`, which is the absent case.
 */
async function directoryExists(path: string): Promise<boolean | undefined> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    const code = (error as { readonly code?: unknown } | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? false : undefined;
  }
}

/**
 * The install records the package managers write into their own `node_modules`.
 *
 * Named as constants so the two readers and their tests cannot drift on the spelling:
 * `node_modules/.modules.yaml` (pnpm) and `node_modules/.package-lock.json` (npm).
 */
const PNPM_MODULES_FILE = ".modules.yaml";
const NPM_INSTALL_RECORD = ".package-lock.json";

/**
 * The content digest of one file's text, with line endings normalized to `\n` first.
 *
 * **Normalization is required, not cosmetic**, and this was measured the hard way: the digest of a
 * file is not a property of the project unless it is independent of how git happened to check that
 * file out. This repository sets `core.autocrlf=true`, so a Windows working tree holds `pnpm-lock.yaml`
 * with CRLF while the committed bytes — and therefore CI's checkout — are LF. Hashing raw bytes made
 * one project produce two identities, and a lock re-recorded on Windows reported
 * `install-graph-changed` on Linux for a graph that had not moved.
 *
 * The line-ending convention a checkout uses is a fact about the *checkout*, not about the install.
 * `git` already normalizes the other direction on commit for exactly this reason, and #94's
 * portability criterion — "the same real inputs in different directories compose the same identity"
 * — cannot be met while a digest depends on the platform that read the file.
 *
 * The cost is that a change which only rewrites line endings no longer invalidates. That is the
 * correct answer rather than a tolerated one: such a change cannot alter what a bundler resolves or
 * emits, so reporting `install-graph-changed` for it would be a false positive of the same class as
 * tying a record to a Node patch release.
 */
function digestOf(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

/**
 * The content digest of a **binary** file's bytes, with no decoding and no normalization.
 *
 * The counterpart to {@link digestOf} for the files `BINARY_LOCKFILE_NAMES` names. Decoding first
 * would replace each invalid byte sequence with U+FFFD, so distinct byte strings could compose one
 * digest — measured, `[0x41, 0xff, 0x42]` and `[0x41, 0xfe, 0x42]` both became `"A�B"`. A
 * digest that two different files can share is not an identity.
 */
function digestOfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Sorted-key JSON, so the same inputs compose the same bytes regardless of property order.
 *
 * Deliberately local rather than shared with `probe/fingerprint.ts`: that module imports
 * `build.ts`, which imports `rolldown`, and this module is reachable from `local.ts` — the entry
 * whose whole purpose is to stay free of a bundler.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const entries = Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * What reading one file produced.
 *
 * Three states, because two would collapse the distinction this module's header is about:
 * `absent` is a known fact ("there is no lockfile"), while `unreadable` is the inability to say.
 */
type FileState =
  | { readonly kind: "absent" }
  | { readonly kind: "read"; readonly text: string }
  | { readonly kind: "unreadable" };

/** The same three states for a file read as bytes, for the lockfiles that are not text. */
type BinaryFileState =
  | { readonly kind: "absent" }
  | { readonly kind: "read"; readonly bytes: Uint8Array }
  | { readonly kind: "unreadable" };

/** Classifies a read failure: absence (`ENOENT`/`ENOTDIR`) versus a file that is there and unreadable. */
function failedKind(error: unknown): "absent" | "unreadable" {
  // Anything else (`EACCES`, `EISDIR`, an I/O error) is a file that is there and cannot be read.
  // Collapsing them would report "no lockfile" for a lockfile the reader can see in their own
  // directory listing.
  const code = (error as { readonly code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unreadable";
}

async function readTextFile(path: string): Promise<FileState> {
  try {
    return { kind: "read", text: await readFile(path, "utf8") };
  } catch (error) {
    return { kind: failedKind(error) };
  }
}

async function readBinaryFile(path: string): Promise<BinaryFileState> {
  try {
    const bytes = await readFile(path);
    // Copied into a plain `Uint8Array` because `readFile` may hand back a pooled `Buffer` view,
    // and the digest must be over exactly this file's bytes rather than a shared backing store.
    return { kind: "read", bytes: new Uint8Array(bytes) };
  } catch (error) {
    return { kind: failedKind(error) };
  }
}

/**
 * One lockfile that some ancestor holds, and where.
 *
 * `digest` is the file's content identity: text files are digested with line-ending normalization,
 * binary ones from their raw bytes (see {@link BINARY_LOCKFILE_NAMES}).
 */
interface LockfileClaim {
  readonly directory: string;
  readonly name: string;
  readonly digest: string;
}

/** Why no single lockfile could be identified. */
type InstallLockfileResult =
  | { readonly kind: "found"; readonly claim: LockfileClaim }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" };

/**
 * The one lockfile that describes this project's install, or why it cannot be named.
 *
 * **Ancestors, not just the project root**, because a workspace member has no lockfile of its own
 * and resolves through its workspace root's install — the shape `examples/probe-proving-cases` has
 * in this repository (measured: it declares `es-toolkit` and resolves it from the root's
 * `node_modules`, with the lockfile two levels up). Reading only `projectRoot` would report
 * `install-graph-unknown` for a project whose install graph is perfectly well described, and
 * withhold decisions the compiler accepts — the same misdirection as reporting a missing dependency
 * because the *project's* manifest was corrupt (#89).
 *
 * **Every ancestor is counted, and more than one claim is `unknown`.** This is the part a
 * first-match walk got wrong, and it is not hypothetical: a workspace member keeps its own
 * `node_modules` (so it looks self-contained) and often does *not* re-declare the root's
 * `packageManager`. Measured — a member holding a leftover `package-lock.json`, with the real
 * `pnpm-lock.yaml` one level up and dependencies resolving from the root's `node_modules`: the walk
 * stopped at the member, hashed a lockfile that describes no install, and the digest stayed put
 * while the root lock and its transitive dependencies moved. A lockfile's *presence* is not proof
 * that it owns the install this project resolves in, and guessing which one does is how that false
 * fresh happens.
 *
 * Each directory is asked only about the names its **own** manifest claims (see
 * {@link candidateNamesFor}), which narrows only on an **installed** manager and otherwise keeps
 * every recognized name. `unreadable` short-circuits to `unknown` rather than being skipped:
 * reporting an identity taken from a different file would describe an install this process never
 * read.
 */
async function findInstallLockfile(projectRoot: string): Promise<InstallLockfileResult> {
  // Absolute before the walk, so the ancestor search is over real directories rather than over the
  // caller's spelling of them. A relative root would still walk, but `dirname` on it eventually
  // reaches `""` and then `"."`, and the loop would terminate on a path that means "wherever the
  // process happens to be" — an identity that depends on the cwd.
  let directory = resolve(projectRoot);
  const claims: LockfileClaim[] = [];

  for (;;) {
    const names = candidateNamesFor();
    for (const name of names) {
      const path = join(directory, name);
      // A binary lockfile is digested from its bytes: decoding it first would let two distinct byte
      // strings compose one digest (`BINARY_LOCKFILE_NAMES` carries the measurement).
      if (BINARY_LOCKFILE_NAMES.has(name)) {
        const state = await readBinaryFile(path);
        if (state.kind === "unreadable") {
          return { kind: "unknown" };
        }
        if (state.kind === "read") {
          claims.push({ directory, name, digest: digestOfBytes(state.bytes) });
        }
        continue;
      }

      const state = await readTextFile(path);
      if (state.kind === "unreadable") {
        return { kind: "unknown" };
      }
      if (state.kind === "read") {
        claims.push({ directory, name, digest: digestOf(state.text) });
      }
    }

    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  if (claims.length === 0) {
    return { kind: "none" };
  }
  if (claims.length > 1) {
    // Two lockfiles both claim to describe this install — a member's leftover beside the workspace
    // root's, or two spellings in one directory. Which one resolution uses is exactly what could
    // not be established, and #94's third criterion forbids presenting an unestablished identity as
    // a complete one.
    return { kind: "unknown" };
  }

  const claim = claims[0]!;
  // A single ancestor claim is not proof that it owns the install *this* project resolves in.
  // Review round 4: a project with its own `node_modules` and no lockfile of its own — the parent
  // holding the only lockfile — still resolves through its own tree first, so the parent's lock
  // describes an install that is not the one being measured. Measured: keeping the parent lock and
  // the root package fixed while moving the child's own installed transitive dependency left all
  // three digests unchanged.
  if (!(await nearerInstallIsAttributableTo(resolve(projectRoot), claim.directory))) {
    return { kind: "unknown" };
  }
  return { kind: "found", claim };
}

/**
 * Whether every `node_modules` between `projectRoot` and `installRoot` belongs to `installRoot`'s
 * install, rather than to a closer one that no lockfile in the walk describes.
 *
 * **Why this is needed.** The walk finds the nearest ancestor *holding a lockfile*, but resolution
 * finds the nearest `node_modules` holding a *name* — and those are different questions. A
 * subproject with its own `node_modules` and no lockfile of its own resolves out of its own tree
 * first, while the only claim the walk sees is the parent's lock; the parent's lock then describes
 * an install that is not the one being measured, and its digest cannot move when the measured tree
 * does.
 *
 * **How it is decided.** A manager's install is *shared* by the members of its workspace through
 * symlinks: in this repository a member's `node_modules/@tanstack/react-query` is a link whose
 * realpath lands inside the root's `node_modules/.pnpm/…` (measured). An entry that already resolves
 * inside `installRoot` is therefore attributable to it, and a nearer tree made only of such entries
 * is the same install. An entry that resolves *outside* — a real directory, or a link elsewhere —
 * is a different install this walk cannot describe.
 *
 * Deliberately conservative in both directions: `true` only when every entry that can be resolved
 * lands inside `installRoot`. An unreadable or unresolvable entry makes the answer `false`, which
 * is `unknown` rather than a claim about a tree this process could not read.
 */
async function nearerInstallIsAttributableTo(projectRoot: string, installRoot: string): Promise<boolean> {
  // The directories strictly between the project and the install root, plus the project itself. The
  // install root's own `node_modules` is by definition its install, so it is not examined.
  const directories: string[] = [];
  let directory = projectRoot;
  for (;;) {
    if (directory === installRoot) {
      break;
    }
    directories.push(directory);
    const parent = dirname(directory);
    if (parent === directory) {
      // The project is not under the install root at all (a sibling tree resolved by some other
      // route); nothing here can attribute it, so the honest answer is "cannot say".
      return false;
    }
    directory = parent;
  }

  // The containment target, resolved lazily: a project with no `node_modules` anywhere has nothing
  // to attribute and nothing to contradict, so it stays attributable without ever needing the
  // target. Resolving eagerly would make that case `unknown` for no reason — and it is the ordinary
  // state of a project whose install has not been run yet.
  let canonicalInstallTree: string | null | undefined;
  const installTree = async (): Promise<string | null> => {
    if (canonicalInstallTree === undefined) {
      // **Canonicalized**, and that is not tidiness: the entry below is `realpath`'d while
      // `installRoot` arrives as whatever the walk spelled, so the two can differ for one directory.
      // Measured on Windows, where a runner's temp directory is an 8.3 short path
      // (`C:\Users\RUNNER~1\…`) that `realpath` expands to `runneradmin`: comparing an expanded entry
      // against a short root made `isInside` false for every package, so every install reported
      // `unknown`. That direction is fail-closed, but it disables the attribution check for a real
      // project on a real runner.
      canonicalInstallTree = await realpath(join(installRoot, "node_modules")).catch(() => null);
    }
    return canonicalInstallTree;
  };

  for (const candidate of directories) {
    const nodeModules = join(candidate, "node_modules");
    let entries: string[];
    try {
      entries = await readdir(nodeModules);
    } catch (error) {
      const code = (error as { readonly code?: unknown } | null)?.code;
      // Absent is the normal case for the directories in between: nothing to attribute.
      if (code === "ENOENT" || code === "ENOTDIR") {
        continue;
      }
      // Present and unreadable is "cannot say", not "no install here".
      return false;
    }

    // Every package directory at this level, with scopes expanded one level so `@scope/name` entries
    // are examined as the packages they are rather than skipped as a name that starts with `@`.
    const packagePaths: string[] = [];
    for (const entry of entries) {
      // Dot entries (`.bin`, `.package-lock.json`, and the install root's own `.pnpm`) are not
      // packages, so they say nothing about which install a name resolves to.
      if (entry.startsWith(".")) {
        continue;
      }
      const path = join(nodeModules, entry);
      if (entry.startsWith("@")) {
        let scoped: string[];
        try {
          scoped = await readdir(path);
        } catch {
          return false;
        }
        for (const name of scoped) {
          if (!name.startsWith(".")) {
            packagePaths.push(join(path, name));
          }
        }
        continue;
      }
      packagePaths.push(path);
    }

    for (const packagePath of packagePaths) {
      let resolved: string;
      try {
        // `realpath` follows a workspace link to the store path it points at, which is what makes
        // "is this the same install" answerable at all.
        resolved = await realpath(packagePath);
      } catch {
        return false;
      }
      // The install a lockfile describes is the one under **its own `node_modules`** — that is where
      // its tree lives (and, for pnpm, where `.pnpm/` is). Checking "under the install root
      // directory" instead would accept a subproject's tree, because a subproject is *inside* the
      // root's directory while having nothing to do with the root's install. A root with no tree at
      // all cannot own an entry that exists, so that is `false` — "cannot say".
      const target = await installTree();
      if (target === null || !isInside(target, resolved)) {
        return false;
      }
    }
  }

  return true;
}

/** Whether `candidate` is `directory` itself or lies beneath it, compared on normalized paths. */
function isInside(directory: string, candidate: string): boolean {
  const fold = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);
  const parent = fold(resolve(directory));
  const child = fold(resolve(candidate));
  return child === parent || child.startsWith(`${parent}${process.platform === "win32" ? "\\" : "/"}`);
}

/**
 * The lockfile spellings each manager can write, **unordered**.
 *
 * An ordering here would be a claim about which spelling that manager prefers, and for npm that
 * claim is version-dependent in a way this module cannot model safely: npm 11 documents
 * `npm-shrinkwrap.json` as taking precedence over `package-lock.json`, so an order of
 * `[package-lock, shrinkwrap]` hashes the file npm ignores. Measured: with both present and a
 * `packageManager` of `npm@11.0.0`, editing the *effective* shrinkwrap left the digest
 * byte-identical while editing the shadowed lock moved it — exactly backwards.
 *
 * A hardcoded order cannot be repaired by reversing it either, because the rule is not stable
 * across versions and this module has no verified model of npm 12. So the candidates are a *set*
 * and {@link findInstallLockfile} answers `unknown` when more than one is present. That is
 * the conservative direction #94 asks for: an identity that cannot be established must not be
 * presented as a complete one, and "unknown" costs a re-measurement while a wrong choice ships
 * stale evidence.
 */
/** The package managers whose lockfile spellings this toolchain knows. */
type ManagerKind = "pnpm" | "npm" | "yarn" | "bun";

const LOCKFILES_BY_MANAGER: Readonly<Record<string, readonly string[]>> = {
  pnpm: ["pnpm-lock.yaml"],
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

/**
 * The inverse of {@link LOCKFILES_BY_MANAGER}: the manager a lockfile name belongs to.
 *
 * Derived from that table rather than written out again, so a spelling added there cannot be
 * forgotten here — the two are the same fact from opposite ends, and a hand-copied second list is
 * the "second copy of a rule" this repository keeps finding.
 */
const MANAGER_BY_LOCKFILE: Readonly<Record<string, ManagerKind>> = Object.fromEntries(
  Object.entries(LOCKFILES_BY_MANAGER).flatMap(([manager, names]) =>
    names.map(name => [name, manager as ManagerKind] as const),
  ),
);

/**
 * The lockfile names a directory can be the install root of — every recognized name, always.
 *
 * **Neither the declaration nor installed-manager evidence narrows this**, and both halves of that
 * are deliberate.
 *
 * The declaration must not: an earlier revision selected by the manifest's `packageManager`, and
 * review showed why that repeats the mistake #94 was written about. A project declaring `pnpm` can
 * have had `npm install` run in it — Corepack does not intercept `npm` (its shims are not installed
 * by default, so `npm` resolves to the Node-bundled copy) — and then `package-lock.json` describes
 * the current install while the declared `pnpm` lockfile is stale. Measured: with a declared
 * `pnpm@11`, a stale `pnpm-lock.yaml` and a live `package-lock.json`, moving the npm transitive
 * dependency left the identity byte-identical, because the real lockfile had been excluded.
 *
 * **Installed-manager evidence does not narrow it either**, and that was measured rather than
 * assumed. A manager's own marker (`node_modules/.modules.yaml` for pnpm, which even names the
 * version that ran; `node_modules/.package-lock.json` for npm) was tried as the selector and then
 * removed for two reasons:
 *
 * - It **changed no outcome.** It narrowed only when every other recognized name was absent — and
 *   then those names contributed no claim anyway, so the collected set was identical. Measured:
 *   `"pnpm marker + pnpm lock only"` and `"no marker + pnpm lock only"` both resolve, and both
 *   ambiguity cases stay `unknown` either way.
 * - It **can be stale, in the unsafe direction.** Markers accumulate: an old pnpm install followed
 *   by `npm install` leaves `.modules.yaml` *and* `.package-lock.json`, and an old lockfile beside
 *   them. A selector trusting the marker would then pick the stale lockfile — measured, both markers
 *   present with both lockfiles. Counting claims instead reports `unknown`, which is safe.
 *
 * So the names stay a set, and ambiguity is resolved by counting claims in
 * {@link findInstallLockfile} — the direction that can only *add* a claim.
 */
const candidateNamesFor = (): readonly string[] => RECOGNIZED_LOCKFILE_NAMES;

/** A parsed YAML or JSON object, or why it could not be produced. */
type ParsedConfig =
  | { readonly kind: "absent" }
  | { readonly kind: "parsed"; readonly value: Record<string, unknown> }
  | { readonly kind: "unreadable" };

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readWorkspaceConfig(projectRoot: string): Promise<ParsedConfig> {
  const state = await readTextFile(join(projectRoot, WORKSPACE_CONFIG_FILE));
  if (state.kind !== "read") {
    return state;
  }
  try {
    const parsed = asPlainObject(parseYaml(state.text));
    // A YAML file whose top level is a scalar or a list is not a workspace config this toolchain
    // can read, which is an unreadable *config* rather than an absent one.
    return parsed === null ? { kind: "unreadable" } : { kind: "parsed", value: parsed };
  } catch {
    return { kind: "unreadable" };
  }
}

async function readProjectManifest(projectRoot: string): Promise<ParsedConfig> {
  const state = await readTextFile(join(projectRoot, "package.json"));
  if (state.kind !== "read") {
    return state;
  }
  try {
    const parsed = asPlainObject(JSON.parse(state.text));
    return parsed === null ? { kind: "unreadable" } : { kind: "parsed", value: parsed };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * The `patchedDependencies` map a config declares, normalized to string→string.
 *
 * Read from **every** site a pnpm version has honoured, and the sites are measured rather than
 * assumed:
 *
 * - `pnpm-workspace.yaml#patchedDependencies` — where pnpm 11 acts on it (measured: a declaration
 *   there produces a `patch_hash=` resolution key and a patched tree).
 * - `package.json#pnpm.patchedDependencies` — the **pnpm 10 and earlier** site (pnpm#11536 records
 *   pnpm 10.33.x still reading it, with the move to the workspace file landing in 11).
 * - `package.json#patchedDependencies` (top level) — silently ignored by pnpm 12.4.2, covered
 *   because it costs nothing and guards a project that believes it declared a patch.
 *
 * **The legacy site is read rather than modelled.** Review showed the gap: under `pnpm@10.x` the
 * manager is recognized and a complete-looking identity was produced, but a patch declared at
 * `pnpm.patchedDependencies` reached only {@link configurationDigest} — which covers the *declared
 * path*, not the file's contents. Measured: keeping the lockfile and the declared path fixed and
 * editing `patches/foo.patch` moved none of the three digests, so a patch edit could not invalidate
 * anything. Reading the legacy site here fixes that without needing a version-to-site table, and a
 * site that does not apply contributes an empty map — which is the correct answer for it.
 */
function patchDeclarations(config: ParsedConfig): Record<string, string> | null {
  if (config.kind === "absent") {
    return {};
  }
  if (config.kind === "unreadable") {
    return null;
  }
  const normalized = normalizePatchMap(config.value["patchedDependencies"]);
  return normalized;
}

/** One site's declarations, normalized, or `null` when a declaration cannot be interpreted. */
function normalizePatchMap(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) {
    return {};
  }
  const record = asPlainObject(value);
  if (record === null) {
    return null;
  }
  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      // A declaration this module cannot interpret is one it cannot claim to have covered, so it
      // reports unknown rather than hashing a shape it guessed at.
      return null;
    }
    normalized[key] = entry.trim();
  }
  return normalized;
}

/** One declared patch, with the content of the file it names. */
interface PatchEntry {
  readonly declaration: string;
  /** The path as the declaration spells it — repository-relative, so two checkouts agree. */
  readonly path: string;
  readonly content: string;
}

/** Resolves each declaration's file content, or `null` when one cannot be read. */
async function patchEntries(
  projectRoot: string,
  declarations: Readonly<Record<string, string>>,
): Promise<readonly PatchEntry[] | null> {
  const entries: PatchEntry[] = [];
  for (const declaration of Object.keys(declarations).sort()) {
    const path = declarations[declaration]!;
    const state = await readTextFile(join(projectRoot, ...path.split(/[\\/]/)));
    if (state.kind !== "read") {
      return null;
    }
    entries.push({ declaration, path, content: digestOf(state.text) });
  }
  return entries;
}

/**
 * The declared patch set, as one digest over every declaration and the file each names.
 *
 * Both halves are load-bearing. The **declaration** says which patches apply; the **file content**
 * says what they do, and a patch edited without a re-install is exactly the change a
 * declaration-only digest would miss.
 *
 * **Every source stays separate in the digest**, and that is a correctness requirement rather than
 * tidiness. Merging declarations into one `declaration → path` map let one site shadow another for
 * the same key — so with two sites declaring a patch for one dependency, the digest covered one
 * site's file while the package manager applied the other's. Measured: editing the *effective*
 * patch, with no re-install and an unchanged lockfile, left the digest byte-identical and the record
 * reporting `fresh` — a false fresh of exactly the class #94 removes.
 *
 * The sites are keyed individually, which is also what covers the **legacy** `pnpm@10` location
 * (`package.json#pnpm.patchedDependencies`): a patch declared there now contributes its file's
 * contents, where before only its declared path reached {@link configurationDigest} and editing the
 * file itself moved nothing.
 *
 * `null` when a declaration cannot be read or a named patch file is missing. A project with no
 * declarations yields the digest of three empty lists, which is a *known* answer rather than an
 * unknown one.
 */
async function patchesDigest(projectRoot: string, workspace: ParsedConfig, manifest: ParsedConfig): Promise<string | null> {
  // Every site pnpm has honoured, keyed separately so none can shadow another.
  const sites: { readonly site: string; readonly declarations: Record<string, string> | null }[] = [
    {
      site: "workspace",
      declarations:
        workspace.kind === "parsed" ? normalizePatchMap(workspace.value["patchedDependencies"]) : patchDeclarations(workspace),
    },
    {
      site: "manifestTopLevel",
      declarations:
        manifest.kind === "parsed" ? normalizePatchMap(manifest.value["patchedDependencies"]) : patchDeclarations(manifest),
    },
    {
      // The pnpm 10 and earlier site (pnpm#11536).
      site: "manifestPnpm",
      declarations:
        manifest.kind === "parsed" ? normalizePatchMap(asPlainObject(manifest.value["pnpm"])?.["patchedDependencies"]) : {},
    },
  ];

  const entries: Record<string, readonly PatchEntry[]> = {};
  for (const { site, declarations } of sites) {
    if (declarations === null) {
      return null;
    }
    const resolved = await patchEntries(projectRoot, declarations);
    if (resolved === null) {
      return null;
    }
    entries[site] = resolved;
  }

  // Keyed by source, so a declaration present in two sites is two entries rather than one shadowed
  // one.
  return digestOf(canonicalJson(entries));
}

/**
 * Manager configuration files that can change the installed tree without changing a lockfile.
 *
 * Named so the set is inspectable rather than scattered through the digest:
 *
 * - `.npmrc` — npm. `omit=optional` is the measured case: omitted dependencies stay in
 *   `package-lock.json` and are only skipped on disk.
 * - `.yarnrc.yml` — Yarn. `nodeLinker` selects `node-modules` versus PnP, which decides whether a
 *   `node_modules` tree exists at all.
 * - `bunfig.toml` — Bun, whose `[install].linker` is the same choice.
 *
 * A file that does not apply to the project's manager is simply absent, which contributes a known
 * `null`.
 */
const MANAGER_CONFIG_FILES: readonly string[] = [".npmrc", ".yarnrc.yml", "bunfig.toml"];

/**
 * The configuration that affects resolution, minus the patch declarations.
 *
 * Patch declarations are excluded on purpose: they are {@link patchesDigest}'s subject, and
 * hashing them here too would report one edit as two moved components. What remains is what this
 * component owns — workspace globs, catalogs, overrides, the package-manager field, and the manager
 * configuration files that change the installed tree — so the freshness diagnostic can say *which*
 * half moved.
 *
 * `null` when any config file is present and unreadable. An absent `pnpm-workspace.yaml` is
 * normal for a non-pnpm project and is not an unknown.
 */
async function configurationDigest(
  installRoot: string,
  workspace: ParsedConfig,
  manifest: ParsedConfig,
): Promise<string | null> {
  if (workspace.kind === "unreadable" || manifest.kind === "unreadable") {
    return null;
  }

  const workspaceFields =
    workspace.kind === "parsed"
      ? Object.fromEntries(Object.entries(workspace.value).filter(([key]) => key !== "patchedDependencies"))
      : null;

  const manifestFields =
    manifest.kind === "parsed"
      ? {
          packageManager: manifest.value["packageManager"] ?? null,
          overrides: manifest.value["overrides"] ?? null,
          resolutions: manifest.value["resolutions"] ?? null,
          pnpm: manifest.value["pnpm"] ?? null,
        }
      : null;

  // Manager configuration files that change the **installed tree without changing the lockfile**.
  // Review round 4: this module treats npm/yarn/bun lockfiles as verifiable identities, but only
  // pnpm's configuration was covered — so a non-pnpm project could change what is on disk while all
  // three digests held. Measured with npm's `omit=optional`: npm documents that omitted
  // dependencies are "still resolved and added to the package-lock.json", only "not physically
  // installed on disk", so the same lockfile describes two different trees and the record would stay
  // `fresh` across the switch.
  //
  // These are digested as **whole file contents** rather than by parsing each manager's schema: the
  // set of settings each one has that can change an install is not something this module can
  // enumerate reliably, and a parser per manager would be a second implementation to keep in step.
  // Content is the conservative answer — any edit invalidates, including one this module does not
  // understand, and a file that is absent contributes a known `null` rather than a guess.
  const managerConfigs: Record<string, string | null> = {};
  for (const name of MANAGER_CONFIG_FILES) {
    const state = await readTextFile(join(installRoot, name));
    if (state.kind === "unreadable") {
      // Present and unreadable is "cannot say", not "no config".
      return null;
    }
    managerConfigs[name] = state.kind === "read" ? digestOf(state.text) : null;
  }

  return digestOf(canonicalJson({ workspace: workspaceFields, manifest: manifestFields, managerConfigs }));
}

/**
 * The installed version of a package, resolved from `base`'s location, or null.
 *
 * `base` is made **absolute** before the lookup, and that is not a formality: `locatePackage`'s
 * host primitive (`module.findPackageJSON`) takes a `file:` URL or an absolute path and throws
 * `ERR_INVALID_URL` for a relative one. Measured — `readToolchainIdentity("examples/x")` reported
 * `vitePlus: null` while the identical project named by an absolute path reported `"0.3.2"`,
 * because the relative call was silently classified as "not installed".
 *
 * That asymmetry is exactly the class of defect #94 exists to remove: an identity that depends on
 * how a caller *spelled* a path rather than on what is installed. Every caller in this repository
 * passes an absolute root, so the bug was invisible until a test compared the two spellings — and
 * it would have surfaced as a record reported `toolchain-unknown` for a project whose toolchain is
 * perfectly well installed.
 */
async function installedVersion(base: string, request: string): Promise<string | null> {
  const location = await locatePackage(resolve(base), request);
  if (location.outcome === "failed") {
    return null;
  }
  return location.package.version ?? null;
}

/**
 * The install graph identity for `projectRoot`.
 *
 * Never throws: every failure to establish a component is reported as `null` in that component,
 * and freshness turns `null` into a stale answer. Throwing here would turn "you have not run
 * install yet" into a crash in the middle of an Agent flow, which is the same choice
 * `install-graph.ts` makes for an unresolved version.
 */
export async function readInstallGraphIdentity(projectRoot: string): Promise<InstallGraphIdentity> {
  const lockfile = await findInstallLockfile(projectRoot);
  if (lockfile.kind !== "found") {
    // No ancestor owns an install this toolchain can name — or more than one appears to. Either way
    // there is no graph to describe confidently, and the answer is unknown rather than an identity
    // over the project's own files: those files would describe a resolution *request*, which is the
    // reading #94 exists to replace.
    return { lockfile: null, patches: null, configuration: null };
  }

  // The install root is the directory the single lockfile claim came from, so the patches and
  // configuration are read from **there** rather than from `projectRoot`: overrides and patches are
  // declared where the install is, so a workspace member's `patchedDependencies` live in the root's
  // `pnpm-workspace.yaml`. Reading them one level down would report "no patches" for a project
  // whose install carries them, and the record would look fresh through exactly the change this
  // axis exists to catch.
  const installRoot = lockfile.claim.directory;
  const [workspace, manifest] = await Promise.all([
    readWorkspaceConfig(installRoot),
    readProjectManifest(installRoot),
  ]);

  const [patches, configuration, installedTree] = await Promise.all([
    patchesDigest(installRoot, workspace, manifest),
    configurationDigest(installRoot, workspace, manifest),
    // The claim's own lockfile decides which manager's record to read, so a stale marker from a
    // previous manager cannot answer for the one that is actually installed (see the function).
    installedTreeDigest(installRoot, lockfile.claim.name),
  ]);

  return { lockfile: lockfile.claim.digest, patches, configuration, installedTree };
}

/**
 * What the package manager actually installed, from its own on-disk record, or `null` when it
 * writes none this toolchain can read.
 *
 * **Why this exists at all.** Every other component describes an input, and review showed inputs
 * cannot confirm a result: part of the effective install is decided by *install-time* parameters
 * that reach no digest. npm derives its `omit` default from `process.env.NODE_ENV` and accepts
 * `--omit=optional`, and neither is recorded in `package-lock.json` or `.npmrc`. Measured end to
 * end: on one real npm project, a default install puts `@rolldown/binding-win32-x64-msvc` on disk
 * while `npm install --omit=optional` does not, and both runs leave a **byte-identical**
 * `package-lock.json` — so every earlier component composed the same digest while the tree a probe
 * would measure had changed.
 *
 * **pnpm** writes `node_modules/.modules.yaml`, and two of its fields are exactly this fact:
 *
 * - `included` — which dependency classes were installed. Measured: `pnpm install --no-optional`
 *   flips `optionalDependencies` to `false` and drops the platform binding from disk.
 * - `nodeLinker` — the layout (`isolated` / `hoisted`), which decides what a `node_modules` tree
 *   even looks like.
 *
 * Both are **portable**, which is why they are the fields chosen: measured, they are plain booleans
 * and a short enum with no machine path. `skipped`, by contrast, lists other platforms' bindings and
 * would make the digest churn between a Windows and a Linux checkout of one project — the same
 * defect the CRLF normalization in `digestOf` exists to avoid.
 *
 * **npm** writes `node_modules/.package-lock.json`, the materialized entry set. It captures the
 * result (the omitted binding is absent from it — measured) and it is deliberately hashed as-is,
 * including the platform-specific entry names: those really are different installs, and the honest
 * answer is that a record measured on one does not describe the other.
 *
 * **Which record is read follows the lockfile the walk already identified**, and that is a
 * correctness requirement rather than a tidy-up. Choosing by first match re-trusted the accumulated
 * markers review had already measured: a project that ran `pnpm install` and later `npm install`
 * keeps **both** markers, so with `pnpm-lock.yaml` deleted — the migration case — the walk correctly
 * identifies npm while a first-match read still preferred the stale `.modules.yaml`. Measured: npm's
 * materialized entry set changed under `--omit=optional` and `installedTree` did not move.
 *
 * So the manager comes from the claim: pnpm's lockfile reads pnpm's record, npm's reads npm's. A
 * manager whose record this toolchain cannot read — yarn, bun — is `null`, and so is a claim whose
 * manager has no record reader at all. Inventing a marker would be the guess #94 exists to remove.
 */
async function installedTreeDigest(installRoot: string, lockfileName: string): Promise<string | null> {
  const manager = MANAGER_BY_LOCKFILE[lockfileName] ?? null;
  if (manager === "pnpm") {
    return pnpmInstalledTreeDigest(installRoot);
  }
  if (manager === "npm") {
    return npmInstalledTreeDigest(installRoot);
  }
  // yarn, bun, or a lockfile name with no reader: the result record is not something this toolchain
  // can verify, so the answer is `unknown` rather than a value taken from a different manager's file.
  return null;
}

/** pnpm's `node_modules/.modules.yaml`, as the two portable fields that record the layout. */
async function pnpmInstalledTreeDigest(installRoot: string): Promise<string | null> {
  const modules = await readTextFile(join(installRoot, "node_modules", PNPM_MODULES_FILE));
  if (modules.kind === "unreadable") {
    return null;
  }
  if (modules.kind !== "read") {
    return null;
  }
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asPlainObject(parseYaml(modules.text));
  } catch {
    return null;
  }
  if (parsed === null) {
    return null;
  }
  // The fields that decide what is on disk *and* what resolution can reach:
  //
  // - `included` — which dependency classes were installed.
  // - `nodeLinker` — `isolated` versus `hoisted`.
  // - `hoistPattern` / `publicHoistPattern` — which undeclared packages are lifted into the root
  //   and virtual-store `node_modules`, i.e. which names Node and Rolldown can find at all. Review
  //   round 6: the CLI changes these while `included` and `nodeLinker` hold still, so omitting them
  //   left a real layout change invisible. Measured: `pnpm install --shamefully-hoist` moves
  //   `publicHoistPattern` from `[]` to `["*"]` with the other two unchanged.
  //
  // `hoistedDependencies` is deliberately **not** here, and both halves of that were measured on a
  // real install. It is not a better signal: `pnpm install --public-hoist-pattern='@rolldown/*'`
  // changed `publicHoistPattern` while `hoistedDependencies` stood still, so it would have missed
  // the very case the patterns catch. And it is not *portable*: its keys name the platform's own
  // binary — `@rolldown/binding-win32-x64-msvc` on this machine, the linux binding on CI — so
  // digesting it would make a committed lock churn between platforms, which is the portability rule
  // #94 requires and the same defect the CRLF normalization in `digestOf` exists to avoid.
  const fields = {
    included: parsed["included"],
    nodeLinker: parsed["nodeLinker"],
    hoistPattern: parsed["hoistPattern"],
    publicHoistPattern: parsed["publicHoistPattern"],
  };
  // A record missing any of them is one this toolchain cannot claim to have covered. `?? null`
  // would silently digest an absent pattern as if it were the empty one.
  if (Object.values(fields).some(value => value === undefined)) {
    return null;
  }

  // The layout fields above describe the *strategy*; the virtual store names the *result*. Review
  // round 7: with `--no-lockfile` (or a stale lock left in place), pnpm re-resolves from the
  // manifest and registry, so a transitive can move `b@1` → `b@2` while every layout field and the
  // old lockfile digest hold still. Measured: two `--no-lockfile` installs of the same tree produce
  // records that differ only in the `prunedAt` timestamp — every digestable field identical. The
  // store's directory names are the installed package identities (`is-odd@3.0.1`,
  // `@scope/pkg@2.0.0`), so they capture exactly that move.
  //
  // They are **portable**, which is why they are the signal: a directory under `.pnpm/` is
  // `name@version` (plus a peer hash), with no machine path. Platform-specific *binaries* do appear
  // when the platform's own binding is installed — measured, `@rolldown/binding-win32-x64-msvc@…` —
  // and those really are different installs, the same reasoning the npm side records deliberately.
  // **Where the store is, comes from the record rather than from a hardcoded `.pnpm`.** Review
  // round 11: pnpm writes the real location to `.modules.yaml#virtualStoreDir` and the CLI accepts
  // `--virtual-store-dir`, so a project can legitimately have its live store somewhere else while a
  // stale default `.pnpm` remains on disk. Measured: a live store at `node_modules/.alt` with a
  // leftover `.pnpm`, a fixed lockfile and identical layout fields — moving a package inside the
  // live store left this digest byte-identical, because the hardcoded path named a store the
  // install no longer used.
  //
  // The recorded value is a **machine absolute path**, so it is used only to *locate* the store and
  // never enters the digest; a relative value is resolved against `node_modules`, which is what
  // pnpm's own reader does. A value this module cannot read as a path is `unknown` rather than a
  // fall back to `.pnpm` — guessing the default is the defect this replaces.
  const storeDirectory = await pnpmStoreDirectory(installRoot, parsed["virtualStoreDir"]);
  if (storeDirectory === null) {
    return null;
  }
  // Every slot, described by the **identities** it holds: the store's own directory names for what it
  // installed, and its link graph for how those resolve against each other.
  //
  // Measured shape of a real store (this repository, pnpm 11): 111 slots, of which 99 entries are
  // symlinks into another slot — pnpm's deduplication — and 111 are the slot's own package as a real
  // directory. A registry package's identity **is** the `name@version` directory it lives in, which is
  // what round 7 established and what this round's `digests what the manager installed` test pins: a
  // transitive that moves `b@1` → `b@2` renames a slot while every layout field and the lockfile digest
  // hold still. Digesting the 8 509 files behind those directories measured **5.6 s** per read and
  // could not answer a question the names already answer.
  //
  // So each slot contributes:
  //
  // - a line for **itself**, named by the directory it lives in.
  // - a line per **link**, by the store-relative slot it points at — a real link is written absolute,
  //   and a digest carrying one would not survive a checkout elsewhere.
  //
  // Two shapes make that naming necessary rather than incidental:
  //
  // - a **scoped** package sits inside a `@scope` container directory, which is a namespace and not a
  //   package. Descending through it is not optional: reading `@babel` as a package walks into the
  //   symlinks beside it and fails, which is how a perfectly readable install came to answer
  //   `unknown`.
  // - a `file:`/injected **copy** is also a real directory, and its name does *not* move when its
  //   files do — that is `injectedDepsDigest` below, driven by the paths pnpm records.
  const store: string[] = [];
  let slots: Dirent[];
  try {
    // `withFileTypes` avoids a stat per entry, and the `node_modules` subdirectory inside the store
    // is the shared root the links point into rather than a package, so it is excluded by name.
    slots = (await readdir(storeDirectory, { withFileTypes: true })).filter(
      entry => entry.isDirectory() && entry.name !== "node_modules",
    );
  } catch {
    // No store on disk: `nodeLinker: hoisted` or an incomplete install. The layout fields above are
    // still a partial answer, but a partial answer to "what did this install" is the unknown the
    // third criterion asks for rather than a value pretending to be complete.
    return null;
  }

  for (const slot of slots.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const slotRoot = join(storeDirectory, slot.name, "node_modules");
    let names: string[];
    try {
      names = await readdir(slotRoot);
    } catch {
      return null;
    }
    // The slot is the record of one package identity, and it is recorded even when nothing below it
    // is a link — otherwise a slot that holds only its own package contributes nothing, and two
    // installs differing by exactly such a slot would digest alike.
    store.push(slot.name);
    for (const name of names.sort()) {
      // A `@scope` entry is a namespace directory holding this slot's package and links to its
      // dependencies; it is descended into rather than described, and its entries follow the same two
      // rules one level down.
      if (name.startsWith("@")) {
        const scopeRoot = join(slotRoot, name);
        let members: string[];
        try {
          members = await readdir(scopeRoot);
        } catch {
          return null;
        }
        for (const member of members.sort()) {
          const described = await describeStoreEntry(
            join(scopeRoot, member),
            `${slot.name}/${name}/${member}`,
            storeDirectory,
            store,
          );
          if (!described) {
            return null;
          }
        }
        continue;
      }
      const described = await describeStoreEntry(join(slotRoot, name), `${slot.name}/${name}`, storeDirectory, store);
      if (!described) {
        return null;
      }
    }
  }

  // Link targets last, because they are the one part of the result no manager's own record
  // describes: the store names registry packages, while a workspace dependency is a symlink out of
  // the tree whose *files* are the artifact (see `linkTargetsDigest`).
  const links = await linkTargetsDigest(installRoot);
  if (links === null) {
    return null;
  }

  // `injectedDeps` next, because a slot **name** is not the artifact it names. Review round 11: with
  // `injectWorkspacePackages`, a workspace dependency is materialized as a real directory
  // `node_modules/.pnpm/<name>@file+<name>/node_modules/<name>`, and `syncInjectedDepsAfterScripts`
  // rewrites the files *inside* it while the slot name, the lockfile and every layout field hold
  // still. Measured: syncing that copy moved nothing. So the copy's own content is digested; if a
  // recorded injected dependency cannot be read, the answer is `unknown` rather than a slot name.
  const injected = await injectedDepsDigest(installRoot, storeDirectory, parsed["injectedDeps"]);
  if (injected === null) {
    return null;
  }

  // Build state last, because it is the one manager field that describes something this module then
  // has to read off disk itself. Review round 11: a slot's **name** does not cover what a lifecycle
  // script left behind in it. Measured on a real registry package — `esbuild@0.25.0`, whose postinstall
  // writes `bin/esbuild` — removing that generated file left `installedTree` byte-identical, so a
  // package whose `main`/`exports` points at it could switch from buildable to missing with a warm
  // cache answering from the old probe.
  //
  // pnpm records who may build and who has not yet, but **not** what the build produced:
  //
  // | install | `allowBuilds` | `pendingBuilds` | `out.js` on disk |
  // | --- | --- | --- | --- |
  // | build ran | `{"bscript@file:vendor/b": true}` | `[]` | present |
  // | `--ignore-scripts` | `{"bscript@file:vendor/b": true}` | `["bscript@file:vendor/b"]` | absent |
  //
  // `allowBuilds` alone cannot tell those apart, which is why the record decides *whether to read*
  // and the files decide *what it is*: every slot the record implicates is digested by content.
  //
  // **What this does not cover, measured rather than assumed.** A package pnpm never approved has no
  // record naming it — an `is-odd@3.0.1` install writes `"allowBuilds": {}` and nothing else — so its
  // slot is read by name only. The alternative was to find such slots by reading each package's
  // manifest and looking for an install script: that measured **391 ms** for 292 manifests, and it is
  // not a sound signal either, because a script that exists is not a script that ran. An unapproved
  // package's build output is therefore still invisible here, and the honest report is that this axis
  // covers the builds the manager recorded rather than every build a script could have performed.
  const builds = await builtSlotsDigest(installRoot, storeDirectory, parsed, slots);
  if (builds === null) {
    return null;
  }

  return digestOf(canonicalJson({ ...fields, store: store, links, injected, builds }));
}

/**
 * The content of every slot pnpm's record says may have been built by a lifecycle script, or `null`
 * when one of them cannot be read.
 *
 * The store walk names slots; this reads the ones whose **content** a script produced. It is
 * deliberately scoped to the slots the record implicates rather than applied to the whole store:
 * digesting every slot measured **5.6 s** per read across 8 509 files, and the names already answer
 * the question for a package nothing built.
 *
 * Two key shapes occur, both measured, and both are matched to a slot by prefix rather than by being
 * composed: `allowBuilds` wrote `{"esbuild": true}` for a registry package and
 * `{"buildy@file:vendor/buildy": true}` for a `file:` one, while `pendingBuilds`/`ignoredBuilds`
 * wrote `name@version`. pnpm encodes a scope in a slot directory as `+` (`@esbuild+win32-x64@0.25.0`),
 * so a scoped key matches its slot only after that substitution.
 *
 * The three fields are also three **shapes**: `allowBuilds` is an object keyed by package, while
 * `pendingBuilds` and `ignoredBuilds` are **arrays** of keys (measured: `"pendingBuilds": []`,
 * `"ignoredBuilds": ["esbuild@0.25.0"]`). Reading an array as an object is not a near-miss — it reads
 * as a shape this module cannot interpret and answers `unknown`, which is how one field's container
 * would have made every install unverifiable.
 */
async function builtSlotsDigest(
  installRoot: string,
  storeDirectory: string,
  parsed: Record<string, unknown>,
  slots: readonly Dirent[],
): Promise<readonly string[] | null> {
  const implicated = new Set<string>();
  for (const field of ["allowBuilds", "pendingBuilds", "ignoredBuilds"]) {
    const value = parsed[field];
    if (value === undefined || value === null) {
      continue;
    }
    const declared = asPlainObject(value);
    if (declared !== null) {
      for (const key of Object.keys(declared)) {
        implicated.add(key);
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const key of value) {
        if (typeof key !== "string") {
          return null;
        }
        implicated.add(key);
      }
      continue;
    }
    // Present but neither object nor array is a shape this module cannot interpret, so it cannot
    // claim to know which slots were built.
    return null;
  }

  // An empty set does **not** mean "no slot was built". Review round 12 established that
  // `dangerouslyAllowAllBuilds` runs every lifecycle script regardless of `allowBuilds` and records
  // nothing about it; round 13 found the deeper reason my round-12 fix was built on the wrong thing.
  // The policy is **resolved configuration**, not installation state: pnpm's `env_overlay.rs` folds
  // `PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS` into it, and it also has user- and global-level config
  // layers. Measured: `PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS=true pnpm install` in a project with
  // **no** `.npmrc` wrote `allowBuilds: {}` / `pendingBuilds: []` and left no trace of the policy
  // anywhere on disk — not in `.modules.yaml`, not in `pnpm-lock.yaml`, not in the store. Reading the
  // environment at probe time does not fix it either: the probe's environment is not the
  // install-time witness, and the question is what the disk holds.
  //
  // **Neither alternative can be made sound, so this is `unknown`.** Measured, in order:
  //
  // - Reading the project's configuration — round 12's approach — answers "off" for the env-driven
  //   install above and returned a byte-identical digest before and after the built artifact changed.
  // - Enumerating slots whose own manifest declares `preinstall`/`install`/`postinstall` costs 300 ms
  //   and finds one buildable slot on this repository, but a dependency's install script is written by
  //   *its* publisher and does not have to be declared at all: the same fixture wrote a build output
  //   into `is-odd@3.0.1`, which declares no script, and stayed invisible.
  // - Digesting **every** slot's content catches it, and measured 12.7 s for 14 281 files — a cost
  //   every probe would pay to answer a question that is still not provable from the tree.
  //
  // So the empty record is not evidence, and the slots that could have been built are enumerated from
  // the disk instead: a dependency can only be built by a script **its own manifest declares**, so
  // those slots are digested by content and everything else stays name-only. That needs no policy and
  // no witness, and it is what catches the env-driven install above: measured on a real
  // `PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS=true pnpm install` of `esbuild`, the enumeration finds
  // exactly `esbuild@0.25.0` and reads the `bin/esbuild` its postinstall wrote.
  //
  // The cost is why this is enumeration and not a blanket pass. Measured on this repository: reading
  // **every** slot's content is 12.7 s for 14 281 files, while reading 292 manifests costs 300 ms and
  // finds **one** buildable slot (`@swc+core@1.16.2`), whose content then costs 54 ms — 354 ms to
  // answer a question 12 s would answer the same way but at thirty-four times the price.
  //
  // **The limit of this, stated rather than glossed.** It rests on a dependency's install script being
  // declared in its manifest, which is how a published package is built but is not something a script
  // written outside the package is obliged to honour. A build output added to a package that declares
  // no install script stays invisible here. That is narrower than "every build a script could have
  // performed", and it is the honest width: the alternative is the 12.7 s pass, which costs every
  // probe and still cannot prove the artifact came from a build rather than from anywhere else.
  if (implicated.size === 0) {
    const buildable: string[] = [];
    for (const slot of slots) {
      const declares = await slotDeclaresInstallScript(storeDirectory, slot.name);
      if (declares === null) {
        return null;
      }
      if (declares) {
        buildable.push(slot.name);
      }
    }
    if (buildable.length === 0) {
      return [];
    }
    const all: string[] = [];
    for (const slotName of buildable.sort()) {
      const files = await storeSlotContentDigest(storeDirectory, slotName);
      if (files === null) {
        return null;
      }
      all.push(`${slotName}:${files}`);
    }
    return all;
  }

  const digests: string[] = [];
  for (const key of [...implicated].sort()) {
    // A key is `name` or `name@version`; a slot directory is `name@version`, with `+` for a scope.
    const slotName = key.replace("/", "+");
    const matching = slots.filter(slot => slot.name === slotName || slot.name.startsWith(`${slotName}@`));
    if (matching.length === 0) {
      // A key naming no slot here is an ordinary fact, not a gap: pnpm records an approval in
      // `package.json` and keeps it in `allowBuilds` across installs that never installed the
      // package. Measured: this repository approves `esbuild` and holds no `esbuild` slot at all,
      // while `{"@swc/core": true}` does match `@swc+core@1.16.2`. Answering `unknown` here would
      // make every project carrying a stale approval unverifiable, so the key is recorded as named
      // and the slots that do exist are read.
      digests.push(`${slotName}:absent`);
      continue;
    }
    for (const slot of matching) {
      const files = await storeSlotContentDigest(storeDirectory, slot.name);
      if (files === null) {
        return null;
      }
      digests.push(`${slot.name}:${files}`);
    }
  }
  return digests;
}

/**
 * Whether a slot's own package declares an install lifecycle script, or `null` when its manifest
 * cannot be read.
 *
 * This is what lets an empty build record be answered from the disk rather than from policy: pnpm runs
 * a dependency's install script from the slot it installed, so a slot whose manifest declares no
 * `preinstall`/`install`/`postinstall` has nothing pnpm would have run there.
 *
 * **A declared script is not a claim that it ran** — a package may declare one that never executed.
 * That is harmless here because this only *selects* slots; what was read is the slot's **content**, so
 * "declared but never ran" and "ran" are told apart by the files rather than by the declaration.
 *
 * `null` on a manifest that is present and unparseable, because a manifest this module cannot read is
 * one whose build policy it cannot rule out. An absent `package.json` is not that case — pnpm has
 * already materialized the slot, so the package is present, and a package with no manifest declares
 * no script.
 */
async function slotDeclaresInstallScript(storeDirectory: string, slotName: string): Promise<boolean | null> {
  for (const root of await slotOwnPackageRoots(storeDirectory, slotName)) {
    if (root === null) {
      return null;
    }
    const manifest = await readTextFile(join(root, "package.json"));
    if (manifest.kind === "unreadable") {
      return null;
    }
    if (manifest.kind !== "read") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifest.text);
    } catch {
      return null;
    }
    const declaration = asPlainObject(parsed);
    const scripts = declaration === null ? null : asPlainObject(declaration["scripts"]);
    if (
      scripts !== null &&
      ["preinstall", "install", "postinstall"].some(name => typeof scripts[name] === "string")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The slot's own package directories, following a `@scope` container and skipping links, or a single
 * `null` when the slot cannot be read at all.
 *
 * A link inside a slot is a **dependency**, not the slot's own package — the store walk records those
 * by the slot they point at — and a `@scope` entry is a namespace directory rather than a package, so
 * it is descended into rather than read.
 */
async function slotOwnPackageRoots(storeDirectory: string, slotName: string): Promise<(string | null)[]> {
  const slotRoot = join(storeDirectory, slotName, "node_modules");
  let entries: Dirent[];
  try {
    entries = await readdir(slotRoot, { withFileTypes: true });
  } catch {
    return [null];
  }
  const roots: (string | null)[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (!entry.name.startsWith("@")) {
      roots.push(join(slotRoot, entry.name));
      continue;
    }
    const members = await scopeMembers(slotRoot, entry.name);
    if (members === null) {
      return [null];
    }
    roots.push(...members);
  }
  return roots;
}

/**
 * The content of one slot's own package, or `null` when it cannot be read.
 *
 * Deliberately the slot's own package and not everything under it: the dependency links beside it are
 * the store walk's business, and following them would re-digest the store through every slot.
 */
async function storeSlotContentDigest(storeDirectory: string, slotName: string): Promise<string | null> {
  // `slotOwnPackageRoots` decides which directory is this slot's own package, so the slot selected
  // for reading and the files read from it cannot drift apart.
  const roots = await slotOwnPackageRoots(storeDirectory, slotName);
  const collected: string[] = [];
  for (const root of roots) {
    if (root === null) {
      return null;
    }
    const files = await collectPackageFiles(root, root);
    if (files === null) {
      return null;
    }
    collected.push(...files);
  }
  return collected.length === 0 ? null : digestOf(canonicalJson(collected.sort()));
}

/** The real package directories inside a `@scope` container, or `null` when it cannot be read. */
async function scopeMembers(slotRoot: string, scope: string): Promise<string[] | null> {
  let members: Dirent[];
  try {
    members = await readdir(join(slotRoot, scope), { withFileTypes: true });
  } catch {
    return null;
  }
  const roots: string[] = [];
  for (const member of members) {
    if (!member.isSymbolicLink() && member.isDirectory()) {
      roots.push(join(slotRoot, scope, member.name));
    }
  }
  return roots;
}

/**
 * One entry inside a slot's `node_modules`, appended to the store description.
 *
 * A **link** is the store's deduplication: its identity is the slot it points at, recorded relative
 * to the store so a checkout in another directory composes the same digest. A **real directory** is
 * the slot's own package — the enclosing `name@version` directory is its identity, and a `file:`/
 * injected copy is covered by `injectedDepsDigest` from the path pnpm records — so the name already
 * says what the files would say, at a measured 5.6 s per read for the whole store instead.
 *
 * `false` when a link points outside the store, or when its target cannot be resolved: content this
 * module cannot describe by name, which the caller answers as `unknown` rather than a partial value.
 */
async function describeStoreEntry(
  path: string,
  slotRelativeName: string,
  storeDirectory: string,
  described: string[],
): Promise<boolean> {
  const link = await readlink(path).catch(() => null);
  if (link === null) {
    return true;
  }
  const resolved = await realpath(path).catch(() => null);
  if (resolved === null) {
    return false;
  }
  const target = relativePath(storeDirectory, resolved).split(/[\\/]/).join("/");
  if (target.startsWith("..")) {
    return false;
  }
  described.push(`${slotRelativeName} -> ${target}`);
  return true;
}

/**
 * Where pnpm's virtual store actually is, from the record it writes.
 *
 * `virtualStoreDir` is a **machine absolute path** on a real install (measured), and may be relative
 * when the CLI was given one, which pnpm's own reader resolves against the modules directory. Either
 * way it is used only to *locate* the store — it never enters a digest, so a lock recorded on one
 * machine still matches on another.
 *
 * `null` when the record states a value this module cannot read as a path, or when the value is
 * absent and the default is not usable. Falling back to the default unconditionally is the defect
 * round 11 removed: a project whose live store is elsewhere would then be digested from a stale one.
 */
async function pnpmStoreDirectory(installRoot: string, recorded: unknown): Promise<string | null> {
  const modulesDirectory = join(installRoot, "node_modules");
  if (recorded === undefined) {
    // No location recorded. A default store that exists is the install; one that does not means this
    // record describes an install this module cannot find.
    const defaultStore = await directoryExists(join(modulesDirectory, ".pnpm"));
    // `undefined` means the store could not be read, which is not the same as "there is no default
    // store": guessing either way is what round 11 removed.
    return defaultStore === true ? join(modulesDirectory, ".pnpm") : null;
  }
  if (typeof recorded !== "string" || recorded.trim().length === 0) {
    return null;
  }
  const value = recorded.trim();
  return isAbsolute(value) ? value : join(modulesDirectory, value);
}

/**
 * The content of every injected dependency copy pnpm materialized, or `null` when one cannot be read.
 *
 * `injectedDeps` maps a `file:`/injected dependency's **project-relative directory** to the paths of
 * the copies pnpm wrote for it, and **which** form those paths take follows the store. Measured on two
 * real installs of the same tree:
 *
 * - `--virtual-store-dir=.altstore` (inside the project) recorded `.altstore/…/file-lib`, relative to
 *   the project.
 * - `--virtual-store-dir=/tmp/gvs/globalstore` (outside it) recorded
 *   `C:/…/globalstore/gvslib@file+vendor+x/node_modules/gvslib` — **absolute**, because a global
 *   virtual store's slot is outside the project and there is no project-relative way to name it.
 *
 * So a recorded absolute path is used to *locate* the copy and is then recorded **relative to the
 * store**, exactly as `virtualStoreDir` itself is. Serializing it verbatim made two checkouts of one
 * tree disagree: measured, `0481eb99c048` versus `726bfcec6956` for identical content in two
 * directories, which is the false stale #94's portability criterion forbids.
 *
 * The **content** of each copy is what gets digested, keyed by the normalized location: with
 * `injectWorkspacePackages`, `syncInjectedDepsAfterScripts` rewrites the files inside a copy while the
 * slot name, the lockfile and every layout field hold still.
 */
async function injectedDepsDigest(
  installRoot: string,
  storeDirectory: string,
  recorded: unknown,
): Promise<readonly string[] | null> {
  if (recorded === undefined || recorded === null) {
    return [];
  }
  const declared = asPlainObject(recorded);
  if (declared === null) {
    return null;
  }

  const digests: string[] = [];
  for (const source of Object.keys(declared).sort()) {
    const copies = declared[source];
    if (!Array.isArray(copies)) {
      return null;
    }
    for (const copy of [...copies].sort()) {
      if (typeof copy !== "string") {
        return null;
      }
      const copyRoot = isAbsolute(copy) ? copy : join(installRoot, copy);
      // A relative path is already project-relative and portable. An absolute one names a slot in
      // *some* store, so it is recorded relative to the store this install uses — the same
      // normalization `virtualStoreDir` gets, and the reason two checkouts compose one identity.
      const location = isAbsolute(copy)
        ? relativePath(storeDirectory, copy).split(/[\\/]/).join("/")
        : copy.split(/[\\/]/).join("/");
      // An absolute path outside both the project and the store is content this module cannot name
      // portably, so it is `unknown` rather than a value carrying a machine directory.
      if (location.startsWith("..")) {
        return null;
      }
      const files = await collectPackageFiles(copyRoot, copyRoot);
      if (files === null) {
        return null;
      }
      digests.push(`${source}:${location}:${digestOf(canonicalJson(files))}`);
    }
  }
  return digests;
}

/** npm's `node_modules/.package-lock.json`, as the materialized entry set. */
async function npmInstalledTreeDigest(installRoot: string): Promise<string | null> {
  // Only the entry paths are read: the recorded integrity hashes duplicate the lockfile, and any
  // machine-dependent field would be the portability defect described above.
  const npmRecord = await readTextFile(join(installRoot, "node_modules", NPM_INSTALL_RECORD));
  if (npmRecord.kind === "unreadable") {
    return null;
  }
  if (npmRecord.kind !== "read") {
    return null;
  }
  let parsed: Record<string, unknown> | null;
  try {
    parsed = asPlainObject(JSON.parse(npmRecord.text));
  } catch {
    return null;
  }
  if (parsed === null) {
    return null;
  }
  const packages = asPlainObject(parsed["packages"]);
  if (packages === null) {
    return null;
  }

  // One entry per materialized package, carrying the portable artifact identity rather than only
  // the path. Review round 7: hashing the key *set* alone could not see an artifact change under an
  // unchanged path — the `--no-save` shape, where npm reifies a different version of a transitive
  // (and its integrity with it) while the root `package-lock.json` and the manifest stay put, then
  // saves the current tree to the hidden lock regardless. Measured: same keys, `installedTree`
  // byte-identical. `version` and `integrity` are the identity of what is on disk; `resolved` is the
  // registry URL and is portable (a URL, not a path); `link`/`workspace` entries have no version, so
  // their *type* is recorded instead — a link to somewhere is a different artifact from a copy.
  const entries = Object.entries(packages).map(([path, entry]) => {
    const record = asPlainObject(entry) ?? {};
    return {
      path,
      version: record["version"] ?? null,
      integrity: record["integrity"] ?? null,
      resolved: record["resolved"] ?? null,
      link: record["link"] ?? false,
      workspace: record["workspace"] ?? false,
    };
  });
  // Sorted by path so the digest is over the *set* of artifacts rather than over whatever order npm
  // happened to write them in.
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Link targets are folded in here as well: npm records a `link: true` entry with only a relative
  // `resolved` path, which does not move when the target's source does (see `linkTargetsDigest`).
  const links = await linkTargetsDigest(installRoot);
  if (links === null) {
    return null;
  }
  return digestOf(canonicalJson({ entries, links }));
}

/**
 * Content identity of every **workspace/link target** reached from `node_modules`, or `null` when
 * one cannot be read.
 *
 * **Why this is a component of its own.** Review round 8: a workspace dependency is materialized as
 * a symlink out of the install tree — measured, both managers do this identically, pnpm linking
 * `node_modules/bar` to `packages/bar` and npm recording `{resolved: "packages/bar", link: true}`
 * with the same symlink on disk — and *nothing* in the other digests describes the target's files.
 * So a consumer could depend on `bar@1.0.0`, the probe could be cached, and then an edit to
 * `packages/bar/src/index.js` alone would move no version, no lockfile, no link path and no store
 * entry, while Rolldown's next build reads the new source. Measured: `installedTree` byte-identical
 * across exactly that edit, with the warm cache answering from the old report.
 *
 * **What is digested.** For each link whose target lies *outside* the install tree, the sorted
 * `(relative path, content digest)` pairs of its package files, skipping `node_modules` and dot
 * directories. Paths are relative to the link's own root, so the identity is portable: the same
 * workspace package in two checkouts composes the same bytes. The link's *name* is included too, so
 * two links to one target are not silently merged into one entry.
 *
 * **Why contents and not a target path.** A path is what the previous revision recorded, and it is
 * exactly what does not move when the source does — the defect this exists for. Digesting the tree
 * is the conservative answer, and it is affordable because these targets are source packages:
 * measured at 2–3 files in this repository's own workspace examples.
 *
 * **The cost, stated rather than discovered later.** A linked package that is *built* into a
 * gitignored `dist/` churns this digest: the output appears, the identity moves, and a record is
 * re-probed although the declared source never changed. That is a false *stale* — the direction this
 * axis has chosen over a false *fresh* at every round — and narrowing it (say, to the files the
 * probe's build actually reached) would mean guessing which files those are, which is the bundler's
 * answer rather than this module's. No fixture or example in this repository has a linked package
 * with build output today, so nothing here depends on the churn either way.
 *
 * `null` when a target cannot be read, which the caller reports as `unknown` — the fail-closed
 * direction, and the one the third criterion asks for.
 */
async function linkTargetsDigest(installRoot: string): Promise<string | null> {
  const nodeModules = join(installRoot, "node_modules");
  const canonicalTree = await realpath(nodeModules).catch(() => null);
  if (canonicalTree === null) {
    return null;
  }

  const links: { readonly name: string; readonly files: readonly string[] }[] = [];
  const seenTargets = new Set<string>();

  // Every `node_modules` location under the install root, not just the top one. Review round 9: a
  // root-only walk finds only the links a manager *hoisted*, and both managers legitimately place a
  // transitive workspace dependency below that. Measured on a real pnpm isolated install — `b` is
  // linked only from `packages/a/node_modules` (a's dependency position), is absent from the root
  // `node_modules` entirely, and is still resolvable from `a`; editing its source moved no digest.
  // npm's hidden lock records the same shape (`node_modules/a/node_modules/b`). So the link set is
  // enumerated from the materialized tree, which is what the manager built, rather than guessed from
  // a directory shape that only holds for hoisted installs.
  const locations: string[] = [];
  // Whether the walk saw the **whole** tree. Review round 10: hitting the depth bound or failing to
  // read a subtree is not the same as "there was nothing there", and treating them alike is how a
  // false fresh returns — a link below the bound stays unseen and its target's source edits move
  // nothing. So an incomplete walk propagates as `unknown` rather than as an empty result.
  //
  // The budget counts **`node_modules` locations, not ordinary directories**, and that distinction is
  // the difference between usable and useless. Review measured 200 directories past a bound of 6
  // counted that way — `node_modules/.pnpm/@babel+parser@7.29.8/node_modules/@babel/parser/lib` and
  // a skills template's `.github/workflows` alike — so a bound on ordinary depth reports `unknown` for
  // a perfectly readable install. Only the nesting of installs is a bound worth having: each one is a
  // graph this walk has to descend into again, and that is both the cost and the cycle risk.
  const collectLocations = async (directory: string, depth: number): Promise<boolean> => {
    if (depth > MAX_LINK_SEARCH_DEPTH) {
      return false;
    }
    let dirents: Dirent[];
    try {
      dirents = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      // A directory that is absent is not an incomplete view of one that exists; anything else is.
      const code = (error as { readonly code?: unknown } | null)?.code;
      return code === "ENOENT" || code === "ENOTDIR";
    }
    for (const entry of dirents) {
      if (!entry.isDirectory()) {
        continue;
      }
      const path = join(directory, entry.name);
      let complete: boolean;
      if (entry.name === "node_modules") {
        locations.push(path);
        // A `node_modules` inside the tree can itself contain one (npm's nested install), and pnpm's
        // virtual store puts each package's own `node_modules` under `.pnpm/<name>@<version>/` — so
        // nesting an install is what consumes the budget.
        complete = await collectLocations(path, depth + 1);
      } else {
        // An ordinary directory costs nothing: a long workspace path or a deep `lib/` inside a store
        // entry is still the same install, and charging for it would report `unknown` for every
        // ordinary project (measured: 200 directories past the bound that way).
        complete = await collectLocations(path, depth);
      }
      if (!complete) {
        return false;
      }
    }
    return true;
  };
  if (!(await collectLocations(installRoot, 0))) {
    return null;
  }

  for (const location of locations) {
    let entries: string[];
    try {
      entries = await readdir(location);
    } catch {
      return null;
    }

    for (const entry of entries) {
      // A package name never starts with a dot, so this cannot skip a link — and it avoids
      // descending into `.pnpm`'s bookkeeping on a name that is not a package.
      if (entry.startsWith(".")) {
        continue;
      }
      const names = entry.startsWith("@")
        ? await readdir(join(location, entry)).then(scoped => scoped.map(name => `${entry}/${name}`)).catch(() => null)
        : [entry];
      if (names === null) {
        return null;
      }

      for (const name of names) {
        const path = join(location, ...name.split("/"));
        // `lstat` first, and that is a measured requirement rather than a micro-optimization.
        // Resolving *every* entry cost 10.5 s on this repository's own install, because
        // `realpath` on a Windows junction is ~20 ms and the walk visits hundreds of them; gating on
        // `lstat` brought it to 776 ms. `lstat` does not follow the link, so it reports a junction as
        // a link (verified on this platform) while a real directory inside the tree is not one — and
        // a real directory inside the tree cannot escape it, so skipping it costs no coverage.
        let isLink: boolean;
        try {
          isLink = (await lstat(path)).isSymbolicLink();
        } catch {
          return null;
        }
        if (!isLink) {
          continue;
        }

        let resolved: string;
        try {
          // `realpath` follows the link, so this is the tree resolution would actually reach.
          resolved = await realpath(path);
        } catch {
          return null;
        }
        if (isInside(canonicalTree, resolved)) {
          continue;
        }
        // The same target linked from two dependency positions is one package installed once; digesting
        // it twice would make the identity depend on how many places a manager happened to record it.
        if (seenTargets.has(resolved)) {
          continue;
        }
        seenTargets.add(resolved);

        // A target that escapes the install root carries **its own** resolution: `package-locator`
        // realpaths into it and Node and Rolldown resolve its `node_modules` first. So that tree is
        // part of what the probe will read, while this walk covers only the install root — skipping it
        // silently would leave a real dependency tree outside every identity. Review round 10,
        // measured: a `file:`/`link:` target whose `shared/node_modules/dep` moved v1 → v2 left the
        // digest byte-identical.
        //
        // Composing that tree's verifiable identity would be the precise answer; **composing it here
        // is not possible**, because the install graph it names is described by a lockfile this module
        // never reads. So an external target that brings its own `node_modules` is `unknown` — the
        // conservative side of the same requirement, and the one the third criterion asks for.
        if (!isInside(installRoot, resolved)) {
          // Present → `unknown`, because that tree is a separate install graph this module cannot
          // describe. **Unreadable** → `unknown` too, and for a different reason: the guard cannot
          // tell whether the target brings its own `node_modules`, and answering "no" would be the
          // claim it could not establish. Review round 12, measured on Linux as a non-root user:
          // `stat` of a `node_modules` inside a mode-`000` directory returns `EACCES`, which used to
          // fold into "absent" and produce a digest that read as complete.
          const ownsTree = await directoryExists(join(resolved, "node_modules"));
          if (ownsTree !== false) {
            return null;
          }
        }

        const files = await collectPackageFiles(resolved, resolved);
        if (files === null) {
          return null;
        }
        // Keyed by the link's *package name*, not by the location that found it: the identity is
        // about which package was installed, and a dependency position is an install-manager detail
        // that differs between pnpm's isolated layout and npm's hoisted one.
        links.push({ name, files });
      }
    }
  }

  links.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return digestOf(canonicalJson(links));
}

/**
 * How deep the link search descends below the install root.
 *
 * A bound rather than an unbounded walk, because the tree contains `node_modules` inside
 * `node_modules` and a dependency cycle among links would otherwise never terminate. Measured depths
 * in this repository's own installs: pnpm's isolated layout nests one level under
 * `.pnpm/<name>@<version>/`, npm's nested install one under the dependent package.
 *
 * **What this walk costs, measured.** Enumerating the link set reads this repository's whole install
 * (169 `node_modules` locations) and takes about **900 ms** on Windows, against 68 ms for the
 * root-only walk this replaced — so covering the transitive links costs ~13× on this axis, on a path
 * reached once per probe run and once per `vp dev` start. That is the conservative direction paying
 * for itself: without it, a transitive workspace dependency's source edit is invisible (review round
 * 9, measured).
 *
 * The 10.5 s it cost *before* the `lstat` gate in the scan loop was not this walk but
 * `realpath` on Windows junctions — see the note there. If this ever needs to get cheaper, the
 * honest lever is a manager's own materialized record rather than a shorter bound: a depth cut would
 * drop exactly the deep store layouts this walk exists to cover.
 */
const MAX_LINK_SEARCH_DEPTH = 6;

/**
 * Sorted `"<relative path>:<content digest>"` for every file under `directory`, or `null` when one
 * cannot be read.
 *
 * **`node_modules` is the only exclusion**, because it is the only name whose exclusion has a
 * reason that holds — it is a different install graph, so following it would make this digest depend
 * on a tree the link does not own. Dot-named entries are *not* excluded: `exports: { ".":
 * "./.generated/index.js" }` is an ordinary way to publish a workspace package, and treating a dot
 * as "manager bookkeeping" left that file invisible (review round 9, measured).
 */
async function collectPackageFiles(directory: string, root: string): Promise<readonly string[] | null> {
  let entries: { readonly name: string; readonly isDirectory: () => boolean; readonly isFile: () => boolean }[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  const files: string[] = [];
  for (const entry of entries) {
    // Only `node_modules` is excluded, and it is excluded for a reason that holds: it is a *different
    // install graph* with its own identity, so following it would make this digest depend on a tree
    // the link does not own. Every other entry is included — including dot-named ones. Review round 9
    // measured the false fresh that blanket dot-exclusion bought: a workspace package whose
    // `package.json` points `exports` (or `main`) at `./.generated/index.js` is entirely ordinary, and
    // editing that file moved nothing while the next build read the new source. A dot name is not
    // evidence of manager bookkeeping; only the names below are.
    // Exclusions are **enumerated**, not "every dot name". The two that exist have separate, specific
    // reasons, and a blanket rule gets one of them wrong:
    //
    // - `node_modules` is a *different install graph*, so following it would make this digest depend
    //   on a tree the link does not own.
    // - this toolchain's own artifacts (`.fgc/`, `fgc.lock.json`, `fgc-evidence/`) are its *output*
    //   about the project, and a project carrying them has them inside the target being digested.
    //   Measured: including them made the identity change on every read of an unchanged tree, and
    //   made it self-referential — read the identity, write the lock, read it again in one process and
    //   the two values differed. An identity that cannot survive recording its own evidence carries
    //   no information, and it would re-measure for ever.
    //
    // Everything else is included, dot-named or not: `exports: { ".": "./.generated/index.js" }` is
    // an ordinary way to publish a package, and excluding it on the grounds that a dot implies
    // "manager bookkeeping" left that file invisible (review round 9, measured).
    if (entry.name === "node_modules" || isToolchainArtifact(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectPackageFiles(path, root);
      if (nested === null) {
        return null;
      }
      files.push(...nested);
      continue;
    }
    if (!entry.isFile()) {
      // A symlink or socket inside the target: its content is elsewhere, so this digest cannot claim
      // to have covered it.
      return null;
    }
    const bytes = await readFile(path).catch(() => null);
    if (bytes === null) {
      return null;
    }
    // Paths relative to the link's own root, so a checkout in another directory composes the same
    // identity. Separators normalized for the same reason.
    const relative = relativePath(root, path).split(/[\\/]/).join("/");
    files.push(`${relative}:${digestOfBytes(bytes)}`);
  }
  files.sort();
  return files;
}

/**
 * The identity a probe ran under, in the shape a lock record's `probedWith` compares against.
 *
 * One function for the probe engine, the cache, the CLI's `status` and the dev harness, so those
 * four cannot each read a different version of the same fact (#94, plan item 5).
 *
 * `vitePlus` is the only component read through the *project's* resolution; `rolldown` is read
 * through this package's, for the reason the module header gives — they are different questions
 * ("what does this project install" versus "what does this probe bundle with").
 */
export async function readToolchainIdentity(projectRoot: string): Promise<ToolchainIdentity> {
  const [vitePlus, rolldown, installGraph] = await Promise.all([
    installedVersion(join(projectRoot, "package.json"), "vite-plus"),
    installedVersion(join(packageRoot, "package.json"), "rolldown"),
    readInstallGraphIdentity(projectRoot),
  ]);

  return {
    vitePlus,
    rolldown,
    // The **exact** version, not the major line. This was the major until review round 8, on the
    // argument that only a major can change resolution while patch lines are bugfix-only — and that
    // argument is false, because a "bugfix" to the resolver *is* a behaviour change to resolution.
    // The counterexample is Node's own and it is about the primitive this module calls: 23.6.0
    // carries `module: fix async resolution error within the sync findPackageJSON`
    // (nodejs/node#56382, commit 4f77920a9d), a **minor** release of the same major, and
    // `package-locator.ts` resolves every identity through exactly that function. Under the major
    // reading both 23.5.x and 23.6.0 record `"23"`, so a package graph that moved between them
    // would leave every toolchain axis reporting "unchanged".
    //
    // The cost is the one #94's third criterion asks for: a CI runner that picks up a new 24.x
    // patch reports `toolchain-changed` and re-probes a record that would have been fine. That is a
    // false *stale*, which costs a measurement, and it is the direction this whole axis has
    // deliberately chosen over a false *fresh* at every previous review round.
    node: process.versions.node,
    installGraph,
  };
}
