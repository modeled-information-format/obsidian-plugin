// Advisory ontology / namespace / entity checks on MIF's own example
// memories (tests/fixtures/memories, from MIF docs/examples/memories).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseMarkdown } from "../src/engine/convert";
import { entityReference, parseEntityFile, renderEntityFile, entitySlug } from "../src/engine/entities";
import { parseOntology, type Corpus } from "../src/engine/ontology";
import { semanticDiagnostics, usefulSuggestions, type SemanticContext } from "../src/engine/semantics";
import { updateFrontmatter } from "../src/engine/writer";

const dir = join(__dirname, "fixtures/ontologies/corpus");
const corpus: Corpus = new Map(readdirSync(dir).map((f) => parseOntology(readFileSync(join(dir, f), "utf8"), f).def!).map((d) => [d.id, d]));
const ctx = (over: Partial<SemanticContext> = {}): SemanticContext => ({
  corpus, reservedPrefixes: [], sharedAgreements: new Set(), entities: new Map(), downloadable: new Set(), defaultOntology: "mif-base", ...over,
});
const memory = (p: string) => parseMarkdown(readFileSync(join(__dirname, "fixtures/memories", p), "utf8"));
const codes = (p: string, c = ctx()) => {
  const { frontmatter, body } = memory(p);
  return semanticDiagnostics(frontmatter, body, p, c).diagnostics.map((d) => d.code);
};
const BASE = "---\nid: 11111111-2222-4333-8444-555555555555\ntype: semantic\ncreated: 2026-01-01T00:00:00Z\n---\n\nBody.\n";
const run = (fm: Record<string, unknown>, c = ctx(), body = "") => {
  const text = updateFrontmatter(BASE, fm);
  const p = parseMarkdown(text);
  return semanticDiagnostics(p.frontmatter, body || p.body, "x.md", c);
};

describe("MIF example memories", () => {
  it("accept _semantic/land against an ontology that declares semantic/land", () => {
    expect(codes("agriculture/soil-profile-example.md")).toEqual(["ontology-version"]);
  });
  it("flag the publishing ontology that exists nowhere", () => {
    expect(codes("publishing/state-adoption-example.md")).toEqual(["ontology-unknown"]);
  });
  it("offer a download when the catalog has the ontology", () => {
    const { frontmatter, body } = memory("publishing/state-adoption-example.md");
    const r = semanticDiagnostics(frontmatter, body, "x", ctx({ downloadable: new Set(["k12-educational-publishing"]) }));
    expect(r.diagnostics[0]!.fixes[0]!.transform).toBe("download-ontology");
  });
  it("do not type-check entities without a declared ontology", () => {
    expect(codes("agriculture/ram-001-breeding-record.md")).toEqual(["entity-type-no-ontology"]);
  });
  it("pass the biology-lab examples", () => {
    expect(codes("biology-lab/grant-example.md")).toEqual([]);
    expect(codes("biology-lab/protocol-example.md")).toEqual([]);
  });
  it("produce discovery hits from the ontology chain", () => {
    const { frontmatter, body } = memory("agriculture/soil-profile-example.md");
    expect(semanticDiagnostics(frontmatter, body, "x", ctx()).discovery.length).toBeGreaterThan(0);
  });
});

describe("namespace checks", () => {
  it("flag a base-type prefix that contradicts type, with a fix", () => {
    const d = run({ namespace: "_episodic/incidents" }).diagnostics.find((x) => x.code === "namespace-type")!;
    expect(d.fixes[0]!.updates).toEqual({ namespace: "_semantic/incidents" });
  });
  it("flag unknown reserved prefixes unless the bundle declares them", () => {
    expect(run({ namespace: "_team/x" }).diagnostics.map((d) => d.code)).toContain("namespace-reserved");
    expect(run({ namespace: "_team/x" }, ctx({ reservedPrefixes: ["_team"] })).diagnostics.map((d) => d.code)).not.toContain("namespace-reserved");
  });
  it("flag a _shared namespace without an agreement file", () => {
    // The spec's own example id "acme+bigcorp" is not a valid namespace segment
    // (mif.schema.json namespace pattern has no "+").
    expect(run({ namespace: "_shared/acme-bigcorp" }).diagnostics.map((d) => d.code)).toContain("namespace-shared");
    expect(run({ namespace: "_shared/acme-bigcorp" }, ctx({ sharedAgreements: new Set(["acme-bigcorp"]) })).diagnostics.map((d) => d.code)).toEqual([]);
  });
  it("flag a namespace the declared ontology does not cover, and a type_hint mismatch", () => {
    const a = run({ namespace: "nowhere/at-all", ontology: { id: "mif-base" } }).diagnostics.map((d) => d.code);
    expect(a).toContain("namespace-undeclared");
    const b = run({ type: "episodic", namespace: "_semantic/decisions", ontology: { id: "mif-base" } }).diagnostics.map((d) => d.code);
    expect(b).toEqual(expect.arrayContaining(["namespace-type", "namespace-type-hint"]));
  });
});

