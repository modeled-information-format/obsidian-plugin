// Citations (§5.4), provenance (§12), and compression (§5.6).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { analyze, type Diagnostic } from "../src/engine/analyze";
import { adoptCitations, bodyCitations, citationAuthors, moveNoteToBody, nearestRole, nearestType, syncCitations, toIsoDate } from "../src/engine/citations";
import { compress, compressionDiagnostics, contentLines, decompress } from "../src/engine/compression";
import { mdToJsonLd, parseMarkdown, roundtripDrift } from "../src/engine/convert";
import { applyTextFix } from "../src/engine/fixes";
import { mirrorDrift } from "../src/engine/relationships";
import { WriteError } from "../src/engine/writer";

const DIR = join(__dirname, "fixtures/citations");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const now = () => new Date("2026-10-08T00:00:00Z");
const codes = (text: string, re = /citation|provenance|compress/) => analyze(text, { now }).diagnostics.filter((d) => re.test(d.code)).map((d) => d.code);

function addedLines(before: string, after: string): string[] {
  const pool = new Map<string, number>();
  for (const l of before.split("\n")) pool.set(l, (pool.get(l) ?? 0) + 1);
  return after.split("\n").filter((l) => {
    const n = pool.get(l) ?? 0;
    if (n > 0) {
      pool.set(l, n - 1);
      return false;
    }
    return true;
  });
}

/** Apply each diagnostic's first fix until none of the matching codes remain. */
function fixAll(text: string, re: RegExp): string {
  for (let round = 0; round < 20; round++) {
    const d = analyze(text, { now }).diagnostics.find((x: Diagnostic) => re.test(x.code) && x.fixes.length);
    if (!d) return text;
    text = applyTextFix(text, d.fixes[0]!, { now: now() });
  }
  throw new Error("fixes did not converge");
}

describe("citation validation (§5.4.7)", () => {
  it("reports each problem once, in place of the schema's errors", () => {
    const ds = analyze(read("broken.md"), { now }).diagnostics;
    expect(ds.filter((d) => d.code.startsWith("schema-"))).toEqual([]);
    expect(ds.filter((d) => d.code.startsWith("citation")).map((d) => `${d.code} ${d.path.join(".")}`)).toEqual([
      "citation-key citations.0.type",
      "citation-key citations.0.role",
      "citation-url citations.0.url",
      "citation-relevance citations.0.relevance",
      "citation-date citations.0.date",
      "citation-required citations.1.@type",
      "citation-type citations.1.citationType",
      "citation-role citations.1.citationRole",
      "citation-date citations.1.accessed",
      "citation-key citations.1.publisher",
    ]);
    expect(analyze(read("broken.md"), { now }).level).toBe(0);
  });

  it("offers the spec's fallbacks and the likely intended value", () => {
    const ds = analyze(read("broken.md"), { now }).diagnostics;
    const labels = (path: string) => ds.find((d) => d.path.join(".") === path)!.fixes.map((f) => f.label);
    expect(labels("citations.0.type")).toEqual(["Rename to citationType: article"]);
    expect(labels("citations.0.role")).toEqual(["Rename to citationRole: supports"]);
    expect(labels("citations.0.url")).toEqual(["Use https://www.example.org/post"]);
    expect(labels("citations.0.relevance")).toEqual(["Set relevance to 1"]);
    expect(labels("citations.0.date")).toEqual(["Use 2024-06-15"]);
    expect(labels("citations.1.citationType")).toEqual(["Use documentation", "Use other (the spec's fallback)"]);
    expect(labels("citations.1.citationRole")).toEqual(["Use background (the spec's fallback)"]);
    expect(labels("citations.1.accessed")).toEqual(["Use 2026-01-18"]);
  });

  it("fixes make the concept schema-valid, editing only the lines involved", () => {
    const before = read("broken.md");
    const after = fixAll(before, /^citation/);
    expect(codes(after, /^(citation|schema)/)).toEqual([]);
    expect(analyze(after, { now }).level).toBe(1);
    expect(addedLines(before, after).sort()).toEqual([
      "    '@type': Citation",
      "    accessed: 2026-01-18",
      "    citationRole: background",
      "    citationRole: supports",
      "    citationType: article",
      "  - citationType: documentation",
      "    date: 2024-06-15",
      '    note: "publisher: Example Inc"',
      "    relevance: 1",
      "    url: https://www.example.org/post",
    ].sort());
  });

  it("accepts the MIF example memories' citations as they are", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".md") ? [join(d, f)] : []));
    const files = walk(join(__dirname, "fixtures/memories"));
    const cited = files.filter((f) => /^citations:/m.test(readFileSync(f, "utf8")));
    expect(cited.length).toBeGreaterThanOrEqual(3);
    for (const f of cited) expect(codes(readFileSync(f, "utf8"), /^citation/), f).toEqual([]);
  });

  it("guesses vocabulary values and dates without inventing them", () => {
    expect([nearestType("Docs"), nearestType("blog post"), nearestType("repo"), nearestType("papers"), nearestType("zzz")]).toEqual(["documentation", "article", "repository", "paper", undefined]);
    expect([nearestRole("support"), nearestRole("based on"), nearestRole("Background")]).toEqual(["supports", "derived", "background"]);
    expect(toIsoDate("2024-06-15T10:00:00Z")).toBe("2024-06-15");
    expect(toIsoDate("June 15, 2024")).toBe("2024-06-15");
    expect(toIsoDate("June 2024")).toBeUndefined();
    expect(toIsoDate("2024")).toBeUndefined();
    expect(toIsoDate("2024-02-30")).toBeUndefined();
  });

  it("finds entity authors for the entity checks", () => {
    expect(citationAuthors(parseMarkdown(read("cited.md")).frontmatter)).toEqual([
      { urn: "urn:mif:entity:person:jane-smith", path: ["citations", 0, "author"], name: "Jane Smith", entityType: "person" },
    ]);
  });
});

