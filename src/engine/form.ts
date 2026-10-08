// Schema-driven property forms. The field model is derived from
// the vendored mif.schema.json, so the editor follows the schema rather
// than a hand-written field list. Frontmatter keys are the JSON-LD keys
// except `type` (schema: conceptType) and `id` (schema: @id).

import entityReference from "../../schemas/definitions/entity-reference.schema.json";
import mif from "../../schemas/mif.schema.json";
import { parseMarkdown, type Frontmatter } from "./convert";
import { pythonIsoTimestamp, loadYaml } from "./yaml11";
import { editStructure, setScalarIn, updateFrontmatter } from "./writer";

export type FieldKind =
  | "text" | "textarea" | "enum" | "number" | "integer" | "boolean"
  | "datetime" | "date" | "duration" | "uri" | "strings" | "object" | "array" | "map" | "raw";

export interface FieldModel {
  key: string;
  label: string;
  description?: string;
  kind: FieldKind;
  required?: boolean;
  nullable?: boolean;
  enum?: string[];
  min?: number;
  max?: number;
  pattern?: string;
  maxLength?: number;
  /** object: its properties; extra keys allowed when `open` is true. */
  children?: FieldModel[];
  open?: boolean;
  /** array: the item model. */
  item?: FieldModel;
  /** Default value for a new array item / object. */
  template?: unknown;
  /** text: known values offered as suggestions (the field also accepts others). */
  suggestions?: string[];
}

type Schema = Record<string, unknown>;
const ROOT = mif as Schema;
const DEFS = (ROOT.$defs ?? {}) as Record<string, Schema>;
const EXTERNAL: Record<string, Schema> = { "./definitions/entity-reference.schema.json": entityReference as Schema };

function resolve(s: Schema): Schema {
  const ref = s.$ref;
  if (typeof ref !== "string") return s;
  if (ref.startsWith("#/$defs/")) return resolve(DEFS[ref.slice(8)] ?? {});
  if (ref.includes("#/$defs/")) return resolve(DEFS[ref.split("#/$defs/")[1]!] ?? {});
  return resolve(EXTERNAL[ref] ?? {});
}

const humanize = (k: string) =>
  k.replace(/^@/, "").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

/** Field model for one schema node. */
export function modelFor(key: string, raw: Schema, required = false): FieldModel {
  const s = resolve(raw);
  const base = { key, label: humanize(key), description: typeof s.description === "string" ? s.description : undefined, required };
  const alternatives = (s.oneOf ?? s.anyOf) as Schema[] | undefined;
  if (Array.isArray(alternatives) && !s.properties) {
    // "a known value, or any string matching …" → text with suggestions.
    const branches = alternatives.map(resolve);
    if (branches.every((b) => b.type === "string" || Array.isArray(b.enum))) {
      const suggestions = branches.flatMap((b) => (Array.isArray(b.enum) ? b.enum.map(String) : []));
      return { ...base, kind: "text", suggestions };
    }
    return { ...base, kind: "raw" };
  }
  if (s.allOf && !s.properties) return { ...base, kind: "raw" };
  let type = s.type;
  let nullable = false;
  if (Array.isArray(type)) {
    nullable = type.includes("null");
    type = type.find((t) => t !== "null");
  }
  if (Array.isArray(s.enum)) return { ...base, nullable, kind: "enum", enum: s.enum.map(String) };
  if (s.const !== undefined) return { ...base, kind: "raw" };
  // Objects with properties are forms even when the schema adds anyOf/oneOf
  // constraints on which keys are required; the validator enforces those.
  if (type === undefined && s.properties) type = "object";
  switch (type) {
    case "string": {
      const fmt = s.format;
      const kind: FieldKind = fmt === "date-time" ? "datetime" : fmt === "date" ? "date" : fmt === "uri" ? "uri"
        : s.pattern === "^P" ? "duration" : (typeof s.maxLength === "number" && s.maxLength > 120) ? "textarea" : "text";
      return { ...base, nullable, kind, pattern: typeof s.pattern === "string" ? s.pattern : undefined, maxLength: typeof s.maxLength === "number" ? s.maxLength : undefined };
    }
    case "number":
    case "integer":
      return { ...base, nullable, kind: type, min: s.minimum as number | undefined, max: s.maximum as number | undefined };
    case "boolean":
      return { ...base, nullable, kind: "boolean" };
    case "array": {
      const items = resolve((s.items ?? {}) as Schema);
      if (items.type === "string" && !items.enum && !items.format) return { ...base, kind: "strings" };
      const item = modelFor("item", items);
      return { ...base, kind: "array", item, template: templateFor(items) };
    }
    case "object": {
      const props = (s.properties ?? {}) as Record<string, Schema>;
      const req = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
      const children = Object.entries(props).filter(([k]) => k !== "@type").map(([k, v]) => modelFor(k, v, req.has(k)));
      if (!children.length) return { ...base, kind: s.additionalProperties && typeof s.additionalProperties === "object" ? "map" : "raw" };
      return { ...base, kind: "object", children, open: s.additionalProperties !== false };
    }
    default:
      return { ...base, kind: "raw" };
  }
}

