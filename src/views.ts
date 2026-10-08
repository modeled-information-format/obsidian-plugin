// Sidebar views: diagnostics for the active note, and the bundle report.

import { ItemView, MarkdownView, Notice, setIcon, TFile, type WorkspaceLeaf } from "obsidian";

import { TRUST_LEVELS, trustOf, type Diagnostic, type Level, type Severity } from "./engine";
import type { FileAnalysis, MifManager } from "./manager";

export const DIAGNOSTICS_VIEW = "mif-diagnostics";
export const REPORT_VIEW = "mif-report";

const SEVERITY_ICON: Record<Severity, string> = { error: "x-circle", warning: "alert-triangle", info: "info" };

export interface ViewHost {
  manager: MifManager;
  convertActive(): void;
}

/** Open a file and put the cursor on a 0-based line. */
export async function openAtLine(view: ItemView, file: TFile, line?: number): Promise<void> {
  const leaf = view.app.workspace.getLeaf(false);
  await leaf.openFile(file, line === undefined ? undefined : { eState: { line } });
  if (line !== undefined && leaf.view instanceof MarkdownView) {
    const editor = leaf.view.editor;
    editor.setCursor({ line, ch: 0 });
    editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
  }
}

export function levelBadge(parent: HTMLElement, level: Level, isConcept = true): HTMLElement {
  const text = !isConcept ? "–" : level === 0 ? "✗" : `L${level}`;
  return parent.createSpan({ cls: `mif-level mif-level-${isConcept ? level : "none"}`, text });
}

const counts = (ds: Diagnostic[]) => ({
  error: ds.filter((d) => d.severity === "error").length,
  warning: ds.filter((d) => d.severity === "warning").length,
});

// --- diagnostics for the active note ------------------------------------------

export class DiagnosticsView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly host: ViewHost) {
    super(leaf);
  }

  override getViewType() {
    return DIAGNOSTICS_VIEW;
  }
  override getDisplayText() {
    return "MIF diagnostics";
  }
  override getIcon() {
    return "stethoscope";
  }

  override async onOpen() {
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.render()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.render()));
    this.registerEvent(this.host.manager.on("changed", () => this.render()));
    this.render();
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    el.addClass("mif-view");
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      el.createEl("p", { cls: "mif-muted", text: "Open a note to see its MIF diagnostics." });
      return;
    }
    const header = el.createDiv({ cls: "mif-header" });
    header.createEl("h4", { text: file.basename });
    const root = this.host.manager.rootFor(file.path);
    if (root === null) {
      el.createEl("p", { cls: "mif-muted", text: "This note is outside every MIF bundle (see MIF settings)." });
      return;
    }
    const a = this.host.manager.get(file.path);
    if (!a) {
      el.createEl("p", { cls: "mif-muted", text: "Analysing…" });
      return;
    }
    levelBadge(header, a.level, a.isConcept);
    if (!a.isConcept) {
      el.createEl("p", { text: "Not a MIF concept yet: it has no frontmatter." });
      const btn = el.createEl("button", { cls: "mod-cta", text: "Convert to MIF concept" });
      btn.onclick = () => this.host.convertActive();
      return;
    }
    if (a.diagnostics.length === 0) {
      el.createEl("p", { cls: "mif-ok", text: `Level ${a.level}. No issues.` });
      return;
    }
    const list = el.createDiv({ cls: "mif-diagnostics" });
    for (const d of a.diagnostics) this.renderDiagnostic(list, file, d);
  }

  private renderDiagnostic(parent: HTMLElement, file: TFile, d: Diagnostic) {
    const item = parent.createDiv({ cls: `mif-diagnostic mif-${d.severity}` });
    const head = item.createDiv({ cls: "mif-diagnostic-head" });
    setIcon(head.createSpan({ cls: "mif-icon" }), SEVERITY_ICON[d.severity]);
    head.createSpan({ cls: "mif-message", text: d.message });
    if (d.line !== undefined) {
      const loc = head.createEl("a", { cls: "mif-line", text: `line ${d.line + 1}`, href: "#" });
      loc.onclick = (e) => {
        e.preventDefault();
        void openAtLine(this, file, d.line);
      };
    }
    if (d.fixes.length) {
      const fixes = item.createDiv({ cls: "mif-fixes" });
      for (const fix of d.fixes) {
        const b = fixes.createEl("button", { text: fix.label });
        b.onclick = () => void this.host.manager.applyFix(file, fix);
      }
    }
  }
}

// --- bundle report ------------------------------------------------------------

export class ReportView extends ItemView {
  private query = "";
  private level: "all" | Level | "none" = "all";
  private issuesOnly = false;
  /** Provenance trust filter (§12.2): "all", a trust level, "at-least:<level>", or "none". */
  private trust = "all";

  constructor(leaf: WorkspaceLeaf, private readonly host: ViewHost) {
    super(leaf);
  }

  override getViewType() {
    return REPORT_VIEW;
  }
  override getDisplayText() {
    return "MIF bundle report";
  }
  override getIcon() {
    return "list-checks";
  }

