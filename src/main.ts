// MIF for Obsidian — authoring and Level 1 validation.

import { normalizePath, Notice, Plugin, PluginSettingTab, Setting, TFile, type App } from "obsidian";

import { newConceptText, promoteToConcept, type BaseType } from "./engine";
import { MifManager } from "./manager";
import { ConvertModal, NewConceptModal, slugify, type NewConceptInput } from "./modals";
import { DEFAULT_SETTINGS, loadSettings, parseLines, type MifSettings, type SyncMode } from "./settings";
import { runFidelitySpike } from "./spikes/fidelity";
import { runLinkSpike } from "./spikes/links";
import { DIAGNOSTICS_VIEW, DiagnosticsView, REPORT_VIEW, ReportView } from "./views";

export default class MifPlugin extends Plugin {
  override settings: MifSettings = DEFAULT_SETTINGS;
  manager!: MifManager;
  private statusEl?: HTMLElement;

  override async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData());
    this.manager = new MifManager(this.app, () => this.settings);
    this.addSettingTab(new MifSettingTab(this.app, this));

    this.registerView(DIAGNOSTICS_VIEW, (leaf) => new DiagnosticsView(leaf, this));
    this.registerView(REPORT_VIEW, (leaf) => new ReportView(leaf, this));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mif-status", "mod-clickable");
    this.statusEl.onclick = () => void this.revealView(DIAGNOSTICS_VIEW);
    this.register(() => this.manager.dispose());

    this.registerCommands();
    this.addRibbonIcon("list-checks", "MIF bundle report", () => void this.revealView(REPORT_VIEW));

    this.app.workspace.onLayoutReady(async () => {
      await this.manager.loadBundles();
      await this.manager.scanAll();
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
    this.registerEvent(
      vault.on("modify", async (file) => {
        if (!(file instanceof TFile)) return;
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
    this.registerEvent(
      vault.on("rename", (file, oldPath) => {
        this.manager.forget(oldPath);
        if (file instanceof TFile) void this.manager.analyzeFile(file);
      }),
    );
  }

  async reloadBundles(): Promise<void> {
    await this.manager.loadBundles();
    await this.manager.scanAll();
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
        new NewConceptModal(this.app, root, (input) => this.createConcept(input)).open();
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
    const text = newConceptText({
      type: input.type,
      title: input.title,
      namespace: input.namespace || undefined,
      id: crypto.randomUUID(),
      created: new Date(),
    });
    const file = await this.app.vault.create(path, text);
    await this.app.workspace.getLeaf(false).openFile(file);
    if (this.manager.rootFor(path) === null) new Notice(`MIF: ${path} is outside every MIF bundle, so it won't be validated.`);
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
