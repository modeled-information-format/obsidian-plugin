// Typed relationships: the authoritative frontmatter `relationships[]` and
// its OKF-legible body mirror (spec §5.3, §8; Invariant 3). Parsing and the
// sync rule are ported from MIF's scripts/okf_validate.py so the plugin
// agrees with the reference validator; tests/golden/*/rels.json pins them.

import { parseMarkdown, scalarText, type Frontmatter } from "./convert";
import { setScalarIn, updateFrontmatter } from "./writer";

/** okf_validate._kebab: PascalCase / snake / spaced → kebab, namespace-aware. */
export function kebab(value: string): string {
  return value
    .replace(/(?<!^)(?<!:)(?=[A-Z])/g, "-")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

export interface RelType {
  /** Token stored in relationships[].type, e.g. "derived-from", "farm:breeds-with". */
  token: string;
  /** PascalCase display name, e.g. "DerivedFrom". */
  name: string;
  namespace?: string;
  /** Inverse token; for symmetric types, the token itself. */
  inverse?: string;
  symmetric: boolean;
  description?: string;
  properties?: PropertyDeclaration[];
  core: boolean;
}

export interface PropertyDeclaration {
  name: string;
  type: "string" | "boolean" | "integer" | "decimal" | "date" | "datetime";
  enum?: unknown[];
  range?: [number, number];
}

const core = (name: string, description: string, inverse?: string): RelType => ({
  token: kebab(name),
  name,
  inverse: inverse ? kebab(inverse) : kebab(name),
  symmetric: !inverse,
  description,
  core: true,
});

/** The nine core types (spec §8.2). Symmetric types are their own inverse. */
export const CORE_TYPES: readonly RelType[] = [
  core("RelatesTo", "General relationship"),
  core("DerivedFrom", "Created based on source", "Derives"),
  core("Supersedes", "Replaces older memory", "SupersededBy"),
  core("ConflictsWith", "Contradicts another memory"),
  core("PartOf", "Component of larger whole", "Contains"),
  core("Implements", "Realizes a concept/pattern", "ImplementedBy"),
  core("Uses", "Utilizes a technology/tool", "UsedBy"),
  core("Created", "Authored by entity", "CreatedBy"),
  core("MentionedIn", "Referenced in memory", "Mentions"),
];

export interface Registry {
  types: Map<string, RelType>;
  /** Inverse token → the forward type it names (for incoming-edge labels). */
  inverses: Map<string, RelType>;
  /** True once the bundle has a .mif/config.yaml (custom types must be declared). */
  configPresent: boolean;
  errors: string[];
}

interface ConfigEntry {
  name: string;
  namespace?: string;
  inverse?: string;
  symmetric?: boolean;
  description?: string;
  properties?: PropertyDeclaration[];
}

/** Core types plus a bundle's declared types (okf_validate registry rules). */
export function buildRegistry(config?: { relationship_types?: ConfigEntry[] } | null): Registry {
  const types = new Map<string, RelType>(CORE_TYPES.map((t) => [t.token, t]));
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of config?.relationship_types ?? []) {
    if (!entry || typeof entry.name !== "string") continue;
    if (!entry.namespace) continue; // core-type documentation entries
    const token = `${entry.namespace}:${kebab(entry.name)}`;
    if (seen.has(token)) {
      errors.push(`config.yaml relationship_types: '${entry.namespace}' + '${entry.name}' is declared more than once (resolves to '${token}')`);
    }
    seen.add(token);
    const symmetric = entry.symmetric === true || !entry.inverse;
    types.set(token, {
      token,
      name: entry.name,
      namespace: entry.namespace,
      inverse: entry.inverse ? `${entry.namespace}:${kebab(entry.inverse)}` : symmetric ? token : undefined,
      symmetric: entry.symmetric === true,
      description: entry.description,
      properties: entry.properties,
      core: false,
    });
  }
  const inverses = new Map<string, RelType>();
  for (const t of types.values()) if (t.inverse && t.inverse !== t.token) inverses.set(t.inverse, t);
  return { types, inverses, configPresent: !!config, errors };
}

