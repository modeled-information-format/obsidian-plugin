// Relationship parsing and the body-mirror sync rule, against goldens from
// MIF's scripts/okf_validate.py (tests/golden/<bundle>/<concept>/rels.json
// and okf.json).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseMarkdown } from "../src/engine/convert";
import {
  addRelationship,
  bodyRelationships,
  buildRegistry,
  frontmatterRelationships,
  incomingLabel,
  kebab,
  mirrorDrift,
  relativeTarget,
  removeRelationship,
  resolveTarget,
  retarget,
  syncMirror,
  updateRelationship,
} from "../src/engine/relationships";

const ROOT = join(__dirname, "..");
const GOLDEN = join(ROOT, "tests", "golden");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const BUNDLES: Record<string, string> = {
  "test-vault": join(ROOT, "test-vault"),
  edge: join(ROOT, "tests/fixtures/edge"),
  rel: join(ROOT, "tests/fixtures/rel"),
  legacy: join(ROOT, "tests/fixtures/mif/legacy-0.1-bundle"),
  ...Object.fromEntries(
    readdirSync(join(ROOT, "tests/fixtures/mif/relationship_types")).map((n) => [`reltypes-${n}`, join(ROOT, "tests/fixtures/mif/relationship_types", n)]),
  ),
};

function* relGoldens(dir: string, rel = ""): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, "rels.json"))) yield `${rel}${e}`;
    else yield* relGoldens(p, `${rel}${e}/`);
  }
}

describe("kebab matches okf_validate._kebab", () => {
  for (const [input, expected] of Object.entries(readJson(join(GOLDEN, "kebab.json")) as Record<string, string>)) {
    it(input, () => expect(kebab(input)).toBe(expected));
  }
});

describe("relationship extraction matches okf_validate", () => {
  for (const [bundle, dir] of Object.entries(BUNDLES)) {
    if (!existsSync(join(GOLDEN, bundle))) continue;
    for (const concept of relGoldens(join(GOLDEN, bundle))) {
      it(`${bundle}/${concept}`, () => {
        const golden = readJson(join(GOLDEN, bundle, concept, "rels.json"));
        const { frontmatter, body } = parseMarkdown(readFileSync(join(dir, concept), "utf8"));
        expect(frontmatterRelationships(frontmatter).map((r) => [r.type, r.target])).toEqual(golden.frontmatter);
        expect(bodyRelationships(body).map((r) => [r.type, r.target])).toEqual(golden.body);
      });
    }
  }
});

describe("mirror sync check matches okf_validate", () => {
  for (const [bundle, dir] of Object.entries(BUNDLES)) {
    const okfPath = join(GOLDEN, bundle, "okf.json");
    if (!existsSync(okfPath)) continue;
    const outOfSync = new Set(
      (readJson(okfPath).errors as string[]).filter((e) => e.includes("relationships out of sync")).map((e) => e.split(":")[0]),
    );
    for (const concept of relGoldens(join(GOLDEN, bundle))) {
      it(`${bundle}/${concept} is ${outOfSync.has(concept) ? "out of" : "in"} sync`, () => {
        const { frontmatter, body } = parseMarkdown(readFileSync(join(dir, concept), "utf8"));
        expect(mirrorDrift(frontmatter, body) !== null).toBe(outOfSync.has(concept));
      });
    }
  }
});

describe("syncMirror", () => {
  const relDir = BUNDLES.rel!;
  for (const name of ["a.md", "b.md", "d.md", "e.md", "sub/c.md"]) {
    it(`brings ${name} into sync, idempotently, without touching frontmatter`, () => {
      const text = readFileSync(join(relDir, name), "utf8");
      const out = syncMirror(text);
      const before = parseMarkdown(text);
      const after = parseMarkdown(out);
      expect(after.frontmatter).toEqual(before.frontmatter);
      expect(mirrorDrift(after.frontmatter, after.body)).toBeNull();
      expect(syncMirror(out)).toBe(out);
    });
  }

  it("leaves an in-sync file byte-identical and keeps custom link text", () => {
    const a = readFileSync(join(relDir, "a.md"), "utf8");
    expect(syncMirror(a)).toBe(a);
    expect(a).toContain("[the C source](/sub/c.md)");
  });

  it("keeps prose inside the section and other sections", () => {
    const out = syncMirror(readFileSync(join(relDir, "e.md"), "utf8"));
    expect(out).toContain("Trailing prose inside the section.");
    expect(out).not.toContain("- relates-to [Concept A](/a.md)");
    const d = syncMirror(readFileSync(join(relDir, "d.md"), "utf8"));
    expect(d).toContain("## Notes\n\nSome other section.\n\n## Relationships\n\n- relates-to [A](/a.md)\n- relates-to [A](/a.md)\n- conflicts-with [B](/b.md)\n");
  });

  it("uses known titles for new lines", () => {
    const d = syncMirror(readFileSync(join(relDir, "d.md"), "utf8"), (t) => ({ "/a.md": "Concept A" })[t]);
    expect(d).toContain("- relates-to [Concept A](/a.md)");
  });
});

