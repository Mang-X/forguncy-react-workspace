/**
 * The pnpm/Vite+ workspace graph, read from the real project files.
 *
 * Decision source: GitHub Issue #15 — "Implement: workspace package flattening
 * PoC" (https://github.com/Mang-X/forguncy-react-workspace/issues/15), which owns
 * the two acceptance criteria #14 could not evidence
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/14):
 *
 * - "Workspace package resolution follows the Vite+/pnpm workspace graph **end to
 *   end** — a real compile through the workspace graph, not the contract's input
 *   type."
 * - "Tree-shaking removes unused workspace exports where the bundler supports it,
 *   asserted against a compiled artifact."
 *
 * The first of those sentences is why this module exists. #14 deliberately took
 * the graph as an *argument* and recorded the reason: "Supplying the graph from
 * those sources is the project-configuration work (#26, #28)." #28 shipped without
 * it, so a compile handed a hand-written graph would be exercising the contract's
 * input type — the thing #14 moved here rather than leaving behind. Something has
 * to do the reading, and this is that something.
 *
 * The contract this loader feeds is itself downstream of #4 "application ownership
 * boundaries and dependency strategy semantics"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/4) and #5 "establish
 * the ReactCellType target/runtime contract on Forguncy 12.0.100"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/5), and of #6
 * "generated ReactCellType artifact and compiler boundary"
 * (https://github.com/Mang-X/forguncy-react-workspace/issues/6). #4 is the reason
 * this module stops at reading: a manifest states what a package *depends on*, and
 * which strategy that dependency resolves to is #4's decision, recorded in
 * `fgc.lock.json` and read by the dependency layer — never inferred from a
 * `package.json` here.
 *
 * ## Why it is here and not in `core`
 *
 * #26/#28 put project configuration in `core`, which is why `forguncy.config.ts`
 * and the Cell registry live there. The workspace graph is a different input with
 * a different owner: `WorkspaceGraph` and `WorkspacePackageRecord` are #14's types,
 * #14's contract is `cell-compiler`'s, and `core` may not depend on
 * `cell-compiler`. Moving the types to `core` to satisfy a placement preference
 * would edit a merged contract's public surface and its re-exports; producing the
 * graph next to the only consumer that holds the type is the smaller change. If a
 * second package ever needs the graph, that is the move to make — the same rule
 * `provenance.ts` states for #14's decision record.
 *
 * ## What is read, and what is deliberately not
 *
 * `pnpm-workspace.yaml`'s `packages:` globs name the workspace members, and each
 * member's `package.json` names the package and its dependencies. That is the whole
 * input. In particular this module does **not**:
 *
 * - resolve a specifier through `node_modules` — the bundler does that, and #6
 *   forbids the toolchain inventing a second resolver;
 * - decide anything about a dependency — a declaration becomes an *edge*, and
 *   whether a published module is `host`, `inline`, `extension` or `replace` is
 *   `fgc.lock.json`'s answer, read elsewhere;
 * - guess a package's `moduleIdentity` — a manifest has no field for it, so every
 *   record leaves it absent, which #14's type defines as `cell-local`.
 *
 * A dependency's *declared name* is the module id carried into the graph, with no
 * translation layer, because that is what a manifest's dependency key is: the name
 * source writes in an import. Whether that name is workspace source or a published
 * package is then `workspacePackageFor`'s question against the finished graph, not
 * this loader's — which is why no record here is annotated with a kind.
 *
 * ## The dependency this adds, and why it is not a strategy decision
 *
 * `yaml` is a build-time parser, like `@babel/parser` in `source-guard.ts`: it
 * never reaches generated cell code, so AGENTS.md's `host | inline | extension |
 * replace` table does not apply — nothing it provides can appear in an artifact.
 * It is pinned rather than floated, for the same reason the parser is: a change in
 * what a file means must not arrive silently.
 *
 * The alternative — reading `packages:` with a hand-written scanner — is the one
 * mistake this repository has already paid for. `source-guard.ts` records four
 * rounds of patches that ended with "that is the signature of approximating a
 * grammar with text, so this module stopped guessing: it parses". A workspace
 * manifest is a YAML document, so it gets a YAML parser.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import type { WorkspaceGraphIndexResult, WorkspacePackageRecord } from "./workspace-source";
import { indexWorkspaceGraph } from "./workspace-source";

/** The manifest pnpm reads its member globs from. */
export const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";

