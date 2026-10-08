// Schema-driven form models, input checking, and edits that touch
// only what changed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { analyze } from "../src/engine/analyze";
import { parseMarkdown } from "../src/engine/convert";
import { applyEdit, checkInput, SECTIONS, topLevelModel } from "../src/engine/form";
import { adoptMirror, mirrorDrift, syncMirror } from "../src/engine/relationships";
import { updateFrontmatter } from "../src/engine/writer";

const ROOT = join(__dirname, "..");
const soil = readFileSync(join(ROOT, "tests/fixtures/memories/agriculture/soil-profile-example.md"), "utf8");

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

describe("field models from mif.schema.json", () => {
  it("cover every §5.2 section with a real editor (raw only where the schema is open-ended)", () => {
    const raw = SECTIONS.flatMap((s) => s.keys).filter((k) => topLevelModel(k).kind === "raw");
    expect(raw).toEqual(["extensions"]);
  });

  it("derive kinds, enums, ranges, and requiredness", () => {
    const prov = topLevelModel("provenance");
    const byKey = Object.fromEntries(prov.children!.map((c) => [c.key, c]));
    expect(byKey.sourceType).toMatchObject({ kind: "enum", enum: expect.arrayContaining(["user_explicit"]) });
    expect(byKey.confidence).toMatchObject({ kind: "number", min: 0, max: 1 });
    expect(topLevelModel("type")).toMatchObject({ kind: "enum", enum: ["semantic", "episodic", "procedural"], required: true });
    const temporal = Object.fromEntries(topLevelModel("temporal").children!.map((c) => [c.key, c]));
    expect(temporal.validFrom).toMatchObject({ kind: "datetime", nullable: true });
    expect(temporal.ttl!.kind).toBe("duration");
    const citation = topLevelModel("citations").item!;
    expect(citation.children!.find((c) => c.key === "citationType")).toMatchObject({ kind: "text", required: true });
    expect(topLevelModel("citations").template).toMatchObject({ "@type": "Citation", title: "", url: "" });
  });
});

describe("checkInput", () => {
  const conf = topLevelModel("provenance").children!.find((c) => c.key === "confidence")!;
  const validFrom = topLevelModel("temporal").children!.find((c) => c.key === "validFrom")!;
  const ttl = topLevelModel("temporal").children!.find((c) => c.key === "ttl")!;

  it("parses and range-checks numbers", () => {
    expect(checkInput(conf, "0.75")).toEqual({ value: 0.75 });
    expect(checkInput(conf, "1.5").error).toMatch(/at most 1/);
    expect(checkInput(conf, "abc").error).toBeDefined();
    expect(checkInput(conf, "")).toEqual({ remove: true });
  });

  it("requires a time zone on date-times and real dates", () => {
    expect(checkInput(validFrom, "2026-01-15T00:00:00Z")).toEqual({ value: "2026-01-15T00:00:00Z" });
    expect(checkInput(validFrom, "2026-01-15 10:30").error).toBeDefined();
    expect(checkInput(validFrom, "2026-02-30T00:00:00Z").error).toMatch(/real/);
  });

  it("checks durations, patterns, and lengths", () => {
    expect(checkInput(ttl, "P90D").value).toBe("P90D");
    expect(checkInput(ttl, "90 days").error).toBeDefined();
    const id = topLevelModel("ontology").children!.find((c) => c.key === "id")!;
    expect(checkInput(id, "Mif Base").error).toMatch(/match/);
    expect(checkInput(topLevelModel("summary"), "x".repeat(501)).error).toMatch(/500/);
  });

  it("parses lists and YAML maps", () => {
    expect(checkInput(topLevelModel("tags"), "a, b\nc").value).toEqual(["a", "b", "c"]);
    expect(checkInput(topLevelModel("properties"), "theme: dark\nlevel: 2").value).toEqual({ theme: "dark", level: 2 });
    expect(checkInput(topLevelModel("properties"), "- not a map").error).toBeDefined();
  });
});

