// The mif-cli 0.13.0 surface: match parsing, the ingest ledger and coverage,
// background ingest, prune, the duplicate check, and the relationship gap
// report, against a fake executable.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("./support/obsidian-stub"));

import { MifCli } from "../src/cliBridge";
import {
  conceptHash, coverage, parseIngest, parseIngestBatch, parseMatches, parsePrune, parseStats, parseVersion, passageLine, relationshipGaps, snippet, versionAtLeast,
} from "../src/engine";
import { MifManager } from "../src/manager";
import { RelatedView } from "../src/relations";
import { DEFAULT_SETTINGS, type MifSettings } from "../src/settings";
import { CoverageView, GapsView } from "../src/storeViews";
import { installDom } from "./support/dom";
import { memoryApp, notices } from "./support/obsidian-stub";

const fixture = (f: string) => readFileSync(join(__dirname, "fixtures/citations", f), "utf8");
const ID = { cited: "c0000000-0000-4000-8000-000000000001", uncited: "c0000000-0000-4000-8000-000000000003", long: "c0000000-0000-4000-8000-000000000004" };
const urn = (k: keyof typeof ID) => `urn:mif:${ID[k]}`;

// Output captured from mif-cli 0.13.0 (mif-rs 3149405), 2026-11-25.
const REAL = {
  stored: (path: string, k: keyof typeof ID) =>
    `${path}: lint=ok validate=ok roundtrip=lossless embedding_dim=384 passages=3 model=sentence-transformers/all-MiniLM-L6-v2 model_version=1110a243fdf4706b3f48f1d95db1a4f5529b4d41 normalized=true stored=true (id=${urn(k)}, db=/v/.mif/vectors.db)\n`,
  unchanged: (path: string, k: keyof typeof ID) => `${path}: unchanged stored=false (id=${urn(k)}, db=/v/.mif/vectors.db)\n`,
  refused: (path: string) => `${path}: error: MIF document failed schema validation: "citationType" is a required property\n`,
  batchFailed: '{"type":"https://modeled-information-format.github.io/mif-rs/references/errors/mif-cli-ingest-batch-failed/v1","title":"Some documents were not ingested","status":422,"detail":"1 of 5 documents were not ingested","exit_code":2}',
  search: JSON.stringify({
    matches: [
      { id: urn("long"), score: 0.032786883413791656, cosine: 0.653450071811676, bm25: -19.19605827331543, path: "long.md", title: "Long runbook", entity_type: null, concept_type: "procedural", heading: null, text: "Long runbook\nRotate keys monthly, verify each service, and record the rotation.", span: null },
      { id: urn("cited"), score: 0.0161, cosine: 0.21, bm25: null, path: "cited.md", title: "Cited fact", entity_type: "how-to-guide", concept_type: "semantic", heading: "Citations", text: "Cited fact\nCitations\nA cited line.", span: { start_char: 40, end_char: 60, start_line: 5, end_line: 6 } },
    ],
  }),
  similar: "0.5598  urn:mif:c0000000-0000-4000-8000-000000000003\n0.0500  urn:mif:c0000000-0000-4000-8000-000000000004\n",
  pruneDry: "would prune urn:mif:c0000000-0000-4000-8000-0000000000ff\nwould prune 1 documents, 4 found under /v (db=/v/.mif/vectors.db)\n",
  pruned: "pruned urn:mif:c0000000-0000-4000-8000-0000000000ff\npruned 1 documents, 4 found under /v (db=/v/.mif/vectors.db)\n",
  stats: "count=4 dim=384 db=/v/.mif/vectors.db passages=21 documents_without_passages=0 documents_without_text=2\n",
  notFound: '{"type":"https://modeled-information-format.github.io/mif-rs/references/errors/mif-cli-document-not-found/v1","title":"No document with the given id has been ingested","status":404,"detail":"no document with id \'urn:mif:x\' has been ingested into this vector store","exit_code":3}',
};

