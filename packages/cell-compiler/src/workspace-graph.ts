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

import type {
  WorkspaceGraph,
  WorkspaceGraphIndexResult,
  WorkspacePackageRecord,
} from "./workspace-source";
import { indexWorkspaceGraph } from "./workspace-source";

/** The manifest pnpm reads its member globs from. */
export const PNPM_WORKSPACE_FILE = "pnpm-workspace.yaml";

/**
 * Keys under which a member declares a dependency that can reach a compiled artifact.
 *
 * `dependencies`, `peerDependencies` and `optionalDependencies` — and deliberately
 * **not** `devDependencies`, which is a difference of kind rather than of degree.
 *
 * A dev dependency is never shipped: it exists for the package's own tests and build,
 * so nothing it names can be flattened into a consuming Cell, and an edge from one
 * would make the audit report a transitive dependency that cannot exist. This
 * repository is the worked example — the compiler's own `react` and `react-dom` are
 * dev dependencies used by its host-bridge regression, and carrying them here would
 * have the audit demand a dependency decision for a module no artifact contains.
 *
 * An *optional* dependency is the opposite: it is part of the shipped package, simply
 * allowed to fail installation, and a package whose source guards an import of one is
 * still importing it. Excluding it would be unsound in the direction that matters —
 * the audit would go silent about a module the bundler may well inline — so it stays.
 * Every manifest-derived edge can over-report relative to the imports that actually
 * exist in source; #14 records that as this contract's stated caveat, and it is the
 * accepted cost of a graph that does not parse source. `devDependencies` is excluded
 * not because it can over-report but because it is categorically outside the artifact.
 *
 * `peerDependencies` is included for the same reason: a peer is a dependency the
 * package's *source* imports and expects the consumer to provide, which is exactly
 * what a host mapping is for. Leaving it out would hide the one edge the decision
 * layer most needs to see.
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

/**
 * The `packages:` globs of a workspace document, in the order it declares them.
 *
 * `fileName` rather than a path: it is used only in messages, and a message carrying
 * an absolute path would leak this machine's checkout location (see {@link forMessage}).
 */
function readWorkspacePatterns(document: unknown, fileName: string): readonly string[] {
  if (!isRecord(document)) {
    throw new Error(
      `"${fileName}" does not parse as a mapping, so its workspace members cannot be read. A pnpm workspace manifest is a YAML mapping with a \`packages\` key.`,
    );
  }

  const patterns = document["packages"];
  // Absent is a legitimate pnpm state: a workspace file with no `packages` key
  // declares the root as its only member, which is an empty member list for this
  // loader. Present-but-malformed is not, and is refused rather than read as
  // empty — an empty member list makes every workspace package look like a published
  // dependency, which is the failure this loader's refusals exist to prevent.
  if (patterns === undefined) return [];
  if (!Array.isArray(patterns)) {
    throw new Error(
      `The \`packages\` key in "${fileName}" is not a list, so the workspace members cannot be read. It is refused rather than treated as empty: an empty member list makes every workspace package look like a published dependency.`,
    );
  }

  const invalid = patterns.filter(pattern => readString(pattern) === undefined);
  if (invalid.length > 0) {
    throw new Error(
      `The \`packages\` list in "${fileName}" contains ${invalid.length} entr(ies) that are not non-empty strings, so the workspace members cannot be read. Refused rather than skipped for the same reason: a skipped member makes a workspace package look like a published dependency.`,
    );
  }
  return patterns.map(pattern => readString(pattern) as string);
}

/**
 * Every character that gives a glob its meaning, as one list.
 *
 * A single complete set rather than the handful of cases that came to mind, because
 * the failure mode of a partial list is *silent*: pattern syntax the guard does not
 * recognize is read as a literal path, resolves to nothing, and drops members with
 * no error. The extglob groups are the ones easiest to miss — `packages/+(app|lib)`
 * contains no star and no brace, so a guard built by enumerating `*`, `?`, `**`,
 * `{}`, `[]` and `!` accepts it, `existsSync` answers `false` for the literal path,
 * and the whole subtree of members vanishes.
 *
 * `@` is deliberately absent: it is ordinary in a path (`@app/ui`) and only
 * meaningful as `@(…)` when followed by a parenthesis, which this list already
 * refuses.
 */
