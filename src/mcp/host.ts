// What the MCP tool layer needs from the vault. Nothing in src/mcp imports
// Obsidian: the plugin supplies a host backed by MifManager and the mif-cli
// bridge (src/mcpHost.ts), and tests supply one over the in-memory vault.

/** How much a recalled concept can be relied on. Returned with every concept. */
export interface Weighing {
  /** fresh, ageing, stale, expired, not-yet-valid, or timeless (no decay model and no expiry). */
  freshness: string;
  /** Decay strength from 0 to 1, when the concept has a decay model. */
  strength?: number;
  expires_at?: string;
  /** provenance.trustLevel, when the concept records one. */
  trust?: string;
  /** provenance.sourceType, when the concept records one. */
  source_type?: string;
  /** MIF conformance level, 0 to 3. */
  level: number;
  errors: number;
  warnings: number;
}

export interface ConceptRef {
  /** Canonical MIF identifier, urn:mif:<uuid>; absent when the note has no valid id. */
  id?: string;
  /** Vault-relative path. */
  path: string;
  /** Bundle root; "" is the vault root. */
  bundle: string;
  title: string;
  type?: string;
}

export interface ConceptView extends ConceptRef {
  namespace?: string;
  entity_type?: string;
  weighing: Weighing;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface EdgeView {
  type: string;
  direction: "outgoing" | "incoming";
  /** The target as written in the source concept's frontmatter. */
  target: string;
  strength?: number;
  /** The concept at the other end, when the target resolves inside the bundle. */
  concept?: ConceptRef;
}

export interface SearchHit {
  concept?: ConceptRef;
  /** The stored document's id, urn:mif:<uuid>. */
  id: string;
  title?: string;
  /** Cosine similarity of the best passage, 0 to 1. */
  cosine?: number;
  /** Heading of the matching passage; absent for the summary passage. */
  heading?: string;
  /** The matching passage's text. */
  passage?: string;
}

export interface SearchRequest {
  query: string;
  bundle: string;
  limit: number;
  semantic: boolean;
  entityType?: string;
  folder?: string;
}

/** Why a request could not be served, in words an agent can act on. */
export interface Unavailable {
  unavailable: string;
}

export type Resolved = { concept: ConceptView } | { ambiguous: string[] } | { missing: true };

export interface McpHost {
  vault(): { name: string; purpose: string; bundles: string[] };
  /**
   * A concept by urn:mif:<uuid>, bare uuid, vault path, or bundle path
   * ("/semantic/x.md"). `asOf` is the instant freshness is judged at.
   */
  resolve(ref: string, asOf: Date): Resolved;
  /** Typed relationships of the concept at a vault path, one hop, both directions. */
  edges(path: string): EdgeView[];
  /** A concept's weighing, for the far end of an edge or a search hit. */
  weigh(path: string, asOf: Date): Weighing | undefined;
  search(request: SearchRequest): Promise<SearchHit[] | Unavailable>;
}
