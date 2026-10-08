// Citations (spec §5.4): validation (§5.4.7) and the optional `## Citations`
// body section (§5.4.5). Frontmatter `citations[]` is authoritative (§15.4);
// the body section carries annotations, and every entry in it must have a
// frontmatter counterpart, matched here by URL.
//
// The schema rejects what §5.4.7 says to accept with a fallback (unknown
// type → "other", unknown role → "background", relevance clamped, odd dates
// as text; F38). The schema decides the level, as everywhere in the plugin,
// so these stay errors, and the spec's fallbacks are offered as fixes.

import type { Diagnostic, Fix } from "./analyze";
import { parseMarkdown, type Frontmatter } from "./convert";
import { applyEdit } from "./form";

export const CITATION_TYPES: Record<string, string> = {
  article: "Journal article, blog post",
  book: "Published book",
  paper: "Conference or research paper",
  website: "General website",
  documentation: "Technical documentation",
  repository: "Code repository",
  video: "Video content",
  podcast: "Podcast episode",
  specification: "Technical specification",
  dataset: "Data source",
  tool: "Software tool or service",
  other: "Miscellaneous source",
};

export const CITATION_ROLES: Record<string, string> = {
  supports: "Provides supporting evidence",
  refutes: "Contradicts or disputes",
  background: "General context or reference",
  methodology: "Method or approach source",
  contradicts: "Conflicts with claims",
  extends: "Builds upon cited work",
  derived: "Direct derivation source",
  source: "Primary source material",
  example: "Illustrative example",
  review: "Critical review or analysis",
};

/** Custom namespaced type or role, e.g. `acme:memo` (schema pattern). */
export const NAMESPACED = /^[a-zA-Z][a-zA-Z0-9]*:[a-zA-Z][a-zA-Z0-9-]*$/;

const TYPE_SYNONYMS: Record<string, string> = {
  blog: "article", "blog-post": "article", blogpost: "article", post: "article", journal: "article", news: "article",
  docs: "documentation", doc: "documentation", manual: "documentation", guide: "documentation", reference: "documentation",
  repo: "repository", github: "repository", gitlab: "repository", code: "repository", "source-code": "repository",
  spec: "specification", rfc: "specification", standard: "specification",
  site: "website", web: "website", webpage: "website", "web-page": "website", homepage: "website", url: "website", link: "website",
  data: "dataset", "data-set": "dataset",
  software: "tool", app: "tool", application: "tool", service: "tool", library: "tool", cli: "tool", saas: "tool",
  talk: "video", youtube: "video", recording: "video", film: "video",
  conference: "paper", "research-paper": "paper", thesis: "paper", preprint: "paper",
  ebook: "book", textbook: "book",
  episode: "podcast",
  misc: "other", unknown: "other",
};

const ROLE_SYNONYMS: Record<string, string> = {
  support: "supports", supporting: "supports", evidence: "supports", confirms: "supports", agrees: "supports",
  refute: "refutes", disputes: "refutes", disproves: "refutes",
  context: "background", reference: "background", related: "background", reading: "background",
  method: "methodology", approach: "methodology", technique: "methodology",
  contradict: "contradicts", conflicts: "contradicts", disagrees: "contradicts",
  extend: "extends", "builds-on": "extends", expands: "extends",
  "derived-from": "derived", "based-on": "derived", adapted: "derived", "adapted-from": "derived", derivation: "derived",
  primary: "source", original: "source", quote: "source",
  "case-study": "example", demo: "example", illustration: "example",
  critique: "review", evaluation: "review", analysis: "review",
};

const norm = (v: string) => v.trim().toLowerCase().replace(/[\s_]+/g, "-");

/** A standard value the input most likely meant, if any. */
export function nearest(value: unknown, standard: Record<string, string>, synonyms: Record<string, string>): string | undefined {
  if (typeof value !== "string") return undefined;
  const n = norm(value);
  if (n in standard) return n;
  if (n in synonyms) return synonyms[n];
  if (n.endsWith("s") && n.slice(0, -1) in standard) return n.slice(0, -1);
  if (`${n}s` in standard) return `${n}s`;
  return undefined;
}

