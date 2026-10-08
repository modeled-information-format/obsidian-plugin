// MifManager under a stubbed `obsidian` module: renames, and the race with
// Obsidian's own link updater found in testing.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("./support/obsidian-stub"));

import { MifManager } from "../src/manager";
import { DEFAULT_SETTINGS } from "../src/settings";
import { memoryApp, type TFile } from "./support/obsidian-stub";

const REL = join(__dirname, "fixtures", "rel");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const relFixtures = () => Object.fromEntries(walk(REL).map((p) => [relative(REL, p), readFileSync(p, "utf8")]));

async function setup(config: Record<string, unknown> = {}) {
  const vault = memoryApp(relFixtures(), config);
  const manager = new MifManager(vault.app as never, () => DEFAULT_SETTINGS);
  vault.onModify((f) => void manager.noteActivity(f as never));
  await manager.loadBundles();
  await manager.scanAll();
  return { ...vault, manager };
}

/** Move sub/c.md to c.md, as in the manual test, and return the pre-move texts. */
function moveC(v: Awaited<ReturnType<typeof setup>>) {
  const before = { c: v.texts.get("sub/c.md")!, a: v.texts.get("a.md")! };
  const c = v.move("sub/c.md", "c.md");
  v.manager.handleRename(c as never, "sub/c.md");
  return before;
}

/** What Obsidian's updater writes for that move (offsets from before the move). */
function obsidianUpdates(v: Awaited<ReturnType<typeof setup>>, before: { c: string; a: string }) {
  v.staleReplace("c.md", before.c, "[Concept A](../a.md)", "[Concept A](a.md)");
  v.staleReplace("a.md", before.a, "[the C source](/sub/c.md)", "[the C source](/c.md)");
}

const clean = (v: Awaited<ReturnType<typeof setup>>) => {
  expect(v.texts.get("c.md")).toContain("- part-of [Concept A](a.md)");
  expect(v.texts.get("c.md")).toContain("target: a.md");
  expect(v.texts.get("a.md")).toContain("[the C source](/c.md)");
  expect(v.texts.get("a.md")).toContain("target: /c.md");
};

describe("renames", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retargets referrers and the moved concept's own relative targets", async () => {
    const v = await setup({ alwaysUpdateLinks: true });
    const c = v.move("sub/c.md", "procedures/c.md");
    v.manager.handleRename(c as never, "sub/c.md");
    await vi.advanceTimersByTimeAsync(11_000); // no Obsidian update: auto-update cap
    expect(v.texts.get("a.md")).toContain("target: /procedures/c.md");
    expect(v.texts.get("a.md")).toContain("[the C source](/procedures/c.md)");
    expect(v.texts.get("procedures/c.md")).toContain("target: ../a.md");
  });

  it("waits for Obsidian's prompted link update, however late it lands", async () => {
    const v = await setup(); // "Automatically update internal links" off: Obsidian asks first
    const before = moveC(v);
    await vi.advanceTimersByTimeAsync(4000); // user clicks the dialog after 4 s
    expect(v.texts.get("c.md")).toBe(before.c); // untouched while waiting
    obsidianUpdates(v, before);
    await vi.advanceTimersByTimeAsync(3000);
    clean(v);
  });

  it("applies its own fixes after the cap when the user declines the dialog", async () => {
    const v = await setup();
    moveC(v);
    await vi.advanceTimersByTimeAsync(61_000);
    clean(v);
  });

  it("follows Obsidian's immediate update when auto-update is on", async () => {
    const v = await setup({ alwaysUpdateLinks: true });
    const before = moveC(v);
    await vi.advanceTimersByTimeAsync(200);
    obsidianUpdates(v, before);
    await vi.advanceTimersByTimeAsync(3000);
    clean(v);
  });

  it("repairs a mirror line damaged after its own edits (safety net)", async () => {
    const v = await setup({ alwaysUpdateLinks: true });
    const before = moveC(v);
    await vi.advanceTimersByTimeAsync(200);
    obsidianUpdates(v, before);
    await vi.advanceTimersByTimeAsync(1700); // plugin edits land
    // A late writer splices with offsets 7 characters off, as seen in Obsidian.
    const text = v.texts.get("c.md")!;
    const at = text.indexOf("[Concept A](a.md)") + 7;
    v.texts.set("c.md", text.slice(0, at) + "[Concept A](a.md)" + text.slice(at + 10));
    expect(v.texts.get("c.md")).toContain("[Concep[Concept A](a.md)");
    await vi.advanceTimersByTimeAsync(3500); // verification pass
    expect(v.texts.get("c.md")).toContain("- part-of [Concept A](a.md)");
    expect(v.texts.get("c.md")).not.toContain("Concep[");
  });
});

