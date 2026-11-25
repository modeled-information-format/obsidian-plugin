// Optional bridge to mif-rs's `mif-cli` 0.13.0 or later (desktop only; the
// binary comes from the mif-cli path setting, else from PATH and the usual
// install folders, see `findMifCli`). `ingest` embeds a concept into the
// bundle's `.mif/vectors.db` (the CLI downloads its embedding model from
// Hugging Face on first use); `search` and `find-similar` rank ingested
// concepts, and `prune` drops documents whose note is gone. What the plugin
// ingested is recorded in `.mif/ingest-ledger.json`, since the CLI cannot
// list its store. The binary runs with an argument list, never through a
// shell.

import { FileSystemAdapter, MarkdownView, Modal, Notice, Platform, Setting, TFile, type App } from "obsidian";

import {
  conceptHash, coverage, embeddingReference, idFromUrn, MIN_CLI_VERSION, pairKey, parseIngest, parseIngestBatch, parseMatches, parseProblem, parsePrune, parseScored,
  parseStats, parseVersion, passageLine, relationshipGaps, snippet, versionAtLeast,
  type Coverage, type GapPair, type IngestResult, type Ledger, type Match, type Problem, type StoreStats,
} from "./engine";
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

export interface Hit extends Match {
  /** Vault path of the concept, when it is in the vault. */
  path?: string;
}

export interface SearchOptions {
  limit?: number;
  /** Only concepts whose `entity.entity_type` is exactly this. */
  entityType?: string;
  /** Only concepts in this vault folder or below it. */
  folder?: string;
  /** Rank by cosine similarity alone; the default is the CLI's hybrid ranking. */
  semantic?: boolean;
}

export interface BundleIngest {
  stored: number;
  unchanged: number;
  failed: Array<{ path: string; problem: Problem }>;
}

/** What the bundle report shows about a bundle's vector store. */
export interface StoreStatus {
  stats?: StoreStats;
  /** Ids the store holds whose note is gone from the bundle. */
  prunable: string[];
  coverage: Coverage;
}

export interface GapReport {
  unlinked: Array<GapPair & { aPath?: string; bPath?: string }>;
  mislinks: Array<GapPair & { aPath?: string; bPath?: string }>;
  /** Concepts compared (those the store holds). */
  compared: number;
}

const LEDGER_FILE = ".mif/ingest-ledger.json";
const versionText = (v: [number, number, number]) => v.join(".");

export class MifCli {
  /** Version reported by each binary that has been run, by path. */
  private readonly versions = new Map<string, [number, number, number] | null>();
  private readonly ledgers = new Map<string, Ledger>();
  private readonly timers = new Map<string, number>();
  /** The last command queued for each store, so only one mif-cli touches a store at a time. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Notes with a background ingest queued or running, by path. */
  private readonly ingesting = new Set<string>();
  /** Notes mif-cli refused on their last ingest, by bundle root then vault path. */
  private readonly refused = new Map<string, Map<string, Problem>>();
  private readonly listeners = new Set<() => void>();
  /** Bumped whenever the store or the ledger changes, so views know to refresh. */
  revision = 0;

  constructor(private readonly app: App, private readonly manager: MifManager, private readonly settings: () => MifSettings, private readonly exec?: ExecFile, private readonly env?: () => LookupEnv) {}

  /** Call `fn` whenever the store or ledger changes; returns the unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.revision++;
    for (const fn of this.listeners) fn();
  }

  /** The binary to run; looked up on each call so a later install is found without a restart. */
  lookup(): CliLookup {
    return findMifCli(this.settings().mifCliPath, this.env ?? systemEnv);
  }

  /** Why the bridge cannot run, or undefined when it can (or its version is not known yet). */
  unavailable(): string | undefined {
    if (!this.exec && !Platform.isDesktopApp) return "The mif-cli bridge is desktop only.";
    if (!this.exec && !(this.app.vault.adapter instanceof FileSystemAdapter)) return "The vault is not on the local file system.";
    const found = this.lookup();
    if ("searched" in found) return notFoundText(found.searched);
    return this.tooOld(this.versions.get(found.bin));
  }

  private tooOld(v: [number, number, number] | null | undefined): string | undefined {
    if (v === undefined) return undefined;
    if (v === null) return "mif-cli did not report its version.";
    return versionAtLeast(v) ? undefined : `mif-cli ${versionText(v)} was found, and ${versionText(MIN_CLI_VERSION)} or later is needed. Update it (cargo install mif-cli).`;
  }

