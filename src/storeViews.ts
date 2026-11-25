// Vector store panels (desktop, with mif-cli): which concepts are ingested
// and which changed since, and the relationship gap report.

import { ItemView, Notice, TFile, type WorkspaceLeaf } from "obsidian";

import type { CoverageState } from "./engine";
import { problemText, type GapReport, type MifCli } from "./cliBridge";
import type { MifManager } from "./manager";
import { openAtLine } from "./views";

export const COVERAGE_VIEW = "mif-coverage";
export const GAPS_VIEW = "mif-gaps";

export interface StoreHost {
  manager: MifManager;
  cli: MifCli;
  /** Open the add-relationship dialog for `file` with a target already chosen. */
  editRelationship(file: TFile, index?: number, targetVaultPath?: string): void;
}

/** The bundle a store panel is about: the active note's, else the first. */
function activeRoot(view: ItemView, manager: MifManager): string | undefined {
  const file = view.app.workspace.getActiveFile();
  return (file ? manager.rootFor(file.path) : null) ?? manager.bundleRoots()[0];
}

const STATE_LABEL: Record<CoverageState, string> = { never: "Never ingested", changed: "Changed since ingest", current: "Up to date" };

export class CoverageView extends ItemView {
  private root?: string;
  private busy = false;

  constructor(leaf: WorkspaceLeaf, private readonly host: StoreHost) {
    super(leaf);
  }
  override getViewType() {
    return COVERAGE_VIEW;
  }
  override getDisplayText() {
    return "MIF vector store coverage";
  }
  override getIcon() {
    return "database";
  }

  override async onOpen() {
    let timer = 0;
    const later = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void this.render(), 300);
    };
    this.registerEvent(this.host.manager.on("changed", later));
    this.register(this.host.cli.onChange(later));
    this.register(() => window.clearTimeout(timer));
    await this.render();
  }

  private async render() {
    const el = this.contentEl;
    const why = this.host.cli.unavailable();
    this.root = activeRoot(this, this.host.manager) ?? this.root;
    const root = this.root;
    if (why || root === undefined) {
      el.empty();
      el.addClass("mif-view");
      el.createEl("p", { cls: "mif-muted", text: why ?? "No MIF bundle." });
      return;
    }
    const cov = await this.host.cli.coverage(root);
    el.empty();
    el.addClass("mif-view");
    const count = (s: CoverageState) => cov.rows.filter((r) => r.state === s).length;
    el.createEl("p", { text: `${root || "Vault bundle"}: ${count("current")} up to date · ${count("changed")} changed since ingest · ${count("never")} never ingested` });
    el.createEl("p", { cls: "mif-muted", text: "This lists what the plugin ingested. A note ingested by another tool shows as never ingested until you ingest new and changed notes here: mif-cli skips what its store already holds." });
    const todo = cov.rows.filter((r) => r.state !== "current");
    const run = el.createEl("button", { cls: "mod-cta", text: this.busy ? "Ingesting…" : "Ingest new and changed" });
    run.disabled = this.busy || !cov.rows.length;
    run.onclick = async () => {
      this.busy = true;
      run.disabled = true;
      try {
        const r = await this.host.cli.ingestBundle(root, (done, total) => run.setText(`Ingesting ${done} / ${total}…`));
        new Notice(`MIF: ${r.stored} ingested, ${r.unchanged} already current${r.failed.length ? `, ${r.failed.length} refused` : ""}.`, 8000);
      } finally {
        this.busy = false;
        await this.render();
      }
    };
    if (!todo.length) {
      el.createEl("p", { cls: "mif-ok", text: cov.rows.length ? "Every concept is in the vector store as it stands." : "No concepts in this bundle." });
      return;
    }
    for (const state of ["changed", "never"] as const) {
      const rows = todo.filter((r) => r.state === state).sort((a, b) => a.path.localeCompare(b.path));
      if (!rows.length) continue;
      el.createEl("h5", { text: `${STATE_LABEL[state]} (${rows.length})` });
      for (const r of rows) {
        const row = el.createDiv({ cls: "mif-rel-row" });
        const vaultPath = this.host.manager.toVaultPath(root, r.path);
        const a = row.createEl("a", { text: r.path, href: "#" });
        a.onclick = (e) => {
          e.preventDefault();
          const f = this.app.vault.getAbstractFileByPath(vaultPath);
          if (f instanceof TFile) void openAtLine(this, f);
        };
        if (r.at) row.createSpan({ cls: "mif-muted", text: ` · ingested ${r.at.slice(0, 10)}` });
      }
    }
  }
}

