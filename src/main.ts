// MIF for Obsidian — authoring and Level 1 validation.

import { FileSystemAdapter, MarkdownRenderChild, normalizePath, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, type App, type WorkspaceLeaf } from "obsidian";

import { compressionState, hasCitationSection, newConceptText, promoteToConcept, updateFrontmatter, visibleNamespaces, visibleTypes, type BaseType, type Corpus, type OntologyDef } from "./engine";
import { isFirstBodySection, renderCompressed } from "./compressionView";
import { MifManager } from "./manager";
import { ConfirmModal, ConvertModal, NewConceptModal, ReportModal, slugify, type NewConceptInput, type OntologyHints } from "./modals";
import { DEFAULT_SETTINGS, loadSettings, parseLines, type MifSettings, type SyncMode } from "./settings";
import { runFidelitySpike } from "./spikes/fidelity";
import { runLinkSpike } from "./spikes/links";
import { BUILD_ID } from "./build";
import { OntologyStore } from "./ontologyStore";
import { MigrationModal, RELATED_VIEW, RelatedView, RelationshipModal, type RelationshipDraft } from "./relations";
import { decorateExplorer, FRESHNESS_VIEW, FreshnessView, freshnessLabel } from "./freshnessView";
import { PROPERTIES_VIEW, PropertiesView } from "./propertiesView";
import { addEntityReference, ENTITIES_VIEW, EntitiesView, ONTOLOGY_VIEW, OntologyView } from "./semanticViews";
import { DIAGNOSTICS_VIEW, DiagnosticsView, REPORT_VIEW, ReportView } from "./views";
import { MifApi } from "./api";
import { registerMifBasesView } from "./basesView";
import { ingestNotice, MifCli, problemText, SearchModal, type SearchFilters } from "./cliBridge";
import { COVERAGE_VIEW, CoverageView, GAPS_VIEW, GapsView } from "./storeViews";
import { GRAPH_VIEW, GraphView } from "./graphView";
import { JSONLD_VIEW, JsonLdView } from "./jsonldView";
import { newToken } from "./mcp/guard";
import { McpService, mcpServing, SwitchMirror, VaultMcpHost, type McpModule } from "./mcpHost";

export default class MifPlugin extends Plugin {
  override settings: MifSettings = DEFAULT_SETTINGS;
  manager!: MifManager;
  store!: OntologyStore;
  /** Read-only API for other plugins and DataviewJS: app.plugins.plugins.mif.api */
  api!: MifApi;
  cli!: MifCli;
  mcp!: McpService;
  private statusEl?: HTMLElement;

