---
id: e83f6fe9-76b3-58e6-a111-48a712280afe
type: semantic
created: 2026-10-08T15:18:08Z
modified: 2026-10-08T15:47:42Z
namespace: _semantic/reference
title: Commands
tags:
- reference
- mif-obsidian-plugin
temporal:
  "@type": TemporalMetadata
  validFrom: 2026-10-08T15:18:08Z
  recordedAt: 2026-10-08T15:18:08Z
  ttl: P1Y
provenance:
  "@type": Provenance
  sourceType: agent_inferred
  trustLevel: high_confidence
  agent: claude-code
  sourceRef: Written by an AI agent from the plugin source; command, setting, and diagnostic names are checked against the source by scripts/check-docs.mjs
citations:
- "@type": Citation
  citationType: specification
  citationRole: source
  title: "MIF: Modeled Information Format specification"
  url: https://mif-spec.dev/
  accessed: 2026-10-09
- "@type": Citation
  citationType: specification
  citationRole: methodology
  title: "Diátaxis: Reference"
  url: https://diataxis.fr/reference/
  accessed: 2026-10-09
ontology:
  "@type": OntologyReference
  id: mif-docs
  version: 1.0.0
  uri: https://mif-spec.dev/ontologies/mif-docs
entity:
  name: Commands
  entity_type: reference-document
description: Every command the plugin adds to the command palette.
diataxis_type: reference
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
| Supersede this concept with a new one | *Concept.* Ask for a title, create a concept with it that supersedes this one, end this one's validity now, and open the new note |

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