export const nearestType = (v: unknown) => nearest(v, CITATION_TYPES, TYPE_SYNONYMS);
export const nearestRole = (v: unknown) => nearest(v, CITATION_ROLES, ROLE_SYNONYMS);

const ALLOWED_KEYS = new Set(["@type", "citationType", "citationRole", "title", "url", "author", "date", "accessed", "relevance", "note"]);
/** Older or snake_case spellings, and the names §5.4.7's error table uses (F39). */
const RENAMES: Record<string, string> = {
  type: "citationType", role: "citationRole", citation_type: "citationType", citation_role: "citationRole",
  link: "url", href: "url", uri: "url", name: "title", authors: "author", published: "date", accessed_at: "accessed",
  notes: "note", annotation: "note", score: "relevance",
};

const URI_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const isRealDate = (s: string) => {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};

/** Best YYYY-MM-DD reading of a date-ish value, or undefined. */
export function toIsoDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (isRealDate(s)) return s;
  const prefix = /^(\d{4}-\d{2}-\d{2})(?=[T ]|$)/.exec(s);
  if (prefix) return isRealDate(prefix[1]!) ? prefix[1] : undefined; // never roll 02-30 over to March
  // A year or a month is not a date: never invent the day.
  if (!/(^|\D)(0?[1-9]|[12]\d|3[01])(\D|$)/.test(s.replace(/\d{4}/g, " "))) return undefined;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return undefined;
  const d = new Date(t);
  // Date.parse reads "June 15, 2024" in local time; keep that calendar day.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A plausible URL for a scheme-less web address ("www.x.org/a" → "https://www.x.org/a"). */
function urlFix(value: string): string | undefined {
  const s = value.trim();
  if (s !== value && URI_RE.test(s)) return s;
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s)) return `https://${s}`;
  return undefined;
}

const edit = (path: Array<string | number>, value: unknown) => ({ path, value });

/** Display text for a citation author (string, EntityReference, or a list of them). */
export function authorText(author: unknown): string | undefined {
  const one = (a: unknown): string | undefined => {
    if (typeof a === "string") return a.trim() || undefined;
    if (!a || typeof a !== "object") return undefined;
    const r = a as Record<string, unknown>;
    if (typeof r.name === "string" && r.name.trim()) return r.name.trim();
    const id = (r.entity as Record<string, unknown> | undefined)?.["@id"];
    return typeof id === "string" ? id.split(":").pop() : undefined;
  };
  if (Array.isArray(author)) {
    const names = author.map(one).filter((x): x is string => !!x);
    return names.length ? names.join(", ") : undefined;
  }
  return one(author);
}

/** Entity URNs used as citation authors, with their frontmatter paths. */
export function citationAuthors(fm: Frontmatter): Array<{ urn: string; path: Array<string | number>; name?: string; entityType?: string }> {
  const out: Array<{ urn: string; path: Array<string | number>; name?: string; entityType?: string }> = [];
  const list = Array.isArray(fm.citations) ? fm.citations : [];
  list.forEach((c, i) => {
    if (!c || typeof c !== "object") return;
    const author = (c as Record<string, unknown>).author;
    const refs = Array.isArray(author) ? author.map((a, j) => [a, [j]] as const) : [[author, []] as const];
    for (const [a, sub] of refs) {
      if (!a || typeof a !== "object") continue;
      const r = a as Record<string, unknown>;
      const id = (r.entity as Record<string, unknown> | undefined)?.["@id"];
      if (typeof id !== "string") continue;
      out.push({
        urn: id,
        path: ["citations", i, "author", ...sub],
        name: typeof r.name === "string" ? r.name : undefined,
        entityType: typeof r.entityType === "string" ? r.entityType : undefined,
      });
    }
  });
  return out;
}

// --- validation (§5.4.7) ----------------------------------------------------------------

/**
 * Per-citation diagnostics. Their paths name the field, so the schema's own
 * (terser, often triplicated) errors on the same paths can be dropped.
 */