describe("mif-cli 0.13.0 output", () => {
  it("reads the version and compares it with the oldest one supported", () => {
    expect(parseVersion("mif-cli 0.13.0\n")).toEqual([0, 13, 0]);
    expect(versionAtLeast([0, 13, 0])).toBe(true);
    expect(versionAtLeast([1, 0, 0])).toBe(true);
    expect(versionAtLeast([0, 12, 9])).toBe(false);
    expect(parseVersion("nonsense")).toBeUndefined();
  });

  it("parses search matches with their passage", () => {
    expect(parseMatches(REAL.search)).toEqual([
      { id: urn("long"), score: 0.032786883413791656, cosine: 0.653450071811676, source: "long.md", title: "Long runbook", conceptType: "procedural", text: "Long runbook\nRotate keys monthly, verify each service, and record the rotation." },
      { id: urn("cited"), score: 0.0161, cosine: 0.21, source: "cited.md", title: "Cited fact", entityType: "how-to-guide", conceptType: "semantic", heading: "Citations", text: "Cited fact\nCitations\nA cited line.", startLine: 5 },
    ]);
    expect(parseMatches('{"matches":[]}')).toEqual([]);
    // The text form of 0.12.0 and earlier is not a result.
    expect(parseMatches("0.1052  urn:mif:x\n")).toBeUndefined();
  });

  it("finds the line to open for a match", () => {
    const note = "---\nid: x\n---\n\n# Title\n\nIntro.\n\n## Setup\n\nDo this.\n";
    expect(passageLine(note, "Setup", 2)).toBe(8);
    // A heading the note no longer has falls back to the span, counted from the body.
    expect(passageLine(note, "Gone", 3)).toBe(5);
    expect(passageLine(note)).toBeUndefined();
    expect(passageLine("no frontmatter\n\n## Setup\n", "Setup")).toBe(2);
  });

  it("makes a snippet without repeating the title", () => {
    expect(snippet("Long runbook\nRotate keys monthly,\n  verify each service.", "Long runbook")).toBe("Rotate keys monthly, verify each service.");
    expect(snippet("x".repeat(300), undefined, 50)).toHaveLength(50);
    expect(snippet(undefined)).toBe("");
  });

  it("parses stored, unchanged, and refused documents of a batch ingest", () => {
    expect(parseIngest(REAL.unchanged("/v/cited.md", "cited"))).toMatchObject({ unchanged: true, stored: false, id: urn("cited") });
    const r = parseIngestBatch(REAL.stored("/v/cited.md", "cited") + REAL.unchanged("/v/sub/long.md", "long"), `${REAL.refused("/v/broken.md")}${REAL.batchFailed}`, ["/v/cited.md", "/v/sub/long.md", "/v/broken.md", "/v/missing.md"]);
    expect(r.get("/v/cited.md")).toMatchObject({ stored: true, embedding: { dimensions: 384 } });
    expect(r.get("/v/sub/long.md")).toMatchObject({ unchanged: true });
    expect(r.get("/v/broken.md")).toMatchObject({ title: "Not ingested", detail: expect.stringContaining("citationType") });
    expect(r.has("/v/missing.md")).toBe(false);
  });

  it("parses prune and stats", () => {
    expect(parsePrune(REAL.pruneDry)).toEqual(["urn:mif:c0000000-0000-4000-8000-0000000000ff"]);
    expect(parsePrune(REAL.pruned)).toEqual(["urn:mif:c0000000-0000-4000-8000-0000000000ff"]);
    expect(parseStats(REAL.stats)).toEqual({ count: 4, dim: 384, withoutText: 2 });
  });
});

