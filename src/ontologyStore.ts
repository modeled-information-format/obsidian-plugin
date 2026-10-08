// Where ontology definitions come from:
//   1. each bundle's .mif/ontologies/*.ontology.yaml (spec §10.8.1), and
//   2. the canonical corpus at mif-spec.dev, downloaded on demand when the
//      user has it enabled, verified against the catalog's sha256, and
//      cached in the plugin folder so it keeps working offline.
// A bundle-local definition overrides a downloaded one with the same id.

import { normalizePath, requestUrl, type App } from "obsidian";

import { parseOntology, type Corpus, type OntologyDef } from "./engine/ontology";

export const CATALOG_URL = "https://mif-spec.dev/ontologies/index.json";

interface CatalogEntry {
  file: string;
  sha256: string;
  version: string;
  yaml: string;
  extends: string[];
}

interface Catalog {
  aliases?: Record<string, string>;
  ontologies: Record<string, CatalogEntry>;
}

export interface StoreStatus {
  catalogVersion?: string;
  cached: string[];
  errors: string[];
  lastFetch?: string;
}

class SkipCatalog extends Error {}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export class OntologyStore {
  private downloaded: Corpus = new Map();
  private catalog?: Catalog;
  readonly status: StoreStatus = { cached: [], errors: [] };
  /** Whether the catalog was fetched from the network this session. */
  private catalogFresh = false;
  /** Ids already attempted this session, so a failing id is not retried in a loop. */
  private attempted = new Set<string>();

  constructor(private readonly app: App, private readonly pluginDir: string) {}

  private get cacheDir() {
    return normalizePath(`${this.pluginDir}/ontology-cache`);
  }

  /** Load the catalog and every cached ontology from disk (no network). */
  async loadCache(): Promise<void> {
    const adapter = this.app.vault.adapter;
    this.downloaded = new Map();
    this.status.cached = [];
    if (!(await adapter.exists(this.cacheDir))) return;
    const indexPath = `${this.cacheDir}/index.json`;
    if (await adapter.exists(indexPath)) {
      try {
        this.catalog = JSON.parse(await adapter.read(indexPath)) as Catalog;
        this.status.catalogVersion = this.catalog.aliases?.latest;
      } catch {
        this.catalog = undefined;
      }
    }
    for (const f of (await adapter.list(this.cacheDir)).files.filter((p) => p.endsWith(".ontology.yaml"))) {
      const { def } = parseOntology(await adapter.read(f), `mif-spec.dev/${f.split("/").pop()}`);
      if (def) {
        this.downloaded.set(def.id, def);
        this.status.cached.push(def.id);
      }
    }
  }

  /** Ids the catalog offers (empty until the catalog has been fetched once). */
  catalogIds(): Set<string> {
    return new Set(Object.keys(this.catalog?.ontologies ?? {}));
  }

  /** Bundle-local definitions from `<root>/.mif/ontologies/`. */
  async loadBundleLocal(root: string): Promise<{ defs: OntologyDef[]; errors: string[] }> {
    const dir = normalizePath(`${root ? `${root}/` : ""}.mif/ontologies`);
    const adapter = this.app.vault.adapter;
    const defs: OntologyDef[] = [];
    const errors: string[] = [];
    if (!(await adapter.exists(dir))) return { defs, errors };
    for (const f of (await adapter.list(dir)).files.filter((p) => /\.ontology\.ya?ml$/.test(p))) {
      const { def, errors: e } = parseOntology(await adapter.read(f), f);
      errors.push(...e);
      if (def) defs.push(def);
    }
    return { defs, errors };
  }

  /** Downloaded definitions overlaid with a bundle's own. */
  corpusFor(bundleLocal: OntologyDef[]): Corpus {
    const corpus: Corpus = new Map(this.downloaded);
    for (const d of bundleLocal) corpus.set(d.id, d);
    return corpus;
  }

  /**
   * Download `ids` and everything they extend. Each file is checked against
   * the catalog's sha256 before it is cached; a mismatch is refused.
   */
  async download(ids: Iterable<string>, opts: { retry?: boolean } = {}): Promise<string[]> {
    const fetched: string[] = [];
    const requested = [...ids];
    // An id the known catalog lacks never costs a request; the catalog itself
    // is refreshed at most once per session unless the user asks (retry).
    if (this.catalog && !opts.retry) {
      if (this.catalogFresh && !requested.some((id) => this.catalog!.ontologies[id] && !this.downloaded.has(id))) return fetched;
      if (!requested.some((id) => this.catalog!.ontologies[id])) return fetched;
    }
    try {
      if (this.catalogFresh && !opts.retry) throw new SkipCatalog();
      const res = await requestUrl({ url: CATALOG_URL });
      this.catalog = res.json as Catalog;
      this.status.catalogVersion = this.catalog.aliases?.latest;
      await this.ensureDir();
      await this.app.vault.adapter.write(`${this.cacheDir}/index.json`, JSON.stringify(this.catalog, null, 2));
      this.catalogFresh = true;
    } catch (err) {
      if (!(err instanceof SkipCatalog)) {
        this.status.errors.push(`catalog: ${(err as Error).message}`);
        return fetched;
      }
    }
    const catalog = this.catalog;
    if (!catalog) return fetched;
    const want = new Set<string>();
    const add = (id: string) => {
      if (want.has(id) || !catalog.ontologies[id]) return;
      want.add(id);
      for (const p of catalog.ontologies[id].extends ?? []) add(p);
    };
    for (const id of requested) add(id);
    for (const id of want) {
      if (!opts.retry && this.attempted.has(id) && !this.downloaded.has(id)) continue;
      this.attempted.add(id);
      const entry = catalog.ontologies[id]!;
      try {
        const res = await requestUrl({ url: entry.yaml });
        const digest = hex(await crypto.subtle.digest("SHA-256", res.arrayBuffer));
        if (digest !== entry.sha256) throw new Error(`sha256 mismatch (expected ${entry.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…)`);
        const text = new TextDecoder().decode(res.arrayBuffer);
        const { def, errors } = parseOntology(text, `mif-spec.dev/${entry.file}`);
        if (!def) throw new Error(errors.join("; "));
        await this.app.vault.adapter.write(`${this.cacheDir}/${entry.file}`, text);
        this.downloaded.set(def.id, def);
        if (!this.status.cached.includes(def.id)) this.status.cached.push(def.id);
        fetched.push(id);
      } catch (err) {
        this.status.errors.push(`${id}: ${(err as Error).message}`);
      }
    }
    this.status.lastFetch = new Date().toISOString();
    return fetched;
  }

  /** Download the whole catalog. */
  async downloadAll(): Promise<string[]> {
    if (!this.catalog) await this.download([]);
    return this.download(Object.keys(this.catalog?.ontologies ?? {}), { retry: true });
  }

  async clearCache(): Promise<void> {
    if (await this.app.vault.adapter.exists(this.cacheDir)) await this.app.vault.adapter.rmdir(this.cacheDir, true);
    this.downloaded = new Map();
    this.catalog = undefined;
    this.status.cached = [];
    this.status.catalogVersion = undefined;
    this.attempted.clear();
    this.catalogFresh = false;
  }

  private async ensureDir(): Promise<void> {
    if (!(await this.app.vault.adapter.exists(this.cacheDir))) await this.app.vault.adapter.mkdir(this.cacheDir);
  }
}
