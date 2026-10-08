// The MIF Properties panel — every §5.2 field edited through forms
// generated from mif.schema.json, written with the format-preserving writer.
// Relationships stay in the Related panel.

import { ItemView, Notice, setIcon, type TFile, type WorkspaceLeaf } from "obsidian";

import { BUILD_ID } from "./build";
import {
  checkInput,
  compressionState,
  dumpYaml,
  hasCitationSection,
  FORM_KEYS,
  isoSeconds,
  SECTIONS,
  topLevelModel,
  visibleNamespaces,
  vocabularyLabel,
  type Diagnostic,
  type FieldModel,
} from "./engine";
import type { MifManager } from "./manager";
import { ConfirmModal } from "./modals";
import { addCitationAuthor } from "./semanticViews";

export const PROPERTIES_VIEW = "mif-properties";

export interface PropertiesHost {
  manager: MifManager;
  revealView(type: string): Promise<void>;
}

type Path = Array<string | number>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const show = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : String(v));
const yamlOf = (v: unknown) => (v === undefined || v === null || (isObj(v) && !Object.keys(v).length) ? "" : dumpYaml(v).trimEnd());

export class PropertiesView extends ItemView {
  private file?: TFile;
  private pendingRender = false;
  // Not called `open`: that would shadow Obsidian's internal View.open(),
  // which starts the view.
  private expandedSections = new Set<string>(["Identity"]);
  private lastLogged = "";

  constructor(leaf: WorkspaceLeaf, private readonly host: PropertiesHost) {
    super(leaf);
  }
  override getViewType() {
    return PROPERTIES_VIEW;
  }
  override getDisplayText() {
    return "MIF properties";
  }
  override getIcon() {
    return "sliders-horizontal";
  }

  override async onOpen() {
    this.host.manager.debug("properties-panel-open", { build: BUILD_ID });
    try {
      this.wire();
    } catch (err) {
      this.host.manager.debug("properties-panel-error", { where: "onOpen", message: (err as Error).message, stack: (err as Error).stack?.split("\n").slice(0, 8) });
      this.contentEl.createEl("p", { cls: "mif-error-text", text: `MIF properties panel failed to open: ${(err as Error).message}` });
    }
  }

