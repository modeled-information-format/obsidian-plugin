// Ontologies (spec §4.3, §10.8): parsing, `extends` resolution, namespace
// trees, entity types, traits, and discovery patterns.
//
// Ported behaviour and its references (pinned by goldens in tests/golden):
//   resolveChain        mif-rs mif_ontology::resolve_chain (ontology-chains.json)
//   flattenNamespaces,  ontologies repo scripts/validate-namespaces.py
//   checkNamespaces     (_flatten_namespaces, ancestor_namespaces, check_corpus)
//   visibleTypes,       MIF scripts/validate-ontologies.py
//   checkSubtypeOf      (visible_types, check_subtype_of)
// composeTraits implements §10.8.6, which no reference tool implements yet
//.

import { loadYaml } from "./yaml11";
import { ONTOLOGY_SCHEMA_ID, validateAgainst } from "./validate";

export interface NamespaceInfo {
  type_hint?: string | null;
  description?: string | null;
  replaces?: string | null;
}

export interface PropertySchema {
  type?: string;
  [k: string]: unknown;
}

export interface TraitDef {
  description?: string;
  extends?: string[];
  fields?: Record<string, PropertySchema>;
  requires?: string[];
}

export interface EntityTypeDef {
  name: string;
  base: "semantic" | "episodic" | "procedural";
  description?: string;
  traits?: string[];
  subtype_of?: string[];
  schema?: { required?: string[]; properties?: Record<string, PropertySchema> };
  [k: string]: unknown;
}

export interface DiscoveryPattern {
  /** Regex over note text (unified content_pattern or legacy content_patterns[].pattern). */
  content?: string;
  /** Unified file_pattern (a glob) or legacy file_patterns[].pattern (a regex). */
  file?: { pattern: string; kind: "glob" | "regex" };
  namespaces: string[];
  entity?: string;
  context?: string;
}

export interface OntologyDef {
  id: string;
  version: string;
  description?: string;
  extends: string[];
  namespaceTree: Record<string, unknown>;
  entityTypes: EntityTypeDef[];
  traits: Record<string, TraitDef>;
  discovery: { enabled: boolean; threshold: number; patterns: DiscoveryPattern[] };
  /** Where it was loaded from, for messages. */
  source: string;
}

export type Corpus = Map<string, OntologyDef>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).filter((x): x is string => typeof x === "string");

/** validate-ontologies._entity_types: list, or a name-keyed map. */
function entityTypes(raw: unknown): EntityTypeDef[] {
  if (isObj(raw)) return Object.entries(raw).map(([name, v]) => ({ ...(isObj(v) ? v : {}), name }) as EntityTypeDef);
  if (Array.isArray(raw)) return raw.filter(isObj) as EntityTypeDef[];
  return [];
}

function discovery(raw: unknown): OntologyDef["discovery"] {
  const d = isObj(raw) ? raw : {};
  const patterns: DiscoveryPattern[] = [];
  for (const p of Array.isArray(d.patterns) ? d.patterns.filter(isObj) : []) {
    patterns.push({
      content: typeof p.content_pattern === "string" ? p.content_pattern : undefined,
      file: typeof p.file_pattern === "string" ? { pattern: p.file_pattern, kind: "glob" } : undefined,
      namespaces: strings(p.suggest_namespace),
      entity: typeof p.suggest_entity === "string" ? p.suggest_entity : undefined,
    });
  }
  for (const p of Array.isArray(d.content_patterns) ? d.content_patterns.filter(isObj) : []) {
    if (typeof p.pattern !== "string") continue;
    patterns.push({
      content: p.pattern,
      namespaces: [...strings(p.namespace), ...strings(p.namespaces)],
      entity: typeof p.suggest_entity === "string" ? p.suggest_entity : undefined,
      context: typeof p.context === "string" ? p.context : undefined,
    });
  }
  for (const p of Array.isArray(d.file_patterns) ? d.file_patterns.filter(isObj) : []) {
    if (typeof p.pattern !== "string") continue;
    patterns.push({
      file: { pattern: p.pattern, kind: "regex" },
      namespaces: strings(p.namespaces),
      entity: typeof p.suggest_entity === "string" ? p.suggest_entity : undefined,
      context: typeof p.context === "string" ? p.context : undefined,
    });
  }
  return {
    enabled: d.enabled === true,
    threshold: typeof d.confidence_threshold === "number" ? d.confidence_threshold : 0.8,
    patterns,
  };
}