/** A new array item: required keys, and `@type` where the schema fixes it. */
function templateFor(s: Schema): unknown {
  if (s.type !== "object") return "";
  const out: Record<string, unknown> = {};
  const props = (s.properties ?? {}) as Record<string, Schema>;
  const atType = props["@type"];
  if (atType && (atType.const !== undefined || Array.isArray(atType.enum))) out["@type"] = atType.const ?? (atType.enum as unknown[])[0];
  for (const k of Array.isArray(s.required) ? (s.required as string[]) : []) {
    if (k === "@type") continue;
    const p = resolve(props[k] ?? {});
    out[k] = p.type === "object" ? (k === "entity" ? { "@id": "urn:mif:entity:" } : {}) : "";
  }
  return out;
}

/** Sections of the Properties panel, in §5.2 order. Relationships live in the Related panel. */
export const SECTIONS: Array<{ title: string; keys: string[] }> = [
  { title: "Identity", keys: ["type", "created", "modified", "namespace", "title", "summary", "tags", "aliases"] },
  { title: "Ontology", keys: ["ontology", "entity", "properties"] },
  { title: "Temporal", keys: ["temporal"] },
  { title: "Provenance", keys: ["provenance"] },
  { title: "Embedding", keys: ["embedding"] },
  { title: "Entities", keys: ["entities"] },
  { title: "Citations", keys: ["citations"] },
  { title: "Documents", keys: ["documents"] },
  { title: "Compression", keys: ["compressedAt"] },
  { title: "Extensions", keys: ["extensions"] },
];

/** Keys the panel edits; anything else is an "other property". */
export const FORM_KEYS = new Set(["id", ...SECTIONS.flatMap((s) => s.keys), "relationships", "memoryType"]);

/** Field model for a frontmatter key. */
export function topLevelModel(key: string): FieldModel {
  const props = (ROOT.properties ?? {}) as Record<string, Schema>;
  if (key === "type") return { ...modelFor("type", props.conceptType ?? {}, true), label: "Type" };
  if (key === "extensions") return { key, label: "Extensions", kind: "raw", description: "Provider-specific data (YAML)." };
  const m = modelFor(key, props[key] ?? {}, key === "created");
  return key === "summary" ? { ...m, kind: "textarea" } : m;
}

// --- values --------------------------------------------------------------------

export interface Checked {
  value?: unknown;
  /** Set when the input is rejected; nothing is written. */
  error?: string;
  /** Empty input: remove the key (or set null when the field is nullable and required). */
  remove?: boolean;
}

