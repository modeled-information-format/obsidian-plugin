// Building new concepts and promoting ordinary notes to MIF concepts.

import { parseMarkdown, type Frontmatter } from "./convert";
import { isoSeconds } from "./analyze";
import { addRelationship, relativeTarget } from "./relationships";
import { updateFrontmatter } from "./writer";

export type BaseType = "semantic" | "episodic" | "procedural";

export interface NewConcept {
  type: BaseType;
  title: string;
  namespace?: string;
  id: string;
  created: Date;
}

/** Text of a new Level 1 concept (Level 2 when a namespace is given). */
export function newConceptText(c: NewConcept): string {
  const stamp = isoSeconds(c.created);
  const fields: Frontmatter = { id: c.id, type: c.type, created: stamp };
  if (c.namespace) {
    Object.assign(fields, { modified: stamp, namespace: c.namespace, title: c.title, temporal: { recordedAt: stamp } });
  } else {
    fields.title = c.title;
  }
  return updateFrontmatter(`# ${c.title}\n`, fields);
}

export interface Promotion {
  type: BaseType;
  id: string;
  /** Used for `created` when the note has none, e.g. the file's creation time. */
  created: Date;
}

/**
 * Add the Level 1 floor (id, type, created) to an existing note, keeping
 * every existing property and the body byte-for-byte. Fields the note
 * already has are left alone.
 */
export function promoteToConcept(text: string, p: Promotion): string {
  let existing: Frontmatter = {};
  try {
    existing = parseMarkdown(text).frontmatter;
  } catch {
    // No frontmatter yet: updateFrontmatter creates the block.
  }
  const updates: Frontmatter = {};
  if (existing.id === undefined || existing.id === null) updates.id = p.id;
  if (existing.type === undefined || existing.type === null) updates.type = p.type;
  if (existing.created === undefined || existing.created === null) updates.created = isoSeconds(p.created);
  return Object.keys(updates).length ? updateFrontmatter(text, updates) : text;
}


/** A free sibling path for a revision: "x.md" → "x-revised.md", "x-revised-2.md", … */
export function revisedPath(path: string, exists: (p: string) => boolean): string {
  const base = path.replace(/\.md$/i, "").replace(/-revised(?:-\d+)?$/, "");
  for (let n = 1; ; n++) {
    const candidate = `${base}-revised${n > 1 ? `-${n}` : ""}.md`;
    if (!exists(candidate)) return candidate;
  }
}

/**
 * A new concept that supersedes `old` (spec §8.2 Supersedes): same type and
 * namespace, valid and recorded from `now`, with a `supersedes` relationship
 * (relative target) mirrored in its body. Paths are bundle paths.
 */
export function supersedingConceptText(old: { path: string; frontmatter: Frontmatter }, next: { path: string; id: string; now: Date }): string {
  const fm = old.frontmatter;
  const type = (["semantic", "episodic", "procedural"] as const).find((t) => t === fm.type) ?? "semantic";
  const oldTitle = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : old.path.split("/").pop()!.replace(/\.md$/, "");
  const stamp = isoSeconds(next.now);
  let text = newConceptText({ type, title: `${oldTitle} (revised)`, namespace: typeof fm.namespace === "string" ? fm.namespace : undefined, id: next.id, created: next.now });
  text = updateFrontmatter(text, { modified: stamp, temporal: { recordedAt: stamp, validFrom: stamp } });
  return addRelationship(text, { type: "supersedes", target: relativeTarget(next.path, old.path) }, () => oldTitle);
}
