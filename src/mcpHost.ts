// The vault side of the MCP server: a McpHost over MifManager and the
// mif-cli bridge, and the service that starts and stops the endpoint for
// this vault. Read-only: nothing here writes a note or the vector store.

import type { App } from "obsidian";
import type { MifCli } from "./cliBridge";
import { trustOf } from "./engine";
import type { MifManager } from "./manager";
import { startEndpoint, type McpEndpoint } from "./mcp/http";
import type { ConceptRef, ConceptSummary, ConceptView, EdgeView, EntityView, GapsView, McpHost, Resolved, SearchHit, SearchRequest, StoreView, Unavailable, Weighing } from "./mcp/host";
import type { MifSettings } from "./settings";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export class VaultMcpHost implements McpHost {
  constructor(
    private readonly app: App,
    private readonly manager: MifManager,
    private readonly cli: MifCli,
    private readonly settings: () => MifSettings,
  ) {}

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
      // The id index is per bundle; the same id in two bundles is ambiguous, never a silent pick.
      for (const root of this.manager.bundleRoots()) {
        const bundlePath = this.manager.bundleInfo(root)?.index?.byId.get(uuid.toLowerCase());
        if (bundlePath !== undefined) paths.push(this.manager.toVaultPath(root, bundlePath));
      }
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

  async gaps(bundle: string): Promise<GapsView | Unavailable> {
    const down = await this.cliProblem();
    if (down) return down;
    const report = await this.cli.gaps(bundle);
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

export type McpStatus = { state: "off" } | { state: "running"; url: string } | { state: "failed"; reason: string };

/**
 * Runs this vault's MCP endpoint according to its settings. One vault, one
 * port: a port that cannot be bound leaves the server off and says why; it
 * never moves to another port, so a client's URL cannot end up pointing at a
 * different vault.
 */
export class McpService {
  private endpoint?: McpEndpoint;
  private running?: { port: number };
  private queue: Promise<unknown> = Promise.resolve();
  status: McpStatus = { state: "off" };

  constructor(
    private readonly host: McpHost,
    private readonly settings: () => MifSettings,
    /** Node's http module on desktop; undefined where there is none (mobile). */
    private readonly http: () => typeof import("node:http") | undefined,
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
    if (this.endpoint) return this.status;
    const http = this.http();
    if (!http) return (this.status = { state: "failed", reason: "The MCP server is desktop only." });
    if (!Number.isInteger(s.mcpPort) || s.mcpPort < 1024 || s.mcpPort > 65535) return (this.status = { state: "failed", reason: `Port ${s.mcpPort} is not between 1024 and 65535.` });
    try {
      this.endpoint = await startEndpoint(http, {
        host: this.host,
        port: s.mcpPort,
        token: () => this.settings().mcpToken,
        version: this.version,
        onError: (error) => this.log("mcp-error", { message: error.message }),
      });
      this.running = { port: s.mcpPort };
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