const GLOB_METACHARACTERS = /[*?{}[\]!()+|]/;

/**
 * Expands one member glob to the directories that declare a manifest.
 *
 * Only two shapes are supported, and each unsupported one is refused by name rather
 * than approximated, because a glob this loader guessed at would silently omit a
 * workspace package — and an omitted package stops resolving to workspace source, so
 * a *local* package is classified `external-package` and the audit demands a
 * dependency decision for it. A loud failure at load is #15's own criterion: a
 * structured failure, not a wrong answer.
 *
 * - a literal directory that declares `package.json` (a single-member entry);
 * - one trailing `/*`, the pnpm and lerna convention this repository uses.
 *
 * Everything else throws. The test is applied to the pattern with that one permitted
 * `/*` removed, so the rule is "no glob syntax anywhere except the single trailing
 * star" rather than "none of the syntax I remembered".
 */
async function expandWorkspacePattern(root: string, pattern: string): Promise<readonly string[]> {
  const trimmed = pattern.replace(/\/+$/, "");
  if (trimmed.length === 0) return [];

  const isChildGlob = trimmed.endsWith("/*");
  const body = isChildGlob ? trimmed.slice(0, -2) : trimmed;

  if (GLOB_METACHARACTERS.test(body)) {
    throw new Error(
      `The workspace pattern "${pattern}" uses a glob form this loader does not implement (only a literal directory and one trailing "/*" are supported). It is refused rather than approximated: a glob read as a literal path resolves to nothing, and a missing member stops resolving to workspace source, so a local package would be reported as a published dependency.`,
    );
  }

  const baseDirectory = path.resolve(root, body);

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
 * A file or directory as a *message* spells it: relative to the workspace root.
 *
 * The same portability rule the records obey, applied to the errors. A thrown
 * message ends up in a CI log and in a pasted diagnostic, so an absolute path here
 * would carry this machine's user name and checkout location out of the repository
 * — which is exactly the leak `workspace-source.ts` reports a graph record for. A
 * path outside the root is written relative anyway rather than hidden: `../../x` is
 * still recognizable to the person who passed the wrong root, which is the reader
 * this message is for.
 */
function forMessage(root: string, target: string): string {
  return workspaceRelativeDirectory(root, target);
}

/** A member manifest as a record, or `undefined` when it declares no `name` at all.
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
  const where = forMessage(root, directory);
  if (!isRecord(manifest)) {
    throw new Error(
      `The workspace member at "${where}" has a package.json that is not a JSON object, so it cannot be read as a workspace package.`,
    );
  }
  if (!("name" in manifest)) return undefined;

  const name = readString(manifest["name"]);
  if (name === undefined) {
    throw new Error(
      `The workspace member at "${where}" declares a "name" that is not a non-empty string, so it cannot be a workspace package. This is a malformed manifest rather than an unresolvable graph entry.`,
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

      // The *same* normalisation the `name` field gets, and for the same reason:
      // a key of `" @app/tokens "` stored verbatim is an id no member can match, so
      // `workspacePackageFor` misses it and the audit reports a bogus unresolved
      // transitive dependency for a workspace package that is right there. A key
      // that normalises to nothing is not a module id at all, so it is skipped.
      const moduleId = readString(dependencyName);
      if (moduleId === undefined) continue;
      imports.add(moduleId);
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

async function readJson(file: string, root: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    // Relative, not `file`: a thrown message travels into CI logs and pasted
    // diagnostics, and an absolute path would carry this machine's user name and
    // checkout location with it.
    throw new Error(
      `Cannot read the workspace manifest "${forMessage(root, file)}": ${error instanceof Error ? error.message : String(error)}`,
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
 * What the loader returns: the graph it read, the index of it, and the findings.
 *
 * All three, because two different consumers need two different views and neither
 * can be recovered from the other:
 *
 * - `index` is what a caller that wants to *look packages up* uses
 *   (`workspacePackageFor`, `classifyWorkspaceModule`). One record per name, with
 *   duplicates already resolved.
 * - `graph` is what `compileCell`'s `workspace` option takes, and it has to be the
 *   raw records rather than the index's. The audit indexes its input itself, so
 *   handing it the *deduped* list would re-index a list that no longer has the
 *   duplicate in it — and the `workspace-graph-conflict` finding the project
 *   actually has would vanish from the report. Passing the raw graph is what keeps
 *   "the graph is incoherent" reportable through the compile seam.
 *
 * `diagnostics` are the index's, so a caller that only wants to look things up does
 * not have to know the raw form exists.
 */
export interface LoadedWorkspaceGraph extends WorkspaceGraphIndexResult {
  /** The records as read, before indexing: what `compileCell`'s `workspace` option takes. */
  readonly graph: WorkspaceGraph;
}

/**
 * Reads the pnpm workspace graph from a real project root.
 *
 * The result carries the raw graph *and* its index, for the reason
 * {@link LoadedWorkspaceGraph} gives: the two are different views and the audit
 * needs the raw one to keep a graph-coherence finding reportable.
 *
 * Throws only for an unreadable or unsupported *input* — a missing workspace file,
 * malformed YAML, an unsupported glob form. A graph that is merely incoherent (a
 * duplicate name, an absolute directory) is returned with diagnostics, because that
 * is `indexWorkspaceGraph`'s contract and #14 states why: a report carrying the
 * usable records and a finding beats an exception that discards the rest of the audit.
 */
export async function loadPnpmWorkspaceGraph(
  options: LoadWorkspaceGraphOptions,
): Promise<LoadedWorkspaceGraph> {
  const root = path.resolve(options.root);
  const fileName = options.fileName ?? PNPM_WORKSPACE_FILE;
  const workspaceFile = path.join(root, fileName);

  if (!existsSync(workspaceFile)) {
    throw new Error(
      `No "${fileName}" at the workspace root, so the workspace graph cannot be read. Pass the directory that holds the workspace manifest.`,
    );
  }

  let document: unknown;
  try {
    document = parseYaml(await readFile(workspaceFile, "utf8"));
  } catch (error) {
    // Only the file's *name*, not its path: this message travels into CI logs, and
    // the root the caller passed is the one thing it already knows.
    throw new Error(
      `Cannot parse "${fileName}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // A `Set` for membership and a sort for ordering. The array alone was used as a
  // set here, making this quadratic in member count — which a real monorepo with a
  // few thousand members would notice before it noticed the reads.
  const memberSet = new Set<string>();
  const patternResults = await Promise.all(
    readWorkspacePatterns(document, fileName).map(pattern => expandWorkspacePattern(root, pattern)),
  );
  for (const directories of patternResults) {
    for (const directory of directories) memberSet.add(directory);
  }
  const memberDirectories = [...memberSet].sort();

  // Read in parallel over the *already sorted* list, so the ordering is a property
  // of this code rather than of which read finishes first. Determinism does not
  // depend on the sequencing — `indexWorkspaceGraph` re-sorts by content — and a
  // large monorepo should not pay one stat-and-read round trip per member.
  const manifests = await Promise.all(
    memberDirectories.map(directory => readJson(path.join(directory, "package.json"), root)),
  );

  const packages: WorkspacePackageRecord[] = [];
  for (const [index, directory] of memberDirectories.entries()) {
    const record = readPackageRecord(manifests[index], directory, root);
    // One record per directory and the directories are sorted, so two loads of one
    // root produce graphs the audit orders identically.
    if (record !== undefined) packages.push(record);
  }

  const graph: WorkspaceGraph = { packages };
  return { graph, ...indexWorkspaceGraph(graph) };
}
