/**
 * The portability predicates every config reader has to agree on.
 *
 * Decision source: GitHub Issue #26 — "Spec: project configuration and React Cell target
 * declarations" (https://github.com/Mang-X/forguncy-react-workspace/issues/26), whose
 * portability rule is that "a committed config must be reviewable in a PR and must mean the
 * same thing on every machine".
 *
 * ## Why this is a leaf module
 *
 * These predicates were `cell-registry.ts`'s. They are here because a second config reader
 * needs them: `resolve-config.ts` checks an alias target with exactly the rule the registry
 * applies to a Cell entry, and importing that rule from the registry would make the two
 * modules a cycle — the registry calls the alias normalizer, so the normalizer may not call
 * back.
 *
 * The extraction follows `specifier.ts`'s precedent for the same reason, and the same
 * standard: the shared half became a leaf that imports nothing, so the property "one
 * implementation of this rule" is structural rather than a coincidence of load order.
 * `cell-registry.ts` re-exports both names, so its public surface and every existing caller
 * are unchanged.
 *
 * ## What belongs here, and what does not
 *
 * The test is "would two config readers have to give the same answer to this question".
 * Whether a value is a machine-specific path, and whether a key names something that would
 * have to be a secret, both pass: a node-spelled path committed in an alias target is the
 * same defect as one committed in a Cell entry, and it should read the same way.
 *
 * Everything else stays in the modules that own it — this is not a home for "config
 * helpers". `MARKER_NAMESPACE_PATTERN`, for instance, is about one runtime field and stays
 * with its validation in `cell-registry.ts`.
 */

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH = /^\\\\/;
const POSIX_ABSOLUTE_PATH = /^\//;
const HOME_RELATIVE_PATH = /^~/;
const FILE_URL_PATTERN = /^file:\/\//i;

const SECRET_KEY_WORDS = [
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "apikey",
  "accesskey",
  "privatekey",
  "session",
  "cookie",
  "bearer",
  "authorization",
];

/**
 * Why a string cannot be committed, or `undefined` when it is portable.
 *
 * Ordered from most to least specific so `C:\x` is reported as a Windows path
 * rather than as a generic directory-looking value.
 */
export function machineSpecificPathProblem(value: string): string | undefined {
  if (WINDOWS_DRIVE_PATH.test(value)) {
    return "an absolute Windows path";
  }
  if (WINDOWS_UNC_PATH.test(value)) {
    return "a UNC path";
  }
  if (FILE_URL_PATTERN.test(value)) {
    return "a file:// URL";
  }
  if (HOME_RELATIVE_PATH.test(value)) {
    return "a home-relative path";
  }
  if (POSIX_ABSOLUTE_PATH.test(value)) {
    return "an absolute path";
  }
  return undefined;
}

/** True when the key names something that would have to be a secret. */
export function isSecretLikeKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return SECRET_KEY_WORDS.some(word => normalized.includes(word));
}
