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
  /**
   * Set when the reference was a title or code that several concepts carry and this is the only one
   * valid at the time asked about: the vault paths of the others, which are expired or not yet valid.
   */
  set_aside?: string[];
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
  /** The ontology's address as a resource: always urn:mif:ontology:<id> (plan M63). */
  uri: string;
  /**
   * Where the definition is published, for information: the uri this vault's concepts declare for
   * it; failing that, its address in the mif-spec.dev catalog, when this definition is the one the
   * catalog publishes (same sha256). Absent for an ontology published nowhere this vault knows of.
   * It is not a resource address: the ontology is read at `uri`.
   */
  published_at?: string;
  /** Which of those it is. "local" also covers a bundle's edited copy of a catalog ontology. */
  address: "declared" | "catalog" | "local";
  /** Why it counts as "local". */
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

/** Who is writing: the MCP client, as it identified itself. Recorded in provenance; self-reported, not verified. */
export interface Author {
  agent: string;
  agent_version?: string;
}

/** Why a write was not made, in words an agent can act on. Nothing was changed. */
export interface Refused {
  refused: string;
}

export interface RelationshipWrite {
  type: string;
  /** Vault path of the concept the relationship points at. */
  target: string;
  strength?: number;
}

/** An entity type a bundle may record entities of: one of the core types, or one a loaded ontology defines. */
export interface EntityTypeView {
  /** As defined, e.g. "Person" or "agricultural-holding". */
  name: string;
  /** The type segment of an entity urn of this type, e.g. "person". */
  slug: string;
  /** "core", or the id of the ontology that defines it. */
  source: string;
  base?: string;
  description?: string;
  subtype_of: string[];
  bundles: string[];
  /** Entity records of this type. */
  entities: number;
  /** Concepts whose entity type this is. */
  concepts: number;
}

/** A change to an existing concept's own text. */
export interface ConceptEdit {
  /** The whole text, replacing the current one. */
  body?: string;
  /** One section replaced (or added), the rest left alone. */
  section?: { heading: string; text: string };
  summary?: string;
  tags?: string[];
}

export interface NewConceptInput {
  title: string;
  /** semantic, episodic or procedural. For a superseding concept, defaults to the old concept's. */
  type?: string;
  namespace?: string;
  /** Bundle-relative folder; defaults to a folder named for the type, or the old concept's folder. */
  folder?: string;
  bundle?: string;
  body: string;
  summary?: string;
  tags?: string[];
  entity_type?: string;
  relationships: RelationshipWrite[];
  citations: Array<Record<string, unknown>>;
  entities: Array<{ urn: string; name?: string; role?: string }>;
  valid_until?: string;
  /** Vault path of the concept this one supersedes: it gets a `supersedes` relationship, and the old one's validity ends now. */
  supersedes?: string;
}

export interface IngestView {
  bundle: string;
  stored: number;
  unchanged: number;
  failed: Array<{ path: string; reason: string }>;
}

export interface McpHost {
  /** Called once before the endpoint starts, for anything the host must fetch first. */
  prepare?(): Promise<void>;
  vault(): { name: string; purpose: string; bundles: string[] };
  /**
   * Every resource's uri with a signature that changes when its content does: what change
   * notifications are worked out from. Concepts without a valid id are not resources and are left out.
   */
  signatures(): Map<string, string>;
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
  /** The entity types entities may be recorded as: the core types, and those the loaded ontologies define. */
  entityTypes(): EntityTypeView[];
  /** Ids carried by more than one note, with the vault paths of each. */
  duplicateIds(): Array<{ id: string; paths: string[] }>;

  // --- writes (plan, Phase 2). Offered only while the vault's "Allow writes" setting is on. ---
  // Every write: is refused while its note is open with unsaved edits or is the active editor;
  // is checked against the MIF schema before anything is saved; never edits a note's own prose;
  // is logged; and raises a notice in Obsidian. A concept an agent creates is marked agent-written
  // and unverified (provenance.sourceType agent_inferred, trustLevel uncertain) with the client's name.

  writes(): { allowed: boolean; limit: number; window_minutes: number };
  /** Count one write against the limit; refused once the window is full. */
  admit(): Refused | undefined;
  /** `carried`: for a superseding concept, how many relationships it took over from the one it replaces. */
  createConcept(input: NewConceptInput, author: Author): Promise<{ concept: ConceptRef; carried: number } | Refused>;
  addRelationship(path: string, rel: RelationshipWrite, author: Author): Promise<{ concept: ConceptRef } | Refused>;
  /** Change the type or strength of the relationship `path` declares to `match.target`. */
  updateRelationship(path: string, match: { type: string; target: string }, next: { type?: string; strength?: number }, author: Author): Promise<{ concept: ConceptRef } | Refused>;
  removeRelationship(path: string, match: { type: string; target: string }, author: Author): Promise<{ concept: ConceptRef } | Refused>;
  addCitation(path: string, citation: Record<string, unknown>, author: Author): Promise<{ concept: ConceptRef } | Refused>;
  createEntity(bundle: string, entity: { type: string; name: string }, author: Author): Promise<{ urn: string; created: boolean } | Refused>;
  addEntityReference(path: string, entity: { urn: string; name?: string; role?: string }, author: Author): Promise<{ concept: ConceptRef } | Refused>;
  /**
   * Change a concept's own text. The mirrored Relationships and Citations sections are rebuilt from
   * the frontmatter, never taken from the edit. The concept goes back to review: trustLevel uncertain,
   * with the client recorded.
   */
  editConcept(path: string, edit: ConceptEdit, author: Author): Promise<{ concept: ConceptRef } | Refused>;
  /**
   * Merge the concepts at `from` into the one at `into`: it takes `body` as its text and their relationships,
   * citations and entity references, and supersedes each of them; each is kept with its validity ended.
   */
  mergeConcepts(into: string, from: string[], body: string, author: Author): Promise<{ concept: ConceptRef; merged: ConceptRef[]; warnings: string[] } | Refused>;
  /** Bring a bundle's vector store up to date. Changes the store only, never a note. */
  ingest(bundle: string, author: Author, progress?: (done: number, total: number) => void): Promise<IngestView | Unavailable>;
  /** Concepts an agent wrote or edited that nobody has reviewed since: trustLevel uncertain, and either sourceType agent_inferred or sourceRef "mcp:mif-vault". */
  reviewQueue(): ConceptRef[];
  /** The vault's cosine thresholds for duplicates, relationship gaps and mislinks. */
  thresholds(): { duplicate: number; similar: number; mislink: number };
}
