// MIF markdown <-> JSON-LD projection (markdown is canonical, Invariant 2).
//
// Ported from the MIF reference converter scripts/mif_convert.py, with one
// deliberate divergence taken from mif-rs (crates/mif-frontmatter): every
// frontmatter key passes through to JSON-LD and back, not only a fixed
// list. The reference converter drops unknown keys, which breaks the
// round trip for ordinary Obsidian properties (cssclasses, publish, ...).

import { dumpYaml, loadYaml } from "./yaml11";

export const CONTEXT_URL = "https://mif-spec.dev/schema/context.jsonld";

/** Filenames OKF reserves; never concepts (mif_convert.RESERVED_FILENAMES). */
export const RESERVED_FILENAMES = new Set(["index.md", "log.md"]);

/** Canonical frontmatter key order (mif_convert.FRONTMATTER_ORDER). */
export const FRONTMATTER_ORDER = [
  "id",
  "type",
  "memoryType",
  "created",
  "modified",
  "namespace",
  "title",
  "summary",
  "properties",
  "compressedAt",
  "tags",
  "aliases",
  "temporal",
  "provenance",
  "embedding",
  "relationships",
  "citations",
  "documents",
  "entities",
  "ontology",
  "entity",
  "extensions",
] as const;

/** Keys the reference converter carries through; anything else it drops. */
export const REFERENCE_PASSTHROUGH: ReadonlySet<string> = new Set(
  FRONTMATTER_ORDER.filter((k) => k !== "id" && k !== "type"),
);

/** JSON-LD keys with their own mapping, never copied back to frontmatter. */
const JSONLD_SPECIAL_KEYS = new Set(["@context", "@type", "@id", "conceptType", "content", "timestamp"]);

export type Frontmatter = Record<string, unknown>;
export type JsonLd = Record<string, unknown>;
export type Namespaces = Record<string, string>;

export class FrontmatterError extends Error {
  override name = "FrontmatterError";
}

// Same shape as mif_convert.FRONTMATTER_RE: "---\n" at offset 0, the
// shortest run up to "\n---", then an optional newline. CRLF files do not
// match, exactly as upstream.
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Split a concept file into (frontmatter, body). */
export function parseMarkdown(md: string): { frontmatter: Frontmatter; body: string } {
  const match = FRONTMATTER_RE.exec(md);
  if (!match) throw new FrontmatterError("No YAML frontmatter found");
  const yamlText = match[1] ?? "";
  const body = match[2] ?? "";
  let loaded: unknown;
  try {
    loaded = loadYaml(yamlText);
  } catch (err) {
    throw new FrontmatterError(`Invalid YAML frontmatter: ${(err as Error).message}`, { cause: err });
  }
  if (loaded === null || loaded === undefined) return { frontmatter: {}, body };
  if (!isPlainObject(loaded)) throw new FrontmatterError("Frontmatter is not a mapping");
  return { frontmatter: loaded, body };
}

/** Frontmatter reordered per FRONTMATTER_ORDER, extras appended in order. */
export function orderedFrontmatter(fm: Frontmatter): Frontmatter {
  const out: Frontmatter = {};
  for (const key of FRONTMATTER_ORDER) if (key in fm) out[key] = fm[key];
  for (const [key, value] of Object.entries(fm)) if (!(key in out)) out[key] = value;
  return out;
}

/** Canonical serialization (mif_convert.serialize_markdown). */
export function serializeMarkdown(fm: Frontmatter, body: string): string {
  const yamlText = dumpYaml(orderedFrontmatter(fm)).trim();
  const trimmedBody = body.replace(/^\n+/, "").trimEnd() + "\n";
  return `---\n${yamlText}\n---\n\n${trimmedBody}`;
}

