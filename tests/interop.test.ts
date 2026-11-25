// JSON-LD export, round-trip report, public API, typed graph, and
// the mif-cli output parsers and bridge (against a fake executable; the real
// binary is exercised by tests/live-mif-cli.test.ts when MIF_CLI is set).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("./support/obsidian-stub"));

import { MifApi } from "../src/api";
import { findMifCli, MifCli, type LookupEnv } from "../src/cliBridge";
import { embeddingReference, exportPath, graphOf, layout, parseIngest, parseProblem, parseScored, parseStats, serializeJsonLd, staleExports } from "../src/engine";
import { MifManager } from "../src/manager";
import { DEFAULT_SETTINGS } from "../src/settings";
import { memoryApp } from "./support/obsidian-stub";

const fixture = (dir: string, f: string) => readFileSync(join(__dirname, "fixtures", dir, f), "utf8");
const golden = (p: string) => readFileSync(join(__dirname, "golden", p), "utf8");

async function vault(files: Record<string, string>, settings = DEFAULT_SETTINGS) {
  const v = memoryApp(files);
  const manager = new MifManager(v.app as never, () => settings);
  await manager.loadBundles();
  await manager.scanAll();
  return { v, manager };
}

const relFiles = () => Object.fromEntries(["a.md", "b.md", "d.md", "e.md", "sub/c.md"].map((f) => [f, fixture("rel", f)]));

describe("JSON-LD export", () => {
  it("lays files out as mif_convert's emit-jsonld", () => {
    expect(exportPath("jsonld", "rel", "sub/c.md")).toBe("jsonld/rel/sub/c.jsonld");
    expect(exportPath("/out/", "vault", "a.md")).toBe("out/vault/a.jsonld");
  });

  it("writes the same JSON as the reference converter's golden projection", async () => {
    const { v, manager } = await vault(relFiles());
    const r = await manager.exportJsonLd("");
    expect(r).toMatchObject({ written: 5, skipped: [], removed: 0, folder: "dist/jsonld" });
    const written = JSON.parse(v.texts.get("dist/jsonld/test-vault/a.jsonld")!);
    expect(written).toEqual(JSON.parse(golden("rel/a.md/jsonld.json")));
    expect(v.texts.get("dist/jsonld/test-vault/sub/c.jsonld")).toBe(serializeJsonLd(manager.get("sub/c.md")!.jsonld!));
  });

  it("exports one note or one folder, and trashes stale projections on a full export", async () => {
    const { v, manager } = await vault(relFiles());
    expect((await manager.exportJsonLd("sub")).written).toBe(1);
    expect([...v.texts.keys()].filter((k) => k.endsWith(".jsonld"))).toEqual(["dist/jsonld/test-vault/sub/c.jsonld"]);
    await v.app.vault.create("dist/jsonld/test-vault/gone.jsonld", "{}");
    const r = await manager.exportJsonLd("");
    expect(r.removed).toBe(1);
    expect(v.trashed).toEqual(["dist/jsonld/test-vault/gone.jsonld"]);
    expect(staleExports(["jsonld/x/a.jsonld", "jsonld/x/b.jsonld", "jsonld/y/a.jsonld", "jsonld/x/c.md"], "jsonld", "x", ["a.md"])).toEqual(["jsonld/x/b.jsonld"]);
  });

  it("skips concepts with no projection", async () => {
    const { manager } = await vault({ "bad.md": "---\nid: x\ntype: [\n---\n\nBody.\n", ...relFiles() });
    const r = await manager.exportJsonLd("");
    expect(r.skipped).toEqual(["bad.md"]);
  });
});

describe("round-trip report (Invariant 4)", () => {
  it("is clean for the relationship fixtures and finds a lossy concept", async () => {
    const lossy = fixture("edge", "unicode-long.md"); // `description` beside `summary` is lost in the projection
    const { manager } = await vault({ ...relFiles(), "lossy.md": lossy });
    const report = await manager.roundtripReport();
    expect(report.map((r) => r.path)).toEqual(["lossy.md"]);
  });
});

