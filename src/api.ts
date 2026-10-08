// A read-only API for other plugins and scripts (DataviewJS,
// Templater, …): `app.plugins.plugins.mif.api`. Values are computed live,
// the same as the panels show; nothing here writes.

import { compressionState, trustOf, type Level } from "./engine";
import type { MifManager } from "./manager";

export interface MifConceptInfo {
  path: string;
  id?: string;
  type?: string;
  namespace?: string;
  level: Level;
  errors: number;
  warnings: number;
  freshness?: string;
  strength?: number;
  trust?: string;
  compressed: boolean;
}

export interface MifRelation {
  type: string;
  /** Vault path of the other concept, when it resolves. */
  path?: string;
  target: string;
}

export class MifApi {
  readonly version = 1;
  constructor(private readonly manager: MifManager) {}

  /** MIF facts about one note, or undefined when it is not a concept in a bundle. */
  concept(path: string): MifConceptInfo | undefined {
    const a = this.manager.get(path);
    if (!a?.isConcept) return undefined;
    const fm = a.frontmatter ?? {};
    const f = this.manager.freshnessOf(path);
    return {
      path,
      id: typeof fm.id === "string" ? fm.id : undefined,
      type: typeof fm.type === "string" ? fm.type : undefined,
      namespace: typeof fm.namespace === "string" ? fm.namespace : undefined,
      level: a.level,
      errors: a.diagnostics.filter((d) => d.severity === "error").length,
      warnings: a.diagnostics.filter((d) => d.severity === "warning").length,
      freshness: f?.state,
      strength: f?.strength,
      trust: trustOf(a.frontmatter),
      compressed: compressionState(a.frontmatter).compressed,
    };
  }

  /** Every concept the plugin knows, sorted by path. */
  concepts(): MifConceptInfo[] {
    return this.manager.all().map((a) => this.concept(a.path)).filter((c): c is MifConceptInfo => !!c);
  }

  /** Outgoing and incoming typed relationships of a note. */
  relations(path: string): { outgoing: MifRelation[]; incoming: MifRelation[] } {
    const ctx = this.manager.indexFor(path);
    if (!ctx) return { outgoing: [], incoming: [] };
    const vault = (p: string | undefined) => (p === undefined ? undefined : this.manager.toVaultPath(ctx.info.root, p));
    return {
      outgoing: (ctx.index.outgoing.get(ctx.bundlePath) ?? []).map((e) => ({ type: e.type, target: e.target, path: vault(e.resolved) })),
      incoming: (ctx.index.incoming.get(ctx.bundlePath) ?? []).map((e) => ({ type: e.type, target: e.target, path: vault(e.from) })),
    };
  }

  /** The JSON-LD projection of a note (a copy), when it has one. */
  jsonld(path: string): Record<string, unknown> | undefined {
    const j = this.manager.get(path)?.jsonld;
    return j ? structuredClone(j) : undefined;
  }
}
