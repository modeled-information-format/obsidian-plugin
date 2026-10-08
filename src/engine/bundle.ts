// Bundle-wide relationship index and the checks that need more than one
// file: mirror sync, declared custom types, relationship metadata, broken
// links, and temporal consistency of derivation edges. Each check is ported
// from MIF's scripts/okf_validate.py; tests compare against its goldens.

import type { Diagnostic } from "./analyze";
import { parseMarkdown, type Frontmatter } from "./convert";
import {
  describeDrift,
  malformedMirrorLines,
  frontmatterRelationships,
  mirrorDrift,
  resolveTarget,
  type PropertyDeclaration,
  type Registry,
  type TargetKind,
} from "./relationships";

export interface BundleConcept {
  /** Bundle-relative path without a leading slash, e.g. "sub/c.md". */
  path: string;
  text: string;
  frontmatter: Frontmatter;
  body: string;
  /** 0-based file line where the body starts. */
  bodyLine: number;
}

export interface Edge {
  from: string;
  /** Index in the source's relationships[]. */
  index: number;
  type: string;
  target: string;
  strength?: number;
  kind: TargetKind;
  /** Bundle path of the target concept, when it exists in the bundle. */
  resolved?: string;
}

export interface BundleIndex {
  concepts: Map<string, BundleConcept>;
  byId: Map<string, string>;
  outgoing: Map<string, Edge[]>;
  incoming: Map<string, Edge[]>;
  registry: Registry;
  /** Every file in the bundle (any extension), bundle-relative. */
  files: Set<string>;
}

export const titleOf = (c: BundleConcept | undefined): string | undefined =>
  c && typeof c.frontmatter.title === "string" ? c.frontmatter.title : undefined;

export function buildIndex(concepts: BundleConcept[], registry: Registry, files: Iterable<string>): BundleIndex {
  const index: BundleIndex = {
    concepts: new Map(concepts.map((c) => [c.path, c])),
    byId: new Map(),
    outgoing: new Map(),
    incoming: new Map(),
    registry,
    files: new Set(files),
  };
  for (const c of concepts) {
    if (typeof c.frontmatter.id === "string") index.byId.set(c.frontmatter.id.toLowerCase(), c.path);
  }
  for (const c of concepts) {
    const edges: Edge[] = [];
    for (const r of frontmatterRelationships(c.frontmatter)) {
      const res = resolveTarget(r.target, c.path);
      let resolved: string | undefined;
      if (res.kind === "path" && index.concepts.has(res.bundlePath!)) resolved = res.bundlePath;
      if (res.kind === "concept-urn") resolved = index.byId.get(res.id!);
      const edge: Edge = { from: c.path, index: r.index, type: r.type, target: r.target, strength: r.strength, kind: res.kind, resolved };
      edges.push(edge);
      if (resolved) index.incoming.set(resolved, [...(index.incoming.get(resolved) ?? []), edge]);
    }
    index.outgoing.set(c.path, edges);
  }
  return index;
}

/** Link text for a target from the index: its title, if it resolves. */
export function titleForTarget(index: BundleIndex, from: string): (target: string) => string | undefined {
  return (target) => {
    const res = resolveTarget(target, from);
    const path = res.kind === "path" ? res.bundlePath : res.kind === "concept-urn" ? index.byId.get(res.id!) : undefined;
    return path ? titleOf(index.concepts.get(path)) : undefined;
  };
}

// --- dates (okf_validate._parse_created / _is_date_only) ------------------------

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

export function parseCreated(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const m = ISO.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "0", tz] = m;
  let ms = Date.UTC(+y!, +mo! - 1, +d!, +h, +mi, +s, Math.round(Number(`0.${frac}`) * 1000));
  if (Number.isNaN(ms)) return null;
  if (tz && tz !== "Z") {
    const sign = tz[0] === "-" ? -1 : 1;
    const digits = tz.slice(1).replace(":", "");
    ms -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
  }
  return ms;
}

export const isDateOnly = (value: unknown) => typeof value === "string" && !value.includes("T") && !value.trim().includes(" ");

// --- checks ------------------------------------------------------------------------

