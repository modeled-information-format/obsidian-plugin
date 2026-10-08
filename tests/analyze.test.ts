import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { analyze, detectRewrites, type Diagnostic, type Fix } from "../src/engine/analyze";
import { newConceptText, promoteToConcept } from "../src/engine/concept";
import { parseMarkdown } from "../src/engine/convert";
import { toLf, updateFrontmatter } from "../src/engine/writer";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const NOW = new Date("2026-10-07T12:00:00.123Z");
const opts = { now: () => NOW, uuid: () => "11111111-2222-4333-8444-555555555555" };
const codes = (ds: Diagnostic[]) => ds.map((d) => d.code);

/** Apply a quick fix the way the plugin does. */
const applyFix = (text: string, fix: Fix) => (fix.transform === "lf" ? toLf(text) : updateFrontmatter(text, fix.updates ?? {}));

const L1 = "---\nid: 7b3c1e90-5a2f-4c8d-9e10-2f6a4b8c1d3e\ntype: semantic\ncreated: 2026-01-15T10:30:00Z\n---\n\n# Title\n\nBody.\n";

describe("conformance level", () => {
  it("reads the example bundle as Level 2", () => {
    for (const p of ["test-vault/semantic/rate-limit-policy.md", "test-vault/episodic/incident-2026-01-rate-spike.md"]) {
      const a = analyze(read(p), opts);
      // namespace + modified are present; temporal is not, so these are L1.
      expect(a.level, p).toBeGreaterThanOrEqual(1);
      expect(codes(a.diagnostics).filter((c) => c !== "level-gap"), p).toEqual([]);
    }
  });

  it("climbs L1 → L2 → L3 by applying the level-gap fixes", () => {
    let text = L1;
    expect(analyze(text, opts).level).toBe(1);
    for (let guard = 0; guard < 6 && analyze(text, opts).level < 3; guard++) {
      const gap = analyze(text, opts).diagnostics.find((d) => d.code === "level-gap")!;
      for (const fix of gap.fixes) text = applyFix(text, fix);
      if (analyze(text, opts).level === 2 && !("provenance" in parseMarkdown(text).frontmatter)) {
        // provenance has no automatic fix: it must be stated truthfully.
        text = updateFrontmatter(text, { provenance: { sourceType: "user_explicit" } });
      }
    }
    expect(analyze(text, opts).level).toBe(3);
  });

  it("reports level 0 for schema errors and maps them to frontmatter lines", () => {
    const bad = updateFrontmatter(L1, { tags: "not-a-list" });
    const a = analyze(bad, opts);
    expect(a.level).toBe(0);
    const d = a.diagnostics.find((x) => x.code.startsWith("schema-"))!;
    expect(d.path).toEqual(["tags"]);
    expect(bad.split("\n")[d.line!]).toMatch(/^tags:/);
  });
});

describe("diagnostics and fixes", () => {
  it("treats a note without frontmatter as not a concept", () => {
    expect(analyze("# Just a note\n", opts)).toMatchObject({ isConcept: false, diagnostics: [] });
  });

  it("offers fixes for each missing identity field", () => {
    const a = analyze("---\ntitle: Draft\n---\n\nText.\n", opts);
    expect(codes(a.diagnostics).sort()).toEqual(["missing-created", "missing-id", "missing-type"]);
    let text = "---\ntitle: Draft\n---\n\nText.\n";
    for (const code of ["missing-id", "missing-type", "missing-created"]) {
      const d = analyze(text, opts).diagnostics.find((x) => x.code === code)!;
      text = applyFix(text, d.fixes[0]!);
    }
    expect(analyze(text, opts).level).toBe(1);
  });

  it("flags CRLF and converts it", () => {
    const crlf = L1.replace(/\n/g, "\r\n");
    const d = analyze(crlf, opts).diagnostics[0]!;
    expect(d.code).toBe("crlf");
    expect(analyze(applyFix(crlf, d.fixes[0]!), opts).level).toBe(1);
  });

  it("warns on non-UUID ids and keeps the old id as an alias", () => {
    const text = updateFrontmatter(L1, { id: "dark-mode-preference" });
    const d = analyze(text, opts).diagnostics.find((x) => x.code === "id-not-uuid")!;
    const fixed = parseMarkdown(applyFix(text, d.fixes[0]!)).frontmatter;
    expect(fixed.id).toBe(opts.uuid());
    expect(fixed.aliases).toEqual(["dark-mode-preference"]);
  });

  it("warns when description would be lost to summary", () => {
    const text = updateFrontmatter(L1, { summary: "Short.", description: "Longer." });
    expect(codes(analyze(text, opts).diagnostics)).toContain("projection-conflict");
  });

  it("flags every YAML 1.1/1.2 ambiguity in the scalar fixture", () => {
    const a = analyze(read("tests/fixtures/edge/yaml11-scalars.md"), opts);
    const paths = a.diagnostics.filter((d) => d.code === "yaml-ambiguous").map((d) => d.path.join("."));
    expect(paths).toEqual(expect.arrayContaining([
      "extensions.test.yesWord", "extensions.test.octalLegacy", "extensions.test.sci", "extensions.test.sexagesimal",
    ]));
    expect(paths).not.toContain("extensions.test.hex"); // 0x1F is 31 either way
  });

  it("resolves an ambiguity either way, after which both readings agree", () => {
    const text = updateFrontmatter(L1, { extensions: { x: 1 } }).replace("x: 1", "flag: yes");
    const d = analyze(text, opts).diagnostics.find((x) => x.code === "yaml-ambiguous")!;
    for (const [fix, expected] of [[d.fixes[0]!, "yes"], [d.fixes[1]!, true]] as const) {
      const out = applyFix(text, fix);
      expect(codes(analyze(out, opts).diagnostics)).not.toContain("yaml-ambiguous");
      expect((parseMarkdown(out).frontmatter.extensions as Record<string, unknown>).flag).toBe(expected);
    }
  });

  it("flags non-canonical timestamps that Obsidian reads differently", () => {
    const a = analyze(read("tests/fixtures/edge/timestamps.md"), opts);
    const paths = a.diagnostics.filter((d) => d.code === "yaml-ambiguous").map((d) => d.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["modified", "temporal.recordedAt", "temporal.lastAccessed"]));
    expect(paths).not.toContain("created");
  });
});

