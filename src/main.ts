// MIF for Obsidian — skeleton.
//
// Ships: settings (Observe/Sync mode, decision D3), a status-bar check of
// the active note through the engine, and the spike commands
// (developer-only, behind a setting). replaces the status-bar check
// with full level detection and diagnostics.

import { Notice, Plugin, PluginSettingTab, Setting, TFile, type App } from "obsidian";

import { mdToJsonLd, parseMarkdown, projectionConflicts, validateJsonLd } from "./engine";
import { runFidelitySpike } from "./spikes/fidelity";
import { runLinkSpike } from "./spikes/links";

export type SyncMode = "observe" | "sync";

interface MifSettings {
  mode: SyncMode;
  /** Vault-relative folder treated as the bundle root; "" means the vault. */
  bundleRoot: string;
  showDevCommands: boolean;
}

const DEFAULT_SETTINGS: MifSettings = {
  mode: "observe",
  bundleRoot: "",
  showDevCommands: false,
};

export default class MifPlugin extends Plugin {
  override settings: MifSettings = DEFAULT_SETTINGS;
  private statusEl?: HTMLElement;

  override async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<MifSettings> | null) };
    this.addSettingTab(new MifSettingTab(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.registerEvent(this.app.workspace.on("file-open", (file) => void this.refreshStatus(file)));
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file === this.app.workspace.getActiveFile()) void this.refreshStatus(file);
      }),
    );
    this.app.workspace.onLayoutReady(() => void this.refreshStatus(this.app.workspace.getActiveFile()));

    this.registerSpikeCommands();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** check: does the active note parse, project, and validate? */
  private async refreshStatus(file: TFile | null): Promise<void> {
    const el = this.statusEl;
    if (!el) return;
    el.empty();
    if (!file || file.extension !== "md" || !this.inBundle(file)) return;
    const text = await this.app.vault.cachedRead(file);
    let label: string;
    let detail: string;
    try {
      const { frontmatter, body } = parseMarkdown(text);
      const issues = validateJsonLd(mdToJsonLd(frontmatter, body));
      const conflicts = projectionConflicts(frontmatter);
      label = issues.length ? `MIF ✗ ${issues.length}` : conflicts.length ? "MIF ⚠" : "MIF ✓";
      detail = [...issues.map((i) => `${i.path}: ${i.message}`), ...conflicts].join("\n") || "Valid MIF concept";
    } catch (err) {
      label = "MIF –";
      detail = (err as Error).message;
    }
    el.setText(label);
    el.setAttr("aria-label", detail);
    el.setAttr("data-tooltip-position", "top");
  }

  private inBundle(file: TFile): boolean {
    const root = this.settings.bundleRoot.replace(/^\/+|\/+$/g, "");
    return root === "" || file.path.startsWith(`${root}/`);
  }

  private registerSpikeCommands(): void {
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
}

class MifSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: MifPlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Mode")
      .setDesc("Observe validates and offers fixes on request. Sync also keeps the body mirror and `modified` up to date on save.")
      .addDropdown((d) =>
        d
          .addOptions({ observe: "Observe", sync: "Sync" })
          .setValue(this.plugin.settings.mode)
          .onChange(async (value) => {
            this.plugin.settings.mode = value as SyncMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Bundle root")
      .setDesc("Vault folder holding the MIF bundle. Leave empty to treat the whole vault as the bundle.")
      .addText((t) =>
        t.setPlaceholder("(vault root)").setValue(this.plugin.settings.bundleRoot).onChange(async (value) => {
          this.plugin.settings.bundleRoot = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Developer commands")
      .setDesc("Show the spike commands in the command palette. They write only under _spike/.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showDevCommands).onChange(async (value) => {
          this.plugin.settings.showDevCommands = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}