/** Parse and schema-check an ontology definition (YAML). */
export function parseOntology(text: string, source: string): { def?: OntologyDef; errors: string[] } {
  let data: unknown;
  try {
    data = loadYaml(text);
  } catch (err) {
    return { errors: [`${source}: invalid YAML: ${(err as Error).message}`] };
  }
  const errors = validateAgainst(ONTOLOGY_SCHEMA_ID, data).map((i) => `${source}${i.path === "/" ? "" : i.path}: ${i.message}`);
  if (!isObj(data) || !isObj(data.ontology) || typeof data.ontology.id !== "string") {
    return { errors: errors.length ? errors : [`${source}: missing ontology.id`] };
  }
  const o = data.ontology;
  return {
    errors,
    def: {
      id: o.id as string,
      version: String(o.version ?? ""),
      description: typeof o.description === "string" ? o.description : undefined,
      extends: strings(o.extends),
      namespaceTree: isObj(data.namespaces) ? data.namespaces : {},
      entityTypes: entityTypes(data.entity_types),
      traits: isObj(data.traits) ? (data.traits as Record<string, TraitDef>) : {},
      discovery: discovery(data.discovery),
      source,
    },
  };
}

// --- extends ---------------------------------------------------------------------

export class OntologyError extends Error {
  override name = "OntologyError";
}

/**
 * mif_ontology::resolve_chain: depth-first over parents in declared order,
 * de-duplicated, base first and `id` last. Throws on a missing id or cycle
 * with the same messages as mif-rs.
 */
export function resolveChain(id: string, corpus: Corpus): OntologyDef[] {
  const chain: OntologyDef[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (oid: string) => {
    if (done.has(oid)) return;
    if (visiting.has(oid)) throw new OntologyError(`ontology '${oid}' is part of an extends cycle`);
    const def = corpus.get(oid);
    if (!def) throw new OntologyError(`ontology '${oid}' not found in the supplied corpus`);
    visiting.add(oid);
    for (const parent of def.extends) visit(parent);
    visiting.delete(oid);
    done.add(oid);
    chain.push(def);
  };
  visit(id);
  return chain;
}

// --- namespaces ---------------------------------------------------------------------

/** validate-namespaces._flatten_namespaces */
export function flattenNamespaces(tree: unknown, prefix = ""): Map<string, NamespaceInfo> {
  const flat = new Map<string, NamespaceInfo>();
  if (!isObj(tree)) return flat;
  for (const [name, entry] of Object.entries(tree)) {
    if (!isObj(entry)) continue;
    const path = prefix ? `${prefix}/${name}` : name;
    flat.set(path, {
      type_hint: (entry.type_hint as string | undefined) ?? null,
      description: (entry.description as string | undefined) ?? null,
      replaces: (entry.replaces as string | undefined) ?? null,
    });
    if (isObj(entry.children)) for (const [k, v] of flattenNamespaces(entry.children, path)) flat.set(k, v);
  }
  return flat;
}

/** validate-namespaces.ancestor_namespaces (excludes the ontology's own tree). */
export function ancestorNamespaces(id: string, corpus: Corpus, seen = new Set<string>()): Map<string, NamespaceInfo> {
  const merged = new Map<string, NamespaceInfo>();
  const def = corpus.get(id);
  if (!def || seen.has(id)) return merged;
  seen.add(id);
  for (const parent of def.extends) {
    const p = corpus.get(parent);
    if (!p) continue;
    for (const [k, v] of ancestorNamespaces(parent, corpus, seen)) merged.set(k, v);
    for (const [k, v] of flattenNamespaces(p.namespaceTree)) merged.set(k, v);
  }
  return merged;
}

/** Every namespace visible from an ontology: ancestors', then its own (own wins). */
export function visibleNamespaces(id: string, corpus: Corpus): Map<string, NamespaceInfo> {
  const merged = ancestorNamespaces(id, corpus);
  const def = corpus.get(id);
  if (def) for (const [k, v] of flattenNamespaces(def.namespaceTree)) merged.set(k, v);
  return merged;
}

/** validate-namespaces.check_corpus, keyed by ontology id. */
export function checkNamespaces(corpus: Corpus): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, def] of corpus) {
    const errors: string[] = [];
    const ancestors = ancestorNamespaces(id, corpus);
    const own = flattenNamespaces(def.namespaceTree);
    for (const [path, info] of own) {
      const anc = ancestors.get(path);
      if (anc && (anc.type_hint ?? null) !== (info.type_hint ?? null)) {
        errors.push(`namespace '${path}': type_hint '${info.type_hint}' here conflicts with type_hint '${anc.type_hint}' declared by an ontology this one extends`);
      }
      const r = info.replaces;
      if (typeof r === "string" && r && !ancestors.has(r) && !own.has(r)) {
        errors.push(`namespace '${path}': replaces '${r}', which is not declared by this ontology or any it extends`);
      }
    }
    if (errors.length) out.set(id, errors);
  }
  return out;
}