describe("coverage and gaps", () => {
  it("hashes what a concept says, not what the plugin stamps on it", () => {
    const fm = { id: "x", title: "T", temporal: { validFrom: "2026-01-01", accessCount: 1 } };
    const h = conceptHash(fm, "Body");
    expect(conceptHash({ ...fm, modified: "2026-02-02", embedding: { model: "m" }, temporal: { validFrom: "2026-01-01", accessCount: 9, lastAccessed: "now" } }, "Body")).toBe(h);
    expect(conceptHash(fm, "Body changed")).not.toBe(h);
    expect(conceptHash({ ...fm, title: "Other" }, "Body")).not.toBe(h);
  });

  it("sorts concepts into current, changed, and never ingested, and finds orphans", () => {
    const c = coverage(
      [{ id: "A", path: "a.md", hash: "1" }, { id: "b", path: "b.md", hash: "2" }, { id: "c", path: "c.md", hash: "3" }],
      { a: { path: "a.md", hash: "1", at: "t" }, b: { path: "b.md", hash: "old", at: "t" }, gone: { path: "g.md", hash: "9", at: "t" } },
    );
    expect(c.rows.map((r) => [r.id, r.state])).toEqual([["a", "current"], ["b", "changed"], ["c", "never"]]);
    expect(c.orphans).toEqual(["gone"]);
  });

  it("reports similar pairs with no relationship, and related pairs that are unalike", () => {
    const similar = new Map([
      ["a", new Map([["b", 0.8], ["c", 0.05], ["d", 0.7]])],
      ["b", new Map([["a", 0.79], ["c", 0.3]])],
    ]);
    const r = relationshipGaps(similar, new Set(["a|c", "a|d"]), 0.55, 0.1);
    expect(r.unlinked).toEqual([{ a: "a", b: "b", cosine: 0.8 }]);
    expect(r.mislinks).toEqual([{ a: "a", b: "c", cosine: 0.05 }]);
  });
});

type Answer = { code: number; stdout?: string; stderr?: string };

async function bridge(answer: (args: string[]) => Answer, settings: Partial<MifSettings> = {}, extra: Record<string, string> = {}) {
  const v = memoryApp({ "cited.md": fixture("cited.md"), "uncited.md": fixture("uncited.md"), "long.md": fixture("long.md"), ...extra });
  const disk = new Map<string, string>([[".mif/vectors.db", "db"]]);
  Object.assign(v.app.vault.adapter, {
    exists: async (p: string) => disk.has(p) || p === ".mif",
    read: async (p: string) => disk.get(p) ?? "",
    write: async (p: string, d: string) => void disk.set(p, d),
    mkdir: async () => {},
  });
  const live = { ...DEFAULT_SETTINGS, mifCliPath: "/bin/mif-cli", ...settings };
  const manager = new MifManager(v.app as never, () => live);
  await manager.loadBundles();
  await manager.scanAll();
  manager.rebuildIndexes();
  const calls: string[][] = [];
  const exec = (_file: string, args: string[], _o: unknown, cb: (e: (Error & { code?: number }) | null, out: string, err: string) => void) => {
    const a = args.slice(2);
    if (a[0] === "--version") return cb(null, "mif-cli 0.13.0\n", "");
    calls.push(a);
    const r = answer(a);
    cb(r.code ? Object.assign(new Error("exit"), { code: r.code }) : null, r.stdout ?? "", r.stderr ?? "");
  };
  const cli = new MifCli(v.app as never, manager, () => live, exec as never, () => ({ path: "", home: "/h", windows: false, isExecutable: () => false }));
  const file = (p: string) => v.files.get(p) as never;
  const text = (p: string) => v.app.vault.read(v.files.get(p) as never) as Promise<string>;
  return { v, manager, cli, calls, disk, file, text, live };
}

/** Answers ingest with a stored line per file, and find-similar with nothing close. */
const storing = (a: string[]): Answer => {
  if (a[0] !== "ingest") return { code: 0, stdout: "(no matches)\n" };
  const files = a.slice(1, a.indexOf("--db-path"));
  const key = (f: string) => (f.replace(".md", "") as keyof typeof ID);
  return { code: 0, stdout: files.map((f) => REAL.stored(f, key(f))).join("") };
};

