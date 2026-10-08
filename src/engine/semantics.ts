// Advisory checks of a concept against its ontology, namespace model, and
// the bundle's entities.

import type { Diagnostic, Fix } from "./analyze";
import type { Frontmatter } from "./convert";
import { ENTITY_URN, referencedEntities, type EntityRecord } from "./entities";
import {
  chainTraits,
  composeTraits,
  discover,
  resolveChain,
  visibleNamespaces,
  visibleTypes,
  type Corpus,
  type DiscoveryHit,
  type OntologyDef,
} from "./ontology";

/** Prefixes the spec reserves (§10.2). */
export const VISIBILITY_PREFIXES = ["_public", "_shared", "_local", "_system"] as const;
export const BASE_PREFIXES: Record<string, string> = { _semantic: "semantic", _episodic: "episodic", _procedural: "procedural" };

export interface SemanticContext {
  corpus: Corpus;
  /** Custom reserved prefixes from .mif/config.yaml `reserved_prefixes`. */
  reservedPrefixes: string[];
  /** Ids of `.mif/shared-agreements/<id>.yaml` files. */
  sharedAgreements: Set<string>;
  entities: Map<string, EntityRecord>;
  /** Ontology ids the remote catalog offers but are not loaded. */
  downloadable: Set<string>;
  /** Ontology assumed when a concept names none (for namespace hints only). */
  defaultOntology?: string;
}

export interface SemanticReport {
  diagnostics: Diagnostic[];
  chain?: OntologyDef[];
  /** The ontology a concept declares (or the default used for hints). */
  ontologyId?: string;
  declared: boolean;
  discovery: DiscoveryHit[];
}

const info = (code: string, message: string, path: Array<string | number>, fixes: Fix[] = []): Diagnostic => ({ severity: "info", code, message, path, fixes });
const warn = (code: string, message: string, path: Array<string | number>, fixes: Fix[] = []): Diagnostic => ({ severity: "warning", code, message, path, fixes });

/** Toggle a leading underscore on the first segment (`_semantic/x` ↔ `semantic/x`). */
const toggleRoot = (ns: string) => (ns.startsWith("_") ? ns.slice(1) : `_${ns}`);

/** The declared namespace node covering `ns` (itself or nearest ancestor), with either root spelling. */
function coveringNamespace(ns: string, declared: Map<string, { type_hint?: string | null }>): { path: string; hint?: string | null } | undefined {
  for (const candidate of [ns, toggleRoot(ns)]) {
    const parts = candidate.split("/");
    let hint: string | null | undefined;
    let found: string | undefined;
    for (let i = parts.length; i > 0; i--) {
      const p = parts.slice(0, i).join("/");
      const node = declared.get(p);
      if (node) {
        found ??= p;
        if (node.type_hint) {
          hint = node.type_hint;
          break;
        }
      }
    }
    if (found) return { path: found, hint };
  }
  return undefined;
}