  /** Run `--version` once per binary; resolves to why the bridge cannot be used, or undefined. */
  async checkVersion(): Promise<string | undefined> {
    const found = this.lookup();
    if ("searched" in found) return notFoundText(found.searched);
    if (!this.versions.has(found.bin)) {
      const r = await this.spawn(found.bin, ["--version"]);
      this.versions.set(found.bin, r.code === 0 ? (parseVersion(r.stdout) ?? null) : null);
    }
    return this.tooOld(this.versions.get(found.bin));
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

  private spawn(bin: string, args: string[]): Promise<Run> {
    return new Promise((resolve) => {
      this.execFile()(bin, ["--format", "json", ...args], { cwd: this.abs(""), timeout: 10 * 60_000, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
        if (err && typeof err.code !== "number") stderr = `${stderr}\n${err.message}`;
        this.manager.debug("mif-cli", { args, code, stderr: stderr.slice(0, 300) });
        resolve({ code, stdout, stderr });
      });
    });
  }

  /**
   * Run a command, refusing a binary older than the bridge supports.
   * Commands against one store run one at a time, in the order asked: the
   * store is a SQLite file with no busy timeout, so two mif-cli processes
   * at once can fail with "database is locked".
   */
  private async run(args: string[]): Promise<Run> {
    const why = await this.checkVersion();
    if (why) return { code: -1, stdout: "", stderr: why };
    const db = args.indexOf("--db-path");
    const store = db === -1 ? "" : (args[db + 1] ?? "");
    const next = (this.queues.get(store) ?? Promise.resolve()).then(() => {
      const found = this.lookup();
      return "bin" in found ? this.spawn(found.bin, args) : { code: -1, stdout: "", stderr: notFoundText(found.searched) };
    });
    const settled = next.catch(() => undefined);
    this.queues.set(store, settled);
    void settled.then(() => {
      if (this.queues.get(store) === settled) this.queues.delete(store);
    });
    return next;
  }

  private fail(r: Run): Problem {
    return parseProblem(r.stderr) ?? { title: r.code === -1 ? r.stderr.trim() || "mif-cli did not run" : `mif-cli exited ${r.code}`, ...(r.code === -1 ? {} : { detail: r.stderr.trim().slice(0, 300) }) };
  }

  private dbPath(root: string): string {
    return `${root ? `${root}/` : ""}.mif/vectors.db`;
  }

  async version(): Promise<string> {
    const found = this.lookup();
    if ("searched" in found) throw new Error(notFoundText(found.searched));
    const r = await this.spawn(found.bin, ["--version"]);
    if (r.code !== 0) throw new Error(problemText(parseProblem(r.stderr)) ?? (r.stderr.trim() || `exit ${r.code}`));
    this.versions.set(found.bin, parseVersion(r.stdout) ?? null);
    return r.stdout.trim();
  }

  // --- ledger ---------------------------------------------------------------------

  private ledgerPath(root: string): string {
    return `${root ? `${root}/` : ""}${LEDGER_FILE}`;
  }

  /** What the plugin has ingested into a bundle's store, by lower-case concept id. */
  async ledger(root: string): Promise<Ledger> {
    const cached = this.ledgers.get(root);
    if (cached) return cached;
    let ledger: Ledger = {};
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.ledgerPath(root))) {
        const doc = JSON.parse(await adapter.read(this.ledgerPath(root))) as { entries?: Ledger };
        if (doc.entries && typeof doc.entries === "object") ledger = doc.entries;
      }
    } catch (err) {
      this.manager.debug("ledger-read-error", { root, message: (err as Error).message });
    }
    this.ledgers.set(root, ledger);
    return ledger;
  }

  private async saveLedger(root: string): Promise<void> {
    const adapter = this.app.vault.adapter as { write?: (p: string, d: string) => Promise<void>; mkdir?: (p: string) => Promise<void>; exists: (p: string) => Promise<boolean> };
    try {
      const dir = this.ledgerPath(root).slice(0, -"/ingest-ledger.json".length);
      if (!(await adapter.exists(dir))) await adapter.mkdir?.(dir);
      await adapter.write?.(this.ledgerPath(root), `${JSON.stringify({ version: 1, entries: this.ledgers.get(root) ?? {} }, null, 1)}\n`);
    } catch (err) {
      this.manager.debug("ledger-write-error", { root, message: (err as Error).message });
    }
  }

  /** The bundle's concepts as (id, bundle path, content hash). */
  private concepts(root: string): Array<{ id: string; path: string; hash: string }> {
    const index = this.manager.bundleInfo(root)?.index;
    if (!index) return [];
    const out: Array<{ id: string; path: string; hash: string }> = [];
    for (const c of index.concepts.values()) {
      if (typeof c.frontmatter.id === "string") out.push({ id: c.frontmatter.id, path: c.path, hash: conceptHash(c.frontmatter, c.body) });
    }
    return out;
  }

  /** The hash of a note's content as the plugin last read it. */
  private hashOf(file: TFile): string | undefined {
    const a = this.manager.get(file.path);
    return a?.frontmatter ? conceptHash(a.frontmatter, a.body ?? "") : undefined;
  }

  /**
   * Note that the store holds `file` with the content that hashed to `hash`.
   * The hash is taken before mif-cli starts, never after: a note edited
   * while mif-cli runs must still read as changed. True when the concept
   * was not in the ledger before.
   */
  private async record(root: string, file: TFile, id: string, hash: string | undefined): Promise<boolean> {
    if (!hash) return false;
    const ledger = await this.ledger(root);
    const key = idFromUrn(id).toLowerCase();
    const first = !ledger[key];
    ledger[key] = { path: this.manager.toBundlePath(root, file.path), hash, at: new Date().toISOString() };
    return first;
  }

  private refuse(root: string, path: string, problem: Problem | undefined): void {
    const map = this.refused.get(root) ?? new Map<string, Problem>();
    if (problem) map.set(path, problem);
    else map.delete(path);
    this.refused.set(root, map);
  }

  /** Notes of a bundle that mif-cli refused the last time they were ingested, with why. */
  refusals(root: string): Array<{ path: string; problem: Problem }> {
    return [...(this.refused.get(root) ?? [])].map(([path, problem]) => ({ path, problem })).sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Which concepts of a bundle are ingested, changed since, or never ingested. */
  async coverage(root: string): Promise<Coverage> {
    return coverage(this.concepts(root), await this.ledger(root));
  }

  // --- ingest ---------------------------------------------------------------------

  /**
   * Embed one concept into its bundle's vector store. A background ingest
   * skips a document the store already holds and never writes to the note.
   */
  async ingest(file: TFile, opts: { background?: boolean } = {}): Promise<IngestResult | Problem> {
    const root = this.manager.rootFor(file.path);
    if (root === null) return { title: "Not in a MIF bundle" };
    const hash = this.hashOf(file);
    const r = await this.run(["ingest", this.abs(file.path), "--db-path", this.abs(this.dbPath(root)), ...(opts.background ? ["--changed-only"] : [])]);
    if (r.code !== 0) {
      const problem = this.fail(r);
      // A refusal is about the note; a CLI that did not run is not.
      if (r.code !== -1) this.refuse(root, file.path, problem);
      this.changed();
      return problem;
    }
    const result = parseIngest(r.stdout);
    if (!result) return { title: "Unexpected mif-cli output", detail: r.stdout.slice(0, 200) };
    this.refuse(root, file.path, undefined);
    await this.afterIngest(root, [[file, result, hash]], !!opts.background);
    return result;
  }

  /** Record results in the note (when asked to) and the ledger, then warn about likely duplicates among new concepts. */
  private async afterIngest(root: string, results: Array<[TFile, IngestResult, string | undefined]>, background: boolean): Promise<void> {
    const fresh: TFile[] = [];
    for (const [file, result, hash] of results) {
      if (!result.id || (!result.stored && !result.unchanged)) continue;
      // The store knows the vector; the concept records what it was embedded with.
      if (result.stored && result.embedding && !background && this.settings().writeEmbeddingReference) {
        await this.manager.recordEmbedding(file, embeddingReference(result.embedding, result.id));
      }
      if ((await this.record(root, file, result.id, hash)) && result.stored) fresh.push(file);
    }
    await this.saveLedger(root);
    this.changed();
    // A handful of new notes is someone writing; a whole bundle is a first ingest, not news.
    if (fresh.length <= 3) for (const file of fresh) await this.warnIfDuplicate(file);
  }

  /**
   * Ingest every new or changed concept of a bundle in one run of the CLI
   * per batch. A background run never writes to a note.
   */
  async ingestBundle(root: string, progress?: (done: number, total: number) => void, opts: { background?: boolean } = {}): Promise<BundleIngest> {
    const files = this.manager.all().filter((a) => a.root === root && a.isConcept).map((a) => this.app.vault.getAbstractFileByPath(a.path)).filter((f): f is TFile => f instanceof TFile);
    const out: BundleIngest = { stored: 0, unchanged: 0, failed: [] };
    const done: Array<[TFile, IngestResult, string | undefined]> = [];
    const BATCH = 40;
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      const paths = batch.map((f) => this.abs(f.path));
      const hashes = batch.map((f) => this.hashOf(f));
      const r = await this.run(["ingest", ...paths, "--db-path", this.abs(this.dbPath(root)), "--changed-only"]);
      const results = parseIngestBatch(r.stdout, r.stderr, paths);
      // With one file a refusal is the file's own problem document, not a stderr line.
      const whole = r.code !== 0 && results.size === 0 ? this.fail(r) : undefined;
      batch.forEach((file, n) => {
        const res = results.get(paths[n]!) ?? whole ?? { title: "No result from mif-cli" };
        if ("checks" in res) {
          if (res.stored) out.stored++;
          else if (res.unchanged) out.unchanged++;
          else out.failed.push({ path: file.path, problem: { title: "Not stored" } });
          done.push([file, res, hashes[n]]);
          this.refuse(root, file.path, undefined);
        } else {
          out.failed.push({ path: file.path, problem: res });
          if (r.code !== -1) this.refuse(root, file.path, res);
        }
      });
      progress?.(Math.min(i + BATCH, files.length), files.length);
      if (r.code === -1) break;
    }
    await this.afterIngest(root, done, !!opts.background);
    return out;
  }

  /**
   * Bring every existing store up to date with its bundle: what was added
   * or changed while the plugin was not running, or by another tool. Never
   * starts a store and never writes a note.
   */
  async reconcile(): Promise<void> {
    if (this.unavailable() || (await this.checkVersion())) return;
    for (const root of this.manager.bundleRoots()) {
      if (!(await this.hasStore(root))) continue;
      const r = await this.ingestBundle(root, undefined, { background: true });
      this.manager.debug("reconcile", { root, stored: r.stored, unchanged: r.unchanged, failed: r.failed.length });
    }
  }

  /**
   * Ingest a concept a few seconds after its last change, into a store that
   * already exists (a first ingest downloads the model, so it stays a
   * command). The store is updated and the note is left alone. Requests for
   * one note collapse: a new one restarts the wait, and while an ingest of
   * the note is queued or running no second one starts.
   */
  scheduleIngest(file: TFile, delay = 5000): void {
    if (this.unavailable()) return;
    window.clearTimeout(this.timers.get(file.path));
    this.timers.set(file.path, window.setTimeout(() => {
      this.timers.delete(file.path);
      void this.backgroundIngest(file, delay);
    }, delay));
  }

  private async backgroundIngest(file: TFile, delay: number): Promise<void> {
    const root = this.manager.rootFor(file.path);
    const a = this.manager.get(file.path);
    if (root === null || !a?.isConcept || !a.frontmatter || typeof a.frontmatter.id !== "string") return;
    // The running ingest checks for later changes when it ends, and asks again itself.
    if (this.ingesting.has(file.path)) return;
    this.ingesting.add(file.path);
    let started: string | undefined;
    try {
      if (!(await this.hasStore(root))) return;
      // mif-cli reads the file on disk: wait until an open editor has saved what it holds.
      if (await this.manager.hasUnsavedText(file)) {
        this.scheduleIngest(file, delay);
        return;
      }
      started = this.hashOf(file);
      const entry = (await this.ledger(root))[a.frontmatter.id.toLowerCase()];
      if (entry?.hash === started) return;
      const r = await this.ingest(file, { background: true });
      this.manager.debug("background-ingest", { path: file.path, result: "checks" in r ? (r.stored ? "stored" : "unchanged") : r.title });
    } finally {
      this.ingesting.delete(file.path);
    }
    // Edited while mif-cli ran: the store holds the earlier text, so go again.
    if (started !== undefined && this.hashOf(file) !== started) this.scheduleIngest(file, delay);
  }

  /** Stop pending background ingests (the plugin is unloading). */
  dispose(): void {
    for (const t of this.timers.values()) window.clearTimeout(t);
    this.timers.clear();
    this.listeners.clear();
  }

  // --- store ----------------------------------------------------------------------

  /** The store must exist: searching a missing one makes the CLI create an empty file. */
  async hasStore(root: string): Promise<boolean> {
    return this.app.vault.adapter.exists(this.dbPath(root));
  }

  async stats(root: string): Promise<StoreStats | undefined> {
    if (!(await this.hasStore(root))) return { count: 0 };
    const r = await this.run(["corpus-stats", "--db-path", this.abs(this.dbPath(root))]);
    return r.code === 0 ? parseStats(r.stdout) : undefined;
  }

  private pruneArgs(root: string): string[] {
    // Excluded folders are never ingested, so a copy of a note there does not keep its document.
    const ignore = this.settings().excludedFolders.flatMap((f) => {
      const inside = root === "" ? f : f.startsWith(`${root}/`) ? f.slice(root.length + 1) : undefined;
      return inside ? ["--ignore", inside.includes("/") ? `${inside}/**` : inside] : [];
    });
    return ["prune", "--root", this.abs(root), "--db-path", this.abs(this.dbPath(root)), ...ignore];
  }

  /** Ids the store holds that no note of the bundle carries; nothing is removed. */
  async prunable(root: string): Promise<string[] | Problem> {
    if (!(await this.hasStore(root))) return [];
    const r = await this.run([...this.pruneArgs(root), "--dry-run"]);
    return r.code === 0 ? parsePrune(r.stdout) : this.fail(r);
  }

  /** Remove from the store every document whose note is gone; returns the ids removed. */
  async prune(root: string): Promise<string[] | Problem> {
    if (!(await this.hasStore(root))) return [];
    const r = await this.run(this.pruneArgs(root));
    if (r.code !== 0) return this.fail(r);
    const removed = parsePrune(r.stdout);
    const ledger = await this.ledger(root);
    for (const id of removed) delete ledger[idFromUrn(id).toLowerCase()];
    await this.saveLedger(root);
    this.changed();
    return removed;
  }

  /** Store statistics, what could be pruned, and ledger coverage, for the bundle report. */
  async status(root: string): Promise<StoreStatus> {
    const prunable = await this.prunable(root);
    return { stats: await this.stats(root), prunable: Array.isArray(prunable) ? prunable : [], coverage: await this.coverage(root) };
  }

  // --- search ---------------------------------------------------------------------

  async search(root: string, query: string, options: SearchOptions | number = {}): Promise<Hit[] | Problem> {
    const o = typeof options === "number" ? { limit: options } : options;
    if (!(await this.hasStore(root))) return { title: "Nothing ingested yet", detail: "Run “Ingest this bundle into the vector store” first." };
    const args = ["search", query, "--db-path", this.abs(this.dbPath(root)), "--limit", String(o.limit ?? 10)];
    if (o.semantic) args.push("--mode", "semantic");
    if (o.entityType) args.push("--entity-type", o.entityType);
    const folder = o.folder === undefined ? undefined : this.manager.toBundlePath(root, o.folder).replace(/^\/+|\/+$/g, "");
    if (folder) args.push("--source-prefix", `${folder}/`);
    const r = await this.run(args);
    if (r.code !== 0) return this.fail(r);
    const matches = parseMatches(r.stdout);
    if (!matches) return { title: "Unexpected mif-cli output", detail: r.stdout.slice(0, 200) };
    return this.resolve(root, matches);
  }

  async similar(file: TFile, limit = 10): Promise<Hit[] | Problem> {
    const root = this.manager.rootFor(file.path);
    const id = this.manager.get(file.path)?.frontmatter?.id;
    if (root === null || typeof id !== "string") return { title: "Not a MIF concept" };
    if (!(await this.hasStore(root))) return { title: "Nothing ingested yet", detail: "Ingest this note or its bundle first." };
    const r = await this.run(["find-similar", `urn:mif:${id}`, "--db-path", this.abs(this.dbPath(root)), "--limit", String(limit)]);
    if (r.code !== 0) return this.fail(r);
    // find-similar ranks by cosine similarity, so its score is one.
    return this.resolve(root, parseScored(r.stdout).map((m) => ({ ...m, cosine: m.score })));
  }

  private resolve(root: string, hits: Match[]): Hit[] {
    const index = this.manager.bundleInfo(root)?.index;
    return hits.map((h) => {
      const bundlePath = index?.byId.get(idFromUrn(h.id).toLowerCase());
      const concept = bundlePath ? index!.concepts.get(bundlePath) : undefined;
      const title = concept && typeof concept.frontmatter.title === "string" ? concept.frontmatter.title : h.title;
      return { ...h, ...(bundlePath ? { path: this.manager.toVaultPath(root, bundlePath) } : {}), ...(title ? { title } : {}) };
    });
  }

  /** Existing concepts whose best passage is at least as close to `text` as the duplicate threshold. */
  async duplicatesOf(root: string, text: string): Promise<Hit[]> {
    if (this.unavailable() || !text.trim() || !(await this.hasStore(root))) return [];
    const hits = await this.search(root, text, { limit: 5, semantic: true });
    return Array.isArray(hits) ? hits.filter((h) => (h.cosine ?? 0) >= this.settings().duplicateThreshold) : [];
  }

  /** After a concept's first ingest, say so when an existing concept is very similar. */
  private async warnIfDuplicate(file: TFile): Promise<void> {
    const hits = await this.similar(file, 3);
    if (!Array.isArray(hits)) return;
    const close = hits.filter((h) => (h.cosine ?? 0) >= this.settings().duplicateThreshold);
    if (!close.length) return;
    new Notice(`MIF: ${file.basename} may duplicate ${close.map((h) => `${h.title ?? h.path ?? h.id} (${(h.cosine ?? 0).toFixed(2)})`).join(", ")}.`, 12_000);
  }

  /**
   * Compare every ingested concept of a bundle with every other (one
   * `find-similar` per concept) and report pairs that look related but are
   * not, and related pairs that look unalike.
   */
  async gaps(root: string, progress?: (done: number, total: number) => void): Promise<GapReport | Problem> {
    const index = this.manager.bundleInfo(root)?.index;
    if (!index) return { title: "Not a MIF bundle" };
    if (!(await this.hasStore(root))) return { title: "Nothing ingested yet", detail: "Run “Ingest this bundle into the vector store” first." };
    const stats = await this.stats(root);
    if (!stats) return { title: "mif-cli could not read the vector store" };
    const idOf = new Map<string, string>();
    for (const [id, path] of index.byId) idOf.set(path, id);
    const similar = new Map<string, Map<string, number>>();
    const ids = [...index.concepts.values()].map((c) => c.frontmatter.id).filter((id): id is string => typeof id === "string");
    for (let i = 0; i < ids.length; i++) {
      const r = await this.run(["find-similar", `urn:mif:${ids[i]}`, "--db-path", this.abs(this.dbPath(root)), "--limit", String(Math.max(stats.count, 1))]);
      // A concept that was never ingested has no row; that is the coverage view's business.
      if (r.code === 0) similar.set(ids[i]!.toLowerCase(), new Map(parseScored(r.stdout).map((m) => [idFromUrn(m.id).toLowerCase(), m.score])));
      else if (r.code === -1) return this.fail(r);
      progress?.(i + 1, ids.length);
    }
    const related = new Set<string>();
    for (const [from, edges] of index.outgoing) {
      const a = idOf.get(from);
      for (const e of edges) {
        const b = e.resolved ? idOf.get(e.resolved) : undefined;
        if (a && b && a !== b) related.add(pairKey(a, b));
      }
    }
    const s = this.settings();
    const { unlinked, mislinks } = relationshipGaps(similar, related, s.similarThreshold, s.mislinkThreshold);
    const place = (p: GapPair) => {
      const a = index.byId.get(p.a);
      const b = index.byId.get(p.b);
      return { ...p, ...(a ? { aPath: this.manager.toVaultPath(root, a) } : {}), ...(b ? { bPath: this.manager.toVaultPath(root, b) } : {}) };
    };
    // A pair with one side outside the bundle cannot be linked from here.
    return { unlinked: unlinked.map(place).filter((p) => p.aPath && p.bPath), mislinks: mislinks.map(place), compared: similar.size };
  }
}