/**
 * Keys under which a member declares a dependency that can reach a compiled artifact.
 *
 * These three, and deliberately **not** `devDependencies`. A package's own tests and
 * build tooling are dev dependencies: nothing they name is ever flattened into a
 * consuming Cell, so an edge from one would make the audit report a transitive
 * dependency that cannot exist. This repository is the worked example — the
 * compiler's own `react` and `react-dom` are dev dependencies used by its host-bridge
 * regression, and carrying them into the graph would have the audit demand a
 * dependency decision for a module no artifact contains.
 *
 * `peerDependencies` is included for the opposite reason: a peer is a dependency the
 * package's *source* imports and expects the consumer to provide, which is exactly a
 * host mapping. Leaving it out would hide the one edge the decision layer most needs
 * to see.
 */
const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  // Trimmed on the way *out*, not only on the way in. A manifest name of
  // `" @app/ui "` passes a `length > 0` test and would then be stored under that
  // padded key, where `byName.get("@app/ui")` cannot reach it — so the package
  // would be classified `external-package` and the audit would demand a dependency
  // decision for local source. Returning the trim is what keeps the stored name the
  // one source can import.
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The `packages:` globs of a workspace document, in the order it declares them. */
function readWorkspacePatterns(document: unknown, workspaceFile: string): readonly string[] {
  if (!isRecord(document)) {
    throw new Error(
      `"${workspaceFile}" does not parse as a mapping, so its workspace members cannot be read. A pnpm workspace manifest is a YAML mapping with a \`packages\` key.`,
    );
  }

  const patterns = document["packages"];
  // Absent is a legitimate pnpm state: a workspace file with no `packages` key
  // declares the root as its only member, which is an empty member list for this
  // loader. Present-but-malformed is not, and is refused rather than read as
  // empty — an empty member list makes every local package look like a published
  // one, which is the failure this loader's refusals exist to prevent.
  if (patterns === undefined) return [];
  if (!Array.isArray(patterns)) {
    throw new Error(
      `The \`packages\` key in "${workspaceFile}" is not a list, so the workspace members cannot be read. It is refused rather than treated as empty: an empty member list makes every workspace package look like a published dependency.`,
    );
  }

  const invalid = patterns.filter(pattern => readString(pattern) === undefined);
  if (invalid.length > 0) {
    throw new Error(
      `The \`packages\` list in "${workspaceFile}" contains ${invalid.length} entr(ies) that are not non-empty strings, so the workspace members cannot be read. Refused rather than skipped for the same reason: a skipped member makes a workspace package look like a published dependency.`,
    );
  }
  return patterns.map(pattern => readString(pattern) as string);
}

/**
 * Expands one member glob to the directories that declare a manifest.
 *
 * Only two shapes are supported, and each unsupported one is refused by name
 * rather than approximated, because a glob this loader guessed at would silently
 * omit a workspace package — and an omitted package makes a published dependency
 * look like local source, which changes what the compiler reports. A loud failure
 * at load is #15's own criterion: a structured failure, not a wrong answer.
 *
 * - a literal directory that declares `package.json` (a single-member entry);
 * - one trailing `/*`, the pnpm and lerna convention this repository uses.
 *
 * Everything else throws: a double star, a brace, a character class, a negation,
 * and — the case easiest to miss — a wildcard that is not that one trailing star,
 * such as a `packages` + one-star + `/src` pattern, or one carrying a `?`. Each of
 * those names a glob pnpm and `fast-glob` accept, so a loader that read them as
 * literal paths would resolve them to nothing and drop a whole subtree of members
 * silently.
 */
