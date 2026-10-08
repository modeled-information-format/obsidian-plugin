// Relationships UI: the Related side panel, the add/edit dialog with a
// fuzzy target picker, and the MIF 0.1 migration preview.

import { FuzzySuggestModal, ItemView, Modal, Notice, Setting, TFile, type App, type WorkspaceLeaf } from "obsidian";

import { incomingLabel, relativeTarget, titleOf, type BundleConcept, type Edge, type RelType } from "./engine";
import type { MifManager } from "./manager";
import { renderTimeline } from "./freshnessView";
import { openAtLine } from "./views";

export const RELATED_VIEW = "mif-related";

export interface RelationsHost {
  manager: MifManager;
  editRelationship(file: TFile, index?: number): void;
}

const label = (c: BundleConcept | undefined, fallback: string) => titleOf(c) ?? fallback;

// --- Related panel ---------------------------------------------------------------

export class RelatedView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly host: RelationsHost) {
    super(leaf);
  }

  override getViewType() {
    return RELATED_VIEW;
  }
  override getDisplayText() {
    return "MIF related";
  }
  override getIcon() {
    return "git-fork";
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
    const ctx = file ? this.host.manager.indexFor(file.path) : undefined;
    if (!file || !ctx) {
      el.createEl("p", { cls: "mif-muted", text: "Open a MIF concept to see its relationships." });
      return;
    }
    const { index, bundlePath, info } = ctx;
    const concept = index.concepts.get(bundlePath);
    const header = el.createDiv({ cls: "mif-header" });
    header.createEl("h4", { text: label(concept, file.basename) });
    if (!concept) {
      el.createEl("p", { cls: "mif-muted", text: "Not a MIF concept yet." });
      return;
    }
    const add = header.createEl("button", { text: "Add", cls: "mod-cta" });
    add.onclick = () => this.host.editRelationship(file);

    // Bi-temporal timeline and supersede / conflict notices.
    const fresh = this.host.manager.freshnessOf(file.path);
    if (fresh) renderTimeline(el, fresh);
    for (const d of this.host.manager.get(file.path)?.diagnostics ?? []) {
      if (d.code === "superseded" || d.code === "conflict") {
        el.createDiv({ cls: `mif-banner mif-banner-${d.code}`, text: d.message });
      }
    }

    const open = (path: string | undefined) => {
      if (!path) return;
      const f = this.app.vault.getAbstractFileByPath(this.host.manager.toVaultPath(info.root, path));
      if (f instanceof TFile) void openAtLine(this, f);
    };

    const outgoing = index.outgoing.get(bundlePath) ?? [];
    this.section(el, "Outgoing", outgoing, (e) => e.type, (row, e) => {
      this.target(row, e, index.concepts.get(e.resolved ?? ""), () => open(e.resolved));
      const actions = row.createSpan({ cls: "mif-row-actions" });
      actions.createEl("a", { text: "edit", href: "#" }).onclick = (ev) => {
        ev.preventDefault();
        this.host.editRelationship(file, e.index);
      };
      actions.createEl("a", { text: "remove", href: "#" }).onclick = (ev) => {
        ev.preventDefault();
        void this.host.manager.removeRelationship(file, e.index);
      };
    });

    const incoming = index.incoming.get(bundlePath) ?? [];
    this.section(el, "Incoming", incoming, (e) => incomingLabel(e.type, info.registry), (row, e) => {
      const source = index.concepts.get(e.from);
      const a = row.createEl("a", { text: label(source, e.from), href: "#" });
      a.onclick = (ev) => {
        ev.preventDefault();
        open(e.from);
      };
      if (e.strength !== undefined) row.createSpan({ cls: "mif-muted", text: ` · ${e.strength}` });
    });

    if (!outgoing.length && !incoming.length) el.createEl("p", { cls: "mif-muted", text: "No relationships yet." });
  }

  private section(parent: HTMLElement, title: string, edges: Edge[], groupBy: (e: Edge) => string, row: (el: HTMLElement, e: Edge) => void) {
    if (!edges.length) return;
    parent.createEl("h5", { text: `${title} (${edges.length})` });
    const groups = new Map<string, Edge[]>();
    for (const e of edges) groups.set(groupBy(e), [...(groups.get(groupBy(e)) ?? []), e]);
    for (const [type, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const g = parent.createDiv({ cls: "mif-rel-group" });
      g.createDiv({ cls: "mif-rel-type", text: type });
      for (const e of list) row(g.createDiv({ cls: "mif-rel-row" }), e);
    }
  }

  private target(row: HTMLElement, e: Edge, c: BundleConcept | undefined, open: () => void) {
    if (e.resolved) {
      const a = row.createEl("a", { text: label(c, e.target), href: "#" });
      a.onclick = (ev) => {
        ev.preventDefault();
        open();
      };
    } else {
      const broken = e.kind === "path" || e.kind === "concept-urn";
      row.createSpan({ cls: broken ? "mif-error-text" : "mif-muted", text: e.target });
      if (broken) row.createSpan({ cls: "mif-error-text", text: " (missing)" });
    }
    if (e.strength !== undefined) row.createSpan({ cls: "mif-muted", text: ` · ${e.strength}` });
  }
}

// --- add / edit dialog --------------------------------------------------------------

export interface RelationshipDraft {
  type: string;
  /** Bundle path of the chosen target concept. */
  targetPath?: string;
  /** Raw target as written (used when editing a target that is not a concept). */
  rawTarget?: string;
  style: "path" | "relative" | "id";
  strength?: number;
}

