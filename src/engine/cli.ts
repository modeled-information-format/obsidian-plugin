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
  /** Present when the CLI reported its model (mif-rs ≥ the ingest-embedding-reference change). */
  embedding?: EmbeddingInfo;
}

export function parseIngest(stdout: string): IngestResult | undefined {
  const line = stdout.split("\n").find((l) => /\blint=/.test(l));
  if (!line) return undefined;
  const checks: Record<string, string> = {};
  for (const m of line.matchAll(/(\w+)=([^\s,()]+)/g)) checks[m[1]!] = m[2]!;
  const dimensions = Number(checks.embedding_dim);
  const embedding: EmbeddingInfo | undefined =
    checks.model && Number.isInteger(dimensions) && dimensions > 0
      ? { model: checks.model, ...(checks.model_version ? { modelVersion: checks.model_version } : {}), dimensions, normalized: checks.normalized === "true" }
      : undefined;
  return { checks, id: checks.id, stored: checks.stored === "true", ...(embedding ? { embedding } : {}) };
}

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

/** `count=6 dim=384 db=…` from `corpus-stats`. */
export function parseStats(stdout: string): { count: number; dim?: number } | undefined {
  const m = /count=(\d+)(?:\s+dim=(\d+))?/.exec(stdout);
  return m ? { count: Number(m[1]), dim: m[2] ? Number(m[2]) : undefined } : undefined;
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