/** Label for an edge seen from its target: the inverse name when known. */
export function incomingLabel(token: string, registry: Registry): string {
  const t = registry.types.get(token);
  if (!t) return `${token} (incoming)`;
  return t.symmetric ? token : (t.inverse ?? `${token} (incoming)`);
}

// --- frontmatter and body forms ------------------------------------------------

export interface FrontmatterRelationship {
  /** Position in relationships[]. */
  index: number;
  type: string;
  target: string;
  strength?: number;
  metadata?: Record<string, unknown>;
}

/** okf_validate._frontmatter_relationships, keeping index/strength/metadata. */
export function frontmatterRelationships(fm: Frontmatter): FrontmatterRelationship[] {
  const list = Array.isArray(fm.relationships) ? fm.relationships : [];
  const out: FrontmatterRelationship[] = [];
  list.forEach((rel, index) => {
    if (!rel || typeof rel !== "object" || Array.isArray(rel)) return;
    const r = rel as Record<string, unknown>;
    let target = r.target ?? "";
    if (target && typeof target === "object") {
      const t = target as Record<string, unknown>;
      target = t.path ?? t["@id"] ?? "";
    }
    out.push({
      index,
      type: kebab(scalarText(r.type ?? r.relationshipType ?? "")),
      target: scalarText(target),
      strength: typeof r.strength === "number" ? r.strength : undefined,
      metadata: r.metadata && typeof r.metadata === "object" ? (r.metadata as Record<string, unknown>) : undefined,
    });
  });
  return out;
}

// okf_validate.REL_LINE_RE
const REL_LINE_RE = /^-\s+([a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?)\s+\[([^\]]+)\]\(([^)]+)\)\s*$/;
// MIF 0.1 form, recognised for migration only.
export const WIKILINK_REL_RE = /^-\s+([a-z0-9][a-z0-9-]*)\s+\[\[([^\]]+)\]\]\s*$/;

export interface BodyRelationship {
  type: string;
  target: string;
  text: string;
  /** 0-based line within the body. */
  line: number;
}

interface Section {
  /** Body line index of the "## Relationships" heading. */
  heading: number;
  /** Exclusive end: the next "## " heading or the end of the body. */
  end: number;
}

/** Every "## Relationships" section (okf_validate treats each as live). */
function sections(lines: string[]): Section[] {
  const out: Section[] = [];
  let current: Section | undefined;
  lines.forEach((line, i) => {
    const s = line.trim();
    if (!s.startsWith("## ")) return;
    if (current) {
      current.end = i;
      out.push(current);
      current = undefined;
    }
    if (s.slice(3).trim().toLowerCase() === "relationships") current = { heading: i, end: lines.length };
  });
  if (current) out.push(current);
  return out;
}

/** okf_validate._relationships_section, keeping link text and line numbers. */
export function bodyRelationships(body: string): BodyRelationship[] {
  const lines = body.split("\n");
  const out: BodyRelationship[] = [];
  for (const sec of sections(lines)) {
    for (let i = sec.heading + 1; i < sec.end; i++) {
      const m = REL_LINE_RE.exec(lines[i]!.trim());
      if (m) out.push({ type: kebab(m[1]!), text: m[2]!, target: m[3]!, line: i });
    }
  }
  return out;
}

/**
 * List items in a Relationships section that look like relationship lines
 * but are damaged, e.g. `- part-of [Concep[Concept A](a.md)` (a link spliced
 * into the middle of another, seen when two writers edit one file). Such a
 * line can still match REL_LINE_RE, so the sync check alone misses it.
 */
