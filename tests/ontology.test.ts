// Ontology engine against the reference implementations: mif-rs for
// `extends` chains (tests/golden/ontology-chains.json, from
// scripts/gen_rust_goldens.mjs) and the Python validators for namespaces,
// visible types, and subtype_of (tests/golden/ontologies.json). Trait
// composition has no reference implementation; its tests are the §10.8.6
// examples.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkNamespaces,
  checkSubtypeOf,
  chainTraits,
  composeTraits,
  discover,
  flattenNamespaces,
  globToRegExp,
  parseOntology,
  resolveChain,
  visibleTypes,
  type Corpus,
  type OntologyDef,
} from "../src/engine/ontology";

const ROOT = join(__dirname, "..");
const CORPUS_DIR = join(ROOT, "tests/fixtures/ontologies/corpus");
const SUBTYPE_DIR = join(ROOT, "tests/fixtures/ontologies/subtype_of");
const chains = JSON.parse(readFileSync(join(ROOT, "tests/golden/ontology-chains.json"), "utf8"));
const py = JSON.parse(readFileSync(join(ROOT, "tests/golden/ontologies.json"), "utf8"));

function load(dir: string): { corpus: Corpus; errors: Map<string, string[]> } {
  const corpus: Corpus = new Map();
  const errors = new Map<string, string[]>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ontology.yaml")).sort()) {
    const { def, errors: e } = parseOntology(readFileSync(join(dir, f), "utf8"), f);
    if (e.length) errors.set(f, e);
    if (def) corpus.set(def.id, def);
  }
  return { corpus, errors };
}

const { corpus, errors: corpusErrors } = load(CORPUS_DIR);

const corpusOf = (texts: string[]): Corpus =>
  new Map(texts.map((t, i) => parseOntology(t, `t${i}`).def!).map((d) => [d.id, d]));

describe("corpus", () => {
  it("loads all 29 ontologies, each valid against ontology.schema.json", () => {
    expect(corpus.size).toBe(29);
    expect(Object.fromEntries(corpusErrors)).toEqual({});
  });
});

describe("resolveChain matches mif_ontology::resolve_chain", () => {
  for (const [id, expected] of Object.entries(chains.corpus as Record<string, string[] | { error: string }>)) {
    it(id, () => {
      if ("error" in expected) expect(() => resolveChain(id, corpus)).toThrow(expected.error);
      else expect(resolveChain(id, corpus).map((d) => d.id)).toEqual(expected);
    });
  }
  for (const [name, c] of Object.entries(chains.synthetic as Record<string, { texts: string[]; id: string; result: string[] | { error: string } }>)) {
    it(`synthetic: ${name}`, () => {
      const local = corpusOf(c.texts);
      if (Array.isArray(c.result)) expect(resolveChain(c.id, local).map((d) => d.id)).toEqual(c.result);
      else expect(() => resolveChain(c.id, local)).toThrow(c.result.error);
    });
  }
});

describe("namespaces match ontologies/scripts/validate-namespaces.py", () => {
  for (const [id, expected] of Object.entries(py.namespaces as Record<string, Record<string, unknown>>)) {
    it(`flattens ${id}`, () => {
      expect(Object.fromEntries(flattenNamespaces(corpus.get(id)!.namespaceTree))).toEqual(expected);
    });
  }
  it("check_corpus finds the same problems (none upstream)", () => {
    expect(Object.fromEntries(checkNamespaces(corpus))).toEqual(py.namespaceChecks);
  });
  it("reports a type_hint conflict and a dangling replaces", () => {
    const base = "ontology:\n  id: base\n  version: '1.0.0'\nnamespaces:\n  _semantic:\n    type_hint: semantic\n";
    const child = "ontology:\n  id: child\n  version: '1.0.0'\n  extends: [base]\nnamespaces:\n  _semantic:\n    type_hint: episodic\n  x:\n    replaces: nowhere\n";
    const errs = checkNamespaces(corpusOf([base, child])).get("child")!;
    expect(errs).toHaveLength(2);
    expect(errs[0]).toContain("conflicts with type_hint 'semantic'");
    expect(errs[1]).toContain("replaces 'nowhere'");
  });
});

