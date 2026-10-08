// Concept analysis: conformance level and diagnostics with quick fixes.
//
// Level floors follow the MIF conformance tooling (mif-rs `validate_level`,
// mif-docs `schema/profiles/level-*.json`), since the spec's §13 prose does
// not define them field by field:
//   L1  the JSON-LD projection passes mif.schema.json
//   L2  + non-null namespace, modified, temporal
//   L3  + non-null provenance and temporal.validFrom

import { isMap, isSeq, parse as parseYaml12, parseDocument, type Document } from "yaml";

import { citationDiagnostics, citationMirrorDiagnostics } from "./citations";
import { compressionDiagnostics } from "./compression";
import { FrontmatterError, mdToJsonLd, parseMarkdown, projectionConflicts, type Frontmatter, type JsonLd, type Namespaces } from "./convert";
import { provenanceDiagnostics } from "./provenance";
import { freshness } from "./temporal";
import { validateJsonLd } from "./validate";
import { LOAD_OPTIONS } from "./yaml11";

export type Severity = "error" | "warning" | "info";
export type Level = 0 | 1 | 2 | 3;

/** A quick fix: top-level frontmatter updates (undefined deletes) or a whole-file transform. */
export interface Fix {
  label: string;
  updates?: Record<string, unknown>;
  /**
   * lf: CRLF → LF; mirror: regenerate the body mirror; mirror-adopt: add
   * body-only relationships to frontmatter; migrate: MIF 0.1 → 1.0;
   * download-ontology: fetch the referenced ontology; create-entity: write the
   * missing .mif/entities file for the diagnostic's entities[] entry;
   * citations-sync / citations-adopt: update the ## Citations section from
   * frontmatter, or the reverse for body-only entries; citation-note-to-body:
   * move a long note into the body; compress / decompress (spec §5.6.3).
   */
  transform?:
    | "lf" | "mirror" | "mirror-adopt" | "migrate" | "download-ontology" | "create-entity"
    | "citations-sync" | "citations-adopt" | "citation-note-to-body" | "compress" | "decompress";
  /** Path-level edits, applied in order with minimal line changes (form.applyEdit). */
  edits?: Array<{ path: Array<string | number>; value: unknown }>;
  /** Parameters for a transform (e.g. the ontology id, or the entity to create). */
  data?: Record<string, unknown>;
}

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  /** Frontmatter path such as ["temporal", "validFrom"]; empty for file-level. */
  path: Array<string | number>;
  /** 0-based line in the file, when known. */
  line?: number;
  fixes: Fix[];
}

export interface Analysis {
  /** False when the file has no frontmatter at all (an ordinary note). */
  isConcept: boolean;
  level: Level;
  diagnostics: Diagnostic[];
  frontmatter?: Frontmatter;
  jsonld?: JsonLd;
}

export interface AnalyzeOptions {
  namespaces?: Namespaces;
  /** Clock for fixes that stamp times; injectable for tests. */
  now?: () => Date;
  /** UUID source for fixes; injectable for tests. */
  uuid?: () => string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const L2_FIELDS = ["namespace", "modified", "temporal"] as const;
export const BASE_TYPES = ["semantic", "episodic", "procedural"] as const;

/** UTC time in the form MIF examples use: 2026-01-15T10:30:00Z. */
export const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

const present = (v: unknown) => v !== undefined && v !== null;

/** Highest level whose floor the JSON-LD meets; 0 when it fails the schema. */
export function levelOf(jsonld: JsonLd, schemaValid: boolean): { level: Level; missing: Record<2 | 3, string[]> } {
  const temporal = jsonld.temporal as Record<string, unknown> | null | undefined;
  const missing2 = L2_FIELDS.filter((f) => !present(jsonld[f]));
  const missing3 = [
    ...missing2,
    ...(present(jsonld.provenance) ? [] : ["provenance"]),
    ...(temporal && present(temporal.validFrom) ? [] : ["temporal.validFrom"]),
  ];
  const level: Level = !schemaValid ? 0 : missing2.length ? 1 : missing3.length ? 2 : 3;
  return { level, missing: { 2: missing2, 3: missing3 } };
}

// --- locating paths ---------------------------------------------------------

class Locator {
  private doc?: Document;
  constructor(private readonly text: string) {
    if (text.startsWith("---\n")) {
      const close = text.indexOf("\n---", 4);
      if (close !== -1) this.doc = parseDocument(text.slice(4, close), LOAD_OPTIONS);
    }
  }

  /** 0-based file line of a frontmatter path (or its nearest existing parent). */
  line(path: Array<string | number>): number | undefined {
    if (!this.doc) return undefined;
    for (let n = path.length; n > 0; n--) {
      const node = this.doc.getIn(path.slice(0, n), true) as { range?: [number, number, number] } | undefined;
      const parentPair = n === path.length ? this.keyOffset(path.slice(0, n)) : undefined;
      const offset = parentPair ?? node?.range?.[0];
      if (offset !== undefined) return 1 + countNewlines(this.text.slice(4, 4 + offset));
    }
    return 1;
  }

