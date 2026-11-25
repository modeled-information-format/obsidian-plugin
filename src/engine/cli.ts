// Parsing the output of mif-rs's `mif-cli`. The bridge
// itself (spawning the binary) is desktop-only and lives in src/cliBridge.ts.

/** `0.5055  urn:mif:<uuid>` lines from `search` / `find-similar`. */
export interface ScoredId {
  score: number;
  id: string;
}

export function parseScored(stdout: string): ScoredId[] {
  const out: ScoredId[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s+(\S+)\s*$/i.exec(line);
    if (m) out.push({ score: Number(m[1]), id: m[2]! });
  }
  return out;
}

/** What `mif-cli` embedded with: `model=… model_version=… embedding_dim=… normalized=…` in the ingest line. */
export interface EmbeddingInfo {
  model: string;
  modelVersion?: string;
  dimensions: number;
  normalized: boolean;
}

/** `path: lint=ok validate=ok roundtrip=lossless embedding_dim=384 model=… model_version=… normalized=true stored=true (id=…, db=…)` */
export interface IngestResult {
  checks: Record<string, string>;
  id?: string;
  stored: boolean;
  /** `--changed-only` found the store already current: `path: unchanged stored=false (id=…, db=…)`. */
  unchanged?: boolean;
  /** Present when the CLI reported its model (mif-rs ≥ the ingest-embedding-reference change). */
  embedding?: EmbeddingInfo;
}

const INGEST_LINE = /\blint=|: unchanged stored=/;

export function parseIngest(stdout: string): IngestResult | undefined {
  const line = stdout.split("\n").find((l) => INGEST_LINE.test(l));
  return line ? parseIngestLine(line) : undefined;
}

function parseIngestLine(line: string): IngestResult {
  const checks: Record<string, string> = {};
  for (const m of line.matchAll(/(\w+)=([^\s,()]+)/g)) checks[m[1]!] = m[2]!;
  const dimensions = Number(checks.embedding_dim);
  const embedding: EmbeddingInfo | undefined =
    checks.model && Number.isInteger(dimensions) && dimensions > 0
      ? { model: checks.model, ...(checks.model_version ? { modelVersion: checks.model_version } : {}), dimensions, normalized: checks.normalized === "true" }
      : undefined;
  const unchanged = /(?:^|: )unchanged stored=/.test(line);
  return { checks, id: checks.id, stored: checks.stored === "true", ...(unchanged ? { unchanged } : {}), ...(embedding ? { embedding } : {}) };
}

/**
 * Every result of an `ingest` given several files, keyed by the file as it
 * was passed. A stored or unchanged document is a result line on stdout; a
 * refused one is `FILE: error: …` on stderr.
 */
export function parseIngestBatch(stdout: string, stderr: string, files: string[]): Map<string, IngestResult | Problem> {
  const out = new Map<string, IngestResult | Problem>();
  const fileOf = (line: string) => files.find((f) => line.startsWith(`${f}: `));
  for (const line of stdout.split("\n")) {
    const f = INGEST_LINE.test(line) ? fileOf(line) : undefined;
    if (f) out.set(f, parseIngestLine(line.slice(f.length + 2)));
  }
  for (const line of stderr.split("\n")) {
    const f = fileOf(line);
    const rest = f ? line.slice(f.length + 2) : "";
    if (f && rest.startsWith("error: ")) out.set(f, { title: "Not ingested", detail: rest.slice("error: ".length) });
  }
  return out;
}

/** `mif-cli 0.13.0` → [0, 13, 0]. */
export function parseVersion(stdout: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** The oldest mif-cli the bridge works with: `search --format json` and its match fields arrive in 0.13.0. */
export const MIN_CLI_VERSION: [number, number, number] = [0, 13, 0];

export function versionAtLeast(v: [number, number, number], min: [number, number, number] = MIN_CLI_VERSION): boolean {
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i]! > min[i]!;
  return true;
}

