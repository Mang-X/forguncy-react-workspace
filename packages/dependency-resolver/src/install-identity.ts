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
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { InstallGraphIdentity, ToolchainIdentity } from "@forguncy-react-workspace/core";
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
 * {@link candidateNamesFor}), so a root that names a manager is not disqualified by an unrelated
 * stray lockfile of another manager's spelling. `unreadable` short-circuits to `unknown` rather
 * than being skipped: reporting an identity taken from a different file would describe an install
 * this process never read.
 */
async function findInstallLockfile(projectRoot: string): Promise<InstallLockfileResult> {
  // Absolute before the walk, so the ancestor search is over real directories rather than over the
  // caller's spelling of them. A relative root would still walk, but `dirname` on it eventually
  // reaches `""` and then `"."`, and the loop would terminate on a path that means "wherever the
  // process happens to be" — an identity that depends on the cwd.
  let directory = resolve(projectRoot);
  const claims: LockfileClaim[] = [];

  for (;;) {
    const names = candidateNamesFor(await readProjectManifest(directory));
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
  return { kind: "found", claim: claims[0]! };
}

/** A package manager named by a manifest's `packageManager` field, reduced to its kind. */
function packageManagerKind(manifest: ParsedConfig): "pnpm" | "npm" | "yarn" | "bun" | null {
  if (manifest.kind !== "parsed") {
    return null;
  }
  const declared = manifest.value["packageManager"];
  if (typeof declared !== "string") {
    return null;
  }
  // The field is `<name>@<version>`; the name is what decides which lockfile is authoritative.
  const name = declared.split("@")[0]?.trim().toLowerCase() ?? "";
  switch (name) {
    case "pnpm":
      return "pnpm";
    case "npm":
      return "npm";
    case "yarn":
      return "yarn";
    case "bun":
      return "bun";
    default:
      // An unrecognized or absent manager says nothing about which lockfile is authoritative.
      return null;
  }
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
const LOCKFILES_BY_MANAGER: Readonly<Record<string, readonly string[]>> = {
  pnpm: ["pnpm-lock.yaml"],
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

/**
 * The lockfile names one directory's manifest claims, from that manifest's `packageManager`.
 *
 * A directory that names a manager is asked only about that manager's spellings, so a stray
 * lockfile of another manager's spelling cannot disqualify it. A directory that names none is asked
 * about every recognized name: with no declaration, any of them could be the one resolution uses.
 *
 * Deliberately independent of {@link findInstallLockfile}'s counting: this answers "what could this
 * directory be the install root of", and the walk decides whether exactly one claim survived.
 */
function candidateNamesFor(manifest: ParsedConfig): readonly string[] {
  const manager = packageManagerKind(manifest);
  return manager === null ? RECOGNIZED_LOCKFILE_NAMES : (LOCKFILES_BY_MANAGER[manager] ?? []);
}

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
 * Read from **both** files this module parses, and the asymmetry is measured rather than assumed.
 * `pnpm-workspace.yaml` is where pnpm 11 acts on it (measured: a declaration there produces a
 * `patch_hash=` resolution key and a patched tree). A top-level `patchedDependencies` in
 * `package.json` is **silently ignored** by pnpm 12.4.2 — no `patch_hash`, no applied patch — so
 * covering it costs nothing and guards a project that believes it declared a patch.
 *
 * Reading it from the manifest is therefore *not* redundant with the workspace file: if pnpm ever
 * starts honouring it, this digest already moves when it does. A site that is ignored contributes
 * an empty map, which is the correct answer for it.
 */
function patchDeclarations(config: ParsedConfig): Record<string, string> | null {
  if (config.kind === "absent") {
    return {};
  }
  if (config.kind === "unreadable") {
    return null;
  }
  const declared = config.value["patchedDependencies"];
  if (declared === undefined || declared === null) {
    return {};
  }
  const record = asPlainObject(declared);
  if (record === null) {
    return null;
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      // A declaration this module cannot interpret is one it cannot claim to have covered, so it
      // reports unknown rather than hashing a shape it guessed at.
      return null;
    }
    normalized[key] = value.trim();
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
 * **The two sources stay separate in the digest**, and that is a correctness requirement rather
 * than tidiness. Merging them into one `declaration → path` map let `package.json` shadow
 * `pnpm-workspace.yaml` for the same key — so with both declaring a patch for one dependency, the
 * digest covered the manifest's file while pnpm applied the workspace's. Measured: editing the
 * *effective* (workspace) patch, with no re-install and an unchanged lockfile, left the digest
 * byte-identical and the record reporting `fresh` — a false fresh of exactly the class #94 removes.
 * Keeping the sources apart means an edit to either one moves the digest, so the conservative
 * direction is preserved whichever site a package manager of some future version honours.
 *
 * `null` when a declaration cannot be read or a named patch file is missing. A project with no
 * declarations yields the digest of two empty lists, which is a *known* answer rather than an
 * unknown one.
 */
async function patchesDigest(projectRoot: string, workspace: ParsedConfig, manifest: ParsedConfig): Promise<string | null> {
  const fromWorkspace = patchDeclarations(workspace);
  const fromManifest = patchDeclarations(manifest);
  if (fromWorkspace === null || fromManifest === null) {
    return null;
  }

  const workspaceEntries = await patchEntries(projectRoot, fromWorkspace);
  const manifestEntries = await patchEntries(projectRoot, fromManifest);
  if (workspaceEntries === null || manifestEntries === null) {
    return null;
  }

  // Keyed by source, so a declaration present in both is two entries rather than one shadowed one.
  return digestOf(canonicalJson({ workspace: workspaceEntries, manifest: manifestEntries }));
}

/**
 * The configuration that affects resolution, minus the patch declarations.
 *
 * Patch declarations are excluded on purpose: they are {@link patchesDigest}'s subject, and
 * hashing them here too would report one edit as two moved components. What remains is what this
 * component owns — workspace globs, catalogs, overrides, and the package-manager field — so the
 * freshness diagnostic can say *which* half moved.
 *
 * `null` when either config file is present and unreadable. An absent `pnpm-workspace.yaml` is
 * normal for a non-pnpm project and is not an unknown.
 */
async function configurationDigest(
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

  return digestOf(canonicalJson({ workspace: workspaceFields, manifest: manifestFields }));
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

  const [patches, configuration] = await Promise.all([
    patchesDigest(installRoot, workspace, manifest),
    configurationDigest(workspace, manifest),
  ]);

  return { lockfile: lockfile.claim.digest, patches, configuration };
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
    // The major line, not `process.versions.node`: the granularity at which Node can change what a
    // probe measured is a major (resolution, `exports` conditions, the loader), while patch lines
    // are bugfix-only. `ToolchainIdentity.node` carries the full argument, including why a
    // committed lock must not be tied to a patch release CI moves under it.
    node: process.versions.node.split(".")[0] ?? null,
    installGraph,
  };
}
