// Typed relationship graph. Edges are coloured by relationship type
// (with a legend that toggles types), nodes by concept type; local mode shows
// the active concept's neighbourhood. SVG, brand colours from styles.css.
// Note: Obsidian's createSvg passes `cls` straight to classList.add, so
// several classes must be an array (unlike createEl, which splits strings).

import { ItemView, TFile, type WorkspaceLeaf } from "obsidian";

import { graphOf, layout, type Graph } from "./engine";
import type { MifManager } from "./manager";

export const GRAPH_VIEW = "mif-graph";
const SLOTS = 8; // --mif-graph-1 … --mif-graph-8

export interface GraphHost {
  manager: MifManager;
}

export class GraphView extends ItemView {
  // Not `scope`: that is a View internal (keyboard scope).
  private reach: "local" | "bundle" = "local";
  private depth = 2;
  private hidden = new Set<string>();
  private lastKey = "";

  constructor(leaf: WorkspaceLeaf, private readonly host: GraphHost) {
    super(leaf);
  }
  override getViewType() {
    return GRAPH_VIEW;
  }
  override getDisplayText() {
    return "MIF graph";
  }
  override getIcon() {
    return "waypoints";
  }

  override async onOpen() {
    let timer = 0;
    const later = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => this.render(), 200);
    };
    this.registerEvent(this.app.workspace.on("file-open", later));
    this.registerEvent(this.host.manager.on("changed", later));
    this.render();
  }

  /** Current graph, before layout (exposed for tests). */
  graph(): { graph: Graph; root: string; center?: string } | undefined {
    const file = this.app.workspace.getActiveFile();
    const ctx = file ? this.host.manager.indexFor(file.path) : undefined;
    const root = ctx?.info.root ?? this.host.manager.bundleRoots()[0] ?? "";
    const index = ctx?.index ?? this.host.manager.bundleInfo(root)?.index;
    if (!index) return undefined;
    const center = this.reach === "local" ? ctx?.bundlePath : undefined;
    const all = graphOf(index, { center, depth: this.depth });
    const types = new Set(all.types.filter((t) => !this.hidden.has(t)));
    const graph = graphOf(index, { center, depth: this.depth, types });
    return { graph: { ...graph, types: all.types }, root, center };
  }

  private render() {
    // Never leave the panel blank: show and log any drawing error (as the Properties panel does).
    try {
      this.draw();
    } catch (err) {
      const e = err as Error;
      this.lastKey = "";
      this.contentEl.createEl("p", { cls: "mif-error-text", text: `MIF graph failed: ${e.message}` });
      this.host.manager.debug("graph-error", { message: e.message, stack: e.stack?.split("\n").slice(0, 8) });
    }
  }

  private draw() {
    const g = this.graph();
    const key = JSON.stringify([this.reach, this.depth, [...this.hidden], g?.center, g?.graph.nodes.map((n) => n.id), g?.graph.edges.map((e) => `${e.from}>${e.type}>${e.to}`)]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const el = this.contentEl;
    el.empty();
    el.addClass("mif-view", "mif-graph-view");

    const controls = el.createDiv({ cls: "mif-controls" });
    const reachSel = controls.createEl("select", { cls: "dropdown" });
    reachSel.createEl("option", { value: "local", text: "Around this note" });
    reachSel.createEl("option", { value: "bundle", text: "Whole bundle" });
    reachSel.value = this.reach;
    reachSel.onchange = () => {
      this.reach = reachSel.value as "local" | "bundle";
      this.render();
    };
    if (this.reach === "local") {
      const depth = controls.createEl("select", { cls: "dropdown" });
      for (const d of [1, 2, 3]) depth.createEl("option", { value: String(d), text: `${d} hop${d > 1 ? "s" : ""}` });
      depth.value = String(this.depth);
      depth.onchange = () => {
        this.depth = Number(depth.value);
        this.render();
      };
    }
    if (!g) {
      el.createEl("p", { cls: "mif-muted", text: "No MIF bundle is loaded." });
      return;
    }
    const { graph, root, center } = g;
    if (this.reach === "local" && !center) {
      el.createEl("p", { cls: "mif-muted", text: "Open a MIF concept to see its neighbourhood, or show the whole bundle." });
      return;
    }

    // Legend: one swatch per relationship type; click to hide / show.
    const legend = el.createDiv({ cls: "mif-graph-legend" });
    graph.types.forEach((t, i) => {
      const item = legend.createSpan({ cls: `mif-graph-type${this.hidden.has(t) ? " is-hidden" : ""}` });
      item.createSpan({ cls: `mif-graph-swatch mif-graph-c${(i % SLOTS) + 1}` });
      item.appendText(t);
      item.onclick = () => {
        if (this.hidden.has(t)) this.hidden.delete(t);
        else this.hidden.add(t);
        this.render();
      };
    });

    layout(graph, { size: 1000, iterations: graph.nodes.length > 300 ? 120 : 300 });
    const slot = new Map(graph.types.map((t, i) => [t, (i % SLOTS) + 1]));
    const svg = el.createSvg("svg", { cls: "mif-graph" });
    const pad = 80;
    const xs = graph.nodes.map((n) => n.x);
    const ys = graph.nodes.map((n) => n.y);
    const box = { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + 2 * pad, h: Math.max(...ys) - Math.min(...ys) + 2 * pad };
    const view = { ...box };
    // Labels, dots, and lines keep a constant on-screen size at any zoom:
    // --mif-graph-scale is graph units per screen pixel.
    const apply = () => {
      svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
      const px = svg.clientWidth || svg.getBoundingClientRect?.().width || 0;
      const scale = px > 0 ? Math.max(view.w / px, view.h / (svg.clientHeight || px)) : 1;
      svg.style.setProperty("--mif-graph-scale", String(scale));
    };
    apply();

    const defs = svg.createSvg("defs");
    for (let i = 1; i <= SLOTS; i++) {
      const m = defs.createSvg("marker", { attr: { id: `mif-arrow-${i}`, viewBox: "0 0 10 10", refX: "18", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" } });
      m.createSvg("path", { attr: { d: "M 0 0 L 10 5 L 0 10 z" }, cls: ["mif-graph-fill", `mif-graph-c${i}`] });
    }
    const pos = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const e of graph.edges) {
      const a = pos.get(e.from)!;
      const b = pos.get(e.to)!;
      const line = svg.createSvg("line", { cls: ["mif-graph-edge", `mif-graph-c${slot.get(e.type)}`], attr: { x1: String(a.x), y1: String(a.y), x2: String(b.x), y2: String(b.y), "marker-end": `url(#mif-arrow-${slot.get(e.type)})` } });
      line.createSvg("title").textContent = `${a.label} — ${e.type} → ${b.label}`;
    }
    for (const n of graph.nodes) {
      const node = svg.createSvg("g", { cls: ["mif-graph-node", `mif-graph-${n.conceptType ?? "none"}`, ...(n.id === center ? ["is-center"] : [])], attr: { transform: `translate(${n.x} ${n.y})` } });
      // A transparent, larger hit target: the dot alone is hard to click.
      node.createSvg("circle", { cls: "mif-graph-hit" });
      node.createSvg("circle", { cls: n.id === center ? "is-center" : [] });
      node.createSvg("text").textContent = n.label;
      // A click (not the end of a drag) opens the concept in the main editor;
      // openLinkText picks the main area even though the graph is in a sidebar.
      node.addEventListener("pointerdown", (ev) => ev.stopPropagation());
      node.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const path = this.host.manager.toVaultPath(root, n.id);
        const f = this.app.vault.getAbstractFileByPath(path);
        this.host.manager.debug("graph-click", { path, found: f instanceof TFile });
        if (f instanceof TFile) void this.app.workspace.openLinkText(f.path, "", false);
      });
    }

    // Pan with drag, zoom with the wheel.
    let drag: { x: number; y: number } | undefined;
    svg.addEventListener("pointerdown", (ev) => (drag = { x: ev.clientX, y: ev.clientY }));
    svg.addEventListener("pointerup", () => (drag = undefined));
    svg.addEventListener("pointerleave", () => (drag = undefined));
    svg.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      const scale = view.w / Math.max(svg.clientWidth, 1);
      view.x -= (ev.clientX - drag.x) * scale;
      view.y -= (ev.clientY - drag.y) * scale;
      drag = { x: ev.clientX, y: ev.clientY };
      apply();
    });
    svg.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const f = ev.deltaY > 0 ? 1.15 : 1 / 1.15;
      view.x += (view.w * (1 - f)) / 2;
      view.y += (view.h * (1 - f)) / 2;
      view.w *= f;
      view.h *= f;
      apply();
    }, { passive: false });

    // Sizes depend on the rendered width, known only once the panel is laid
    // out. Then widen the right margin so the longest label is not clipped
    // (labels are ~7 screen px per character at 12px).
    window.requestAnimationFrame(() => {
      apply();
      const scale = Number(svg.style.getPropertyValue("--mif-graph-scale")) || 1;
      const longest = Math.max(...graph.nodes.map((n) => n.label.length), 0);
      const extra = Math.max(0, (longest * 7 + 16) * scale - pad);
      if (extra > 0) {
        view.w += extra;
        view.h *= view.w / (view.w - extra);
        view.y -= (view.h - (view.h * (view.w - extra)) / view.w) / 2;
        apply();
      }
    });
    this.registerDomEvent(window, "resize", apply);
    el.createEl("p", { cls: "mif-muted", text: `${graph.nodes.length} concepts · ${graph.edges.length} relationships · drag to pan, scroll to zoom, click a concept to open it` });
    this.host.manager.debug("graph", { reach: this.reach, root, center: center ?? null, nodes: graph.nodes.length, edges: graph.edges.length, viewBox: svg.getAttribute("viewBox"), svgChildren: svg.childElementCount });
  }
}
