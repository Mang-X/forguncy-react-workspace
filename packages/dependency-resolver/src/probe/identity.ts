/**
 * The `package-identity` step: which exact artifact is being probed.
 *
 * Decision source: GitHub Issue #17 — "Implement: deterministic dependency probe
 * engine"
 * https://github.com/Mang-X/forguncy-react-workspace/issues/17
 *
 * Governing Specs: #16 (the step's place and records in the probe protocol —
 * "Exact name, resolved version, license and source, so the evidence is about one
 * artifact rather than a package name"), #8 (a lock record's `resolvedVersion` and
 * `environment.source` are the same identity this step resolves), #5 (the runtime
 * contract the target half of the environment defaults to).
 *
 * Why a dedicated step rather than reading `resolveInstalledVersions`:
 * `install-graph` deliberately never returns a path — only versions — because a
 * machine path reaching `fgc.lock.json` breaks the lock's portability rule. The
 * probe needs the opposite: the *files* of one package, to scan, build and
 * measure. So this module re-implements the same two-attempt manifest resolution
 * (`<name>/package.json`, then bare `<name>` walked up to a named manifest,
 * stopping at a `node_modules` boundary) while keeping its own promise: only
 * portable strings — name, version, license, normalized source — cross back into
 * the report; the resolved directory stays internal to the engine.
 *
 * Identity failure is thrown, not reported. A probe of a package that is not
 * installed has no artifact to describe, so every later step would be fabricating
 * observations about nothing; `ProbeIdentityError` makes that a precondition
 * failure of the run rather than a report that looks complete and says
 * `packageVersion: ""`. The report path exists for a candidate that exists.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, parse as parsePath } from "node:path";

import type { ProbeEnvironment, ToolchainIdentity } from "@forguncy-react-workspace/core";
import { forguncyTargetIdentity, RUNTIME_CONTRACT_TARGET } from "@forguncy-react-workspace/core";

/** Why identity could not be established — the same reasons `install-graph` reports, re-stated for a throw. */
export type ProbeIdentityReason =
  | "not-installed"
  | "manifest-without-version"
  | "manifest-name-mismatch"
  | "manifest-unreadable";

export class ProbeIdentityError extends Error {
  readonly packageName: string;
  readonly reason: ProbeIdentityReason;
  readonly manifestName?: string;

  constructor(packageName: string, reason: ProbeIdentityReason, manifestName?: string) {
    super(describeIdentityFailure(packageName, reason, manifestName));
    this.name = "ProbeIdentityError";
    this.packageName = packageName;
    this.reason = reason;
    if (manifestName !== undefined) {
      this.manifestName = manifestName;
    }
  }
}

function describeIdentityFailure(packageName: string, reason: ProbeIdentityReason, manifestName?: string): string {
  switch (reason) {
    case "not-installed":
      return `Cannot probe "${packageName}": nothing in the install graph resolves to that name. Install it first — a probe describes an installed artifact, not a package name.`;
    case "manifest-without-version":
      return `Cannot probe "${packageName}": its manifest declares no usable version, so the evidence could not be tied to one artifact.`;
    case "manifest-name-mismatch":
      return `Cannot probe "${packageName}": the nearest manifest calls itself "${manifestName ?? "unknown"}", which is the shape an npm alias takes — recording the other package's identity would make the evidence about the wrong artifact.`;
    case "manifest-unreadable":
      return `Cannot probe "${packageName}": its manifest is not readable JSON, so name, version and source cannot be established.`;
  }
}

interface Manifest {
  readonly name: string;
  readonly version: string | undefined;
  readonly directory: string;
  readonly raw: Record<string, unknown>;
}

/**
 * The named manifest owning `startDirectory`, walking up, stopping at a
 * `node_modules` boundary.
 *
 * Same climb as `install-graph`'s `nearestNamedManifest`: stop at the first
 * manifest that declares a `name` (an `{"type":"module"}` marker deeper in a
 * package tree declares none), and refuse to walk out of a package into the
 * project — which would report the project itself as a name mismatch.
 */
