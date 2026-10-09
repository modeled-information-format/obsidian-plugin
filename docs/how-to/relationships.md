---
id: 190c9f2f-286d-5cce-9da3-13ea38b4f27e
type: procedural
created: 2026-10-08T15:18:08Z
modified: 2026-10-09T10:47:10Z
namespace: _procedural/learning
title: Work with relationships
tags:
- how-to
- mif-obsidian-plugin
temporal:
  "@type": TemporalMetadata
  validFrom: 2026-10-08T15:18:08Z
  recordedAt: 2026-10-08T15:18:08Z
  ttl: P1Y
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: Work with relationships
  entity_type: how-to-guide
description: Add, edit, and remove typed relationships, keep the body mirror in step, move notes safely, and browse the typed graph.
diataxis_type: how-to
---

# Work with relationships

MIF relationships live in frontmatter `relationships[]`; the body section
`## Relationships` mirrors them as markdown links so other tools (and
Obsidian's backlinks and graph) can follow them.

## Add, edit, or remove

- **Add:** run **MIF: Add relationship**, or click **Add** in the **MIF
  related** panel. Choose the type and the target concept.
- **Write target as:** *Bundle path* (`/folder/note.md`, the MIF default),
  *Relative path*, or *Concept id* (`urn:mif:<uuid>`). An id survives moves
  without any rewriting, but Obsidian does not show it as a backlink. MIF 1.4
  recommends paths for targets in the same bundle. Spaces, parentheses,
  angle brackets, and `%` in a path are written percent-encoded
  (`Phase%201.md`), so the `## Relationships` line renders as a link;
  targets written either way resolve to the same note.
- **Edit / Remove:** use the links beside an outgoing edge in the related
  panel.

Every change updates frontmatter and the body mirror together.

## Custom relationship types

Declare them in the bundle's `.mif/config.yaml` under `relationship_types`
with a `namespace`. A declared `name: BreedsWith` with `namespace: farm`
becomes the token `farm:breeds-with` (spec §8.1.1). Run **MIF: Reload bundle
configuration** after editing the file.

## Keep the mirror in step

If the body and frontmatter disagree, the diagnostics panel reports
`mirror-drift` with two fixes: regenerate the body from frontmatter, or add
body-only lines to frontmatter. **MIF: Regenerate body relationships from
frontmatter** does the first for the open note. In Sync mode it happens when
you leave a note you edited.

## Move and rename notes

Move notes normally. The plugin rewrites relationship targets that point at
the moved note (and the moved note's own relative targets), waiting for
Obsidian's own link updater first so the two never overwrite each other.

## Browse the graph

Run **MIF: Open typed relationship graph**. Edges are coloured by type; click
a type in the legend to hide or show it. Choose **Around this note** (1–3
hops) or **Whole bundle**. Drag to pan, scroll to zoom, click a concept to
open it.