export function semanticDiagnostics(fm: Frontmatter, body: string, path: string, ctx: SemanticContext): SemanticReport {
  const out: Diagnostic[] = [];
  const type = typeof fm.type === "string" ? fm.type : undefined;
  const ns = typeof fm.namespace === "string" ? fm.namespace : undefined;

  // --- ontology reference and chain --------------------------------------------------
  const ref = fm.ontology && typeof fm.ontology === "object" ? (fm.ontology as Record<string, unknown>) : undefined;
  const declaredId = typeof ref?.id === "string" ? ref.id : undefined;
  const ontologyId = declaredId ?? (ctx.defaultOntology && ctx.corpus.has(ctx.defaultOntology) ? ctx.defaultOntology : undefined);
  let chain: OntologyDef[] | undefined;
  if (declaredId && !ctx.corpus.has(declaredId)) {
    const fixes: Fix[] = ctx.downloadable.has(declaredId) ? [{ label: `Download ${declaredId} from mif-spec.dev`, transform: "download-ontology", data: { id: declaredId } }]  : [];
    out.push(warn("ontology-unknown", `Ontology '${declaredId}' is not loaded${ctx.downloadable.has(declaredId) ? "" : " and not in the mif-spec.dev catalog"}.`, ["ontology", "id"], fixes));
  } else if (ontologyId) {
    try {
      chain = resolveChain(ontologyId, ctx.corpus);
    } catch (err) {
      out.push(warn("ontology-chain", `Ontology '${ontologyId}': ${(err as Error).message}.`, ["ontology"]));
    }
    const def = ctx.corpus.get(ontologyId);
    if (declaredId && def && typeof ref?.version === "string" && ref.version !== def.version) {
      out.push(info("ontology-version", `Declares ${declaredId} ${ref.version}; the loaded definition is ${def.version}.`, ["ontology", "version"]));
    }
  }

  // --- namespace (§10) -------------------------------------------------------------------
  if (ns) {
    const root = ns.split("/")[0]!;
    if (root.startsWith("_") && !(root in BASE_PREFIXES) && !(VISIBILITY_PREFIXES as readonly string[]).includes(root) && !ctx.reservedPrefixes.includes(root)) {
      out.push(info("namespace-reserved", `'${root}' uses the reserved underscore prefix but is not a known reserved namespace (§10.2).`, ["namespace"]));
    }
    if (root in BASE_PREFIXES && type && BASE_PREFIXES[root] !== type) {
      out.push(warn("namespace-type", `Namespace '${ns}' is for ${BASE_PREFIXES[root]} concepts, but this one is ${type}.`, ["namespace"], [
        { label: `Set namespace root to _${type}`, updates: { namespace: [`_${type}`, ...ns.split("/").slice(1)].join("/") } },
      ]));
    }
    if (root === "_shared") {
      const agreement = ns.split("/")[1];
      if (agreement && !ctx.sharedAgreements.has(agreement)) {
        out.push(info("namespace-shared", `'_shared/${agreement}' has no .mif/shared-agreements/${agreement}.yaml (§10.4).`, ["namespace"]));
      }
    }
    // Only against an ontology the concept declares, and not for visibility
    // scopes (_public/_shared/_local/_system), which are not taxonomy.
    const visibility = (VISIBILITY_PREFIXES as readonly string[]).includes(root);
    if (chain && ontologyId && declaredId && !visibility) {
      const declared = visibleNamespaces(ontologyId, ctx.corpus);
      const cover = coveringNamespace(ns, declared);
      if (!cover && declared.size) {
        const near = [...declared.keys()].filter((p) => p.split("/").length === 2 && (!type || p.replace(/^_/, "").startsWith(type))).slice(0, 4);
        out.push(info("namespace-undeclared", `Namespace '${ns}' is not declared by ${ontologyId} or the ontologies it extends.`, ["namespace"],
          near.map((p) => ({ label: `Use ${p}`, updates: { namespace: p } }))));
      } else if (cover?.hint && type && cover.hint !== type) {
        out.push(warn("namespace-type-hint", `${ontologyId} marks '${cover.path}' as ${cover.hint}, but this concept is ${type}.`, ["namespace"]));
      }
    }
  }

  // --- entity type (frontmatter `entity`) -------------------------------------------------
  const entity = fm.entity && typeof fm.entity === "object" ? (fm.entity as Record<string, unknown>) : undefined;
  const entityType = typeof entity?.entity_type === "string" ? entity.entity_type : undefined;
  // Entity types are checked only against an ontology the concept declares;
  // the default ontology drives namespace hints, not typing.
  if (entityType && chain && declaredId) {
    const types = visibleTypes(declaredId, ctx.corpus);
    const def = types.get(entityType);
    if (!def) {
      out.push(warn("entity-type-unknown", `Entity type '${entityType}' is not defined by ${ontologyId} or the ontologies it extends.`, ["entity", "entity_type"]));
    } else {
      if (type && def.base !== type) {
        out.push(warn("entity-type-base", `'${entityType}' is a ${def.base} type, but this concept is ${type}.`, ["type"], [{ label: `Set type to ${def.base}`, updates: { type: def.base } }]));
      }
      // mif-rh's check: the `entity` object against the type's schema.required.
      const missing = (def.schema?.required ?? []).filter((f) => !(f in entity!));
      if (missing.length) out.push(warn("entity-fields", `'${entityType}' requires ${missing.join(", ")} in \`entity\`.`, ["entity"]));
      const composed = composeTraits(def, chainTraits(chain));
      for (const t of composed.unresolved) out.push(warn("trait-unresolved", `'${entityType}' uses trait '${t}', which ${ontologyId}'s chain does not define.`, ["entity", "entity_type"]));
      for (const c of composed.cycles) out.push(warn("trait-cycle", `Trait cycle: ${c}.`, ["entity", "entity_type"]));
      for (const c of composed.conflicts) {
        out.push(warn("trait-conflict", `'${entityType}' gets '${c.field}' from ${c.definitions.map((d) => d.origin).join(" and ")} with different definitions; the ontology must override it in the entity schema (§10.8.6).`, ["entity", "entity_type"]));
      }
      const absent = composed.requires.filter((f) => !(f in fm));
      if (absent.length) out.push(info("trait-requires", `Traits of '${entityType}' expect ${absent.join(", ")} on this concept.`, []));
    }
  } else if (entityType && !declaredId) {
    out.push(info("entity-type-no-ontology", `Entity type '${entityType}' cannot be checked: the concept declares no ontology.`, ["entity"]));
  }

  // --- entity references (`entities[]`) ---------------------------------------------------
  for (const r of referencedEntities(fm)) {
    if (!ENTITY_URN.test(r.urn)) {
      out.push(info("entity-urn", `'${r.urn}' is not in the urn:mif:entity:<type>:<slug> form (Appendix C).`, ["entities", r.index]));
    } else if (!ctx.entities.has(r.urn)) {
      out.push(info("entity-unresolved", `No entity file for ${r.urn}.`, ["entities", r.index], [{ label: "Create the entity file", transform: "create-entity", data: { urn: r.urn, name: r.name, entityType: r.entityType } }] ));
    }
  }

  // --- discovery (suggestions only) -------------------------------------------------------
  const discovery = chain ? discover(chain, body, path) : [];
  const suggestNs = new Set(discovery.flatMap((h) => h.namespaces));
  if (suggestNs.size && !ns) {
    out.push(info("discovery-namespace", `Content suggests namespace ${[...suggestNs].slice(0, 3).join(", ")}.`, ["namespace"],
      [...suggestNs].slice(0, 3).map((n) => ({ label: `Set namespace to ${n}`, updates: { namespace: n } }))));
  }
  const suggestEntity = [...new Set(discovery.map((h) => h.entity).filter((e): e is string => !!e))];
  if (suggestEntity.length === 1 && !entityType) {
    const name = typeof fm.title === "string" ? fm.title : path.split("/").pop()!.replace(/\.md$/, "");
    out.push(info("discovery-entity", `Content suggests entity type '${suggestEntity[0]}'.`, ["entity"], [
      { label: `Mark as ${suggestEntity[0]}`, updates: { entity: { ...(entity ?? {}), name: entity?.name ?? name, entity_type: suggestEntity[0] } } },
    ]));
  }

  return { diagnostics: out, chain, ontologyId, declared: !!declaredId, discovery };
}


/**
 * Discovery hits worth showing: only suggestions that would change the
 * concept, and only listed in full when it still lacks a namespace or an
 * entity type (otherwise the panel offers them behind a link).
 */
export function usefulSuggestions(hits: DiscoveryHit[], namespace: string | undefined, entityType: string | undefined): { hits: DiscoveryHit[]; collapsed: boolean } {
  const useful = hits
    .map((h) => ({ ...h, namespaces: h.namespaces.filter((n) => n !== namespace), entity: h.entity === entityType ? undefined : h.entity }))
    .filter((h) => h.namespaces.length > 0 || h.entity !== undefined);
  return { hits: useful, collapsed: !!namespace && !!entityType };
}