/** One `search --format json` match: the document, the passage that matched, and the scores. */
export interface Match extends ScoredId {
  /** Cosine similarity of the best passage; `score` is a rank-fusion value in hybrid mode. */
  cosine?: number;
  /** Source path as recorded at ingest, relative to the folder that holds `.mif/`. */
  source?: string;
  title?: string;
  entityType?: string;
  conceptType?: string;
  /** Heading of the matching passage; absent for the summary passage. */
  heading?: string;
  /** The matching passage's text. */
  text?: string;
  /** First line of the passage in the document body; the body's first line is 1. */
  startLine?: number;
}

export function parseMatches(stdout: string): Match[] | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const list = (doc as { matches?: unknown } | null)?.matches;
  if (!Array.isArray(list)) return undefined;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const out: Match[] = [];
  for (const raw of list as Array<Record<string, unknown>>) {
    const id = str(raw?.id);
    const score = num(raw?.score);
    if (!id || score === undefined) continue;
    const m: Match = { score, id };
    const set = <K extends keyof Match>(k: K, v: Match[K] | undefined) => {
      if (v !== undefined) m[k] = v;
    };
    set("cosine", num(raw.cosine));
    set("source", str(raw.path));
    set("title", str(raw.title));
    set("entityType", str(raw.entity_type));
    set("conceptType", str(raw.concept_type));
    set("heading", str(raw.heading));
    set("text", str(raw.text));
    set("startLine", num((raw.span as { start_line?: unknown } | null)?.start_line));
    out.push(m);
  }
  return out;
}

/**
 * The 0-based line of a note to open for a match: its heading's line when
 * the note still has that heading, else the span's line counted from the
 * end of the frontmatter, else undefined (the summary passage: the top).
 */
export function passageLine(text: string, heading?: string, startLine?: number): number | undefined {
  const lines = text.split("\n");
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) bodyStart = end + 1;
  }
  if (heading) {
    const want = heading.trim();
    for (let i = bodyStart; i < lines.length; i++) {
      const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(lines[i]!);
      if (m && m[1] === want) return i;
    }
  }
  if (startLine !== undefined && startLine >= 1) return Math.min(lines.length - 1, bodyStart + startLine - 1);
  return undefined;
}

