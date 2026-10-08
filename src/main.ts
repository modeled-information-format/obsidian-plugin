// MIF for Obsidian — authoring and Level 1 validation.

import { normalizePath, Notice, Plugin, PluginSettingTab, Setting, TFile, type App } from "obsidian";

import { newConceptText, promoteToConcept, updateFrontmatter, visibleNamespaces, visibleTypes, type BaseType } from "./engine";
import { MifManager } from "./manager";
import { ConvertModal, NewConceptModal, slugify, type NewConceptInput, type OntologyHints } from "./modals";
import { DEFAULT_SETTINGS, loadSettings, parseLines, type MifSettings, type SyncMode } from "./settings";
import { runFidelitySpike } from "./spikes/fidelity";
import { runLinkSpike } from "./spikes/links";
import { BUILD_ID } from "./build";
import { OntologyStore } from "./ontologyStore";
import { MigrationModal, RELATED_VIEW, RelatedView, RelationshipModal, type RelationshipDraft } from "./relations";
import { addEntityReference, ENTITIES_VIEW, EntitiesView, ONTOLOGY_VIEW, OntologyView } from "./semanticViews";
import { DIAGNOSTICS_VIEW, DiagnosticsView, REPORT_VIEW, ReportView } from "./views";

export default class MifPlugin extends Plugin {
  override settings: MifSettings = DEFAULT_SETTINGS;
  manager!: MifManager;
  store!: OntologyStore;
  private statusEl?: HTMLElement;