describe("applyEdit", () => {
  it("changes a nested scalar on one line", () => {
    const out = applyEdit(soil, ["provenance", "confidence"], 0.9);
    expect(addedLines(soil, out)).toEqual(["  confidence: 0.9"]);
  });

  it("adds a nested key without rewriting siblings' values", () => {
    const out = applyEdit(soil, ["temporal", "ttl"], "P365D");
    const fm = parseMarkdown(out).frontmatter;
    expect(fm.temporal).toMatchObject({ validFrom: "2026-01-15T00:00:00Z", ttl: "P365D" });
    expect(analyze(out).level).toBe(analyze(soil).level);
  });

  it("removes a key, and an object left empty", () => {
    const base = updateFrontmatter(soil, { embedding: { model: "m" } });
    const out = applyEdit(base, ["embedding", "model"], undefined);
    expect(parseMarkdown(out).frontmatter).not.toHaveProperty("embedding");
  });

  it("adds and removes array items", () => {
    const item = topLevelModel("citations").template as Record<string, unknown>;
    const fm = parseMarkdown(soil).frontmatter;
    const n = (fm.citations as unknown[]).length;
    const added = applyEdit(soil, ["citations", n], { ...item, citationType: "article", citationRole: "supports", title: "T", url: "https://example.org" });
    expect((parseMarkdown(added).frontmatter.citations as unknown[]).length).toBe(n + 1);
    const removed = applyEdit(added, ["citations", n], undefined);
    expect(parseMarkdown(removed).frontmatter.citations).toEqual(fm.citations);
  });

  it("edits and removes entity references", () => {
    const withRef = updateFrontmatter(soil, { entities: [{ "@type": "EntityReference", entity: { "@id": "urn:mif:entity:person:jane" }, name: "Jane", role: "author" }] });
    const renamed = applyEdit(withRef, ["entities", 0, "role"], "reviewer");
    expect(addedLines(withRef, renamed)).toEqual(["  role: reviewer"]);
    expect(parseMarkdown(applyEdit(renamed, ["entities", 0], undefined)).frontmatter).not.toHaveProperty("entities");
  });
});

describe("adopting body-only mirror lines", () => {
  const e = readFileSync(join(ROOT, "tests/fixtures/rel/e.md"), "utf8");

  it("adds them to frontmatter, after which the mirror is in sync", () => {
    const out = syncMirror(adoptMirror(e));
    const { frontmatter, body } = parseMarkdown(out);
    expect(frontmatter.relationships).toEqual([
      { type: "mentions", target: "/d.md" },
      { type: "relates-to", target: "/a.md" },
    ]);
    expect(mirrorDrift(frontmatter, body)).toBeNull();
    expect(body).toContain("- relates-to [Concept A](/a.md)");
    expect(body).toContain("Trailing prose inside the section.");
  });
});

describe("structural edits keep sibling formatting", () => {
  // The fixture quotes '@type' and timestamps; a block rewrite dropped those quotes.
  it("adds a nested key as one new line", () => {
    const out = applyEdit(soil, ["temporal", "ttl"], "P365D");
    expect(addedLines(soil, out)).toEqual(["  ttl: P365D"]);
    expect(addedLines(out, soil)).toEqual([]);
  });

  it("removes a nested key's line only", () => {
    const out = applyEdit(soil, ["provenance", "agent"], undefined);
    expect(addedLines(soil, out)).toEqual([]);
    expect(addedLines(out, soil)).toEqual(["  agent: claude-opus-4"]);
  });

  it("appends and removes sequence items without touching the others", () => {
    const fm = parseMarkdown(soil).frontmatter;
    const n = (fm.citations as unknown[]).length;
    const added = applyEdit(soil, ["citations", n], { "@type": "Citation", citationType: "article", citationRole: "supports", title: "T", url: "https://example.org" });
    expect(addedLines(added, soil)).toEqual([]);
    expect(addedLines(soil, added).length).toBe(5);
    const removed = applyEdit(added, ["citations", n], undefined);
    expect(removed).toBe(soil);
    // Removing the first of two items deletes only its lines.
    const first = applyEdit(added, ["citations", 0], undefined);
    expect(addedLines(added, first)).toEqual([]);
    expect((parseMarkdown(first).frontmatter.citations as unknown[]).length).toBe(n);
    // Removing the only item removes the emptied key.
    expect(parseMarkdown(applyEdit(soil, ["citations", 0], undefined)).frontmatter).not.toHaveProperty("citations");
  });
});