describe("public API", () => {
  it("reports computed facts and typed relations", async () => {
    const { manager } = await vault(relFiles());
    const api = new MifApi(manager);
    expect(api.concept("a.md")).toMatchObject({ path: "a.md", type: "semantic", level: 1, errors: 0, compressed: false });
    expect(api.concept("nope.md")).toBeUndefined();
    expect(api.concepts().map((c) => c.path)).toEqual(["a.md", "b.md", "d.md", "e.md", "sub/c.md"]);
    const rel = api.relations("a.md");
    expect(rel.outgoing.length).toBeGreaterThan(0);
    expect(rel.outgoing.every((e) => typeof e.type === "string")).toBe(true);
    expect(api.jsonld("a.md")).toEqual(manager.get("a.md")!.jsonld);
    expect(api.jsonld("a.md")).not.toBe(manager.get("a.md")!.jsonld); // a copy
  });
});

describe("typed graph", () => {
  it("builds the bundle graph and a local neighbourhood", async () => {
    const { manager } = await vault(relFiles());
    const index = manager.indexFor("a.md")!.index;
    const whole = graphOf(index);
    expect(whole.nodes.map((n) => n.id)).toEqual(["a.md", "b.md", "d.md", "e.md", "sub/c.md"]);
    expect(whole.types).toEqual([...new Set(whole.edges.map((e) => e.type))].sort());
    const local = graphOf(index, { center: "e.md", depth: 1 });
    expect(local.nodes.map((n) => n.id)).toContain("e.md");
    expect(local.nodes.length).toBeLessThanOrEqual(whole.nodes.length);
    const hidden = graphOf(index, { types: new Set() });
    expect(hidden.edges).toEqual([]);
  });

  it("lays out deterministically inside the box, without overlaps", async () => {
    const { manager } = await vault(relFiles());
    const g1 = layout(graphOf(manager.indexFor("a.md")!.index));
    const g2 = layout(graphOf(manager.indexFor("a.md")!.index));
    expect(g1.nodes.map((n) => [n.x, n.y])).toEqual(g2.nodes.map((n) => [n.x, n.y]));
    for (const n of g1.nodes) expect(Math.abs(n.x) <= 500 && Math.abs(n.y) <= 500).toBe(true);
    for (let i = 0; i < g1.nodes.length; i++) {
      for (let j = i + 1; j < g1.nodes.length; j++) {
        expect(Math.hypot(g1.nodes[i]!.x - g1.nodes[j]!.x, g1.nodes[i]!.y - g1.nodes[j]!.y)).toBeGreaterThan(20);
      }
    }
  });
});

// Output captured from mif-cli 0.9.0 (mif-rs 4d7296d), 2026-10-08.
const REAL = {
  ingest: "citations/cited.md: lint=ok validate=ok roundtrip=lossless embedding_dim=384 stored=true (id=urn:mif:c0000000-0000-4000-8000-000000000001, db=/tmp/v.db)\n",
  search: "0.1052  urn:mif:c0000000-0000-4000-8000-000000000001\n0.0499  urn:mif:c0000000-0000-4000-8000-000000000003\n",
  stats: "count=6 dim=384 db=/tmp/v.db\n",
  problem: '{"type":"https://modeled-information-format.github.io/mif-rs/references/errors/invalid-document/v1","title":"Document failed schema validation","status":422,"detail":"MIF document failed schema validation: \\"citationType\\" is a required property"}',
  // From mif-rs feat/ingest-embedding-reference, 2026-10-09: the model, its hub revision, and normalization.
  ingestWithModel:
    "citations/cited.md: lint=ok validate=ok roundtrip=lossless embedding_dim=384 model=sentence-transformers/all-MiniLM-L6-v2 model_version=c9745ed1d9f207416be6d2e6f8de32d1f16199bf normalized=true stored=true (id=urn:mif:c0000000-0000-4000-8000-000000000001, db=/tmp/v.db)\n",
};

