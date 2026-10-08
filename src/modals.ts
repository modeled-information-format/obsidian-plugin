// Dialogs for creating a concept and promoting a note to one.

import { Modal, Notice, Setting, type App } from "obsidian";

import { BASE_TYPES, type BaseType } from "./engine";

export interface NewConceptInput {
  type: BaseType;
  title: string;
  namespace: string;
  folder: string;
}

const TYPE_HELP: Record<BaseType, string> = {
  semantic: "Semantic — facts, decisions, concepts",
  episodic: "Episodic — events, incidents, records",
  procedural: "Procedural — runbooks, how-tos",
};

export class NewConceptModal extends Modal {
  private input: NewConceptInput;

  constructor(app: App, private readonly root: string, private readonly onSubmit: (input: NewConceptInput) => Promise<void>) {
    super(app);
    this.input = { type: "semantic", title: "", namespace: "", folder: this.defaultFolder("semantic") };
  }

  private defaultFolder(type: BaseType) {
    return this.root ? `${this.root}/${type}` : type;
  }

  override onOpen() {
    this.setTitle("New MIF concept");
    let folderText: { setValue(v: string): unknown } | undefined;
    new Setting(this.contentEl).setName("Type").addDropdown((d) => {
      for (const t of BASE_TYPES) d.addOption(t, TYPE_HELP[t]);
      d.setValue(this.input.type).onChange((v) => {
        const wasDefault = this.input.folder === this.defaultFolder(this.input.type);
        this.input.type = v as BaseType;
        if (wasDefault) {
          this.input.folder = this.defaultFolder(this.input.type);
          folderText?.setValue(this.input.folder);
        }
      });
    });
    new Setting(this.contentEl).setName("Title").addText((t) => {
      t.setPlaceholder("API rate limit policy").onChange((v) => (this.input.title = v.trim()));
      window.setTimeout(() => t.inputEl.focus(), 0);
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void this.submit();
      });
    });
    new Setting(this.contentEl)
      .setName("Namespace")
      .setDesc("Optional. Setting one also adds modified and temporal, giving a Level 2 concept.")
      .addText((t) => t.setPlaceholder("_semantic/policies").onChange((v) => (this.input.namespace = v.trim())));
    new Setting(this.contentEl).setName("Folder").addText((t) => {
      folderText = t;
      t.setValue(this.input.folder).onChange((v) => (this.input.folder = v.trim().replace(/^\/+|\/+$/g, "")));
    });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("Create").setCta().onClick(() => void this.submit()));
  }

  private async submit() {
    if (!this.input.title) {
      new Notice("Give the concept a title.");
      return;
    }
    await this.onSubmit(this.input);
    this.close();
  }

  override onClose() {
    this.contentEl.empty();
  }
}

export class ConvertModal extends Modal {
  private type: BaseType = "semantic";

  constructor(app: App, private readonly name: string, private readonly onSubmit: (type: BaseType) => Promise<void>) {
    super(app);
  }

  override onOpen() {
    this.setTitle("Convert to MIF concept");
    this.contentEl.createEl("p", {
      text: `Adds id, type, and created to "${this.name}". Existing properties and the note's text are not changed.`,
    });
    new Setting(this.contentEl).setName("Type").addDropdown((d) => {
      for (const t of BASE_TYPES) d.addOption(t, TYPE_HELP[t]);
      d.setValue(this.type).onChange((v) => (this.type = v as BaseType));
    });
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Convert").setCta().onClick(async () => {
        await this.onSubmit(this.type);
        this.close();
      }),
    );
  }

  override onClose() {
    this.contentEl.empty();
  }
}

/** File-name slug for a title: lowercase words joined by hyphens. */
export const slugify = (title: string) =>
  title.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "concept";
