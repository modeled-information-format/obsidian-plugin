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
    const { v, host } = await setup({ "soil.md": soil }, "soil.md");
    for (const View of [OntologyView, RelatedView, DiagnosticsView, ReportView]) {
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
    const { v, host } = await setup({ "soil.md": soil }, "soil.md");
    const allowed = new Set(["contentEl", "app", "leaf"]); // set by the base class itself
    for (const View of [PropertiesView, OntologyView, EntitiesView, RelatedView, DiagnosticsView, ReportView]) {
      const view = new (View as never as new (l: unknown, h: unknown) => object)({ app: v.app }, host);
      const clashes = Object.keys(view).filter((k) => (VIEW_INTERNALS as readonly string[]).includes(k) && !allowed.has(k));
      expect(clashes, View.name).toEqual([]);
    }
  });
});
