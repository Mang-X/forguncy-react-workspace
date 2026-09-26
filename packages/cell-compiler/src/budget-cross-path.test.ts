import { describe, expect, it } from "vitest";

import { CELL_ARTIFACT_BANNER, compileCell } from "./artifact.ts";
import type { CellBundlerPort } from "./artifact.ts";
import { CELL_ENTRY_COMPONENT_BINDING, renderCellEntryWrapper } from "./entry.ts";

/**
 * The probe's character count and the compiler's are **different documents**, and this
 * file is what keeps that a stated fact rather than a claim someone can quietly re-make.
 *
 * Decision source: GitHub Issue #77 —
 * "Implement: align the dependency selection path with #21's measured character-based
 * cell-code bands" (https://github.com/Mang-X/forguncy-react-workspace/issues/77).
 *
 * ## The defect this pins
 *
 * #77 settled the unit as characters, which fixed a real bug: the probe compared UTF-8
 * bytes while the compiler compared characters, so a CJK artifact could be `inline` to
 * one and over budget to the other. The first revision of that change then overreached
 * in the documentation — it described the probe's `size.codeCharacters` and the
 * compiler's `codeBudgetCharacters` as "the same quantity", which is false in a way a
 * reader would act on:
 *
 * - the compiler caps the **composed Cell source**: `banner + "\n" + <the Cell's own
 *   bundled entry> + "\n" + entryWrapper + "\n"`;
 * - the probe measures the **candidate package's** bundle, built from its own synthetic
 *   entry (`import * as candidate from "<pkg>"; export default candidate;`).
 *
 * So the two counts differ by the composition overhead *and* by the bundles themselves
 * being different. A candidate that fits a cap can exceed it once composed, and only the
 * compiler's check decides that. The shared thing is the **unit** and the band table —
 * not one number describing both artifacts.
 *
 * ## What is asserted, and why each half can fail on its own
 *
 * 1. **The composition overhead is real and fixed.** A given bundle compiles to exactly
 *    `bundle + banner + wrapper + separators`, measured from the compiled artifact rather
 *    than recomputed from the same expression the compiler uses (a test that re-derived
 *    the formula would pass while the formula changed). This is the half that fails if
 *    someone makes the probe apply the compiler's cap as though the counts were equal.
 * 2. **A probe-sized artifact is not the compiler's artifact.** A bundle whose length is
 *    under a cap can be over it once composed, and the compiler says so. This is the half
 *    that fails if someone "aligns" the paths by measuring the composed source in the
 *    probe, which would report the Cell's own entry weight as the package's.
 *
 * The probe's side of the contract — that it measures the candidate and reports the band
 * — is asserted in `packages/dependency-resolver/src/probe/size.test.ts`, where the
 * artifact it measures actually comes from.
 */

function bundlerEmitting(code: string): CellBundlerPort {
  return { bundle: async () => ({ code, sourceSpecifiers: [] }) } as unknown as CellBundlerPort;
}

/** A bundle that declares the entry binding, so the wrapper can be emitted. */
function bundleOfLength(length: number): string {
  const head = `var ${CELL_ENTRY_COMPONENT_BINDING} = (function () {\n`;
  const tail = "\n})();";
  const filler = "x".repeat(Math.max(0, length - head.length - tail.length));
  return `${head}${filler}${tail}`;
}

async function compileWith(bundle: string, codeBudgetCharacters?: number) {
  return compileCell(
    { entry: "cells/bench/App.tsx", dependencies: [] },
    {
      bundler: bundlerEmitting(bundle),
      ...(codeBudgetCharacters === undefined ? {} : { codeBudgetCharacters }),
    },
  );
}

describe("the probe's characters and the compiler's are different documents", () => {
  it("composes the artifact with a fixed overhead around the bundle", async () => {
    // Measured from the compiled artifact, not recomputed from the compiler's own
    // expression: `artifact.code` is the composed document, so the difference from the
    // bundle *is* the overhead the two paths disagree by.
    const bundle = bundleOfLength(5_000);
    const outcome = await compileWith(bundle);

    if (outcome.status !== "compiled") throw new Error(`expected a compile, got ${outcome.status}`);
    const composed = outcome.artifact.code;
    const overhead = composed.length - bundle.length;

    // The overhead is the banner, the wrapper, and the **three** separators the
    // composition adds (after the banner, after the bundle, after the wrapper) — all
    // present, none of them the bundle. Asserted as a decomposition rather than a magic
    // number, so a banner edit changes this test's arithmetic rather than its verdict.
    const wrapper = renderCellEntryWrapper({});
    if (wrapper.status !== "emitted") throw new Error("the default entry shape must be emittable");
    expect(overhead).toBe(CELL_ARTIFACT_BANNER.length + wrapper.source.length + 3);

    // And the composed source really is longer than what the probe would have measured,
    // which is the direction that matters: the compiler's cap sees *more* than the probe.
    expect(composed.length).toBeGreaterThan(bundle.length);
    expect(composed.startsWith(CELL_ARTIFACT_BANNER)).toBe(true);
  });

  it("rejects an artifact the probe would have measured as inside the cap", async () => {
    // The trap in one assertion. The probe measures `bundle.length`; the compiler caps
    // `composed.length`, which is strictly larger. A cap set exactly at the bundle's
    // length is therefore satisfied by the probe's number and exceeded by the compiler's.
    const bundle = bundleOfLength(5_000);

    const composed = await compileWith(bundle);
    if (composed.status !== "compiled") throw new Error(`expected a compile, got ${composed.status}`);
    const composedLength = composed.artifact.code.length;

    // The probe's quantity fits; the compiler's does not.
    const atBundleLength = await compileWith(bundle, bundle.length);
    expect(atBundleLength.status).toBe("rejected");
    if (atBundleLength.status !== "rejected") return;
    expect(atBundleLength.diagnostics.map(diagnostic => diagnostic.code)).toContain("cell-code-budget-exceeded");

    // And the compiler's own count is the one that admits it, so the rejection is about
    // the composed document rather than a boundary coincidence.
    const atComposedLength = await compileWith(bundle, composedLength);
    expect(atComposedLength.status).toBe("compiled");
  });

  it("states the distinction where a reader will look, rather than claiming one quantity", async () => {
    // The documentation half, pinned because it is what a reader acts on: `size.ts` is
    // where the probe's number is defined, and it has to say whose characters they are.
    // A future edit that collapses this back into "the same quantity the compiler caps"
    // fails here rather than in a reader's head.
    const { readFileSync } = await import("node:fs");
    const sizeSource = readFileSync(new URL("../../dependency-resolver/src/probe/size.ts", import.meta.url), "utf8");

    expect(sizeSource).toContain("Whose characters these are: the candidate, not the composed Cell");
    expect(sizeSource).toMatch(/neither bounds the other in general/);
    // The claim that must not come back, quoted from the revision this replaced: the
    // probe's character count described as the compiler's own capped quantity. Falsified
    // by restoring that sentence — the assertion fails, and only this test does.
    expect(sizeSource).not.toMatch(/and the quantity `compileCell`'s `codeBudgetCharacters` caps/);
  });
});