describe("search", () => {
  it("passes the entity type and folder filters, and resolves matches to notes", async () => {
    const { cli, calls } = await bridge(() => ({ code: 0, stdout: REAL.search }));
    const hits = await cli.search("", "rotate keys", { limit: 5, entityType: "how-to-guide", folder: "runbooks/keys" });
    expect(calls[0]).toEqual(["search", "rotate keys", "--db-path", ".mif/vectors.db", "--limit", "5", "--entity-type", "how-to-guide", "--source-prefix", "runbooks/keys/"]);
    expect(hits).toMatchObject([
      { path: "long.md", title: "Long runbook", cosine: 0.653450071811676 },
      { path: "cited.md", heading: "Citations", startLine: 5, entityType: "how-to-guide" },
    ]);
  });

  it("says so when the output is not what 0.13.0 prints", async () => {
    const { cli } = await bridge(() => ({ code: 0, stdout: "0.1052  urn:mif:x\n" }));
    expect(await cli.search("", "q")).toMatchObject({ title: "Unexpected mif-cli output" });
  });

  it("lists likely duplicates of a title by cosine similarity, not the hybrid score", async () => {
    const { cli, calls } = await bridge(() => ({ code: 0, stdout: REAL.search }));
    expect((await cli.duplicatesOf("", "Key rotation runbook")).map((h) => h.path)).toEqual(["long.md"]);
    expect(calls[0]).toContain("semantic");
    expect(await cli.duplicatesOf("", "  ")).toEqual([]);
  });
});

describe("ingest, the embedding reference, and the ledger", () => {
  beforeEach(() => void (notices.length = 0));

  it("writes the embedding reference by default and records the ingest in the ledger", async () => {
    const { cli, text, file, disk } = await bridge(storing);
    expect(await cli.ingest(file("cited.md"))).toMatchObject({ stored: true });
    expect(await text("cited.md")).toContain("vectorUri: urn:mif:vector:c0000000-0000-4000-8000-000000000001");
    const ledger = JSON.parse(disk.get(".mif/ingest-ledger.json")!) as { version: number; entries: Record<string, { path: string; hash: string }> };
    expect(ledger.version).toBe(1);
    expect(ledger.entries[ID.cited]).toMatchObject({ path: "cited.md" });
    // Writing the reference did not make the note look changed.
    expect((await cli.coverage("")).rows.find((r) => r.path === "cited.md")!.state).toBe("current");
  });

  it("leaves the note alone when the setting is off", async () => {
    const { cli, text, file } = await bridge(storing, { writeEmbeddingReference: false });
    const before = await text("cited.md");
    expect(await cli.ingest(file("cited.md"))).toMatchObject({ stored: true });
    expect(await text("cited.md")).toBe(before);
    expect((await cli.coverage("")).rows.find((r) => r.path === "cited.md")!.state).toBe("current");
  });

  it("a background ingest skips unchanged documents and never writes the note", async () => {
    const { cli, text, file, calls } = await bridge(storing);
    const before = await text("cited.md");
    expect(await cli.ingest(file("cited.md"), { background: true })).toMatchObject({ stored: true });
    expect(calls[0]).toEqual(["ingest", "cited.md", "--db-path", ".mif/vectors.db", "--changed-only"]);
    expect(await text("cited.md")).toBe(before);
  });

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("schedules one background ingest per burst of edits, and none for a note the store already has", async () => {
    const { cli, file, calls } = await bridge(storing);
    cli.scheduleIngest(file("cited.md"), 10);
    cli.scheduleIngest(file("cited.md"), 10);
    await wait(60);
    expect(calls.filter((c) => c[0] === "ingest")).toHaveLength(1);
    cli.scheduleIngest(file("cited.md"), 10);
    await wait(60);
    expect(calls.filter((c) => c[0] === "ingest")).toHaveLength(1);
  });

  it("does not start a vector store in the background", async () => {
    const { cli, file, calls, disk } = await bridge(storing);
    disk.delete(".mif/vectors.db");
    cli.scheduleIngest(file("cited.md"), 10);
    await wait(60);
    expect(calls).toEqual([]);
  });

  it("ingests a bundle in one run, counting stored, unchanged, and refused notes", async () => {
    const { cli, calls } = await bridge((a) => {
      if (a[0] !== "ingest") return { code: 0, stdout: "(no matches)\n" };
      return { code: 2, stdout: REAL.stored("cited.md", "cited") + REAL.unchanged("uncited.md", "uncited"), stderr: REAL.refused("long.md") + REAL.batchFailed };
    });
    const r = await cli.ingestBundle("");
    expect(r).toMatchObject({ stored: 1, unchanged: 1 });
    expect(r.failed).toEqual([{ path: "long.md", problem: { title: "Not ingested", detail: expect.stringContaining("citationType") } }]);
    expect(calls.filter((c) => c[0] === "ingest")).toHaveLength(1);
    expect(calls[0]!.at(-1)).toBe("--changed-only");
    const cov = await cli.coverage("");
    expect(Object.fromEntries(cov.rows.map((x) => [x.path, x.state]))).toEqual({ "cited.md": "current", "uncited.md": "current", "long.md": "never" });
  });

  it("shows a note as changed once its content differs from what was ingested", async () => {
    const { v, cli, manager, file } = await bridge(storing, { writeEmbeddingReference: false });
    await cli.ingest(file("uncited.md"));
    await v.app.vault.process(file("uncited.md"), (t: string) => `${t}\nA new paragraph.\n`);
    await manager.analyzeFile(file("uncited.md"));
    manager.rebuildIndexes();
    expect((await cli.coverage("")).rows.find((r) => r.path === "uncited.md")!.state).toBe("changed");
  });

  it("warns when a newly ingested concept is very like an existing one", async () => {
    const { cli, file } = await bridge((a) => (a[0] === "find-similar" ? { code: 0, stdout: REAL.similar } : storing(a)), { writeEmbeddingReference: false });
    await cli.ingest(file("cited.md"));
    expect(notices.join("\n")).toMatch(/cited may duplicate Uncited \(0\.56\)/);
    notices.length = 0;
    // Only the first ingest of a concept is news.
    await cli.ingest(file("cited.md"));
    expect(notices).toEqual([]);
  });
});

