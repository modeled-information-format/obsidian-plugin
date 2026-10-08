// Render the plugin's panels in a headless DOM against real fixtures, so
// drawing errors are caught by the suite instead of in Obsidian.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => import("./support/obsidian-stub"));

import { installDom } from "./support/dom";
import { memoryApp, VIEW_INTERNALS } from "./support/obsidian-stub";

beforeAll(() => installDom());

const soil = readFileSync(join(__dirname, "fixtures/memories/agriculture/soil-profile-example.md"), "utf8");

async function setup(files: Record<string, string>, active: string) {
  const { MifManager } = await import("../src/manager");
  const { DEFAULT_SETTINGS } = await import("../src/settings");
  const v = memoryApp(files);
  const workspace = { on: () => ({}), getActiveFile: () => v.files.get(active), iterateAllLeaves: () => {} };
  (v.app as Record<string, unknown>).workspace = workspace;
  const manager = new MifManager(v.app as never, () => DEFAULT_SETTINGS);
  await manager.loadBundles();
  await manager.scanAll();
  return { v, manager, host: { manager, revealView: async () => {}, addEntityReference: () => {}, convertActive: () => {}, editRelationship: () => {} } };
}

describe("panels render without errors", () => {
  it("Properties panel draws every section for a Level 3 concept", async () => {
    const { PropertiesView } = await import("../src/propertiesView");
    const { v, host } = await setup({ "soil.md": soil }, "soil.md");
    const view = new PropertiesView({ app: v.app } as never, host as never);
    await (view as unknown as { open(): Promise<void> }).open();
    const el = (view as unknown as { contentEl: HTMLElement }).contentEl;
    expect(el.textContent).toContain("North Field Soil Profile");
    expect(el.querySelectorAll("details").length).toBe(10);
    expect(el.textContent).toContain("MIF build");
  });

  it("Properties panel still draws when Obsidian focuses the new panel", async () => {
    const { PropertiesView } = await import("../src/propertiesView");
    const { v, host } = await setup({ "soil.md": soil }, "soil.md");
    const view = new PropertiesView({ app: v.app } as never, host as never);
    const el = (view as unknown as { contentEl: HTMLElement }).contentEl;
    document.body.appendChild(el);
    const holder = el.createDiv();
    holder.tabIndex = 0;
    holder.focus(); // focus inside the panel, but not in a text field
    await (view as unknown as { open(): Promise<void> }).open();
    expect(el.querySelectorAll("details").length).toBe(10);
  });

  it("Properties panel defers redraws while a field is being typed in", async () => {
    const { PropertiesView } = await import("../src/propertiesView");
    const { v, host } = await setup({ "soil.md": soil }, "soil.md");
    const view = new PropertiesView({ app: v.app } as never, host as never);
    const el = (view as unknown as { contentEl: HTMLElement }).contentEl;
    document.body.appendChild(el);
    await (view as unknown as { open(): Promise<void> }).open();
    const input = el.querySelector("input[type=text]") as HTMLInputElement;
    input.focus();
    input.value = "typing…";
    (view as unknown as { render(): void }).render();
    expect((el.querySelector("input[type=text]") as HTMLInputElement).value).toBe("typing…");
  });

  it("Ontology, Related, Diagnostics, and Report panels draw", async () => {
    const { OntologyView } = await import("../src/semanticViews");
    const { RelatedView } = await import("../src/relations");
    const { DiagnosticsView, ReportView } = await import("../src/views");
    const { FreshnessView } = await import("../src/freshnessView");
    const { JsonLdView } = await import("../src/jsonldView");
    const { GraphView } = await import("../src/graphView");
    const { v, host } = await setup({ "soil.md": soil }, "soil.md");
    for (const View of [OntologyView, RelatedView, DiagnosticsView, ReportView, FreshnessView, JsonLdView, GraphView]) {
      const view = new (View as never as new (l: unknown, h: unknown) => { open(): Promise<void>; contentEl: HTMLElement })({ app: v.app }, host);
      await (view as unknown as { open(): Promise<void> }).open();
      expect(view.contentEl.textContent!.length, View.name).toBeGreaterThan(0);
    }
  });
});