describe("mif-cli output", () => {
  it("reads the embedding model from an ingest line and builds the EmbeddingReference", () => {
    const r = parseIngest(REAL.ingestWithModel)!;
    expect(r.embedding).toEqual({ model: "sentence-transformers/all-MiniLM-L6-v2", modelVersion: "c9745ed1d9f207416be6d2e6f8de32d1f16199bf", dimensions: 384, normalized: true });
    expect(embeddingReference(r.embedding!, r.id!)).toEqual({
      "@type": "EmbeddingReference",
      model: "sentence-transformers/all-MiniLM-L6-v2",
      modelVersion: "c9745ed1d9f207416be6d2e6f8de32d1f16199bf",
      dimensions: 384,
      vectorUri: "urn:mif:vector:c0000000-0000-4000-8000-000000000001",
      normalized: true,
    });
    expect(parseIngest(REAL.ingest)!.embedding).toBeUndefined();
  });

  it("parses ingest, search, stats, and problem documents", () => {
    expect(parseIngest(REAL.ingest)).toEqual({
      checks: { lint: "ok", validate: "ok", roundtrip: "lossless", embedding_dim: "384", stored: "true", id: "urn:mif:c0000000-0000-4000-8000-000000000001", db: "/tmp/v.db" },
      id: "urn:mif:c0000000-0000-4000-8000-000000000001",
      stored: true,
    });
    expect(parseScored(REAL.search)).toEqual([
      { score: 0.1052, id: "urn:mif:c0000000-0000-4000-8000-000000000001" },
      { score: 0.0499, id: "urn:mif:c0000000-0000-4000-8000-000000000003" },
    ]);
    expect(parseScored("(no matches)\n")).toEqual([]);
    expect(parseStats(REAL.stats)).toEqual({ count: 6, dim: 384 });
    expect(parseProblem(REAL.problem)).toMatchObject({ title: "Document failed schema validation", status: 422 });
    expect(parseProblem("not json")).toBeUndefined();
  });
});

/** A machine where only `executables` exist. */
function machine(executables: string[], path = "/usr/bin:/bin", windows = false): LookupEnv {
  return { path, home: windows ? "C:\\Users\\me" : "/home/me", windows, isExecutable: (f) => executables.includes(f) };
}

describe("findMifCli", () => {
  it("uses a set path as given, without looking for it", () => {
    const looked = () => {
      throw new Error("looked");
    };
    expect(findMifCli("  /opt/mif/mif-cli ", looked)).toEqual({ bin: "/opt/mif/mif-cli" });
  });

  it("prefers PATH, in order, to the usual install folders", () => {
    const everywhere = ["/a/mif-cli", "/b/mif-cli", "/home/me/.cargo/bin/mif-cli", "/opt/homebrew/bin/mif-cli"];
    expect(findMifCli("", () => machine(everywhere, "/b:/a"))).toEqual({ bin: "/b/mif-cli" });
    expect(findMifCli("", () => machine(everywhere.slice(2), "/b:/a"))).toEqual({ bin: "/home/me/.cargo/bin/mif-cli" });
    expect(findMifCli("", () => machine(["/opt/homebrew/bin/mif-cli", "/usr/local/bin/mif-cli"], "/usr/bin"))).toEqual({ bin: "/opt/homebrew/bin/mif-cli" });
    expect(findMifCli("", () => machine(["/usr/local/bin/mif-cli"], ""))).toEqual({ bin: "/usr/local/bin/mif-cli" });
  });

  it("skips relative and empty PATH entries and searches each folder once", () => {
    const r = findMifCli("", () => machine(["./mif-cli", "bin/mif-cli"], ".::bin:/usr/local/bin/:/usr/bin"));
    expect(r).toEqual({ searched: ["/usr/local/bin", "/usr/bin", "/home/me/.cargo/bin", "/opt/homebrew/bin"] });
  });

  it("looks for mif-cli.exe on Windows", () => {
    const env = machine(["C:\\Users\\me\\.cargo\\bin\\mif-cli.exe"], "C:\\Windows;relative", true);
    expect(findMifCli("", () => env)).toEqual({ bin: "C:\\Users\\me\\.cargo\\bin\\mif-cli.exe" });
    expect(findMifCli("", () => machine([], "C:\\Windows", true))).toEqual({ searched: ["C:\\Windows", "C:\\Users\\me\\.cargo\\bin"] });
  });
});

