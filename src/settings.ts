export type SyncMode = "observe" | "sync";

export interface MifSettings {
  /** Observe validates and fixes on request; Sync also stamps `modified` on save. */
  mode: SyncMode;
  /** Vault-relative bundle roots; "" is the vault root. Longest match wins. */
  bundleRoots: string[];
  /** Vault-relative folders never treated as MIF, even inside a bundle. */
  excludedFolders: string[];
  showDevCommands: boolean;
  /** Download ontologies a bundle needs from mif-spec.dev (cached; verified by sha256). */
  downloadOntologies: boolean;
  /** Ontology used for namespace hints when a concept declares none. */
  defaultOntology: string;
  /** Decay strength at or above which a concept is "fresh". */
  freshThreshold: number;
  /** Decay strength at or above which a concept is "ageing" (else "stale"). */
  ageingThreshold: number;
  /** Write accessCount / lastAccessed when a concept is opened (writes on read). */
  accessTracking: boolean;
  /** Freshness dots in the file explorer (uses an undocumented Obsidian API). */
  explorerBadges: boolean;
  /** Vault folder for JSON-LD exports: <folder>/<bundle>/<path>.jsonld (spec §3.2: dist/jsonld). */
  exportFolder: string;
  /** Desktop only: absolute path to mif-rs's `mif-cli`; empty turns the bridge off. */
  mifCliPath: string;
  /** Desktop only: keep an existing vector store current as concepts are added and changed (never writes a note). */
  backgroundIngest: boolean;
  /** After a stored ingest you start, write the EmbeddingReference into the note's frontmatter. */
  writeEmbeddingReference: boolean;
  /** Cosine similarity at or above which a new concept is reported as a likely duplicate. */
  duplicateThreshold: number;
  /** Cosine similarity at or above which two unrelated concepts are a relationship gap. */
  similarThreshold: number;
  /** Cosine similarity at or below which a typed relationship is reported as a possible mislink. */
  mislinkThreshold: number;
  /** Desktop only: serve this vault's MIF graph to MCP clients on localhost. Off until turned on for this vault. */
  mcpEnabled: boolean;
  /** The localhost port this vault's MCP server listens on; each open vault needs its own. */
  mcpPort: number;
  /** Bearer token MCP clients must send; generated the first time the server is turned on. */
  mcpToken: string;
  /** One line telling an agent what this vault's memory is for. */
  mcpPurpose: string;
  /** Let MCP clients write: create and supersede concepts, change relationships, add citations and entities, ingest. Off until turned on. */
  mcpAllowWrites: boolean;
  /** Writes an MCP client may make within the window below; more are refused until the window moves on. */
  mcpWriteLimit: number;
  /** Length in minutes of the window the write limit counts over. */
  mcpWriteWindowMinutes: number;
}

export const DEFAULT_SETTINGS: MifSettings = {
  mode: "observe",
  bundleRoots: [""],
  excludedFolders: ["_spike", "templates"],
  showDevCommands: false,
  downloadOntologies: true,
  defaultOntology: "mif-base",
  freshThreshold: 0.75,
  ageingThreshold: 0.5,
  accessTracking: false,
  explorerBadges: true,
  exportFolder: "dist/jsonld",
  mifCliPath: "",
  backgroundIngest: false,
  writeEmbeddingReference: true,
  duplicateThreshold: 0.55,
  similarThreshold: 0.55,
  mislinkThreshold: 0.1,
  mcpEnabled: false,
  mcpPort: 27182,
  mcpToken: "",
  mcpPurpose: "",
  mcpAllowWrites: false,
  mcpWriteLimit: 30,
  mcpWriteWindowMinutes: 10,
};

const clean = (p: string) => p.trim().replace(/^\/+|\/+$/g, "");

/** Load saved data, migrating the earlier single `bundleRoot` setting. */
export function loadSettings(data: unknown): MifSettings {
  const saved = (data ?? {}) as Partial<MifSettings> & { bundleRoot?: string };
  const settings: MifSettings = { ...DEFAULT_SETTINGS, ...saved };
  if (saved.bundleRoots === undefined && typeof saved.bundleRoot === "string") {
    settings.bundleRoots = [clean(saved.bundleRoot)];
  }
  settings.bundleRoots = [...new Set(settings.bundleRoots.map(clean))];
  if (settings.bundleRoots.length === 0) settings.bundleRoots = [""];
  settings.excludedFolders = settings.excludedFolders.map(clean).filter(Boolean);
  delete (settings as { bundleRoot?: string }).bundleRoot;
  return settings;
}

export const parseLines = (text: string) => text.split("\n").map(clean);