describe("panels do not shadow Obsidian's View internals", () => {
  it("no own property of any panel instance uses an internal View name", async () => {
    const { PropertiesView } = await import("../src/propertiesView");
    const { OntologyView, EntitiesView } = await import("../src/semanticViews");
    const { RelatedView } = await import("../src/relations");
    const { DiagnosticsView, ReportView } = await import("../src/views");
    const { FreshnessView } = await import("../src/freshnessView");
    const { JsonLdView } = await import("../src/jsonldView");
    const { GraphView } = await import("../src/graphView");
    const { v, host } = await setup({ "soil.md": soil }, "soil.md");
    const allowed = new Set(["contentEl", "app", "leaf"]); // set by the base class itself
    for (const View of [PropertiesView, OntologyView, EntitiesView, RelatedView, DiagnosticsView, ReportView, FreshnessView, JsonLdView, GraphView]) {
      const view = new (View as never as new (l: unknown, h: unknown) => object)({ app: v.app }, host);
      const clashes = Object.keys(view).filter((k) => (VIEW_INTERNALS as readonly string[]).includes(k) && !allowed.has(k));
      expect(clashes, View.name).toEqual([]);
    }
  });
});

describe("citation, provenance, and compression panels", () => {
  const read = (f: string) => readFileSync(join(__dirname, "fixtures/citations", f), "utf8");
  type Viewish = { open(): Promise<void>; contentEl: HTMLElement };
  const make = (View: unknown, app: unknown, host: unknown) => new (View as new (l: unknown, h: unknown) => Viewish)({ app }, host);

  it("Related panel leads a compressed concept with its preserved original", async () => {
    const { compress } = await import("../src/engine/compression");
    const { RelatedView } = await import("../src/relations");
    const { rendered } = await import("./support/obsidian-stub");
    const compressed = compress(read("long.md"), new Date("2026-10-08T00:00:00Z"));
    const { v, host } = await setup({ "long.md": compressed, "cited.md": read("cited.md") }, "long.md");
    const view = make(RelatedView, v.app, host);
    await view.open();
    expect(view.contentEl.querySelector(".mif-compressed-badge")?.textContent).toBe("Compressed");
    const details = view.contentEl.querySelector(".mif-compressed-original") as HTMLDetailsElement;
    expect(details.textContent).toContain("Original content (122 lines)");
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    expect(rendered.at(-1)).toMatch(/^# Long runbook\n\nStep 1:/);
  });

  it("Report filters by provenance trust", async () => {
    const { ReportView } = await import("../src/views");
    const { v, host } = await setup({ "uncited.md": read("uncited.md"), "cited.md": read("cited.md") }, "cited.md");
    const view = make(ReportView, v.app, host);
    await view.open();
    const rows = () => [...view.contentEl.querySelectorAll("tbody tr")].map((tr) => tr.children[1]!.textContent);
    expect(rows()).toEqual(["cited.md", "uncited.md"]);
    const trust = [...view.contentEl.querySelectorAll("select")][1] as HTMLSelectElement;
    for (const [value, expected] of [["at-least:user_stated", ["uncited.md"]], ["at-least:verified", []], ["none", ["cited.md"]], ["user_stated", ["uncited.md"]]] as const) {
      trust.value = value;
      trust.dispatchEvent(new Event("change"));
      expect(rows(), value).toEqual(expected);
    }
  });

  it("Properties panel labels the provenance vocabularies and offers section actions", async () => {
    const { PropertiesView } = await import("../src/propertiesView");
    const { v, host } = await setup({ "uncited.md": read("uncited.md"), "cited.md": read("cited.md"), "long.md": read("long.md") }, "uncited.md");
    let view = make(PropertiesView, v.app, host);
    await view.open();
    const options = [...view.contentEl.querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toContain("agent_inferred — AI reasoning from context (0.50–0.69)");
    expect(options).toContain("user_stated — User explicitly provided");
    expect(view.contentEl.textContent).toContain("Write a summary (Identity) to compress.");

    const cited = await setup({ "cited.md": read("cited.md") }, "cited.md");
    view = make(PropertiesView, cited.v.app, cited.host);
    await view.open();
    const buttons = [...view.contentEl.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toContain("Update ## Citations section");
    expect(buttons).toContain("Add author entity…");

    const long = await setup({ "long.md": read("long.md") }, "long.md");
    view = make(PropertiesView, long.v.app, long.host);
    await view.open();
    const compressBtn = [...view.contentEl.querySelectorAll("button")].find((b) => b.textContent === "Compress…") as HTMLButtonElement;
    expect(compressBtn.disabled).toBe(false);
  });
});

describe("reading-view banner placement", () => {
  it("finds the first body section with or without Obsidian's section info", async () => {
    const { isFirstBodySection } = await import("../src/compressionView");
    const text = "---\nid: x\n---\n\n# Title\n\nText.\n";
    const sizer = document.createElement("div");
    document.body.appendChild(sizer);
    const fm = sizer.createDiv({ cls: "el-pre mod-frontmatter mod-ui" });
    const h1 = sizer.createDiv({ cls: "el-h1" });
    const p = sizer.createDiv({ cls: "el-p" });
    expect(isFirstBodySection(h1, { lineStart: 4, text })).toBe(true);
    expect(isFirstBodySection(p, { lineStart: 6, text })).toBe(false);
    expect(isFirstBodySection(fm, null)).toBe(false); // hidden in reading view
    expect(isFirstBodySection(fm, { lineStart: 0, text })).toBe(false);
    expect(isFirstBodySection(h1, null)).toBe(true);
    expect(isFirstBodySection(p, null)).toBe(false);
    expect(isFirstBodySection(document.createElement("div"), null)).toBeUndefined(); // not attached yet
  });
});

describe("JSON-LD and graph panels", () => {
  const rel = (f: string) => readFileSync(join(__dirname, "fixtures/rel", f), "utf8");
  const files = Object.fromEntries(["a.md", "b.md", "d.md", "e.md", "sub/c.md"].map((f) => [f, rel(f)]));
  type Viewish = { open(): Promise<void>; contentEl: HTMLElement };
  const make = (View: unknown, app: unknown, host: unknown) => new (View as new (l: unknown, h: unknown) => Viewish)({ app }, host);

  it("graph draws typed edges with a legend that hides types", async () => {
    const { GraphView } = await import("../src/graphView");
    const { v, host } = await setup(files, "a.md");
    const view = make(GraphView, v.app, host);
    await view.open();
    const el = view.contentEl;
    const edges = () => el.querySelectorAll("line.mif-graph-edge").length;
    expect(el.querySelectorAll("g.mif-graph-node").length).toBeGreaterThan(1);
    expect(el.querySelector("g.mif-graph-node.is-center")).not.toBeNull();
    const before = edges();
    expect(before).toBeGreaterThan(0);
    const legend = [...el.querySelectorAll(".mif-graph-type")] as HTMLElement[];
    expect(legend.length).toBeGreaterThan(0);
    legend[0]!.click();
    expect(edges()).toBeLessThan(before);
    expect(el.querySelector(".mif-graph-type.is-hidden")).not.toBeNull();
  });

  it("JSON-LD panel shows the projection and a lossless round trip", async () => {
    const { JsonLdView } = await import("../src/jsonldView");
    const { v, host } = await setup(files, "a.md");
    const view = make(JsonLdView, v.app, host);
    await view.open();
    expect(view.contentEl.textContent).toContain("Round trip: lossless");
    expect(JSON.parse(view.contentEl.querySelector("pre.mif-jsonld")!.textContent!)["@id"]).toMatch(/^urn:mif:/);
  });
});
