// The plugin's model of the vault: which files belong to a MIF bundle, the
// latest analysis of each, and every write the plugin makes. All writes go
// through the engine's format-preserving writer.

import { Events, Notice, TFile, type App } from "obsidian";

import {
  analyze,
  detectRewrites,
  isoSeconds,
  loadYaml,
  RESERVED_FILENAMES,
  toLf,
  updateFrontmatter,
  validateBundleConfig,
  WriteError,
  type Analysis,
  type Diagnostic,
  type Fix,
  type Frontmatter,
  type Namespaces,
} from "./engine";
import type { MifSettings } from "./settings";

export interface FileAnalysis extends Analysis {
  path: string;
  root: string;
}

export interface BundleInfo {
  root: string;
  namespaces?: Namespaces;
  /** Problems with .mif/config.yaml, if it exists. */
  configIssues: string[];
}

/** Fix variant the manager handles itself: forget a reported rewrite. */
export const DISMISS = "dismiss" as const;
type ManagedFix = Fix | (Fix & { dismiss: true; path: Array<string | number> });

const getIn = (obj: unknown, path: Array<string | number>) =>
  path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string | number, unknown>)[k] : undefined), obj);


export class MifManager extends Events {
  private readonly analyses = new Map<string, FileAnalysis>();
  private readonly bundles = new Map<string, BundleInfo>();
  /** Values Obsidian rewrote out from under MIF (Spike B), per file. */
  private readonly rewrites = new Map<string, Diagnostic[]>();
  /** Files the user has typed into since their last save (Sync mode). */
  private readonly dirty = new Set<string>();
  private readonly stampTimers = new Map<string, number>();
  /** Text of each file the plugin last wrote, to ignore its own modify events. */
  private readonly ownWrites = new Map<string, string>();

  constructor(private readonly app: App, private settings: () => MifSettings) {
    super();
  }

  // --- membership -------------------------------------------------------------

  /** The bundle root a file belongs to, or null if it is not MIF territory. */
  rootFor(path: string): string | null {
    const s = this.settings();
    if (!path.endsWith(".md")) return null;
    if (RESERVED_FILENAMES.has(path.split("/").pop() ?? "")) return null;
    if (s.excludedFolders.some((f) => path === f || path.startsWith(`${f}/`))) return null;
    let best: string | null = null;
    for (const root of s.bundleRoots) {
      if ((root === "" || path.startsWith(`${root}/`)) && (best === null || root.length > best.length)) best = root;
    }
    return best;
  }

  bundleInfo(root: string): BundleInfo | undefined {
    return this.bundles.get(root);
  }

  async loadBundles(): Promise<void> {
    this.bundles.clear();
    for (const root of this.settings().bundleRoots) {
      const configPath = `${root ? `${root}/` : ""}.mif/config.yaml`;
      const info: BundleInfo = { root, configIssues: [] };
      // .mif/ is a dot-folder Obsidian does not index, so read through the adapter.
      if (await this.app.vault.adapter.exists(configPath)) {
        try {
          const config = loadYaml(await this.app.vault.adapter.read(configPath)) as { namespaces?: Namespaces } | null;
          info.configIssues = validateBundleConfig(config ?? {}).map((i) => `${configPath}${i.path}: ${i.message}`);
          info.namespaces = config?.namespaces;
        } catch (err) {
          info.configIssues = [`${configPath}: ${(err as Error).message}`];
        }
      }
      this.bundles.set(root, info);
    }
  }

  // --- analysis ---------------------------------------------------------------

  get(path: string): FileAnalysis | undefined {
    return this.analyses.get(path);
  }

