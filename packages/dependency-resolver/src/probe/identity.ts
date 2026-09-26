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
 * measure. So this module resolves the same artifact `install-graph` resolves —
 * now through the shared `package-locator` (#89) — while keeping its own promise:
 * only portable strings — name, version, license, normalized source — cross back
 * into the report; the resolved directory stays internal to the engine.
 *
 * **Locating is not resolving, and #89 split the two.** This step used to find a
 * package with two `require.resolve` attempts, which answer under the CommonJS
 * condition — so an `import`-only package failed both and was reported as
 * *not installed* while `import()` and rolldown both loaded it. `locatePackage`
 * answers the identity question from the host's own package-directory lookup,
 * and the question of *whether a specifier is exported at all* is left where it
 * can be answered under the conditions compilation actually uses: the `build`
 * step, whose `RESOLVE_ERROR` is the evidence for a name the manifest does not
 * publish. This step therefore never claims "forbidden export"; it claims which
 * artifact is installed, and `manifest-name-mismatch` is still the one thing a
 * name can be wrong about here.
 *
 * Identity failure is thrown, not reported. A probe of a package that is not
 * installed has no artifact to describe, so every later step would be fabricating
 * observations about nothing; `ProbeIdentityError` makes that a precondition
 * failure of the run rather than a report that looks complete and says
 * `packageVersion: ""`. The report path exists for a candidate that exists.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProbeEnvironment, ToolchainIdentity } from "@forguncy-react-workspace/core";
import { forguncyTargetIdentity, RUNTIME_CONTRACT_TARGET } from "@forguncy-react-workspace/core";

import type { LocatedPackage } from "../package-locator.ts";
import { locatePackage } from "../package-locator.ts";

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

/**
 * The located package, in the shape this module's consumers read.
 *
 * `name` and `version` are `undefined` when the manifest declares none, which is
 * the honest answer for a manifest that parsed: `resolvePackageIdentity` turns
 * those into `manifest-name-mismatch` and `manifest-without-version`. A manifest
 * that does *not* parse never reaches here — `locatePackage` reports it as its own
 * failure reason.
 */
export interface LocatedManifest {
  readonly name: string;
  readonly version: string | undefined;
  readonly directory: string;
  readonly raw: Record<string, unknown>;
}

/**
 * Resolve `request` from `base`'s location, returning the owning manifest or null
 * when nothing installed answers.
 *
 * Shared by `package-identity` and `node-builtin-scan` so both ask the host the
 * same question and neither invents a private variant of resolution. A package
 * whose manifest declares no `name` yields `null` here, because both callers need
 * a *named* manifest: the transitive walk keys graph members by name, and an
 * unnamed directory is not a graph node.
 *
 * `base` is a filename inside the resolution scope — the project's own manifest
 * for a top-level probe, a package's manifest for the transitive walk — and it is
 * a parameter rather than a `NodeJS.Require` because the host primitive walks
 * ancestor `node_modules` directories from a location, which is the same scope
 * question `createRequire` answers without the `NODE_PATH` leak.
 */
export async function locateManifest(base: string, request: string): Promise<LocatedManifest | null> {
  const location = await locatePackage(base, request);
  if (location.outcome === "failed") {
    return null;
  }
  const found: LocatedPackage = location.package;
  if (found.name === undefined) {
    return null;
  }
  return {
    name: found.name,
    version: found.version,
    directory: found.directory,
    raw: found.raw,
  };
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
  const location = await locatePackage(join(projectRoot, "package.json"), packageName);

  if (location.outcome === "failed") {
    // `manifest-unreadable` is a distinct reason now that the locator reports it:
    // the climb this replaced skipped every unreadable manifest and kept walking, so
    // a corrupt package root was blamed on the install graph instead of on the file.
    throw new ProbeIdentityError(packageName, location.reason);
  }
  const found = location.package;

  if (found.name === undefined) {
    // The manifest parsed but declares no `name`, so there is nothing to compare the
    // request against and nothing to record as the artifact's identity. Reported as
    // `manifest-name-mismatch` with no `manifestName`, because that is the same
    // defect from a caller's side: the nearest manifest does not call itself what it
    // was asked for.
    throw new ProbeIdentityError(packageName, "manifest-name-mismatch");
  }
  if (found.name !== packageName && !packageName.startsWith(`${found.name}/`)) {
    throw new ProbeIdentityError(packageName, "manifest-name-mismatch", found.name);
  }
  if (found.version === undefined) {
    // Distinguishes "no version field" from "manifest is not readable JSON": the
    // locator reports the latter as `manifest-unreadable` before this point, so
    // reaching here means the JSON parsed and lacked a usable `version`.
    throw new ProbeIdentityError(packageName, "manifest-without-version");
  }

  return {
    packageName: found.name,
    packageVersion: found.version,
    license: licenseOf(found.raw),
    source: sourceOf(found.raw),
    directory: found.directory,
    manifest: found.raw,
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