describe("mif-cli bridge (fake executable)", () => {
  const files = { "cited.md": fixture("citations", "cited.md"), "uncited.md": fixture("citations", "uncited.md") };

  // The bridge asks a binary for its version before its first command; `version` answers that
  // (null hands the question to `answer`, and records it like any other call).
  async function bridge(answer: (args: string[]) => { code: number; stdout?: string; stderr?: string }, path = "/bin/mif-cli", env: LookupEnv = machine([]), version: string | null = "mif-cli 0.13.0\n") {
    const { v, manager } = await vault(files);
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec = (file: string, args: string[], _o: unknown, cb: (e: (Error & { code?: number }) | null, out: string, err: string) => void) => {
      if (version !== null && args.includes("--version")) return cb(null, version, "");
      calls.push({ file, args });
      const a = answer(args);
      cb(a.code ? Object.assign(new Error("exit"), { code: a.code }) : null, a.stdout ?? "", a.stderr ?? "");
    };
    const cli = new MifCli(v.app as never, manager, () => ({ ...DEFAULT_SETTINGS, mifCliPath: path }), exec as never, () => env);
    return { v, manager, cli, calls };
  }

  it("is off when the path is empty and mif-cli is nowhere, saying where it looked", async () => {
    const { cli, calls } = await bridge(() => ({ code: 0 }), "", machine([], "/usr/bin:/bin"));
    const why = cli.unavailable();
    expect(why).toContain("/usr/bin, /bin, /home/me/.cargo/bin, /opt/homebrew/bin, /usr/local/bin");
    expect(why).toMatch(/Set its path in Settings → MIF → mif-cli path/);
    await expect(cli.version()).rejects.toThrow(/was not found/);
    expect(calls).toEqual([]);
  });

  it("runs the mif-cli found on PATH when the path is empty", async () => {
    const { cli, calls } = await bridge(() => ({ code: 0, stdout: "mif-cli 0.13.0\n" }), "", machine(["/home/me/.cargo/bin/mif-cli"]), null);
    expect(cli.unavailable()).toBeUndefined();
    expect(await cli.version()).toBe("mif-cli 0.13.0");
    expect(calls[0]!.file).toBe("/home/me/.cargo/bin/mif-cli");
  });

  it("refuses a mif-cli older than 0.13.0, and says which version it found", async () => {
    const { v, cli, calls } = await bridge(() => ({ code: 0, stdout: REAL.search }), "/bin/mif-cli", machine([]), "mif-cli 0.12.0\n");
    // Nothing is known until the binary has been asked once.
    expect(cli.unavailable()).toBeUndefined();
    expect(await cli.ingest(v.files.get("cited.md") as never)).toMatchObject({ title: expect.stringMatching(/mif-cli 0\.12\.0 was found, and 0\.13\.0 or later is needed/) });
    expect(cli.unavailable()).toMatch(/0\.13\.0 or later is needed/);
    expect(calls).toEqual([]);
  });

  it("ingests with an argument list (no shell) into the bundle's store", async () => {
    const { v, cli, calls } = await bridge(() => ({ code: 0, stdout: REAL.ingest }));
    const r = await cli.ingest(v.files.get("cited.md") as never);
    expect(r).toMatchObject({ stored: true });
    expect(calls[0]).toEqual({ file: "/bin/mif-cli", args: ["--format", "json", "ingest", "cited.md", "--db-path", ".mif/vectors.db"] });
  });

  it("reports a refused ingest as its problem document", async () => {
    const { v, cli } = await bridge(() => ({ code: 2, stderr: REAL.problem }));
    expect(await cli.ingest(v.files.get("cited.md") as never)).toMatchObject({ title: "Document failed schema validation", status: 422 });
  });

  it("does not search a store that does not exist (the CLI would create one)", async () => {
    const { cli, calls } = await bridge(() => ({ code: 0, stdout: REAL.search }));
    expect(await cli.search("", "memory")).toMatchObject({ title: "Nothing ingested yet" });
    expect(calls).toEqual([]);
  });

  it("maps search hits back to notes by id", async () => {
    const { v, cli } = await bridge(() => ({ code: 0, stdout: REAL.search }));
    (v.app.vault.adapter as { exists: (p: string) => Promise<boolean> }).exists = async (p) => p === ".mif/vectors.db";
    expect(await cli.similar(v.files.get("uncited.md") as never)).toEqual([
      { score: 0.1052, cosine: 0.1052, id: "urn:mif:c0000000-0000-4000-8000-000000000001", path: "cited.md", title: "Cited fact" },
      { score: 0.0499, cosine: 0.0499, id: "urn:mif:c0000000-0000-4000-8000-000000000003", path: "uncited.md", title: "Uncited" },
    ]);
  });
});
