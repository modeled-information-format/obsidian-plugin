---
diataxis_type: reference
title: Commands
description: Every command the plugin adds to the command palette.
---

# Commands

All appear in the command palette prefixed with **MIF:**. Commands marked
*concept* are offered only while a MIF concept is open. `npm run check:docs`
fails if this list and the source disagree.

## Authoring

| Command | What it does |
|---|---|
| New concept | Create a concept from a dialog (type, title, ontology, entity type, namespace, folder) |
| Convert note to a concept | Add MIF frontmatter to the open note |
| Add relationship | *Concept.* Add a typed relationship (frontmatter and body mirror) |
| Regenerate body relationships from frontmatter | *Concept.* Rewrite the `## Relationships` section from frontmatter |
| Add entity reference | *Concept.* Reference an existing or new entity |
| Write or update the ## Citations section from frontmatter | *Concept with citations.* Create or update the body section |
| Compress this concept to its summary | *Concept with a summary.* Body → summary; original kept in `extensions.original_content` |
| Restore original content of a compressed concept | *Compressed concept.* Undo compression exactly |
| Migrate version 0.1 notes to 1.0 | Migrate every MIF 0.1 note in the bundles |
| Supersede this concept with a new one | *Concept.* Create `<name>-revised.md` that supersedes it, end its validity now, and open the new note |

## Panels

| Command | Opens |
|---|---|
| Open diagnostics | Diagnostics and quick fixes for the open note |
| Open related panel | Outgoing and incoming relationships, timeline, banners |
| Open properties panel | Form editor for every MIF field |
| Open ontology panel | Ontology chain, namespaces, entity types, suggestions |
| Open entities panel | Every entity and the notes that reference it |
| Open freshness panel | Concepts that are expired, stale, ageing, or not yet valid |
| Open bundle report | Every note's level and issues, with filters |
| Open JSON-LD panel | The open note's JSON-LD projection and round trip |
| Open typed relationship graph | Relationships coloured by type |

## Export and checks

| Command | What it does |
|---|---|
| Export this note as JSON-LD | *Concept.* Write its projection to the export folder |
| Export this note's folder as JSON-LD | Export the open note's folder |
| Export all bundles as JSON-LD | Export everything; stale projections go to the trash |
| Check that every concept round-trips losslessly | List concepts whose markdown → JSON-LD → markdown changes |

## Ontologies and bundles

| Command | What it does |
|---|---|
| Download all ontologies from the spec catalog | Download and verify every ontology from mif-spec.dev |
| Reload bundle configuration | Re-read `.mif/config.yaml`, ontologies, and entities |
| Rescan all bundles | Re-read every note (the bundle report's **Rescan**) |

## mif-cli (desktop, when a path is set)

| Command | What it does |
|---|---|
| Ingest this note into the vector store | *Concept.* Embed it into the bundle's `.mif/vectors.db` |
| Ingest this bundle into the vector store | Embed every concept of the bundle |
| Semantic search | Rank ingested concepts by similarity to a query |
| Find concepts similar to this note | *Concept.* Rank ingested concepts by similarity to it |

## Developer (when **Developer commands** is on)

| Command | What it does |
|---|---|
| Spike B: frontmatter write fidelity | Developer experiment; writes a report under `_spike/` |
| Spike C: relationship link resolution | Developer experiment; writes a report under `_spike/` |
| Toggle mobile emulation (developer) | Switch Obsidian between desktop and its mobile layout, to check the plugin on "mobile" |
