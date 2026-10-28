// Optional bridge to mif-rs's `mif-cli` (desktop only; the binary comes from
// the mif-cli path setting, else from PATH and the usual install folders, see
// `findMifCli`). `ingest` embeds a concept into the bundle's
// `.mif/vectors.db` (the CLI downloads its embedding model from Hugging Face
// on first use); `search` and `find-similar` rank ingested concepts. The
// binary runs with an argument list, never through a shell.

import { FileSystemAdapter, Modal, Notice, Platform, Setting, TFile, type App } from "obsidian";

import { embeddingReference, idFromUrn, parseIngest, parseProblem, parseScored, parseStats, type IngestResult, type Problem, type ScoredId } from "./engine";
import type { MifManager } from "./manager";
import type { MifSettings } from "./settings";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

type ExecFile = (file: string, args: string[], opts: { cwd?: string; timeout: number; maxBuffer: number }, cb: (err: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void) => void;

/** What `findMifCli` needs from the machine. */
export interface LookupEnv {
  /** The PATH environment variable. */
  path: string;
  home: string;
  windows: boolean;
  /** Whether a path is an executable file. */
  isExecutable: (file: string) => boolean;
}

/** The binary to run, or every folder searched without finding one. */
export type CliLookup = { bin: string } | { searched: string[] };

/**
 * Resolve the mif-cli binary. A non-empty setting wins and is used as given,
 * without consulting the machine.
 * Otherwise the PATH entries are searched, then the usual install folders:
 * Obsidian started from the macOS Dock or Finder gets launchd's minimal PATH,
 * not the login shell's, so a cargo or Homebrew install would not be on it.
 * The folders are listed rather than asking the login shell for its PATH,
 * because that runs the user's shell startup files, takes hundreds of
 * milliseconds, and is asynchronous, while `unavailable` must answer
 * synchronously for command palette checks. Relative PATH entries are
 * skipped: mif-cli runs with the vault as its working directory, so `.` would
 * resolve inside the vault.
 */
export function findMifCli(setting: string, machine: () => LookupEnv): CliLookup {
  const configured = setting.trim();
  if (configured) return { bin: configured };
  const env = machine();
  const sep = env.windows ? "\\" : "/";
  const absolute = env.windows ? /^(?:[A-Za-z]:)?[\\/]/ : /^\//;
  const usual = env.windows
    ? [env.home && `${env.home}\\.cargo\\bin`]
    : [env.home && `${env.home}/.cargo/bin`, "/opt/homebrew/bin", "/usr/local/bin"];
  const dirs = [...env.path.split(env.windows ? ";" : ":"), ...usual]
    .map((d) => (d ?? "").replace(/[\\/]+$/, ""))
    .filter((d, i, all) => d && absolute.test(d) && all.indexOf(d) === i);
  const name = env.windows ? "mif-cli.exe" : "mif-cli";
  for (const dir of dirs) {
    const bin = `${dir}${sep}${name}`;
    if (env.isExecutable(bin)) return { bin };
  }
  return { searched: dirs };
}

export const notFoundText = (searched: string[]) =>
  `mif-cli was not found on PATH or in the usual install folders (looked in ${searched.join(", ") || "no folders"}). Set its path in Settings → MIF → mif-cli path.`;

/** The real machine, through Electron's Node. Desktop only. */
function systemEnv(): LookupEnv {
  const fs = window.require("fs") as typeof import("fs");
  const os = window.require("os") as typeof import("os");
  const proc = window.require("process") as typeof import("process");
  return {
    path: proc.env.PATH ?? "",
    home: os.homedir(),
    windows: Platform.isWin,
    isExecutable: (file) => {
      try {
        if (!fs.statSync(file).isFile()) return false;
        if (!Platform.isWin) fs.accessSync(file, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface Hit extends ScoredId {
  /** Vault path of the concept, when it is in the vault. */
  path?: string;
  title?: string;
}

export class MifCli {
  constructor(private readonly app: App, private readonly manager: MifManager, private readonly settings: () => MifSettings, private readonly exec?: ExecFile, private readonly env?: () => LookupEnv) {}

  /** The binary to run; looked up on each call so a later install is found without a restart. */
  lookup(): CliLookup {
    return findMifCli(this.settings().mifCliPath, this.env ?? systemEnv);
  }

  /** Why the bridge cannot run, or undefined when it can. */
  unavailable(): string | undefined {
    if (!this.exec && !Platform.isDesktopApp) return "The mif-cli bridge is desktop only.";
    if (!this.exec && !(this.app.vault.adapter instanceof FileSystemAdapter)) return "The vault is not on the local file system.";
    const found = this.lookup();
    if ("searched" in found) return notFoundText(found.searched);
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
    const found = this.lookup();
    if ("searched" in found) return Promise.resolve({ code: -1, stdout: "", stderr: notFoundText(found.searched) });
    return new Promise((resolve) => {
      this.execFile()(found.bin, ["--format", "json", ...args], { cwd: this.abs(""), timeout: 10 * 60_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
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
    if (r.code === 0) {
      const result = parseIngest(r.stdout);
      if (!result) return { title: "Unexpected mif-cli output", detail: r.stdout.slice(0, 200) };
      // The store knows the vector; the concept records what it was embedded with.
      if (result.stored && result.embedding && result.id) await this.manager.recordEmbedding(file, embeddingReference(result.embedding, result.id));
      return result;
    }
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