describe("writes to open notes", () => {
  it("go through Vault.process and are read back", async () => {
    const v = memoryApp(relFixtures());
    const processSpy = vi.spyOn(v.app.vault, "process");
    const manager = new MifManager(v.app as never, () => DEFAULT_SETTINGS);
    await manager.loadBundles();
    await manager.scanAll();
    await manager.applyFix(v.files.get("b.md") as never, { label: "mirror", transform: "mirror" });
    expect(processSpy).toHaveBeenCalledTimes(1);
    expect(v.texts.get("b.md")).toContain("- supersedes [Concept A](/a.md)");
  });

  it("report a write that does not stick", async () => {
    const v = memoryApp(relFixtures());
    const manager = new MifManager(v.app as never, () => DEFAULT_SETTINGS);
    await manager.loadBundles();
    await manager.scanAll();
    // Something else rewrites the file right after the plugin's write.
    const real = v.app.vault.process;
    v.app.vault.process = async (f: Parameters<typeof real>[0], fn: (t: string) => string) => {
      await real(f, fn);
      v.texts.set("b.md", "clobbered");
      return "clobbered";
    };
    const ok = await manager.write(v.files.get("b.md") as never, (t) => t + "\n");
    expect(ok).toBe(false);
  });
});

describe("entities", () => {
  it("creates a missing entity file from the diagnostic's fix, which then resolves", async () => {
    const { memoryAdapter } = await import("./support/obsidian-stub");
    const concept = [
      "---",
      "id: 11111111-2222-4333-8444-555555555555",
      "type: semantic",
      "created: 2026-01-01T00:00:00Z",
      "entities:",
      "  - '@type': EntityReference",
      "    entity:",
      "      '@id': urn:mif:entity:person:jane-doe",
      "    name: Jane Doe",
      "    entityType: Person",
      "---",
      "",
      "Body.",
      "",
    ].join("\n");
    const v = memoryApp({ "note.md": concept });
    const dotFiles = new Map<string, string>();
    (v.app.vault as { adapter: unknown }).adapter = memoryAdapter(dotFiles);
    const manager = new MifManager(v.app as never, () => DEFAULT_SETTINGS);
    await manager.loadBundles();
    await manager.scanAll();
    const d = manager.get("note.md")!.diagnostics.find((x) => x.code === "entity-unresolved")!;
    expect(d.fixes[0]!.data).toEqual({ urn: "urn:mif:entity:person:jane-doe", name: "Jane Doe", entityType: "Person" });
    await manager.applyFix(v.files.get("note.md") as never, d.fixes[0]!);
    expect(dotFiles.get(".mif/entities/person/jane-doe.yaml")).toContain("name: Jane Doe");
    expect(manager.get("note.md")!.diagnostics.map((x) => x.code)).not.toContain("entity-unresolved");
    expect(manager.entityIndex("").get("urn:mif:entity:person:jane-doe")!.refs.map((r) => r.path)).toEqual(["note.md"]);
  });
});

describe("Properties panel edits", () => {
  it("edit one field through the writer and refresh diagnostics", async () => {
    const v = memoryApp(relFixtures());
    const manager = new MifManager(v.app as never, () => DEFAULT_SETTINGS);
    await manager.loadBundles();
    await manager.scanAll();
    const before = v.texts.get("a.md")!;
    expect(manager.get("a.md")!.level).toBe(1);
    await manager.editField(v.files.get("a.md") as never, ["namespace"], "_semantic/test");
    await manager.editField(v.files.get("a.md") as never, ["modified"], "2026-03-02T00:00:00Z");
    await manager.editField(v.files.get("a.md") as never, ["temporal"], { recordedAt: "2026-03-01T09:00:00Z" });
    const after = v.texts.get("a.md")!;
    expect(manager.get("a.md")!.level).toBe(2);
    // Only additions; the relationships block and body are untouched.
    expect(after.split("\n").filter((l) => !before.split("\n").includes(l))).toEqual([
      "modified: 2026-03-02T00:00:00Z", "namespace: _semantic/test", "temporal:", "  recordedAt: 2026-03-01T09:00:00Z",
    ]);
    expect(await manager.editField(v.files.get("a.md") as never, ["provenance", "confidence"], 0.8)).toBe(true);
    expect(v.texts.get("a.md")).toContain("provenance:\n  confidence: 0.8");
  });
});

describe("access tracking", () => {
  it("is off by default, and when on bumps the count at most hourly", async () => {
    const v = memoryApp(relFixtures());
    const settings = { ...DEFAULT_SETTINGS };
    const manager = new MifManager(v.app as never, () => settings);
    await manager.loadBundles();
    await manager.scanAll();
    const before = v.texts.get("a.md");
    await manager.trackAccess(v.files.get("a.md") as never);
    expect(v.texts.get("a.md")).toBe(before);
    settings.accessTracking = true;
    await manager.trackAccess(v.files.get("a.md") as never);
    await manager.trackAccess(v.files.get("a.md") as never);
    const temporal = (manager.get("a.md")!.frontmatter!.temporal as { accessCount: number; lastAccessed: string });
    expect(temporal.accessCount).toBe(1);
    expect(temporal.lastAccessed).toMatch(/Z$/);
  });
});