export function citationDiagnostics(fm: Frontmatter): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (fm.citations === undefined || fm.citations === null) return out;
  if (!Array.isArray(fm.citations)) {
    out.push({ severity: "error", code: "citation-invalid", message: "`citations` must be a list of Citation objects (§5.4.1).", path: ["citations"], fixes: [] });
    return out;
  }
  const seen = new Map<string, number>();
  fm.citations.forEach((raw, i) => {
    const at = (...k: Array<string | number>) => ["citations", i, ...k];
    const label = `Citation ${i + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      out.push({ severity: "error", code: "citation-invalid", message: `${label} is not a Citation object.`, path: at(), fixes: [{ label: "Remove it", edits: [edit(at(), undefined)] }] });
      return;
    }
    const c = raw as Record<string, unknown>;
    const name = typeof c.title === "string" && c.title.trim() ? `"${c.title}"` : label;

    // Renamed or unknown keys (the schema allows no others).
    for (const key of Object.keys(c)) {
      if (ALLOWED_KEYS.has(key)) continue;
      const to = RENAMES[key];
      if (to && !(to in c)) {
        // Renaming to a vocabulary field also maps the value onto the vocabulary.
        let value = c[key];
        if (to === "citationType" && !(typeof value === "string" && (value in CITATION_TYPES || NAMESPACED.test(value)))) value = nearestType(value) ?? "other";
        if (to === "citationRole" && !(typeof value === "string" && (value in CITATION_ROLES || NAMESPACED.test(value)))) value = nearestRole(value) ?? "background";
        const label = value === c[key] ? `Rename to ${to}` : `Rename to ${to}: ${String(value)}`;
        out.push({ severity: "error", code: "citation-key", message: `${name}: \`${key}\` should be \`${to}\`.`, path: at(key),
          fixes: [{ label, edits: [edit(at(key), undefined), edit(at(to), value)] }] });
      } else {
        out.push({ severity: "error", code: "citation-key", message: `${name}: \`${key}\` is not a citation field (allowed: ${[...ALLOWED_KEYS].join(", ")}).`, path: at(key),
          fixes: typeof c[key] === "string" && !("note" in c) ? [{ label: `Move it into note`, edits: [edit(at(key), undefined), edit(at("note"), `${key}: ${String(c[key])}`)] }] : [] });
      }
    }

    if (c["@type"] !== "Citation") {
      out.push({ severity: "error", code: "citation-required", message: `${name}: \`@type\` must be Citation.`, path: at("@type"), fixes: [{ label: "Set @type to Citation", edits: [edit(at("@type"), "Citation")] }] });
    }

    const vocab = (key: "citationType" | "citationRole", table: Record<string, string>, guess: (v: unknown) => string | undefined, fallback: string, section: string) => {
      const legacy = Object.entries(RENAMES).find(([from, to]) => to === key && from in c)?.[0];
      const v = c[key];
      if (v === undefined) {
        if (legacy) return; // reported as a rename
        out.push({ severity: "error", code: "citation-required", message: `${name}: missing \`${key}\` (§5.4.7 falls back to "${fallback}").`, path: at(key),
          fixes: [{ label: `Set ${key} to ${fallback}`, edits: [edit(at(key), fallback)] }] });
        return;
      }
      if (typeof v === "string" && (v in table || NAMESPACED.test(v))) return;
      const near = guess(v);
      const fixes: Fix[] = [];
      if (near && near !== fallback) fixes.push({ label: `Use ${near}`, edits: [edit(at(key), near)] });
      fixes.push({ label: `Use ${fallback} (the spec's fallback)`, edits: [edit(at(key), fallback)] });
      out.push({ severity: "error", code: `citation-${key === "citationType" ? "type" : "role"}`,
        message: `${name}: ${JSON.stringify(v)} is not a ${key === "citationType" ? "citation type" : "citation role"} (${section}) or a namespaced custom value like acme:memo.`,
        path: at(key), fixes });
    };
    vocab("citationType", CITATION_TYPES, nearestType, "other", "§5.4.3");
    vocab("citationRole", CITATION_ROLES, nearestRole, "background", "§5.4.4");

    if (!("title" in c) && !("name" in c)) {
      out.push({ severity: "error", code: "citation-required", message: `${name}: missing \`title\`.`, path: at("title"), fixes: [] });
    } else if ("title" in c && (typeof c.title !== "string" || !c.title.trim())) {
      out.push({ severity: "error", code: "citation-title", message: `${label}: \`title\` must be a non-empty string.`, path: at("title"), fixes: [] });
    }

    const urlKey = "url" in c ? "url" : undefined;
    if (!urlKey && !["link", "href", "uri"].some((k) => k in c)) {
      out.push({ severity: "error", code: "citation-required", message: `${name}: missing \`url\`.`, path: at("url"), fixes: [] });
    } else if (urlKey) {
      if (typeof c.url !== "string" || !URI_RE.test(c.url)) {
        const fixed = typeof c.url === "string" ? urlFix(c.url) : undefined;
        out.push({ severity: "error", code: "citation-url", message: `${name}: ${JSON.stringify(c.url)} is not a valid URI.`, path: at("url"),
          fixes: fixed ? [{ label: `Use ${fixed}`, edits: [edit(at("url"), fixed)] }] : [] });
      } else {
        const prior = seen.get(c.url);
        if (prior !== undefined) {
          out.push({ severity: "warning", code: "citation-duplicate", message: `${name} has the same URL as citation ${prior + 1}; the body section cannot tell them apart.`, path: at("url"), fixes: [] });
        } else seen.set(c.url, i);
      }
    }

    if ("relevance" in c) {
      const r = c.relevance;
      const n = typeof r === "number" ? r : typeof r === "string" && r.trim() !== "" && !Number.isNaN(Number(r)) ? Number(r) : undefined;
      if (n === undefined) {
        out.push({ severity: "error", code: "citation-relevance", message: `${name}: relevance must be a number from 0 to 1.`, path: at("relevance"), fixes: [{ label: "Remove relevance", edits: [edit(at("relevance"), undefined)] }] });
      } else if (typeof r !== "number" || n < 0 || n > 1) {
        const clamped = Math.min(1, Math.max(0, n));
        out.push({ severity: "error", code: "citation-relevance", message: `${name}: relevance ${JSON.stringify(r)} must be a number from 0 to 1 (§5.4.7 clamps it).`, path: at("relevance"),
          fixes: [{ label: `Set relevance to ${clamped}`, edits: [edit(at("relevance"), clamped)] }] });
      }
    }

    for (const key of ["date", "accessed"] as const) {
      if (!(key in c)) continue;
      const v = c[key];
      if (typeof v === "string" && isRealDate(v)) continue;
      const fixed = toIsoDate(v);
      out.push({ severity: "error", code: "citation-date", message: `${name}: ${key} ${JSON.stringify(v)} is not a YYYY-MM-DD date.`, path: at(key),
        fixes: fixed ? [{ label: `Use ${fixed}`, edits: [edit(at(key), fixed)] }] : [] });
    }

    if (typeof c.note === "string" && c.note.length > 1000) {
      out.push({ severity: "error", code: "citation-note", message: `${name}: note is ${c.note.length} characters; the limit is 1000, and §5.4.7 says longer notes belong in the body section.`, path: at("note"),
        fixes: [{ label: "Move the note to the ## Citations section", transform: "citation-note-to-body", data: { index: i } }] });
    }

    if (Array.isArray(c.author) && c.author.length === 0) {
      out.push({ severity: "warning", code: "citation-author", message: `${name}: author is an empty list.`, path: at("author"), fixes: [{ label: "Remove author", edits: [edit(at("author"), undefined)] }] });
    } else if ("author" in c && authorText(c.author) === undefined && typeof c.author !== "object") {
      out.push({ severity: "warning", code: "citation-author", message: `${name}: author should be a name or an entity reference.`, path: at("author"), fixes: [] });
    }
  });
  return out;
}