  override async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData());
    this.store = new OntologyStore(this.app, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    this.manager = new MifManager(this.app, () => this.settings, this.store);
    this.addSettingTab(new MifSettingTab(this.app, this));

    this.registerView(DIAGNOSTICS_VIEW, (leaf) => new DiagnosticsView(leaf, this));
    this.registerView(REPORT_VIEW, (leaf) => new ReportView(leaf, this));
    this.registerView(RELATED_VIEW, (leaf) => new RelatedView(leaf, this));
    this.registerView(ONTOLOGY_VIEW, (leaf) => new OntologyView(leaf, this));
    this.registerView(ENTITIES_VIEW, (leaf) => new EntitiesView(leaf, this));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mif-status", "mod-clickable");
    this.statusEl.onclick = () => void this.revealView(DIAGNOSTICS_VIEW);
    this.register(() => this.manager.dispose());

    this.registerCommands();
    this.addRibbonIcon("list-checks", "MIF bundle report", () => void this.revealView(REPORT_VIEW));

    this.app.workspace.onLayoutReady(async () => {
      this.manager.debug("loaded", { build: BUILD_ID, version: this.manifest.version });
      await this.store.loadCache();
      await this.manager.loadBundles();
      await this.manager.scanAll();
      void this.manager.ensureOntologies();
      this.registerVaultEvents();
      this.refreshStatus();
    });
  }

  private registerVaultEvents(): void {
    const { vault, workspace } = this.app;
    this.registerEvent(this.manager.on("changed", () => this.refreshStatus()));
    this.registerEvent(workspace.on("file-open", () => this.refreshStatus()));
    this.registerEvent(
      workspace.on("editor-change", (_editor, info) => {
        if (info.file) this.manager.markDirty(info.file.path);
      }),
    );
    this.registerEvent(this.app.metadataCache.on("changed", () => void this.manager.noteActivity()));
    this.registerEvent(
      vault.on("modify", async (file) => {
        if (!(file instanceof TFile)) return;
        void this.manager.noteActivity(file);
        if (file.path.endsWith(".mif/config.yaml")) return this.reloadBundles();
        await this.manager.analyzeFile(file);
        this.manager.scheduleStamp(file);
      }),
    );
    this.registerEvent(
      vault.on("create", (file) => {
        if (file instanceof TFile) void this.manager.analyzeFile(file);
      }),
    );
    this.registerEvent(vault.on("delete", (file) => this.manager.forget(file.path)));
    this.registerEvent(vault.on("rename", (file, oldPath) => this.manager.handleRename(file, oldPath)));
  }

  async reloadBundles(): Promise<void> {
    await this.manager.loadBundles();
    await this.manager.scanAll();
    void this.manager.ensureOntologies();
  }

  addEntityReference(file: TFile): void {
    addEntityReference(this.app, this.manager, file);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private refreshStatus(): void {
    const el = this.statusEl;
    if (!el) return;
    el.empty();
    const file = this.app.workspace.getActiveFile();
    const a = file ? this.manager.get(file.path) : undefined;
    if (!file || !a) {
      el.hide();
      return;
    }
    el.show();
    const errors = a.diagnostics.filter((d) => d.severity === "error").length;
    const warnings = a.diagnostics.filter((d) => d.severity === "warning").length;
    const label = !a.isConcept ? "MIF –" : a.level === 0 ? "MIF ✗" : `MIF L${a.level}`;
    el.createSpan({ cls: `mif-level mif-level-${a.isConcept ? a.level : "none"}`, text: label });
    if (errors) el.createSpan({ cls: "mif-error-text", text: ` ${errors}✗` });
    if (warnings) el.createSpan({ cls: "mif-warning-text", text: ` ${warnings}⚠` });
    el.setAttr("aria-label", a.isConcept ? "Open MIF diagnostics" : "Not a MIF concept — open diagnostics to convert");
    el.setAttr("data-tooltip-position", "top");
  }

  async revealView(type: string): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(type)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  // --- commands -----------------------------------------------------------------

  private registerCommands(): void {
    this.addCommand({
      id: "new-concept",
      name: "New concept",
      callback: () => {
        const active = this.app.workspace.getActiveFile();
        const root = (active && this.manager.rootFor(active.path)) ?? this.settings.bundleRoots[0] ?? "";
        const info = this.manager.bundleInfo(root);
        const corpus = info?.corpus ?? new Map();
        const hints: OntologyHints = {
          ontologies: [...corpus.keys()].sort(),
          namespaces: (ontology, type) => {
            const id = ontology ?? (this.settings.defaultOntology || undefined);
            if (!id || !corpus.has(id)) return [];
            return [...visibleNamespaces(id, corpus)].filter(([, n]) => !n.type_hint || n.type_hint === type).map(([p]) => p).sort();
          },
          entityTypes: (ontology, type) =>
            corpus.has(ontology) ? [...visibleTypes(ontology, corpus).values()].filter((t) => t.base === type).map((t) => t.name).sort() : [],
        };
        new NewConceptModal(this.app, root, (input) => this.createConcept(input), hints).open();
      },
    });
    this.addCommand({
      id: "convert-note",
      name: "Convert note to MIF concept",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const a = file && this.manager.get(file.path);
        const eligible = !!file && file.extension === "md" && this.manager.rootFor(file.path) !== null
          && (!a || !a.isConcept || a.diagnostics.some((d) => d.code.startsWith("missing-")));
        if (eligible && !checking) this.convertActive();
        return eligible;
      },
    });
    this.addCommand({ id: "open-diagnostics", name: "Open diagnostics", callback: () => void this.revealView(DIAGNOSTICS_VIEW) });
    this.addCommand({ id: "open-related", name: "Open related panel", callback: () => void this.revealView(RELATED_VIEW) });
    this.addCommand({
      id: "add-relationship",
      name: "Add relationship",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && !!this.manager.indexFor(file.path)?.index.concepts.has(this.manager.indexFor(file.path)!.bundlePath);
        if (ok && !checking) this.editRelationship(file!);
        return ok;
      },
    });
    this.addCommand({
      id: "regenerate-mirror",
      name: "Regenerate body relationships from frontmatter",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const a = file && this.manager.get(file.path);
        const ok = !!a?.isConcept && !!a.frontmatter;
        if (ok && !checking) void this.manager.applyFix(file!, { label: "mirror", transform: "mirror" });
        return ok;
      },
    });
    this.addCommand({ id: "open-ontology", name: "Open ontology panel", callback: () => void this.revealView(ONTOLOGY_VIEW) });
    this.addCommand({ id: "open-entities", name: "Open entities panel", callback: () => void this.revealView(ENTITIES_VIEW) });
    this.addCommand({
      id: "add-entity-reference",
      name: "Add entity reference",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && !!this.manager.get(file.path)?.isConcept;
        if (ok && !checking) this.addEntityReference(file!);
        return ok;
      },
    });
    this.addCommand({
      id: "download-ontologies",
      name: "Download all ontologies from mif-spec.dev",
      callback: async () => {
        new Notice("MIF: downloading the ontology catalog…");
        const got = await this.store.downloadAll();
        this.manager.refreshCorpora();
        const errors = this.store.status.errors.slice(-3);
        new Notice(`MIF: ${got.length} ontologies downloaded and verified.${errors.length ? ` Errors: ${errors.join("; ")}` : ""}`);
      },
    });
    this.addCommand({
      id: "reload-bundles",
      name: "Reload bundle configuration (.mif)",
      callback: () => void this.reloadBundles(),
    });
    this.addCommand({
      id: "migrate-legacy",
      name: "Migrate MIF 0.1 notes",
      callback: () => new MigrationModal(this.app, this.manager, this.manager.legacyFiles()).open(),
    });
    this.addCommand({ id: "open-report", name: "Open bundle report", callback: () => void this.revealView(REPORT_VIEW) });

    const spike = (id: string, name: string, run: (app: App) => Promise<string>) =>
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          if (!this.settings.showDevCommands) return false;
          if (!checking) {
            new Notice(`${name}: running…`);
            run(this.app)
              .then((summary) => new Notice(`${name}: done (${summary}). Report in _spike/.`))
              .catch((err: Error) => new Notice(`${name} failed: ${err.message}`, 0));
          }
          return true;
        },
      });
    spike("spike-frontmatter-fidelity", "Spike B: frontmatter write fidelity", runFidelitySpike);
    spike("spike-link-resolution", "Spike C: relationship link resolution", runLinkSpike);
  }

  private async createConcept(input: NewConceptInput): Promise<void> {
    const folder = normalizePath(input.folder || "/");
    if (folder !== "/" && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const base = `${folder === "/" ? "" : `${folder}/`}${slugify(input.title)}`;
    let path = `${base}.md`;
    for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = `${base}-${n}.md`;
    let text = newConceptText({
      type: input.type,
      title: input.title,
      namespace: input.namespace || undefined,
      id: crypto.randomUUID(),
      created: new Date(),
    });
    if (input.ontology) {
      const root = this.manager.rootFor(`${base}.md`) ?? "";
      const def = this.manager.bundleInfo(root)?.corpus.get(input.ontology);
      const extra: Record<string, unknown> = { ontology: def ? { id: input.ontology, version: def.version } : { id: input.ontology } };
      if (input.entityType) extra.entity = { name: input.title, entity_type: input.entityType };
      text = updateFrontmatter(text, extra);
    }
    const file = await this.app.vault.create(path, text);
    await this.app.workspace.getLeaf(false).openFile(file);
    if (this.manager.rootFor(path) === null) new Notice(`MIF: ${path} is outside every MIF bundle, so it won't be validated.`);
  }

  /** Open the add (index undefined) or edit dialog for a concept's relationship. */
  editRelationship(file: TFile, index?: number): void {
    const ctx = this.manager.indexFor(file.path);
    if (!ctx) return;
    const { index: bundleIndex, bundlePath, info } = ctx;
    const edge = index === undefined ? undefined : bundleIndex.outgoing.get(bundlePath)?.find((e) => e.index === index);
    const draft: RelationshipDraft = edge
      ? {
          type: edge.type,
          targetPath: edge.resolved,
          rawTarget: edge.resolved ? undefined : edge.target,
          style: edge.target.startsWith("urn:") ? "id" : edge.target.startsWith("/") ? "path" : "relative",
          strength: edge.strength,
        }
      : { type: "relates-to", style: "path" };
    const types = [...info.registry.types.values()];
    const concepts = [...bundleIndex.concepts.values()].sort((a, b) => a.path.localeCompare(b.path));
    new RelationshipModal(this.app, types, concepts, bundlePath, draft, async (type, target, strength) => {
      const rel = { type, target, strength };
      if (index === undefined) await this.manager.addRelationship(file, rel);
      else await this.manager.updateRelationship(file, index, rel);
    }).open();
  }

  convertActive(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    new ConvertModal(this.app, file.basename, async (type: BaseType) => {
      const ok = await this.manager.write(file, (text) =>
        promoteToConcept(text, { type, id: crypto.randomUUID(), created: new Date(file.stat.ctime) }),
      );
      if (ok) await this.manager.analyzeFile(file);
    }).open();
  }
}

class MifSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: MifPlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    containerEl.createEl("p", { cls: "mif-build", text: `MIF build ${BUILD_ID}` });

    new Setting(containerEl)
      .setName("Mode")
      .setDesc("Observe validates and offers fixes. Sync also updates `modified` after you edit a concept.")
      .addDropdown((d) =>
        d.addOptions({ observe: "Observe", sync: "Sync" }).setValue(s.mode).onChange(async (value) => {
          s.mode = value as SyncMode;
          await this.plugin.saveSettings();
        }),
      );

    const roots = new Setting(containerEl)
      .setName("Bundle roots")
      .setDesc("One folder per line. An empty line means the whole vault. A note belongs to the deepest matching root.")
      .addTextArea((t) => {
        t.setValue(s.bundleRoots.join("\n")).onChange(async (value) => {
          s.bundleRoots = [...new Set(parseLines(value))];
          if (s.bundleRoots.length === 0) s.bundleRoots = [""];
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 3;
        t.inputEl.addEventListener("blur", () => void this.plugin.reloadBundles().then(() => this.display()));
      });
    if (s.bundleRoots.some((r) => r !== "")) {
      roots.descEl.createEl("p", {
        cls: "mif-warning-text",
        text: "A bundle in a subfolder loses Obsidian's native backlinks for relationship targets, because /path targets resolve from the vault root.",
      });
    }

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("One folder per line. Notes here are never treated as MIF.")
      .addTextArea((t) => {
        t.setValue(s.excludedFolders.join("\n")).onChange(async (value) => {
          s.excludedFolders = parseLines(value).filter(Boolean);
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 3;
        t.inputEl.addEventListener("blur", () => void this.plugin.reloadBundles());
      });

    new Setting(containerEl).setName("Ontologies").setHeading();
    const status = this.plugin.store.status;
    new Setting(containerEl)
      .setName("Download ontologies from mif-spec.dev")
      .setDesc(
        `When a concept declares an ontology the vault doesn't have, download it (and what it extends) from mif-spec.dev, check it against the catalog's sha256, and cache it in the plugin folder. Bundle .mif/ontologies/ files always take precedence. Cached: ${status.cached.length ? status.cached.sort().join(", ") : "none"}${status.catalogVersion ? ` (corpus ${status.catalogVersion})` : ""}.`,
      )
      .addToggle((t) =>
        t.setValue(s.downloadOntologies).onChange(async (value) => {
          s.downloadOntologies = value;
          await this.plugin.saveSettings();
          if (value) void this.plugin.manager.ensureOntologies();
        }),
      )
      .addExtraButton((b) =>
        b.setIcon("trash").setTooltip("Clear the downloaded ontology cache").onClick(async () => {
          await this.plugin.store.clearCache();
          this.plugin.manager.refreshCorpora();
          this.display();
        }),
      );
    new Setting(containerEl)
      .setName("Default ontology")
      .setDesc("Used for namespace hints on concepts that declare no ontology. Entity types are only checked against a declared ontology.")
      .addText((t) =>
        t.setPlaceholder("mif-base").setValue(s.defaultOntology).onChange(async (value) => {
          s.defaultOntology = value.trim();
          await this.plugin.saveSettings();
          this.plugin.manager.recomputeSemantics();
        }),
      );

    new Setting(containerEl)
      .setName("Developer commands")
      .setDesc("Show the spike commands. They write only under _spike/.")
      .addToggle((t) =>
        t.setValue(s.showDevCommands).onChange(async (value) => {
          s.showDevCommands = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}
