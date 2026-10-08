// Building new concepts and promoting ordinary notes to MIF concepts.

import { parseMarkdown, type Frontmatter } from "./convert";
import { isoSeconds } from "./analyze";
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

