/**
 * The compile identity a size rejection rests on.
 *
 * Decision source: GitHub Issue #77 — the review that required a `cell-code-budget-exceeded`
 * rejection's evidence to describe *the compile it was measured against* (revision 16). Two
 * properties matter and they pull in opposite directions, which is why they are stated together:
 * the identity must move when the compiled Cell would differ, and it must be stable for one Cell so
 * a reader can recompute it.
 */

import { describe, expect, it } from "vitest";

import { composeCellCompileFingerprint } from "./cell-compile-fingerprint.ts";

/** A Cell whose artifact is longer than a fixed prefix, so a prefix-only hash would miss a change. */
function artifact(marker: string): string {
  return `${"/* padding to push any change past a short prefix */".repeat(20)}\n${marker}`;
}

describe("composeCellCompileFingerprint", () => {
  it("is stable for identical inputs, so a reader recomputes what the recorder wrote", () => {
    const input = { artifactSource: artifact("A"), codeBudgetCharacters: 4096 };

    expect(composeCellCompileFingerprint(input)).toBe(composeCellCompileFingerprint({ ...input }));
  });

  // The property the round-6 review found missing: the identity has to cover the *whole* artifact,
  // because the artifact is the document the cap measured. Revision 15 hashed the entry file's own
  // source instead, so editing a module the entry imports — which changes the composed bytes and can
  // bring the Cell under its cap — left the record reporting `fresh`.
  //
  // The marker sits at the END of the artifact, past any plausible fixed prefix, so this fails
  // against an identity that hashes only a leading slice. That is deliberate: a test using a short
  // artifact would pass for a prefix-only hash too, and would therefore not pin the property.
  it("moves when any byte of the artifact moves, including deep in the document", () => {
    const before = composeCellCompileFingerprint({ artifactSource: artifact("const a = 1;"), codeBudgetCharacters: 4096 });
    const after = composeCellCompileFingerprint({ artifactSource: artifact("const a = 2;"), codeBudgetCharacters: 4096 });

    expect(after).not.toBe(before);
  });

  it("moves when the cap moves, because the verdict is relative to it", () => {
    const source = artifact("const a = 1;");

    expect(composeCellCompileFingerprint({ artifactSource: source, codeBudgetCharacters: 4096 })).not.toBe(
      composeCellCompileFingerprint({ artifactSource: source, codeBudgetCharacters: 8192 }),
    );
  });

  it("names the artifact and the cap, so a stored value is readable rather than opaque", () => {
    const fingerprint = composeCellCompileFingerprint({ artifactSource: artifact("x"), codeBudgetCharacters: 4096 });

    expect(fingerprint).toMatch(/^cell="[0-9a-f]{64}";budget=4096$/);
  });

  // The exclusion the freshness axis depends on: a rejected candidate's own version has its own
  // staleness reason, so folding it in here would report one change twice. Nothing in the interface
  // lets a caller pass it, and this pins that the *shape* of the identity does not grow one.
  it("carries nothing but the artifact identity and the cap", () => {
    const fingerprint = composeCellCompileFingerprint({ artifactSource: artifact("x"), codeBudgetCharacters: 1 });

    expect(fingerprint.split(";")).toHaveLength(2);
    expect(fingerprint).not.toMatch(/version/i);
  });
});
