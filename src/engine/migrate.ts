// MIF 0.1.0-draft → 1.0.0 migration, ported from MIF's
// scripts/migrate_0_1_to_1_0.py (MIGRATION.md):
//   - `*.memory.md` → `*.md`
//   - a non-UUID `id` becomes a deterministic UUIDv5, the old slug an alias
//   - body `## Relationships` wiki-links become markdown links, and the
//     frontmatter `relationships[]` is synthesised to match
// Beyond the reference: 0.1 snake_case fields inside
// temporal/provenance/embedding are renamed to their 1.0 camelCase names,
// since mif.schema.json rejects the old names (additionalProperties: false).
// Edits go through the format-preserving writer rather than re-serialising.

import { parseMarkdown, type Frontmatter } from "./convert";
import { titleize, WIKILINK_REL_RE } from "./relationships";
import { updateFrontmatter } from "./writer";

// --- UUIDv5 (RFC 4122 §4.3), synchronous SHA-1 ------------------------------------

function sha1(bytes: Uint8Array): Uint8Array {
  const ml = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, ml >>> 0);
  view.setUint32(padded.length - 8, Math.floor(ml / 2 ** 32));
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = (x << 1) | (x >>> 31);
    }
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) >>> 0;
      [e, d, c, b, a] = [d, c, (b << 30) | (b >>> 2), a, t];
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => ov.setUint32(i * 4, h >>> 0));
  return out;
}

const uuidBytes = (uuid: string) => Uint8Array.from(uuid.replace(/-/g, "").match(/../g)!.map((h) => parseInt(h, 16)));
const formatUuid = (b: Uint8Array) => {
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

export function uuid5(name: string, namespace: string): string {
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + nameBytes.length);
  input.set(uuidBytes(namespace));
  input.set(nameBytes, 16);
  const hash = sha1(input).slice(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  return formatUuid(hash);
}

/** uuid.NAMESPACE_URL */
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
/** migrate_0_1_to_1_0.MIF_NAMESPACE = uuid5(NAMESPACE_URL, "https://mif-spec.dev") */
export const MIF_NAMESPACE = uuid5("https://mif-spec.dev", NAMESPACE_URL);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- 0.1 field names ------------------------------------------------------------------

const RENAMES: Record<string, Record<string, string>> = {
  temporal: {
    valid_from: "validFrom",
    valid_until: "validUntil",
    recorded_at: "recordedAt",
    access_count: "accessCount",
    last_accessed: "lastAccessed",
    half_life: "halfLife",
  },
  provenance: { source_type: "sourceType", source_ref: "sourceRef", trust_level: "trustLevel", agent_version: "agentVersion" },
  embedding: { model_version: "modelVersion", source_text: "sourceText", vector_uri: "vectorUri" },
};
const TOP_LEVEL_RENAMES: Record<string, string> = { compressed_at: "compressedAt" };

function renameKeys(obj: Record<string, unknown>, map: Record<string, string>): { value: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const value: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const nk = map[k] ?? k;
    if (nk !== k) changed = true;
    // decay.half_life lives one level down in temporal
    if (k === "decay" && v && typeof v === "object" && !Array.isArray(v)) {
      const inner = renameKeys(v as Record<string, unknown>, map);
      value[nk] = inner.value;
      changed ||= inner.changed;
    } else value[nk] = v;
  }
  return { value, changed };
}

/** Frontmatter updates that rename 0.1 snake_case fields; empty when none. */
export function fieldRenames(fm: Frontmatter): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const [block, map] of Object.entries(RENAMES)) {
    const v = fm[block];
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const r = renameKeys(v as Record<string, unknown>, map);
    if (r.changed) updates[block] = r.value;
  }
  for (const [from, to] of Object.entries(TOP_LEVEL_RENAMES)) {
    if (from in fm && !(to in fm)) {
      updates[to] = fm[from];
      updates[from] = undefined;
    }
  }
  return updates;
}

// --- detection and migration --------------------------------------------------------

export interface LegacySigns {
  memoryExtension: boolean;
  slugId: boolean;
  wikilinkRelationships: number;
  snakeCaseFields: string[];
}

function wikilinkLines(body: string): number[] {
  const out: number[] = [];
  let inSection = false;
  body.split("\n").forEach((line, i) => {
    const s = line.trim();
    if (s.startsWith("## ")) {
      inSection = s.slice(3).trim().toLowerCase() === "relationships";
      return;
    }
    if (inSection && WIKILINK_REL_RE.test(s)) out.push(i);
  });
  return out;
}

/** What makes a file look like MIF 0.1, or null if nothing does. */
export function legacySigns(path: string, text: string): LegacySigns | null {
  let fm: Frontmatter;
  let body: string;
  try {
    ({ frontmatter: fm, body } = parseMarkdown(text));
  } catch {
    return null;
  }
  const signs: LegacySigns = {
    memoryExtension: path.endsWith(".memory.md"),
    slugId: typeof fm.id === "string" && !UUID_RE.test(fm.id),
    wikilinkRelationships: wikilinkLines(body).length,
    snakeCaseFields: Object.entries(fieldRenames(fm)).filter(([, v]) => v !== undefined).map(([k]) => k),
  };
  // A slug id alone is a 1.0 warning (id-not-uuid), not a sign of 0.1.
  const legacy = signs.memoryExtension || signs.wikilinkRelationships > 0 || signs.snakeCaseFields.length > 0;
  return legacy ? signs : null;
}

/** New path for a migrated file: drop the `.memory` infix. */
export const migratedPath = (path: string) => path.replace(/\.memory\.md$/, ".md");

/** Migrate one concept's text (migrate_0_1_to_1_0.migrate_concept, format-preserving). */
export function migrateConcept(text: string): string {
  const { frontmatter: fm, body } = parseMarkdown(text);
  const updates: Record<string, unknown> = {};

  const rawId = String(fm.id ?? "").trim();
  if (!UUID_RE.test(rawId)) {
    updates.id = uuid5(rawId || text.slice(0, 64), MIF_NAMESPACE);
    if (rawId) {
      const aliases = Array.isArray(fm.aliases) ? fm.aliases : [];
      updates.aliases = aliases.includes(rawId) ? aliases : [...aliases, rawId];
    }
  }

  // Body wiki-link relationships → markdown links, and the frontmatter to match.
  const lines = body.split("\n");
  const rels: Array<{ type: string; target: string }> = [];
  for (const i of wikilinkLines(body)) {
    const m = WIKILINK_REL_RE.exec(lines[i]!.trim())!;
    // str.partition("|"): split at the first bar only.
    const bar = m[2]!.indexOf("|");
    const slug = (bar === -1 ? m[2]! : m[2]!.slice(0, bar)).trim();
    const display = bar === -1 ? "" : m[2]!.slice(bar + 1);
    const label = display.trim() || titleize(slug);
    const target = `/${slug}.md`;
    rels.push({ type: m[1]!, target });
    lines[i] = `- ${m[1]} [${label}](${target})`;
  }
  if (rels.length) updates.relationships = rels;

  Object.assign(updates, fieldRenames({ ...fm }));
  const head = text.slice(0, text.length - body.length);
  return updateFrontmatter(head + lines.join("\n"), updates);
}
