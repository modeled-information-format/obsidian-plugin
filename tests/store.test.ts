// OntologyStore under a stubbed network: downloads follow `extends`, each
// file is verified against the catalog sha256, and bundle-local definitions
// override downloaded ones.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("./support/obsidian-stub"));

import { CATALOG_URL, OntologyStore } from "../src/ontologyStore";
import { memoryAdapter, network } from "./support/obsidian-stub";

const CORPUS = join(__dirname, "fixtures/ontologies/corpus");
const yaml = (id: string) => readFileSync(join(CORPUS, `${id}.ontology.yaml`), "utf8");
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

function publish(ids: Record<string, string[]>, tamper?: string) {
  network.clear();
  const ontologies: Record<string, unknown> = {};
  for (const [id, ext] of Object.entries(ids)) {
    const url = `https://mif-spec.dev/ontologies/${id}.ontology.yaml`;
    const text = yaml(id);
    network.set(url, id === tamper ? `${text}\n# tampered\n` : text);
    ontologies[id] = { file: `${id}.ontology.yaml`, sha256: sha(text), version: "x", yaml: url, extends: ext };
  }
  network.set(CATALOG_URL, JSON.stringify({ aliases: { latest: "0.4.0" }, ontologies }));
}

function store(files = new Map<string, string>()) {
  const app = { vault: { adapter: memoryAdapter(files) } };
  return { s: new OntologyStore(app as never, ".obsidian/plugins/mif"), files };
}

describe("OntologyStore", () => {
  beforeEach(() => publish({ "mif-base": [], "shared-traits": [], "engineering-base": ["mif-base", "shared-traits"], "platform-engineering": ["engineering-base"] }));

  it("downloads an ontology and everything it extends, and caches it", async () => {
    const { s, files } = store();
    const got = await s.download(["platform-engineering"]);
    expect(got.sort()).toEqual(["engineering-base", "mif-base", "platform-engineering", "shared-traits"]);
    expect([...files.keys()].filter((f) => f.endsWith(".yaml")).length).toBe(4);
    // A fresh store reads the cache without the network.
    network.clear();
    const again = new OntologyStore({ vault: { adapter: memoryAdapter(files) } } as never, ".obsidian/plugins/mif");
    await again.loadCache();
    expect([...again.corpusFor([]).keys()].sort()).toEqual(["engineering-base", "mif-base", "platform-engineering", "shared-traits"]);
  });

  it("refuses a file whose sha256 does not match the catalog", async () => {
    publish({ "mif-base": [] }, "mif-base");
    const { s, files } = store();
    expect(await s.download(["mif-base"])).toEqual([]);
    expect(s.status.errors.join()).toContain("sha256 mismatch");
    expect([...files.keys()].some((f) => f.endsWith("mif-base.ontology.yaml"))).toBe(false);
  });

  it("lets a bundle's own .mif/ontologies definition win", async () => {
    const { s, files } = store();
    await s.download(["mif-base"]);
    files.set("bundle/.mif/ontologies/mif-base.ontology.yaml", "ontology:\n  id: mif-base\n  version: '9.9.9'\n");
    const local = await s.loadBundleLocal("bundle");
    expect(s.corpusFor(local.defs).get("mif-base")!.version).toBe("9.9.9");
  });

  it("does not hit the network for an id the catalog lacks, or re-fetch the catalog", async () => {
    const { s: st } = store();
    await st.download(["mif-base"]);
    const calls: string[] = [];
    const real = network.get(CATALOG_URL)!;
    network.delete(CATALOG_URL); // any catalog request would now fail loudly
    const spy = vi.spyOn(network, "get").mockImplementation((url: string) => {
      calls.push(url);
      return url === CATALOG_URL ? undefined : real;
    });
    expect(await st.download(["k12-educational-publishing"])).toEqual([]);
    expect(await st.download(["mif-base"])).toEqual([]);
    expect(calls).toEqual([]);
    expect(st.status.errors).toEqual([]);
    spy.mockRestore();
  });
});
