// The plugin's model of the vault: which files belong to a MIF bundle, the
// latest analysis of each, each bundle's relationship index, and every
// write the plugin makes. All writes go through the engine's
// format-preserving writer.

import { Events, Notice, TFile, TFolder, Vault, type App, type TAbstractFile } from "obsidian";

import {
  scalarText,
  revisedPath,
  supersedingConceptText,
  addRelationship,
  exportPath,
  roundtripDrift,
  serializeJsonLd,
  staleExports,
  analyze,
  applyEdit,
  applyTextFix,
  citationMirrorDiagnostics,
  hasCitationSection,
  syncCitations,
  buildIndex,
  buildRegistry,
  bundleDiagnostics,
  detectRewrites,
  frontmatterRelationships,
  isoSeconds,
  legacySigns,
  loadYaml,
  malformedMirrorLines,
  migrateConcept,
  migratedPath,
  mirrorDrift,
  removeRelationship,
  RESERVED_FILENAMES,
  resolveTarget,
  retarget,
  syncMirror,
  titleForTarget,
  toBundleConcept,
  updateFrontmatter,
  updateRelationship,
  validateBundleConfig,
  WriteError,
  type Analysis,
  type BundleConcept,
  type BundleIndex,
  type Diagnostic,
  type Fix,
  type Frontmatter,
  type LegacySigns,
  type Namespaces,
  type Registry,
  type RelationshipInput,
  parseEntityFile,
  renderEntityFile,
  semanticDiagnostics,
  freshness,
  temporalDiagnostics,
  type Freshness,
  type Corpus,
  type EntityRecord,
  type OntologyDef,
  type SemanticReport,
} from "./engine";
import type { OntologyStore } from "./ontologyStore";
import type { MifSettings } from "./settings";

export interface FileAnalysis extends Analysis {
  path: string;
  root: string;
  legacy?: LegacySigns;
  /** The markdown body, for concepts. */
  body?: string;
}

export interface BundleInfo {
  root: string;
  namespaces?: Namespaces;
  registry: Registry;
  /** Problems with .mif/config.yaml, .mif/ontologies, or .mif/entities. */
  configIssues: string[];
  index?: BundleIndex;
  /** Definitions from the bundle's own .mif/ontologies/. */
  localOntologies: OntologyDef[];
  corpus: Corpus;
  reservedPrefixes: string[];
  sharedAgreements: Set<string>;
  /** Entities from .mif/entities/, by urn. */
  entities: Map<string, EntityRecord>;
}

interface FileState {
  analysis: Analysis;
  root: string;
  concept: BundleConcept | null;
  legacy: LegacySigns | null;
  semantic?: SemanticReport;
}

const RENAME_QUIET_MS = 1500;
/** Cap on waiting for Obsidian's link updater when it updates links itself. */
const RENAME_MAX_WAIT_AUTO_MS = 10_000;
/** Cap when Obsidian may ask first ("Automatically update internal links" not reported as on). */
const RENAME_MAX_WAIT_PROMPT_MS = 60_000;
/** Delay before re-checking renamed notes for damage. */
const RENAME_VERIFY_MS = 3000;

interface RenameBatch {
  /** Each bundle's index from before the first rename in the burst. */
  snapshot: Map<string, BundleIndex | undefined>;
  moves: Array<[string, string]>;
  timer: number;
  started: number;
  /** Vault paths (after the move) that Obsidian's link updater should rewrite. */
  expected: Set<string>;
  /** Vault paths written by something other than this plugin since the burst began. */
  external: Set<string>;
}

const MD_LINK = /\[[^\]]*\]\(([^)]+)\)/g;

/** Where Obsidian resolves a markdown link: "/x" from the vault root, else from the note's folder. */
function obsidianLinkPath(target: string, from: string): string | null {
  let t = target.trim().replace(/^<|>$/g, "").split("#")[0]!;
  if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t)) return null;
  try {
    t = decodeURI(t);
  } catch {
    // keep as written
  }
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const parts: string[] = [];
  for (const seg of (t.startsWith("/") ? t : `${dir}/${t}`).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  const path = parts.join("/");
  return path.endsWith(".md") ? path : `${path}.md`;
}

type ManagedFix = Fix | (Fix & { dismiss: true; path: Array<string | number> });

const getIn = (obj: unknown, path: Array<string | number>) =>
  path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string | number, unknown>)[k] : undefined), obj);

const describeLegacy = (s: LegacySigns) =>
  [
    s.memoryExtension && "`.memory.md` file name",
    s.wikilinkRelationships && `${s.wikilinkRelationships} wiki-link relationship${s.wikilinkRelationships > 1 ? "s" : ""}`,
    s.snakeCaseFields.length && `0.1 field names in ${s.snakeCaseFields.join(", ")}`,
    s.slugId && "a slug id",
  ].filter(Boolean).join(", ");