// --- body section (§5.4.5) ----------------------------------------------------------------

export interface BodyCitation {
  title: string;
  url: string;
  author?: string;
  year?: string;
  /** Structured sub-items (**Type**: …), by lower-case label. */
  fields: Map<string, { value: string; line: number }>;
  /** 0-based body line of the entry's link. */
  line: number;
  /** Exclusive end line of the entry (next entry, or end of section). */
  end: number;
}

interface CitationSection {
  heading: number;
  end: number;
  entries: BodyCitation[];
}

const ENTRY_RE = /^-\s+\[([^\]]*)\]\(([^)\s]+)\)(.*)$/;
const FIELD_RE = /^(\s+)-\s+\*\*([A-Za-z]+)\*\*:\s*(.*?)\s*$/;
const SUFFIX_RE = /^\s*(?:by\s+(.+?))?\s*(?:\((\d{4})(?:-\d{2}(?:-\d{2})?)?\))?\s*$/;
const FIELD_LABELS = ["Type", "Role", "Relevance", "Accessed"] as const;

function citationSection(lines: string[]): CitationSection | undefined {
  let heading = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i]!.trim();
    if (!s.startsWith("## ")) continue;
    if (heading !== -1) {
      end = i;
      break;
    }
    if (s.slice(3).trim().toLowerCase() === "citations") heading = i;
  }
  if (heading === -1) return undefined;
  const entries: BodyCitation[] = [];
  for (let i = heading + 1; i < end; i++) {
    const line = lines[i]!;
    const m = ENTRY_RE.exec(line);
    if (!m) {
      const f = FIELD_RE.exec(line);
      const last = entries[entries.length - 1];
      if (f && last) last.fields.set(f[2]!.toLowerCase(), { value: f[3]!, line: i });
      // A non-indented, non-blank line closes the entry (prose between entries).
      if (last && line.trim() !== "" && !/^\s/.test(line)) last.end = Math.min(last.end, i);
      continue;
    }
    const prev = entries[entries.length - 1];
    if (prev && prev.end > i) prev.end = i;
    const suffix = SUFFIX_RE.exec(m[3]!);
    entries.push({ title: m[1]!, url: m[2]!, author: suffix?.[1]?.trim(), year: suffix?.[2], fields: new Map(), line: i, end });
  }
  // Trailing blank lines do not belong to the last entry.
  for (const e of entries) while (e.end - 1 > e.line && lines[e.end - 1]!.trim() === "") e.end--;
  return { heading, end, entries };
}