  private keyOffset(path: Array<string | number>): number | undefined {
    const parent = path.length > 1 ? this.doc!.getIn(path.slice(0, -1), true) : this.doc!.contents;
    const last = path[path.length - 1];
    if (isMap(parent)) {
      const pair = parent.items.find((p) => (p.key as { value?: unknown })?.value === last);
      return (pair?.key as { range?: [number, number, number] } | undefined)?.range?.[0];
    }
    if (isSeq(parent) && typeof last === "number") {
      return (parent.items[last] as { range?: [number, number, number] } | undefined)?.range?.[0];
    }
    return undefined;
  }

  bodyLine(): number | undefined {
    const close = this.text.indexOf("\n---", 4);
    return close === -1 ? undefined : countNewlines(this.text.slice(0, close)) + 2;
  }
}

const countNewlines = (s: string) => (s.match(/\n/g) ?? []).length;

/** JSON-LD pointer → frontmatter path (identity keys map back to their source). */
function frontmatterPath(pointer: string): Array<string | number> | "body" {
  const parts = pointer.split("/").slice(1).filter((p) => p !== "").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  const head = parts[0];
  if (head === "content") return "body";
  if (head === "@id") parts[0] = "id";
  else if (head === "conceptType") parts[0] = "type";
  return parts.map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}

// --- YAML 1.1 vs 1.2 ambiguity ----------------------------------------------

interface Ambiguity {
  path: Array<string | number>;
  mif: unknown;
  obsidian: unknown;
}

/**
 * Scalars that MIF's reference reading (PyYAML, YAML 1.1) and Obsidian /
 * mif-rs (YAML 1.2) resolve differently — e.g. `yes`, `010`, `1e3`,
 * `2026-01-15 10:30:00`. Obsidian's Properties panel
 * rewrites these on any edit (Spike B), so they are flagged up front.
 */
export function ambiguities(frontmatter: Frontmatter, yamlText: string): Ambiguity[] {
  let y12: unknown;
  try {
    y12 = parseYaml12(yamlText, { uniqueKeys: true });
  } catch {
    return [];
  }
  const out: Ambiguity[] = [];
  const walk = (a: unknown, b: unknown, path: Array<string | number>) => {
    if (Array.isArray(a) && Array.isArray(b)) {
      a.forEach((v, i) => walk(v, b[i], [...path, i]));
      return;
    }
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      for (const k of Object.keys(a)) walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], [...path, k]);
      return;
    }
    if (Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)) return;
    // A block scalar that ends the YAML text gains a final newline under the
    // `yaml` package's 1.2 reading only; that is not an Obsidian rewrite risk.
    if (typeof a === "string" && typeof b === "string" && b === `${a}\n`) return;
    out.push({ path, mif: a, obsidian: b });
  };
  // An empty block is {} to MIF and null to YAML 1.2; only compare entries.
  walk(frontmatter, y12 ?? {}, []);
  return out.filter((a) => a.path.length > 0);
}

function setIn(root: unknown, path: Array<string | number>, value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const copy = Array.isArray(root) ? [...root] : { ...(root as Record<string, unknown>) };
  (copy as Record<string | number, unknown>)[head!] = setIn((root as Record<string | number, unknown>)?.[head!], rest, value);
  return copy;
}

const show = (v: unknown) => (typeof v === "string" ? `"${v}"` : JSON.stringify(v));

const getIn = (obj: unknown, path: Array<string | number>) =>
  path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string | number, unknown>)[k] : undefined), obj);

/**
 * Spike B guard. A value flagged `yaml-ambiguous` in the previous analysis
 * that now reads differently under MIF's rules was most likely rewritten by
 * Obsidian's Properties panel (e.g. `010` → `10`, `1e3` → `1000`). Returns a
 * warning per changed value, with a fix that restores the MIF reading.
 */
export function detectRewrites(previous: Analysis, now: Frontmatter): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const d of previous.diagnostics) {
    if (d.code !== "yaml-ambiguous") continue;
    const before = getIn(previous.frontmatter, d.path);
    const after = getIn(now, d.path);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (after === undefined) continue; // removed outright, not rewritten
    const top = String(d.path[0]);
    found.push({
      severity: "warning",
      code: "rewritten",
      message: `${d.path.join(".")} changed from ${show(before)} to ${show(after)} under MIF's reading. Obsidian's Properties panel rewrites this kind of value; restore it if the change was not intended.`,
      path: d.path,
      line: d.line,
      fixes: [{ label: `Restore ${show(before)}`, updates: { [top]: (setIn(now, d.path, before) as Frontmatter)[top] } }],
    });
  }
  return found;
}

