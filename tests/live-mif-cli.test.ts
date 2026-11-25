// The mif-cli bridge against the real binary. Skipped unless
// MIF_CLI points at mif-rs's mif-cli:
//   MIF_CLI=/path/to/mif-cli npx vitest run tests/live-mif-cli.test.ts
// The first ingest downloads the embedding model from Hugging Face.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("./support/obsidian-stub"));

import { MifCli } from "../src/cliBridge";
import { MifManager } from "../src/manager";
import { DEFAULT_SETTINGS } from "../src/settings";
import { memoryApp } from "./support/obsidian-stub";

const BIN = process.env.MIF_CLI ? resolve(process.env.MIF_CLI) : "";

describe.skipIf(!BIN)("mif-cli bridge, live", () => {
  const dir = mkdtempSync(join(tmpdir(), "mif-live-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const names = ["cited.md", "uncited.md", "long.md", "broken.md"];
  const files = Object.fromEntries(names.map((f) => [f, readFileSync(join(__dirname, "fixtures/citations", f), "utf8")]));
  for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);

  async function setup() {
    const v = memoryApp(files);
    const adapter = v.app.vault.adapter as Record<string, unknown>;
    adapter.getFullPath = (p: string) => join(dir, p);
    adapter.exists = async (p: string) => existsSync(join(dir, p));
    mkdirSync(join(dir, ".mif"), { recursive: true });
    const manager = new MifManager(v.app as never, () => DEFAULT_SETTINGS);
    await manager.loadBundles();
    await manager.scanAll();
    const cli = new MifCli(v.app as never, manager, () => ({ ...DEFAULT_SETTINGS, mifCliPath: BIN }), execFile as never);
    return { v, manager, cli };
  }

  it("reports its version", async () => {
    const { cli } = await setup();
    expect(await cli.version()).toMatch(/^mif-cli \d+\.\d+\.\d+/);
  });

  it("refuses search before anything is ingested, without creating a store", async () => {
    const { cli } = await setup();
    expect(await cli.search("", "rotation")).toMatchObject({ title: "Nothing ingested yet" });
    expect(existsSync(join(dir, ".mif/vectors.db"))).toBe(false);
  });

  it("ingests the bundle, refusing the schema-invalid note", async () => {
    const { cli } = await setup();
    const r = await cli.ingestBundle("");
    expect(r.stored).toBe(3);
    expect(r.failed.map((f) => f.path)).toEqual(["broken.md"]);
    expect(r.failed[0]!.problem.detail).toContain("failed schema validation");
    expect(await cli.stats("")).toMatchObject({ count: 3, dim: 384 });
  }, 300_000);

  it("searches and finds similar concepts, mapped back to notes", async () => {
    const { v, cli } = await setup();
    const hits = await cli.search("", "rotate keys and verify each service", 3);
    expect(Array.isArray(hits)).toBe(true);
    const list = hits as Array<{ path?: string; score: number }>;
    expect(list[0]!.path).toBe("long.md");
    expect(list.every((h) => h.path && names.includes(h.path))).toBe(true);
    const similar = await cli.similar(v.files.get("cited.md") as never, 5);
    expect((similar as Array<{ path?: string }>).map((h) => h.path).sort()).toEqual(["long.md", "uncited.md"]);
  }, 120_000);

  it("returns the matching passage, filters by folder, and skips what is already stored", async () => {
    const { v, cli } = await setup();
    const hits = (await cli.search("", "rotate keys and verify each service", { limit: 3 })) as Array<{ path?: string; text?: string; cosine?: number; score: number }>;
    expect(hits[0]).toMatchObject({ path: "long.md", text: expect.stringContaining("Rotate keys monthly") });
    // Hybrid ranking: the score is a rank-fusion value, the cosine is the similarity.
    expect(hits[0]!.score).toBeLessThan(0.04);
    expect(hits[0]!.cosine).toBeGreaterThan(0.3);
    expect(await cli.search("", "rotate keys", { folder: "nowhere" })).toEqual([]);
    expect(await cli.ingest(v.files.get("cited.md") as never, { background: true })).toMatchObject({ unchanged: true, stored: false });
    const again = await cli.ingestBundle("");
    expect(again).toMatchObject({ stored: 0, unchanged: 3 });
    expect(again.failed.map((f) => f.path)).toEqual(["broken.md"]);
    expect(await cli.prunable("")).toEqual([]);
    expect(await cli.stats("")).toMatchObject({ count: 3, withoutText: 0 });
  }, 120_000);

  it("reports relationship gaps from pairwise similarity", async () => {
    const { cli } = await setup();
    const r = await cli.gaps("");
    expect(r).toMatchObject({ compared: 3 });
  }, 120_000);
});