describe("prune and the gap report", () => {
  it("lists what a prune would remove without removing it, then prunes and forgets it", async () => {
    const { cli, calls, disk } = await bridge((a) => ({ code: 0, stdout: a.includes("--dry-run") ? REAL.pruneDry : REAL.pruned }), { excludedFolders: ["_spike", "notes/archive"] });
    disk.set(".mif/ingest-ledger.json", JSON.stringify({ version: 1, entries: { "c0000000-0000-4000-8000-0000000000ff": { path: "gone.md", hash: "h", at: "t" } } }));
    expect(await cli.prunable("")).toEqual(["urn:mif:c0000000-0000-4000-8000-0000000000ff"]);
    expect(calls[0]).toEqual(["prune", "--root", "", "--db-path", ".mif/vectors.db", "--ignore", "_spike", "--ignore", "notes/archive/**", "--dry-run"]);
    expect(await cli.prune("")).toHaveLength(1);
    expect(calls[1]).not.toContain("--dry-run");
    expect(JSON.parse(disk.get(".mif/ingest-ledger.json")!).entries).toEqual({});
  });

  it("finds similar pairs with no relationship and related pairs that are unalike", async () => {
    // In the fixtures cited.md relates to uncited.md, and long.md to cited.md; uncited and long are unrelated.
    const row: Record<string, string> = {
      [ID.cited]: `0.9000  ${urn("uncited")}\n0.0400  ${urn("long")}\n`,
      [ID.uncited]: `0.9000  ${urn("cited")}\n0.7000  ${urn("long")}\n`,
      [ID.long]: `0.0400  ${urn("cited")}\n0.7000  ${urn("uncited")}\n`,
    };
    const { cli, calls } = await bridge((a) => (a[0] === "corpus-stats" ? { code: 0, stdout: REAL.stats } : { code: 0, stdout: row[a[1]!.slice("urn:mif:".length)] ?? "" }));
    const r = await cli.gaps("");
    expect(r).toMatchObject({
      compared: 3,
      unlinked: [{ aPath: "uncited.md", bPath: "long.md", cosine: 0.7 }],
      mislinks: [{ aPath: "cited.md", bPath: "long.md", cosine: 0.04 }],
    });
    expect(calls.filter((c) => c[0] === "find-similar")).toHaveLength(3);
    expect(calls.find((c) => c[0] === "find-similar")!.slice(-2)).toEqual(["--limit", "4"]);
  });

  it("leaves out concepts that were never ingested", async () => {
    const { cli } = await bridge((a) => (a[0] === "corpus-stats" ? { code: 0, stdout: REAL.stats } : { code: 3, stderr: REAL.notFound }));
    expect(await cli.gaps("")).toMatchObject({ compared: 0, unlinked: [], mislinks: [] });
  });
});