  all(): FileAnalysis[] {
    return [...this.analyses.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async scanAll(): Promise<void> {
    this.analyses.clear();
    const files = this.app.vault.getMarkdownFiles().filter((f) => this.rootFor(f.path) !== null);
    for (let i = 0; i < files.length; i++) {
      await this.analyzeFile(files[i]!, { quiet: true });
      if (i % 50 === 49) await new Promise((r) => window.setTimeout(r, 0));
    }
    this.trigger("changed", null);
  }

  async analyzeFile(file: TFile, opts: { quiet?: boolean } = {}): Promise<FileAnalysis | undefined> {
    const root = this.rootFor(file.path);
    if (root === null) {
      if (this.analyses.delete(file.path) && !opts.quiet) this.trigger("changed", file.path);
      return undefined;
    }
    const text = await this.app.vault.cachedRead(file);
    let analysis: Analysis;
    try {
      analysis = analyze(text, { namespaces: this.bundles.get(root)?.namespaces });
    } catch (err) {
      // One file must never stop the scan; surface the failure on that file.
      console.error(`MIF: analysis failed for ${file.path}`, err);
      analysis = {
        isConcept: true,
        level: 0,
        diagnostics: [{ severity: "error", code: "internal", message: `MIF could not analyse this file: ${(err as Error).message}`, path: [], fixes: [] }],
      };
    }
    const previous = this.analyses.get(file.path);
    const ownWrite = this.ownWrites.get(file.path) === text;
    if (previous && analysis.frontmatter && !ownWrite) this.detectRewrites(file.path, previous, analysis.frontmatter);
    this.reconcileRewrites(file.path, analysis.frontmatter);

    const result: FileAnalysis = {
      ...analysis,
      diagnostics: [...(this.rewrites.get(file.path) ?? []), ...analysis.diagnostics],
      path: file.path,
      root,
    };
    this.analyses.set(file.path, result);
    if (!opts.quiet) this.trigger("changed", file.path);
    return result;
  }

  forget(path: string): void {
    this.analyses.delete(path);
    this.rewrites.delete(path);
    this.dirty.delete(path);
    this.ownWrites.delete(path);
    this.trigger("changed", path);
  }

  private detectRewrites(path: string, previous: FileAnalysis, now: Frontmatter): void {
    const previousAnalysis = { ...previous, diagnostics: previous.diagnostics.filter((d) => d.code !== "rewritten") };
    const found = detectRewrites(previousAnalysis, now).map((d) => ({
      ...d,
      fixes: [...d.fixes, { label: "Keep the new value", dismiss: true, path: d.path } as ManagedFix],
    }));
    if (found.length) this.rewrites.set(path, [...(this.rewrites.get(path) ?? []), ...found]);
  }

  /** Drop rewrite reports whose path no longer exists in the frontmatter. */
  private reconcileRewrites(path: string, fm: Frontmatter | undefined): void {
    const list = this.rewrites.get(path);
    if (!list) return;
    const kept = fm ? list.filter((d) => getIn(fm, d.path.slice(0, 1)) !== undefined) : [];
    if (kept.length) this.rewrites.set(path, kept);
    else this.rewrites.delete(path);
  }

  // --- writes -----------------------------------------------------------------

  /** Write through the format-preserving writer; returns false on refusal. */
  async write(file: TFile, edit: (text: string) => string): Promise<boolean> {
    try {
      await this.app.vault.process(file, (text) => {
        const out = edit(text);
        this.ownWrites.set(file.path, out);
        return out;
      });
      return true;
    } catch (err) {
      if (err instanceof WriteError) {
        new Notice(`MIF: not saved — ${err.message}`);
        return false;
      }
      throw err;
    }
  }

  async applyFix(file: TFile, fix: ManagedFix): Promise<void> {
    if ("dismiss" in fix) {
      const list = (this.rewrites.get(file.path) ?? []).filter((d) => d.path.join(".") !== fix.path.join("."));
      if (list.length) this.rewrites.set(file.path, list);
      else this.rewrites.delete(file.path);
      await this.analyzeFile(file);
      return;
    }
    const isRestore = (this.rewrites.get(file.path) ?? []).some((d) => d.fixes.includes(fix));
    const ok = await this.write(file, (text) => (fix.transform === "lf" ? toLf(text) : updateFrontmatter(text, fix.updates ?? {})));
    if (ok && isRestore) {
      const list = (this.rewrites.get(file.path) ?? []).filter((d) => !d.fixes.includes(fix));
      if (list.length) this.rewrites.set(file.path, list);
      else this.rewrites.delete(file.path);
    }
    await this.analyzeFile(file);
  }

  // --- Sync mode --------------------------------------------------------------

  markDirty(path: string): void {
    if (this.settings().mode === "sync" && this.rootFor(path) !== null) this.dirty.add(path);
  }

  /** After a user edit is saved, stamp `modified` (debounced). */
  scheduleStamp(file: TFile): void {
    if (this.settings().mode !== "sync" || !this.dirty.has(file.path)) return;
    window.clearTimeout(this.stampTimers.get(file.path));
    this.stampTimers.set(
      file.path,
      window.setTimeout(() => {
        this.stampTimers.delete(file.path);
        this.dirty.delete(file.path);
        void this.stamp(file);
      }, 2000),
    );
  }

  private async stamp(file: TFile): Promise<void> {
    const analysis = this.analyses.get(file.path);
    if (!analysis?.isConcept || !analysis.frontmatter?.id) return;
    await this.write(file, (text) => {
      // Skip when the only change since the last stamp is `modified` itself.
      if (this.ownWrites.get(file.path)?.replace(/^modified:.*$/m, "") === text.replace(/^modified:.*$/m, "")) return text;
      return updateFrontmatter(text, { modified: isoSeconds(new Date()) });
    });
  }

  dispose(): void {
    for (const t of this.stampTimers.values()) window.clearTimeout(t);
    this.stampTimers.clear();
  }
}
