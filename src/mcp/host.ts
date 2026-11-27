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

/** An ontology the vault has loaded, from a bundle's .mif/ontologies/ or the mif-spec.dev catalog. */
export interface OntologyView {
  /** The ontology's identifier (ontology.id in its definition). */
  id: string;
  version: string;
  /**
   * Where the ontology is addressed (plan M28, M31): the uri this vault's
   * concepts declare for it; failing that, its canonical address in the
   * mif-spec.dev catalog, when this definition is the one the catalog
   * publishes; failing that, urn:mif:ontology:<id>.
   */
  uri: string;
  /** Which of those it is. "local" also covers a bundle's edited copy of a catalog ontology. */
  address: "declared" | "catalog" | "local";
  /** Why a "local" address was used. */
  address_note?: string;
  description?: string;
  extends: string[];
  entity_types: Array<{ name: string; base: string; subtype_of: string[]; description?: string }>;
  namespaces: string[];
  /** Bundles whose concepts can use it. */
  bundles: string[];
  /** Where the definition was loaded from. */
  source: string;
}

/** The values the vault actually uses, most used first: what a caller can filter by. */
export interface Vocabulary {
  types: string[];
  entity_types: string[];
  namespaces: string[];
  relationship_types: string[];
  folders: string[];
  trust: string[];
  bundles: string[];
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
  /** Called once before the endpoint starts, for anything the host must fetch first. */
  prepare?(): Promise<void>;
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
  /** Slow: one mif-cli run per concept of the bundle; `progress` is called after each. */
  gaps(bundle: string, progress?: (done: number, total: number) => void): Promise<GapsView | Unavailable>;
  /** Every ontology the vault's bundles have loaded, sorted by id. */
  ontologies(): OntologyView[];
  /** An entity type and every type the loaded ontologies declare as its subtype, at any depth. Names compare without case or punctuation. */
  subtypes(type: string): string[];
  vocabulary(): Vocabulary;
  /** Ids carried by more than one note, with the vault paths of each. */
  duplicateIds(): Array<{ id: string; paths: string[] }>;
  /** The vault's cosine thresholds for duplicates, relationship gaps and mislinks. */
  thresholds(): { duplicate: number; similar: number; mislink: number };
}