const DERIVATION_TYPES = new Set(["derived-from", "supersedes", "cites"]);
const MD_LINK_RE = /\[[^\]]+\]\(([^)]+)\)/g;

function checkProperty(value: unknown, type: PropertyDeclaration["type"]): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "decimal": return typeof value === "number";
    case "date": return typeof value === "string" && isDateOnly(value) && parseCreated(value) !== null;
    case "datetime": return typeof value === "string" && !isDateOnly(value) && parseCreated(value) !== null;
    default: return true;
  }
}

const pyRepr = (v: unknown) =>
  typeof v === "string" ? `'${v}'` : typeof v === "number" && Number.isInteger(v) && !Number.isSafeInteger(v) ? String(v) : JSON.stringify(v);

/** okf_validate._relationship_metadata_errors */
export function metadataErrors(ns: string | undefined, props: PropertyDeclaration[] | undefined, metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const errors: string[] = [];
  for (const prop of props ?? []) {
    const key = `${ns}:${prop.name}`;
    if (!(key in (metadata as Record<string, unknown>))) continue;
    const value = (metadata as Record<string, unknown>)[key];
    if (!checkProperty(value, prop.type)) {
      errors.push(`metadata['${key}']: expected type '${prop.type}', got ${pyRepr(value)}`);
      continue;
    }
    if (prop.type === "string" && prop.enum && !prop.enum.includes(value)) {
      errors.push(`metadata['${key}']: ${pyRepr(value)} is not one of the declared enum values ${JSON.stringify(prop.enum)}`);
    }
    if ((prop.type === "integer" || prop.type === "decimal") && prop.range) {
      const [lo, hi] = prop.range;
      if (!((value as number) >= lo && (value as number) <= hi)) {
        errors.push(`metadata['${key}']: ${pyRepr(value)} is outside the declared range [${lo}, ${hi}]`);
      }
    }
  }
  return errors;
}

/** File line of relationships[index] (or of the relationships key). */
function relationshipLine(c: BundleConcept, index?: number): number | undefined {
  const lines = c.text.split("\n");
  const key = lines.findIndex((l, i) => i < c.bodyLine && /^relationships:/.test(l));
  if (key === -1 || index === undefined) return key === -1 ? undefined : key;
  const indent = lines[key + 1]?.search(/-\s/) ?? -1;
  let seen = -1;
  for (let i = key + 1; i < c.bodyLine; i++) {
    const line = lines[i]!;
    if (/^\S/.test(line)) break;
    if (line.search(/-\s/) === indent && line.slice(0, indent).trim() === "" && ++seen === index) return i;
  }
  return key;
}

/** Index entry for a concept file, or null when it has no parseable frontmatter. */
export function toBundleConcept(path: string, text: string): BundleConcept | null {
  let parsed: { frontmatter: Frontmatter; body: string };
  try {
    parsed = parseMarkdown(text);
  } catch {
    return null;
  }
  const bodyOffset = text.length - parsed.body.length;
  const bodyLine = (text.slice(0, bodyOffset).match(/\n/g) ?? []).length;
  return { path, text, frontmatter: parsed.frontmatter, body: parsed.body, bodyLine };
}

