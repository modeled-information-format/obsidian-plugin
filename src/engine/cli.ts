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

/** `path: lint=ok validate=ok roundtrip=lossless embedding_dim=384 stored=true (id=…, db=…)` */
export interface IngestResult {
  checks: Record<string, string>;
  id?: string;
  stored: boolean;
}

export function parseIngest(stdout: string): IngestResult | undefined {
  const line = stdout.split("\n").find((l) => /\blint=/.test(l));
  if (!line) return undefined;
  const checks: Record<string, string> = {};
  for (const m of line.matchAll(/(\w+)=([^\s,()]+)/g)) checks[m[1]!] = m[2]!;
  return { checks, id: checks.id, stored: checks.stored === "true" };
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