export function bodyCitations(body: string): BodyCitation[] {
  return citationSection(body.split("\n"))?.entries ?? [];
}

export const hasCitationSection = (body: string) => citationSection(body.split("\n")) !== undefined;

const fmCitations = (fm: Frontmatter) =>
  (Array.isArray(fm.citations) ? fm.citations : [])
    .map((c, index) => ({ c: (c && typeof c === "object" ? c : {}) as Record<string, unknown>, index }))
    .filter(({ c }) => typeof c.url === "string" && c.url);

const fieldValue = (c: Record<string, unknown>, label: (typeof FIELD_LABELS)[number]): string | undefined => {
  const v = { Type: c.citationType, Role: c.citationRole, Relevance: c.relevance, Accessed: c.accessed }[label];
  return v === undefined || v === null || v === "" ? undefined : String(v);
};

/** What differs between a frontmatter citation and its body entry (frontmatter wins). */
function entryDrift(c: Record<string, unknown>, e: BodyCitation): string[] {
  const out: string[] = [];
  if (typeof c.title === "string" && c.title !== e.title) out.push("title");
  const author = authorText(c.author);
  if (author && e.author !== undefined && author !== e.author) out.push("author");
  const year = typeof c.date === "string" ? c.date.slice(0, 4) : undefined;
  if (year && e.year !== undefined && year !== e.year) out.push("date");
  for (const label of FIELD_LABELS) {
    const want = fieldValue(c, label);
    const have = e.fields.get(label.toLowerCase())?.value;
    if (have !== undefined && want !== have) out.push(label.toLowerCase());
  }
  return out;
}

