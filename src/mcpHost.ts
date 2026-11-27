// The vault side of the MCP server: a McpHost over MifManager and the
// mif-cli bridge, and the service that starts and stops the endpoint for
// this vault. Reads are here; what a client may write, and its rules, are in
// mcpWrites.ts.

import type { App } from "obsidian";
import type { MifCli } from "./cliBridge";
import { CORE_ENTITY_TYPES, entitySlug, trustOf } from "./engine";
import type { MifManager } from "./manager";
import type { McpEndpoint, startEndpoint } from "./mcp/http";
import type { Author, ConceptEdit, ConceptRef, ConceptSummary, ConceptView, EdgeView, EntityTypeView, EntityView, GapsView, McpHost, NewConceptInput, OntologyView, RelationshipWrite, Resolved, SearchHit, SearchRequest, StoreView, Unavailable, Vocabulary, Weighing } from "./mcp/host";
import { REVIEW_SOURCE, VaultWrites, type ReviewLevel } from "./mcpWrites";
import type { MifSettings } from "./settings";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export class VaultMcpHost implements McpHost {
  constructor(
    private readonly app: App,
    private readonly manager: MifManager,
    private readonly cli: MifCli,
    private readonly settings: () => MifSettings,
    private readonly pluginDir: string = `${app.vault.configDir}/plugins/mif`,
  ) {}

  private written?: VaultWrites;

  /** The vault's write operations and their rules; see mcpWrites.ts. */
  private get write(): VaultWrites {
    return (this.written ??= new VaultWrites(this.app, this.manager, this.cli, this.settings, (path) => this.ref(path), this.pluginDir, () => this.entityTypes()));
  }

  writes() {
    return this.write.writes();
  }
  admit() {
    return this.write.admit();
  }
  createConcept(input: NewConceptInput, author: Author) {
    return this.write.createConcept(input, author);
  }
  addRelationship(path: string, rel: RelationshipWrite, author: Author) {
    return this.write.addRelationship(path, rel, author);
  }
  updateRelationship(path: string, match: { type: string; target: string }, next: { type?: string; strength?: number }, author: Author) {
    return this.write.updateRelationship(path, match, next, author);
  }
  removeRelationship(path: string, match: { type: string; target: string }, author: Author) {
    return this.write.removeRelationship(path, match, author);
  }
  addCitation(path: string, citation: Record<string, unknown>, author: Author) {
    return this.write.addCitation(path, citation, author);
  }
  createEntity(bundle: string, entity: { type: string; name: string }, author: Author) {
    return this.write.createEntity(bundle, entity, author);
  }
  addEntityReference(path: string, entity: { urn: string; name?: string; role?: string }, author: Author) {
    return this.write.addEntityReference(path, entity, author);
  }
  ingest(bundle: string, author: Author, progress?: (done: number, total: number) => void) {
    return this.write.ingest(bundle, author, progress);
  }
  editConcept(path: string, edit: ConceptEdit, author: Author) {
    return this.write.editConcept(path, edit, author);
  }
  mergeConcepts(into: string, from: string[], body: string, author: Author) {
    return this.write.mergeConcepts(into, from, body, author);
  }

  /** Agent-written or agent-edited and not reviewed since: trustLevel uncertain, with sourceType agent_inferred or this server as sourceRef (spec §12). */
  reviewQueue(): ConceptRef[] {
    return this.manager.all().flatMap((a) => {
      const p = a.isConcept ? a.frontmatter?.provenance : undefined;
      const prov = p && typeof p === "object" ? (p as Record<string, unknown>) : undefined;
      const ref = prov?.trustLevel === "uncertain" && (prov.sourceType === "agent_inferred" || prov.sourceRef === REVIEW_SOURCE) ? this.ref(a.path) : undefined;
      return ref ? [ref] : [];
    });
  }

  /** The review queue as the Review panel shows it: who wrote each concept, and when. */
  reviewItems(): Array<{ concept: ConceptRef; agent: string; created?: string }> {
    return this.reviewQueue().map((concept) => {
      const fm = this.manager.get(concept.path)?.frontmatter ?? {};
      const prov = fm.provenance as Record<string, unknown>;
      const created = str(fm.created);
      return { concept, agent: [str(prov.agent) ?? "unknown agent", str(prov.agentVersion)].filter(Boolean).join(" "), ...(created ? { created } : {}) };
    });
  }
  promote(path: string, level: ReviewLevel) {
    return this.write.promote(path, level);
  }
  reject(path: string) {
    return this.write.reject(path);
  }

  vault() {
    return { name: this.app.vault.getName(), purpose: this.settings().mcpPurpose.trim(), bundles: this.manager.bundleRoots() };
  }

  private ref(path: string): ConceptRef | undefined {
    const a = this.manager.get(path);
    if (!a?.isConcept) return undefined;
    const fm = a.frontmatter ?? {};
    const id = str(fm.id);
    return {
      ...(id && UUID.test(id) ? { id: `urn:mif:${id.toLowerCase()}` } : {}),
      path,
      bundle: a.root,
      title: str(fm.title) ?? path.split("/").pop()!.replace(/\.md$/, ""),
      ...(str(fm.type) ? { type: str(fm.type) } : {}),
    };
  }

  weigh(path: string, asOf: Date): Weighing | undefined {
    const a = this.manager.get(path);
    const f = this.manager.freshnessOf(path, asOf);
    if (!a?.isConcept || !f) return undefined;
    const provenance = a.frontmatter?.provenance;
    const sourceType = provenance && typeof provenance === "object" ? str((provenance as Record<string, unknown>).sourceType) : undefined;
    const trust = trustOf(a.frontmatter);
    return {
      freshness: f.state,
      ...(f.strength === undefined ? {} : { strength: f.strength }),
      ...(f.expiresAt ? { expires_at: f.expiresAt } : {}),
      ...(trust ? { trust } : {}),
      ...(sourceType ? { source_type: sourceType } : {}),
      level: a.level,
      errors: a.diagnostics.filter((d) => d.severity === "error").length,
      warnings: a.diagnostics.filter((d) => d.severity === "warning").length,
    };
  }

  private view(path: string, asOf: Date): ConceptView | undefined {
    const ref = this.ref(path);
    const weighing = this.weigh(path, asOf);
    const a = this.manager.get(path);
    if (!ref || !weighing || !a) return undefined;
    const fm = (a.frontmatter ?? {}) as Record<string, unknown>;
    const entity = fm.entity && typeof fm.entity === "object" ? (fm.entity as Record<string, unknown>) : undefined;
    return {
      ...ref,
      ...(str(fm.namespace) ? { namespace: str(fm.namespace) } : {}),
      ...(str(entity?.entity_type) ? { entity_type: str(entity?.entity_type) } : {}),
      weighing,
      frontmatter: structuredClone(fm),
      body: a.body ?? "",
    };
  }

  resolve(ref: string, asOf: Date): Resolved {
    const raw = ref.trim();
    const uuid = raw.replace(/^urn:mif:/i, "");
    let paths: string[] = [];
    if (UUID.test(uuid)) {
      // Every note is checked, not the bundle's id index: that index keeps one path per id, so it
      // cannot show two notes carrying the same id. Two matches are ambiguous, never a silent pick.
      const want = uuid.toLowerCase();
      paths = this.manager.all().flatMap((a) => (a.isConcept && str(a.frontmatter?.id)?.toLowerCase() === want ? [a.path] : []));
    } else {
      const p = raw.replace(/^\/+/, "");
      if (this.manager.get(p)?.isConcept) paths = [p];
      else paths = this.manager.bundleRoots().map((root) => this.manager.toVaultPath(root, p)).filter((v) => this.manager.get(v)?.isConcept);
      if (paths.length === 0) paths = this.byTitle(raw);
    }
    paths = [...new Set(paths)].sort();
    if (paths.length > 1) return { ambiguous: paths.slice(0, 12).map((v) => `${v} — ${this.ref(v)?.title ?? ""}`) };
    const concept = paths[0] === undefined ? undefined : this.view(paths[0], asOf);
    return concept ? { concept } : { missing: true };
  }

  /**
   * Concepts a title reference names, most specific reading first: the whole
   * title, then the reference as a word of the title ("C08" is a word of
   * "C08 Supply Chain" but not of "C08.01 Planning"), then any title that
   * contains it. The first reading that matches anything decides.
   */
  private byTitle(ref: string): string[] {
    const want = ref.trim().toLowerCase();
    if (want.length < 2) return [];
    const titled = this.manager.all().flatMap((a) => {
      const t = a.isConcept ? str(a.frontmatter?.title) : undefined;
      return t ? [{ path: a.path, title: t.toLowerCase() }] : [];
    });
    const exact = titled.filter((c) => c.title === want);
    if (exact.length) return exact.map((c) => c.path);
    const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const word = new RegExp(`(^|[^\\w.-])${escaped}($|[^\\w.-])`);
    const worded = titled.filter((c) => word.test(c.title));
    if (worded.length) return worded.map((c) => c.path);
    return titled.filter((c) => c.title.includes(want)).map((c) => c.path);
  }

  uniqueTitles(): Set<string> {
    const seen = new Map<string, number>();
    for (const a of this.manager.all()) {
      const t = a.isConcept ? str(a.frontmatter?.title)?.toLowerCase() : undefined;
      if (t) seen.set(t, (seen.get(t) ?? 0) + 1);
    }
    return new Set([...seen].filter(([, n]) => n === 1).map(([t]) => t));
  }

  edges(path: string): EdgeView[] {
    const ctx = this.manager.indexFor(path);
    if (!ctx) return [];
    const at = (bundlePath: string | undefined) => (bundlePath === undefined ? undefined : this.ref(this.manager.toVaultPath(ctx.info.root, bundlePath)));
    const edge = (direction: EdgeView["direction"], e: { type: string; target: string; strength?: number }, other: string | undefined): EdgeView => {
      const concept = at(other);
      return { type: e.type, direction, target: e.target, ...(e.strength === undefined ? {} : { strength: e.strength }), ...(concept ? { concept } : {}) };
    };
    return [
      ...(ctx.index.outgoing.get(ctx.bundlePath) ?? []).map((e) => edge("outgoing", e, e.resolved)),
      ...(ctx.index.incoming.get(ctx.bundlePath) ?? []).map((e) => edge("incoming", e, e.from)),
    ];
  }

  concepts(): ConceptSummary[] {
    return this.manager.all().flatMap((a) => {
      const ref = a.isConcept ? this.ref(a.path) : undefined;
      if (!ref) return [];
      const fm = (a.frontmatter ?? {}) as Record<string, unknown>;
      const entity = fm.entity && typeof fm.entity === "object" ? (fm.entity as Record<string, unknown>) : undefined;
      return [{ ...ref, ...(str(fm.namespace) ? { namespace: str(fm.namespace) } : {}), ...(str(entity?.entity_type) ? { entity_type: str(entity?.entity_type) } : {}) }];
    });
  }

  entities(): EntityView[] {
    const out: EntityView[] = [];
    for (const bundle of this.manager.bundleRoots()) {
      for (const [urn, e] of this.manager.entityIndex(bundle)) {
        const references = e.refs.flatMap((r) => {
          const concept = this.ref(r.path);
          return concept ? [{ concept, ...(r.role ? { role: r.role } : {}) }] : [];
        });
        const name = e.record?.name ?? e.refs.find((r) => r.name)?.name;
        // urn:mif:entity:<type>:<slug>
        const type = e.record?.type ?? e.record?.typeSegment ?? urn.split(":")[3];
        out.push({ urn, ...(name ? { name } : {}), ...(type ? { type } : {}), aliases: e.record?.aliases ?? [], bundle, recorded: !!e.record, references });
      }
    }
    return out.sort((a, b) => a.urn.localeCompare(b.urn));
  }

  thresholds() {
    return this.manager.similarity();
  }

  private async cliProblem(): Promise<Unavailable | undefined> {
    const why = this.cli.unavailable() ?? (await this.cli.checkVersion());
    return why ? { unavailable: `This needs mif-cli: ${why}` } : undefined;
  }

  private hit(h: { id: string; path?: string; title?: string; cosine?: number; heading?: string; text?: string }): SearchHit {
    const concept = h.path ? this.ref(h.path) : undefined;
    return {
      id: h.id,
      ...(concept ? { concept } : {}),
      ...(h.title ? { title: h.title } : {}),
      ...(h.cosine === undefined ? {} : { cosine: h.cosine }),
      ...(h.heading ? { heading: h.heading } : {}),
      ...(h.text ? { passage: h.text } : {}),
    };
  }

  async similar(path: string, limit: number): Promise<SearchHit[] | Unavailable> {
    const down = await this.cliProblem();
    if (down) return down;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !("extension" in file)) return { unavailable: `No note at ${path}.` };
    const hits = await this.cli.similar(file as never, limit);
    if (!Array.isArray(hits)) return { unavailable: [hits.title, hits.detail].filter(Boolean).join(": ") };
    return hits.map((h) => this.hit(h));
  }

  async store(bundle: string): Promise<StoreView | Unavailable> {
    const down = await this.cliProblem();
    if (down) return down;
    if (!(await this.cli.hasStore(bundle))) return { unavailable: "Nothing ingested yet: this bundle has no vector store. Ask the user to run “Ingest this bundle into the vector store” in Obsidian." };
    const status = await this.cli.status(bundle);
    const at = (state: string) => status.coverage.rows.filter((r) => r.state === state).map((r) => this.manager.toVaultPath(bundle, r.path));
    return {
      bundle,
      ...(status.stats ? { stored: status.stats.count } : {}),
      current: at("current").length,
      changed: at("changed"),
      never: at("never"),
      refused: this.cli.refusals(bundle).map((r) => ({ path: r.path, reason: [r.problem.title, r.problem.detail].filter(Boolean).join(": ") })),
      orphans: status.prunable.length,
    };
  }

  duplicateIds(): Array<{ id: string; paths: string[] }> {
    const by = new Map<string, string[]>();
    for (const a of this.manager.all()) {
      const id = a.isConcept ? str(a.frontmatter?.id)?.toLowerCase() : undefined;
      if (id && UUID.test(id)) by.set(id, [...(by.get(id) ?? []), a.path]);
    }
    return [...by].filter(([, paths]) => paths.length > 1).map(([id, paths]) => ({ id: `urn:mif:${id}`, paths: paths.sort() })).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The ontology catalog gives ontologies their addresses; learn it before serving, when the user allows downloads. */
  async prepare(): Promise<void> {
    await this.manager.refreshOntologyCatalog();
  }

  ontologies(): OntologyView[] {
    // An ontology's uri is the one this vault's concepts declare for it; failing that, its canonical
    // address in the mif-spec.dev catalog, if this definition is the catalog's own (same sha256);
    // failing that, urn:mif:ontology:<id> (owner decisions, plan M28 and M31).
    const uris = new Map<string, string>();
    for (const a of this.manager.all()) {
      const o = a.isConcept ? a.frontmatter?.ontology : undefined;
      if (o && typeof o === "object") {
        const ref = o as Record<string, unknown>;
        const id = str(ref.id);
        const uri = str(ref.uri);
        if (id && uri && !uris.has(id)) uris.set(id, uri);
      }
    }
    const out = new Map<string, OntologyView>();
    for (const bundle of this.manager.bundleRoots()) {
      for (const def of this.manager.bundleInfo(bundle)?.corpus.values() ?? []) {
        const seen = out.get(def.id);
        if (seen) {
          if (!seen.bundles.includes(bundle)) seen.bundles.push(bundle);
          continue;
        }
        const namespaces: string[] = [];
        const walk = (tree: unknown, prefix: string) => {
          if (!tree || typeof tree !== "object" || Array.isArray(tree)) return;
          for (const [k, v] of Object.entries(tree as Record<string, unknown>)) {
            if (k === "children") walk(v, prefix);
            else if (v && typeof v === "object" && !Array.isArray(v)) {
              namespaces.push(prefix ? `${prefix}/${k}` : k);
              walk((v as Record<string, unknown>).children, prefix ? `${prefix}/${k}` : k);
            }
          }
        };
        walk(def.namespaceTree, "");
        const declared = uris.get(def.id);
        const catalog = declared ? undefined : this.manager.ontologyAddress(def);
        const note = declared || catalog ? undefined : this.manager.ontologyInCatalog(def.id) ? "This copy differs from the one the mif-spec.dev catalog publishes under the same id." : "Not listed in the mif-spec.dev catalog, or the catalog is not known.";
        out.set(def.id, {
          id: def.id,
          version: def.version,
          uri: declared ?? catalog ?? `urn:mif:ontology:${def.id}`,
          address: declared ? "declared" : catalog ? "catalog" : "local",
          ...(note ? { address_note: note } : {}),
          ...(def.description ? { description: def.description } : {}),
          extends: [...def.extends],
          entity_types: def.entityTypes.map((t) => ({ name: t.name, base: t.base, subtype_of: [...(t.subtype_of ?? [])], ...(t.description ? { description: t.description } : {}) })),
          namespaces,
          bundles: [bundle],
          source: def.source,
        });
      }
    }
    return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  subtypes(type: string): string[] {
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
    const children = new Map<string, Set<string>>();
    for (const o of this.ontologies()) {
      for (const t of o.entity_types) {
        for (const parent of t.subtype_of) children.set(norm(parent), (children.get(norm(parent)) ?? new Set()).add(t.name));
      }
    }
    const found = new Map<string, string>([[norm(type), type]]);
    const queue = [norm(type)];
    while (queue.length) {
      for (const child of children.get(queue.shift()!) ?? []) {
        if (found.has(norm(child))) continue;
        found.set(norm(child), child);
        queue.push(norm(child));
      }
    }
    return [...found.values()];
  }

  entityTypes(): EntityTypeView[] {
    const out = new Map<string, EntityTypeView>();
    const roots = this.manager.bundleRoots();
    for (const name of CORE_ENTITY_TYPES) out.set(entitySlug(name), { name, slug: entitySlug(name), source: "core", subtype_of: [], bundles: [...roots], entities: 0, concepts: 0 });
    for (const o of this.ontologies()) {
      for (const t of o.entity_types) {
        const slug = entitySlug(t.name);
        const seen = out.get(slug);
        if (seen) {
          for (const b of o.bundles) if (!seen.bundles.includes(b)) seen.bundles.push(b);
          continue;
        }
        out.set(slug, { name: t.name, slug, source: o.id, base: t.base, ...(t.description ? { description: t.description } : {}), subtype_of: [...t.subtype_of], bundles: [...o.bundles], entities: 0, concepts: 0 });
      }
    }
    for (const e of this.entities()) {
      const t = e.recorded ? out.get(e.urn.split(":")[3] ?? "") : undefined;
      if (t) t.entities++;
    }
    for (const a of this.manager.all()) {
      const entity = a.isConcept ? a.frontmatter?.entity : undefined;
      const type = entity && typeof entity === "object" ? str((entity as Record<string, unknown>).entity_type) : undefined;
      const t = type ? out.get(entitySlug(type)) : undefined;
      if (t) t.concepts++;
    }
    // Core types first, in their own order; then each ontology's, by name.
    const all = [...out.values()];
    return [...all.filter((t) => t.source === "core"), ...all.filter((t) => t.source !== "core").sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name))];
  }

  private vocab?: { at: number; value: Vocabulary };

  vocabulary(): Vocabulary {
    // Asked for on every request, to put the vault's own values into the tool schemas; a few seconds stale is fine.
    if (this.vocab && Date.now() - this.vocab.at < 5_000) return this.vocab.value;
    const count = () => new Map<string, number>();
    const add = (m: Map<string, number>, v: string | undefined) => v && m.set(v, (m.get(v) ?? 0) + 1);
    const types = count(), entityTypes = count(), namespaces = count(), relationships = count(), folders = count(), trust = count();
    for (const a of this.manager.all()) {
      if (!a.isConcept) continue;
      const fm = (a.frontmatter ?? {}) as Record<string, unknown>;
      add(types, str(fm.type));
      add(namespaces, str(fm.namespace));
      add(entityTypes, fm.entity && typeof fm.entity === "object" ? str((fm.entity as Record<string, unknown>).entity_type) : undefined);
      add(trust, trustOf(a.frontmatter));
      if (a.path.includes("/")) add(folders, a.path.slice(0, a.path.indexOf("/")));
      for (const r of Array.isArray(fm.relationships) ? fm.relationships : []) add(relationships, r && typeof r === "object" ? str((r as Record<string, unknown>).type) : undefined);
    }
    const ranked = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
    const value = { types: ranked(types), entity_types: ranked(entityTypes), namespaces: ranked(namespaces), relationship_types: ranked(relationships), folders: ranked(folders), trust: ranked(trust), bundles: this.manager.bundleRoots() };
    this.vocab = { at: Date.now(), value };
    return value;
  }

  async gaps(bundle: string, progress?: (done: number, total: number) => void): Promise<GapsView | Unavailable> {
    const down = await this.cliProblem();
    if (down) return down;
    const report = await this.cli.gaps(bundle, progress);
    if (!("unlinked" in report)) return { unavailable: [report.title, report.detail].filter(Boolean).join(": ") };
    const pair = (p: { aPath?: string; bPath?: string; cosine: number }) => {
      const a = p.aPath ? this.ref(p.aPath) : undefined;
      const b = p.bPath ? this.ref(p.bPath) : undefined;
      return { ...(a ? { a } : {}), ...(b ? { b } : {}), cosine: p.cosine };
    };
    return { bundle, compared: report.compared, unlinked: report.unlinked.map(pair), mislinks: report.mislinks.map(pair) };
  }

  async search(request: SearchRequest): Promise<SearchHit[] | Unavailable> {
    const why = this.cli.unavailable() ?? (await this.cli.checkVersion());
    if (why) return { unavailable: `Semantic search needs mif-cli: ${why}` };
    const hits = await this.cli.search(request.bundle, request.query, {
      limit: request.limit,
      semantic: request.semantic,
      ...(request.entityType ? { entityType: request.entityType } : {}),
      ...(request.folder ? { folder: request.folder } : {}),
    });
    if (!Array.isArray(hits)) return { unavailable: [hits.title, hits.detail].filter(Boolean).join(": ") };
    return hits.map((h) => {
      const concept = h.path ? this.ref(h.path) : undefined;
      return {
        id: h.id,
        ...(concept ? { concept } : {}),
        ...(h.title ? { title: h.title } : {}),
        ...(h.cosine === undefined ? {} : { cosine: h.cosine }),
        ...(h.heading ? { heading: h.heading } : {}),
        ...(h.text ? { passage: h.text } : {}),
      };
    });
  }
}