describe("editing relationships", () => {
  const base = "---\nid: x\ntype: semantic\ncreated: 2026-01-01T00:00:00Z\n---\n\n# X\n";

  it("adds, updates, and removes while keeping the mirror in sync", () => {
    let t = addRelationship(base, { type: "relates-to", target: "/a.md" }, () => "Concept A");
    t = addRelationship(t, { type: "uses", target: "/b.md", strength: 0.5 });
    expect(frontmatterRelationships(parseMarkdown(t).frontmatter)).toHaveLength(2);
    t = updateRelationship(t, 0, { type: "derived-from", target: "/a.md" });
    t = removeRelationship(t, 1);
    const { frontmatter, body } = parseMarkdown(t);
    expect(frontmatter.relationships).toEqual([{ type: "derived-from", target: "/a.md" }]);
    expect(body).toContain("- derived-from [Concept A](/a.md)");
    expect(mirrorDrift(frontmatter, body)).toBeNull();
    t = removeRelationship(t, 0);
    expect(parseMarkdown(t).frontmatter).not.toHaveProperty("relationships");
    expect(t).not.toContain("## Relationships");
  });
});

describe("registry", () => {
  it("knows the nine core types and their inverses", () => {
    const r = buildRegistry();
    expect([...r.types.keys()]).toEqual([
      "relates-to", "derived-from", "supersedes", "conflicts-with", "part-of", "implements", "uses", "created", "mentioned-in",
    ]);
    expect(incomingLabel("derived-from", r)).toBe("derives");
    expect(incomingLabel("relates-to", r)).toBe("relates-to");
    expect(incomingLabel("mentioned-in", r)).toBe("mentions");
    expect(incomingLabel("farm:x", r)).toBe("farm:x (incoming)");
  });

  it("adds declared custom types; a duplicate is an error and the last declaration wins (as in okf_validate)", () => {
    const r = buildRegistry({
      relationship_types: [
        { name: "BreedsWith", namespace: "farm", inverse: "BredBy" },
        { name: "BreedsWith", namespace: "farm" },
        { name: "RelatesTo" },
      ],
    });
    expect(r.types.get("farm:breeds-with")?.inverse).toBe("farm:breeds-with");
    expect(r.errors).toHaveLength(1);
    const once = buildRegistry({ relationship_types: [{ name: "BreedsWith", namespace: "farm", inverse: "BredBy" }] });
    expect(once.types.get("farm:breeds-with")?.inverse).toBe("farm:bred-by");
    expect(incomingLabel("farm:breeds-with", once)).toBe("farm:bred-by");
    expect(r.configPresent).toBe(true);
  });
});