export class GapsView extends ItemView {
  private report?: GapReport;
  private root?: string;
  private message = "";
  private busy = false;

  constructor(leaf: WorkspaceLeaf, private readonly host: StoreHost) {
    super(leaf);
  }
  override getViewType() {
    return GAPS_VIEW;
  }
  override getDisplayText() {
    return "MIF relationship gaps";
  }
  override getIcon() {
    return "unlink";
  }

  override async onOpen() {
    this.render();
  }

  private async compare(root: string) {
    this.busy = true;
    this.message = "Comparing…";
    this.render();
    try {
      const r = await this.host.cli.gaps(root, (done, total) => {
        this.message = `Comparing ${done} / ${total}…`;
        this.contentEl.querySelector(".mif-gaps-status")?.setText(this.message);
      });
      if ("compared" in r) {
        this.report = r;
        this.root = root;
        this.message = "";
      } else this.message = problemText(r) ?? "";
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    el.addClass("mif-view");
    const why = this.host.cli.unavailable();
    const root = activeRoot(this, this.host.manager);
    if (why || root === undefined) {
      el.createEl("p", { cls: "mif-muted", text: why ?? "No MIF bundle." });
      return;
    }
    const s = this.host.manager.similarity();
    el.createEl("p", { cls: "mif-muted", text: `Compares every ingested concept of ${root || "the vault bundle"} with every other, one mif-cli run per concept. Thresholds (Settings → MIF): similar at ${s.similar} or above, mislink at ${s.mislink} or below.` });
    const run = el.createEl("button", { cls: "mod-cta", text: this.report ? "Compare again" : "Compare" });
    run.disabled = this.busy;
    run.onclick = () => void this.compare(root);
    el.createEl("p", { cls: "mif-gaps-status mif-muted", text: this.message });
    const report = this.report;
    if (!report || this.root !== root) return;
    const open = (path: string | undefined) => {
      const f = path ? this.app.vault.getAbstractFileByPath(path) : null;
      if (f instanceof TFile) void openAtLine(this, f);
    };
    const name = (path: string | undefined, id: string) => (path ? (this.host.manager.titleAt(path) ?? path) : id);
    const pair = (row: HTMLElement, p: GapReport["unlinked"][number]) => {
      row.createSpan({ cls: "mif-muted", text: p.cosine.toFixed(2) });
      for (const [path, id] of [[p.aPath, p.a], [p.bPath, p.b]] as const) {
        const a = row.createEl("a", { text: name(path, id), href: "#" });
        a.onclick = (e) => {
          e.preventDefault();
          open(path);
        };
      }
    };
    el.createEl("h5", { text: `Similar, not related (${report.unlinked.length})` });
    if (!report.unlinked.length) el.createEl("p", { cls: "mif-muted", text: "None." });
    for (const p of report.unlinked) {
      const row = el.createDiv({ cls: "mif-rel-row mif-gap-row" });
      pair(row, p);
      const add = row.createSpan({ cls: "mif-row-actions" }).createEl("a", { text: "Add relationship", href: "#" });
      add.onclick = (e) => {
        e.preventDefault();
        const f = p.aPath ? this.app.vault.getAbstractFileByPath(p.aPath) : null;
        if (f instanceof TFile) this.host.editRelationship(f, undefined, p.bPath);
      };
    }
    el.createEl("h5", { text: `Related, not similar (${report.mislinks.length})` });
    if (!report.mislinks.length) el.createEl("p", { cls: "mif-muted", text: "None." });
    for (const p of report.mislinks) pair(el.createDiv({ cls: "mif-rel-row mif-gap-row" }), p);
    el.createEl("p", { cls: "mif-muted", text: `${report.compared} concepts compared. Concepts that are not ingested are left out; see the coverage panel.` });
  }
}
