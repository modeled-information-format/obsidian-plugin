// Entity files (spec §7.4): `.mif/entities/<type>/<slug>.yaml`, referenced
// from concepts as `urn:mif:entity:<type>:<slug>` (Appendix C). No MIF tool
// reads these files yet; the plugin follows the spec's example shape:
//   id, type (PascalCase), name, aliases[], properties{}.

import { dumpYaml, loadYaml } from "./yaml11";

export interface EntityRecord {
  urn: string;
  /** URN / folder segment, lower-case, e.g. "person". */
  typeSegment: string;
  slug: string;
  name: string;
  /** Declared `type`, e.g. "Person". */
  type?: string;
  aliases: string[];
  properties: Record<string, unknown>;
  /** Vault path of the file, when the entity has one. */
  file?: string;
}

export const ENTITY_URN = /^urn:mif:entity:([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*)$/;

/** Lower-case kebab slug for names and type folders. */
export const entitySlug = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export const entityUrn = (typeSegment: string, slug: string) => `urn:mif:entity:${typeSegment}:${slug}`;

/** Parse `.mif/entities/<type>/<slug>.yaml`. The path decides the URN. */
export function parseEntityFile(text: string, path: string): { entity?: EntityRecord; error?: string } {
  const m = /(?:^|\/)\.mif\/entities\/([^/]+)\/([^/]+)\.ya?ml$/.exec(path);
  if (!m) return { error: `${path}: not under .mif/entities/<type>/<slug>.yaml` };
  let data: unknown;
  try {
    data = loadYaml(text);
  } catch (err) {
    return { error: `${path}: invalid YAML: ${(err as Error).message}` };
  }
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const typeSegment = entitySlug(m[1]!);
  const slug = entitySlug(m[2]!);
  return {
    entity: {
      urn: entityUrn(typeSegment, slug),
      typeSegment,
      slug,
      name: typeof d.name === "string" ? d.name : slug,
      type: typeof d.type === "string" ? d.type : undefined,
      aliases: Array.isArray(d.aliases) ? d.aliases.filter((a): a is string => typeof a === "string") : [],
      properties: d.properties && typeof d.properties === "object" ? (d.properties as Record<string, unknown>) : {},
      file: path,
    },
  };
}

/** YAML for a new entity file, in the §7.4 example shape. */
export function renderEntityFile(e: { typeName: string; name: string; slug: string }): string {
  return dumpYaml({ id: e.slug, type: e.typeName, name: e.name, aliases: [], properties: {} });
}

/** A frontmatter `entities[]` entry (EntityReference). */
export function entityReference(e: { urn: string; name?: string; entityType?: string; role?: string }): Record<string, unknown> {
  const ref: Record<string, unknown> = { "@type": "EntityReference", entity: { "@id": e.urn } };
  if (e.entityType) ref.entityType = e.entityType;
  if (e.name) ref.name = e.name;
  if (e.role) ref.role = e.role;
  return ref;
}

/** URNs referenced by a concept: `entities[].entity["@id"]`. */
export function referencedEntities(fm: Record<string, unknown>): Array<{ urn: string; index: number; name?: string; role?: string; entityType?: string }> {
  const list = Array.isArray(fm.entities) ? fm.entities : [];
  const out: Array<{ urn: string; index: number; name?: string; role?: string; entityType?: string }> = [];
  list.forEach((r, index) => {
    if (!r || typeof r !== "object") return;
    const ref = r as Record<string, unknown>;
    const id = (ref.entity as Record<string, unknown> | undefined)?.["@id"];
    if (typeof id !== "string") return;
    out.push({
      urn: id,
      index,
      name: typeof ref.name === "string" ? ref.name : undefined,
      role: typeof ref.role === "string" ? ref.role : undefined,
      entityType: typeof ref.entityType === "string" ? ref.entityType : undefined,
    });
  });
  return out;
}