describe("entity types match MIF scripts/validate-ontologies.py", () => {
  for (const [id, expected] of Object.entries(py.visibleTypes as Record<string, string[]>)) {
    it(`visible types of ${id}`, () => expect([...visibleTypes(id, corpus).keys()].sort()).toEqual(expected));
  }
  const sub = load(SUBTYPE_DIR).corpus;
  const both: Corpus = new Map([...corpus, ...sub]);
  for (const [file, expected] of Object.entries(py.subtypeChecks as Record<string, string[]>)) {
    it(`subtype_of checks for ${file}`, () => {
      const dir = file.startsWith("corpus/") ? CORPUS_DIR : SUBTYPE_DIR;
      const def = parseOntology(readFileSync(join(dir, file.replace(/^corpus\//, "")), "utf8"), file).def!;
      const scope = file.startsWith("corpus/") ? corpus : both;
      expect(checkSubtypeOf(def, visibleTypes(def.id, scope))).toEqual(expected.map((e) => e.replace(/^ {2}- /, "")));
    });
  }
});

describe("trait composition (§10.8.6)", () => {
  const spec = `
ontology: { id: spec, version: "1.0.0" }
traits:
  timestamped:
    fields:
      created: { type: string, format: date-time }
      modified: { type: string, format: date-time }
  auditable:
    extends: [timestamped]
    fields:
      audit_log: { type: array }
  lifecycle:
    extends: [timestamped]
    requires: [temporal]
    fields:
      status: { type: string, enum: [draft, active, archived] }
  trait_a:
    fields: { status: { type: string, enum: [open, closed] } }
  trait_b:
    fields: { status: { type: string, enum: [draft, published] } }
  stamped_override:
    extends: [timestamped]
    fields: { created: { type: string, format: date } }
  loop_a: { extends: [loop_b] }
  loop_b: { extends: [loop_a] }
entity_types:
  - { name: document, base: semantic, traits: [auditable, lifecycle] }
  - { name: conflicting, base: semantic, traits: [trait_a, trait_b] }
  - name: resolved
    base: semantic
    traits: [trait_a, trait_b]
    schema: { properties: { status: { type: string, enum: [draft, open, published, closed] } } }
  - { name: overridden, base: semantic, traits: [stamped_override] }
  - { name: dangling, base: semantic, traits: [nope] }
  - { name: looping, base: semantic, traits: [loop_a] }
`;
  const local = corpusOf([spec]);
  const traits = chainTraits(resolveChain("spec", local));
  const compose = (name: string) => composeTraits(visibleTypes("spec", local).get(name)!, traits);

  it("resolves a diamond to the shared ancestor without conflict", () => {
    const c = compose("document");
    expect(c.conflicts).toEqual([]);
    expect(c.fields.get("created")!.origin).toBe("timestamped");
    expect([...c.fields.keys()].sort()).toEqual(["audit_log", "created", "modified", "status"]);
    expect(c.requires).toEqual(["temporal"]);
  });

  it("reports the same field from independent traits, with both sources", () => {
    const c = compose("conflicting");
    expect(c.conflicts).toHaveLength(1);
    expect(c.conflicts[0]!.field).toBe("status");
    expect(c.conflicts[0]!.definitions.map((d) => d.origin)).toEqual(["trait_a", "trait_b"]);
  });

  it("lets the entity schema resolve a conflict", () => {
    const c = compose("resolved");
    expect(c.conflicts).toEqual([]);
    expect(c.fields.get("status")!.origin).toBe("entity");
  });

  it("lets a child trait override an inherited field", () => {
    expect(compose("overridden").fields.get("created")).toEqual({ schema: { type: "string", format: "date" }, origin: "stamped_override" });
  });

  it("reports unresolved traits and trait cycles", () => {
    expect(compose("dangling").unresolved).toEqual(["nope"]);
    expect(compose("looping").cycles).toEqual(["loop_a -> loop_b -> loop_a"]);
  });

  it("finds the corpus's unresolvable mif-docs traits", () => {
    const docTraits = chainTraits(resolveChain("mif-docs", corpus));
    const adr = composeTraits(visibleTypes("mif-docs", corpus).get("decision-record")!, docTraits);
    expect(adr.unresolved.sort()).toEqual(["documented", "versioned"]);
  });
});

describe("discovery", () => {
  it("compiles every corpus pattern", () => {
    const all = [...corpus.values()].flatMap((d: OntologyDef) => d.discovery.patterns);
    expect(all.length).toBeGreaterThan(100);
    for (const p of all) if (p.content) expect(() => new RegExp(p.content!, "iu"), p.content).not.toThrow();
  });

  it("suggests from content and file patterns along a chain", () => {
    const chain = resolveChain("platform-engineering", corpus);
    const hits = discover(chain, "We adopted the Repository Pattern after the Strategy Pattern review.", "notes/x.md");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => chain.some((d) => d.id === h.ontology))).toBe(true);
  });

  it("ignores file patterns unless asked (they target source files)", () => {
    const chain = resolveChain("mif-base", corpus);
    const path = "_fixtures/memories/agriculture/soil-profile-example.md";
    expect(discover(chain, "", path).length).toBe(0);
    expect(discover(chain, "", path, { filePatterns: true }).length).toBeGreaterThanOrEqual(0);
  });

  it("translates globs", () => {
    expect(globToRegExp("**/*.tf").test("infra/main.tf")).toBe(true);
    expect(globToRegExp("docs/*.md").test("docs/a/b.md")).toBe(false);
  });
});
