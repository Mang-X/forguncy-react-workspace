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

async function readTextFile(path: string): Promise<FileState> {
  try {
    return { kind: "read", text: await readFile(path, "utf8") };
  } catch (error) {
    // `ENOENT`/`ENOTDIR` are absence; anything else (`EACCES`, `EISDIR`, an I/O error) is a file
    // that is there and cannot be read. Collapsing them would report "no lockfile" for a lockfile
    // the reader can see in their own directory listing.
    const code = (error as { readonly code?: unknown } | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { kind: "absent" };
    }
    return { kind: "unreadable" };
  }
}

/**
 * Where a project's install graph actually lives.
 *
 * **Ancestors, not just the project root**, and that is not a convenience: a workspace member has
 * no lockfile of its own and resolves through its workspace root's install, which is exactly the
 * shape `examples/probe-proving-cases` has in this repository (measured — it declares
 * `es-toolkit` and resolves it from the root's `node_modules`, with the lockfile two levels up).
 * Reading only `projectRoot` would report `install-graph-unknown` for a project whose install
 * graph is perfectly well described, and withhold decisions the compiler accepts — the same
 * misdirection as reporting a missing dependency because the *project's* manifest was corrupt
 * (#89).
 *
 * The walk is the one `install-graph.ts` already performs for `node_modules`, and for the same
 * reason: the graph a name resolves in is the nearest ancestor that owns an install, not the
 * directory the caller happened to name.
 *
 * The digest is over file **content**, so two projects nested at different depths under one
 * workspace compose the same identity — which is correct, because they share one install.
 */
async function findInstallRoot(projectRoot: string): Promise<string | null> {
  // Absolute before the walk, so the ancestor search is over real directories rather than over the
  // caller's spelling of them. A relative root would still walk, but `dirname` on it eventually
  // reaches `""` and then `"."`, and the loop would terminate on a path that means "wherever the
  // process happens to be" — an identity that depends on the cwd.
  let directory = resolve(projectRoot);
  for (;;) {
    for (const name of RECOGNIZED_LOCKFILE_NAMES) {
      const state = await readTextFile(join(directory, name));
      if (state.kind === "read") {
        return directory;
      }
      if (state.kind === "unreadable") {
        // A lockfile that is *there* and cannot be read stops the walk rather than being skipped
        // for an ancestor's: skipping would report an identity for a graph this process could not
        // actually read, which is the "complete-looking identity" #94's third criterion forbids.
        return null;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/** The lockfile's content digest at the install root, or `null` when there is none. */
async function lockfileDigest(installRoot: string): Promise<string | null> {
  for (const name of RECOGNIZED_LOCKFILE_NAMES) {
    const state = await readTextFile(join(installRoot, name));
    if (state.kind === "read") {
      return digestOf(state.text);
    }
    if (state.kind === "unreadable") {
      return null;
    }
  }
  return null;
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

/**
 * The declared patch set, as one digest over both halves.
 *
 * Both halves are load-bearing. The **declaration** says which patches apply; the **file content**
 * says what they do, and a patch edited without a re-install is exactly the change a
 * declaration-only digest would miss. The path is included as the declaration spells it —
 * repository-relative — so two checkouts of one project agree.
 *
 * `null` when the declaration cannot be read or a named patch file is missing. A project with no
 * declarations yields the digest of an empty set, which is a *known* answer rather than an
 * unknown one.
 */
async function patchesDigest(projectRoot: string, workspace: ParsedConfig, manifest: ParsedConfig): Promise<string | null> {
  const fromWorkspace = patchDeclarations(workspace);
  const fromManifest = patchDeclarations(manifest);
  if (fromWorkspace === null || fromManifest === null) {
    return null;
  }

  const merged: Record<string, string> = { ...fromWorkspace, ...fromManifest };
  const entries: { readonly declaration: string; readonly path: string; readonly content: string }[] = [];
  for (const declaration of Object.keys(merged).sort()) {
    const path = merged[declaration]!;
    const state = await readTextFile(join(projectRoot, ...path.split(/[\\/]/)));
    if (state.kind !== "read") {
      return null;
    }
    entries.push({ declaration, path, content: digestOf(state.text) });
  }

  return digestOf(canonicalJson(entries));
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
  const installRoot = await findInstallRoot(projectRoot);
  if (installRoot === null) {
    // No ancestor owns an install this toolchain recognizes, so there is no graph to describe.
    // Reported as unknown rather than as an identity over the project's own files: those files
    // would describe a resolution *request*, which is the reading #94 exists to replace.
    return { lockfile: null, patches: null, configuration: null };
  }

  // Read at the **install root**, not at `projectRoot`: patches and overrides are declared where
  // the install is, so a workspace member's `patchedDependencies` live in the root's
  // `pnpm-workspace.yaml`. Reading them one level down would report "no patches" for a project
  // whose install carries them, and the record would look fresh through exactly the change this
  // axis exists to catch.
  const [lockfile, workspace, manifest] = await Promise.all([
    lockfileDigest(installRoot),
    readWorkspaceConfig(installRoot),
    readProjectManifest(installRoot),
  ]);

  const [patches, configuration] = await Promise.all([
    patchesDigest(installRoot, workspace, manifest),
    configurationDigest(workspace, manifest),
  ]);

  return { lockfile, patches, configuration };
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
