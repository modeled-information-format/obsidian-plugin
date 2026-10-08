// The Ontology panel (active concept's ontology chain, namespace,
// entity type with composed trait fields, discovery suggestions), the
// Entities panel, and the add-entity-reference dialog.

import { FuzzySuggestModal, ItemView, Modal, Notice, Setting, TFile, type App, type WorkspaceLeaf } from "obsidian";

import {
  scalarText,
  chainTraits,
  composeTraits,
  entityReference,
  entitySlug,
  entityUrn,
  visibleNamespaces,
  visibleTypes,
  type EntityRecord,
  usefulSuggestions,
} from "./engine";
import { BUILD_ID } from "./build";
import type { MifManager } from "./manager";
import { openAtLine } from "./views";

export const ONTOLOGY_VIEW = "mif-ontology";
export const ENTITIES_VIEW = "mif-entities";

export interface SemanticHost {
  manager: MifManager;
  addEntityReference(file: TFile): void;
}

// --- Ontology panel -------------------------------------------------------------------

export class OntologyView extends ItemView {
  private showAllSuggestions = false;
  private lastLogged = "";
  constructor(leaf: WorkspaceLeaf, private readonly host: SemanticHost) {
    super(leaf);
  }
  override getViewType() {
    return ONTOLOGY_VIEW;
  }
  override getDisplayText() {
    return "MIF ontology";
  }
  override getIcon() {
    return "network";
  }
  override async onOpen() {
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.render()));
    this.registerEvent(this.app.workspace.on("file-open", () => {
      this.showAllSuggestions = false;
      this.render();
    }));
    this.registerEvent(this.host.manager.on("changed", () => this.render()));
    this.render();
  }

  private render() {
    const el = this.contentEl;
    el.empty();
    el.addClass("mif-view");
    const file = this.app.workspace.getActiveFile();
    const a = file ? this.host.manager.get(file.path) : undefined;
    const report = file ? this.host.manager.semantic(file.path) : undefined;
    const info = a ? this.host.manager.bundleInfo(a.root) : undefined;
    if (!file || !a?.isConcept || !info) {
      el.createEl("p", { cls: "mif-muted", text: "Open a MIF concept to see its ontology." });
      return;
    }
    const fm = a.frontmatter ?? {};
    el.createEl("h4", { text: typeof fm.title === "string" ? fm.title : file.basename });

    // Ontology and chain
    const sec = (title: string) => el.createEl("h5", { text: title });
    sec("Ontology");
    if (!report?.ontologyId) {
      el.createEl("p", { cls: "mif-muted", text: "None declared." });
    } else {
      const p = el.createEl("p");
      p.createSpan({ cls: "mif-rel-type", text: report.ontologyId });
      p.appendText(report.declared ? " (declared)" : " (default, for namespace hints)");
      if (report.chain) {
        const ul = el.createEl("ul", { cls: "mif-chain" });
        for (const d of report.chain) {
          const li = ul.createEl("li", { text: `${d.id} ${d.version}` });
          li.createSpan({ cls: "mif-muted", text: ` — ${d.source}` });
        }
      }
    }

    // Namespace
    sec("Namespace");
    const ns = typeof fm.namespace === "string" ? fm.namespace : undefined;
    el.createEl("p", { text: ns ?? "None.", cls: ns ? "" : "mif-muted" });
    if (report?.ontologyId && info.corpus.has(report.ontologyId) && ns) {
      const declared = visibleNamespaces(report.ontologyId, info.corpus);
      const node = declared.get(ns) ?? declared.get(ns.startsWith("_") ? ns.slice(1) : `_${ns}`);
      if (node?.description) el.createEl("p", { cls: "mif-muted", text: node.description });
    }

    // Entity type
    const entity = fm.entity && typeof fm.entity === "object" ? (fm.entity as Record<string, unknown>) : undefined;
    const entityType = typeof entity?.entity_type === "string" ? entity.entity_type : undefined;
    sec("Entity type");
    if (!entityType) {
      el.createEl("p", { cls: "mif-muted", text: "Not typed." });
    } else if (!report?.declared || !report.chain) {
      el.createEl("p", { text: `${entityType} (not checked: no declared ontology)` });
    } else {
      const def = visibleTypes(report.ontologyId!, info.corpus).get(entityType);
      if (!def) {
        el.createEl("p", { cls: "mif-warning-text", text: `${entityType} is not defined by this ontology chain.` });
      } else {
        el.createEl("p", { text: `${entityType} — ${def.base}, from ${def.ontology}` });
        if (def.description) el.createEl("p", { cls: "mif-muted", text: def.description });
        const composed = composeTraits(def, chainTraits(report.chain));
        if (composed.fields.size) {
          const table = el.createEl("table", { cls: "mif-fields" });
          const head = table.createEl("tr");
          for (const h of ["Field", "Type", "From", "Present"]) head.createEl("th", { text: h });
          const required = new Set(def.schema?.required ?? []);
          for (const [name, f] of [...composed.fields].sort(([x], [y]) => x.localeCompare(y))) {
            const tr = table.createEl("tr");
            tr.createEl("td", { text: required.has(name) ? `${name} *` : name });
            tr.createEl("td", { text: String(f.schema.type ?? "") });
            tr.createEl("td", { cls: "mif-muted", text: f.origin });
            tr.createEl("td", { text: entity && name in entity ? "✓" : "" });
          }
        }
        for (const c of composed.conflicts) el.createEl("p", { cls: "mif-warning-text", text: `Conflict on ${c.field}: ${c.definitions.map((d) => d.origin).join(" vs ")}` });
        for (const t of composed.unresolved) el.createEl("p", { cls: "mif-warning-text", text: `Unresolved trait: ${t}` });
      }
    }

    // Entities referenced
    sec("Entities");
    const refs = Array.isArray(fm.entities) ? (fm.entities as Array<Record<string, unknown>>) : [];
    if (!refs.length) el.createEl("p", { cls: "mif-muted", text: "None referenced." });
    for (const r of refs) {
      const urn = scalarText((r.entity as Record<string, unknown> | undefined)?.["@id"] ?? "");
      const known = info.entities.get(urn);
      const row = el.createDiv({ cls: "mif-rel-row" });
      row.createSpan({ text: known?.name ?? (typeof r.name === "string" ? r.name : urn) });
      if (typeof r.role === "string") row.createSpan({ cls: "mif-muted", text: ` · ${r.role}` });
      if (!known) row.createSpan({ cls: "mif-muted", text: " (no entity file)" });
    }
    const add = el.createEl("button", { text: "Add entity reference" });
    add.onclick = () => this.host.addEntityReference(file);

    // Discovery: only what would change something, and only when the concept
    // still lacks a namespace or entity type (or the user asks to see more).
    const { hits: useful, collapsed: complete } = usefulSuggestions(report?.discovery ?? [], ns, entityType);
    if (useful.length && (!complete || this.showAllSuggestions)) {
      sec("Suggestions from the ontology");
      const seen = new Set<string>();
      for (const h of useful) {
        const key = `${h.entity ?? ""}|${h.namespaces.join(",")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const row = el.createDiv({ cls: "mif-rel-row" });
        row.createSpan({ text: `“${h.match.slice(0, 40)}”` });
        const actions = row.createSpan({ cls: "mif-row-actions" });
        for (const n of h.namespaces) {
          actions.createEl("a", { text: `namespace ${n}`, href: "#" }).onclick = (e) => {
            e.preventDefault();
            void this.host.manager.applyFix(file, { label: n, updates: { namespace: n } });
          };
        }
        if (h.entity && h.entity !== entityType) {
          actions.createEl("a", { text: `type ${h.entity}`, href: "#" }).onclick = (e) => {
            e.preventDefault();
            const name = typeof fm.title === "string" ? fm.title : file.basename;
            void this.host.manager.applyFix(file, { label: h.entity!, updates: { entity: { ...(entity ?? {}), name: entity?.name ?? name, entity_type: h.entity } } });
          };
        }
      }
    } else if (useful.length && complete) {
      const more = el.createEl("p").createEl("a", { cls: "mif-muted", text: `${useful.length} other suggestions from the ontology…`, href: "#" });
      more.onclick = (e) => {
        e.preventDefault();
        this.showAllSuggestions = true;
        this.render();
      };
    }
    el.createEl("p", { cls: "mif-build", text: `MIF build ${BUILD_ID}` });
    const shown = useful.length === 0 ? "none" : complete && !this.showAllSuggestions ? "collapsed" : "listed";
    const summary = `${file.path}|${shown}|${useful.length}`;
    if (summary !== this.lastLogged) {
      this.lastLogged = summary;
      this.host.manager.debug("ontology-panel", { path: file.path, build: BUILD_ID, suggestions: shown, count: useful.length });
    }
  }
}

// --- Entities panel ----------------------------------------------------------------------

export class EntitiesView extends ItemView {
  private query = "";
  constructor(leaf: WorkspaceLeaf, private readonly host: SemanticHost) {
    super(leaf);
  }
  override getViewType() {
    return ENTITIES_VIEW;
  }
  override getDisplayText() {
    return "MIF entities";
  }
  override getIcon() {
    return "users";
  }
  override async onOpen() {
    this.registerEvent(this.host.manager.on("changed", () => this.renderList()));
    const search = this.contentEl.createEl("input", { type: "search", placeholder: "Filter entities" });
    search.oninput = () => {
      this.query = search.value.toLowerCase();
      this.renderList();
    };
    this.contentEl.addClass("mif-view");
    this.listEl = this.contentEl.createDiv();
    this.renderList();
  }
  private listEl?: HTMLElement;

  private renderList() {
    const el = this.listEl;
    if (!el) return;
    el.empty();
    const active = this.app.workspace.getActiveFile();
    const root = (active && this.host.manager.rootFor(active.path)) ?? this.host.manager.bundleRoots()[0] ?? "";
    const index = this.host.manager.entityIndex(root);
    const rows = [...index].filter(([urn, e]) => !this.query || urn.includes(this.query) || (e.record?.name ?? "").toLowerCase().includes(this.query));
    el.createEl("p", { cls: "mif-muted", text: `${rows.length} entities in ${root || "the vault bundle"}` });
    for (const [urn, e] of rows.sort(([a], [b]) => a.localeCompare(b))) {
      const box = el.createDiv({ cls: "mif-rel-group" });
      const head = box.createDiv({ cls: "mif-rel-row" });
      head.createSpan({ text: e.record?.name ?? urn });
      head.createSpan({ cls: "mif-muted", text: ` ${urn}` });
      if (!e.record) {
        const create = head.createEl("a", { cls: "mif-row-actions", text: "Create file", href: "#" });
        create.onclick = (ev) => {
          ev.preventDefault();
          void this.host.manager.createEntity(root, urn, e.refs[0]?.name);
        };
      }
      for (const r of e.refs) {
        const row = box.createDiv({ cls: "mif-rel-row" });
        const a = row.createEl("a", { text: r.path, href: "#" });
        a.onclick = (ev) => {
          ev.preventDefault();
          const f = this.app.vault.getAbstractFileByPath(r.path);
          if (f instanceof TFile) void openAtLine(this, f);
        };
        if (r.role) row.createSpan({ cls: "mif-muted", text: ` · ${r.role}` });
      }
    }
  }
}

// --- add entity reference -------------------------------------------------------------------

class EntityPicker extends FuzzySuggestModal<EntityRecord | "new"> {
  constructor(app: App, private readonly entities: EntityRecord[], private readonly onPick: (e: EntityRecord | "new") => void) {
    super(app);
    this.setPlaceholder("Find an entity, or choose “New entity…”");
  }
  getItems() {
    return ["new" as const, ...this.entities];
  }
  getItemText(e: EntityRecord | "new") {
    return e === "new" ? "New entity…" : `${e.name}${e.aliases.length ? ` (${e.aliases.join(", ")})` : ""} — ${e.urn}`;
  }
  onChooseItem(e: EntityRecord | "new") {
    this.onPick(e);
  }
}

const CORE_ENTITY_TYPES = ["Person", "Organization", "Technology", "Concept", "File"];

export class NewEntityModal extends Modal {
  private typeName = "Person";
  private name = "";
  private role = "";
  constructor(app: App, private readonly onSubmit: (e: { urn: string; name: string; typeName: string; role?: string }) => Promise<void>) {
    super(app);
  }
  override onOpen() {
    this.setTitle("New entity");
    new Setting(this.contentEl).setName("Type").addDropdown((d) => {
      for (const t of CORE_ENTITY_TYPES) d.addOption(t, t);
      d.setValue(this.typeName).onChange((v) => (this.typeName = v));
    });
    new Setting(this.contentEl).setName("Name").addText((t) => t.setPlaceholder("Jane Doe").onChange((v) => (this.name = v.trim())));
    new Setting(this.contentEl).setName("Role").setDesc("Optional: how this concept relates to the entity.").addText((t) => t.onChange((v) => (this.role = v.trim())));
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Add").setCta().onClick(async () => {
        if (!this.name) {
          new Notice("Give the entity a name.");
          return;
        }
        const urn = entityUrn(entitySlug(this.typeName), entitySlug(this.name));
        await this.onSubmit({ urn, name: this.name, typeName: this.typeName, role: this.role || undefined });
        this.close();
      }),
    );
  }
  override onClose() {
    this.contentEl.empty();
  }
}

/** Pick an entity of `file`'s bundle, or create one, then call `use`. */
function pickEntity(app: App, manager: MifManager, file: TFile, use: (e: { urn: string; name: string; typeName?: string; role?: string }) => Promise<void>): void {
  const root = manager.rootFor(file.path);
  if (root === null) return;
  const entities = [...(manager.bundleInfo(root)?.entities.values() ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  new EntityPicker(app, entities, (picked) => {
    if (picked === "new") {
      new NewEntityModal(app, async (e) => {
        await manager.createEntity(root, e.urn, e.name, e.typeName);
        await use(e);
      }).open();
    } else {
      void use({ urn: picked.urn, name: picked.name, typeName: picked.type });
    }
  }).open();
}

/** Pick or create an entity, then add an `entities[]` reference to `file`. */
export function addEntityReference(app: App, manager: MifManager, file: TFile): void {
  pickEntity(app, manager, file, async (e) => {
    const fm = manager.get(file.path)?.frontmatter ?? {};
    const list = Array.isArray(fm.entities) ? [...(fm.entities as unknown[])] : [];
    if (list.some((r) => (r as { entity?: { "@id"?: string } })?.entity?.["@id"] === e.urn)) {
      new Notice("MIF: that entity is already referenced.");
      return;
    }
    list.push(entityReference({ urn: e.urn, name: e.name, entityType: e.typeName, role: e.role }));
    await manager.applyFix(file, { label: "entities", updates: { entities: list } });
  });
}

/**
 * Pick or create an entity as an author of citation `index` (§5.4.6). Entity
 * authors are added to any already there; a plain-text author is replaced,
 * since the schema does not allow text and references together.
 */
export function addCitationAuthor(app: App, manager: MifManager, file: TFile, index: number): void {
  pickEntity(app, manager, file, async (e) => {
    const fm = manager.get(file.path)?.frontmatter ?? {};
    const citation = (Array.isArray(fm.citations) ? fm.citations[index] : undefined) as Record<string, unknown> | undefined;
    if (!citation) return;
    const ref = { ...entityReference({ urn: e.urn, name: e.name, entityType: e.typeName }) };
    const current = citation.author;
    const refs: unknown[] = Array.isArray(current) ? current : current && typeof current === "object" ? [current] : [];
    if (refs.some((r) => (r as { entity?: { "@id"?: string } })?.entity?.["@id"] === e.urn)) {
      new Notice("MIF: that entity is already an author.");
      return;
    }
    if (typeof current === "string" && current.trim()) new Notice(`MIF: replaced the plain-text author "${current}".`);
    const next = refs.length ? [...refs, ref] : ref;
    await manager.editField(file, ["citations", index, "author"], next);
  });
}
