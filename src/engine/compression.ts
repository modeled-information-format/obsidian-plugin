// Compression (spec §5.6). The schema field is `compressedAt`; §5.6 writes
// `compressed_at`. Compressing replaces the body with the
// summary and keeps the original in `extensions.original_content` (§5.6.3),
// but never removes the `## Relationships` or `## Citations` sections: the
// relationship mirror is required (Invariant 3), which §5.6.3 does not
// account for (F43).

import type { Diagnostic, Fix } from "./analyze";
import { parseMarkdown, type Frontmatter } from "./convert";
import { applyEdit } from "./form";
import { WriteError } from "./writer";

const DAY = 86_400_000;
export const COMPRESS_MIN_LINES = 100;
export const COMPRESS_MIN_AGE_DAYS = 30;
export const COMPRESS_MAX_STRENGTH = 0.3;

const KEPT_SECTIONS = new Set(["relationships", "citations"]);

/** Split a body into prose and the mirror sections compression must keep. */
export function splitBody(body: string): { prose: string; kept: string } {
  const lines = body.split("\n");
  const prose: string[] = [];
  const kept: string[] = [];
  let keeping = false;
  for (const line of lines) {
    const s = line.trim();
    if (s.startsWith("## ")) keeping = KEPT_SECTIONS.has(s.slice(3).trim().toLowerCase());
    (keeping ? kept : prose).push(line);
  }
  return { prose: prose.join("\n").replace(/\s+$/, ""), kept: kept.join("\n").replace(/\s+$/, "") };
}

/** Lines of content §5.6.2 counts: the prose, without the mirror sections. */
export const contentLines = (body: string) => {
  const { prose } = splitBody(body);
  return prose ? prose.split("\n").length : 0;
};

const original = (fm: Frontmatter) => {
  const ext = fm.extensions && typeof fm.extensions === "object" ? (fm.extensions as Record<string, unknown>) : undefined;
  return typeof ext?.original_content === "string" ? ext.original_content : undefined;
};

export interface CompressionState {
  compressed: boolean;
  at?: string;
  summary?: string;
  hasOriginal: boolean;
}

export function compressionState(fm: Frontmatter | undefined): CompressionState {
  const at = typeof fm?.compressedAt === "string" ? fm.compressedAt : typeof fm?.compressed_at === "string" ? fm.compressed_at : undefined;
  return {
    compressed: at !== undefined,
    at,
    summary: typeof fm?.summary === "string" && fm.summary.trim() ? fm.summary : undefined,
    hasOriginal: fm ? original(fm) !== undefined : false,
  };
}

export function compressionDiagnostics(fm: Frontmatter, body: string, opts: { now?: Date; strength?: number } = {}): Diagnostic[] {
  const now = opts.now ?? new Date();
  const out: Diagnostic[] = [];
  if ("compressed_at" in fm) {
    const both = "compressedAt" in fm;
    out.push({
      severity: "warning",
      code: "compressed-at-name",
      message: both
        ? "Both `compressed_at` and `compressedAt` are set; the schema and tools read only `compressedAt`."
        : "`compressed_at` is the spelling in spec §5.6, but the schema, the JSON-LD context, and the tools read `compressedAt`.",
      path: ["compressed_at"],
      fixes: [both
        ? { label: "Remove compressed_at", edits: [{ path: ["compressed_at"], value: undefined }] }
        : { label: "Rename to compressedAt", edits: [{ path: ["compressed_at"], value: undefined }, { path: ["compressedAt"], value: fm.compressed_at }] }],
    });
  }
  const state = compressionState(fm);
  if (state.compressed && !state.summary) {
    out.push({ severity: "warning", code: "compression-no-summary", message: "Marked compressed, but there is no `summary` (§5.6.3).", path: ["summary"], fixes: [] });
  }
  const at = typeof fm.compressedAt === "string" ? Date.parse(fm.compressedAt) : NaN;
  if (!Number.isNaN(at) && at > now.getTime() + 60_000) {
    out.push({ severity: "warning", code: "compression-future", message: `compressedAt ${String(fm.compressedAt)} is in the future.`, path: ["compressedAt"], fixes: [] });
  }

  if (!state.compressed) {
    const lines = contentLines(body);
    const created = typeof fm.created === "string" ? Date.parse(fm.created) : NaN;
    const ageDays = Number.isNaN(created) ? undefined : Math.floor((now.getTime() - created) / DAY);
    const old = ageDays !== undefined && ageDays > COMPRESS_MIN_AGE_DAYS;
    const weak = opts.strength !== undefined && opts.strength < COMPRESS_MAX_STRENGTH;
    if (lines > COMPRESS_MIN_LINES && (old || weak)) {
      const why = old ? `${ageDays} days old` : `strength ${opts.strength!.toFixed(2)}`;
      const fixes: Fix[] = state.summary ? [{ label: "Compress: replace the body with the summary", transform: "compress" }] : [];
      out.push({
        severity: "info",
        code: "compression-candidate",
        message: `${lines} lines and ${why}: meets §5.6.2's compression criteria.${state.summary ? "" : " Write a `summary` (up to 500 characters) to compress it."}`,
        path: [],
        fixes,
      });
    }
  }
  return out;
}

const splitDoc = (text: string) => {
  const close = text.indexOf("\n---", 4);
  const bodyStart = text.indexOf("\n", close + 1) + 1 || text.length;
  return { head: text.slice(0, bodyStart), body: text.slice(bodyStart) };
};

/**
 * §5.6.3: keep the prose in `extensions.original_content`, replace it with
 * the summary (a leading `# Heading` stays), stamp `compressedAt`.
 */
export function compress(text: string, now: Date = new Date()): string {
  const fm = parseMarkdown(text).frontmatter;
  const state = compressionState(fm);
  if (!state.summary) throw new WriteError("there is no summary to compress to");
  if (state.hasOriginal) throw new WriteError("extensions.original_content already holds an original");
  if (fm.extensions !== undefined && (fm.extensions === null || typeof fm.extensions !== "object")) throw new WriteError("extensions is not an object");
  const { body } = splitDoc(text);
  const { prose, kept } = splitBody(body);
  const heading = /^(\s*\n)*(# [^\n]*)\n/.exec(prose);
  const newBody = [heading ? heading[2] : undefined, state.summary.trim(), kept || undefined].filter((x) => x !== undefined).join("\n\n") + "\n";
  // No trailing newline: a block scalar that ends the frontmatter loses it on reading.
  let out = applyEdit(text, ["extensions", "original_content"], prose.replace(/^\s*\n/, ""));
  if ("compressed_at" in fm) out = applyEdit(out, ["compressed_at"], undefined);
  out = applyEdit(out, ["compressedAt"], now.toISOString().replace(/\.\d{3}Z$/, "Z"));
  return splitDoc(out).head + "\n" + newBody;
}

/** Undo `compress`: restore the original prose, keep the current mirror sections. */
export function decompress(text: string): string {
  const fm = parseMarkdown(text).frontmatter;
  const prose = original(fm);
  if (prose === undefined) throw new WriteError("no extensions.original_content to restore");
  const { kept } = splitBody(splitDoc(text).body);
  let out = applyEdit(text, ["extensions", "original_content"], undefined);
  for (const key of ["compressedAt", "compressed_at"]) if (key in fm) out = applyEdit(out, [key], undefined);
  const newBody = [prose.replace(/\s+$/, ""), kept || undefined].filter((x) => x !== undefined).join("\n\n") + "\n";
  return splitDoc(out).head + "\n" + newBody;
}