/** Body section checks; `line` is the 0-based body line. */
export function citationMirrorDiagnostics(fm: Frontmatter, body: string): Diagnostic[] {
  const section = citationSection(body.split("\n"));
  if (!section) return [];
  const out: Diagnostic[] = [];
  const byUrl = new Map(fmCitations(fm).map((x) => [x.c.url as string, x]));
  const inBody = new Set<string>();
  const sync: Fix = { label: "Update the ## Citations section from frontmatter", transform: "citations-sync" };
  for (const e of section.entries) {
    inBody.add(e.url);
    const match = byUrl.get(e.url);
    if (!match) {
      out.push({ severity: "warning", code: "citation-body-only",
        message: `## Citations lists "${e.title}" (${e.url}), which has no frontmatter citation; §5.4.5 requires one.`,
        path: [], line: e.line, fixes: [{ label: "Add body-only citations to frontmatter", transform: "citations-adopt" }] });
      continue;
    }
    const drift = entryDrift(match.c, e);
    if (drift.length) {
      out.push({ severity: "warning", code: "citation-mirror-drift",
        message: `## Citations entry for "${e.title}" differs from frontmatter in ${drift.join(", ")}.`,
        path: ["citations", match.index], line: e.line, fixes: [sync] });
    }
  }
  for (const [url, { c, index }] of byUrl) {
    if (inBody.has(url)) continue;
    out.push({ severity: "info", code: "citation-not-in-body",
      message: `"${typeof c.title === "string" ? c.title : url}" is not in the ## Citations section.`,
      path: ["citations", index], line: section.heading, fixes: [sync] });
  }
  return out;
}

// --- transforms -----------------------------------------------------------------------------

const splitDoc = (text: string) => {
  const close = text.indexOf("\n---", 4);
  if (!text.startsWith("---\n") || close === -1) return undefined;
  const bodyStart = text.indexOf("\n", close + 1) + 1 || text.length;
  return { head: text.slice(0, bodyStart), body: text.slice(bodyStart) };
};

function entryLines(c: Record<string, unknown>, keep: { author?: string; year?: string } = {}): string[] {
  // Frontmatter wins; what the body wrote is kept only where frontmatter is silent.
  const author = authorText(c.author) ?? keep.author;
  const year = typeof c.date === "string" ? c.date.slice(0, 4) : keep.year;
  const title = (typeof c.title === "string" && c.title ? c.title : String(c.url)).replace(/[[\]]/g, "");
  const lines = [`- [${title}](${String(c.url)})${author ? ` by ${author}` : ""}${year ? ` (${year})` : ""}`];
  for (const label of FIELD_LABELS) {
    const v = fieldValue(c, label);
    if (v !== undefined) lines.push(`  - **${label}**: ${v}`);
  }
  if (typeof c.note === "string" && c.note.trim()) lines.push(`  - ${c.note.trim().replace(/\n+/g, " ")}`);
  return lines;
}

/**
 * Bring the `## Citations` section in line with frontmatter: each entry's
 * link line and Type / Role / Relevance / Accessed items are rewritten from
 * frontmatter; annotations and body-only entries are kept; frontmatter
 * citations missing from the section are appended. With `create`, a missing
 * section is added (before `## Relationships`, else at the end).
 */
