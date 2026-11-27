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

/** A concept as it appears in a listing: identity plus what it can be filtered by. */
export interface ConceptSummary extends ConceptRef {
  namespace?: string;
  entity_type?: string;
}

/** An entity record from a bundle's .mif/entities/, or one only referenced by concepts. */
export interface EntityView {
  urn: string;
  name?: string;
  /** Declared type, e.g. "Person"; or the type segment of the urn. */
  type?: string;
  aliases: string[];
  bundle: string;
  /** False when concepts reference the urn but no entity record exists. */
  recorded: boolean;
  references: Array<{ concept: ConceptRef; role?: string }>;
}

/** How a bundle's vector store stands against its notes. */
export interface StoreView {
  bundle: string;
  /** Documents the store holds, when mif-cli could say. */
  stored?: number;
  current: number;
  /** Vault paths of concepts changed since they were ingested. */
  changed: string[];
  /** Vault paths of concepts never ingested. */
  never: string[];
  refused: Array<{ path: string; reason: string }>;
  /** Stored documents whose note is gone. */
  orphans: number;
}

export interface GapPairView {
  a?: ConceptRef;
  b?: ConceptRef;
  cosine: number;
}

export interface GapsView {
  bundle: string;
  compared: number;
  /** Similar concepts with no typed relationship in either direction. */
  unlinked: GapPairView[];
  /** Typed relationships whose two ends are unalike. */
  mislinks: GapPairView[];
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

/** `ambiguous` lists the candidates as "path — title", so the caller can pick one. */
export type Resolved = { concept: ConceptView } | { ambiguous: string[] } | { missing: true };

export interface McpHost {
  vault(): { name: string; purpose: string; bundles: string[] };
  /**
   * A concept by urn:mif:<uuid>, bare uuid, vault path, bundle path
   * ("/semantic/x.md"), or title: the whole title, a code that stands as a
   * word in exactly one title ("CON-P-92"), or text only one title contains.
   * `asOf` is the instant freshness is judged at.
   */
  resolve(ref: string, asOf: Date): Resolved;
  /** Lower-cased titles that exactly one concept carries; such a title names its concept on its own. */
  uniqueTitles(): Set<string>;
  /** Typed relationships of the concept at a vault path, one hop, both directions. */
  edges(path: string): EdgeView[];
  /** A concept's weighing, for the far end of an edge or a search hit. */
  weigh(path: string, asOf: Date): Weighing | undefined;
  search(request: SearchRequest): Promise<SearchHit[] | Unavailable>;
  /** Every concept in the vault, sorted by path. */
  concepts(): ConceptSummary[];
  /** Entity records and referenced entities of every bundle, sorted by urn. */
  entities(): EntityView[];
  /** The concepts nearest in meaning to the one at a vault path. */
  similar(path: string, limit: number): Promise<SearchHit[] | Unavailable>;
  store(bundle: string): Promise<StoreView | Unavailable>;
  /** Slow: one mif-cli run per concept of the bundle. */
  gaps(bundle: string): Promise<GapsView | Unavailable>;
  /** The vault's cosine thresholds for duplicates, relationship gaps and mislinks. */
  thresholds(): { duplicate: number; similar: number; mislink: number };
}
