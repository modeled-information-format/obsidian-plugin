import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { applyHunks, textHunks } from "../src/engine/diff";
import { retarget, syncMirror } from "../src/engine/relationships";

const REL = join(__dirname, "fixtures", "rel");

describe("textHunks", () => {
  it("returns nothing for identical text", () => expect(textHunks("a\nb", "a\nb")).toEqual([]));

  it("splits separate changes into separate small hunks", () => {
    const a = readFileSync(join(REL, "a.md"), "utf8");
    const out = retarget(a, { from: "a.md", to: "a.md" }, new Map([["sub/c.md", "c.md"]]));
    const hunks = textHunks(a, out);
    expect(hunks).toHaveLength(2);
    for (const h of hunks) expect(h.to - h.from).toBeLessThan(10);
    expect(applyHunks(a, hunks)).toBe(out);
  });

  it("round-trips insertions, deletions, and edits at the ends", () => {
    const cases: Array<[string, string]> = [
      ["", "x"], ["x", ""], ["a\nb\nc", "a\nc"], ["a\nc", "a\nb\nc"], ["a\nb", "z\nb"], ["a\nb", "a\nz"],
      ["a\nb\nc\n", "a\nB\nc\nd\n"], ["one two\nthree", "one 2\nthree four"],
    ];
    for (const [x, y] of cases) expect(applyHunks(x, textHunks(x, y)), `${JSON.stringify(x)} → ${JSON.stringify(y)}`).toBe(y);
  });

  it("round-trips a mirror regeneration", () => {
    const b = readFileSync(join(REL, "b.md"), "utf8");
    const out = syncMirror(b);
    expect(applyHunks(b, textHunks(b, out))).toBe(out);
  });
});