export function malformedMirrorLines(body: string): number[] {
  const lines = body.split("\n");
  const out: number[] = [];
  for (const sec of sections(lines)) {
    for (let i = sec.heading + 1; i < sec.end; i++) {
      const s = lines[i]!.trim();
      if (!/^-\s+[a-z0-9][a-z0-9:-]*\s+\[/.test(s)) continue;
      const m = REL_LINE_RE.exec(s);
      const opens = (s.match(/\[/g) ?? []).length;
      const links = (s.match(/\]\(/g) ?? []).length;
      if (!m || m[2]!.includes("[") || opens !== 1 || links !== 1) out.push(i);
    }
  }
  return out;
}

export interface MirrorDrift {
  missingInBody: Array<[string, string]>;
  missingInFrontmatter: Array<[string, string]>;
}

const pairKey = ([t, x]: [string, string]) => `${t}\u0000${x}`;
const sortedPairs = (pairs: Array<[string, string]>) => [...pairs].sort((a, b) => pairKey(a).localeCompare(pairKey(b)));

/**
 * okf_validate check (3): the sorted (type, target) lists must be equal.
 * Returns null when in sync; otherwise the same detail lists the reference
 * reports (membership-based, so duplicates are listed once per occurrence).
 */
export function mirrorDrift(fm: Frontmatter, body: string): MirrorDrift | null {
  const f = sortedPairs(frontmatterRelationships(fm).map((r) => [r.type, r.target] as [string, string]));
  const b = sortedPairs(bodyRelationships(body).map((r) => [r.type, r.target] as [string, string]));
  if (f.length === b.length && f.every((p, i) => pairKey(p) === pairKey(b[i]!))) return null;
  const bKeys = new Set(b.map(pairKey));
  const fKeys = new Set(f.map(pairKey));
  return {
    missingInBody: f.filter((p) => !bKeys.has(pairKey(p))),
    missingInFrontmatter: b.filter((p) => !fKeys.has(pairKey(p))),
  };
}

/** okf_validate-style rendering of a drift report. */
export function describeDrift(d: MirrorDrift): string {
  const show = (ps: Array<[string, string]>) => ps.map(([t, x]) => `${t} ${x}`).join(", ");
  const parts: string[] = [];
  if (d.missingInBody.length) parts.push(`no body link for ${show(d.missingInBody)}`);
  if (d.missingInFrontmatter.length) parts.push(`no frontmatter entry for ${show(d.missingInFrontmatter)}`);
  return `Relationships out of sync (${parts.join("; ") || "duplicate counts differ"}).`;
}

/** "prior-sample-decision" → "Prior Sample Decision" (migrate_0_1_to_1_0.titleize). */
export const titleize = (slug: string) =>
  slug.split(/[-_\s]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");

/** Fallback link text for a target with no known title. */
export function defaultLinkText(target: string): string {
  if (target.startsWith("urn:")) return target;
  const file = target.split("#")[0]!.split("/").pop() ?? target;
  return titleize(file.replace(/\.md$/, "")) || target;
}

/**
 * Regenerate the body mirror from the frontmatter (Invariant 3), in place:
 * relationship lines are replaced in frontmatter order, existing link text
 * is kept for unchanged (type, target) pairs, other lines in the section
 * (prose, blank lines) stay where they are, and a section is created at the
 * end of the body when needed. Targets are written exactly as in the
 * frontmatter — the reference sync check compares them as strings.
 */
export function syncMirror(text: string, titleFor: (target: string) => string | undefined = () => undefined): string {
  const close = text.indexOf("\n---", 4);
  if (!text.startsWith("---\n") || close === -1) return text;
  const bodyStart = text.indexOf("\n", close + 1) + 1 || text.length;
  const head = text.slice(0, bodyStart);
  const body = text.slice(bodyStart);

  // Frontmatter via the writer's parser path keeps one source of truth.
  const fm = parseFrontmatterOnly(text);
  const rels = frontmatterRelationships(fm);
  const existing = bodyRelationships(body);
  const textFor = new Map<string, string[]>();
  const textForTarget = new Map<string, string>();
  for (const e of existing) {
    const k = pairKey([e.type, e.target]);
    textFor.set(k, [...(textFor.get(k) ?? []), e.text]);
    if (!textForTarget.has(e.target)) textForTarget.set(e.target, e.text);
  }
  const newLines = rels.map((r) => {
    const k = pairKey([r.type, r.target]);
    // Same (type, target) keeps its text; a retyped edge keeps its target's
    // text. Damaged text (containing a bracket) is never reused.
    const candidate = textFor.get(k)?.shift() ?? textForTarget.get(r.target);
    const reuse = candidate && !candidate.includes("[") ? candidate : undefined;
    const label = (reuse ?? titleFor(r.target) ?? defaultLinkText(r.target)).replace(/[[\]]/g, "");
    return `- ${r.type} [${label}](${r.target})`;
  });

  const lines = body.split("\n");
  const secs = sections(lines);
  if (secs.length === 0) {
    if (newLines.length === 0) return text;
    const trimmed = body.replace(/\s+$/, "");
    return `${head}${trimmed}${trimmed ? "\n\n" : ""}## Relationships\n\n${newLines.join("\n")}\n`;
  }

  // Rewrite the first section; empty the relationship lines of any others.
  const out = [...lines];
  for (let s = secs.length - 1; s >= 0; s--) {
    const sec = secs[s]!;
    const kept: string[] = [];
    let insertAt = -1;
    for (let i = sec.heading + 1; i < sec.end; i++) {
      if (REL_LINE_RE.test(out[i]!.trim())) {
        if (insertAt === -1) insertAt = kept.length;
      } else {
        kept.push(out[i]!);
      }
    }
    let content = kept;
    if (s === 0) {
      if (insertAt === -1) insertAt = kept.length && kept[0]!.trim() === "" ? 1 : 0;
      content = [...kept.slice(0, insertAt), ...newLines, ...kept.slice(insertAt)];
      if (insertAt === 0 && newLines.length) content = ["", ...content];
    }
    const meaningful = content.some((l) => l.trim() !== "");
    if (!meaningful) {
      // Drop an emptied section entirely, with the blank line before it.
      let from = sec.heading;
      if (from > 0 && out[from - 1]!.trim() === "") from--;
      out.splice(from, sec.end - from);
    } else {
      out.splice(sec.heading + 1, sec.end - sec.heading - 1, ...content);
    }
  }
  let newBody = out.join("\n");
  if (body.endsWith("\n") && !newBody.endsWith("\n")) newBody += "\n";
  return head + newBody;
}

const parseFrontmatterOnly = (text: string) => parseMarkdown(text).frontmatter;

// --- editing ---------------------------------------------------------------------

export interface RelationshipInput {
  type: string;
  target: string;
  strength?: number;
}

const toEntry = (r: RelationshipInput) => {
  const e: Record<string, unknown> = { type: r.type, target: r.target };
  if (r.strength !== undefined) e.strength = r.strength;
  return e;
};

const rawList = (fm: Frontmatter) => (Array.isArray(fm.relationships) ? [...(fm.relationships as unknown[])] : []);

/** Add a relationship to frontmatter and the body mirror. */
export function addRelationship(text: string, rel: RelationshipInput, titleFor?: (t: string) => string | undefined): string {
  const list = rawList(parseMarkdown(text).frontmatter);
  list.push(toEntry(rel));
  return syncMirror(updateFrontmatter(text, { relationships: list }), titleFor);
}

/** Replace relationships[index] (keeping its other keys, e.g. metadata). */
export function updateRelationship(text: string, index: number, rel: RelationshipInput, titleFor?: (t: string) => string | undefined): string {
  const list = rawList(parseMarkdown(text).frontmatter);
  const old = (list[index] ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...old, type: rel.type, target: rel.target };
  if (rel.strength === undefined) delete next.strength;
  else next.strength = rel.strength;
  list[index] = next;
  return syncMirror(updateFrontmatter(text, { relationships: list }), titleFor);
}

/** Remove relationships[index]; drops the key when the list becomes empty. */
export function removeRelationship(text: string, index: number, titleFor?: (t: string) => string | undefined): string {
  const list = rawList(parseMarkdown(text).frontmatter);
  list.splice(index, 1);
  return syncMirror(updateFrontmatter(text, { relationships: list.length ? list : undefined }), titleFor);
}

// --- targets ---------------------------------------------------------------------

export type TargetKind = "path" | "concept-urn" | "other-urn" | "external" | "empty";

export interface ResolvedTarget {
  kind: TargetKind;
  /** Bundle-relative path without a leading slash, e.g. "sub/c.md" (kind "path"). */
  bundlePath?: string;
  /** Concept id (kind "concept-urn"). */
  id?: string;
}

const UUID_URN = /^urn:mif:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Normalise "a/./b/../c.md" segments; null if it escapes the bundle root. */
export function normalizeBundlePath(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

/**
 * Resolve a relationship target as okf_validate._resolve does: "/x" is
 * bundle-relative, anything else document-relative; urn and URL targets are
 * not paths. `from` is the source's bundle-relative path ("sub/c.md").
 */
export function resolveTarget(raw: string, from: string): ResolvedTarget {
  const target = raw.split("#")[0]!.trim();
  if (!target) return { kind: "empty" };
  const urn = UUID_URN.exec(target);
  if (urn) return { kind: "concept-urn", id: urn[1]!.toLowerCase() };
  if (target.startsWith("urn:")) return { kind: "other-urn" };
  if (/^(https?|mailto):/i.test(target)) return { kind: "external" };
  let decoded = target;
  try {
    decoded = decodeURI(target.replace(/^<|>$/g, ""));
  } catch {
    // keep as written
  }
  const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
  const joined = decoded.startsWith("/") ? decoded : `${dir}/${decoded}`;
  const bundlePath = normalizeBundlePath(joined);
  return bundlePath === null ? { kind: "external" } : { kind: "path", bundlePath };
}

/** Relative path from one bundle file's folder to another bundle path. */
export function relativeTarget(from: string, to: string): string {
  const fromDir = from.includes("/") ? from.slice(0, from.lastIndexOf("/")).split("/") : [];
  const toParts = to.split("/");
  let i = 0;
  while (i < fromDir.length && i < toParts.length - 1 && fromDir[i] === toParts[i]) i++;
  return [...fromDir.slice(i).map(() => ".."), ...toParts.slice(i)].join("/");
}

/**
 * Rewrite targets after a rename. `moved` maps old → new bundle paths;
 * `self` is the source's old and new bundle path (it may be the moved file).
 * Path targets keep their style (bundle-absolute stays absolute, relative is
 * recomputed from the source's new folder); urn targets never change. Body
 * mirror lines pointing at either the old or the new location are updated
 * to match, which also undoes Obsidian's own link-updater rewrite of them.
 */
export function retarget(text: string, self: { from: string; to: string }, moved: Map<string, string>): string {
  const fm = parseMarkdown(text).frontmatter;
  const rels = frontmatterRelationships(fm);
  const lineTargets = new Map<string, string>(); // resolved new bundle path → raw target
  let out = text;

  for (const r of rels) {
    const res = resolveTarget(r.target, self.from);
    if (res.kind !== "path") continue;
    const dest = moved.get(res.bundlePath!) ?? res.bundlePath!;
    const raw = r.target.startsWith("/") ? `/${dest}` : relativeTarget(self.to, dest);
    lineTargets.set(dest, raw);
    // Splice just the target string, leaving the rest of the block as written.
    if (raw !== r.target) out = setScalarIn(out, ["relationships", r.index, "target"], raw);
  }

  // Fix up mirror lines whose target now resolves (from old or new location) to a moved file.
  const close = out.indexOf("\n---", 4);
  const bodyStart = out.indexOf("\n", close + 1) + 1;
  const lines = out.slice(bodyStart).split("\n");
  let bodyChanged = false;
  for (const b of bodyRelationships(lines.join("\n"))) {
    const candidates = [resolveTarget(b.target, self.from), resolveTarget(b.target, self.to)];
    for (const c of candidates) {
      if (c.kind !== "path") continue;
      const dest = moved.get(c.bundlePath!) ?? c.bundlePath!;
      const raw = lineTargets.get(dest);
      if (raw && raw !== b.target) {
        lines[b.line] = lines[b.line]!.replace(`](${b.target})`, `](${raw})`);
        bodyChanged = true;
        break;
      }
      if (raw) break;
    }
  }
  if (bodyChanged) out = out.slice(0, bodyStart) + lines.join("\n");
  return out;
}

/**
 * Keep relationships that exist only in the body mirror by adding them to
 * the frontmatter (the alternative to regenerating them away). Mirror lines
 * are left as written; afterwards both sides agree.
 */
export function adoptMirror(text: string): string {
  const { frontmatter, body } = parseMarkdown(text);
  const drift = mirrorDrift(frontmatter, body);
  if (!drift || drift.missingInFrontmatter.length === 0) return text;
  const list = rawList(frontmatter);
  for (const [type, target] of drift.missingInFrontmatter) list.push({ type, target });
  return updateFrontmatter(text, { relationships: list });
}