/** A passage's text as a one-paragraph snippet of at most `max` characters. */
export function snippet(text: string | undefined, title?: string, max = 220): string {
  if (!text) return "";
  // A passage leads with the document title; the result row already shows it.
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (title && lines.length > 1 && lines[0] === title.trim()) lines.shift();
  const flat = lines.join(" ").replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** `would prune <id>` / `pruned <id>` lines from `prune`. */
export function parsePrune(stdout: string): string[] {
  return [...stdout.matchAll(/^(?:would prune|pruned) (\S+)$/gm)].map((m) => m[1]!);
}

/**
 * A stable hash of what a concept says, to tell whether it changed since it
 * was ingested. Fields the plugin itself writes on the side (`modified`, the
 * `embedding` block, access tracking) are left out, so stamping a note does
 * not make it look changed.
 */
export function conceptHash(frontmatter: Record<string, unknown>, body: string): string {
  const { modified: _m, embedding: _e, temporal, ...rest } = frontmatter;
  let kept: unknown = temporal;
  if (temporal && typeof temporal === "object" && !Array.isArray(temporal)) {
    const { accessCount: _a, lastAccessed: _l, ...t } = temporal as Record<string, unknown>;
    kept = t;
  }
  const s = `${JSON.stringify({ ...rest, temporal: kept })}\n${body}`;
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = (Math.imul(b ^ c, 0x85ebca6b) + a) | 0;
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/** What the plugin recorded when it ingested a concept. */
export interface LedgerEntry {
  /** Bundle path of the note. */
  path: string;
  hash: string;
  /** ISO time of the ingest. */
  at: string;
}

export type Ledger = Record<string, LedgerEntry>;

export type CoverageState = "current" | "changed" | "never";

export interface Coverage {
  /** One row per concept of the bundle. */
  rows: Array<{ id: string; path: string; state: CoverageState; at?: string }>;
  /** Ledger ids no concept carries any more. */
  orphans: string[];
}

/** Compare the bundle's concepts (id, bundle path, content hash) with the ingest ledger. */
export function coverage(concepts: Array<{ id: string; path: string; hash: string }>, ledger: Ledger): Coverage {
  const seen = new Set<string>();
  const rows = concepts.map((c) => {
    const key = c.id.toLowerCase();
    seen.add(key);
    const e = ledger[key];
    const state: CoverageState = !e ? "never" : e.hash === c.hash ? "current" : "changed";
    return { id: key, path: c.path, state, ...(e ? { at: e.at } : {}) };
  });
  return { rows, orphans: Object.keys(ledger).filter((id) => !seen.has(id)) };
}

export interface GapPair {
  a: string;
  b: string;
  cosine: number;
}

/**
 * Relationship gaps from pairwise similarities: `unlinked` are pairs at or
 * above `high` with no typed relationship in either direction; `mislinks`
 * are related pairs at or below `low`. `similar` maps a concept to its
 * neighbours' scores, and `related` holds `a|b` keys with a < b.
 */
export function relationshipGaps(similar: Map<string, Map<string, number>>, related: Set<string>, high: number, low: number): { unlinked: GapPair[]; mislinks: GapPair[] } {
  const pairs = new Map<string, GapPair>();
  for (const [from, row] of similar) {
    for (const [to, cosine] of row) {
      if (from === to) continue;
      const [a, b] = from < to ? [from, to] : [to, from];
      const key = `${a}|${b}`;
      const prev = pairs.get(key);
      if (!prev || cosine > prev.cosine) pairs.set(key, { a, b, cosine });
    }
  }
  const unlinked: GapPair[] = [];
  const mislinks: GapPair[] = [];
  for (const [key, p] of pairs) {
    if (related.has(key)) {
      if (p.cosine <= low) mislinks.push(p);
    } else if (p.cosine >= high) unlinked.push(p);
  }
  unlinked.sort((x, y) => y.cosine - x.cosine);
  mislinks.sort((x, y) => x.cosine - y.cosine);
  return { unlinked, mislinks };
}

export const pairKey = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);

/**
 * The `embedding` frontmatter block for a concept `mif-cli` just stored: an
 * EmbeddingReference per the MIF embeddings section — model, version,
 * dimensions, normalization, and the vector's address. The vector itself
 * stays in the bundle's store, keyed by the concept's id, so `vectorUri` is
 * `urn:mif:vector:<id>`. No `sourceText`: the embedded text is the concept's
 * content, which the document already holds.
 */
export function embeddingReference(info: EmbeddingInfo, id: string): Record<string, unknown> {
  return {
    "@type": "EmbeddingReference",
    model: info.model,
    ...(info.modelVersion ? { modelVersion: info.modelVersion } : {}),
    dimensions: info.dimensions,
    vectorUri: `urn:mif:vector:${idFromUrn(id)}`,
    normalized: info.normalized,
  };
}

export interface StoreStats {
  count: number;
  dim?: number;
  /** Documents stored without passage text: no snippet or type filter until they are ingested again. */
  withoutText?: number;
}

/** `count=6 dim=384 db=… passages=… documents_without_passages=… documents_without_text=…` from `corpus-stats`. */
export function parseStats(stdout: string): StoreStats | undefined {
  const m = /count=(\d+)(?:\s+dim=(\d+))?/.exec(stdout);
  if (!m) return undefined;
  const t = /documents_without_text=(\d+)/.exec(stdout);
  return { count: Number(m[1]), dim: m[2] ? Number(m[2]) : undefined, ...(t ? { withoutText: Number(t[1]) } : {}) };
}

/** An RFC 9457 problem document, as `--format json` writes errors. */
export interface Problem {
  title: string;
  status?: number;
  detail?: string;
  type?: string;
}

export function parseProblem(stderr: string): Problem | undefined {
  const start = stderr.indexOf("{");
  if (start === -1) return undefined;
  try {
    const p = JSON.parse(stderr.slice(start)) as Partial<Problem>;
    return typeof p.title === "string" ? { title: p.title, status: p.status, detail: p.detail, type: p.type } : undefined;
  } catch {
    return undefined;
  }
}

/** urn:mif:<uuid> → <uuid> (the frontmatter id). */
export const idFromUrn = (urn: string) => (urn.startsWith("urn:mif:") ? urn.slice("urn:mif:".length) : urn);