  private wire() {
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.render()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.render()));
    this.registerEvent(this.host.manager.on("changed", () => this.render()));
    // Never redraw under the user's cursor; catch up when focus leaves.
    this.registerDomEvent(this.contentEl, "focusout", () => {
      window.setTimeout(() => {
        if (this.pendingRender && !this.editing()) this.render();
      }, 0);
    });
    this.render();
  }

  /** True while the user is typing in one of this panel's inputs. */
  private editing(): boolean {
    const a = document.activeElement;
    return !!a && this.contentEl.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  }

  private render() {
    if (this.editing()) {
      this.pendingRender = true;
      return;
    }
    this.pendingRender = false;
    try {
      this.draw();
    } catch (err) {
      // Never leave the panel blank: show the error and log the stack.
      const e = err as Error;
      this.contentEl.empty();
      this.contentEl.createEl("p", { cls: "mif-error-text", text: `MIF properties panel failed: ${e.message}` });
      this.contentEl.createEl("p", { cls: "mif-build", text: `MIF build ${BUILD_ID}` });
      this.host.manager.debug("properties-panel-error", { message: e.message, stack: e.stack?.split("\n").slice(0, 8) });
    }
  }

  private draw() {
    this.host.manager.debug("properties-panel-draw", { active: this.app.workspace.getActiveFile()?.path ?? null });
    const el = this.contentEl;
    el.empty();
    el.addClass("mif-view", "mif-properties");
    const file = this.app.workspace.getActiveFile() ?? undefined;
    this.file = file;
    const a = file ? this.host.manager.get(file.path) : undefined;
    if (!file || !a?.isConcept || !a.frontmatter) {
      el.createEl("p", { cls: "mif-muted", text: "Open a MIF concept to edit its properties." });
      return;
    }
    const fm = a.frontmatter;
    el.createEl("h4", { text: typeof fm.title === "string" ? fm.title : file.basename });
    const idRow = el.createDiv({ cls: "mif-field" });
    idRow.createSpan({ cls: "mif-field-label", text: "Id" });
    idRow.createSpan({ cls: "mif-field-readonly", text: show(fm.id) });

    for (const section of SECTIONS) {
      const details = el.createEl("details", { cls: "mif-section" });
      details.open = this.expandedSections.has(section.title);
      details.addEventListener("toggle", () => (details.open ? this.expandedSections.add(section.title) : this.expandedSections.delete(section.title)));
      const summary = details.createEl("summary", { text: section.title });
      const count = section.keys.filter((k) => fm[k] !== undefined).length;
      if (count) summary.createSpan({ cls: "mif-muted", text: ` · ${count}` });
      for (const key of section.keys) this.renderField(details, topLevelModel(key), [key], fm[key], a.diagnostics);
      this.sectionActions(details, section.title, file, fm, a.body ?? "");
    }

    const related = el.createEl("p", { cls: "mif-muted" });
    related.appendText("Relationships are edited in the ");
    related.createEl("a", { text: "Related panel", href: "#" }).onclick = (e) => {
      e.preventDefault();
      void this.host.revealView("mif-related");
    };
    related.appendText(".");

    const others = Object.keys(fm).filter((k) => !FORM_KEYS.has(k));
    if (others.length) {
      const p = el.createEl("p", { cls: "mif-muted" });
      p.setText(`Other properties (edit in Obsidian's Properties): ${others.join(", ")}`);
    }
    el.createEl("p", { cls: "mif-build", text: `MIF build ${BUILD_ID}` });
    if (this.lastLogged !== file.path) {
      this.lastLogged = file.path;
      this.host.manager.debug("properties-panel", { path: file.path, build: BUILD_ID, sections: SECTIONS.map((sec) => `${sec.title}:${sec.keys.filter((k) => fm[k] !== undefined).length}`) });
    }
  }

  /** Section-level actions: the ## Citations section, and compression (§5.6.3). */
  private sectionActions(parent: HTMLElement, title: string, file: TFile, fm: Record<string, unknown>, body: string) {
    if (title === "Citations" && Array.isArray(fm.citations) && fm.citations.length) {
      const row = parent.createDiv({ cls: "mif-section-actions" });
      const exists = hasCitationSection(body);
      const b = row.createEl("button", { text: exists ? "Update ## Citations section" : "Write ## Citations section" });
      b.onclick = () => void this.host.manager.applyFix(file, { label: b.textContent ?? "", transform: "citations-sync" });
      row.createSpan({ cls: "mif-muted", text: exists ? " Rewrites each entry's link and Type / Role / Relevance / Accessed from frontmatter; annotations stay." : " Optional: a body section for annotations (§5.4.5)." });
    }
    if (title === "Compression") {
      const state = compressionState(fm);
      const row = parent.createDiv({ cls: "mif-section-actions" });
      if (state.compressed && state.hasOriginal) {
        const b = row.createEl("button", { text: "Restore original content" });
        b.onclick = () => void this.host.manager.applyFix(file, { label: "Restore original content", transform: "decompress" });
      } else if (!state.compressed) {
        const b = row.createEl("button", { text: "Compress…" });
        b.disabled = !state.summary;
        b.onclick = () =>
          new ConfirmModal(this.app, "Compress this concept", [
            "The body is replaced by the summary. The original text is kept in extensions.original_content, and the ## Relationships and ## Citations sections stay.",
            "Restore original content (here) undoes it.",
          ], "Compress", () => this.host.manager.applyFix(file, { label: "Compress", transform: "compress" })).open();
      }
      row.createSpan({ cls: "mif-muted", text: state.summary ? " The summary is edited under Identity." : " Write a summary (Identity) to compress." });
    }
  }

  // --- fields ---------------------------------------------------------------------

  private renderField(parent: HTMLElement, model: FieldModel, path: Path, value: unknown, diagnostics: Diagnostic[]) {
    const row = parent.createDiv({ cls: `mif-field mif-kind-${model.kind}` });
    const label = row.createDiv({ cls: "mif-field-label", text: model.label + (model.required ? " *" : "") });
    if (model.description) label.setAttr("title", model.description);
    const control = row.createDiv({ cls: "mif-field-control" });
    const error = row.createDiv({ cls: "mif-field-error" });
    const here = diagnostics.filter((d) => d.path.length && d.path.join(".") === path.join("."));
    for (const d of here) row.createDiv({ cls: `mif-field-diag mif-${d.severity}-text`, text: d.message });

    const commitInput = (input: string) => {
      const checked = checkInput(model, input);
      if (checked.error) {
        error.setText(checked.error);
        return;
      }
      error.setText("");
      void this.commit(path, checked.remove ? undefined : checked.value);
    };

    switch (model.kind) {
      case "enum": {
        const sel = control.createEl("select", { cls: "dropdown" });
        sel.createEl("option", { value: "", text: model.required ? "—" : "(none)" });
        for (const v of model.enum ?? []) sel.createEl("option", { value: v, text: vocabularyLabel(model.key, v) ?? v });
        sel.value = show(value);
        sel.onchange = () => commitInput(sel.value);
        break;
      }
      case "boolean": {
        const box = control.createEl("input", { type: "checkbox" });
        box.checked = value === true;
        box.onchange = () => void this.commit(path, box.checked);
        break;
      }
      case "textarea":
      case "strings":
      case "map":
      case "raw": {
        if (path.length === 3 && path[0] === "citations" && path[2] === "author" && this.file) {
          const file = this.file;
          const pick = control.createEl("button", { text: "Add author entity…", cls: "mif-inline-action" });
          pick.onclick = () => addCitationAuthor(this.app, this.host.manager, file, path[1] as number);
        }
        const ta = control.createEl("textarea", { cls: "mif-textarea" });
        ta.value = model.kind === "strings" ? (Array.isArray(value) ? value.join("\n") : "") : model.kind === "textarea" ? show(value) : yamlOf(value);
        ta.rows = Math.min(8, Math.max(2, ta.value.split("\n").length));
        if (model.kind === "strings") ta.placeholder = "One per line";
        if (model.kind === "map" || model.kind === "raw") ta.placeholder = "YAML";
        ta.onchange = () => commitInput(ta.value);
        break;
      }
      case "object": {
        const obj = isObj(value) ? value : {};
        const box = control.createDiv({ cls: "mif-object" });
        for (const child of model.children ?? []) this.renderField(box, child, [...path, child.key], obj[child.key], diagnostics);
        if (model.open) {
          const known = new Set((model.children ?? []).map((c) => c.key));
          const extra = Object.fromEntries(Object.entries(obj).filter(([k]) => !known.has(k) && k !== "@type"));
          const extraModel: FieldModel = { key: "other", label: "Other keys", kind: "map", description: "Extra keys this object allows (YAML)." };
          this.renderExtra(box, extraModel, path, obj, extra);
        }
        break;
      }
      case "array": {
        const list = Array.isArray(value) ? value : [];
        const box = control.createDiv({ cls: "mif-array" });
        list.forEach((item, i) => {
          const itemBox = box.createDiv({ cls: "mif-array-item" });
          const head = itemBox.createDiv({ cls: "mif-array-head" });
          head.createSpan({ cls: "mif-muted", text: `#${i + 1}` });
          const remove = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Remove" } });
          setIcon(remove, "trash-2");
          remove.onclick = () => void this.commit([...path, i], undefined);
          this.renderField(itemBox, { ...model.item!, label: "" }, [...path, i], item, diagnostics);
        });
        const add = box.createEl("button", { text: `Add ${model.label.replace(/s$/, "").toLowerCase()}` });
        add.onclick = () => void this.commit([...path, list.length], structuredClone(model.template ?? ""));
        break;
      }
      default: {
        const input = control.createEl("input", { type: model.kind === "number" || model.kind === "integer" ? "number" : "text" });
        if (model.kind === "number") input.step = "any";
        input.value = show(value);
        if (model.kind === "datetime") input.placeholder = "2026-01-15T10:30:00Z";
        if (model.kind === "date") input.placeholder = "YYYY-MM-DD";
        if (model.kind === "duration") input.placeholder = "P90D";
        const suggestions = path.length === 1 && path[0] === "namespace" ? this.namespaceSuggestions() : model.suggestions;
        if (suggestions?.length) {
          const id = `mif-dl-${path.join("-")}`;
          const dl = control.createEl("datalist", { attr: { id } });
          for (const s of suggestions) dl.createEl("option", { value: s });
          input.setAttr("list", id);
        }
        input.onchange = () => commitInput(input.value);
        input.onkeydown = (e) => {
          if (e.key === "Enter") input.blur();
        };
        if (model.kind === "datetime" || model.kind === "date") {
          const now = control.createEl("button", { text: model.kind === "date" ? "Today" : "Now", cls: "mif-now" });
          now.onclick = () => {
            const stamp = isoSeconds(new Date());
            commitInput(model.kind === "date" ? stamp.slice(0, 10) : stamp);
          };
        }
      }
    }
  }

  /** Extra keys of an open object, edited as YAML and merged back. */
  private renderExtra(parent: HTMLElement, model: FieldModel, path: Path, obj: Record<string, unknown>, extra: Record<string, unknown>) {
    const row = parent.createDiv({ cls: "mif-field mif-kind-map" });
    row.createDiv({ cls: "mif-field-label", text: model.label }).setAttr("title", model.description ?? "");
    const ta = row.createDiv({ cls: "mif-field-control" }).createEl("textarea", { cls: "mif-textarea" });
    const error = row.createDiv({ cls: "mif-field-error" });
    ta.value = yamlOf(extra);
    ta.rows = Math.min(6, Math.max(2, ta.value.split("\n").length));
    ta.placeholder = "key: value";
    ta.onchange = () => {
      const checked = checkInput(model, ta.value);
      if (checked.error) {
        error.setText(checked.error);
        return;
      }
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) if (!(k in extra)) next[k] = v;
      Object.assign(next, (checked.value as Record<string, unknown>) ?? {});
      void this.commit(path, next);
    };
  }

  private namespaceSuggestions(): string[] {
    const file = this.file;
    if (!file) return [];
    const report = this.host.manager.semantic(file.path);
    const a = this.host.manager.get(file.path);
    const info = a ? this.host.manager.bundleInfo(a.root) : undefined;
    if (!report?.ontologyId || !info?.corpus.has(report.ontologyId)) return [];
    return [...visibleNamespaces(report.ontologyId, info.corpus).keys()].sort();
  }

  private async commit(path: Path, value: unknown) {
    if (!this.file) return;
    const ok = await this.host.manager.editField(this.file, path, value);
    if (!ok) new Notice("MIF: the change was not saved.");
  }
}
