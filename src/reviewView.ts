// The Review panel: concepts an MCP client wrote that nobody has reviewed yet
// (provenance sourceType agent_inferred, trustLevel uncertain). The user
// promotes one by giving it a trust level, or rejects it, which moves it to
// the trash.

import { ItemView, Modal, Notice, Setting, TFile, type App, type WorkspaceLeaf } from "obsidian";

import { BUILD_ID } from "./build";
import type { MifManager } from "./manager";
import type { VaultMcpHost } from "./mcpHost";
import { DEFAULT_REVIEW_LEVEL, REVIEW_LEVELS, type ReviewLevel } from "./mcpWrites";
import { ConfirmModal } from "./modals";
import { openAtLine } from "./views";

export const REVIEW_VIEW = "mif-review";

const LEVEL_LABEL: Record<ReviewLevel, string> = {
  verified: "Verified",
  user_stated: "User stated",
  high_confidence: "High confidence",
  moderate_confidence: "Moderate confidence",
  low_confidence: "Low confidence",
};

export interface ReviewHost {
  manager: MifManager;
  mcpHost: VaultMcpHost;
}

/** Give one agent-written concept a trust level; then tell the user. */
export async function promoteConcept(host: ReviewHost, path: string, title: string, level: ReviewLevel): Promise<boolean> {
  const ok = await host.mcpHost.promote(path, level);
  if (ok) new Notice(`MIF: ${title} is now trusted as "${LEVEL_LABEL[level].toLowerCase()}".`);
  return ok;
}

/** Ask before moving an agent-written concept to the trash. */
export function confirmReject(app: App, host: ReviewHost, path: string, title: string, after: () => void = () => undefined): void {
  new ConfirmModal(app, "Reject this concept", [`Move "${title}" to the trash?`, "You can restore it from the trash. If it superseded a concept, that concept becomes valid again."], "Move to trash", async () => {
    if (await host.mcpHost.reject(path)) new Notice(`MIF: moved ${title} to the trash.`);
    after();
  }).open();
}

/** The promote command's dialog: pick the trust level, "user stated" by default. */
export class PromoteModal extends Modal {
  private level: ReviewLevel = DEFAULT_REVIEW_LEVEL;
  constructor(app: App, private readonly host: ReviewHost, private readonly path: string, private readonly title: string) {
    super(app);
  }
  override onOpen() {
    this.setTitle("Promote this concept");
    this.contentEl.createEl("p", { text: `"${this.title}" was written or edited by an MCP client. Choose the trust to give it; who did so stays on record.` });
    new Setting(this.contentEl).setName("Trust level").addDropdown((d) => {
      for (const l of REVIEW_LEVELS) d.addOption(l, LEVEL_LABEL[l]);
      d.setValue(this.level).onChange((v) => (this.level = v as ReviewLevel));
    });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText("Promote").setCta().onClick(async () => {
          b.setDisabled(true);
          await promoteConcept(this.host, this.path, this.title, this.level);
          this.close();
        }),
      );
  }
  override onClose() {
    this.contentEl.empty();
  }
}

export class ReviewView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly host: ReviewHost) {
    super(leaf);
  }
  override getViewType() {
    return REVIEW_VIEW;
  }
  override getDisplayText() {
    return "MIF agent review";
  }
  override getIcon() {
    return "bot";
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
    const items = this.host.mcpHost.reviewItems();
    el.createEl("p", {
      cls: "mif-muted",
      text: items.length
        ? `${items.length} concept${items.length === 1 ? "" : "s"} written or edited by an MCP client and not yet reviewed. Until you review one, recall states its trust as "uncertain".`
        : "Nothing is waiting for review. Concepts an MCP client writes, edits or merges appear here.",
    });
    if (!items.length) return;
    // One block per concept, not a table: the panel is usually a narrow sidebar.
    const list = el.createDiv({ cls: "mif-review" });
    for (const { concept, agent, created } of items) {
      const item = list.createDiv({ cls: "mif-review-item" });
      const link = item.createEl("a", { text: concept.title, href: "#" });
      link.onclick = (e) => {
        e.preventDefault();
        const file = this.app.vault.getAbstractFileByPath(concept.path);
        if (file instanceof TFile) void openAtLine(this, file);
      };
      item.createDiv({ cls: "mif-muted", text: [`By ${agent}`, created ? created.slice(0, 10) : "", concept.path].filter(Boolean).join(" · ") });
      const actions = item.createDiv({ cls: "mif-review-actions" });
      const level = actions.createEl("select", { cls: "dropdown", attr: { "aria-label": "Trust level to give this concept" } });
      for (const l of REVIEW_LEVELS) level.createEl("option", { value: l, text: LEVEL_LABEL[l] });
      level.value = DEFAULT_REVIEW_LEVEL;
      const promote = actions.createEl("button", { text: "Promote", cls: "mod-cta" });
      promote.onclick = async () => {
        promote.disabled = true;
        await promoteConcept(this.host, concept.path, concept.title, level.value as ReviewLevel);
        this.render();
      };
      const reject = actions.createEl("button", { text: "Reject", cls: "mod-warning" });
      reject.onclick = () => confirmReject(this.app, this.host, concept.path, concept.title, () => this.render());
    }
    el.createEl("p", { cls: "mif-build", text: `MIF build ${BUILD_ID}` });
  }
}