export class MifManager extends Events {
  private readonly files = new Map<string, FileState>();
  private readonly bundles = new Map<string, BundleInfo>();
  /** Bundle-wide diagnostics by vault path. */
  private bundleDiags = new Map<string, Diagnostic[]>();
  /** Values Obsidian rewrote out from under MIF (Spike B), per file. */
  private readonly rewrites = new Map<string, Diagnostic[]>();
  /** Files the user has typed into since their last save (Sync mode). */
  private readonly dirty = new Set<string>();
  private readonly stampTimers = new Map<string, number>();
  /** Text of each file the plugin last wrote, to ignore its own modify events. */
  private readonly ownWrites = new Map<string, string>();
  private indexTimer = 0;
  private renameBatch?: RenameBatch;

  constructor(private readonly app: App, private settings: () => MifSettings, readonly store?: OntologyStore) {
    super();
  }

  /** Developer log, only with Developer commands on. Written outside the vault index. */
  debug(event: string, detail: Record<string, unknown> = {}): void {
    if (!this.settings().showDevCommands) return;
    const line = `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}\n`;
    console.debug("MIF", event, detail);
    const adapter = this.app.vault.adapter as { append?: (p: string, d: string) => Promise<void> };
    void adapter.append?.(`${this.app.vault.configDir}/plugins/mif/debug.log`, line).catch(() => undefined);
  }

