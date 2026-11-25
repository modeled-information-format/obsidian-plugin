---
id: f069aae6-9344-56a7-9071-877176a455d6
type: procedural
created: 2026-10-08T15:18:08Z
modified: 2026-11-25T18:53:07Z
namespace: _procedural/learning
title: Search concepts by meaning with mif-cli
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
  name: Search concepts by meaning with mif-cli
  entity_type: how-to-guide
description: Connect mif-rs's mif-cli, ingest concepts, search by meaning, keep the vector store current, and find duplicates and missing relationships (desktop only).
diataxis_type: how-to
---

# Search concepts by meaning with mif-cli

Desktop only. Uses [mif-rs](https://github.com/modeled-information-format/mif-rs)'s
`mif-cli`, version 0.13.0 or later; the plugin itself sends nothing over the
network.

## 1. Connect the binary

1. Install `mif-cli` (`cargo install mif-cli`), or build it
   (`cargo build --release -p mif-cli` in mif-rs).
2. **Settings → MIF → mif-cli path:** leave it empty if `mif-cli` is on your
   `PATH` or in `~/.cargo/bin`, `/opt/homebrew/bin`, or `/usr/local/bin`;
   otherwise enter the absolute path to the binary. Then **Test** — a notice
   shows its version and the binary it ran. With a `mif-cli` older than
   0.13.0 the notice says so, and the mif-cli commands stay hidden until it
   is updated.

## 2. Ingest

- **MIF: Ingest this note into the vector store** — the open concept.
- **MIF: Ingest this bundle into the vector store** — every new or changed
  concept in the bundle. Concepts the store already holds unchanged are
  skipped; the notice counts them and lists any `mif-cli` refused (for
  example, schema-invalid notes) and why.

Embeddings go to the bundle's `.mif/vectors.db`. The first ingest downloads
the embedding model `all-MiniLM-L6-v2` from Hugging Face and caches it.

A stored ingest also writes an `embedding` block into the note's frontmatter,
the MIF EmbeddingReference: `model`, `modelVersion` (the model's hub
revision), `dimensions`, `normalized`, and `vectorUri: urn:mif:vector:<id>`,
the vector's address in the store. The vector itself is not written to the
note, and the block is written only once you have left the note, never
while you are editing it. To keep notes untouched, turn off **Settings → MIF → Write the
embedding reference into notes**; the store is the same either way, and
blocks already written stay.

A store written by `mif-cli` 0.12.0 or earlier keeps working, but its
documents have no passage text: no snippet, and no entity type to filter by.
Ingest the bundle again to add them. The bundle report counts such documents.

## 3. Search

- **MIF: Semantic search** — type a query and press Enter. Each result shows
  the note, the heading of the passage that matched, and that passage's
  text; click it to open the note at that heading. **Only** narrows results
  to one entity type (`entity.entity_type`) or one folder.
- **MIF: Find concepts similar to this note** — concepts closest to the open
  one (ingest it first).

Search ranks by meaning and by exact terms together, so an identifier finds
the passage that holds it. The number beside a result is the cosine
similarity of its best passage, from 0 to 1.

## 4. Keep the store current

- Turn on **Settings → MIF → Background ingest**. A concept is then
  ingested a few seconds after it is added or changed, and when Obsidian
  starts the plugin ingests whatever was added or changed while it was not
  running, including notes written by other tools. This updates the store
  only: no note is written, whatever the embedding reference setting says.
  It works in Observe and Sync mode alike, and only for a bundle that
  already has a vector store, so ingest the bundle once first. With it off,
  nothing is ingested until you run a command.
- Background ingest waits for an open editor to save before it reads a
  note, runs one `mif-cli` at a time against a store, and ingests a note
  again if it changed while `mif-cli` was running.
- **MIF: Open vector store coverage** lists concepts that were never
  ingested, concepts that changed since they were, and notes `mif-cli`
  refused on their last ingest, with the reason. **Ingest new and
  changed** brings the store up to date.
- The **MIF bundle report** shows one line per vector store: documents
  stored, notes changed since ingest, notes never ingested, and stored
  documents whose note is gone. **Prune…** (or **MIF: Prune the vector
  store**) lists those and removes them once you confirm. No note is touched.

Coverage comes from a record the plugin keeps beside the store,
`.mif/ingest-ledger.json`, because `mif-cli` cannot list what its store
holds. A note ingested by another tool shows as never ingested until you run
**Ingest new and changed**, which skips what the store already has.

## 5. Find duplicates and missing relationships

- **MIF: New concept** lists existing concepts that resemble the title as
  you type it, and a notice names any concept a new note closely resembles
  the first time it is ingested. Both use **Duplicate threshold**.
- The **MIF related** panel has a **Semantically related** section: the
  open concept's nearest neighbours in the store. **Add as relationship**
  opens the relationship dialog with that neighbour as the target.
- **MIF: Open relationship gap report**, then **Compare**: pairs of concepts
  at or above **Similar threshold** with no typed relationship in either
  direction, and typed relationships whose two ends score at or below
  **Mislink threshold**. It runs `mif-cli` once per concept, so a large
  bundle takes a while.

The three thresholds are cosine similarities in **Settings → MIF**. The
defaults (0.55, 0.55, 0.1) are starting values: adjust them to what the
reports show for your notes.