describe("entity type checks", () => {
  const adr = { ontology: { id: "mif-docs" }, entity: { name: "ADR-1", entity_type: "decision-record" } };
  const unresolved = (c: SemanticContext) => run(adr, c).diagnostics.filter((d) => d.code === "trait-unresolved");
  const withoutSharedTraits = new Map([...corpus].filter(([id]) => id === "mif-base" || id === "mif-docs"));
  it("resolve a mif-docs record's traits from any loaded ontology (shared-traits)", () => {
    expect(unresolved(ctx())).toEqual([]);
  });
  it("note traits no loaded ontology defines as info while catalog ontologies remain to download", () => {
    const d = unresolved(ctx({ corpus: withoutSharedTraits, downloadable: new Set(["shared-traits"]) }));
    expect(d.map((x) => [x.severity, x.message])).toEqual([
      ["info", expect.stringContaining("'versioned'")], ["info", expect.stringContaining("'documented'")],
    ]);
  });
  it("warn about traits no loaded ontology defines once nothing is left to download", () => {
    expect(unresolved(ctx({ corpus: withoutSharedTraits })).map((x) => x.severity)).toEqual(["warning", "warning"]);
  });
  it("report an unknown entity type and a base mismatch", () => {
    expect(run({ ontology: { id: "mif-base" }, entity: { name: "x", entity_type: "nope" } }).diagnostics.map((d) => d.code)).toContain("entity-type-unknown");
  });
});

describe("entities", () => {
  const file = "id: jane-doe\ntype: Person\nname: Jane Doe\naliases: [Jane]\nproperties: { role: maintainer }\n";

  it("parse .mif/entities/<type>/<slug>.yaml into a urn", () => {
    expect(parseEntityFile(file, "bundle/.mif/entities/person/jane-doe.yaml").entity).toMatchObject({
      urn: "urn:mif:entity:person:jane-doe", name: "Jane Doe", type: "Person", aliases: ["Jane"],
    });
    expect(parseEntityFile(file, "elsewhere/jane.yaml").error).toBeDefined();
  });

  it("flag unresolved and malformed references", () => {
    const ref = entityReference({ urn: "urn:mif:entity:person:jane-doe", name: "Jane Doe", entityType: "Person" });
    const bad = entityReference({ urn: "urn:mif:entity:auth-service" });
    const r = run({ entities: [ref, bad] });
    expect(r.diagnostics.map((d) => d.code)).toEqual(["entity-unresolved", "entity-urn"]);
    const known = parseEntityFile(file, ".mif/entities/person/jane-doe.yaml").entity!;
    expect(run({ entities: [ref] }, ctx({ entities: new Map([[known.urn, known]]) })).diagnostics).toEqual([]);
  });

  it("render and slug", () => {
    expect(entitySlug("Jane Doe")).toBe("jane-doe");
    expect(entitySlug("BigCorp")).toBe("big-corp");
    const text = renderEntityFile({ typeName: "Person", name: "Jane Doe", slug: "jane-doe" });
    expect(parseEntityFile(text, ".mif/entities/person/jane-doe.yaml").entity!.name).toBe("Jane Doe");
  });
});

describe("suggestions shown in the Ontology panel", () => {
  const hits = [
    { ontology: "o", namespaces: ["semantic/land"], entity: "soil-profile", match: "Soil" },
    { ontology: "o", namespaces: ["_semantic/farm"], entity: "land-parcel", match: "Field" },
  ];
  it("lists everything for a concept missing namespace or type", () => {
    expect(usefulSuggestions(hits, undefined, undefined)).toMatchObject({ collapsed: false, hits: { length: 2 } });
  });
  it("drops suggestions equal to current values and collapses a complete concept", () => {
    const r = usefulSuggestions(hits, "semantic/land", "soil-profile");
    expect(r.collapsed).toBe(true);
    expect(r.hits).toEqual([{ ontology: "o", namespaces: ["_semantic/farm"], entity: "land-parcel", match: "Field" }]);
  });
});
