// The temporal fixture bundle (also staged into the test vault) has one
// concept per freshness state; pin each state at a fixed date.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildIndex, bundleDiagnostics, toBundleConcept, type BundleConcept } from "../src/engine/bundle";
import { parseMarkdown } from "../src/engine/convert";
import { buildRegistry } from "../src/engine/relationships";
import { freshness, temporalDiagnostics } from "../src/engine/temporal";

const DIR = join(__dirname, "fixtures/temporal");
const at = new Date("2026-10-08T12:00:00Z");
const load = (f: string) => parseMarkdown(readFileSync(join(DIR, f), "utf8")).frontmatter;

describe("temporal fixtures", () => {
  const expected: Record<string, string> = {
    "fresh.md": "fresh",
    "ageing.md": "ageing",
    "stale.md": "stale",
    "expired-ttl.md": "expired",
    "expired-until.md": "expired",
    "future.md": "not-yet-valid",
  };
  it("cover every file", () => expect(readdirSync(DIR).sort()).toEqual(Object.keys(expected).sort()));
  for (const [file, state] of Object.entries(expected)) {
    it(`${file} is ${state}`, () => expect(freshness(load(file), at).state).toBe(state));
  }
  it("stale.md also reports its out-of-date recorded strength", () => {
    expect(temporalDiagnostics(load("stale.md"), at).map((d) => d.code)).toEqual(["freshness-stale", "freshness-recorded"]);
  });
  it("only the ttl expiry offers a renewal", () => {
    expect(temporalDiagnostics(load("expired-ttl.md"), at)[0]!.fixes).toHaveLength(1);
    expect(temporalDiagnostics(load("expired-until.md"), at)[0]!.fixes).toHaveLength(0);
  });
  // A bundle-root target ("/fresh.md") broke once the folder
  // was staged inside a larger bundle, hiding the superseded banner.
  for (const prefix of ["", "_fixtures/temporal/"]) {
    it(`fresh.md is marked superseded (bundle root '${prefix || "temporal"}')`, () => {
      const files = readdirSync(DIR).map((f) => prefix + f);
      const concepts = readdirSync(DIR)
        .map((f) => toBundleConcept(prefix + f, readFileSync(join(DIR, f), "utf8")))
        .filter((c): c is BundleConcept => c !== null);
      const diags = bundleDiagnostics(buildIndex(concepts, buildRegistry(null as never), files));
      expect(diags.get(`${prefix}fresh.md`)?.map((d) => d.message)).toContain(`Superseded by Expired policy (validUntil) (${prefix}expired-until.md).`);
      expect(diags.get(`${prefix}expired-until.md`)?.some((d) => d.code === "broken-link" || /missing/i.test(d.message)) ?? false).toBe(false);
    });
  }
});
