// An Obsidian Bases view ("MIF table"). Bases filters, sorts, and
// groups notes by their properties; this view adds the values MIF computes
// live and never writes to frontmatter: level, freshness, trust, issues.

import { BasesView, type QueryController } from "obsidian";

import type { MifApi } from "./api";
import { freshnessLabel } from "./freshnessView";
import type { MifManager } from "./manager";

export const BASES_VIEW = "mif-table";

export class MifBasesView extends BasesView {
  readonly type = BASES_VIEW;

  constructor(controller: QueryController, private readonly containerEl: HTMLElement, private readonly api: MifApi, private readonly manager: MifManager) {
    super(controller);
  }

  override onDataUpdated(): void {
    const el = this.containerEl;
    el.empty();
    el.addClass("mif-view", "mif-bases");
    const props = this.data.properties.filter((p) => p !== "file.name");
    const table = el.createDiv({ cls: "mif-report" }).createEl("table");
    const head = table.createEl("thead").createEl("tr");
    for (const h of ["Note", ...props.map((p) => this.config.getDisplayName(p)), "MIF level", "Freshness", "Trust", "Issues"]) head.createEl("th", { text: h });
    const body = table.createEl("tbody");
    let rows = 0;
    for (const group of this.data.groupedData) {
      if (group.hasKey()) body.createEl("tr", { cls: "mif-bases-group" }).createEl("td", { text: group.key?.toString() ?? "", attr: { colspan: String(props.length + 5) } });
      for (const entry of group.entries) {
        rows++;
        const tr = body.createEl("tr");
        const link = tr.createEl("td").createEl("a", { text: entry.file.basename, href: "#" });
        link.onclick = (e) => {
          e.preventDefault();
          void this.app.workspace.getLeaf(false).openFile(entry.file);
        };
        for (const p of props) tr.createEl("td", { text: entry.getValue(p)?.toString() ?? "" });
        const info = this.api.concept(entry.file.path);
        if (!info) {
          tr.createEl("td", { cls: "mif-muted", text: "—" });
          tr.createEl("td");
          tr.createEl("td");
          tr.createEl("td");
          continue;
        }
        tr.createEl("td").createSpan({ cls: `mif-level mif-level-${info.level}`, text: info.level === 0 ? "✗" : `L${info.level}` });
        const f = this.manager.freshnessOf(entry.file.path);
        tr.createEl("td").createSpan({ cls: f ? `mif-fresh mif-fresh-${f.state}` : "", text: f && f.state !== "timeless" ? freshnessLabel(f) : "" });
        tr.createEl("td", { cls: "mif-muted", text: info.trust ?? "" });
        tr.createEl("td", { cls: info.errors ? "mif-error-text" : info.warnings ? "mif-warning-text" : "mif-muted", text: info.errors || info.warnings ? `${info.errors}✗ ${info.warnings}⚠` : "" });
      }
    }
    if (!rows) el.createEl("p", { cls: "mif-muted", text: "No notes match this base." });
  }
}