export function syncCitations(text: string, opts: { create?: boolean } = {}): string {
  const doc = splitDoc(text);
  if (!doc) return text;
  const fm = parseMarkdown(text).frontmatter;
  const cites = fmCitations(fm);
  const lines = doc.body.split("\n");
  let section = citationSection(lines);
  if (!section) {
    if (!opts.create || !cites.length) return text;
    const rel = lines.findIndex((l) => l.trim().toLowerCase() === "## relationships");
    const block = ["## Citations", ""];
    if (rel === -1) {
      while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
      lines.push(...(lines.length ? [""] : []), ...block);
    } else {
      lines.splice(rel, 0, ...block);
    }
    section = citationSection(lines)!;
  }

  const byUrl = new Map(cites.map((x) => [x.c.url as string, x.c]));
  // Rewrite matched entries, last first so line numbers stay valid.
  for (const e of [...section.entries].reverse()) {
    const c = byUrl.get(e.url);
    if (!c) continue;
    const [newHead, ...fieldLines] = entryLines({ ...c, note: undefined }, { author: e.author, year: e.year });
    const want = new Map(fieldLines.map((l) => [FIELD_RE.exec(l)![2]!.toLowerCase(), l]));
    const block = lines.slice(e.line + 1, e.end);
    const kept: string[] = [];
    for (const l of block) {
      const f = FIELD_RE.exec(l);
      const label = f?.[2]!.toLowerCase();
      if (f && FIELD_LABELS.some((x) => x.toLowerCase() === label)) {
        const replacement = want.get(label!);
        if (replacement) {
          kept.push(`${f[1]}${replacement.trimStart()}`);
          want.delete(label!);
        }
        continue; // a field frontmatter no longer has is dropped
      }
      kept.push(l);
    }
    // A new field goes after the last existing field that precedes it in
    // Type, Role, Relevance, Accessed order (else first).
    const rank = (l: string) => FIELD_LABELS.findIndex((x) => x.toLowerCase() === FIELD_RE.exec(l)?.[2]!.toLowerCase());
    for (const line of want.values()) {
      const r = rank(line);
      const after = kept.reduce((acc, l, i) => (FIELD_RE.test(l) && rank(l) !== -1 && rank(l) < r ? i : acc), -1);
      kept.splice(after + 1, 0, line);
    }
    lines.splice(e.line, e.end - e.line, newHead!, ...kept);
  }

  // Append frontmatter citations the section lacks.
  const present = new Set(citationSection(lines)!.entries.map((e) => e.url));
  const missing = cites.filter(({ c }) => !present.has(c.url as string));
  if (missing.length) {
    const sec = citationSection(lines)!;
    let at = sec.end;
    while (at - 1 > sec.heading && lines[at - 1]!.trim() === "") at--;
    const add: string[] = [];
    for (const { c } of missing) add.push("", ...entryLines(c));
    const trailing = sec.end < lines.length ? [""] : [];
    lines.splice(at, sec.end - at, ...add, ...trailing);
  }
  let body = lines.join("\n");
  if (!body.endsWith("\n")) body += "\n";
  return doc.head + body;
}

/** Add body-only `## Citations` entries to frontmatter (spec fallbacks for missing type/role). */
export function adoptCitations(text: string): string {
  const { frontmatter: fm, body } = parseMarkdown(text);
  const known = new Set(fmCitations(fm).map(({ c }) => c.url as string));
  let out = text;
  let n = Array.isArray(fm.citations) ? fm.citations.length : 0;
  for (const e of bodyCitations(body)) {
    if (known.has(e.url)) continue;
    known.add(e.url);
    const type = e.fields.get("type")?.value;
    const role = e.fields.get("role")?.value;
    const relevance = Number(e.fields.get("relevance")?.value);
    const accessed = e.fields.get("accessed")?.value;
    const c: Record<string, unknown> = {
      "@type": "Citation",
      citationType: type && (type in CITATION_TYPES || NAMESPACED.test(type)) ? type : nearestType(type) ?? "other",
      citationRole: role && (role in CITATION_ROLES || NAMESPACED.test(role)) ? role : nearestRole(role) ?? "background",
      title: e.title || e.url,
      url: e.url,
    };
    if (e.author) c.author = e.author;
    if (e.fields.has("relevance") && !Number.isNaN(relevance)) c.relevance = Math.min(1, Math.max(0, relevance));
    if (accessed && isRealDate(accessed)) c.accessed = accessed;
    out = applyEdit(out, ["citations", n++], c);
  }
  return out;
}

/** Move citation `index`'s note into its `## Citations` entry as an annotation. */
export function moveNoteToBody(text: string, index: number): string {
  const fm = parseMarkdown(text).frontmatter;
  const c = (Array.isArray(fm.citations) ? fm.citations[index] : undefined) as Record<string, unknown> | undefined;
  if (!c || typeof c.note !== "string" || typeof c.url !== "string") return text;
  const note = c.note.trim();
  let out = syncCitations(applyEdit(text, ["citations", index, "note"], undefined), { create: true });
  const doc = splitDoc(out)!;
  const lines = doc.body.split("\n");
  const entry = citationSection(lines)?.entries.find((e) => e.url === c.url);
  if (!entry) return text;
  const wrapped = note.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " "));
  lines.splice(entry.end, 0, ...wrapped.map((p) => `  - ${p}`));
  out = doc.head + lines.join("\n");
  return out;
}
