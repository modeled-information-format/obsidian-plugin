// Bundle-wide checks against MIF's scripts/okf_validate.py: for every
// fixture bundle, each file must get the same kinds and counts of
// relationship findings as the reference (tests/golden/<bundle>/okf.json).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { buildIndex, bundleDiagnostics, parseCreated, toBundleConcept, type BundleConcept } from "../src/engine/bundle";
import { RESERVED_FILENAMES } from "../src/engine/convert";
import { buildRegistry, incomingLabel } from "../src/engine/relationships";
import { validateBundleConfig } from "../src/engine/validate";
import { loadYaml } from "../src/engine/yaml11";

const ROOT = join(__dirname, "..");
const GOLDEN = join(ROOT, "tests", "golden");

const BUNDLES: Record<string, string> = {
  "test-vault": join(ROOT, "test-vault"),
  rel: join(ROOT, "tests/fixtures/rel"),
  ...Object.fromEntries(
    readdirSync(join(ROOT, "tests/fixtures/mif/relationship_types")).map((n) => [`reltypes-${n}`, join(ROOT, "tests/fixtures/mif/relationship_types", n)]),
  ),
};

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    if (f === ".obsidian" || f.startsWith("_")) return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

/** Load a bundle the way the manager does. */
export function loadBundle(dir: string) {
  const files = walk(dir).map((p) => relative(dir, p));
  let config: unknown = null;
  const configPath = join(dir, ".mif", "config.yaml");
  if (existsSync(configPath)) {
    const parsed = loadYaml(readFileSync(configPath, "utf8"));
    config = validateBundleConfig(parsed ?? {}).length ? null : parsed;
  }
  const concepts = files
    .filter((f) => f.endsWith(".md") && !RESERVED_FILENAMES.has(f.split("/").pop()!) && !f.startsWith(".mif"))
    .map((f) => toBundleConcept(f, readFileSync(join(dir, f), "utf8")))
    .filter((c): c is BundleConcept => c !== null);
  return buildIndex(concepts, buildRegistry(config as never), files);
}

// okf_validate message → plugin diagnostic code
const KINDS: Array<[RegExp, string]> = [
  [/relationships out of sync/, "mirror-drift"],
  [/is not declared in \.mif\/config\.yaml/, "undeclared-type"],
  [/metadata\['/, "relationship-metadata"],
  [/broken link ->/, "broken-link"],
  [/temporal inconsistency/, "temporal-inconsistency"],
];

describe("bundle checks match okf_validate", () => {
  for (const [name, dir] of Object.entries(BUNDLES)) {
    it(name, () => {
      const golden = JSON.parse(readFileSync(join(GOLDEN, name, "okf.json"), "utf8")) as { errors: string[]; warnings: string[] };
      const expected: Record<string, Record<string, number>> = {};
      for (const msg of [...golden.errors, ...golden.warnings]) {
        const kind = KINDS.find(([re]) => re.test(msg))?.[1];
        if (!kind) continue; // config-shape and round-trip errors are reported elsewhere
        const file = msg.split(":")[0]!;
        expected[file] ??= {};
        expected[file]![kind] = (expected[file]![kind] ?? 0) + 1;
      }
      const actual: Record<string, Record<string, number>> = {};
      for (const [file, ds] of bundleDiagnostics(loadBundle(dir))) {
        for (const d of ds) {
          if (d.code === "broken-target") continue; // plugin-only check (urn targets)
          actual[file] ??= {};
          actual[file]![d.code] = (actual[file]![d.code] ?? 0) + 1;
        }
      }
      expect(actual).toEqual(expected);
    });
  }

  it("reproduces okf_validate's metadata messages", () => {
    const ds = bundleDiagnostics(loadBundle(BUNDLES["reltypes-property_values"]!)).get("invalid.md")!;
    const golden = JSON.parse(readFileSync(join(GOLDEN, "reltypes-property_values", "okf.json"), "utf8")).errors as string[];
    // Python prints whole floats as 5.0 and lists with single quotes; JS cannot
    // tell 5.0 from 5. Compare with both normalised.
    const norm = (m: string) => m.replace(/(\d+)\.0\b/g, "$1").replace(/'/g, '"').replace(/", "/g, '","');
    for (const g of golden) {
      const tail = norm(g.slice(g.indexOf("metadata[")));
      expect(ds.map((d) => norm(d.message)).some((m) => m.endsWith(tail)), tail).toBe(true);
    }
  });
});

describe("bundle index", () => {
  const index = loadBundle(BUNDLES.rel!);

  it("resolves path and urn targets to concepts", () => {
    const a = index.outgoing.get("a.md")!;
    expect(a.map((e) => [e.type, e.resolved])).toEqual([
      ["derived-from", "sub/c.md"],
      ["relates-to", "b.md"],
      ["uses", "sub/c.md"],
    ]);
  });

  it("collects incoming edges with inverse labels", () => {
    const incoming = index.incoming.get("sub/c.md")!;
    expect(incoming.map((e) => [e.from, incomingLabel(e.type, index.registry)])).toEqual([
      ["a.md", "derives"],
      ["a.md", "used-by"],
    ]);
  });

  it("says when regenerating would drop body-only lines, and offers to keep them first", () => {
    const fixes = bundleDiagnostics(index).get("e.md")!.find((d) => d.code === "mirror-drift")!.fixes.map((f) => f.label);
    expect(fixes).toEqual([
      "Add body-only relationships to frontmatter",
      "Regenerate the body mirror from frontmatter (drops 2 body-only lines)",
    ]);
  });

  it("puts diagnostics on the right lines", () => {
    const b = index.concepts.get("b.md")!;
    const ds = bundleDiagnostics(index).get("b.md")!;
    const drift = ds.find((d) => d.code === "mirror-drift")!;
    expect(b.text.split("\n")[drift.line!]).toBe("## Relationships");
    const link = ds.find((d) => d.code === "broken-link")!;
    expect(b.text.split("\n")[link.line!]).toContain("(/missing.md)");
    const a = index.concepts.get("a.md")!;
    const temporal = bundleDiagnostics(index).get("a.md")!.find((d) => d.code === "temporal-inconsistency")!;
    expect(a.text.split("\n")[temporal.line!]).toContain("type: derived-from");
  });

  it("parses created values like okf_validate", () => {
    expect(parseCreated("2026-01-15T10:30:00Z")).toBe(Date.UTC(2026, 0, 15, 10, 30));
    expect(parseCreated("2026-01-15T10:30:00+05:30")).toBe(Date.UTC(2026, 0, 15, 5, 0));
    expect(parseCreated("2026-01-15")).toBe(Date.UTC(2026, 0, 15));
    expect(parseCreated("not a date")).toBeNull();
  });
});