/** What mcp.cjs exports: the server code, loaded apart from the plugin's main bundle. */
export interface McpModule {
  startEndpoint: typeof startEndpoint;
}

export type McpStatus = { state: "off" } | { state: "running"; url: string } | { state: "failed"; reason: string };

/** Whether the settings switch should read on: the server is wanted and its last start did not fail. */
export const mcpServing = (enabled: boolean, status: McpStatus): boolean => enabled && status.state !== "failed";

/**
 * Keeps the settings switch showing whether the server is serving, not only
 * whether it is wanted. Obsidian's toggle calls its change handler when its
 * value is set from code, so `showing` lets that handler tell a correction
 * of the display from the user's own click.
 */
export class SwitchMirror {
  showing = false;
  constructor(private readonly toggle: { getValue(): boolean; setValue(on: boolean): unknown }) {}

  show(serving: boolean): void {
    if (this.toggle.getValue() === serving) return;
    this.showing = true;
    try {
      this.toggle.setValue(serving);
    } finally {
      this.showing = false;
    }
  }
}

/**
 * Runs this vault's MCP endpoint according to its settings. One vault, one
 * port: a port that cannot be bound leaves the server off and says why; it
 * never moves to another port, so a client's URL cannot end up pointing at a
 * different vault.
 */
export class McpService {
  private endpoint?: McpEndpoint;
  private running?: { port: number; writes: boolean };
  private queue: Promise<unknown> = Promise.resolve();
  status: McpStatus = { state: "off" };