  override async onload(): Promise<void> {
    // Views are registered before anything is awaited: Obsidian may restore
    // the saved layout while onload is suspended, and a leaf restored before
    // its view type exists never gets the view.
    this.store = new OntologyStore(this.app, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    this.manager = new MifManager(this.app, () => this.settings, this.store);
    // Each factory is logged (developer log) so a view that never appears can be traced.
    const view = <V>(type: string, make: (leaf: WorkspaceLeaf) => V) =>
      this.registerView(type, (leaf) => {
        try {
          const v = make(leaf);
          this.manager.debug("view-created", { type });
          return v as never;
        } catch (err) {
          this.manager.debug("view-create-error", { type, message: (err as Error).message, stack: (err as Error).stack?.split("\n").slice(0, 6) });
          throw err;
        }
      });
    view(DIAGNOSTICS_VIEW, (leaf) => new DiagnosticsView(leaf, this));
    view(REPORT_VIEW, (leaf) => new ReportView(leaf, this));
    view(RELATED_VIEW, (leaf) => new RelatedView(leaf, this));
    view(ONTOLOGY_VIEW, (leaf) => new OntologyView(leaf, this));
    view(ENTITIES_VIEW, (leaf) => new EntitiesView(leaf, this));
    view(PROPERTIES_VIEW, (leaf) => new PropertiesView(leaf, this));
    view(FRESHNESS_VIEW, (leaf) => new FreshnessView(leaf, this));
    view(JSONLD_VIEW, (leaf) => new JsonLdView(leaf, this));
    view(GRAPH_VIEW, (leaf) => new GraphView(leaf, this));
    view(COVERAGE_VIEW, (leaf) => new CoverageView(leaf, this));
    view(GAPS_VIEW, (leaf) => new GapsView(leaf, this));
    this.api = new MifApi(this.manager);
    this.cli = new MifCli(this.app, this.manager, () => this.settings);
    this.register(() => this.cli.dispose());
    // The MCP server: desktop only, off until this vault turns it on. Node's
    // http is reached lazily, so the plugin still loads on mobile.
    this.mcp = new McpService(
      new VaultMcpHost(this.app, this.manager, this.cli, () => this.settings),
      () => this.settings,
      () => (Platform.isDesktopApp ? (window.require("http") as typeof import("node:http")) : undefined),
      () => this.loadMcp(),
      this.manifest.version,
      (event, detail) => this.manager.debug(event, detail),
    );
    this.register(() => void this.mcp.dispose());
    // Bases (Obsidian 1.10+): a "MIF table" view with level, freshness, trust.
    registerMifBasesView(this, this.api, this.manager);

    this.settings = loadSettings(await this.loadData());
    this.addSettingTab(new MifSettingTab(this.app, this));

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
      if (this.settings.mcpEnabled) {
        void this.mcp.sync().then((status) => {
          if (status.state === "failed") new Notice(`MIF: ${status.reason}`, 10_000);
        });
      }
      // Learn the mif-cli version once, so its commands can say when it is too old;
      // then catch up on what was added or changed while the plugin was not running.
      if (Platform.isDesktopApp && "bin" in this.cli.lookup()) {
        void this.cli.checkVersion().then(() => {
          if (this.settings.backgroundIngest) return this.cli.reconcile();
        });
      }
    });
  }

  private registerVaultEvents(): void {
    const { vault, workspace } = this.app;
    this.registerEvent(this.manager.on("changed", () => {
      this.refreshStatus();
      this.scheduleExplorer();
    }));
    this.registerEvent(workspace.on("file-open", (file) => {
      this.refreshStatus();
      if (file) void this.manager.trackAccess(file);
      void this.manager.flushPendingStamps();
    }));
    // Sync mode stamps a note once you have left it (see MifManager.scheduleStamp).
    this.registerEvent(workspace.on("active-leaf-change", () => void this.manager.flushPendingStamps()));
    this.registerEvent(workspace.on("layout-change", () => {
      this.scheduleExplorer();
      void this.manager.flushPendingStamps();
    }));
    // Freshness moves with the clock: refresh badges every ten minutes.
    this.registerInterval(window.setInterval(() => {
      this.refreshStatus();
      this.scheduleExplorer();
    }, 600_000));
    this.scheduleExplorer();
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
        const a = await this.manager.analyzeFile(file);
        this.manager.scheduleStamp(file);
        // Keeps an existing vector store in step with the note; the note itself is not written.
        if (this.settings.backgroundIngest && a?.isConcept) this.cli.scheduleIngest(file);
      }),
    );
    this.registerEvent(
      vault.on("create", async (file) => {
        if (!(file instanceof TFile)) return;
        const a = await this.manager.analyzeFile(file);
        // A note that arrives whole (copied in, written by another tool) gets no later edit to trigger on.
        if (this.settings.backgroundIngest && a?.isConcept) this.cli.scheduleIngest(file);
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

  /**
   * The MCP server's code lives in mcp.cjs beside main.js and is loaded only
   * here: on desktop, when a vault turns the server on. Mobile never reads it.
   * It is named .cjs because Node decides how to load a .js file from the
   * nearest package.json above it, and a vault can sit inside a project whose
   * package.json says "type": "module"; .cjs is CommonJS wherever it is.
   */
  private loadMcp(): McpModule | undefined {
    const adapter = this.app.vault.adapter;
    if (!Platform.isDesktopApp || !(adapter instanceof FileSystemAdapter)) return undefined;
    try {
      const path = window.require("path") as typeof import("node:path");
      const file = path.join(adapter.getBasePath(), this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`, "mcp.cjs");
      // A reloaded plugin must get the file now on disk, not the copy Node cached at the last load.
      const load = window.require;
      delete load.cache[load.resolve(file)];
      const mod = load(file) as Partial<McpModule>;
      return typeof mod.startEndpoint === "function" ? (mod as McpModule) : undefined;
    } catch (err) {
      this.manager.debug("mcp-load-failed", { message: (err as Error).message });
      return undefined;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private explorerTimer = 0;

  private scheduleExplorer(): void {
    window.clearTimeout(this.explorerTimer);
    this.explorerTimer = window.setTimeout(() => {
      const n = decorateExplorer(this.app, this.manager, this.settings.explorerBadges);
      this.manager.debug("explorer-badges", { decorated: n, enabled: this.settings.explorerBadges });
    }, 300);
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
    if (errors) el.createSpan({ cls: "mif-error-text", text: `${errors}✗` });
    if (warnings) el.createSpan({ cls: "mif-warning-text", text: `${warnings}⚠` });
    const fresh = a.isConcept ? this.manager.freshnessOf(file.path) : undefined;
    if (fresh && fresh.state !== "timeless") {
      el.createSpan({ cls: "mif-muted", text: "·" });
      el.createSpan({ cls: `mif-fresh mif-fresh-${fresh.state}`, text: freshnessLabel(fresh) });
    }
    el.setAttr("aria-label", a.isConcept ? "Open MIF diagnostics" : "Not a MIF concept — open diagnostics to convert");
    el.setAttr("data-tooltip-position", "top");
  }

  /**
   * Show one of the plugin's panels. A tab restored from the saved layout
   * may be deferred (Obsidian 1.7+) or hold a placeholder if it was restored
   * before the view type was registered; both are loaded or re-opened here.
   */
  async revealView(type: string): Promise<void> {
    try {
      await this.revealViewInner(type);
    } catch (err) {
      this.manager.debug("reveal-error", { type, message: (err as Error).message, stack: (err as Error).stack?.split("\n").slice(0, 6) });
      new Notice(`MIF: could not open the panel — ${(err as Error).message}`);
    }
  }

  private async revealViewInner(type: string): Promise<void> {
    const { workspace } = this.app;
    this.manager.debug("reveal", { type, existing: workspace.getLeavesOfType(type).map((l) => ({ deferred: l.isDeferred, view: l.view?.getViewType() })) });
    let leaf = workspace.getLeavesOfType(type)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type, active: true });
    }
    await workspace.revealLeaf(leaf);
    await leaf.loadIfDeferred();
    if (leaf.view.getViewType() !== type) {
      this.manager.debug("reopen-view", { type, found: leaf.view.getViewType() });
      await leaf.setViewState({ type, active: true });
    }
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
        const corpus: Corpus = info?.corpus ?? new Map<string, OntologyDef>();
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
        const similar = async (title: string) =>
          (await this.cli.duplicatesOf(root, title)).map((h) => ({ title: h.title ?? h.path ?? h.id, path: h.path, cosine: h.cosine ?? 0 }));
        new NewConceptModal(this.app, root, (input) => this.createConcept(input), hints, similar).open();
      },
    });
    this.addCommand({
      id: "convert-note",
      name: "Convert note to a concept",
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
        if (ok && !checking) this.editRelationship(file);
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
    this.addCommand({ id: "open-properties", name: "Open properties panel", callback: () => void this.revealView(PROPERTIES_VIEW) });
    this.addCommand({ id: "open-freshness", name: "Open freshness panel", callback: () => void this.revealView(FRESHNESS_VIEW) });
    this.addCommand({ id: "open-entities", name: "Open entities panel", callback: () => void this.revealView(ENTITIES_VIEW) });
    this.addCommand({
      id: "add-entity-reference",
      name: "Add entity reference",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && !!this.manager.get(file.path)?.isConcept;
        if (ok && !checking) this.addEntityReference(file);
        return ok;
      },
    });
    this.addCommand({
      id: "download-ontologies",
      name: "Download all ontologies from the spec catalog",
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
      name: "Reload bundle configuration",
      callback: () => void this.reloadBundles(),
    });
    this.addCommand({
      id: "migrate-legacy",
      name: "Migrate version 0.1 notes to 1.0",
      callback: () => new MigrationModal(this.app, this.manager, this.manager.legacyFiles()).open(),
    });
    this.addCommand({ id: "open-report", name: "Open bundle report", callback: () => void this.revealView(REPORT_VIEW) });
    this.addCommand({
      id: "rescan",
      name: "Rescan all bundles",
      callback: async () => {
        const n = await this.manager.rescan();
        new Notice(`MIF: rescanned ${n} note${n === 1 ? "" : "s"}.`);
      },
    });
    this.addCommand({
      id: "supersede",
      name: "Supersede this concept with a new one",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && !!this.manager.get(file.path)?.isConcept && this.manager.rootFor(file.path) !== null;
        if (ok && !checking) void this.manager.supersede(file);
        return ok;
      },
    });

    // JSON-LD, round trip, graph, and the mif-cli bridge.
    this.addCommand({ id: "open-jsonld", name: "Open JSON-LD panel", callback: () => void this.revealView(JSONLD_VIEW) });
    this.addCommand({ id: "open-graph", name: "Open typed relationship graph", callback: () => void this.revealView(GRAPH_VIEW) });
    const exportScope = async (scope: string, what: string) => {
      const r = await this.manager.exportJsonLd(scope);
      new Notice(`MIF: exported ${r.written} JSON-LD file${r.written === 1 ? "" : "s"} for ${what} to ${r.folder}/${r.skipped.length ? `; ${r.skipped.length} skipped (no projection — fix their errors)` : ""}${r.removed ? `; ${r.removed} stale moved to trash` : ""}.`, 8000);
    };
    this.addCommand({
      id: "export-jsonld-note",
      name: "Export this note as JSON-LD",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && !!this.manager.get(file.path)?.isConcept;
        if (ok && !checking) void exportScope(file.path, file.basename);
        return ok;
      },
    });
    this.addCommand({
      id: "export-jsonld-folder",
      name: "Export this note's folder as JSON-LD",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && this.manager.rootFor(file.path) !== null;
        if (ok && !checking) void exportScope(file.parent?.path === "/" ? "" : file.parent?.path ?? "", file.parent?.path || "the vault");
        return ok;
      },
    });
    this.addCommand({ id: "export-jsonld-all", name: "Export all bundles as JSON-LD", callback: () => void exportScope("", "all bundles") });
    this.addCommand({
      id: "roundtrip-check",
      name: "Check that every concept round-trips losslessly",
      callback: async () => {
        const drift = await this.manager.roundtripReport();
        new ReportModal(this.app, "MIF round-trip check", drift.length
          ? [`${drift.length} concept${drift.length === 1 ? "" : "s"} do not survive markdown → JSON-LD → markdown unchanged:`, ...drift.map((d) => `${d.path}: ${d.drift.split("\n")[0]}`)]
          : ["Every concept round-trips losslessly."]).open();
      },
    });
    const withCli = (run: () => Promise<void>) => {
      const why = this.cli.unavailable();
      if (why) new Notice(`MIF: ${why}`);
      else void run();
    };
    this.addCommand({
      id: "cli-ingest-note",
      name: "Ingest this note into the vector store",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && !!this.manager.get(file.path)?.isConcept && !this.cli.unavailable();
        if (ok && !checking) withCli(async () => ingestNotice(file, await this.cli.ingest(file)));
        return ok;
      },
    });
    this.addCommand({
      id: "cli-ingest-bundle",
      name: "Ingest this bundle into the vector store",
      checkCallback: (checking) => {
        // The active note's bundle; otherwise (no note, or a .base / canvas open) the first bundle.
        const file = this.app.workspace.getActiveFile();
        const root = (file ? this.manager.rootFor(file.path) : null) ?? this.manager.bundleRoots()[0];
        const ok = root !== undefined && !this.cli.unavailable();
        if (ok && !checking) withCli(async () => {
          const notice = new Notice("MIF: ingesting…", 0);
          const r = await this.cli.ingestBundle(root, (done, total) => notice.setMessage(`MIF: ingesting ${done} / ${total}…`));
          notice.hide();
          new Notice(`MIF: ${r.stored} concepts ingested into ${root ? `${root}/` : ""}.mif/vectors.db, ${r.unchanged} already current${r.failed.length ? `; ${r.failed.length} refused (${r.failed.slice(0, 3).map((f) => `${f.path}: ${problemText(f.problem)}`.slice(0, 160)).join("; ")}${r.failed.length > 3 ? "; …" : ""})` : ""}.`, 12_000);
        });
        return ok;
      },
    });
    this.addCommand({
      id: "cli-search",
      name: "Semantic search",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const root = (file ? this.manager.rootFor(file.path) : null) ?? this.manager.bundleRoots()[0] ?? "";
        const ok = !this.cli.unavailable();
        if (ok && !checking) new SearchModal(this.app, this.cli, root, undefined, this.searchFilters(root)).open();
        return ok;
      },
    });
    this.addCommand({
      id: "cli-prune",
      name: "Prune the vector store",
      checkCallback: (checking) => {
        const root = this.activeRoot();
        const ok = root !== undefined && !this.cli.unavailable();
        if (ok && !checking) withCli(() => this.pruneStore(root));
        return ok;
      },
    });
    this.addCommand({
      id: "open-coverage",
      name: "Open vector store coverage",
      checkCallback: (checking) => {
        const ok = !this.cli.unavailable();
        if (ok && !checking) void this.revealView(COVERAGE_VIEW);
        return ok;
      },
    });
    this.addCommand({
      id: "open-gaps",
      name: "Open relationship gap report",
      checkCallback: (checking) => {
        const ok = !this.cli.unavailable();
        if (ok && !checking) void this.revealView(GAPS_VIEW);
        return ok;
      },
    });
    this.addCommand({
      id: "cli-similar",
      name: "Find concepts similar to this note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ok = !!file && !!this.manager.get(file.path)?.isConcept && !this.cli.unavailable();
        if (ok && !checking) withCli(async () => {
          const hits = await this.cli.similar(file);
          new SearchModal(this.app, this.cli, this.manager.rootFor(file.path) ?? "", { title: `Similar to ${file.basename}`, hits }).open();
        });
        return ok;
      },
    });

    // Citations section and compression.
    const activeConcept = () => {
      const file = this.app.workspace.getActiveFile();
      const a = file ? this.manager.get(file.path) : undefined;
      return file && a?.isConcept && a.frontmatter ? { file, a, fm: a.frontmatter } : undefined;
    };
    this.addCommand({
      id: "sync-citations",
      name: "Write or update the ## Citations section from frontmatter",
      checkCallback: (checking) => {
        const c = activeConcept();
        const ok = !!c && Array.isArray(c.fm.citations) && c.fm.citations.length > 0;
        if (ok && !checking) void this.manager.applyFix(c.file, { label: hasCitationSection(c.a.body ?? "") ? "Update ## Citations" : "Write ## Citations", transform: "citations-sync" });
        return ok;
      },
    });
    this.addCommand({
      id: "compress",
      name: "Compress this concept to its summary",
      checkCallback: (checking) => {
        const c = activeConcept();
        const state = compressionState(c?.fm);
        const ok = !!c && !state.compressed && !!state.summary;
        if (ok && !checking) {
          new ConfirmModal(this.app, "Compress this concept", [
            "The body is replaced by the summary. The original text is kept in extensions.original_content, and the ## Relationships and ## Citations sections stay.",
            "“Restore original content” undoes it.",
          ], "Compress", () => this.manager.applyFix(c.file, { label: "Compress", transform: "compress" })).open();
        }
        return ok;
      },
    });
    this.addCommand({
      id: "decompress",
      name: "Restore original content of a compressed concept",
      checkCallback: (checking) => {
        const c = activeConcept();
        const ok = !!c && compressionState(c.fm).hasOriginal;
        if (ok && !checking) void this.manager.applyFix(c.file, { label: "Restore original content", transform: "decompress" });
        return ok;
      },
    });

    // Reading view: compressed concepts open with their summary / original (§5.6).
    this.registerMarkdownPostProcessor((el, ctx) => {
      const a = this.manager.get(ctx.sourcePath);
      if (!a?.isConcept || !a.frontmatter || !compressionState(a.frontmatter).compressed) return;
      // Decide once the section is attached: before that, Obsidian usually
      // has no section info and the element has no siblings to inspect.
      const child = new MarkdownRenderChild(el);
      let tries = 0;
      const place = () => {
        if (el.querySelector(":scope > .mif-compressed")) return;
        const first = isFirstBodySection(el, ctx.getSectionInfo(el));
        if (first === undefined && tries++ < 20) {
          window.requestAnimationFrame(place);
          return;
        }
        if (!first) return;
        const banner = createDiv();
        if (renderCompressed(this.app, banner, a.frontmatter!, a.body ?? "", ctx.sourcePath, child)) {
          el.prepend(...Array.from(banner.childNodes));
          this.manager.debug("compressed-banner", { path: ctx.sourcePath, tries });
        }
      };
      child.onload = () => place();
      ctx.addChild(child);
    });

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

    // Obsidian's (undocumented) mobile emulation, so the
    // plugin can be checked in the phone layout without the developer console.
    this.addCommand({
      id: "toggle-mobile-emulation",
      name: "Toggle mobile emulation (developer)",
      checkCallback: (checking) => {
        const app = this.app as unknown as { emulateMobile?: (on: boolean) => void; isMobile?: boolean };
        const ok = this.settings.showDevCommands && typeof app.emulateMobile === "function";
        if (ok && !checking) app.emulateMobile!(!Platform.isMobile);
        return ok;
      },
    });
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

  /** The active note's bundle; otherwise (no note, or a .base / canvas open) the first bundle. */
  private activeRoot(): string | undefined {
    const file = this.app.workspace.getActiveFile();
    return (file ? this.manager.rootFor(file.path) : null) ?? this.manager.bundleRoots()[0];
  }

  /** Entity types and folders the bundle's concepts use, for the search dialog's filters. */
  private searchFilters(root: string): SearchFilters {
    const types = new Set<string>();
    const folders = new Set<string>();
    for (const a of this.manager.all()) {
      if (a.root !== root || !a.isConcept) continue;
      const t = (a.frontmatter?.entity as { entity_type?: unknown } | undefined)?.entity_type;
      if (typeof t === "string" && t) types.add(t);
      const parts = a.path.split("/").slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const folder = parts.slice(0, i).join("/");
        if (folder.length > root.length) folders.add(folder);
      }
    }
    return { entityTypes: [...types].sort(), folders: [...folders].sort() };
  }

  /** List what a prune would remove from a bundle's store, and remove it once confirmed. */
  async pruneStore(root: string): Promise<void> {
    const ids = await this.cli.prunable(root);
    if (!Array.isArray(ids)) {
      new Notice(`MIF: ${problemText(ids)}`, 10_000);
      return;
    }
    if (!ids.length) {
      new Notice("MIF: nothing to prune. Every stored document still has its note.");
      return;
    }
    new ConfirmModal(this.app, "Prune the vector store", [
      `${ids.length} stored document${ids.length === 1 ? " has" : "s have"} no note in ${root || "the vault bundle"} any more. Pruning removes their vectors from .mif/vectors.db; no note is touched.`,
      ids.slice(0, 8).join(", ") + (ids.length > 8 ? ", …" : ""),
    ], "Prune", async () => {
      const removed = await this.cli.prune(root);
      new Notice(Array.isArray(removed) ? `MIF: pruned ${removed.length} document${removed.length === 1 ? "" : "s"} from the vector store.` : `MIF: ${problemText(removed)}`, 8000);
    }).open();
  }

  /** Open the add (index undefined) or edit dialog for a concept's relationship; `targetVaultPath` preselects the target of a new one. */
  editRelationship(file: TFile, index?: number, targetVaultPath?: string): void {
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
      : { type: "relates-to", style: "path", ...(targetVaultPath ? { targetPath: this.manager.toBundlePath(info.root, targetVaultPath) } : {}) };
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
      .setDesc("Observe validates and offers fixes. Sync also updates `modified`, the ## Relationships mirror, and an existing ## Citations section of a concept you edited, once you leave it.")
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

    new Setting(containerEl).setName("Freshness").setHeading();
    new Setting(containerEl)
      .setName("Thresholds")
      .setDesc("Decay strength for “fresh” and “ageing”; below the second is “stale”. The spec defines no bands.")
      .addText((t) =>
        t.setValue(String(s.freshThreshold)).onChange(async (v) => {
          const n = Number(v);
          if (n > 0 && n <= 1) {
            s.freshThreshold = n;
            await this.plugin.saveSettings();
            this.plugin.manager.trigger("changed", null);
          }
        }),
      )
      .addText((t) =>
        t.setValue(String(s.ageingThreshold)).onChange(async (v) => {
          const n = Number(v);
          if (n >= 0 && n < s.freshThreshold) {
            s.ageingThreshold = n;
            await this.plugin.saveSettings();
            this.plugin.manager.trigger("changed", null);
          }
        }),
      );
    new Setting(containerEl)
      .setName("Freshness dots in the file explorer")
      .setDesc("Colours concepts by freshness. Uses an undocumented Obsidian API and turns itself off quietly if that changes.")
      .addToggle((t) =>
        t.setValue(s.explorerBadges).onChange(async (v) => {
          s.explorerBadges = v;
          await this.plugin.saveSettings();
          this.plugin.manager.trigger("changed", null);
        }),
      );
    new Setting(containerEl)
      .setName("Track access")
      .setDesc("When you open a concept, update temporal.accessCount and lastAccessed (at most hourly per note). Off by default because it writes on read.")
      .addToggle((t) =>
        t.setValue(s.accessTracking).onChange(async (v) => {
          s.accessTracking = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Export and interoperability").setHeading();
    new Setting(containerEl)
      .setName("JSON-LD export folder")
      .setDesc("Exports go to <folder>/<bundle name>/<path>.jsonld (spec §3.2). They are derived output: if this vault is a git repository, ignore this folder rather than committing it with the bundle.")
      .addText((t) =>
        t.setPlaceholder("dist/jsonld").setValue(s.exportFolder).onChange(async (v) => {
          s.exportFolder = v.trim().replace(/^\/+|\/+$/g, "") || "dist/jsonld";
          await this.plugin.saveSettings();
        }),
      );
    const cliSetting = new Setting(containerEl)
      .setName("mif-cli path (desktop)")
      .setDesc("Optional. Absolute path to mif-rs's mif-cli, version 0.13.0 or later, for ingest, semantic search, find-similar, the coverage panel, and the gap report. When empty, the plugin looks for mif-cli on the system search path, then in ~/.cargo/bin, /opt/homebrew/bin, and /usr/local/bin, and the mif-cli commands stay hidden until it is found. Test shows which binary is used. On first ingest mif-cli downloads its embedding model (all-MiniLM-L6-v2) from Hugging Face.")
      .addText((t) =>
        t.setPlaceholder("Empty: look it up").setValue(s.mifCliPath).onChange(async (v) => {
          s.mifCliPath = v.trim();
          await this.plugin.saveSettings();
        }),
      )
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          const found0 = this.plugin.cli.lookup();
          if ("searched" in found0) {
            new Notice(`MIF: ${this.plugin.cli.unavailable() ?? "mif-cli was not found."}`);
            return;
          }
          try {
            const found = this.plugin.cli.lookup();
            const version = await this.plugin.cli.version();
            const old = this.plugin.cli.unavailable();
            new Notice(`MIF: found ${version}${"bin" in found ? ` at ${found.bin}` : ""}.${old ? ` ${old}` : ""}`, old ? 10_000 : undefined);
          } catch (err) {
            new Notice(`MIF: mif-cli did not run — ${(err as Error).message}`, 10_000);
          }
        }),
      );
    if (!Platform.isDesktopApp) cliSetting.setDisabled(true);
    new Setting(containerEl)
      .setName("Background ingest")
      .setDesc("Keep a bundle's existing vector store current: ingest a concept a few seconds after it is added or changed, and catch up when Obsidian starts. It updates the store only and never writes to a note. It does not start a store: ingest the bundle once first.")
      .addToggle((t) =>
        t.setValue(s.backgroundIngest).onChange(async (v) => {
          s.backgroundIngest = v;
          await this.plugin.saveSettings();
          if (v) void this.plugin.cli.reconcile();
        }),
      );
    new Setting(containerEl)
      .setName("Write the embedding reference into notes")
      .setDesc("After an ingest you start, record the model, its version, the dimensions, and the vector's address in the note's `embedding` block, once you have left the note. Off leaves notes untouched; the vector store is the same either way. Background ingest never writes it.")
      .addToggle((t) =>
        t.setValue(s.writeEmbeddingReference).onChange(async (v) => {
          s.writeEmbeddingReference = v;
          await this.plugin.saveSettings();
        }),
      );
    const threshold = (name: string, desc: string, key: "duplicateThreshold" | "similarThreshold" | "mislinkThreshold") =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
        t.setValue(String(s[key])).onChange(async (v) => {
          const n = Number(v);
          if (v.trim() !== "" && n >= 0 && n <= 1) {
            s[key] = n;
            await this.plugin.saveSettings();
          }
        }),
      );
    threshold("Duplicate threshold", "Cosine similarity, 0 to 1, at or above which a new concept is reported as a likely duplicate of an existing one.", "duplicateThreshold");
    threshold("Similar threshold", "Cosine similarity at or above which two concepts with no typed relationship appear in the relationship gap report and the related panel offers to link them.", "similarThreshold");
    threshold("Mislink threshold", "Cosine similarity at or below which a typed relationship appears in the gap report as a possible mislink.", "mislinkThreshold");

    const mcpStatus = () => {
      const st = this.plugin.mcp.status;
      return st.state === "running" ? `Running at ${st.url}.` : st.state === "failed" ? st.reason : "Off.";
    };
    const mcpDesc = () => `Serve this vault's concepts, typed relationships, and semantic search to MCP clients on this computer only (127.0.0.1). Read-only. Each vault has its own port and token. ${mcpStatus()}`;
    const mcpApply = async () => {
      await this.plugin.saveSettings();
      const status = await this.plugin.mcp.sync();
      if (status.state === "failed") new Notice(`MIF: ${status.reason}`, 10_000);
      mcpSetting.setDesc(mcpDesc());
      showMcpToggle();
    };
    // The switch shows whether the server is serving, not only whether it is
    // wanted: after a start that failed (a port in use) it reads off, and the
    // description says why. The setting stays on, so a free port, or the
    // switch, starts it.
    const serving = () => mcpServing(s.mcpEnabled, this.plugin.mcp.status);
    let mcpSwitch: SwitchMirror | undefined;
    const showMcpToggle = () => mcpSwitch?.show(serving());
    const mcpSetting = new Setting(containerEl)
      .setName("MCP server (desktop)")
      .setDesc(mcpDesc())
      .addToggle((t) => {
        mcpSwitch = new SwitchMirror(t);
        t.setValue(serving()).onChange(async (v) => {
          if (mcpSwitch?.showing) return;
          s.mcpEnabled = v;
          if (v && !s.mcpToken) s.mcpToken = newToken();
          await mcpApply();
        });
      });
    if (!Platform.isDesktopApp) mcpSetting.setDisabled(true);
    new Setting(containerEl)
      .setName("MCP port")
      .setDesc("The port this vault's MCP server listens on. Two open vaults need two different ports. If the port is in use, the server stays off.")
      .addText((t) => {
        t.setValue(String(s.mcpPort));
        t.inputEl.addEventListener("blur", () => {
          const n = Number(t.getValue());
          if (!Number.isInteger(n) || n < 1024 || n > 65535 || n === s.mcpPort) return void t.setValue(String(s.mcpPort));
          s.mcpPort = n;
          void mcpApply();
        });
      });
    new Setting(containerEl)
      .setName("MCP token")
      .setDesc("An MCP client must send this token. Regenerate replaces it at once; clients using the old one stop working.")
      .addButton((b) =>
        b.setButtonText("Copy client command").onClick(async () => {
          if (!s.mcpToken) return void new Notice("MIF: turn the MCP server on first; that creates the token.");
          const name = `mif-vault-${slugify(this.app.vault.getName()) || "vault"}`;
          await navigator.clipboard.writeText(`claude mcp add --transport http ${name} http://127.0.0.1:${s.mcpPort}/mcp --header "Authorization: Bearer ${s.mcpToken}"`);
          new Notice("MIF: copied the command that adds this vault to Claude Code. It contains the token.");
        }),
      )
      .addButton((b) =>
        b.setButtonText("Regenerate").onClick(async () => {
          s.mcpToken = newToken();
          await mcpApply();
        }),
      );
    new Setting(containerEl)
      .setName("Vault purpose")
      .setDesc("One line telling an agent what this vault's memory is for, so it can choose between vaults.")
      .addText((t) =>
        t.setValue(s.mcpPurpose).onChange(async (v) => {
          s.mcpPurpose = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Developer commands")
      .setDesc("Show the developer spike commands. They write only under _spike/.")
      .addToggle((t) =>
        t.setValue(s.showDevCommands).onChange(async (value) => {
          s.showDevCommands = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}