describe("Citations and compression through the manager", () => {
  const CIT = join(__dirname, "fixtures", "citations");
  const cit = (f: string) => readFileSync(join(CIT, f), "utf8");

  afterEach(() => vi.useRealTimers());

  it("Sync mode keeps an existing ## Citations section in step with a frontmatter edit", async () => {
    vi.useFakeTimers();
    const v = memoryApp({ "cited.md": cit("cited.md") });
    const manager = new MifManager(v.app as never, () => ({ ...DEFAULT_SETTINGS, mode: "sync" as const }));
    await manager.loadBundles();
    await manager.scanAll();
    const file = v.files.get("cited.md")!;
    // The user changes the first citation's role in the editor and saves.
    v.texts.set("cited.md", v.texts.get("cited.md")!.replace("    citationRole: supports\n", "    citationRole: extends\n"));
    manager.markDirty("cited.md");
    await manager.analyzeFile(file as never);
    manager.scheduleStamp(file as never);
    await vi.advanceTimersByTimeAsync(2500);
    const out = v.texts.get("cited.md")!;
    expect(out).toContain("  - **Role**: extends");
    expect(out).toContain("- [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339)");
    expect(out).toContain("- [CommonMark](https://spec.commonmark.org/)"); // body-only entry kept
    expect(out).toMatch(/^modified: /m);
  });

  it("offers to create the entity file for a citation author", async () => {
    const { memoryAdapter } = await import("./support/obsidian-stub");
    const v = memoryApp({ "cited.md": cit("cited.md") });
    const dotFiles = new Map<string, string>();
    (v.app.vault as { adapter: unknown }).adapter = memoryAdapter(dotFiles);
    const manager = new MifManager(v.app as never, () => DEFAULT_SETTINGS);
    await manager.loadBundles();
    await manager.scanAll();
    const d = manager.get("cited.md")!.diagnostics.find((x) => x.code === "entity-unresolved")!;
    expect(d.path).toEqual(["citations", 0, "author"]);
    await manager.applyFix(v.files.get("cited.md") as never, d.fixes[0]!);
    expect(dotFiles.get(".mif/entities/person/jane-smith.yaml")).toContain("name: Jane Smith");
    expect(manager.get("cited.md")!.diagnostics.map((x) => x.code)).not.toContain("entity-unresolved");
  });

  it("compresses and restores, with a notice each way", async () => {
    const { notices } = await import("./support/obsidian-stub");
    const v = memoryApp({ "long.md": cit("long.md"), "cited.md": cit("cited.md") });
    const manager = new MifManager(v.app as never, () => DEFAULT_SETTINGS);
    await manager.loadBundles();
    await manager.scanAll();
    const file = v.files.get("long.md") as never;
    const d = manager.get("long.md")!.diagnostics.find((x) => x.code === "compression-candidate")!;
    await manager.applyFix(file, d.fixes[0]!);
    expect(manager.get("long.md")!.frontmatter!.compressedAt).toBeDefined();
    expect(notices.at(-1)).toMatch(/^MIF: compressed\./);
    await manager.applyFix(file, { label: "Restore", transform: "decompress" });
    expect(v.texts.get("long.md")).toBe(cit("long.md"));
    expect(notices.at(-1)).toBe("MIF: original content restored.");
  });
});

describe("superseding an expired concept", () => {
  it("creates the revision, links it, ends the old validity, and opens it", async () => {
    const TEMP = join(__dirname, "fixtures", "temporal");
    const v = memoryApp({ "temporal/stale.md": readFileSync(join(TEMP, "stale.md"), "utf8") });
    const opened: string[] = [];
    (v.app as { workspace: Record<string, unknown> }).workspace = { iterateAllLeaves: () => {}, openLinkText: async (p: string) => void opened.push(p) };
    const manager = new MifManager(v.app as never, () => DEFAULT_SETTINGS);
    await manager.loadBundles();
    await manager.scanAll();
    const d = manager.get("temporal/stale.md")!.diagnostics.find((x) => x.code === "freshness-stale")!;
    await manager.applyFix(v.files.get("temporal/stale.md") as never, d.fixes.find((f) => f.transform === "supersede")!);
    const revised = v.texts.get("temporal/stale-revised.md")!;
    expect(revised).toContain("- supersedes [Stale incident note](stale.md)");
    expect(manager.get("temporal/stale-revised.md")!.level).toBeGreaterThanOrEqual(1);
    expect(v.texts.get("temporal/stale.md")).toMatch(/validUntil: /);
    expect(manager.get("temporal/stale.md")!.diagnostics.map((x) => x.code)).toContain("superseded");
    expect(opened).toEqual(["temporal/stale-revised.md"]);
  });
});