  constructor(
    private readonly host: McpHost,
    private readonly settings: () => MifSettings,
    /** Node's http module on desktop; undefined where there is none (mobile). */
    private readonly http: () => typeof import("node:http") | undefined,
    /** The server code from mcp.cjs; undefined when the file is missing or cannot be loaded. */
    private readonly load: () => McpModule | undefined,
    private readonly version: string,
    private readonly log: (event: string, detail?: Record<string, unknown>) => void = () => undefined,
  ) {}

  /** Bring the endpoint in line with the settings. Calls are serialized. */
  sync(): Promise<McpStatus> {
    const next = this.queue.then(() => this.apply());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async apply(): Promise<McpStatus> {
    const s = this.settings();
    const want = s.mcpEnabled && s.mcpToken !== "";
    if (this.endpoint && (!want || this.running?.port !== s.mcpPort)) {
      await this.endpoint.close();
      this.endpoint = undefined;
      this.running = undefined;
      this.log("mcp-stopped");
    }
    if (!want) return (this.status = { state: "off" });
    if (this.endpoint) {
      // The write tools come and go with the setting: tell clients that are listening for list changes.
      if (this.running && this.running.writes !== s.mcpAllowWrites) {
        this.running.writes = s.mcpAllowWrites;
        this.endpoint.toolsChanged();
        this.log("mcp-tools-changed", { writes: s.mcpAllowWrites });
      }
      return this.status;
    }
    const http = this.http();
    if (!http) return (this.status = { state: "failed", reason: "The MCP server is desktop only." });
    const mcp = this.load();
    if (!mcp) return (this.status = { state: "failed", reason: "The MCP server's code (mcp.cjs) is missing from the plugin's folder. Reinstall the plugin's files." });
    if (!Number.isInteger(s.mcpPort) || s.mcpPort < 1024 || s.mcpPort > 65535) return (this.status = { state: "failed", reason: `Port ${s.mcpPort} is not between 1024 and 65535.` });
    try {
      // Never fatal: with no catalog, ontologies the vault gives no uri are simply not addressable.
      await this.host.prepare?.().catch((err: unknown) => this.log("mcp-prepare-failed", { message: (err as Error).message }));
      this.endpoint = await mcp.startEndpoint(http, {
        host: this.host,
        port: s.mcpPort,
        token: () => this.settings().mcpToken,
        version: this.version,
        onError: (error) => this.log("mcp-error", { message: error.message }),
      });
      this.running = { port: s.mcpPort, writes: s.mcpAllowWrites };
      this.log("mcp-started", { port: s.mcpPort });
      return (this.status = { state: "running", url: this.endpoint.url });
    } catch (err) {
      const code = (err as { code?: string }).code;
      const reason = code === "EADDRINUSE" ? `Port ${s.mcpPort} is already in use, perhaps by another vault. Choose a different port for this vault.` : `The MCP server did not start: ${(err as Error).message}`;
      this.log("mcp-start-failed", { port: s.mcpPort, code });
      return (this.status = { state: "failed", reason });
    }
  }

  async dispose(): Promise<void> {
    await this.queue;
    await this.endpoint?.close();
    this.endpoint = undefined;
    this.running = undefined;
    this.status = { state: "off" };
  }
}