/** Turn an input string into a typed value for a field, or explain why not. */
export function checkInput(model: FieldModel, input: string): Checked {
  const raw = input.trim();
  if (raw === "") return model.nullable && model.required ? { value: null } : { remove: true };
  switch (model.kind) {
    case "number":
    case "integer": {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: "Enter a number." };
      if (model.kind === "integer" && !Number.isInteger(n)) return { error: "Enter a whole number." };
      if (model.min !== undefined && n < model.min) return { error: `Must be at least ${model.min}.` };
      if (model.max !== undefined && n > model.max) return { error: `Must be at most ${model.max}.` };
      return { value: n };
    }
    case "datetime": {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
        return { error: "Use an ISO 8601 date-time with a time zone, e.g. 2026-01-15T10:30:00Z." };
      }
      try {
        pythonIsoTimestamp(raw);
      } catch {
        return { error: "Not a real date-time." };
      }
      return { value: raw };
    }
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) return { error: "Use YYYY-MM-DD." };
      return { value: raw };
    case "duration":
      if (!/^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/.test(raw)) return { error: "Use an ISO 8601 duration, e.g. P90D or PT12H." };
      return { value: raw };
    case "uri":
      try {
        new URL(raw);
        return { value: raw };
      } catch {
        return { error: "Enter an absolute URL or URI." };
      }
    case "enum":
      return model.enum?.includes(raw) ? { value: raw } : { error: `One of: ${model.enum?.join(", ")}.` };
    case "boolean":
      return { value: raw === "true" };
    case "strings":
      return { value: raw.split(/\n|,/).map((x) => x.trim()).filter(Boolean) };
    case "raw":
    case "map":
    case "object":
    case "array":
      try {
        const v = loadYaml(raw);
        if (model.kind === "map" && (v === null || typeof v !== "object" || Array.isArray(v))) return { error: "Enter key: value pairs." };
        return { value: v };
      } catch (err) {
        return { error: `Invalid YAML: ${(err as Error).message.split("\n")[0]}` };
      }
    default:
      if (model.pattern && !new RegExp(model.pattern).test(raw)) return { error: `Must match ${model.pattern}.` };
      if (model.maxLength && raw.length > model.maxLength) return { error: `At most ${model.maxLength} characters (now ${raw.length}).` };
      return { value: raw };
  }
}

// --- edits -------------------------------------------------------------------------

const getIn = (obj: unknown, path: Array<string | number>) =>
  path.reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string | number, unknown>)[k] : undefined), obj);

function setIn(root: unknown, path: Array<string | number>, value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const base = root && typeof root === "object" ? root : typeof head === "number" ? [] : {};
  const copy = Array.isArray(base) ? [...base] : { ...(base as Record<string, unknown>) };
  const next = setIn((base as Record<string | number, unknown>)[head!], rest, value);
  if (next === undefined) {
    if (Array.isArray(copy)) copy.splice(head as number, 1);
    else delete (copy as Record<string, unknown>)[head as string];
  } else (copy as Record<string | number, unknown>)[head!] = next;
  return copy;
}

const isEmpty = (v: unknown) =>
  v === undefined || (Array.isArray(v) ? v.length === 0 : v !== null && typeof v === "object" && Object.keys(v).length === 0);

/**
 * Set (or with `undefined`, remove) the value at a frontmatter path. A
 * scalar replacing a scalar is spliced in place; anything else rewrites
 * only the top-level key, keeping the file's list style. A top-level
 * object or list left empty by a removal is removed too.
 */
export function applyEdit(text: string, path: Array<string | number>, value: unknown): string {
  const fm: Frontmatter = parseMarkdown(text).frontmatter;
  const scalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
  if (path.length > 1 && value !== undefined && scalar(value) && scalar(getIn(fm, path)) && getIn(fm, path) !== undefined) {
    return setScalarIn(text, path, value as string | number | boolean | null);
  }
  const top = String(path[0]);
  // Line-level insert/delete when the result does not empty the top-level key.
  if (path.length > 1) {
    const whole = (setIn(fm, path, value) as Frontmatter)[top];
    if (!isEmpty(whole)) {
      const spliced = editStructure(text, path, value);
      if (spliced !== null) return spliced;
    }
  }
  let next = path.length === 1 ? value : (setIn(fm, path, value) as Frontmatter)[top];
  if (path.length > 1 && isEmpty(next)) next = undefined;
  return updateFrontmatter(text, { [top]: next });
}