// --- entity types ---------------------------------------------------------------------

/** validate-ontologies.visible_types: own definitions win; later parents override earlier. */
export function visibleTypes(id: string, corpus: Corpus, seen = new Set<string>()): Map<string, EntityTypeDef & { ontology: string }> {
  const merged = new Map<string, EntityTypeDef & { ontology: string }>();
  const def = corpus.get(id);
  if (!def || seen.has(id)) return merged;
  seen.add(id);
  for (const parent of def.extends) for (const [k, v] of visibleTypes(parent, corpus, seen)) merged.set(k, v);
  for (const t of def.entityTypes) if (typeof t.name === "string" && t.name) merged.set(t.name, { ...t, ontology: id });
  return merged;
}

const requiredSet = (t: EntityTypeDef | undefined) => new Set(strings(t?.schema?.required));

/** validate-ontologies.check_subtype_of (messages without the leading "  - "). */
export function checkSubtypeOf(def: OntologyDef, visible: Map<string, EntityTypeDef>): string[] {
  const errors: string[] = [];
  const local = new Map(def.entityTypes.filter((t) => typeof t.name === "string" && t.name).map((t) => [t.name, t]));
  for (const [name, t] of local) {
    for (const p of strings(t.subtype_of)) {
      if (p === name) {
        errors.push(`entity_type '${name}': subtype_of cannot reference itself`);
        continue;
      }
      const parent = visible.get(p);
      if (!parent) {
        errors.push(`entity_type '${name}': subtype_of parent '${p}' is not a declared entity type in this ontology or any it extends`);
        continue;
      }
      const mine = requiredSet(t);
      const missing = [...requiredSet(parent)].filter((f) => !mine.has(f)).sort();
      if (missing.length) {
        errors.push(`entity_type '${name}': subtype_of '${p}' but its required set is missing parent field(s) [${missing.map((m) => `'${m}'`).join(", ")}] (a subtype must require at least the parent's)`);
      }
    }
  }
  // Cycles over local types only (as the reference).
  const graph = new Map([...local].map(([n, t]) => [n, strings(t.subtype_of).filter((p) => local.has(p) && p !== n)]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let cycle: string[] | undefined;
  const dfs = (n: string) => {
    if (cycle) return;
    state.set(n, 1);
    stack.push(n);
    for (const p of graph.get(n) ?? []) {
      if (state.get(p) === 1) {
        cycle = [...stack.slice(stack.indexOf(p)), p];
        return;
      }
      if (!state.get(p)) dfs(p);
      if (cycle) return;
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of graph.keys()) if (!state.get(n) && !cycle) dfs(n);
  if (cycle) errors.push(`subtype_of cycle: ${cycle.join(" -> ")}`);
  return errors;
}

// --- traits (§10.8.6) ------------------------------------------------------------------

export interface ResolvedField {
  schema: PropertySchema;
  /** Trait (or "entity") that defines this field's effective definition. */
  origin: string;
}

export interface TraitConflict {
  field: string;
  definitions: Array<{ origin: string; schema: PropertySchema }>;
}

export interface ComposedType {
  type: EntityTypeDef & { ontology: string };
  fields: Map<string, ResolvedField>;
  /** MIF document fields the traits require (union over the trait closure). */
  requires: string[];
  conflicts: TraitConflict[];
  /** Traits named by the type (or by a trait's extends) that no ontology in the chain defines. */
  unresolved: string[];
  cycles: string[];
}

/** Traits visible along a chain; a nearer (later) ontology's definition shadows an earlier one. */
export function chainTraits(chain: OntologyDef[]): Map<string, TraitDef & { ontology: string }> {
  const traits = new Map<string, TraitDef & { ontology: string }>();
  for (const def of chain) for (const [name, t] of Object.entries(def.traits)) if (isObj(t)) traits.set(name, { ...t, ontology: def.id });
  return traits;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Compose an entity type's fields from its traits per §10.8.6:
 *   - a trait's own field overrides the same field inherited via `extends`;
 *   - a field reached through a shared ancestor (diamond) is not a conflict;
 *   - the same field from independent traits is a conflict, unless the
 *     definitions are identical or the entity's schema defines the field;
 *   - entity `schema.properties` win over every trait.
 */
export function composeTraits(type: EntityTypeDef & { ontology: string }, traits: Map<string, TraitDef & { ontology: string }>): ComposedType {
  const unresolved = new Set<string>();
  const cycles: string[] = [];
  const memo = new Map<string, { fields: Map<string, ResolvedField>; requires: Set<string> }>();

  const resolveTrait = (name: string, stack: string[]): { fields: Map<string, ResolvedField>; requires: Set<string> } => {
    const cached = memo.get(name);
    if (cached) return cached;
    const empty = { fields: new Map<string, ResolvedField>(), requires: new Set<string>() };
    if (stack.includes(name)) {
      cycles.push([...stack.slice(stack.indexOf(name)), name].join(" -> "));
      return empty;
    }
    const t = traits.get(name);
    if (!t) {
      unresolved.add(name);
      return empty;
    }
    const fields = new Map<string, ResolvedField>();
    const requires = new Set<string>(strings(t.requires));
    for (const parent of strings(t.extends)) {
      const p = resolveTrait(parent, [...stack, name]);
      for (const [k, v] of p.fields) if (!fields.has(k)) fields.set(k, v);
      for (const r of p.requires) requires.add(r);
    }
    for (const [k, schema] of Object.entries(isObj(t.fields) ? t.fields : {})) fields.set(k, { schema, origin: name });
    const result = { fields, requires };
    memo.set(name, result);
    return result;
  };

  const fields = new Map<string, ResolvedField>();
  const candidates = new Map<string, ResolvedField[]>();
  const requires = new Set<string>();
  for (const name of strings(type.traits)) {
    const r = resolveTrait(name, []);
    for (const req of r.requires) requires.add(req);
    for (const [k, v] of r.fields) candidates.set(k, [...(candidates.get(k) ?? []), v]);
  }
  const entityProps = isObj(type.schema?.properties) ? type.schema!.properties! : {};
  const conflicts: TraitConflict[] = [];
  for (const [field, defs] of candidates) {
    if (field in entityProps) continue; // entity wins (below)
    const distinct = defs.filter((d, i) => defs.findIndex((e) => e.origin === d.origin) === i);
    const differing = distinct.filter((d) => !same(d.schema, distinct[0]!.schema));
    if (distinct.length > 1 && differing.length > 0) {
      conflicts.push({ field, definitions: distinct.map((d) => ({ origin: d.origin, schema: d.schema })) });
    }
    fields.set(field, distinct[0]!);
  }
  for (const [field, schema] of Object.entries(entityProps)) fields.set(field, { schema, origin: "entity" });
  return { type, fields, requires: [...requires], conflicts, unresolved: [...unresolved], cycles };
}

// --- discovery ----------------------------------------------------------------------------

export interface DiscoveryHit {
  ontology: string;
  entity?: string;
  namespaces: string[];
  context?: string;
  /** The matched text, or the path for file patterns. */
  match: string;
}

/** Glob → RegExp (`**` any depth, `*` within a segment, `?` one character). */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

const compiled = new Map<string, RegExp | null>();
function regex(pattern: string): RegExp | null {
  if (!compiled.has(pattern)) {
    try {
      // Case-insensitive like mif-rh; invalid patterns are skipped, as there.
      compiled.set(pattern, new RegExp(pattern, "iu"));
    } catch {
      compiled.set(pattern, null);
    }
  }
  return compiled.get(pattern)!;
}

/** Discovery hits for a note's text and path across a chain. */
export function discover(chain: OntologyDef[], text: string, path: string, opts: { filePatterns?: boolean } = {}): DiscoveryHit[] {
  const hits: DiscoveryHit[] = [];
  for (const def of chain) {
    for (const p of def.discovery.patterns) {
      let match: string | undefined;
      if (p.content) {
        const re = regex(p.content);
        match = re?.exec(text)?.[0];
      } else if (p.file && opts.filePatterns) {
        // Off by default: file patterns target source files being edited, and
        // mif-rh (the only reference) ignores them.
        const re = p.file.kind === "glob" ? globToRegExp(p.file.pattern) : regex(p.file.pattern);
        match = re?.test(path) ? path : undefined;
      }
      if (match !== undefined) hits.push({ ontology: def.id, entity: p.entity, namespaces: p.namespaces, context: p.context, match });
    }
  }
  return hits;
}