describe("## Citations body section (§5.4.5)", () => {
  const cited = read("cited.md");

  it("reads entries, authors, years, and structured items", () => {
    const [first, second, third] = bodyCitations(parseMarkdown(cited).body);
    expect(first).toMatchObject({ title: "Memory Systems in AI Agents", author: "Jane Smith", year: "2024" });
    expect(first!.fields.get("role")!.value).toBe("background");
    expect(second).toMatchObject({ author: "W3C", year: undefined });
    expect(third!.fields.get("type")!.value).toBe("spec");
  });

  it("reports drift, body-only entries, and citations missing from the body", () => {
    const ds = analyze(cited, { now }).diagnostics.filter((d) => d.code.startsWith("citation"));
    expect(ds.map((d) => [d.code, d.line])).toEqual([
      ["citation-mirror-drift", 41],
      ["citation-body-only", 52],
      ["citation-not-in-body", 39],
    ]);
    expect(cited.split("\n")[41]).toMatch(/^- \[Memory Systems/);
    expect(cited.split("\n")[52]).toMatch(/^- \[CommonMark/);
    expect(cited.split("\n")[39]).toBe("## Citations");
    expect(ds[0]!.message).toMatch(/in role\.$/);
  });

  it("syncs from frontmatter, keeping annotations and body-only entries", () => {
    const out = syncCitations(cited);
    expect(parseMarkdown(out).frontmatter).toEqual(parseMarkdown(cited).frontmatter);
    expect(addedLines(cited, out)).toEqual([
      "  - **Role**: supports",
      "  - **Accessed**: 2026-01-18",
      "- [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339)",
      "  - **Type**: specification",
      "  - **Role**: methodology",
      "",
    ]);
    expect(addedLines(out, cited)).toEqual(["  - **Role**: background"]);
    expect(out).toContain("  - Foundational paper on semantic memory structures.");
    expect(out).toContain("- [CommonMark](https://spec.commonmark.org/)");
    expect(syncCitations(out)).toBe(out);
    expect(mirrorDrift(parseMarkdown(out).frontmatter, parseMarkdown(out).body)).toBeNull();
  });

  it("adopts body-only entries with the spec's fallbacks, after which all is in sync", () => {
    const out = applyTextFix(cited, { label: "", transform: "citations-adopt" });
    const added = (parseMarkdown(out).frontmatter.citations as Array<Record<string, unknown>>)[3];
    expect(added).toEqual({ "@type": "Citation", citationType: "specification", citationRole: "background", title: "CommonMark", url: "https://spec.commonmark.org/", relevance: 0.5 });
    const synced = applyTextFix(out, { label: "", transform: "citations-sync" });
    expect(codes(synced, /^citation/)).toEqual([]);
  });

  it("creates the section before ## Relationships when asked, and only then", () => {
    const text = cited.replace(/## Citations[\s\S]*?(?=## Relationships)/, "");
    expect(syncCitations(text)).toBe(text);
    const out = syncCitations(text, { create: true });
    expect(out.indexOf("## Citations")).toBeLessThan(out.indexOf("## Relationships"));
    expect(bodyCitations(parseMarkdown(out).body).map((e) => e.title)).toEqual(["Memory Systems in AI Agents", "JSON-LD 1.1", "RFC 3339"]);
    expect(codes(out, /^citation/)).toEqual([]);
  });

  it("moves an over-long note into the body", () => {
    const note = "x".repeat(1200);
    const text = cited.replace("    relevance: 0.95\n", `    relevance: 0.95\n    note: ${note}\n`);
    const d = analyze(text, { now }).diagnostics.find((x) => x.code === "citation-note")!;
    const out = applyTextFix(text, d.fixes[0]!);
    expect((parseMarkdown(out).frontmatter.citations as Array<Record<string, unknown>>)[0]).not.toHaveProperty("note");
    expect(out).toContain(`  - ${note}`);
    expect(moveNoteToBody(cited, 0)).toBe(cited); // no note: nothing to move
  });
});

describe("provenance (§12)", () => {
  it("flags confidence and trust that do not fit the source", () => {
    expect(codes(read("uncited.md"))).toEqual(["provenance-confidence", "provenance-trust"]);
  });
  it("notes an empty provenance block that still counts for Level 3", () => {
    const text = read("uncited.md").replace(/provenance:\n(  .*\n)+/, "provenance: {}\n");
    expect(codes(text)).toEqual(["provenance-empty"]);
  });
});

describe("compression (§5.6)", () => {
  const long = read("long.md");

  it("counts content without the mirror sections and spots candidates", () => {
    expect(contentLines(parseMarkdown(long).body)).toBe(123);
    expect(codes(long)).toEqual(["compression-candidate"]);
    const young = compressionDiagnostics(parseMarkdown(long).frontmatter, parseMarkdown(long).body, { now: new Date("2025-06-15T00:00:00Z") });
    expect(young).toEqual([]);
    const weak = compressionDiagnostics(parseMarkdown(long).frontmatter, parseMarkdown(long).body, { now: new Date("2025-06-15T00:00:00Z"), strength: 0.2 });
    expect(weak[0]!.message).toMatch(/strength 0\.20/);
  });

  it("compresses to the summary, keeping the original and the mirror, and restores exactly", () => {
    const out = compress(long, now());
    const { frontmatter, body } = parseMarkdown(out);
    expect(frontmatter.compressedAt).toBe("2026-10-08T00:00:00Z");
    expect((frontmatter.extensions as Record<string, string>).original_content).toMatch(/^# Long runbook\n\nStep 1:[\s\S]*Step 120: a line of the original runbook\.$/);
    expect(body).toBe("\n# Long runbook\n\nRotate keys monthly, verify each service, and record the rotation.\n\n## Relationships\n\n- relates-to [Cited fact](cited.md)\n");
    expect(mirrorDrift(frontmatter, body)).toBeNull();
    expect(roundtripDrift(out)).toBeNull();
    expect(codes(out)).toEqual([]);
    expect(decompress(out)).toBe(long);
    expect(() => compress(out)).toThrow(WriteError);
    expect(() => decompress(long)).toThrow(WriteError);
  });

  it("projects the compressed body as the JSON-LD content", () => {
    const { frontmatter, body } = parseMarkdown(compress(long, now()));
    expect(mdToJsonLd(frontmatter, body).content).toMatch(/^# Long runbook\n\nRotate keys monthly/);
  });

  it("renames the spec's compressed_at to the schema's compressedAt", () => {
    const text = long.replace("summary:", "compressed_at: 2026-01-01T00:00:00Z\nsummary:");
    const d = analyze(text, { now }).diagnostics.find((x) => x.code === "compressed-at-name")!;
    const out = applyTextFix(text, d.fixes[0]!);
    expect(addedLines(text, out)).toEqual(["compressedAt: 2026-01-01T00:00:00Z"]);
    expect(addedLines(out, text)).toEqual(["compressed_at: 2026-01-01T00:00:00Z"]);
  });

  it("warns when marked compressed without a summary", () => {
    const text = long.replace(/^summary: .*\n/m, "compressedAt: 2026-01-01T00:00:00Z\n");
    expect(codes(text)).toEqual(["compression-no-summary"]);
  });
});

describe("fixture links work wherever the folder is staged", async () => {
  const { buildIndex, bundleDiagnostics, toBundleConcept } = await import("../src/engine/bundle");
  const { buildRegistry } = await import("../src/engine/relationships");
  for (const prefix of ["", "_fixtures/citations/"]) {
    it(`bundle root '${prefix || "citations"}'`, () => {
      const names = readdirSync(DIR);
      const concepts = names.map((f) => toBundleConcept(prefix + f, read(f))!).filter(Boolean);
      const diags = bundleDiagnostics(buildIndex(concepts, buildRegistry(null as never), names.map((f) => prefix + f)));
      const problems = [...diags.values()].flat().filter((d) => d.severity !== "info").map((d) => `${d.code}: ${d.message}`);
      expect(problems).toEqual([]);
    });
  }
});
