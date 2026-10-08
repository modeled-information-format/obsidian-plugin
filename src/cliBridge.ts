// Optional bridge to mif-rs's `mif-cli` (desktop only, off until a
// binary path is set). `ingest` embeds a concept into the bundle's
// `.mif/vectors.db` (the CLI downloads its embedding model from Hugging Face
// on first use); `search` and `find-similar` rank ingested concepts. The
// binary runs with an argument list, never through a shell.

import { FileSystemAdapter, Modal, Notice, Platform, Setting, TFile, type App } from "obsidian";

import { idFromUrn, parseIngest, parseProblem, parseScored, parseStats, type IngestResult, type Problem, type ScoredId } from "./engine";
import type { MifManager } from "./manager";
import type { MifSettings } from "./settings";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

type ExecFile = (file: string, args: string[], opts: { cwd?: string; timeout: number; maxBuffer: number }, cb: (err: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void) => void;

export interface Hit extends ScoredId {
  /** Vault path of the concept, when it is in the vault. */
  path?: string;
  title?: string;
}

export class MifCli {
  constructor(private readonly app: App, private readonly manager: MifManager, private readonly settings: () => MifSettings, private readonly exec?: ExecFile) {}

  /** Why the bridge cannot run, or undefined when it can. */
  unavailable(): string | undefined {
    if (!this.exec && !Platform.isDesktopApp) return "The mif-cli bridge is desktop only.";
    if (!this.settings().mifCliPath.trim()) return "Set the path to mif-cli in Settings → MIF.";
    if (!(this.app.vault.adapter instanceof FileSystemAdapter) && !this.exec) return "The vault is not on the local file system.";
    return undefined;
  }

  private execFile(): ExecFile {
    if (this.exec) return this.exec;
    // Electron's Node, loaded only here so mobile never touches it.
    return (window.require("child_process") as { execFile: ExecFile }).execFile;
  }

  private abs(vaultPath: string): string {
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    return typeof adapter.getFullPath === "function" ? adapter.getFullPath(vaultPath) : vaultPath;
  }

  private run(args: string[]): Promise<Run> {
    const bin = this.settings().mifCliPath.trim();
    return new Promise((resolve) => {
      this.execFile()(bin, ["--format", "json", ...args], { cwd: this.abs(""), timeout: 10 * 60_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
        if (err && typeof err.code !== "number") stderr = `${stderr}\n${err.message}`;
        this.manager.debug("mif-cli", { args, code, stderr: stderr.slice(0, 300) });
        resolve({ code, stdout, stderr });
      });
    });
  }

  private dbPath(root: string): string {
    return `${root ? `${root}/` : ""}.mif/vectors.db`;
  }

  async version(): Promise<string> {
    const r = await this.run(["--version"]);
    if (r.code !== 0) throw new Error(problemText(parseProblem(r.stderr)) ?? (r.stderr.trim() || `exit ${r.code}`));
    return r.stdout.trim();
  }

  /** Embed one concept into its bundle's vector store. */
  async ingest(file: TFile): Promise<IngestResult | Problem> {
    const root = this.manager.rootFor(file.path);
    if (root === null) return { title: "Not in a MIF bundle" };
    const r = await this.run(["ingest", this.abs(file.path), "--db-path", this.abs(this.dbPath(root))]);
    if (r.code === 0) return parseIngest(r.stdout) ?? { title: "Unexpected mif-cli output", detail: r.stdout.slice(0, 200) };
    return parseProblem(r.stderr) ?? { title: `mif-cli exited ${r.code}`, detail: r.stderr.trim().slice(0, 300) };
  }

  /** Ingest every concept of a bundle; returns how many were stored and which failed. */
  async ingestBundle(root: string, progress?: (done: number, total: number) => void): Promise<{ stored: number; failed: Array<{ path: string; problem: Problem }> }> {
    const files = this.manager.all().filter((a) => a.root === root && a.isConcept).map((a) => this.app.vault.getAbstractFileByPath(a.path)).filter((f): f is TFile => f instanceof TFile);
    let stored = 0;
    const failed: Array<{ path: string; problem: Problem }> = [];
    for (let i = 0; i < files.length; i++) {
      const r = await this.ingest(files[i]!);
      if ("checks" in r && r.stored) stored++;
      else failed.push({ path: files[i]!.path, problem: "checks" in r ? { title: "Not stored" } : r });
      progress?.(i + 1, files.length);
    }
    return { stored, failed };
  }

  /** The store must exist: searching a missing one makes the CLI create an empty file. */
  private async hasStore(root: string): Promise<boolean> {
    return this.app.vault.adapter.exists(this.dbPath(root));
  }

  async stats(root: string): Promise<{ count: number; dim?: number } | undefined> {
    if (!(await this.hasStore(root))) return { count: 0 };
    const r = await this.run(["corpus-stats", "--db-path", this.abs(this.dbPath(root))]);
    return r.code === 0 ? parseStats(r.stdout) : undefined;
  }

  async search(root: string, query: string, limit = 10): Promise<Hit[] | Problem> {
    if (!(await this.hasStore(root))) return { title: "Nothing ingested yet", detail: "Run “Ingest bundle into the vector store” first." };
    const r = await this.run(["search", query, "--db-path", this.abs(this.dbPath(root)), "--limit", String(limit)]);
    if (r.code !== 0) return parseProblem(r.stderr) ?? { title: `mif-cli exited ${r.code}` };
    return this.resolve(root, parseScored(r.stdout));
  }

  async similar(file: TFile, limit = 10): Promise<Hit[] | Problem> {
    const root = this.manager.rootFor(file.path);
    const id = this.manager.get(file.path)?.frontmatter?.id;
    if (root === null || typeof id !== "string") return { title: "Not a MIF concept" };
    if (!(await this.hasStore(root))) return { title: "Nothing ingested yet", detail: "Ingest this note or its bundle first." };
    const r = await this.run(["find-similar", `urn:mif:${id}`, "--db-path", this.abs(this.dbPath(root)), "--limit", String(limit)]);
    if (r.code !== 0) return parseProblem(r.stderr) ?? { title: `mif-cli exited ${r.code}` };
    return this.resolve(root, parseScored(r.stdout));
  }

  private resolve(root: string, hits: ScoredId[]): Hit[] {
    const index = this.manager.bundleInfo(root)?.index;
    return hits.map((h) => {
      const bundlePath = index?.byId.get(idFromUrn(h.id).toLowerCase());
      const concept = bundlePath ? index!.concepts.get(bundlePath) : undefined;
      return {
        ...h,
        path: bundlePath ? this.manager.toVaultPath(root, bundlePath) : undefined,
        title: concept && typeof concept.frontmatter.title === "string" ? concept.frontmatter.title : undefined,
      };
    });
  }
}

export const problemText = (p: Problem | undefined) => (p ? `${p.title}${p.detail ? `: ${p.detail}` : ""}` : undefined);

/** Search box and ranked results (also used for "find similar"). */
export class SearchModal extends Modal {
  private results?: HTMLElement;

  constructor(app: App, private readonly cli: MifCli, private readonly root: string, private readonly initial?: { title: string; hits: Hit[] | Problem }) {
    super(app);
  }

  override onOpen() {
    this.setTitle(this.initial?.title ?? "MIF semantic search");
    if (!this.initial) {
      let query = "";
      new Setting(this.contentEl).setName("Query").addText((t) => {
        t.setPlaceholder("What are you looking for?").onChange((v) => (query = v));
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void this.search(query);
        });
      }).addButton((b) => b.setButtonText("Search").setCta().onClick(() => void this.search(query)));
    }
    this.results = this.contentEl.createDiv({ cls: "mif-search-results" });
    if (this.initial) this.show(this.initial.hits);
  }

  private async search(query: string) {
    if (!query.trim() || !this.results) return;
    this.results.setText("Searching…");
    this.show(await this.cli.search(this.root, query));
  }

  private show(hits: Hit[] | Problem) {
    const el = this.results!;
    el.empty();
    if (!Array.isArray(hits)) {
      el.createEl("p", { cls: "mif-error-text", text: problemText(hits) });
      return;
    }
    if (!hits.length) {
      el.createEl("p", { cls: "mif-muted", text: "No matches." });
      return;
    }
    for (const h of hits) {
      const row = el.createDiv({ cls: "mif-rel-row" });
      row.createSpan({ cls: "mif-muted", text: h.score.toFixed(3) });
      if (h.path) {
        const a = row.createEl("a", { text: h.title ?? h.path, href: "#" });
        a.onclick = (e) => {
          e.preventDefault();
          const f = this.app.vault.getAbstractFileByPath(h.path!);
          if (f instanceof TFile) void this.app.workspace.getLeaf(false).openFile(f);
          this.close();
        };
      } else {
        row.createSpan({ text: h.id });
        row.createSpan({ cls: "mif-muted", text: " (not in this vault)" });
      }
    }
  }

  override onClose() {
    this.contentEl.empty();
  }
}

/** Notice for an ingest result. */
export function ingestNotice(file: TFile, r: IngestResult | Problem): void {
  if ("checks" in r) new Notice(r.stored ? `MIF: ${file.basename} ingested (${r.checks.embedding_dim ?? "?"}-dim embedding).` : `MIF: ${file.basename} was not stored.`);
  else new Notice(`MIF: ${file.basename} not ingested — ${problemText(r)}`, 10_000);
}