  private mirrorLines(text: string): string[] {
    const body = text.slice(text.indexOf("\n---", 4) + 4);
    return body.split("\n").filter((l) => /^-\s+\S+\s+\[/.test(l.trim()));
  }

  // --- membership -------------------------------------------------------------

  /** The bundle root a file belongs to, or null if it is not MIF territory. */
  rootFor(path: string): string | null {
    if (!path.endsWith(".md")) return null;
    if (RESERVED_FILENAMES.has(path.split("/").pop() ?? "")) return null;
    return this.rootContaining(path);
  }

  /** Deepest bundle root containing a path, ignoring file type. */
  private rootContaining(path: string): string | null {
    const s = this.settings();
    if (s.excludedFolders.some((f) => path === f || path.startsWith(`${f}/`))) return null;
    let best: string | null = null;
    for (const root of s.bundleRoots) {
      if ((root === "" || path.startsWith(`${root}/`)) && (best === null || root.length > best.length)) best = root;
    }
    return best;
  }

  toBundlePath(root: string, vaultPath: string): string {
    return root ? vaultPath.slice(root.length + 1) : vaultPath;
  }

  toVaultPath(root: string, bundlePath: string): string {
    return root ? `${root}/${bundlePath}` : bundlePath;
  }

  bundleRoots(): string[] {
    return [...this.bundles.keys()];
  }

  bundleInfo(root: string): BundleInfo | undefined {
    return this.bundles.get(root);
  }

  async loadBundles(): Promise<void> {
    this.bundles.clear();
    for (const root of this.settings().bundleRoots) {
      const configPath = `${root ? `${root}/` : ""}.mif/config.yaml`;
      const info: BundleInfo = {
        root, configIssues: [], registry: buildRegistry(null), localOntologies: [], corpus: new Map(),
        reservedPrefixes: [], sharedAgreements: new Set(), entities: new Map(),
      };
      // .mif/ is a dot-folder Obsidian does not index, so read through the adapter.
      if (await this.app.vault.adapter.exists(configPath)) {
        try {
          const config = loadYaml(await this.app.vault.adapter.read(configPath)) as { namespaces?: Namespaces; reserved_prefixes?: unknown } | null;
          if (Array.isArray(config?.reserved_prefixes)) {
            info.reservedPrefixes = config.reserved_prefixes
              .map((p) => (typeof p === "string" ? p : (p as { prefix?: unknown })?.prefix))
              .filter((p): p is string => typeof p === "string");
          }
          info.configIssues = validateBundleConfig(config ?? {}).map((i) => `${configPath}${i.path === "/" ? "" : i.path}: ${i.message}`);
          info.namespaces = config?.namespaces;
          // Like okf_validate: a malformed config does not opt the bundle in.
          info.registry = buildRegistry(info.configIssues.length ? null : (config as never));
          info.configIssues.push(...info.registry.errors);
        } catch (err) {
          info.configIssues = [`${configPath}: ${(err as Error).message}`];
        }
      }
      await this.loadBundleSemantics(info);
      this.bundles.set(root, info);
    }
  }

  /** .mif/ontologies, .mif/shared-agreements, and .mif/entities for one bundle. */
  private async loadBundleSemantics(info: BundleInfo): Promise<void> {
    const adapter = this.app.vault.adapter;
    const mif = `${info.root ? `${info.root}/` : ""}.mif`;
    if (this.store) {
      const local = await this.store.loadBundleLocal(info.root);
      info.localOntologies = local.defs;
      info.configIssues.push(...local.errors);
      info.corpus = this.store.corpusFor(local.defs);
    }
    if (await adapter.exists(`${mif}/shared-agreements`)) {
      for (const f of (await adapter.list(`${mif}/shared-agreements`)).files) {
        const m = /([^/]+)\.ya?ml$/.exec(f);
        if (m) info.sharedAgreements.add(m[1]!);
      }
    }
    info.entities = new Map();
    const walk = async (dir: string): Promise<string[]> => {
      if (!(await adapter.exists(dir))) return [];
      const listed = await adapter.list(dir);
      return [...listed.files, ...(await Promise.all(listed.folders.map(walk))).flat()];
    };
    for (const f of (await walk(`${mif}/entities`)).filter((p) => /\.ya?ml$/.test(p))) {
      const { entity, error } = parseEntityFile(await adapter.read(f), f);
      if (error) info.configIssues.push(error);
      if (entity) info.entities.set(entity.urn, entity);
    }
  }

  /** Re-derive every bundle's corpus from the store (after a download). */
  refreshCorpora(): void {
    if (!this.store) return;
    for (const info of this.bundles.values()) info.corpus = this.store.corpusFor(info.localOntologies);
    this.recomputeSemantics();
  }

  /** Ontology ids concepts declare that no corpus has yet. */
  missingOntologies(): string[] {
    const missing = new Set<string>();
    const def = this.settings().defaultOntology;
    for (const info of this.bundles.values()) if (def && !info.corpus.has(def)) missing.add(def);
    for (const state of this.files.values()) {
      const id = (state.analysis.frontmatter?.ontology as { id?: unknown } | undefined)?.id;
      const info = this.bundles.get(state.root);
      if (typeof id === "string" && info && !info.corpus.has(id)) missing.add(id);
    }
    return [...missing];
  }

  /** Download what concepts need, when the setting allows. */
  async ensureOntologies(): Promise<void> {
    if (!this.store || !this.settings().downloadOntologies) return;
    const missing = this.missingOntologies();
    if (!missing.length) return;
    const got = await this.store.download(missing);
    this.debug("ontologies", { missing, got, errors: this.store.status.errors });
    if (got.length) this.refreshCorpora();
  }

  private semanticFor(state: FileState, path: string): SemanticReport | undefined {
    const info = this.bundles.get(state.root);
    if (!info || !state.concept) return undefined;
    return semanticDiagnostics(state.concept.frontmatter, state.concept.body, path, {
      corpus: info.corpus,
      reservedPrefixes: info.reservedPrefixes,
      sharedAgreements: info.sharedAgreements,
      entities: info.entities,
      downloadable: this.store ? new Set([...this.store.catalogIds()].filter((id) => !info.corpus.has(id))) : new Set(),
      defaultOntology: this.settings().defaultOntology || undefined,
    });
  }

  recomputeSemantics(): void {
    for (const [path, state] of this.files) state.semantic = this.semanticFor(state, path);
    this.trigger("changed", null);
  }

  thresholds() {
    const s = this.settings();
    return { fresh: s.freshThreshold, ageing: s.ageingThreshold };
  }

  /** Live freshness of a concept (spec §9), or undefined for non-concepts. */
  freshnessOf(path: string, now = new Date()): Freshness | undefined {
    const fm = this.files.get(path)?.analysis.frontmatter;
    return fm && this.files.get(path)?.analysis.isConcept ? freshness(fm, now, this.thresholds()) : undefined;
  }

  private lastTracked = new Map<string, number>();

  /** Opt-in access tracking: bump accessCount / lastAccessed, at most hourly per note. */
  async trackAccess(file: TFile): Promise<void> {
    if (!this.settings().accessTracking) return;
    const a = this.files.get(file.path);
    if (!a?.analysis.isConcept || !a.analysis.frontmatter?.id) return;
    const last = this.lastTracked.get(file.path) ?? 0;
    if (Date.now() - last < 3_600_000) return;
    this.lastTracked.set(file.path, Date.now());
    const temporal = (a.analysis.frontmatter.temporal && typeof a.analysis.frontmatter.temporal === "object" ? a.analysis.frontmatter.temporal : {}) as Record<string, unknown>;
    const count = typeof temporal.accessCount === "number" ? temporal.accessCount : 0;
    await this.write(file, (text) => {
      const once = applyEdit(text, ["temporal", "accessCount"], count + 1);
      return applyEdit(once, ["temporal", "lastAccessed"], isoSeconds(new Date()));
    });
    await this.analyzeFile(file);
  }

  semantic(path: string): SemanticReport | undefined {
    return this.files.get(path)?.semantic;
  }

  /** Every entity in a bundle: from files, and referenced-only, with referrers. */
  entityIndex(root: string): Map<string, { record?: EntityRecord; refs: Array<{ path: string; role?: string; name?: string }> }> {
    const out = new Map<string, { record?: EntityRecord; refs: Array<{ path: string; role?: string; name?: string }> }>();
    const info = this.bundles.get(root);
    for (const [urn, record] of info?.entities ?? []) out.set(urn, { record, refs: [] });
    for (const [path, state] of this.files) {
      if (state.root !== root) continue;
      const list = Array.isArray(state.analysis.frontmatter?.entities) ? (state.analysis.frontmatter.entities as unknown[]) : [];
      for (const r of list) {
        const ref = r as { entity?: { "@id"?: unknown }; role?: unknown; name?: unknown };
        const urn = ref?.entity?.["@id"];
        if (typeof urn !== "string") continue;
        if (!out.has(urn)) out.set(urn, { refs: [] });
        out.get(urn)!.refs.push({ path, role: typeof ref.role === "string" ? ref.role : undefined, name: typeof ref.name === "string" ? ref.name : undefined });
      }
    }
    return out;
  }

  /** Write `.mif/entities/<type>/<slug>.yaml` (no-op if it exists) and reload. */
  async createEntity(root: string, urn: string, name?: string, typeName?: string): Promise<boolean> {
    const m = /^urn:mif:entity:([a-z0-9-]+):([a-z0-9-]+)$/.exec(urn);
    if (!m) {
      new Notice(`MIF: ${urn} is not a urn:mif:entity:<type>:<slug> id.`);
      return false;
    }
    const [, typeSegment, slug] = m;
    const dir = `${root ? `${root}/` : ""}.mif/entities/${typeSegment}`;
    const path = `${dir}/${slug}.yaml`;
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path))) {
      for (const d of [`${root ? `${root}/` : ""}.mif`, `${root ? `${root}/` : ""}.mif/entities`, dir]) if (!(await adapter.exists(d))) await adapter.mkdir(d);
      const pascal = typeName ?? typeSegment!.split("-").map((w) => w[0]!.toUpperCase() + w.slice(1)).join("");
      await adapter.write(path, renderEntityFile({ typeName: pascal, name: name ?? slug!, slug: slug! }));
    }
    const info = this.bundles.get(root);
    if (info) await this.loadBundleSemantics(info);
    this.recomputeSemantics();
    return true;
  }

  // --- analysis ---------------------------------------------------------------

  get(path: string): FileAnalysis | undefined {
    const state = this.files.get(path);
    if (!state) return undefined;
    const legacy = state.legacy
      ? [{
          severity: "warning" as const,
          code: "legacy-0.1",
          message: `Looks like MIF 0.1: ${describeLegacy(state.legacy)}.`,
          path: [],
          line: 0,
          fixes: [{ label: state.legacy.memoryExtension ? "Migrate to MIF 1.0 (renames the file)" : "Migrate to MIF 1.0", transform: "migrate" as const }],
        }]
      : [];
    return {
      ...state.analysis,
      diagnostics: [
        ...(this.rewrites.get(path) ?? []),
        ...legacy,
        ...state.analysis.diagnostics,
        ...(this.bundleDiags.get(path) ?? []),
        ...(state.semantic?.diagnostics ?? []),
        ...(state.analysis.isConcept && state.analysis.frontmatter ? temporalDiagnostics(state.analysis.frontmatter, new Date(), this.thresholds()) : []),
      ],
      path,
      root: state.root,
      legacy: state.legacy ?? undefined,
      body: state.concept?.body,
    };
  }

  all(): FileAnalysis[] {
    return [...this.files.keys()].sort().map((p) => this.get(p)!);
  }

  /** Re-read bundle configuration and every note; returns how many notes were read. */
  async rescan(): Promise<number> {
    await this.loadBundles();
    await this.scanAll();
    void this.ensureOntologies();
    this.debug("rescan", { notes: this.files.size });
    return this.files.size;
  }

  async scanAll(): Promise<void> {
    this.files.clear();
    const files = this.app.vault.getMarkdownFiles().filter((f) => this.rootFor(f.path) !== null);
    for (let i = 0; i < files.length; i++) {
      await this.analyzeFile(files[i]!, { quiet: true });
      if (i % 50 === 49) await new Promise((r) => window.setTimeout(r, 0));
    }
    this.rebuildIndexes();
  }

  async analyzeFile(file: TFile, opts: { quiet?: boolean } = {}): Promise<FileAnalysis | undefined> {
    const root = this.rootFor(file.path);
    if (root === null) {
      if (this.files.delete(file.path) && !opts.quiet) this.scheduleIndex();
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
    const previous = this.files.get(file.path);
    const ownWrite = this.ownWrites.get(file.path) === text;
    if (previous && analysis.frontmatter && !ownWrite) this.detectRewrites(file.path, previous.analysis, analysis.frontmatter);
    this.reconcileRewrites(file.path, analysis.frontmatter);

    const concept = analysis.isConcept ? toBundleConcept(this.toBundlePath(root, file.path), text) : null;
    const state: FileState = { analysis, root, concept, legacy: legacySigns(file.path, text) };
    state.semantic = this.semanticFor(state, file.path);
    this.files.set(file.path, state);
    if (!opts.quiet) this.scheduleIndex();
    return this.get(file.path);
  }

  forget(path: string): void {
    this.files.delete(path);
    this.rewrites.delete(path);
    this.dirty.delete(path);
    this.ownWrites.delete(path);
    this.scheduleIndex();
  }

  private scheduleIndex(): void {
    window.clearTimeout(this.indexTimer);
    this.indexTimer = window.setTimeout(() => this.rebuildIndexes(), 150);
  }

  /** Rebuild every bundle's relationship index and its bundle-wide checks. */
  rebuildIndexes(): void {
    window.clearTimeout(this.indexTimer);
    const diags = new Map<string, Diagnostic[]>();
    const allFiles = this.app.vault.getFiles();
    for (const info of this.bundles.values()) {
      const concepts: BundleConcept[] = [];
      for (const state of this.files.values()) if (state.root === info.root && state.concept) concepts.push(state.concept);
      // Existence checks see every file under the root, excluded or not,
      // as okf_validate sees the filesystem.
      const files = allFiles
        .filter((f) => info.root === "" || f.path.startsWith(`${info.root}/`))
        .map((f) => this.toBundlePath(info.root, f.path));
      info.index = buildIndex(concepts, info.registry, files);
      for (const [bundlePath, ds] of bundleDiagnostics(info.index)) diags.set(this.toVaultPath(info.root, bundlePath), ds);
    }
    this.bundleDiags = diags;
    this.trigger("changed", null);
  }

  indexFor(path: string): { info: BundleInfo; index: BundleIndex; bundlePath: string } | undefined {
    const root = this.rootFor(path);
    const info = root === null ? undefined : this.bundles.get(root);
    if (!info?.index) return undefined;
    return { info, index: info.index, bundlePath: this.toBundlePath(info.root, path) };
  }

  /** Link-text lookup for mirror lines written from `path`. */
  private titleFor(path: string): (target: string) => string | undefined {
    const ctx = this.indexFor(path);
    return ctx ? titleForTarget(ctx.index, ctx.bundlePath) : () => undefined;
  }

  private detectRewrites(path: string, previous: Analysis, now: Frontmatter): void {
    const previousAnalysis = { ...previous, diagnostics: previous.diagnostics.filter((d) => d.code !== "rewritten") };
    const found = detectRewrites(previousAnalysis, now).map((d) => ({
      ...d,
      fixes: [...d.fixes, { label: "Keep the new value", dismiss: true, path: d.path }],
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

  /**
   * Write through the format-preserving writer; returns false on refusal.
   * Always via Vault.process — the route Obsidian's own Properties panel uses
   * for open notes; the open editor picks the change up. (Editing through
   * the Editor API dropped some changes in testing.) Every write is
   * read back: a mismatch is reported, never silent.
   */
  async write(file: TFile, edit: (text: string) => string): Promise<boolean> {
    let expected: string | undefined;
    try {
      await this.app.vault.process(file, (text) => {
        const out = edit(text);
        expected = out;
        this.ownWrites.set(file.path, out);
        return out;
      });
    } catch (err) {
      if (err instanceof WriteError || (err instanceof Error && err.name === "FrontmatterError")) {
        new Notice(`MIF: not saved — ${err.message}`);
        this.debug("write-refused", { path: file.path, message: err.message });
        return false;
      }
      this.debug("write-error", { path: file.path, message: (err as Error).message });
      throw err;
    }
    const actual = await this.app.vault.read(file);
    if (expected !== undefined && actual !== expected) {
      this.debug("write-mismatch", { path: file.path, expectedLength: expected.length, actualLength: actual.length });
      new Notice(`MIF: ${file.basename} changed while saving; check the note.`);
      return false;
    }
    this.debug("write", { path: file.path, bytes: actual.length });
    return true;
  }

  async applyFix(file: TFile, fix: ManagedFix): Promise<void> {
    this.debug("fix", { path: file.path, label: fix.label, transform: fix.transform ?? null });
    if ("dismiss" in fix) {
      const list = (this.rewrites.get(file.path) ?? []).filter((d) => d.path.join(".") !== fix.path.join("."));
      if (list.length) this.rewrites.set(file.path, list);
      else this.rewrites.delete(file.path);
      await this.analyzeFile(file);
      return;
    }
    if (fix.transform === "migrate") {
      await this.migrate(file);
      return;
    }
    if (fix.transform === "download-ontology" && this.store) {
      const id = scalarText(fix.data?.id ?? "");
      const got = await this.store.download([id], { retry: true });
      new Notice(got.length ? `MIF: downloaded ${got.join(", ")}.` : `MIF: could not download ${id}. ${this.store.status.errors.slice(-1)[0] ?? ""}`);
      this.refreshCorpora();
      return;
    }
    if (fix.transform === "supersede") {
      await this.supersede(file);
      return;
    }
    if (fix.transform === "create-entity") {
      const root = this.rootFor(file.path);
      if (root !== null) {
        await this.createEntity(root, scalarText(fix.data?.urn ?? ""), fix.data?.name as string | undefined, fix.data?.entityType as string | undefined);
      }
      return;
    }
    const isRestore = (this.rewrites.get(file.path) ?? []).some((d) => d.fixes.includes(fix));
    const titleFor = this.titleFor(file.path);
    const ok = await this.write(file, (text) => applyTextFix(text, fix, { titleFor }));
    if (ok && fix.transform === "compress") new Notice("MIF: compressed. The original text is in extensions.original_content; Restore original content undoes it.");
    if (ok && fix.transform === "decompress") new Notice("MIF: original content restored.");
    if (ok && isRestore) {
      const list = (this.rewrites.get(file.path) ?? []).filter((d) => !d.fixes.includes(fix));
      if (list.length) this.rewrites.set(file.path, list);
      else this.rewrites.delete(file.path);
    }
    await this.analyzeFile(file);
  }

  /** Edit one frontmatter path from the Properties panel (a user edit, for Sync mode). */
  async editField(file: TFile, path: Array<string | number>, value: unknown): Promise<boolean> {
    this.markDirty(file.path);
    const ok = await this.write(file, (text) => applyEdit(text, path, value));
    await this.analyzeFile(file);
    this.scheduleStamp(file);
    return ok;
  }

  // --- relationships ------------------------------------------------------------

  async addRelationship(file: TFile, rel: RelationshipInput): Promise<boolean> {
    const titleFor = this.titleFor(file.path);
    const ok = await this.write(file, (text) => addRelationship(text, rel, titleFor));
    await this.analyzeFile(file);
    return ok;
  }

  async updateRelationship(file: TFile, index: number, rel: RelationshipInput): Promise<boolean> {
    const titleFor = this.titleFor(file.path);
    const ok = await this.write(file, (text) => updateRelationship(text, index, rel, titleFor));
    await this.analyzeFile(file);
    return ok;
  }

  async removeRelationship(file: TFile, index: number): Promise<boolean> {
    const titleFor = this.titleFor(file.path);
    const ok = await this.write(file, (text) => removeRelationship(text, index, titleFor));
    await this.analyzeFile(file);
    return ok;
  }

  // --- migration ----------------------------------------------------------------

  /** Migrate one MIF 0.1 note in place, then drop a `.memory` infix. */
  async migrate(file: TFile): Promise<boolean> {
    const ok = await this.write(file, migrateConcept);
    if (!ok) return false;
    const target = migratedPath(file.path);
    if (target !== file.path) {
      if (this.app.vault.getAbstractFileByPath(target)) {
        new Notice(`MIF: migrated ${file.path} but did not rename it — ${target} already exists.`);
      } else {
        await this.app.fileManager.renameFile(file, target);
      }
    }
    await this.analyzeFile(file);
    return true;
  }

  legacyFiles(): TFile[] {
    return [...this.files.entries()]
      .filter(([, s]) => s.legacy)
      .map(([p]) => this.app.vault.getAbstractFileByPath(p))
      .filter((f): f is TFile => f instanceof TFile);
  }

  // --- renames ------------------------------------------------------------------

  /**
   * Record a rename and, once the burst of events settles, rewrite every
   * relationship target that pointed at a moved concept (and each moved
   * concept's own relative targets). Uses the index from before the burst.
   */
  handleRename(file: TAbstractFile, oldPath: string): void {
    if (!this.renameBatch) {
      this.renameBatch = {
        snapshot: new Map([...this.bundles].map(([root, info]) => [root, info.index])),
        moves: [],
        timer: 0,
        started: Date.now(),
        expected: new Set(),
        external: new Set(),
      };
    }
    const batch = this.renameBatch;
    if (file instanceof TFolder) {
      Vault.recurseChildren(file, (child) => {
        if (child instanceof TFile) batch.moves.push([oldPath + child.path.slice(file.path.length), child.path]);
      });
    } else {
      batch.moves.push([oldPath, file.path]);
      this.forget(oldPath);
      if (file instanceof TFile) void this.analyzeFile(file);
    }
    this.predictLinkUpdates(batch);
    this.debug("rename", { from: oldPath, to: file.path, expected: [...batch.expected] });
    this.deferRenames();
  }

  /**
   * Notes Obsidian's link updater will rewrite for this burst of moves: each
   * moved note with relative links, and each note linking to a moved note.
   * The plugin must not edit these until Obsidian has (its edits use
   * offsets recorded at move time).
   */
  private predictLinkUpdates(batch: RenameBatch): void {
    const moved = new Map(batch.moves);
    const newPath = (p: string) => moved.get(p) ?? p;
    for (const [root, index] of batch.snapshot) {
      if (!index) continue;
      for (const c of index.concepts.values()) {
        const vaultPath = this.toVaultPath(root, c.path);
        for (const m of c.body.matchAll(MD_LINK)) {
          const raw = m[1]!.trim();
          const dest = obsidianLinkPath(raw, vaultPath);
          if (!dest) continue;
          const linksToMoved = moved.has(dest);
          const ownRelativeLink = moved.has(vaultPath) && !raw.startsWith("/");
          if (linksToMoved || ownRelativeLink) batch.expected.add(newPath(vaultPath));
        }
      }
    }
  }

  /**
   * Obsidian's own link updater rewrites links after a move using character
   * offsets it recorded beforehand. Writing to the same file first shifts
   * those offsets and Obsidian then splices into the wrong place (seen in
   * testing: `[Concep[Concept A](a.md)`). So rename edits wait until
   * the vault has been quiet — no modify or re-index events — for
   * RENAME_QUIET_MS, capped at RENAME_MAX_WAIT_MS.
   */
  async noteActivity(file?: TAbstractFile): Promise<void> {
    const batch = this.renameBatch;
    if (!batch) return;
    if (file instanceof TFile) {
      const text = await this.app.vault.cachedRead(file);
      const own = this.ownWrites.get(file.path) === text;
      if (!own) batch.external.add(file.path);
      if (batch.expected.has(file.path) || own) this.debug("modify", { path: file.path, own, mirror: this.mirrorLines(text) });
    }
    this.deferRenames();
  }

  /**
   * Whether Obsidian reports updating links itself. Obsidian 1.13.7 updated
   * links without asking even with an empty app.json, so
   * "not true" only means the longer cap applies, not that a dialog appears.
   */
  private obsidianAutoUpdatesLinks(): boolean {
    const vault = this.app.vault as unknown as { getConfig?: (key: string) => unknown };
    return vault.getConfig?.("alwaysUpdateLinks") === true;
  }

  private deferRenames(): void {
    const batch = this.renameBatch;
    if (!batch) return;
    window.clearTimeout(batch.timer);
    const cap = this.obsidianAutoUpdatesLinks() ? RENAME_MAX_WAIT_AUTO_MS : RENAME_MAX_WAIT_PROMPT_MS;
    const waited = Date.now() - batch.started;
    const pending = [...batch.expected].filter((p) => !batch.external.has(p));
    this.debug("defer", { waited, pending, external: [...batch.external] });
    if (waited >= cap) {
      batch.timer = window.setTimeout(() => void this.processRenames(), 0);
    } else if (pending.length) {
      // Still waiting for Obsidian's own rewrite of these; check again shortly.
      batch.timer = window.setTimeout(() => this.deferRenames(), Math.min(1000, cap - waited));
    } else {
      batch.timer = window.setTimeout(() => void this.processRenames(), Math.min(RENAME_QUIET_MS, cap - waited));
    }
  }

  private async processRenames(): Promise<void> {
    const batch = this.renameBatch;
    this.renameBatch = undefined;
    if (!batch) return;
    let updated = 0;
    for (const [root, index] of batch.snapshot) {
      if (!index) continue;
      const inRoot = (p: string) => (root === "" ? !p.startsWith("/") : p.startsWith(`${root}/`));
      const moved = new Map<string, string>();
      for (const [from, to] of batch.moves) {
        if (inRoot(from) && this.rootContaining(to) === root) moved.set(this.toBundlePath(root, from), this.toBundlePath(root, to));
      }
      if (moved.size === 0) continue;
      for (const concept of index.concepts.values()) {
        const self = { from: concept.path, to: moved.get(concept.path) ?? concept.path };
        const affected = frontmatterRelationships(concept.frontmatter).some((r) => {
          const res = resolveTarget(r.target, self.from);
          if (res.kind !== "path") return false;
          return moved.has(res.bundlePath!) || (self.from !== self.to && !r.target.startsWith("/"));
        });
        if (!affected) continue;
        const file = this.app.vault.getAbstractFileByPath(this.toVaultPath(root, self.to));
        if (!(file instanceof TFile)) continue;
        let changed = false;
        const ok = await this.write(file, (text) => {
          const out = retarget(text, self, moved);
          changed = out !== text;
          return out;
        });
        if (ok && changed) updated++;
        this.debug("retarget", { path: file.path, changed, mirror: this.mirrorLines(this.ownWrites.get(file.path) ?? "") });
        await this.analyzeFile(file, { quiet: true });
      }
    }
    if (updated) new Notice(`MIF: updated relationship targets in ${updated} note${updated > 1 ? "s" : ""}.`);
    this.rebuildIndexes();
    const touched = [...new Set([...batch.expected, ...batch.moves.map(([, to]) => to)])];
    window.setTimeout(() => void this.verifyAfterRename(touched), RENAME_VERIFY_MS);
  }

  /**
   * Safety net after a rename: anything that still edited these notes with
   * stale offsets leaves a damaged mirror line. The frontmatter is
   * authoritative, so regenerating the mirror repairs it.
   */
  private async verifyAfterRename(paths: string[]): Promise<void> {
    let repaired = 0;
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || this.rootFor(path) === null) continue;
      const text = await this.app.vault.cachedRead(file);
      const concept = toBundleConcept(path, text);
      if (!concept || malformedMirrorLines(concept.body).length === 0) continue;
      this.debug("repair", { path, mirror: this.mirrorLines(text) });
      const titleFor = this.titleFor(path);
      if (await this.write(file, (t) => syncMirror(t, titleFor))) repaired++;
      await this.analyzeFile(file);
    }
    if (repaired) new Notice(`MIF: repaired damaged relationship lines in ${repaired} note${repaired > 1 ? "s" : ""} after the move.`);
  }

  // --- Sync mode --------------------------------------------------------------

  markDirty(path: string): void {
    if (this.settings().mode === "sync" && this.rootFor(path) !== null) this.dirty.add(path);
  }

  /** After a user edit is saved, stamp `modified` and resync the mirror (debounced). */
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
    const state = this.files.get(file.path);
    if (!state?.analysis.isConcept || !state.analysis.frontmatter?.id) return;
    const titleFor = this.titleFor(file.path);
    await this.write(file, (text) => {
      // Skip when the only change since the last stamp is `modified` itself.
      if (this.ownWrites.get(file.path)?.replace(/^modified:.*$/m, "") === text.replace(/^modified:.*$/m, "")) return text;
      let out = updateFrontmatter(text, { modified: isoSeconds(new Date()) });
      const concept = toBundleConcept(file.path, out);
      if (concept && mirrorDrift(concept.frontmatter, concept.body)) out = syncMirror(out, titleFor);
      // An existing ## Citations section follows frontmatter too (never created here).
      if (concept && hasCitationSection(concept.body) && citationMirrorDiagnostics(concept.frontmatter, concept.body).some((d) => d.code !== "citation-body-only")) {
        out = syncCitations(out);
      }
      return out;
    });
  }

  /**
   * Create a concept that supersedes `file` (same type and namespace, valid
   * from now, with a `supersedes` relationship), end the old concept's
   * validity now if it is still open, and open the new one.
   */
  async supersede(file: TFile): Promise<TFile | undefined> {
    const root = this.rootFor(file.path);
    const fm = this.files.get(file.path)?.analysis.frontmatter;
    if (root === null || !fm) return undefined;
    const now = new Date();
    const oldPath = this.toBundlePath(root, file.path);
    const nextPath = revisedPath(oldPath, (p) => this.app.vault.getAbstractFileByPath(this.toVaultPath(root, p)) !== null);
    const text = supersedingConceptText({ path: oldPath, frontmatter: fm }, { path: nextPath, id: crypto.randomUUID(), now });
    const created = await this.app.vault.create(this.toVaultPath(root, nextPath), text);
    const temporal = fm.temporal && typeof fm.temporal === "object" ? (fm.temporal as Record<string, unknown>) : {};
    const until = typeof temporal.validUntil === "string" ? Date.parse(temporal.validUntil) : NaN;
    if (Number.isNaN(until) || until > now.getTime()) {
      await this.write(file, (t) => applyEdit(t, ["temporal", "validUntil"], isoSeconds(now)));
    }
    this.debug("supersede", { from: file.path, to: created.path });
    await this.analyzeFile(created, { quiet: true });
    await this.analyzeFile(file, { quiet: true });
    this.rebuildIndexes(); // the "superseded" banner shows at once
    new Notice(`MIF: created ${created.basename}, which supersedes ${file.basename}.`);
    void this.app.workspace.openLinkText(created.path, "", false);
    return created;
  }

  // --- JSON-LD export and the round-trip check ---------------------------

  /** A bundle's name in export paths: its folder name, or the vault's name for the root bundle. */
  bundleName(root: string): string {
    return root ? root.split("/").pop()! : this.app.vault.getName();
  }

  /**
   * Write JSON-LD projections for the concepts at or under `scope` (a vault
   * path: one note, a folder, a bundle root, or "" for every bundle), laid
   * out as mif_convert's emit-jsonld. When a whole bundle is exported,
   * projections whose concept no longer exists go to the trash.
   */
  async exportJsonLd(scope: string): Promise<{ written: number; skipped: string[]; removed: number; folder: string }> {
    const folder = this.settings().exportFolder.replace(/^\/+|\/+$/g, "") || "dist/jsonld";
    const inScope = (p: string) => scope === "" || p === scope || p.startsWith(`${scope}/`);
    let written = 0;
    const skipped: string[] = [];
    const byBundle = new Map<string, string[]>();
    for (const [path, state] of [...this.files].sort(([a], [b]) => a.localeCompare(b))) {
      if (!inScope(path) || !state.analysis.isConcept) continue;
      const bundlePath = this.toBundlePath(state.root, path);
      byBundle.set(state.root, [...(byBundle.get(state.root) ?? []), bundlePath]);
      const jsonld = state.analysis.jsonld;
      if (!jsonld) {
        skipped.push(path);
        continue;
      }
      await this.writeVaultFile(exportPath(folder, this.bundleName(state.root), bundlePath), serializeJsonLd(jsonld));
      written++;
    }
    let removed = 0;
    for (const root of this.bundleRoots()) {
      if (!(scope === "" || scope === root) || !this.bundles.has(root)) continue;
      const existing = this.app.vault.getFiles().map((f) => f.path);
      for (const stale of staleExports(existing, folder, this.bundleName(root), byBundle.get(root) ?? [])) {
        const f = this.app.vault.getAbstractFileByPath(stale);
        if (f instanceof TFile) {
          await this.app.fileManager.trashFile(f);
          removed++;
        }
      }
    }
    this.debug("export-jsonld", { scope, folder, written, skipped: skipped.length, removed });
    return { written, skipped, removed, folder };
  }

  private async writeVaultFile(path: string, text: string): Promise<void> {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
    }
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      if ((await this.app.vault.read(existing)) !== text) await this.app.vault.modify(existing, text);
    } else {
      await this.app.vault.create(path, text);
    }
  }

  /** Invariant 4 for every concept: markdown → JSON-LD → markdown must be lossless. */
  async roundtripReport(): Promise<Array<{ path: string; drift: string }>> {
    const out: Array<{ path: string; drift: string }> = [];
    for (const [path, state] of [...this.files].sort(([a], [b]) => a.localeCompare(b))) {
      if (!state.analysis.isConcept || !state.analysis.jsonld) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;
      const drift = roundtripDrift(await this.app.vault.cachedRead(file), this.bundles.get(state.root)?.namespaces);
      if (drift) out.push({ path, drift });
    }
    this.debug("roundtrip", { drifting: out.length });
    return out;
  }

  dispose(): void {
    for (const t of this.stampTimers.values()) window.clearTimeout(t);
    this.stampTimers.clear();
    window.clearTimeout(this.indexTimer);
    if (this.renameBatch) window.clearTimeout(this.renameBatch.timer);
  }
}