async function expandWorkspacePattern(root: string, pattern: string): Promise<readonly string[]> {
  const trimmed = pattern.replace(/\/+$/, "");
  if (trimmed.length === 0) return [];

  const isChildGlob = trimmed.endsWith("/*");
  // A star anywhere other than that one trailing occurrence is a glob shape this
  // loader does not implement, and it is refused rather than read as a literal
  // directory. The refusal matters for the *silent* case: a deeper star pattern
  // contains a star, ends in neither `/*` nor a double star, and would otherwise be
  // treated as a literal path — which does not exist, so the pattern would expand
  // to nothing and a whole subtree of members would vanish with no error.
  const starCount = [...trimmed].filter(character => character === "*").length;
  const unsupportedStar = isChildGlob ? starCount !== 1 : starCount > 0;

  // A `?` is glob syntax too (one character), and it fails the same silent way: it
  // has no star, so the count above does not see it, and `existsSync` then answers
  // `false` for a path containing a literal `?`. Refused here rather than left to a
  // filesystem that would report "missing" instead of "unsupported".
  const unsupportedQuestionMark = trimmed.includes("?");

  if (
    unsupportedStar ||
    unsupportedQuestionMark ||
    trimmed.includes("**") ||
    /[{}[\]!]/.test(trimmed)
  ) {
    throw new Error(
      `The workspace pattern "${pattern}" uses a glob form this loader does not implement (only a literal directory and one trailing "/*" are supported). It is refused rather than approximated: expanding it wrongly would omit a workspace package, and an omitted package makes a published dependency look like local source.`,
    );
  }

  const baseDirectory = path.resolve(root, isChildGlob ? trimmed.slice(0, -2) : trimmed);

  if (!isChildGlob) {
    return existsSync(path.join(baseDirectory, "package.json")) ? [baseDirectory] : [];
  }
  if (!existsSync(baseDirectory)) return [];

  // A directory read rather than a glob: one trailing `/*` means exactly "every
  // child directory that is a package", and `readdir` cannot be affected by a glob
  // library's dotfile or separator conventions.
  const entries = await readdir(baseDirectory, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => path.join(baseDirectory, entry.name))
    .filter(directory => existsSync(path.join(directory, "package.json")))
    .sort();
}

/**
 * A member manifest as a record, or `undefined` when it declares no `name` at all.
 *
 * The two cases are different problems and are answered differently:
 *
 * - **No `name` key.** A member glob can match a directory nobody meant as a
 *   workspace package. That is a mis-specified glob rather than a project error
 *   worth a diagnostic, so the directory is skipped.
 * - **A `name` key that is not a non-empty string.** The manifest is malformed —
 *   pnpm itself would refuse it — so it throws, like the unreadable-manifest case
 *   below. It is *not* passed through to `indexWorkspaceGraph`, because that
 *   function's answer for a name it cannot use is `workspace-graph-conflict`,
 *   which means "declared, but not resolvable" rather than "this file is not a
 *   manifest". Reporting a malformed manifest as a graph conflict would send the
 *   reader to the graph instead of to the file that is broken.
 */
function readPackageRecord(manifest: unknown, directory: string, root: string): WorkspacePackageRecord | undefined {
  if (!isRecord(manifest)) {
    throw new Error(
      `The workspace member at "${directory}" has a package.json that is not a JSON object, so it cannot be read as a workspace package.`,
    );
  }
  if (!("name" in manifest)) return undefined;

  const name = readString(manifest["name"]);
  if (name === undefined) {
    throw new Error(
      `The workspace member at "${directory}" declares a "name" that is not a non-empty string, so it cannot be a workspace package. This is a malformed manifest rather than an unresolvable graph entry.`,
    );
  }

  const imports = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const declarations = manifest[field];
    if (!isRecord(declarations)) continue;
    for (const [dependencyName, specifier] of Object.entries(declarations)) {
      // A malformed dependency entry is skipped rather than turned into an edge:
      // the shape of a dependency must be npm's (`string` specifier), and
      // inventing an id here would put a name in the graph that nothing declared.
      // Unlike an unusable `name`, this cannot hide a package — the package is
      // still in the graph, only one of its edges is absent, and #14's contract
      // already reports "the caller did not state these edges" distinctly.
      if (typeof specifier !== "string") continue;
      imports.add(dependencyName);
    }
  }

  return {
    name,
    // Workspace-relative and POSIX, which is what `WorkspacePackageRecord` requires
    // and what keeps a diagnostic portable across machines. `path.relative` answers
    // the empty string for the root itself — which is a real pnpm state, since
    // `packages: ["."]` makes the root a member — so the root is written as `"."`.
    // The empty string is not equivalent: `isWorkspaceRelativeDirectory` rejects it,
    // and the audit would report a legitimate root member as a leaked
    // machine-specific path.
    directory: workspaceRelativeDirectory(root, directory),
    imports: [...imports].sort(),
  };
}