async function nearestNamedManifest(startDirectory: string): Promise<Manifest | null> {
  let directory = startDirectory;
  for (;;) {
    if (parsePath(directory).base === "node_modules") {
      return null;
    }
    try {
      const text = await readFile(join(directory, "package.json"), "utf8");
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        if (typeof record.name === "string") {
          return {
            name: record.name,
            version:
              typeof record.version === "string" && record.version.trim().length > 0 ? record.version : undefined,
            directory,
            raw: record,
          };
        }
      }
    } catch {
      // Missing file, or one that is not JSON: this directory contributes nothing
      // and the walk continues. An unreadable manifest at the package root is
      // reported later only when it is the manifest that answered.
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

async function resolveManifest(require: NodeJS.Require, request: string): Promise<Manifest | null> {
  for (const candidate of [`${request}/package.json`, request]) {
    let entry: string;
    try {
      entry = require.resolve(candidate);
    } catch {
      continue;
    }
    if (!isAbsolute(entry)) {
      continue;
    }
    // The direct `<name>/package.json` attempt lands on the manifest itself;
    // walking from its directory still finds it (it declares `name`) and keeps
    // one code path for both attempts.
    const manifest = await nearestNamedManifest(dirname(entry));
    if (manifest !== null) {
      return manifest;
    }
  }
  return null;
}

/**
 * Shortens common git hosting forms to a portable `isEvidenceReference` URL.
 *
 * `fgc.lock.json` and `ProbeEnvironment.source` both require a URL or a
 * repository-relative path, and npm manifests are full of non-URL spellings
 * (`git@host:owner/repo.git`, `github:owner/repo`, `git+ssh://…`). Normalized
 * here at the point of entry so the report's validation never sees the raw form
 * and never has to guess whether a string is portable.
 */
export function normalizeSourceReference(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  let source = value.trim();
  if (source.length === 0) {
    return null;
  }
  source = source.replace(/^git\+/, "");
  if (source.startsWith("git://")) {
    source = `https://${source.slice("git://".length)}`;
  }
  if (source.startsWith("ssh://git@")) {
    source = `https://${source.slice("ssh://git@".length)}`;
  }
  if (source.startsWith("git@")) {
    const rest = source.slice("git@".length);
    const colon = rest.indexOf(":");
    if (colon > 0) {
      source = `https://${rest.slice(0, colon)}/${rest.slice(colon + 1)}`;
    }
  }
  if (source.startsWith("github:")) {
    source = `https://github.com/${source.slice("github:".length)}`;
  }
  if (source.startsWith("gitlab:")) {
    source = `https://gitlab.com/${source.slice("gitlab:".length)}`;
  }
  source = source.replace(/\.git$/, "");
  if (source.startsWith("https://") || source.startsWith("http://")) {
    return source;
  }
  // Anything still not a URL is left for `isEvidenceReference` to judge — a
    // repository-relative path is a legitimate answer, so inventing a host for
    // an unrecognized form would be worse than passing it through.
  return source;
}

function licenseOf(raw: Record<string, unknown>): string | null {
  if (typeof raw.license === "string" && raw.license.trim().length > 0) {
    return raw.license.trim();
  }
  const licenses = raw.licenses;
  if (Array.isArray(licenses)) {
    for (const entry of licenses) {
      if (entry !== null && typeof entry === "object") {
        const type = (entry as { readonly type?: unknown }).type;
        if (typeof type === "string" && type.trim().length > 0) {
          return type.trim();
        }
      }
    }
  }
  return null;
}

function sourceOf(raw: Record<string, unknown>): string | null {
  const repository = raw["repository"];
  const repositoryUrl =
    repository !== null && typeof repository === "object"
      ? (repository as { readonly url?: unknown }).url
      : repository;
  return normalizeSourceReference(repositoryUrl ?? raw["homepage"] ?? raw["url"]);
}

/** The identity of one installed package, plus the internal directory the engine scans. */
export interface ResolvedPackageIdentity {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly license: string | null;
  readonly source: string | null;
  /** Not report content: the directory the scan and build steps read. */
  readonly directory: string;
  readonly manifest: Readonly<Record<string, unknown>>;
}

/** The `package-identity` step's result. Throws `ProbeIdentityError` when no artifact answers. */
export async function resolvePackageIdentity(projectRoot: string, packageName: string): Promise<ResolvedPackageIdentity> {
  const require = createRequire(join(projectRoot, "package.json"));
  const manifest = await resolveManifest(require, packageName);

  if (manifest === null) {
    throw new ProbeIdentityError(packageName, "not-installed");
  }
  if (manifest.name !== packageName && !packageName.startsWith(`${manifest.name}/`)) {
    throw new ProbeIdentityError(packageName, "manifest-name-mismatch", manifest.name);
  }
  if (manifest.version === undefined) {
    // Distinguishes "no version field" from "manifest is not readable JSON":
    // an unreadable root manifest never produces a `Manifest` at all (the walk
    // skips it), so reaching here means the JSON parsed and lacked `version`.
    throw new ProbeIdentityError(packageName, "manifest-without-version");
  }

  return {
    packageName: manifest.name,
    packageVersion: manifest.version,
    license: licenseOf(manifest.raw),
    source: sourceOf(manifest.raw),
    directory: manifest.directory,
    manifest: manifest.raw,
  };
}

/** Toolchain as the report records it: the Vite+ version this workspace pins, or null. */
export async function readToolchainIdentity(projectRoot: string): Promise<ToolchainIdentity> {
  try {
    const text = await readFile(join(projectRoot, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object") {
      const record = parsed as {
        readonly devDependencies?: unknown;
        readonly dependencies?: unknown;
      };
      const vitePlus = pickVersion(record.devDependencies) ?? pickVersion(record.dependencies);
      return { vitePlus };
    }
  } catch {
    // No readable workspace manifest: a null toolchain is the honest answer and
    // `toolchain-unknown` in freshness treats it as such.
  }
  return { vitePlus: null };
}

function pickVersion(deps: unknown): string | null {
  if (deps !== null && typeof deps === "object") {
    const vitePlus = (deps as Record<string, unknown>)["vite-plus"];
    if (typeof vitePlus === "string" && vitePlus.trim().length > 0) {
      return vitePlus.trim();
    }
  }
  return null;
}

/** The `environment` section: identity of everything the other sections observe against. */
export function buildProbeEnvironment(
  identity: Pick<ResolvedPackageIdentity, "packageName" | "packageVersion" | "license" | "source">,
  toolchain: ToolchainIdentity,
  target: ProbeEnvironment["target"],
): ProbeEnvironment {
  return {
    packageName: identity.packageName,
    packageVersion: identity.packageVersion,
    license: identity.license,
    source: identity.source,
    toolchain,
    target,
  };
}

/** Default target for a run: the verified runtime contract, shaped for the report. */
export function defaultProbeTarget(): ProbeEnvironment["target"] {
  return forguncyTargetIdentity(RUNTIME_CONTRACT_TARGET);
}