export function bundleDiagnostics(index: BundleIndex): Map<string, Diagnostic[]> {
  const out = new Map<string, Diagnostic[]>();
  const add = (path: string, d: Diagnostic) => out.set(path, [...(out.get(path) ?? []), d]);
  const { registry } = index;

  for (const c of index.concepts.values()) {
    // (3) mirror sync
    const drift = mirrorDrift(c.frontmatter, c.body);
    if (drift) {
      const heading = c.body.split("\n").findIndex((l) => /^##\s+relationships\s*$/i.test(l.trim()));
      add(c.path, {
        severity: "error",
        code: "mirror-drift",
        message: describeDrift(drift),
        path: ["relationships"],
        line: heading !== -1 ? c.bodyLine + heading : relationshipLine(c),
        fixes: [
          ...(drift.missingInFrontmatter.length ? [{ label: "Add body-only relationships to frontmatter", transform: "mirror-adopt" as const }] : []),
          {
            label: drift.missingInFrontmatter.length
              ? `Regenerate the body mirror from frontmatter (drops ${drift.missingInFrontmatter.length} body-only line${drift.missingInFrontmatter.length > 1 ? "s" : ""})`
              : "Regenerate the body mirror from frontmatter",
            transform: "mirror",
          },
        ],
      });
    }

    for (const line of malformedMirrorLines(c.body)) {
      add(c.path, {
        severity: "error",
        code: "mirror-malformed",
        message: `Damaged relationship line: ${c.body.split("\n")[line]!.trim()}`,
        path: ["relationships"],
        line: c.bodyLine + line,
        fixes: [{ label: "Regenerate the body mirror from frontmatter", transform: "mirror" }],
      });
    }

    for (const edge of index.outgoing.get(c.path) ?? []) {
      // (7) custom types must be declared once the bundle has a config
      if (registry.configPresent && edge.type.includes(":")) {
        const declared = registry.types.get(edge.type);
        if (!declared) {
          add(c.path, {
            severity: "error",
            code: "undeclared-type",
            message: `Relationship type '${edge.type}' is not declared in .mif/config.yaml's relationship_types.`,
            path: ["relationships", edge.index, "type"],
            line: relationshipLine(c, edge.index),
            fixes: [],
          });
        } else {
          // (8) metadata values against declared properties
          const rel = (c.frontmatter.relationships as Array<Record<string, unknown>>)[edge.index];
          for (const msg of metadataErrors(declared.namespace, declared.properties, rel?.metadata)) {
            add(c.path, {
              severity: "error",
              code: "relationship-metadata",
              message: `Relationship '${edge.type}' ${msg}`,
              path: ["relationships", edge.index, "metadata"],
              line: relationshipLine(c, edge.index),
              fixes: [],
            });
          }
        }
      }
      // urn:mif:<uuid> targets that match no concept (okf_validate skips urns)
      if (edge.kind === "concept-urn" && !edge.resolved) {
        add(c.path, {
          severity: "warning",
          code: "broken-target",
          message: `No concept in this bundle has id ${edge.target.slice("urn:mif:".length)}.`,
          path: ["relationships", edge.index, "target"],
          line: relationshipLine(c, edge.index),
          fixes: [],
        });
      }
      // (6) a derivation target must not be newer than its source
      if (DERIVATION_TYPES.has(edge.type) && edge.resolved && edge.resolved !== c.path) {
        const target = index.concepts.get(edge.resolved)!;
        const srcRaw = c.frontmatter.created;
        const tgtRaw = target.frontmatter.created;
        const src = parseCreated(srcRaw);
        const tgt = parseCreated(tgtRaw);
        if (src !== null && tgt !== null) {
          const day = (ms: number) => Math.floor(ms / 86_400_000);
          const later = isDateOnly(srcRaw) || isDateOnly(tgtRaw) ? day(tgt) > day(src) : tgt > src;
          if (later) {
            add(c.path, {
              severity: "warning",
              code: "temporal-inconsistency",
              message: `'${edge.type}' target ${edge.target} was created ${String(tgtRaw)}, after this concept (${String(srcRaw)}).`,
              path: ["relationships", edge.index],
              line: relationshipLine(c, edge.index),
              fixes: [],
            });
          }
        }
      }
    }

    // (4) broken body links (any markdown link that resolves to a missing .md).
    // Unlike okf_validate, percent-encoding is decoded first (`%20` → space),
    // matching how Obsidian resolves the same link (Spike C).
    const bodyLines = c.body.split("\n");
    bodyLines.forEach((line, i) => {
      for (const m of line.matchAll(MD_LINK_RE)) {
        const res = resolveTarget(m[1]!, c.path);
        if (res.kind === "path" && res.bundlePath!.endsWith(".md") && !index.files.has(res.bundlePath!)) {
          add(c.path, {
            severity: "warning",
            code: "broken-link",
            message: `Broken link → ${m[1]}`,
            path: [],
            line: c.bodyLine + i,
            fixes: [],
          });
        }
      }
    });
  }
  return out;
}

