// The active concept's JSON-LD projection, live, with its round-trip
// status (Invariant 4) and export.

import { ItemView, Notice, type WorkspaceLeaf } from "obsidian";

import { BUILD_ID } from "./build";
import { roundtripDrift, serializeJsonLd } from "./engine";
import type { MifManager } from "./manager";

export const JSONLD_VIEW = "mif-jsonld";

export interface JsonLdHost {
  manager: MifManager;
}

export class JsonLdView extends ItemView {
  private renderSeq = 0;

  constructor(leaf: WorkspaceLeaf, private readonly host: JsonLdHost) {
    super(leaf);
  }
  override getViewType() {
    return JSONLD_VIEW;
  }
  override getDisplayText() {
    return "MIF JSON-LD";
  }
  override getIcon() {
    return "braces";
  }

  override async onOpen() {
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => void this.render()));
    this.registerEvent(this.app.workspace.on("file-open", () => void this.render()));
    this.registerEvent(this.host.manager.on("changed", () => void this.render()));
    await this.render();
  }

  private async render() {
    const seq = ++this.renderSeq;
    const file = this.app.workspace.getActiveFile();
    const a = file ? this.host.manager.get(file.path) : undefined;
    const text = file && a?.jsonld ? await this.app.vault.cachedRead(file) : undefined;
    if (seq !== this.renderSeq) return; // a newer render started while reading
    const el = this.contentEl;
    el.empty();
    el.addClass("mif-view");
    if (!file || !a?.isConcept) {
      el.createEl("p", { cls: "mif-muted", text: "Open a MIF concept to see its JSON-LD projection." });
      return;
    }
    if (!a.jsonld) {
      el.createEl("p", { cls: "mif-error-text", text: "No projection: fix the errors in the diagnostics panel first." });
      return;
    }
    const json = serializeJsonLd(a.jsonld);
    const drift = text === undefined ? null : roundtripDrift(text, this.host.manager.bundleInfo(a.root)?.namespaces);
    const head = el.createDiv({ cls: "mif-controls" });
    head.createSpan({ cls: drift ? "mif-error-text" : "mif-ok", text: drift ? "Round trip: drift" : "Round trip: lossless" });
    const copy = head.createEl("button", { text: "Copy" });
    copy.onclick = async () => {
      await navigator.clipboard.writeText(json);
      new Notice("MIF: JSON-LD copied.");
    };
    const exp = head.createEl("button", { text: "Export" });
    exp.onclick = async () => {
      const r = await this.host.manager.exportJsonLd(file.path);
      new Notice(r.written ? `MIF: wrote ${r.folder}/… (${r.written} file).` : "MIF: nothing exported.");
    };
    if (drift) el.createEl("pre", { cls: "mif-drift", text: drift });
    el.createEl("pre", { cls: "mif-jsonld" }).createEl("code", { text: json });
    el.createEl("p", { cls: "mif-build", text: `MIF build ${BUILD_ID}` });
  }
}