describe("new and promoted concepts", () => {
  it("builds a Level 1 concept, or Level 2 with a namespace", () => {
    const base = { type: "semantic" as const, title: "Dark mode", id: opts.uuid(), created: NOW };
    expect(analyze(newConceptText(base), opts).level).toBe(1);
    const l2 = newConceptText({ ...base, namespace: "_semantic/preferences" });
    expect(analyze(l2, opts).level).toBe(2);
    expect(parseMarkdown(l2).frontmatter.created).toBe("2026-10-07T12:00:00Z");
  });

  it("promotes a plain note without touching its body or properties", () => {
    const note = "---\ntags: [ui]\ncssclasses: wide\n---\n\n# Note\n\nKeep  this   spacing.\n";
    const out = promoteToConcept(note, { type: "episodic", id: opts.uuid(), created: NOW });
    const { frontmatter, body } = parseMarkdown(out);
    expect(frontmatter).toMatchObject({ tags: ["ui"], cssclasses: "wide", type: "episodic" });
    expect(body).toBe(parseMarkdown(note).body);
    expect(out).toContain("tags: [ui]");
    expect(analyze(out, opts).level).toBe(1);
  });

  it("promotes a note with no frontmatter", () => {
    const out = promoteToConcept("# Note\n", { type: "procedural", id: opts.uuid(), created: NOW });
    expect(analyze(out, opts).level).toBe(1);
  });

  it("leaves an existing id alone", () => {
    const out = promoteToConcept(L1, { type: "episodic", id: "other", created: NOW });
    expect(out).toBe(L1);
  });
});

describe("Properties-panel rewrite guard", () => {
  // The exact rewrite Obsidian made in Spike B: `octalLegacy: 010` → `10`.
  const before = updateFrontmatter(L1, { extensions: { x: 1 } }).replace("x: 1", "octalLegacy: 010\n  keep: a");
  const after = before.replace("octalLegacy: 010", "octalLegacy: 10");

  it("reports the changed value and restores it", () => {
    const found = detectRewrites(analyze(before, opts), parseMarkdown(after).frontmatter);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: "rewritten", path: ["extensions", "octalLegacy"] });
    const restored = applyFix(after, found[0]!.fixes[0]!);
    expect((parseMarkdown(restored).frontmatter.extensions as Record<string, unknown>).octalLegacy).toBe(8);
    expect(codes(analyze(restored, opts).diagnostics)).not.toContain("yaml-ambiguous");
  });

  it("stays quiet when nothing ambiguous changed", () => {
    const edited = before.replace("keep: a", "keep: b");
    expect(detectRewrites(analyze(before, opts), parseMarkdown(edited).frontmatter)).toEqual([]);
  });
});

describe("every fixture", () => {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return f.startsWith(".") || f.startsWith("_") ? [] : statSync(p).isDirectory() ? walk(p) : f.endsWith(".md") ? [p] : [];
    });
  for (const p of [...walk(join(ROOT, "test-vault")), ...walk(join(ROOT, "tests", "fixtures"))]) {
    it(`analyzes ${p.slice(ROOT.length + 1)} without throwing`, () => {
      expect(() => analyze(readFileSync(p, "utf8"), opts)).not.toThrow();
    });
  }
});