/** Project frontmatter + body to the derived JSON-LD document. */
export function mdToJsonLd(fm: Frontmatter, body: string, namespaces?: Namespaces): JsonLd {
  const ns = namespaces && Object.keys(namespaces).length > 0 ? namespaces : undefined;
  const jsonld: JsonLd = {
    "@context": ns ? [CONTEXT_URL, ns] : CONTEXT_URL,
    "@type": "Concept",
  };
  if ("id" in fm) {
    if (typeof fm.id !== "string") throw new FrontmatterError("`id` must be a string");
    jsonld["@id"] = `urn:mif:${fm.id}`;
  }
  if ("type" in fm) jsonld.conceptType = fm.type;

  // Known keys first in canonical order (matching the reference output's
  // key order), then every remaining key — the mif-rs divergence.
  for (const key of REFERENCE_PASSTHROUGH) if (key in fm) jsonld[key] = fm[key];
  for (const [key, value] of Object.entries(fm)) {
    if (key === "id" || key === "type" || key in jsonld) continue;
    if (JSONLD_SPECIAL_KEYS.has(key)) {
      throw new FrontmatterError(`frontmatter key \`${key}\` collides with a derived JSON-LD key`);
    }
    jsonld[key] = value;
  }

  jsonld.timestamp = fm.modified ?? fm.created ?? null;
  if ("summary" in fm) jsonld.description = fm.summary;
  jsonld.content = body.trim();
  return jsonld;
}

/** Recover (frontmatter, body) from a derived JSON-LD document. */
export function jsonLdToMd(jsonld: JsonLd): { frontmatter: Frontmatter; body: string } {
  const fm: Frontmatter = {};
  const id = jsonld["@id"];
  if (id !== undefined) {
    if (typeof id !== "string") throw new FrontmatterError("`@id` must be a string");
    fm.id = id.startsWith("urn:mif:") ? id.slice("urn:mif:".length) : id;
  }
  if ("conceptType" in jsonld) fm.type = jsonld.conceptType;
  // `description` is derived only when `summary` exists; otherwise it is a
  // genuine pass-through key (mif-rs JSONLD_SPECIAL_KEYS doc comment).
  const descriptionDerived = "summary" in jsonld;
  for (const [key, value] of Object.entries(jsonld)) {
    if (JSONLD_SPECIAL_KEYS.has(key)) continue;
    if (key === "description" && descriptionDerived) continue;
    fm[key] = value;
  }
  const content = jsonld.content;
  return { frontmatter: fm, body: typeof content === "string" ? content : "" };
}

/**
 * Frontmatter keys the JSON-LD projection cannot carry faithfully. A
 * `description` beside `summary` is overwritten by the summary-derived
 * OKF mirror (both mif_convert.py and mif-rs lose it). The plugin surfaces
 * these as warnings; mdToJsonLd throws for the hard collisions instead.
 */
export function projectionConflicts(fm: Frontmatter): string[] {
  const conflicts: string[] = [];
  if ("summary" in fm && "description" in fm && fm.description !== fm.summary) {
    conflicts.push("`description` is replaced by the value derived from `summary` in JSON-LD and lost on the round trip");
  }
  for (const key of JSONLD_SPECIAL_KEYS) {
    if (key in fm) conflicts.push(`\`${key}\` is a derived JSON-LD key and cannot be authored in frontmatter`);
  }
  return conflicts;
}

/** Normalize a concept file for comparison (mif_convert.normalize). */
export function normalize(md: string): string {
  const { frontmatter, body } = parseMarkdown(md);
  return serializeMarkdown(frontmatter, body);
}

/**
 * Invariant 4: md -> json-ld -> md must not lose data. Returns null when
 * lossless, otherwise a description of the first drift found.
 */
export function roundtripDrift(md: string, namespaces?: Namespaces): string | null {
  const { frontmatter, body } = parseMarkdown(md);
  // Through JSON text, like roundtrip_file(), so non-JSON values surface.
  const jsonld = JSON.parse(JSON.stringify(mdToJsonLd(frontmatter, body, namespaces))) as JsonLd;
  const back = jsonLdToMd(jsonld);
  const recovered = serializeMarkdown(back.frontmatter, back.body);
  const expected = serializeMarkdown(frontmatter, body);
  if (recovered === expected) return null;
  const a = recovered.split("\n");
  const b = expected.split("\n");
  const line = a.findIndex((l, i) => l !== b[i]);
  return `round-trip drift at line ${line + 1}: expected ${JSON.stringify(b[line])}, got ${JSON.stringify(a[line])}`;
}