// --- analysis ----------------------------------------------------------------

export function analyze(text: string, options: AnalyzeOptions = {}): Analysis {
  const now = options.now ?? (() => new Date());
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const diagnostics: Diagnostic[] = [];

  if (text.includes("\r\n")) {
    diagnostics.push({
      severity: "error",
      code: "crlf",
      message: "Windows (CRLF) line endings: MIF tools cannot read this file's frontmatter.",
      path: [],
      line: 0,
      fixes: [{ label: "Convert line endings to LF", transform: "lf" }],
    });
    return { isConcept: text.startsWith("---\r\n"), level: 0, diagnostics };
  }

  let frontmatter: Frontmatter;
  let body: string;
  try {
    ({ frontmatter, body } = parseMarkdown(text));
  } catch (err) {
    if (/No YAML frontmatter found/.test((err as Error).message)) {
      return { isConcept: false, level: 0, diagnostics: [] };
    }
    const linePos = (err as { cause?: { linePos?: Array<{ line: number }> } }).cause?.linePos;
    diagnostics.push({
      severity: "error",
      code: "yaml-invalid",
      message: (err as Error).message,
      path: [],
      line: linePos?.[0] ? linePos[0].line : 0,
      fixes: [],
    });
    return { isConcept: true, level: 0, diagnostics };
  }

  const locator = new Locator(text);
  const created = typeof frontmatter.created === "string" ? frontmatter.created : undefined;

  // L1 identity fields, reported with fixes before the schema's terser messages.
  if (!present(frontmatter.id)) {
    diagnostics.push({ severity: "error", code: "missing-id", message: "Missing `id` (a UUID).", path: ["id"], line: 1,
      fixes: [{ label: "Add a new UUID", updates: { id: uuid() } }] });
  } else if (typeof frontmatter.id === "string" && !UUID_RE.test(frontmatter.id)) {
    const aliases = Array.isArray(frontmatter.aliases) ? frontmatter.aliases : [];
    diagnostics.push({ severity: "warning", code: "id-not-uuid",
      message: `\`id\` must be a UUID (spec §4.1, §13.1); "${frontmatter.id}" is not.`,
      path: ["id"], line: locator.line(["id"]),
      fixes: [{ label: "Replace with a new UUID, keeping the old id as an alias",
        updates: { id: uuid(), aliases: [...aliases, frontmatter.id] } }] });
  }
  if (!present(frontmatter.type)) {
    diagnostics.push({ severity: "error", code: "missing-type", message: "Missing `type` (semantic, episodic, or procedural).", path: ["type"], line: 1,
      fixes: BASE_TYPES.map((t) => ({ label: `Set type to ${t}`, updates: { type: t } })) });
  }
  if (!present(frontmatter.created)) {
    diagnostics.push({ severity: "error", code: "missing-created", message: "Missing `created` timestamp.", path: ["created"], line: 1,
      fixes: [{ label: "Set created to now", updates: { created: isoSeconds(now()) } }] });
  }

  let jsonld: JsonLd | undefined;
  try {
    jsonld = mdToJsonLd(frontmatter, body, options.namespaces);
  } catch (err) {
    if (!(err instanceof FrontmatterError)) throw err;
    diagnostics.push({ severity: "error", code: "projection", message: err.message, path: [], line: 1, fixes: [] });
  }

  // Field-level checks with fixes. They cover the schema's errors
  // on the same paths, which are dropped below.
  // Body-section lines are counted in the raw body (parseMarkdown drops its leading blank line).
  const closeAt = text.indexOf("\n---", 4);
  const rawBodyStart = text.indexOf("\n", closeAt + 1) + 1;
  const bodyOffset = countNewlines(text.slice(0, rawBodyStart));
  const fieldDiagnostics = [
    ...citationDiagnostics(frontmatter).map((d) => ({ ...d, line: locator.line(d.path) })),
    ...citationMirrorDiagnostics(frontmatter, rawBodyStart > 0 ? text.slice(rawBodyStart) : body).map((d) => ({ ...d, line: d.line === undefined ? undefined : bodyOffset + d.line })),
    ...provenanceDiagnostics(frontmatter).map((d) => ({ ...d, line: locator.line(d.path) })),
    ...compressionDiagnostics(frontmatter, body, { now: now(), strength: freshness(frontmatter, now()).strength }).map((d) => ({ ...d, line: d.path.length ? locator.line(d.path) : 1 })),
  ];
  // A path is covered when a field diagnostic reports it or one of its fixes writes it (a rename).
  const covered = new Set(
    fieldDiagnostics
      .filter((d) => d.path[0] === "citations" || d.path[0] === "compressed_at")
      .flatMap((d) => [d.path, ...d.fixes.flatMap((f) => (f.edits ?? []).map((e) => e.path))])
      .map((p) => p.join(".")),
  );

  let schemaValid = false;
  if (jsonld) {
    const identityCodes = new Set(diagnostics.map((d) => d.path[0]));
    const issues = validateJsonLd(jsonld);
    schemaValid = issues.length === 0;
    for (const issue of issues) {
      const mapped = frontmatterPath(issue.path);
      const path = mapped === "body" ? [] : mapped;
      // The 1.4 schema requires @id = urn:mif:<uuid>: its pattern error is
      // reported as the id-not-uuid diagnostic (with the fix), not twice.
      const idDiag = diagnostics.find((d) => d.code === "id-not-uuid");
      if (idDiag && issue.keyword === "pattern" && path.length === 1 && path[0] === "id") {
        idDiag.severity = "error";
        idDiag.message = `\`id\` must be a UUID: the schema requires \`@id\` to be urn:mif:<uuid>, and "${String(frontmatter.id)}" is not a UUID.`;
        continue;
      }
      const effective = issue.property ? [...path, issue.property] : path;
      if (covered.has(effective.join(".")) || (path[0] === "citations" && covered.has(path.join(".")))) continue;
      // `required` errors for id/type/created are already reported above.
      if (issue.keyword === "required" && path.length === 0 && /'(@id|conceptType|memoryType|created)'/.test(issue.message)) continue;
      if (issue.keyword === "anyOf" && path.length === 0 && !present(frontmatter.type)) continue;
      // `timestamp` is derived from modified/created; its errors surface there.
      if (path[0] === "timestamp") continue;
      if (path.length === 1 && identityCodes.has(String(path[0])) && issue.keyword === "required") continue;
      diagnostics.push({
        severity: "error",
        code: `schema-${issue.keyword}`,
        message: `${path.length ? path.join(".") : "document"}: ${issue.message}`,
        path,
        line: mapped === "body" ? locator.bodyLine() : locator.line(path),
        fixes: [],
      });
    }
  }

  diagnostics.push(...fieldDiagnostics);

  for (const message of projectionConflicts(frontmatter)) {
    const key = /`([^`]+)`/.exec(message)?.[1] ?? "";
    diagnostics.push({ severity: "warning", code: "projection-conflict", message, path: [key], line: locator.line([key]), fixes: [] });
  }

  const yamlText = text.slice(4, text.indexOf("\n---", 4));
  for (const a of ambiguities(frontmatter, yamlText)) {
    const top = String(a.path[0]);
    const withValue = (v: unknown) => ({ [top]: (setIn(frontmatter, a.path, v) as Frontmatter)[top] });
    diagnostics.push({
      severity: "warning",
      code: "yaml-ambiguous",
      message: `${a.path.join(".")} reads as ${show(a.mif)} in MIF but ${show(a.obsidian)} in Obsidian, which rewrites it on the next Properties edit.`,
      path: a.path,
      line: locator.line(a.path),
      fixes: [
        { label: `Keep what Obsidian shows (${show(a.obsidian)})`, updates: withValue(a.obsidian) },
        { label: `Keep the MIF reading (${show(a.mif)})`, updates: withValue(a.mif) },
      ],
    });
  }

  const { level, missing } = jsonld ? levelOf(jsonld, schemaValid) : { level: 0 as Level, missing: { 2: [], 3: [] } };
  if (level >= 1 && level < 3) {
    const next = (level + 1) as 2 | 3;
    const fixes: Fix[] = [];
    const want = missing[next];
    if (want.includes("modified")) fixes.push({ label: "Set modified to now", updates: { modified: isoSeconds(now()) } });
    if (want.includes("namespace") && typeof frontmatter.type === "string") {
      fixes.push({ label: `Set namespace to _${frontmatter.type}`, updates: { namespace: `_${frontmatter.type}` } });
    }
    const temporal = (frontmatter.temporal ?? {}) as Record<string, unknown>;
    if (want.includes("temporal") && created) {
      fixes.push({ label: "Add temporal.recordedAt from created", updates: { temporal: { ...temporal, recordedAt: created } } });
    }
    if (want.includes("temporal.validFrom") && created) {
      fixes.push({ label: "Set temporal.validFrom to created", updates: { temporal: { ...temporal, validFrom: created } } });
    }
    diagnostics.push({
      severity: "info",
      code: "level-gap",
      message: `Level ${next} needs: ${want.join(", ")}.`,
      path: [],
      line: 1,
      fixes,
    });
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  diagnostics.sort((a, b) => order[a.severity] - order[b.severity] || (a.line ?? 0) - (b.line ?? 0));
  return { isConcept: true, level, diagnostics, frontmatter, jsonld };
}
