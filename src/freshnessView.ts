// The Freshness panel, the bi-temporal header used by the
// Related panel, and freshness dots in the file explorer.

import { ItemView, TFile, type App, type WorkspaceLeaf } from "obsidian";

import { BUILD_ID } from "./build";
import { urgency, type Freshness, type FreshnessState } from "./engine";
import type { MifManager } from "./manager";
import { openAtLine } from "./views";

export const FRESHNESS_VIEW = "mif-freshness";

const LABEL: Record<FreshnessState, string> = {
  fresh: "fresh",
  ageing: "ageing",
  stale: "stale",
  expired: "expired",
  "not-yet-valid": "not yet valid",
  timeless: "no decay",
};

/** "fresh 0.82" / "expired" / "no decay" */
export const freshnessLabel = (f: Freshness) => (f.strength !== undefined && f.state !== "expired" ? `${LABEL[f.state]} ${f.strength.toFixed(2)}` : LABEL[f.state]);

/** Valid-time / transaction-time line and freshness, for the active concept. */
export function renderTimeline(parent: HTMLElement, f: Freshness): void {
  const box = parent.createDiv({ cls: "mif-timeline" });
  const day = (s?: string | null) => (s ? s.slice(0, 10) : "—");
  const valid = box.createDiv();
  valid.createSpan({ cls: "mif-muted", text: "Valid " });
  valid.createSpan({ text: `${day(f.validFrom)} → ${f.validUntil === null || f.validUntil === undefined ? "open" : day(f.validUntil)}` });
  if (f.recordedAt) {
    valid.createSpan({ cls: "mif-muted", text: " · recorded " });
    valid.createSpan({ text: day(f.recordedAt) });
  }
  const fr = box.createDiv();
  fr.createSpan({ cls: `mif-fresh mif-fresh-${f.state}`, text: freshnessLabel(f) });
  fr.createSpan({ cls: "mif-muted", text: ` — ${f.reason}` });
  if (f.expiresAt && f.state !== "expired") fr.createSpan({ cls: "mif-muted", text: ` · expires ${day(f.expiresAt)}` });
}

export interface FreshnessHost {
  manager: MifManager;
}

export class FreshnessView extends ItemView {
  private filter: "attention" | "all" = "attention";
  private lastLogged = "";

  constructor(leaf: WorkspaceLeaf, private readonly host: FreshnessHost) {
    super(leaf);
  }
  override getViewType() {
    return FRESHNESS_VIEW;
  }
  override getDisplayText() {
    return "MIF freshness";
  }
  override getIcon() {
    return "hourglass";
  }

  override async onOpen() {
    let timer = 0;
    this.registerEvent(
      this.host.manager.on("changed", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => this.render(), 250);
      }),
    );
    this.render();
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    el.addClass("mif-view");
    const now = new Date();
    const rows = this.host.manager
      .all()
      .filter((a) => a.isConcept)
      .map((a) => ({ a, f: this.host.manager.freshnessOf(a.path, now)! }))
      .filter(({ f }) => f && (this.filter === "all" || ["expired", "stale", "ageing", "not-yet-valid"].includes(f.state)))
      .sort((x, y) => urgency(x.f, now) - urgency(y.f, now));

    const controls = el.createDiv({ cls: "mif-controls" });
    const sel = controls.createEl("select", { cls: "dropdown" });
    sel.createEl("option", { value: "attention", text: "Needs attention" });
    sel.createEl("option", { value: "all", text: "All concepts" });
    sel.value = this.filter;
    sel.onchange = () => {
      this.filter = sel.value as "attention" | "all";
      this.render();
    };
    const counts = new Map<FreshnessState, number>();
    for (const { f } of rows) counts.set(f.state, (counts.get(f.state) ?? 0) + 1);
    controls.createSpan({ cls: "mif-muted", text: [...counts].map(([s, n]) => `${n} ${LABEL[s]}`).join(" · ") || "Nothing needs attention." });

    const table = el.createDiv({ cls: "mif-report" }).createEl("table");
    const head = table.createEl("tr");
    for (const h of ["Freshness", "Note", "Why", ""]) head.createEl("th", { text: h });
    for (const { a, f } of rows) {
      const tr = table.createEl("tr");
      tr.createEl("td").createSpan({ cls: `mif-fresh mif-fresh-${f.state}`, text: freshnessLabel(f) });
      const link = tr.createEl("td").createEl("a", { text: typeof a.frontmatter?.title === "string" ? a.frontmatter.title : a.path, href: "#" });
      link.onclick = (e) => {
        e.preventDefault();
        const file = this.app.vault.getAbstractFileByPath(a.path);
        if (file instanceof TFile) void openAtLine(this, file);
      };
      tr.createEl("td", { cls: "mif-muted", text: f.reason });
      const actions = tr.createEl("td");
      const fix = a.diagnostics.find((d) => d.code === "freshness-stale" || d.code === "freshness-expired")?.fixes[0];
      if (fix) {
        const b = actions.createEl("button", { text: fix.label.replace(/:.*/, "") });
        b.onclick = () => {
          const file = this.app.vault.getAbstractFileByPath(a.path);
          if (file instanceof TFile) void this.host.manager.applyFix(file, fix);
        };
      }
    }
    el.createEl("p", { cls: "mif-build", text: `MIF build ${BUILD_ID}` });
    const summary = `${this.filter}|${rows.length}|${[...counts].join(",")}`;
    if (summary !== this.lastLogged) {
      this.lastLogged = summary;
      this.host.manager.debug("freshness-panel", { build: BUILD_ID, filter: this.filter, rows: rows.length, counts: Object.fromEntries(counts) });
    }
  }
}

// --- file explorer -----------------------------------------------------------------------

const STATE_CLASSES = ["fresh", "ageing", "stale", "expired", "not-yet-valid", "timeless"].map((s) => `mif-explorer-${s}`);

/**
 * Freshness dots in the file explorer. Obsidian has no public API for
 * this; it uses the explorer view's `fileItems` map and fails quietly if
 * that changes. Returns the number of items decorated.
 */
export function decorateExplorer(app: App, manager: MifManager, enabled: boolean): number {
  let count = 0;
  try {
    const now = new Date();
    for (const leaf of app.workspace.getLeavesOfType("file-explorer")) {
      const items = (leaf.view as unknown as { fileItems?: Record<string, { selfEl?: HTMLElement; el?: HTMLElement }> }).fileItems;
      if (!items) continue;
      for (const [path, item] of Object.entries(items)) {
        const el = item.selfEl ?? item.el;
        if (!el) continue;
        el.classList.remove(...STATE_CLASSES);
        if (!enabled || !path.endsWith(".md")) continue;
        const f = manager.freshnessOf(path, now);
        if (!f || f.state === "timeless") continue;
        el.classList.add(`mif-explorer-${f.state}`);
        el.setAttribute("data-mif-freshness", freshnessLabel(f));
        count++;
      }
    }
  } catch {
    // Undocumented API changed: no dots, nothing else affected.
  }
  return count;
}