export const problemText = (p: Problem | undefined) => (p ? `${p.title}${p.detail ? `: ${p.detail}` : ""}` : undefined);

/** Open a hit's note at the passage that matched. */
export async function openHit(app: App, hit: Hit): Promise<void> {
  const f = hit.path ? app.vault.getAbstractFileByPath(hit.path) : null;
  if (!(f instanceof TFile)) return;
  const line = passageLine(await app.vault.cachedRead(f), hit.heading, hit.startLine);
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(f, line === undefined ? undefined : { eState: { line } });
  if (line !== undefined && leaf.view instanceof MarkdownView) {
    const editor = leaf.view.editor;
    editor.setCursor({ line, ch: 0 });
    editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
  }
}

/** What the search dialog can filter by, from the bundle's own concepts. */
export interface SearchFilters {
  entityTypes: string[];
  folders: string[];
}

/** Search box with filters and ranked results (also used for "find similar"). */
export class SearchModal extends Modal {
  private results?: HTMLElement;
  private query = "";
  private entityType = "";
  private folder = "";

  constructor(app: App, private readonly cli: MifCli, private readonly root: string, private readonly initial?: { title: string; hits: Hit[] | Problem }, private readonly filters?: SearchFilters) {
    super(app);
  }

  override onOpen() {
    this.setTitle(this.initial?.title ?? "MIF semantic search");
    if (!this.initial) {
      new Setting(this.contentEl).setName("Query").addText((t) => {
        t.setPlaceholder("What are you looking for?").onChange((v) => (this.query = v));
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void this.search();
        });
        window.setTimeout(() => t.inputEl.focus(), 0);
      }).addButton((b) => b.setButtonText("Search").setCta().onClick(() => void this.search()));
      const f = this.filters;
      if (f && (f.entityTypes.length || f.folders.length)) {
        const row = new Setting(this.contentEl).setName("Only");
        if (f.entityTypes.length) {
          row.addDropdown((d) => {
            d.addOption("", "Any entity type");
            for (const t of f.entityTypes) d.addOption(t, t);
            d.onChange((v) => {
              this.entityType = v;
              void this.search();
            });
          });
        }
        if (f.folders.length) {
          row.addDropdown((d) => {
            d.addOption("", "Any folder");
            for (const p of f.folders) d.addOption(p, p);
            d.onChange((v) => {
              this.folder = v;
              void this.search();
            });
          });
        }
      }
    }
    this.results = this.contentEl.createDiv({ cls: "mif-search-results" });
    if (this.initial) this.show(this.initial.hits);
  }

  private async search() {
    if (!this.query.trim() || !this.results) return;
    this.results.setText("Searching…");
    this.show(await this.cli.search(this.root, this.query, { entityType: this.entityType || undefined, folder: this.folder || undefined }));
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
      const item = el.createDiv({ cls: "mif-search-hit" });
      const row = item.createDiv({ cls: "mif-rel-row" });
      // Hybrid scores are rank-fusion values with no scale of their own; cosine is the readable one.
      row.createSpan({ cls: "mif-muted", text: (h.cosine ?? h.score).toFixed(2) });
      if (h.path) {
        const a = row.createEl("a", { text: h.title ?? h.path, href: "#" });
        a.onclick = (e) => {
          e.preventDefault();
          void openHit(this.app, h);
          this.close();
        };
      } else {
        row.createSpan({ text: h.title ?? h.id });
        row.createSpan({ cls: "mif-muted", text: " (not in this vault)" });
      }
      if (h.heading) row.createSpan({ cls: "mif-search-heading", text: `› ${h.heading}` });
      if (h.entityType) row.createSpan({ cls: "mif-muted", text: ` · ${h.entityType}` });
      const text = snippet(h.text, h.title);
      if (text) item.createDiv({ cls: "mif-search-snippet mif-muted", text });
    }
  }

  override onClose() {
    this.contentEl.empty();
  }
}

/** Notice for an ingest result. */
export function ingestNotice(file: TFile, r: IngestResult | Problem): void {
  if ("checks" in r) new Notice(r.stored ? `MIF: ${file.basename} ingested (${r.checks.embedding_dim ?? "?"}-dim embedding).` : r.unchanged ? `MIF: ${file.basename} is already in the vector store.` : `MIF: ${file.basename} was not stored.`);
  else new Notice(`MIF: ${file.basename} not ingested — ${problemText(r)}`, 10_000);
}