  override async onOpen() {
    let timer = 0;
    this.registerEvent(
      this.host.manager.on("changed", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => this.renderTable(), 250);
      }),
    );
    this.renderShell();
  }

  private tableEl?: HTMLElement;
  private summaryEl?: HTMLElement;

  private renderShell() {
    const el = this.contentEl;
    el.empty();
    el.addClass("mif-view");
    this.summaryEl = el.createDiv({ cls: "mif-summary" });
    const controls = el.createDiv({ cls: "mif-controls" });
    const search = controls.createEl("input", { type: "search", placeholder: "Filter by path" });
    search.oninput = () => {
      this.query = search.value.toLowerCase();
      this.renderTable();
    };
    const select = controls.createEl("select");
    for (const [value, label] of [["all", "All levels"], ["0", "Invalid"], ["1", "L1"], ["2", "L2"], ["3", "L3"], ["none", "Not concepts"]]) {
      select.createEl("option", { value: value!, text: label });
    }
    select.onchange = () => {
      this.level = select.value === "all" || select.value === "none" ? select.value : (Number(select.value) as Level);
      this.renderTable();
    };
    const trust = controls.createEl("select");
    trust.createEl("option", { value: "all", text: "Any trust" });
    for (const level of Object.keys(TRUST_LEVELS)) {
      if (level !== "uncertain") trust.createEl("option", { value: `at-least:${level}`, text: `${level} or better` });
    }
    for (const level of Object.keys(TRUST_LEVELS)) trust.createEl("option", { value: level, text: `Only ${level}` });
    trust.createEl("option", { value: "none", text: "No trust level" });
    trust.onchange = () => {
      this.trust = trust.value;
      this.renderTable();
    };
    const issues = controls.createEl("label", { cls: "mif-toggle" });
    const box = issues.createEl("input", { type: "checkbox" });
    issues.appendText(" Issues only");
    box.onchange = () => {
      this.issuesOnly = box.checked;
      this.renderTable();
    };
    const rescan = controls.createEl("button", { text: "Rescan" });
    rescan.onclick = async () => {
      rescan.disabled = true;
      rescan.setText("Rescanning…");
      try {
        const n = await this.host.manager.rescan();
        new Notice(`MIF: rescanned ${n} note${n === 1 ? "" : "s"}.`);
      } finally {
        rescan.disabled = false;
        rescan.setText("Rescan");
      }
    };
    this.tableEl = el.createDiv({ cls: "mif-report" });
    this.renderTable();
  }

  private matches(a: FileAnalysis): boolean {
    if (this.query && !a.path.toLowerCase().includes(this.query)) return false;
    if (this.level === "none" && a.isConcept) return false;
    if (typeof this.level === "number" && (!a.isConcept || a.level !== this.level)) return false;
    if (this.issuesOnly && a.diagnostics.every((d) => d.severity === "info")) return false;
    if (this.trust !== "all") {
      const t = trustOf(a.frontmatter);
      const order = Object.keys(TRUST_LEVELS);
      if (this.trust === "none") return a.isConcept && t === undefined;
      if (this.trust.startsWith("at-least:")) {
        const rank = t === undefined ? -1 : order.indexOf(t);
        return rank !== -1 && rank <= order.indexOf(this.trust.slice("at-least:".length));
      }
      return t === this.trust;
    }
    return true;
  }

  private renderTable() {
    if (!this.tableEl || !this.summaryEl) return;
    const all = this.host.manager.all();
    const concepts = all.filter((a) => a.isConcept);
    const byLevel = [0, 1, 2, 3].map((l) => concepts.filter((a) => a.level === l).length);
    const totals = counts(all.flatMap((a) => a.diagnostics));

    this.summaryEl.empty();
    this.summaryEl.createEl("p", {
      text: `${concepts.length} concepts · L3 ${byLevel[3]} · L2 ${byLevel[2]} · L1 ${byLevel[1]} · invalid ${byLevel[0]} · ${all.length - concepts.length} plain notes · ${totals.error} errors · ${totals.warning} warnings`,
    });
    for (const root of new Set(all.map((a) => a.root))) {
      if (root !== "") {
        this.summaryEl.createEl("p", {
          cls: "mif-warning-text",
          text: `Bundle "${root}" is not at the vault root: relationship targets like /semantic/x.md resolve from the vault root in Obsidian, so its backlinks and graph edges will be missing.`,
        });
      }
      for (const issue of this.host.manager.bundleInfo(root)?.configIssues ?? []) {
        this.summaryEl.createEl("p", { cls: "mif-error-text", text: issue });
      }
    }

    this.tableEl.empty();
    const rows = all.filter((a) => this.matches(a));
    if (rows.length === 0) {
      this.tableEl.createEl("p", { cls: "mif-muted", text: all.length ? "Nothing matches the filters." : "No notes in any MIF bundle." });
      return;
    }
    const table = this.tableEl.createEl("table");
    const head = table.createEl("thead").createEl("tr");
    for (const h of ["Level", "Note", "Type", "Trust", "Errors", "Warnings"]) head.createEl("th", { text: h });
    const body = table.createEl("tbody");
    for (const a of rows) {
      const tr = body.createEl("tr");
      levelBadge(tr.createEl("td"), a.level, a.isConcept);
      const link = tr.createEl("td").createEl("a", { text: a.path, href: "#" });
      link.onclick = (e) => {
        e.preventDefault();
        const file = this.app.vault.getAbstractFileByPath(a.path);
        if (file instanceof TFile) void openAtLine(this, file);
      };
      tr.createEl("td", { text: typeof a.frontmatter?.type === "string" ? a.frontmatter.type : "" });
      tr.createEl("td", { cls: "mif-muted", text: trustOf(a.frontmatter) ?? "" });
      const c = counts(a.diagnostics);
      tr.createEl("td", { cls: c.error ? "mif-error-text" : "", text: String(c.error) });
      tr.createEl("td", { cls: c.warning ? "mif-warning-text" : "", text: String(c.warning) });
    }
  }
}