describe("panels", () => {
  installDom();
  type Viewish = { open(): Promise<void>; contentEl: HTMLElement };
  const make = (View: unknown, app: unknown, host: unknown) => new (View as new (l: unknown, h: unknown) => Viewish)({ app }, host);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const activate = (v: { app: unknown; files: Map<string, unknown> }, path?: string) => {
    (v.app as Record<string, unknown>).workspace = { on: () => ({}), getActiveFile: () => (path ? v.files.get(path) : null), iterateAllLeaves: () => {} };
  };

  it("Related panel lists semantic neighbours and offers to relate the ones that are not", async () => {
    // Asked about long.md: cited.md (already related) and uncited.md (not).
    const { v, manager, cli } = await bridge(() => ({ code: 0, stdout: `0.8100  ${urn("cited")}\n0.6000  ${urn("uncited")}\n` }));
    activate(v, "long.md");
    const asked: Array<string | undefined> = [];
    const view = make(RelatedView, v.app, { manager, cli, editRelationship: (_f: unknown, _i: unknown, target?: string) => asked.push(target) });
    await view.open();
    await settle();
    await settle();
    const text = view.contentEl.textContent ?? "";
    expect(text).toContain("Semantically related");
    expect(text).toMatch(/0\.81Cited factrelated/);
    const add = [...view.contentEl.querySelectorAll("a")].filter((a) => a.textContent === "Add as relationship");
    expect(add).toHaveLength(1);
    add[0]!.click();
    expect(asked).toEqual(["uncited.md"]);
  });

  it("Coverage panel lists notes that were never ingested or changed since", async () => {
    const { v, manager, cli, file } = await bridge(storing, { writeEmbeddingReference: false });
    await cli.ingest(file("cited.md"));
    activate(v);
    const view = make(CoverageView, v.app, { manager, cli, editRelationship: () => {} });
    await view.open();
    const text = view.contentEl.textContent ?? "";
    expect(text).toContain("1 up to date · 0 changed since ingest · 2 never ingested");
    expect(text).toContain("Never ingested (2)");
    expect(text).toContain("long.md");
  });

  it("Gap panel compares on request and offers to relate a similar pair", async () => {
    const row: Record<string, string> = { [ID.cited]: "", [ID.uncited]: `0.9000  ${urn("long")}\n`, [ID.long]: `0.9000  ${urn("uncited")}\n` };
    const { v, manager, cli } = await bridge((a) => (a[0] === "corpus-stats" ? { code: 0, stdout: REAL.stats } : { code: 0, stdout: row[a[1]!.slice("urn:mif:".length)] ?? "" }));
    activate(v);
    const asked: Array<[string, string | undefined]> = [];
    const view = make(GapsView, v.app, { manager, cli, editRelationship: (f: { path: string }, _i: unknown, target?: string) => asked.push([f.path, target]) });
    await view.open();
    (view.contentEl.querySelector("button") as HTMLButtonElement).click();
    for (let i = 0; i < 20; i++) await settle();
    expect(view.contentEl.textContent).toContain("Similar, not related (1)");
    [...view.contentEl.querySelectorAll("a")].find((a) => a.textContent === "Add relationship")!.click();
    expect(asked).toEqual([["uncited.md", "long.md"]]);
  });
});