/** A member directory as the graph records it: workspace-relative, POSIX, never empty. */
function workspaceRelativeDirectory(root: string, directory: string): string {
  const relative = path.relative(root, directory).split(path.sep).join("/");
  return relative.length === 0 ? "." : relative;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Cannot read the workspace manifest "${file}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface LoadWorkspaceGraphOptions {
  /** The project root the workspace file is read from and directories are made relative to. */
  readonly root: string;
  /** The workspace manifest file name. Defaults to `pnpm-workspace.yaml`. */
  readonly fileName?: string;
}

/**
 * Reads the pnpm workspace graph from a real project root.
 *
 * The result is the *index* rather than the bare graph, because the two are always
 * wanted together: a caller that wants the graph wants `byName` or `packages`, and
 * both arrive with the diagnostics the graph's own coherence produced. Returning a
 * `WorkspaceGraph` would make every caller re-run `indexWorkspaceGraph`, and one of
 * them would eventually forget to.
 *
 * Throws only for an unreadable or unsupported *input* — a missing workspace file,
 * malformed YAML, an unsupported glob form. A graph that is merely incoherent (a
 * duplicate name, an absolute directory) is returned with diagnostics, because that
 * is `indexWorkspaceGraph`'s contract and #14 states why: a report carrying the
 * usable records and a finding beats an exception that discards the rest of the audit.
 */
export async function loadPnpmWorkspaceGraph(
  options: LoadWorkspaceGraphOptions,
): Promise<WorkspaceGraphIndexResult> {
  const root = path.resolve(options.root);
  const fileName = options.fileName ?? PNPM_WORKSPACE_FILE;
  const workspaceFile = path.join(root, fileName);

  if (!existsSync(workspaceFile)) {
    throw new Error(
      `No "${fileName}" at "${root}", so the workspace graph cannot be read. Pass the directory that holds the workspace manifest.`,
    );
  }

  let document: unknown;
  try {
    document = parseYaml(await readFile(workspaceFile, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse "${workspaceFile}": ${error instanceof Error ? error.message : String(error)}`);
  }

  const memberDirectories: string[] = [];
  const patternResults = await Promise.all(
    readWorkspacePatterns(document, workspaceFile).map(pattern => expandWorkspacePattern(root, pattern)),
  );
  for (const directories of patternResults) {
    for (const directory of directories) {
      if (!memberDirectories.includes(directory)) memberDirectories.push(directory);
    }
  }
  memberDirectories.sort();

  // Read in parallel over the *already sorted* list, so the ordering is a property
  // of this code rather than of which read finishes first. Determinism does not
  // depend on the sequencing — `indexWorkspaceGraph` re-sorts by content — and a
  // large monorepo should not pay one stat-and-read round trip per member.
  const manifests = await Promise.all(
    memberDirectories.map(directory => readJson(path.join(directory, "package.json"))),
  );

  const packages: WorkspacePackageRecord[] = [];
  for (const [index, directory] of memberDirectories.entries()) {
    const record = readPackageRecord(manifests[index], directory, root);
    // One record per directory and the directories are sorted, so two loads of one
    // root produce graphs the audit orders identically.
    if (record !== undefined) packages.push(record);
  }

  return indexWorkspaceGraph({ packages });
}