class ConceptPicker extends FuzzySuggestModal<BundleConcept> {
  constructor(app: App, private readonly concepts: BundleConcept[], private readonly onPick: (c: BundleConcept) => void) {
    super(app);
    this.setPlaceholder("Find a concept by title, alias, or path");
  }
  getItems() {
    return this.concepts;
  }
  getItemText(c: BundleConcept) {
    const aliases = Array.isArray(c.frontmatter.aliases) ? ` (${(c.frontmatter.aliases as unknown[]).join(", ")})` : "";
    return `${titleOf(c) ?? c.path}${aliases} — ${c.path}`;
  }
  onChooseItem(c: BundleConcept) {
    this.onPick(c);
  }
}

export class RelationshipModal extends Modal {
  constructor(
    app: App,
    private readonly types: RelType[],
    private readonly concepts: BundleConcept[],
    private readonly sourcePath: string,
    private readonly draft: RelationshipDraft,
    private readonly onSubmit: (type: string, target: string, strength?: number) => Promise<void>,
  ) {
    super(app);
  }

  override onOpen() {
    this.setTitle(this.draft.rawTarget || this.draft.targetPath ? "Edit relationship" : "Add relationship");
    const d = this.draft;
    new Setting(this.contentEl).setName("Type").addDropdown((dd) => {
      for (const t of this.types) dd.addOption(t.token, t.core ? t.token : `${t.token} (custom)`);
      if (!this.types.some((t) => t.token === d.type)) dd.addOption(d.type, `${d.type} (undeclared)`);
      dd.setValue(d.type).onChange((v) => (d.type = v));
    });

    const targetSetting = new Setting(this.contentEl).setName("Target");
    const describe = () => {
      const c = this.concepts.find((x) => x.path === d.targetPath);
      targetSetting.setDesc(c ? `${titleOf(c) ?? c.path} — ${c.path}` : d.rawTarget ? d.rawTarget : "None chosen");
    };
    describe();
    targetSetting.addButton((b) =>
      b.setButtonText("Choose…").onClick(() =>
        new ConceptPicker(this.app, this.concepts.filter((c) => c.path !== this.sourcePath), (c) => {
          d.targetPath = c.path;
          d.rawTarget = undefined;
          describe();
        }).open(),
      ),
    );

    new Setting(this.contentEl)
      .setName("Write target as")
      .setDesc("Bundle path is the MIF default. An id survives moves without rewriting, but Obsidian will not show it as a backlink.")
      .addDropdown((dd) =>
        dd
          .addOptions({ path: "Bundle path (/folder/note.md)", relative: "Relative path", id: "Concept id (urn:mif:…)" })
          .setValue(d.style)
          .onChange((v) => (d.style = v as RelationshipDraft["style"])),
      );

    new Setting(this.contentEl)
      .setName("Strength")
      .setDesc("Optional, 0 to 1.")
      .addText((t) =>
        t.setPlaceholder("e.g. 0.8").setValue(d.strength === undefined ? "" : String(d.strength)).onChange((v) => {
          const n = Number(v);
          d.strength = v.trim() === "" || Number.isNaN(n) ? undefined : Math.min(1, Math.max(0, n));
        }),
      );

    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Save").setCta().onClick(async () => {
        const target = this.renderTarget();
        if (!target) {
          new Notice("Choose a target concept.");
          return;
        }
        await this.onSubmit(d.type, target, d.strength);
        this.close();
      }),
    );
  }

  private renderTarget(): string | undefined {
    const d = this.draft;
    if (!d.targetPath) return d.rawTarget;
    if (d.style === "id") {
      const id = this.concepts.find((c) => c.path === d.targetPath)?.frontmatter.id;
      if (typeof id === "string") return `urn:mif:${id}`;
    }
    return d.style === "relative" ? relativeTarget(this.sourcePath, d.targetPath) : `/${d.targetPath}`;
  }

  override onClose() {
    this.contentEl.empty();
  }
}

// --- migration preview --------------------------------------------------------------

export class MigrationModal extends Modal {
  constructor(app: App, private readonly manager: MifManager, private readonly files: TFile[]) {
    super(app);
  }

  override onOpen() {
    this.setTitle("Migrate MIF 0.1 notes");
    const { contentEl } = this;
    if (!this.files.length) {
      contentEl.createEl("p", { text: "No MIF 0.1 notes found in your bundles." });
      return;
    }
    contentEl.createEl("p", {
      text: `${this.files.length} note${this.files.length > 1 ? "s" : ""} will get UUID ids (old ids kept as aliases), markdown-link relationships with matching frontmatter, 1.0 field names, and \`.memory.md\` names shortened to \`.md\`.`,
    });
    const list = contentEl.createEl("ul", { cls: "mif-migration-list" });
    for (const f of this.files) {
      const a = this.manager.get(f.path);
      list.createEl("li", { text: `${f.path}${a?.legacy?.slugId ? ` (id ${String(a.frontmatter?.id)})` : ""}` });
    }
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Migrate").setCta().onClick(async () => {
        b.setDisabled(true);
        let done = 0;
        for (const f of this.files) if (await this.manager.migrate(f)) done++;
        new Notice(`MIF: migrated ${done} of ${this.files.length} notes.`);
        this.close();
      }),
    );
  }

  override onClose() {
    this.contentEl.empty();
  }
}