describe("targets", () => {
  it("resolves like okf_validate._resolve", () => {
    expect(resolveTarget("/sub/c.md", "a.md")).toEqual({ kind: "path", bundlePath: "sub/c.md" });
    expect(resolveTarget("../a.md", "sub/c.md")).toEqual({ kind: "path", bundlePath: "a.md" });
    expect(resolveTarget("b.md#heading", "a.md")).toEqual({ kind: "path", bundlePath: "b.md" });
    expect(resolveTarget("/space%20name.md", "a.md")).toEqual({ kind: "path", bundlePath: "space name.md" });
    expect(resolveTarget("urn:mif:C3C3C3C3-0000-4000-8000-000000000003", "a.md")).toEqual({ kind: "concept-urn", id: "c3c3c3c3-0000-4000-8000-000000000003" });
    expect(resolveTarget("urn:mif:entity:person:x", "a.md").kind).toBe("other-urn");
    expect(resolveTarget("https://x.org/a.md", "a.md").kind).toBe("external");
    expect(resolveTarget("../../escape.md", "sub/c.md").kind).toBe("external");
  });

  it("computes relative targets", () => {
    expect(relativeTarget("sub/c.md", "a.md")).toBe("../a.md");
    expect(relativeTarget("a.md", "sub/c.md")).toBe("sub/c.md");
    expect(relativeTarget("x/y/z.md", "x/q.md")).toBe("../q.md");
  });

  it("retargets referrers after a rename, keeping each target's style", () => {
    const a = readFileSync(join(BUNDLES.rel!, "a.md"), "utf8");
    const moved = new Map([["sub/c.md", "procedures/c.md"], ["b.md", "events/b.md"]]);
    const out = retarget(a, { from: "a.md", to: "a.md" }, moved);
    const { frontmatter, body } = parseMarkdown(out);
    expect(frontmatterRelationships(frontmatter).map((r) => r.target)).toEqual([
      "/procedures/c.md", "events/b.md", "urn:mif:c3c3c3c3-0000-4000-8000-000000000003",
    ]);
    expect(body).toContain("[the C source](/procedures/c.md)");
    expect(mirrorDrift(frontmatter, body)).toBeNull();
  });

  it("recomputes a moved file's own relative targets", () => {
    const c = readFileSync(join(BUNDLES.rel!, "sub/c.md"), "utf8");
    const out = retarget(c, { from: "sub/c.md", to: "deep/er/c.md" }, new Map([["sub/c.md", "deep/er/c.md"]]));
    const { frontmatter, body } = parseMarkdown(out);
    expect(frontmatterRelationships(frontmatter)[0]!.target).toBe("../../a.md");
    expect(mirrorDrift(frontmatter, body)).toBeNull();
  });

  it("repairs a mirror line Obsidian's link updater already rewrote", () => {
    const a = readFileSync(join(BUNDLES.rel!, "a.md"), "utf8").replace("[the C source](/sub/c.md)", "[the C source](procedures/c.md)");
    const out = retarget(a, { from: "a.md", to: "a.md" }, new Map([["sub/c.md", "procedures/c.md"]]));
    expect(out).toContain("[the C source](/procedures/c.md)");
    const { frontmatter, body } = parseMarkdown(out);
    expect(mirrorDrift(frontmatter, body)).toBeNull();
  });
});

describe("damaged mirror lines", () => {
  const damaged = "---\nid: x\ntype: semantic\ncreated: 2026-01-01T00:00:00Z\ntitle: C\nrelationships:\n  - type: part-of\n    target: a.md\n---\n\n## Relationships\n\n- part-of [Concep[Concept A](a.md)\n";

  it("are detected even though the sync check passes", async () => {
    const { malformedMirrorLines } = await import("../src/engine/relationships");
    const { frontmatter, body } = parseMarkdown(damaged);
    expect(mirrorDrift(frontmatter, body)).toBeNull();
    expect(malformedMirrorLines(body)).toHaveLength(1);
    expect(malformedMirrorLines(parseMarkdown(readFileSync(join(BUNDLES.rel!, "a.md"), "utf8")).body)).toEqual([]);
  });

  it("are repaired by regenerating, with the title instead of the damaged text", () => {
    const out = syncMirror(damaged, () => "Concept A");
    expect(out).toContain("- part-of [Concept A](a.md)\n");
    expect(out).not.toContain("Concep[");
  });
});

describe("type tokens follow spec §8.1.1 (MIF 1.4.0)", async () => {
  const { buildRegistry, CORE_TYPES, kebab } = await import("../src/engine/relationships");
  it("rule 1: hyphen before every capital but the first, lower-cased", () => {
    expect(["DerivedFrom", "ConflictsWith", "Uses", "HttpProxy", "HTTPProxy"].map(kebab)).toEqual(["derived-from", "conflicts-with", "uses", "http-proxy", "h-t-t-p-proxy"]);
  });
  it("rules 2–3: a namespace prefixes the type and its inverse", () => {
    const r = buildRegistry({ relationship_types: [
      { name: "BreedsWith", namespace: "farm", symmetric: true },
      { name: "Reinforces", inverse: "ReinforcedBy", namespace: "subcog" },
    ] } as never);
    expect(r.types.get("farm:breeds-with")).toMatchObject({ inverse: "farm:breeds-with" });
    expect(r.types.get("subcog:reinforces")).toMatchObject({ inverse: "subcog:reinforced-by" });
    expect(CORE_TYPES.find((t) => t.token === "derived-from")!.inverse).toBe("derives");
  });
  it("every token matches the schema's Relationship.type pattern", () => {
    const re = /^[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$/;
    expect(CORE_TYPES.every((t) => re.test(t.token) && (!t.inverse || re.test(t.inverse)))).toBe(true);
  });
});
