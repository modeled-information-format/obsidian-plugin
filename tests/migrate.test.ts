// MIF 0.1 → 1.0 migration against scripts/migrate_0_1_to_1_0.py goldens.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { analyze } from "../src/engine/analyze";
import { parseMarkdown } from "../src/engine/convert";
import { fieldRenames, legacySigns, MIF_NAMESPACE, migrateConcept, migratedPath, uuid5 } from "../src/engine/migrate";
import { mirrorDrift } from "../src/engine/relationships";

const ROOT = join(__dirname, "..");
const golden = JSON.parse(readFileSync(join(ROOT, "tests/golden/uuid5.json"), "utf8"));
const legacyPath = "tests/fixtures/mif/legacy-0.1-bundle/decision-sample.memory.md";
const legacy = readFileSync(join(ROOT, legacyPath), "utf8");

describe("UUIDv5", () => {
  it("derives MIF_NAMESPACE like Python's uuid module", () => expect(MIF_NAMESPACE).toBe(golden.namespace));
  for (const [slug, expected] of Object.entries(golden.slugs as Record<string, string>)) {
    it(JSON.stringify(slug), () => expect(uuid5(slug, MIF_NAMESPACE)).toBe(expected));
  }
});

describe("migrateConcept", () => {
  const out = migrateConcept(legacy);
  const ref = parseMarkdown(readFileSync(join(ROOT, "tests/golden/legacy/decision-sample.memory.md/migrated.md"), "utf8"));

  it("produces the reference frontmatter and body", () => {
    const ours = parseMarkdown(out);
    expect(ours.frontmatter).toEqual(ref.frontmatter);
    expect(ours.body.trim()).toBe(ref.body.trim());
  });

  it("yields a Level 1 concept whose mirror is in sync", () => {
    const { frontmatter, body } = parseMarkdown(out);
    expect(mirrorDrift(frontmatter, body)).toBeNull();
    expect(analyze(out).level).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent and drops the .memory infix", () => {
    expect(migrateConcept(out)).toBe(out);
    expect(legacySigns("x.md", out)).toBeNull();
    expect(migratedPath("a/b.memory.md")).toBe("a/b.md");
  });

  it("detects the 0.1 signs", () => {
    expect(legacySigns(legacyPath, legacy)).toEqual({
      memoryExtension: true, slugId: true, wikilinkRelationships: 2, snakeCaseFields: [],
    });
  });
});

describe("0.1 snake_case fields (beyond the reference script)", () => {
  const text = [
    "---",
    "id: 11111111-2222-4333-8444-555555555555",
    "type: semantic",
    "created: 2026-01-15T10:30:00Z",
    "temporal:",
    "  valid_from: 2026-01-15T00:00:00Z",
    "  decay:",
    "    model: exponential",
    "    half_life: P7D",
    "provenance:",
    "  source_type: user_explicit",
    "  trust_level: user_stated",
    "compressed_at: 2026-01-20T00:00:00Z",
    "---",
    "",
    "Body.",
    "",
  ].join("\n");

  it("are renamed so the schema accepts them", () => {
    expect(analyze(text).level).toBe(0); // temporal has additionalProperties: false
    expect(Object.keys(fieldRenames(parseMarkdown(text).frontmatter)).sort()).toEqual(["compressedAt", "compressed_at", "provenance", "temporal"]);
    const out = migrateConcept(text);
    const fm = parseMarkdown(out).frontmatter;
    expect(fm.temporal).toEqual({ validFrom: "2026-01-15T00:00:00Z", decay: { model: "exponential", halfLife: "P7D" } });
    expect(fm.provenance).toEqual({ sourceType: "user_explicit", trustLevel: "user_stated" });
    expect(fm).not.toHaveProperty("compressed_at");
    expect(analyze(out).level).toBeGreaterThanOrEqual(1);
  });
});
